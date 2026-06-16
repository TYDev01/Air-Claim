/**
 * Canonical flightId encoding — the front-end mirror of the project-wide source
 * of truth at `scripts/config/flightId.ts`. Every caller (contract, oracle,
 * indexer, this UI) MUST derive flightId identically or policies/oracle records
 * will silently fail to line up and `insureFlight` may revert.
 *
 *   flightId = keccak256(abi.encodePacked(flightIata, "-", flightDate))
 *
 * where flightIata is the upper-cased IATA code (e.g. "ET309") and flightDate is
 * the scheduled-departure CALENDAR date in UTC, "YYYY-MM-DD". This is byte-for-
 * byte identical to keccak256 over the UTF-8 string `${IATA}-${YYYY-MM-DD}`.
 */
import { keccak256, toBytes } from "viem";

import { assertIsoDate } from "./dates";

/**
 * Derive the canonical bytes32 flightId for a flight on a given UTC date.
 *
 * @param flightIata  IATA flight code; case-insensitive (upper-cased here).
 * @param flightDate  Scheduled-departure calendar date in UTC, "YYYY-MM-DD".
 * @returns           0x-prefixed bytes32 hex string.
 * @throws            If flightDate is not in "YYYY-MM-DD" form.
 */
export function canonicalFlightId(
  flightIata: string,
  flightDate: string,
): `0x${string}` {
  assertIsoDate(flightDate);
  return keccak256(toBytes(`${flightIata.toUpperCase()}-${flightDate}`));
}
