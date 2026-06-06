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

  // ── Interface methods (implemented in subsequent commits) ──────────────────

  async getFlightStatus(
    _flightIata: string,
    _flightDate: string,
  ): Promise<NormalisedFlight | null> {
    throw new Error("Not yet implemented — see getFlightStatus commit");
  }

  // ── Internal helpers (implemented in subsequent commits) ──────────────────

  _parseResponse(
    _raw: RawFlight,
    _flightIata: string,
  ): NormalisedFlight {
    throw new Error("Not yet implemented — see _parseResponse commit");
  }

  /** Exposed for testing — returns the underlying axios instance. @internal */
  _httpClient(): AxiosInstance { return this.http; }
}
