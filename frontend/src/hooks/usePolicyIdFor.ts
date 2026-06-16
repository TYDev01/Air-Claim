"use client";

/**
 * Read hook for InsuredFlightsAgency.policyIdFor(bytes32 flightId).
 *
 * Returns the numeric policyId for a flightId (0 when no policy exists). Useful
 * for deep links / display; richer state should come from `usePolicyInfo`.
 */
import { useChainId, useReadContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Read the policyId for a flightId.
 *
 * @param flightId  Canonical bytes32 flightId, or undefined while unknown.
 * @returns         wagmi read result; `data` is the policyId (uint256). Idle
 *                  until a flightId is provided.
 */
export function usePolicyIdFor(flightId: `0x${string}` | undefined) {
  const chainId = useChainId();

  return useReadContract({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    functionName: "policyIdFor",
    args: flightId ? [flightId] : undefined,
    query: { enabled: Boolean(flightId) },
  });
}
