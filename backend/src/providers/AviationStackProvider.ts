/**
 * AviationStack implementation of IFlightDataProvider.
 *
 * Fetches real-time flight status from the AviationStack API and normalises
 * the response into NormalisedFlight. The API key is read from AppConfig and
 * never logged.
 *
 * AviationStack real-time flights endpoint:
 *   GET /v1/flights?access_key=KEY&flight_iata=ET309&flight_date=YYYY-MM-DD
 *
 * Documented flight_status values: scheduled | active | landed | cancelled |
 *   incident | diverted
 *
 * Rate limits (as of June 2026):
 *   Free plan       : 100 req/month, HTTP only (no HTTPS)
 *   Basic plan      : 10,000 req/month, HTTPS
 *   Professional    : 50,000 req/month, HTTPS
 *
 * This implementation respects AVIATIONSTACK_MAX_RPH via the Scheduler —
 * it does not enforce rate limits internally; the Scheduler gates calls.
 */

import axios, { type AxiosInstance, type AxiosError } from "axios";
import axiosRetry, { isNetworkOrIdempotentRequestError } from "axios-retry";
import { ConsecutiveBreaker, ExponentialBackoff, retry, handleAll, circuitBreaker, wrap, type IPolicy } from "cockatiel";

import type { IFlightDataProvider, NormalisedFlight, ApiFlightStatus, FlightLeg } from "../interfaces/IFlightDataProvider.js";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";

// ─── AviationStack raw response types ────────────────────────────────────────
// Derived from official AviationStack documentation for /v1/flights.
// Do not modify without re-reading the docs — field names are exact.

interface RawLeg {
  airport:          string | null;
  timezone:         string | null;
  iata:             string | null;
  icao:             string | null;
  terminal:         string | null;
  gate:             string | null;
  delay:            number | null;   // minutes; null when not yet reported
  scheduled:        string | null;   // ISO 8601 with tz offset
  estimated:        string | null;
  actual:           string | null;
  estimated_runway: string | null;
  actual_runway:    string | null;
}

interface RawFlight {
  flight_date:   string | null;
  flight_status: string | null;
  departure:     RawLeg;
  arrival:       RawLeg;
  airline: { name: string | null; iata: string | null; icao: string | null } | null;
  flight:  { number: string | null; iata: string | null; icao: string | null; codeshared: unknown } | null;
  aircraft: unknown;
  live:     unknown;
}

interface RawApiResponse {
  pagination: { limit: number; offset: number; count: number; total: number } | null;
  data:       RawFlight[] | null;
  error?:     { code: string; message: string };
}

// ─── Documented status values ─────────────────────────────────────────────────

const KNOWN_STATUSES = new Set<ApiFlightStatus>([
  "scheduled", "active", "landed", "cancelled", "incident", "diverted",
]);

function toApiStatus(raw: string | null | undefined): ApiFlightStatus {
  if (raw && KNOWN_STATUSES.has(raw as ApiFlightStatus)) {
    return raw as ApiFlightStatus;
  }
  return "unknown";
}

// ─── AviationStackProvider ────────────────────────────────────────────────────

export class AviationStackProvider implements IFlightDataProvider {
  private readonly http:    AxiosInstance;
  private readonly policy:  IPolicy;
  private readonly logger:  Logger;
  private readonly apiKey:  string;

  /**
   * Construct the provider with an HTTP client configured for:
   *  - 10-second request timeout
   *  - 3 axios-retry attempts with exponential backoff on network errors
   *  - A cockatiel circuit breaker that opens after 5 consecutive failures
   *    and half-opens after 30 seconds, preventing thundering-herd against
   *    a temporarily unavailable API
   *
   * The API key is stored in a private field and never passed to the logger.
   */
  constructor(config: Pick<AppConfig, "AVIATIONSTACK_BASE_URL" | "AVIATIONSTACK_API_KEY">, logger: Logger) {
    this.apiKey = config.AVIATIONSTACK_API_KEY;
    this.logger = logger.child({ component: "AviationStackProvider" });

    // ── Axios instance ──────────────────────────────────────────────────────
    this.http = axios.create({
      baseURL: config.AVIATIONSTACK_BASE_URL,
      timeout: 10_000, // 10 s per request
      headers: { "Accept": "application/json" },
    });

    // Retry on network errors and 5xx responses (not 4xx — those are caller errors).
    axiosRetry(this.http, {
      retries:           3,
      retryDelay:        axiosRetry.exponentialDelay, // 1s, 2s, 4s
      retryCondition:    (err: AxiosError) =>
        isNetworkOrIdempotentRequestError(err) ||
        (err.response?.status !== undefined && err.response.status >= 500),
      onRetry:           (retryCount, err) => {
        this.logger.warn(
          { retryCount, status: err.response?.status, message: err.message },
          "AviationStack request retry",
        );
      },
    });

    // ── Circuit breaker ─────────────────────────────────────────────────────
    // Opens after 5 consecutive failures; half-opens after 30 s.
    // While open, calls throw immediately without hitting the API.
    const breaker = circuitBreaker(handleAll, {
      halfOpenAfter: 30_000,
      breaker:       new ConsecutiveBreaker(5),
    });

    const retryPolicy = retry(handleAll, {
      maxAttempts: 1, // axios-retry handles HTTP retries; this wraps for the breaker
      backoff:     new ExponentialBackoff(),
    });

    this.policy = wrap(retryPolicy, breaker);
  }

