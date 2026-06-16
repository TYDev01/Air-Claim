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
