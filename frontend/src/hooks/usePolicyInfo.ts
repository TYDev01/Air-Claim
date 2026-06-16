"use client";

/**
 * Read hook for InsuredFlightsAgency.policyInfo(bytes32 flightId).
 *
 * Returns the PolicyView struct { policyId, flightId, flightNumber, departure,
 * arrival, flightDate, claimable, exists, passengerCount }. Use `exists` to tell
 * "no policy" from a still-loading read, and feed `claimable`/`exists` into
 * `derivePolicyStatus`.
 */
import { useChainId, useReadContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Read the policy view for a flightId.
 *
 * @param flightId  Canonical bytes32 flightId, or undefined while unknown.
 * @returns         wagmi read result; `data` is the PolicyView. Idle until a
 *                  flightId is provided.
 */
export function usePolicyInfo(flightId: `0x${string}` | undefined) {
  const chainId = useChainId();

  return useReadContract({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    functionName: "policyInfo",
    args: flightId ? [flightId] : undefined,
    query: { enabled: Boolean(flightId) },
  });
}
