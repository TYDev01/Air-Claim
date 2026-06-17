"use client";

/**
 * Event hook for InsuredFlightsAgency `DelayConfirmed`.
 *
 * Fires when the oracle confirms a delay/cancellation and a policy becomes
 * claimable. Use it to flip tracked policies to the "claimable" state and to
 * prompt insured passengers to claim.
 */
import { useChainId, useWatchContractEvent } from "wagmi";
import type { Log } from "viem";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Subscribe to `DelayConfirmed` logs.
 *
 * @param onLogs  Callback invoked with each batch of decoded event logs.
 */
export function useWatchDelayConfirmed(onLogs: (logs: Log[]) => void): void {
  const chainId = useChainId();

  useWatchContractEvent({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    eventName: "DelayConfirmed",
    onLogs,
  });
}
