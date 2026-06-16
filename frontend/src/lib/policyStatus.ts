/**
 * Policy status derivation for AirClaim.
 *
 * Collapses the on-chain `policyInfo` + `passengerInfo` reads into a single UI
 * state so components don't re-implement the branching. Shapes mirror the
 * contract views (see the InsuredFlightsAgency ABI).
 */

/** Subset of `policyInfo(flightId) → PolicyView` the status logic needs. */
export interface PolicyView {
  /** Whether a policy exists for this flightId. */
  exists: boolean;
  /** Whether the oracle has confirmed a delay/cancellation (payout open). */
  claimable: boolean;
}

/** Result of `passengerInfo(flightId, account) → (found, ticketPrice, claimed)`. */
export interface PassengerInfo {
  /** Whether the account is an insured passenger on this policy. */
  found: boolean;
  /** Whether the account has already claimed its payout. */
  claimed: boolean;
}

/**
 * UI-facing policy status.
 * - `none`       — no policy exists for this flight.
 * - `scheduled`  — insured, no delay confirmed yet.
 * - `delayed`    — delay confirmed; payouts open (account is not a passenger).
 * - `claimable`  — delay confirmed; connected account can claim now.
 * - `claimed`    — connected account already claimed.
 */
export type PolicyStatus = "none" | "scheduled" | "delayed" | "claimable" | "claimed";

/**
 * Derive the UI policy status from the on-chain reads.
 *
 * @param policy     The `policyInfo` view, or undefined while loading.
 * @param passenger  The `passengerInfo` view for the connected account, if any.
 * @returns          The collapsed {@link PolicyStatus}.
 */
export function derivePolicyStatus(
  policy: PolicyView | undefined,
  passenger?: PassengerInfo,
): PolicyStatus {
  if (!policy || !policy.exists) return "none";
  if (!policy.claimable) return "scheduled";
  if (passenger?.found) return passenger.claimed ? "claimed" : "claimable";
  return "delayed";
}
