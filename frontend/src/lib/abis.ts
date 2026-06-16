/**
 * ABI accessors for AirClaim.
 *
 * ABIs are COPIES of the committed source of truth in `backend/abis/*.json`,
 * re-extracted via `npm run abis:extract` at the repo root. Never hand-edit the
 * copies in `src/abi/` — CI's `abis:check` will fail if they drift.
 */
import type { Abi } from "viem";

import insuredFlightsAgency from "@/abi/InsuredFlightsAgency.json";
import flightOracle from "@/abi/FlightOracle.json";

/**
 * The InsuredFlightsAgency ABI, typed as a viem `Abi` for use with wagmi's
 * `useReadContract` / `useWriteContract`.
 *
 * @returns The InsuredFlightsAgency contract ABI.
 */
export function importInsuredFlightsAgencyAbi(): Abi {
  return insuredFlightsAgency as Abi;
}

/**
 * The FlightOracle ABI, typed as a viem `Abi`. Used to read oracle state /
 * watch delay-confirmation events; the UI does not call its keeper methods.
 *
 * @returns The FlightOracle contract ABI.
 */
export function importFlightOracleAbi(): Abi {
  return flightOracle as Abi;
}
