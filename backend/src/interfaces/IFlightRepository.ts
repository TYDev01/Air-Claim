/**
 * Persistence abstraction for tracked flights, the transaction outbox, and the
 * event-indexer cursor. All state that must survive a restart lives here.
 *
 * The implementation (PrismaRepository) is wired in main.ts. Tests use an
 * in-memory double that implements this interface.
 */

import { OnChainFlightStatus } from "./IChainClient.js";

// ─── Domain types ─────────────────────────────────────────────────────────────

/** Values that can be stored in tracked_flight.last_submitted_status. */
export type SubmittedStatus = OnChainFlightStatus;

/** Matches the tracked_flight table. */
export interface TrackedFlight {
  id: string;
  /** bytes32 hex string — matches the contract's flightId (keccak256 of flightIata). */
  flightId: string;
  flightIata: string;
  flightDate: string; // "YYYY-MM-DD" UTC
  originIata: string;
  destIata: string;
  scheduledDepartureUtc: Date;
  /** May be null if not yet known at policy-creation time. */
  scheduledArrivalUtc: Date | null;
  lastSubmittedStatus: SubmittedStatus;
  lastSubmittedDelayMinutes: number;
  lastSubmittedAt: Date | null;
  /** true once the flight reaches Landed or Cancelled on-chain. */
  isTerminal: boolean;
  /** Scheduler won't call keeper before this timestamp. */
  keeperEligibleAfter: Date | null;
  keeperLastCalledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input shape for creating a new tracked flight. */
export type CreateTrackedFlight = Pick<
  TrackedFlight,
  | "flightId"
  | "flightIata"
  | "flightDate"
  | "originIata"
  | "destIata"
  | "scheduledDepartureUtc"
  | "scheduledArrivalUtc"
  | "keeperEligibleAfter"
>;

// ── Outbox ────────────────────────────────────────────────────────────────────

export type OutboxKind = "oracle_update" | "keeper_check";
export type OutboxStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface OutboxEntry {
  id: string;
  flightId: string;
  kind: OutboxKind;
  /** Populated only for oracle_update entries. */
  intendedStatus: SubmittedStatus | null;
  intendedDelayMinutes: number | null;
  status: OutboxStatus;
  txHash: string | null;
  attempts: number;
  lastError: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

export type CreateOutboxEntry = Pick<
  OutboxEntry,
  "flightId" | "kind" | "intendedStatus" | "intendedDelayMinutes"
>;

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IFlightRepository {
  // ── Tracked flights ────────────────────────────────────────────────────────

  /** Insert a new tracked flight. Silently ignores duplicate flightId (upsert). */
  upsertTrackedFlight(data: CreateTrackedFlight): Promise<TrackedFlight>;

  /** Fetch a tracked flight by its bytes32 flightId. Returns null if not found. */
  getTrackedFlight(flightId: string): Promise<TrackedFlight | null>;

  /** All non-terminal tracked flights — the polling work list. */
  listActiveFlights(): Promise<TrackedFlight[]>;

  /**
   * All non-terminal flights whose keeperEligibleAfter ≤ now and whose
   * keeperLastCalledAt is either null or older than `cooldownSeconds`.
   */
  listKeeperEligibleFlights(cooldownSeconds: number): Promise<TrackedFlight[]>;

  /**
   * Update the last-submitted state after a confirmed oracle_update tx.
   * Sets lastSubmittedStatus, lastSubmittedDelayMinutes, lastSubmittedAt.
   * Marks isTerminal=true if status is Landed or Cancelled.
   */
  markSubmitted(
    flightId: string,
    status: SubmittedStatus,
    delayMinutes: number,
    at: Date,
  ): Promise<void>;

  /** Record a keeper call attempt timestamp. */
  markKeeperCalled(flightId: string, at: Date): Promise<void>;

  /** Mark a flight terminal (stop polling and keeping). */
  markTerminal(flightId: string): Promise<void>;

  // ── Transaction outbox ─────────────────────────────────────────────────────

  /**
   * Create a new pending outbox entry.
   * Returns null (no-op) if there is already a pending or submitted entry for
   * the same flightId + kind — idempotency guard.
   */
  createOutboxEntry(data: CreateOutboxEntry): Promise<OutboxEntry | null>;

  /** All pending entries not yet submitted. */
  listPendingOutboxEntries(): Promise<OutboxEntry[]>;

  /** Mark entry as submitted; record the tx hash. */
  markOutboxSubmitted(id: string, txHash: string): Promise<void>;

  /** Mark entry as confirmed; record confirmation timestamp. */
  markOutboxConfirmed(id: string, at: Date): Promise<void>;

  /** Record a failure; increment attempts; set lastError. */
  markOutboxFailed(id: string, error: string): Promise<void>;

  // ── Indexer cursor ─────────────────────────────────────────────────────────

  /** Returns the last block fully processed by the event indexer, or null on first run. */
  getIndexerCursor(): Promise<bigint | null>;

  /** Advance the cursor to `blockNumber` after successfully processing that block. */
  setIndexerCursor(blockNumber: bigint): Promise<void>;
}
