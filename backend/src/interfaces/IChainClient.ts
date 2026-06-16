/**
 * Typed wrapper around viem for the two contracts this backend writes to.
 *
 * All ABI encoding, nonce management, EIP-1559 fee strategy, and confirmation
 * waiting are encapsulated here. The rest of the system calls typed methods
 * and receives typed results — no raw hex, no hand-written signatures.
 *
 * ABIs are loaded from compiled artifacts, never hand-written.
 */

// ─── On-chain enum mirrors ────────────────────────────────────────────────────

/**
 * Mirrors the canonical FlightStatus enum in contracts/interfaces/IFlightOracle.sol
 * (the source of truth). Values must match the contract exactly (0-indexed), and
 * the Prisma `OnChainStatus` enum in prisma/schema.prisma must mirror the same
 * order. Append only — never reorder or insert in the middle.
 */
export enum OnChainFlightStatus {
  Scheduled = 0,
  Delayed   = 1,
  Cancelled = 2,
  Landed    = 3,
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface TxResult {
  /** Transaction hash as submitted. */
  txHash: `0x${string}`;
  /** Block number the tx was included in (after confirmation). */
  blockNumber: bigint;
  /** Gas units consumed. */
  gasUsed: bigint;
}

export interface OracleFlightRecord {
  status: OnChainFlightStatus;
  delayMinutes: number;
  source: string;
  updatedAt: number;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IChainClient {
  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Returns true if `address` holds UPDATER_ROLE on FlightOracle.
   * Used at boot to verify the configured wallet is authorised.
   */
  hasUpdaterRole(address: `0x${string}`): Promise<boolean>;

  /**
   * Reads the current FlightRecord from the oracle for `flightId`.
   * Returns null if no record exists yet.
   */
  getOracleFlightRecord(flightId: `0x${string}`): Promise<OracleFlightRecord | null>;

  /**
   * Returns true if the IFA policy for `flightId` is already claimable.
   * Used by the keeper to skip flights already opened.
   */
  isPolicyClaimable(flightId: `0x${string}`): Promise<boolean>;

  /**
   * Returns the updater wallet's current CELO balance (wei).
   * Used for low-balance alerting.
   */
  getUpdaterBalance(): Promise<bigint>;

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Calls FlightOracle.updateFlight(flightId, status, delayMinutes, source).
   *
   * Manages nonce sequencing and EIP-1559 fees internally.
   * Waits for `confirmations` blocks before resolving.
   * On a stuck tx (not mined within `txTimeoutSeconds`), bumps maxFeePerGas
   * and resubmits, returning the new hash via TxResult.
   *
   * @throws if the tx reverts or all retry attempts are exhausted.
   */
  updateFlight(
    flightId: `0x${string}`,
    status: OnChainFlightStatus,
    delayMinutes: number,
    source: string,
  ): Promise<TxResult>;

  /**
   * Calls InsuredFlightsAgency.checkFlightDelay(flightId).
   *
   * Same nonce/fee/confirmation semantics as updateFlight.
   * May revert if the contract-side cooldown hasn't elapsed — the caller
   * must gate on keeper_last_called_at before invoking.
   *
   * @throws if the tx reverts or all retry attempts are exhausted.
   */
  checkFlightDelay(flightId: `0x${string}`): Promise<TxResult>;
}
