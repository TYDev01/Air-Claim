"use client";

/**
 * Write hook for InsuredFlightsAgency.claimInsurance(bytes32 flightId).
 *
 * Claims a delay payout for the connected wallet. Only succeeds when the policy
 * is claimable and the caller is an insured passenger who has not yet claimed;
 * the payout currency (cUSD or native CELO) is decided on-chain at claim time
 * and surfaced via the `InsuranceClaimed` event.
 */
import { useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { importInsuredFlightsAgencyAbi } from "@/lib/abis";
import { getContractAddresses } from "@/lib/contracts";

/**
 * Claim a delay payout and follow the transaction to confirmation.
 *
 * @returns  `claim(flightId)` to submit, plus the write result and
 *           receipt-wait state (`isConfirming` / `isConfirmed`) for UX.
 */
export function useClaimInsurance() {
  const chainId = useChainId();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  function claim(flightId: `0x${string}`) {
    return write.writeContract({
      abi: importInsuredFlightsAgencyAbi(),
      address: getContractAddresses(chainId).insuredFlightsAgency,
      functionName: "claimInsurance",
      args: [flightId],
    });
  }

  return {
    claim,
    hash: write.data,
    error: write.error,
    isPending: write.isPending,
    isConfirming: receipt.isLoading,
    isConfirmed: receipt.isSuccess,
  };
}
