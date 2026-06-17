"use client";

/**
 * Event hook for InsuredFlightsAgency `FlightInsured`.
 *
 * Fires when a policy is created. Use it for toasts and optimistic refresh of
 * policy reads after an insure transaction lands.
 */
import { useChainId, useWatchContractEvent } from "wagmi";
import type { Log } from "viem";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Subscribe to `FlightInsured` logs.
 *
 * @param onLogs  Callback invoked with each batch of decoded event logs.
 */
export function useWatchFlightInsured(onLogs: (logs: Log[]) => void): void {
  const chainId = useChainId();

  useWatchContractEvent({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    eventName: "FlightInsured",
    onLogs,
  });
}
