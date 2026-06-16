/**
 * Money helpers for AirClaim.
 *
 * All on-chain amounts (ticket prices, premiums, payouts) are CELO wei — native
 * CELO with 18 decimals. Never assume a fixed display precision; convert through
 * these helpers, which wrap viem's `formatEther` / `parseEther`.
 */
import { formatEther, parseEther } from "viem";

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

/**
 * Parse a user-entered CELO amount into wei.
 *
 * Accepts a plain decimal string (no symbol, no thousands separators), rejecting
 * blanks, negatives, and malformed input before handing off to viem's
 * `parseEther` — so callers get a clear error instead of a silent `0n`.
 *
 * @param input  Decimal CELO amount as typed, e.g. "1.5".
 * @returns      Amount in CELO wei.
 * @throws       If the input is blank, negative, or not a valid decimal number.
 */
export function parseCelo(input: string): bigint {
  const value = input.trim();
  if (value === "" || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid CELO amount "${input}". Use a plain decimal like "1.5".`);
  }
  return parseEther(value);
}