  // ── IFlightDataProvider ───────────────────────────────────────────────────

  /**
   * Fetch the current status of a single flight from AviationStack.
   *
   * Flow:
   *  1. Execute GET /v1/flights?access_key=KEY&flight_iata=IATA&flight_date=DATE
   *     through the cockatiel policy (circuit breaker wrapping axios-retry).
   *  2. Validate the response envelope: check for API-level error objects and
   *     confirm data[] is a non-empty array.
   *  3. Normalise the first matching record via _parseResponse().
   *
   * @returns NormalisedFlight when the API returns data for the flight.
   * @returns null when the API returns an empty result set (flight not found).
   * @throws  On network errors, auth failures, API error responses, or when
   *          the circuit breaker is open. The caller treats any throw as
   *          "hold, retry later."
   */
  async getFlightStatus(
    flightIata: string,
    flightDate: string,
  ): Promise<NormalisedFlight | null> {
    const log = this.logger.child({ flightIata, flightDate });

    let response: RawApiResponse;

    try {
      const result = await this.policy.execute(() =>
        this.http.get<RawApiResponse>("/flights", {
          params: {
            // API key passed as query param per AviationStack spec.
            // axios does not log params by default; our pino redact list
            // covers the access_key shape as a belt-and-suspenders guard.
            access_key:  this.apiKey,
            flight_iata: flightIata.toUpperCase(),
            flight_date: flightDate,
          },
        }),
      );
      response = result.data;
    } catch (err) {
      log.warn({ err }, "AviationStack request failed (network or circuit open)");
      throw err;
    }

    // ── API-level error check ───────────────────────────────────────────────
    // AviationStack returns HTTP 200 even for auth failures and quota errors;
    // the error is encoded in response.error.
    if (response.error) {
      const { code, message } = response.error;
      log.error({ code, message }, "AviationStack API returned an error object");
      throw new Error(`AviationStack API error [${code}]: ${message}`);
    }

    // ── Empty result ────────────────────────────────────────────────────────
    const data = response.data;
    if (!Array.isArray(data) || data.length === 0) {
      log.info("AviationStack returned no data for flight — treating as not found");
      return null;
    }

    // AviationStack may return multiple records when querying by IATA code
    // (e.g. code-shares). Use the first record whose flight.iata matches
    // the requested code; fall back to the first record if none match exactly.
    const match =
      data.find(r => r.flight?.iata?.toUpperCase() === flightIata.toUpperCase()) ??
      data[0]!;

    const normalised = this._parseResponse(match, flightIata);

    log.debug(
      { apiStatus: normalised.apiStatus, depDelay: normalised.departure.delayMinutes },
      "AviationStack response normalised",
    );

    return normalised;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Normalise a single RawFlight entry from the AviationStack response into
   * the provider-agnostic NormalisedFlight shape.
   *
   * All field accesses are defensive — null/undefined at any level is handled
   * explicitly rather than letting it propagate silently.
   *
   * @param raw         A single element from response.data[].
   * @param flightIata  The IATA code requested (used as fallback if the API
   *                    omits flight.iata in the response).
   */
  _parseResponse(raw: RawFlight, flightIata: string): NormalisedFlight {
    const normLeg = (leg: RawLeg): FlightLeg => ({
      iata:           leg.iata ?? "",
      scheduledUtc:   leg.scheduled ?? null,
      estimatedUtc:   leg.estimated ?? null,
      actualUtc:      leg.actual    ?? null,
      // delay is an integer number of minutes or null — never coerce a string.
      delayMinutes:   typeof leg.delay === "number" ? leg.delay : null,
    });

    // flight_date from the API is "YYYY-MM-DD" in the airline's local timezone.
    // We store it as-is — callers use it only for API lookups, not UTC math.
    const flightDate = raw.flight_date ?? "";

    // Produce a deterministic digest of the raw record for alert messages
    // when the mapper returns Unknown. Truncate to keep logs bounded.
    const rawDigest = JSON.stringify(raw).slice(0, 500);

    return {
      flightIata:  (raw.flight?.iata ?? flightIata).toUpperCase(),
      flightDate,
      apiStatus:   toApiStatus(raw.flight_status),
      departure:   normLeg(raw.departure),
      arrival:     normLeg(raw.arrival),
      rawDigest,
    };
  }

  /** Exposed for testing — returns the underlying axios instance. @internal */
  _httpClient(): AxiosInstance { return this.http; }
}
