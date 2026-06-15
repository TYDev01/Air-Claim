import { ethers } from "ethers";

/**
 * Canonical flightId encoding — the SINGLE SOURCE OF TRUTH for how a flight is
 * hashed into the bytes32 `flightId` used by InsuredFlightsAgency, FlightOracle,
 * and the backend indexer. Every caller — deploy fixtures, tests, any front-end,
 * and the off-chain services — MUST derive flightId the same way or policies,
 * oracle records, and tracked-flight rows will silently fail to line up.
 *
 *   flightId = keccak256(abi.encodePacked(flightIata, "-", flightDate))
 *
 * where:
 *   - flightIata  is the IATA flight code, upper-cased  (e.g. "ET309")
 *   - flightDate  is the scheduled departure CALENDAR date in UTC, formatted
 *                 "YYYY-MM-DD"                            (e.g. "2026-06-15")
 *
 * Why the date is part of the key
 * ───────────────────────────────
 * AviationStack disambiguates a flight by BOTH code and date
 * (getFlightStatus(flightIata, flightDate)), and the contract enforces a single
 * active policy per flightId. Keying on the code alone would collide across
 * days — the second day's "ET309" would revert in insureFlight ("policy exists")
 * and the indexer could not tell two days' flights apart. Including the date
 * makes each (flight, day) a distinct, collision-free key.
 *
 * Solidity equivalent (for the contract caller / front-end):
 *   keccak256(abi.encodePacked(flightIata, "-", flightDate))
 * which is byte-for-byte identical to keccak256 over the UTF-8 string
 * `${flightIata}-${flightDate}`.
 */

/** Strict "YYYY-MM-DD" guard so a timestamp or locale string can't slip in. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Derive the canonical bytes32 flightId for a flight on a given UTC date.
 *
 * @param flightIata  IATA flight code; case-insensitive (upper-cased here).
 * @param flightDate  Scheduled-departure calendar date in UTC, "YYYY-MM-DD".
 * @returns           0x-prefixed bytes32 hex string.
 * @throws            If flightDate is not in "YYYY-MM-DD" form.
 */
export function canonicalFlightId(flightIata: string, flightDate: string): string {
  if (!ISO_DATE.test(flightDate)) {
    throw new Error(
      `flightDate must be "YYYY-MM-DD" (UTC), got "${flightDate}". ` +
      `Use the scheduled-departure calendar date, not a timestamp.`,
    );
  }
  const composed = `${flightIata.toUpperCase()}-${flightDate}`;
  return ethers.keccak256(ethers.toUtf8Bytes(composed));
}
