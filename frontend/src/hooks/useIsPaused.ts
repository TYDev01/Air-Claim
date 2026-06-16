"use client";

/**
 * Read hook for InsuredFlightsAgency.paused() → bool.
 *
 * The contract has an owner emergency stop; while paused, `insureFlight` and
 * `claimInsurance` revert. The UI should disable those actions and explain why
 * when this reads `true`.
 */
import { useChainId, useReadContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Read whether the InsuredFlightsAgency is paused.
 *
 * @returns  wagmi read result; `data` is `true` when the contract is paused.
 */
export function useIsPaused() {
  const chainId = useChainId();

  return useReadContract({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    functionName: "paused",
  });
}
