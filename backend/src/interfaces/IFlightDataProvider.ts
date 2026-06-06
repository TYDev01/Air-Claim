/**
 * Abstraction over any flight-data API (AviationStack, FlightAware, etc.).
 * All runtime modules depend on this interface, never on a concrete provider.
 * Swap the implementation in main.ts without touching the rest of the system.
 */

// ─── Raw API response types ───────────────────────────────────────────────────

/**
 * The set of flight_status values documented by AviationStack.
 * "unknown" is our own sentinel for any undocumented or missing value.
 */
export type ApiFlightStatus =
  | "scheduled"
  | "active"
  | "landed"
  | "cancelled"
  | "incident"
  | "diverted"
  | "unknown";

/** Departure or arrival leg data normalised from the raw API response. */
export interface FlightLeg {
  /** IATA airport code (e.g. "ADD"). */
  iata: string;
  /** Scheduled time in UTC (ISO 8601). Null if the API omits it. */
  scheduledUtc: string | null;
  /** Estimated time in UTC. Null until the airline publishes an estimate. */
  estimatedUtc: string | null;
  /** Actual time in UTC. Null until the aircraft departs/arrives. */
  actualUtc: string | null;
  /**
   * Delay in minutes as reported by the API (departure.delay / arrival.delay).
   * Null means the API did not include a delay value — treat as 0 for now,
   * but do NOT upgrade to Delayed status on a null alone.
   */
  delayMinutes: number | null;
}

/**
 * The normalised view of a flight returned by every IFlightDataProvider.
 * This is the only shape the rest of the system ever sees — provider-specific
 * quirks are handled inside the implementation.
 */
export interface NormalisedFlight {
  /** IATA flight number, upper-cased (e.g. "ET309"). */
  flightIata: string;
  /** UTC date string "YYYY-MM-DD" matching the scheduled departure date. */
  flightDate: string;
  /** AviationStack-style status string. "unknown" for any unrecognised value. */
  apiStatus: ApiFlightStatus;
  departure: FlightLeg;
  arrival: FlightLeg;
  /** Raw provider response preserved for logging/alerting when mapping fails. */
  rawDigest: string;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IFlightDataProvider {
  /**
   * Fetch the current status of a single flight.
   *
   * @param flightIata  IATA flight number (e.g. "ET309").
   * @param flightDate  UTC departure date "YYYY-MM-DD". Required by AviationStack
   *                    to disambiguate daily flights.
   * @returns           Normalised flight record, or null if the provider has no
   *                    data for the requested flight (404 / empty result set).
   * @throws            On network errors, auth failures, or rate-limit responses
   *                    that exhausted the configured retry budget. The caller
   *                    treats any thrown error as "hold, retry later."
   */
  getFlightStatus(
    flightIata: string,
    flightDate: string,
  ): Promise<NormalisedFlight | null>;
}
