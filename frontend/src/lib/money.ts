/**
 * Money helpers for AirClaim.
 *
 * All on-chain amounts (ticket prices, premiums, payouts) are CELO wei — native
 * CELO with 18 decimals. Never assume a fixed display precision; convert through
 * these helpers, which wrap viem's `formatEther` / `parseEther`.
 */
import { formatEther } from "viem";

/**
 * Format a CELO wei amount into a human display string.
 *
 * Trims trailing-zero noise from the 18-decimal expansion (so `1.5e18` shows as
 * "1.5", not "1.500000000000000000") and optionally appends a unit symbol.
 *
 * @param wei     Amount in CELO wei.
 * @param symbol  Optional unit to append, e.g. "CELO". Omitted by default.
 * @returns       Display string, e.g. "1.5" or "1.5 CELO".
 */
export function formatCelo(wei: bigint, symbol?: string): string {
  const raw = formatEther(wei);
  const trimmed = raw.includes(".") ? raw.replace(/\.?0+$/, "") : raw;
  return symbol ? `${trimmed} ${symbol}` : trimmed;
}
