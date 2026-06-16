"use client";

/**
 * Read hook for InsuredFlightsAgency.premiumFor(uint256[] ticketPrices).
 *
 * The returned premium MUST be sent EXACTLY as `msg.value` to `insureFlight` —
 * the contract reverts on any other amount. Always quote via this hook rather
 * than computing the premium client-side.
 */
import { useChainId, useReadContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Quote the total premium for a set of per-passenger ticket prices.
 *
 * @param ticketPrices  Per-passenger ticket prices in CELO wei.
 * @returns             wagmi read result; `data` is the total premium (wei).
 *                      Idle until at least one ticket price is provided.
 */
export function usePremiumFor(ticketPrices: readonly bigint[]) {
  const chainId = useChainId();

  return useReadContract({
    abi: importInsuredFlightsAgencyAbi(),
    address: getContractAddresses(chainId).insuredFlightsAgency,
    functionName: "premiumFor",
    args: [ticketPrices],
    query: { enabled: ticketPrices.length > 0 },
  });
}
