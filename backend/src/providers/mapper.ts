/**
 * Pure deterministic mapping: AviationStack API response → on-chain status.
 *
 * This is the safety-critical function of the entire system. A wrong mapping
 * directly causes a wrong payout. Rules:
 *
 *  - The function is pure (no I/O, no side effects) and exhaustively handles
 *    every documented API status value plus every malformed/missing case.
 *  - Any ambiguous or unrecognised input returns MappedStatus.Unknown.
 *    The caller (OracleUpdater) treats Unknown as "hold, alert, do not write."
 *  - Never return Unknown as a fallback without logging the raw input — the
 *    caller receives rawDigest from NormalisedFlight for exactly this purpose.
 *
 * Mapping table (mirrors ARCHITECTURE.md):
 *
 *  API status   │ Condition                    │ On-chain status │ delayMinutes
 *  ─────────────┼──────────────────────────────┼─────────────────┼─────────────
 *  "scheduled"  │ —                            │ Scheduled       │ 0
 *  "active"     │ departure.delay < threshold  │ Scheduled       │ departure.delay ?? 0
 *  "active"     │ departure.delay ≥ threshold  │ Delayed         │ departure.delay
 *  "cancelled"  │ —                            │ Cancelled       │ 0
 *  "landed"     │ arrival.delay < threshold    │ Landed          │ 0
 *  "landed"     │ arrival.delay ≥ threshold    │ Delayed         │ arrival.delay
 *  "incident"   │ —                            │ Unknown (hold)  │ —
 *  "diverted"   │ —                            │ Unknown (hold)  │ —
 *  anything else│ —                            │ Unknown (hold)  │ —
 *  null / undef │ —                            │ Unknown (hold)  │ —
 */

import { OnChainFlightStatus } from "../interfaces/IChainClient.js";
import type { NormalisedFlight } from "../interfaces/IFlightDataProvider.js";

// ─── Result type ──────────────────────────────────────────────────────────────

/** Sentinel value returned when the mapper cannot safely resolve a status. */
export const UNKNOWN = "Unknown" as const;
export type Unknown  = typeof UNKNOWN;

export type MapResult =
  | { status: OnChainFlightStatus; delayMinutes: number; unknown: false }
  | { status: Unknown;             delayMinutes: null;   unknown: true;  reason: string };

// ─── Mapper ───────────────────────────────────────────────────────────────────

/**
 * Map a normalised AviationStack flight record to an on-chain write decision.
 *
 * @param flight             Normalised flight from IFlightDataProvider.
 * @param thresholdMinutes   Delay threshold matching the deployed contract's
 *                           delayThresholdMinutes constructor parameter.
 * @returns                  MapResult — check `.unknown` before acting.
 */
export function mapApiStatus(
  flight: NormalisedFlight,
  thresholdMinutes: number,
): MapResult {
  const { apiStatus, departure, arrival } = flight;

  switch (apiStatus) {
    case "scheduled":
      return { status: OnChainFlightStatus.Scheduled, delayMinutes: 0, unknown: false };

    case "active": {
      // departure.delay is null when the API omits the field — treat as 0,
      // but do NOT upgrade to Delayed on a null alone (explicit hold rule).
      const depDelay = departure.delayMinutes ?? 0;
      if (depDelay >= thresholdMinutes) {
        return { status: OnChainFlightStatus.Delayed, delayMinutes: depDelay, unknown: false };
      }
      return { status: OnChainFlightStatus.Scheduled, delayMinutes: depDelay, unknown: false };
    }

    case "cancelled":
      return { status: OnChainFlightStatus.Cancelled, delayMinutes: 0, unknown: false };

    case "landed": {
      // Use arrival delay for landed flights.
      // If arrival.delay is null (API omitted it), treat conservatively as 0 —
      // the flight landed, we just don't know how late.
      const arrDelay = arrival.delayMinutes ?? 0;
      if (arrDelay >= thresholdMinutes) {
        // Flight landed late — report Delayed so the contract marks claimable,
        // then the next oracle update will move it to Landed once the keeper acts.
        // In practice the oracle should also immediately submit a Landed write,
        // so the OracleUpdater submits Delayed first, then Landed in the same tick.
        return { status: OnChainFlightStatus.Delayed, delayMinutes: arrDelay, unknown: false };
      }
      return { status: OnChainFlightStatus.Landed, delayMinutes: 0, unknown: false };
    }

    case "incident":
      return {
        status:       UNKNOWN,
        delayMinutes: null,
        unknown:      true,
        reason:       `flight_status="incident" — ambiguous; holding and alerting`,
      };

    case "diverted":
      return {
        status:       UNKNOWN,
        delayMinutes: null,
        unknown:      true,
        reason:       `flight_status="diverted" — ambiguous; holding and alerting`,
      };

    case "unknown":
      return {
        status:       UNKNOWN,
        delayMinutes: null,
        unknown:      true,
        reason:       `flight_status value was absent, null, or unrecognised by the provider`,
      };

    default: {
      // TypeScript exhaustiveness guard — should never reach here because
      // ApiFlightStatus is a closed union and the provider normalises all
      // unrecognised values to "unknown". Belt-and-suspenders.
      const _exhaustive: never = apiStatus;
      return {
        status:       UNKNOWN,
        delayMinutes: null,
        unknown:      true,
        reason:       `Unhandled API status value: ${String(_exhaustive)}`,
      };
    }
  }
}
