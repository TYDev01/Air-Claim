"use client";

/**
 * Write hook for InsuredFlightsAgency.insureFlight(...) payable.
 *
 * Sends the insure transaction and tracks it to receipt. The premium MUST equal
 * `premiumFor(ticketPrices)` exactly — pass that value as `premium`; the
 * contract reverts on any other `msg.value` and does not refund excess.
 */
import { useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses, type Address } from "@/lib/contracts";

/** Arguments for an insure transaction (premium is the exact quoted total). */
export interface InsureFlightParams {
  flightId: `0x${string}`;
  flightNumber: string;
  departure: string;
  arrival: string;
  /** Scheduled-departure unix timestamp (uint64 seconds); must be in the future. */
  flightDate: bigint;
  passengers: readonly Address[];
  /** Per-passenger ticket prices in CELO wei. */
  ticketPrices: readonly bigint[];
  /** Exact premium from `premiumFor(ticketPrices)`, sent as msg.value. */
  premium: bigint;
}

/**
 * Insure a flight and follow the transaction to confirmation.
 *
 * @returns  `insure(params)` to submit, the write result, and the receipt-wait
 *           state (`isConfirming` / `isConfirmed`) for UX.
 */
export function useInsureFlight() {
  const chainId = useChainId();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  function insure(params: InsureFlightParams) {
    return write.writeContract({
      abi: importInsuredFlightsAgencyAbi(),
      address: getContractAddresses(chainId).insuredFlightsAgency,
      functionName: "insureFlight",
      args: [
        params.flightId,
        params.flightNumber,
        params.departure,
        params.arrival,
        params.flightDate,
        params.passengers,
        params.ticketPrices,
      ],
      value: params.premium,
    });
  }

  return {
    insure,
    hash: write.data,
    error: write.error,
    isPending: write.isPending,
    isConfirming: receipt.isLoading,
    isConfirmed: receipt.isSuccess,
  };
}
