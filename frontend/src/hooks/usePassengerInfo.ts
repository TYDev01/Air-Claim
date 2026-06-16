"use client";

/**
 * Read hook for InsuredFlightsAgency.passengerInfo(bytes32 flightId, address).
 *
 * Returns (bool found, uint256 ticketPrice, bool claimed) for the given account
 * on the given policy. Drives claim eligibility: a wallet can claim only when
 * `found && !claimed` on a claimable policy.
 */
import { useChainId, useReadContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Read a passenger's record on a policy.
 *
 * @param flightId  Canonical bytes32 flightId, or undefined while unknown.
 * @param account   Passenger address, or undefined when no wallet is connected.
 * @returns         wagmi read result; `data` is `[found, ticketPrice, claimed]`.
 *                  Idle until both flightId and account are provided.
 */
export function usePassengerInfo(
  flightId: `0x${string}` | undefined,
  account: `0x${string}` | undefined,
) {
  const chainId = useChainId();

  return useReadContract({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    functionName: "passengerInfo",
    args: flightId && account ? [flightId, account] : undefined,
    query: { enabled: Boolean(flightId && account) },
  });
}
