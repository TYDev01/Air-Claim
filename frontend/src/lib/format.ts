/**
 * Display-formatting helpers for AirClaim (addresses, flight dates, etc.).
 * Pure presentation — no chain access.
 */

/**
 * Shorten an address for display, e.g. "0x1234…cdef".
 *
 * Falls back to returning the input unchanged when it is too short to truncate
 * meaningfully, so malformed or already-short values don't get mangled.
 *
 * @param address  The address (or any hex string) to shorten.
 * @param chars    Hex chars to keep on each side of the ellipsis (default 4).
 * @returns        The truncated address.
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

/**
 * Format a scheduled-departure unix timestamp (the contract's uint64
 * `flightDate`, in SECONDS) as a human-readable UTC datetime.
 *
 * Rendered in UTC to match how flights are keyed (UTC calendar date), so the
 * displayed day never drifts from the `flightId` the policy was created under.
 *
 * @param ts  Unix timestamp in seconds (bigint from chain, or number).
 * @returns   e.g. "15 Jun 2026, 14:30 UTC".
 */
export function formatFlightDate(ts: bigint | number): string {
  const seconds = typeof ts === "bigint" ? Number(ts) : ts;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(date) + " UTC";
}
