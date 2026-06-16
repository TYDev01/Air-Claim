/**
 * Date helpers for AirClaim.
 *
 * Flights are keyed by their scheduled-departure UTC calendar date in strict
 * "YYYY-MM-DD" form (see `flightId.ts`). These helpers keep that format honest
 * and convert between the calendar date, display strings, and the uint64 unix
 * timestamp the contract takes as a separate `flightDate` argument.
 */

/** Strict "YYYY-MM-DD" guard so a timestamp or locale string can't slip in. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Assert that a string is a strict "YYYY-MM-DD" (UTC) calendar date.
 *
 * Validates both shape and real-calendar validity (e.g. rejects "2026-02-30"),
 * narrowing the input so callers can treat it as a trusted date string.
 *
 * @param flightDate  Candidate date string.
 * @throws            If not in "YYYY-MM-DD" form or not a real calendar date.
 */
export function assertIsoDate(flightDate: string): void {
  if (!ISO_DATE.test(flightDate)) {
    throw new Error(
      `flightDate must be "YYYY-MM-DD" (UTC), got "${flightDate}". ` +
        `Use the scheduled-departure calendar date, not a timestamp.`,
    );
  }
  const asUtc = new Date(`${flightDate}T00:00:00.000Z`);
  if (Number.isNaN(asUtc.getTime()) || asUtc.toISOString().slice(0, 10) !== flightDate) {
    throw new Error(`flightDate "${flightDate}" is not a valid calendar date.`);
  }
}
