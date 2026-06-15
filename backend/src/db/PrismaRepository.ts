/**
 * Prisma implementation of IFlightRepository.
 *
 * All persistence operations for tracked flights, the transaction outbox,
 * and the indexer cursor go through this class. Every method maps cleanly
 * between Prisma-generated types and the domain types in IFlightRepository.
 *
 * The Prisma client is created once and reused — never instantiated per-call.
 * Call connect() after construction and disconnect() on graceful shutdown.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import type {
  IFlightRepository,
  TrackedFlight,
  CreateTrackedFlight,
  OutboxEntry,
  CreateOutboxEntry,
  OutboxKind,
  OutboxStatus,
  SubmittedStatus,
} from "../interfaces/IFlightRepository.js";
import { OnChainFlightStatus } from "../interfaces/IChainClient.js";
import type { Logger } from "../logger.js";

// ─── Prisma enum → domain enum helpers ───────────────────────────────────────

// Prisma generates string-union enums; we map to/from the numeric OnChainFlightStatus.

const STATUS_TO_PRISMA: Record<OnChainFlightStatus, "Scheduled" | "Delayed" | "Cancelled" | "Landed"> = {
  [OnChainFlightStatus.Scheduled]: "Scheduled",
  [OnChainFlightStatus.Delayed]:   "Delayed",
  [OnChainFlightStatus.Cancelled]: "Cancelled",
  [OnChainFlightStatus.Landed]:    "Landed",
};

const PRISMA_TO_STATUS: Record<string, OnChainFlightStatus> = {
  Scheduled: OnChainFlightStatus.Scheduled,
  Delayed:   OnChainFlightStatus.Delayed,
  Cancelled: OnChainFlightStatus.Cancelled,
  Landed:    OnChainFlightStatus.Landed,
};

function toPrismaStatus(s: SubmittedStatus) { return STATUS_TO_PRISMA[s]; }
function fromPrismaStatus(s: string): OnChainFlightStatus {
  const v = PRISMA_TO_STATUS[s];
  if (v === undefined) throw new Error(`Unknown Prisma OnChainStatus value: ${s}`);
  return v;
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

type PrismaFlight  = Awaited<ReturnType<PrismaClient["trackedFlight"]["findUniqueOrThrow"]>>;
type PrismaOutbox  = Awaited<ReturnType<PrismaClient["txOutbox"]["findUniqueOrThrow"]>>;

function mapFlight(row: PrismaFlight): TrackedFlight {
  return {
    id:                       row.id,
    flightId:                 row.flightId,
    flightIata:               row.flightIata,
    flightDate:               row.flightDate,
    originIata:               row.originIata,
    destIata:                 row.destIata,
    scheduledDepartureUtc:    row.scheduledDepartureUtc,
    scheduledArrivalUtc:      row.scheduledArrivalUtc,
    lastSubmittedStatus:      fromPrismaStatus(row.lastSubmittedStatus),
    lastSubmittedDelayMinutes: row.lastSubmittedDelayMinutes,
    lastSubmittedAt:          row.lastSubmittedAt,
    isTerminal:               row.isTerminal,
    keeperEligibleAfter:      row.keeperEligibleAfter,
    keeperLastCalledAt:       row.keeperLastCalledAt,
    createdAt:                row.createdAt,
    updatedAt:                row.updatedAt,
  };
}

function mapOutbox(row: PrismaOutbox): OutboxEntry {
  return {
    id:                   row.id,
    flightId:             row.flightId,
    kind:                 row.kind as OutboxKind,
    intendedStatus:       row.intendedStatus ? fromPrismaStatus(row.intendedStatus) : null,
    intendedDelayMinutes: row.intendedDelayMinutes,
    status:               row.status as OutboxStatus,
    txHash:               row.txHash,
    attempts:             row.attempts,
    lastError:            row.lastError,
    submittedAt:          row.submittedAt,
    confirmedAt:          row.confirmedAt,
    createdAt:            row.createdAt,
  };
}

// ─── PrismaRepository ─────────────────────────────────────────────────────────

export class PrismaRepository implements IFlightRepository {
  private readonly db:     PrismaClient;
  private readonly logger: Logger;

  /**
   * Create a PrismaRepository over a shared PrismaClient.
   *
   * @param prisma  The single PrismaClient owned by the process. The repository
   *                never creates its own client — connection lifecycle is managed
   *                by whoever owns this instance (main.ts), so connect()/disconnect()
   *                here operate on the same pool the rest of the app uses.
   * @param logger  Root logger; a child with component="PrismaRepository" is created.
   *
   * The underlying connection pool is established lazily on the first query.
   * Call connect() to eagerly verify DB reachability at boot.
   */
  constructor(prisma: PrismaClient, logger: Logger) {
    this.db     = prisma;
    this.logger = logger.child({ component: "PrismaRepository" });
  }

  /**
   * Eagerly open the connection pool and verify DB reachability.
   * Call once at startup before accepting work.
   * @throws if the database is unreachable.
   */
  async connect(): Promise<void> {
    await this.db.$connect();
    this.logger.info("Database connection established");
  }

  /**
   * Gracefully close the connection pool.
   * Call on SIGTERM/SIGINT before process exit.
   */
  async disconnect(): Promise<void> {
    await this.db.$disconnect();
    this.logger.info("Database connection closed");
  }

  // ── IFlightRepository methods (implemented in subsequent commits) ──────────

  /**
   * Insert a new tracked flight or update the scheduling fields if a row for
   * this flightId already exists.
   *
   * The upsert key is flightId (unique). On conflict, only non-status fields
   * are updated — lastSubmittedStatus and isTerminal are never overwritten by
   * a re-index of the same event (idempotent re-processing of reorged blocks).
   */
  async upsertTrackedFlight(data: CreateTrackedFlight): Promise<TrackedFlight> {
    const row = await this.db.trackedFlight.upsert({
      where:  { flightId: data.flightId },
      create: {
        flightId:             data.flightId,
        flightIata:           data.flightIata,
        flightDate:           data.flightDate,
        originIata:           data.originIata,
        destIata:             data.destIata,
        scheduledDepartureUtc: data.scheduledDepartureUtc,
        scheduledArrivalUtc:  data.scheduledArrivalUtc ?? null,
        keeperEligibleAfter:  data.keeperEligibleAfter ?? null,
      },
      update: {
        // Refresh scheduling fields in case the event is re-processed after
        // a reorg with updated times; never touch status or terminal flag.
        scheduledDepartureUtc: data.scheduledDepartureUtc,
        scheduledArrivalUtc:   data.scheduledArrivalUtc ?? null,
        keeperEligibleAfter:   data.keeperEligibleAfter ?? null,
      },
    });

    this.logger.debug({ flightId: data.flightId }, "Tracked flight upserted");
    return mapFlight(row);
  }

  /**
   * Fetch a tracked flight by its bytes32 flightId hex string.
   * Returns null if no row exists — callers must handle the not-found case
   * rather than assuming every polled flightId is tracked.
   */
  async getTrackedFlight(flightId: string): Promise<TrackedFlight | null> {
    const row = await this.db.trackedFlight.findUnique({
      where: { flightId },
    });
    return row ? mapFlight(row) : null;
  }

  /**
   * Returns all non-terminal tracked flights ordered by scheduled departure.
   *
   * This is the scheduler's polling work list — every flight returned here
   * will be polled against AviationStack on the next tick. Terminal flights
   * (Landed or Cancelled confirmed on-chain) are excluded so polling stops
   * automatically once a flight reaches its final state.
   *
   * Ordered by scheduledDepartureUtc ascending so flights closest to
   * departure are processed first (highest urgency).
   */
  async listActiveFlights(): Promise<TrackedFlight[]> {
    const rows = await this.db.trackedFlight.findMany({
      where:   { isTerminal: false },
      orderBy: { scheduledDepartureUtc: "asc" },
    });
    return rows.map(mapFlight);
  }

  /**
   * Returns non-terminal flights that the keeper should call checkFlightDelay on.
   *
   * A flight is eligible when ALL of the following hold:
   *  1. isTerminal = false (still being tracked)
   *  2. keeperEligibleAfter ≤ now (scheduled arrival + buffer has passed)
   *  3. keeperLastCalledAt IS NULL  OR  keeperLastCalledAt ≤ now - cooldownSeconds
   *     (respects the contract's own check cooldown so we don't waste gas)
   *
   * @param cooldownSeconds  Minimum gap between keeper calls for the same flight.
   *                         Must be >= the contract's checkCooldownSeconds (300 s).
   */
  async listKeeperEligibleFlights(cooldownSeconds: number): Promise<TrackedFlight[]> {
    const now          = new Date();
    const cooldownCutoff = new Date(now.getTime() - cooldownSeconds * 1_000);

    const rows = await this.db.trackedFlight.findMany({
      where: {
        isTerminal:         false,
        keeperEligibleAfter: { lte: now },
        OR: [
          { keeperLastCalledAt: null },
          { keeperLastCalledAt: { lte: cooldownCutoff } },
        ],
      },
      orderBy: { keeperEligibleAfter: "asc" },
    });

    return rows.map(mapFlight);
  }

  /**
   * Record a successfully confirmed oracle_update on the tracked flight.
   *
   * Updates:
   *  - lastSubmittedStatus, lastSubmittedDelayMinutes, lastSubmittedAt
   *  - isTerminal = true when status is Landed or Cancelled — polling and
   *    keeping stop automatically on the next scheduler tick
   *
   * Called by OracleUpdater after ChainClient.updateFlight() resolves with
   * a confirmed TxResult. Never called for dry-run submissions.
   */
  async markSubmitted(
    flightId:     string,
    status:       SubmittedStatus,
    delayMinutes: number,
    at:           Date,
  ): Promise<void> {
    const isTerminal =
      status === OnChainFlightStatus.Landed ||
      status === OnChainFlightStatus.Cancelled;

    await this.db.trackedFlight.update({
      where: { flightId },
      data: {
        lastSubmittedStatus:       toPrismaStatus(status),
        lastSubmittedDelayMinutes: delayMinutes,
        lastSubmittedAt:           at,
        isTerminal,
      },
    });

    this.logger.debug(
      { flightId, status, delayMinutes, isTerminal },
      "Tracked flight marked submitted",
    );
  }

  /**
   * Record the timestamp of a keeper checkFlightDelay call attempt.
   *
   * This timestamp is used by listKeeperEligibleFlights() to enforce the
   * cooldown window between calls — preventing the keeper from submitting
   * a checkFlightDelay tx that would revert because the contract's own
   * CHECK_COOLDOWN_SECONDS has not yet elapsed.
   *
   * Called immediately before submitting the keeper tx (not after confirmation)
   * so that a crash mid-submission does not leave the cooldown unenforced on
   * restart and cause a duplicate gas-wasting call.
   */
  async markKeeperCalled(flightId: string, at: Date): Promise<void> {
    await this.db.trackedFlight.update({
      where: { flightId },
      data:  { keeperLastCalledAt: at },
    });

    this.logger.debug({ flightId, at }, "Keeper call timestamp recorded");
  }

  /**
   * Explicitly mark a flight terminal, stopping all further polling and keeping.
   *
   * This is a safety escape hatch for cases where the terminal state is
   * determined outside of markSubmitted() — for example:
   *  - An operator manually resolving a stuck flight via the admin interface.
   *  - The FlightTracker detecting that a policy has already been claimed
   *    on-chain (no further oracle updates needed).
   *  - Integration tests that need to fast-forward a flight to terminal state.
   *
   * Note: markSubmitted() already sets isTerminal=true for Landed/Cancelled
   * statuses. Call this method only when markSubmitted() has not been called
   * or is not appropriate.
   */
  async markTerminal(flightId: string): Promise<void> {
    await this.db.trackedFlight.update({
      where: { flightId },
      data:  { isTerminal: true },
    });

    this.logger.info({ flightId }, "Flight marked terminal — polling and keeping stopped");
  }

  /**
   * Create a new pending outbox entry for an intended on-chain write.
   *
   * Idempotency guard: returns null (no-op) if a row already exists for
   * this (flightId, kind) pair with status pending or submitted. This
   * prevents double-enqueuing the same write when:
   *  - The OracleUpdater is called twice before the first submission completes.
   *  - The service restarts and re-processes the same polling tick.
   *  - A reorged block is re-indexed and triggers a duplicate event.
   *
   * A failed entry does NOT block a new one — the previous attempt is done
   * and a fresh submission is legitimate.
   *
   * @returns The created OutboxEntry, or null if an active entry already exists.
   */
  async createOutboxEntry(data: CreateOutboxEntry): Promise<OutboxEntry | null> {
    // Check for an existing pending or submitted entry for this flight+kind.
    const existing = await this.db.txOutbox.findFirst({
      where: {
        flightId: data.flightId,
        kind:     data.kind,
        status:   { in: ["pending", "submitted"] },
      },
    });

    if (existing) {
      this.logger.debug(
        { flightId: data.flightId, kind: data.kind, existingId: existing.id, existingStatus: existing.status },
        "Outbox entry already active — skipping duplicate creation",
      );
      return null;
    }

    const row = await this.db.txOutbox.create({
      data: {
        flightId:            data.flightId,
        kind:                data.kind,
        intendedStatus:      data.intendedStatus !== null && data.intendedStatus !== undefined
          ? toPrismaStatus(data.intendedStatus)
          : null,
        intendedDelayMinutes: data.intendedDelayMinutes ?? null,
      },
    });

    this.logger.debug(
      { flightId: data.flightId, kind: data.kind, outboxId: row.id },
      "Outbox entry created",
    );

    return mapOutbox(row);
  }

  /**
   * Returns all outbox entries with status=pending, ordered by creation time.
   *
   * Called by the OracleUpdater and Keeper on each work cycle to find entries
   * that need to be submitted to the chain. On a clean restart this also
   * picks up any entries that were created but not yet submitted before the
   * process crashed — providing restart-safety without re-enqueuing.
   *
   * Note: submitted entries (tx hash recorded, awaiting confirmation) are
   * NOT returned here — they are tracked separately by the confirmation
   * watcher inside _sendWithRetry. Only truly un-sent entries are returned.
   */
  async listPendingOutboxEntries(): Promise<OutboxEntry[]> {
    const rows = await this.db.txOutbox.findMany({
      where:   { status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapOutbox);
  }

  /**
   * Transition an outbox entry from pending → submitted and record the tx hash.
   *
   * Called by the OracleUpdater / Keeper immediately after walletClient.writeContract()
   * returns a hash but before waitForTransactionReceipt completes. This ensures
   * the hash is persisted even if the process crashes during confirmation waiting —
   * on restart the entry can be looked up by hash and its status reconciled.
   *
   * Also increments the attempts counter so repeated stuck-tx resubmissions
   * are accurately tracked toward TX_MAX_ATTEMPTS.
   */
  async markOutboxSubmitted(id: string, txHash: string): Promise<void> {
    await this.db.txOutbox.update({
      where: { id },
      data: {
        status:      "submitted",
        txHash,
        submittedAt: new Date(),
        attempts:    { increment: 1 },
      },
    });

    this.logger.debug({ outboxId: id, txHash }, "Outbox entry marked submitted");
  }

  /**
   * Transition an outbox entry from submitted → confirmed.
   *
   * Called by OracleUpdater / Keeper after ChainClient._sendWithRetry()
   * resolves with a TxResult — meaning the tx was mined with at least
   * TX_CONFIRMATIONS blocks on top.
   *
   * The confirmedAt timestamp is the authoritative record of when the
   * on-chain state change was finalised. The row is never deleted —
   * it forms the permanent audit trail of every oracle write.
   *
   * @param id   Outbox entry UUID.
   * @param at   Timestamp of confirmation (typically block timestamp or wall clock).
   */
  async markOutboxConfirmed(id: string, at: Date): Promise<void> {
    await this.db.txOutbox.update({
      where: { id },
      data: {
        status:      "confirmed",
        confirmedAt: at,
      },
    });

    this.logger.debug({ outboxId: id, confirmedAt: at }, "Outbox entry confirmed");
  }

  /**
   * Transition an outbox entry to failed and record the last error reason.
   *
   * Called by OracleUpdater / Keeper when _sendWithRetry() throws after
   * exhausting all TX_MAX_ATTEMPTS — either from repeated submission errors,
   * a confirmed revert, or a timeout that could not be resolved by fee bumping.
   *
   * A failed entry:
   *  - Is excluded from listPendingOutboxEntries() (status != pending)
   *  - Does NOT block a new createOutboxEntry() for the same flightId+kind
   *    (the idempotency guard only blocks on pending/submitted)
   *  - Triggers an alert in the caller after this method returns
   *
   * lastError is truncated to 2000 chars to fit the text column comfortably
   * while still providing enough context for debugging.
   */
  async markOutboxFailed(id: string, error: string): Promise<void> {
    await this.db.txOutbox.update({
      where: { id },
      data: {
        status:    "failed",
        lastError: error.slice(0, 2000),
        attempts:  { increment: 1 },
      },
    });

    this.logger.warn({ outboxId: id, error: error.slice(0, 200) }, "Outbox entry marked failed");
  }

  /**
   * Returns the last block number fully processed by the FlightInsured event
   * indexer, or null if no cursor row exists yet (first-ever run).
   *
   * The indexer uses this value as the exclusive lower bound for its next
   * eth_getLogs batch: fromBlock = cursor + 1.
   *
   * On null (first run) the indexer falls back to INDEX_FROM_BLOCK from
   * config — typically the contract deployment block so we don't scan
   * from genesis unnecessarily.
   *
   * The cursor row uses id=1 and is always upserted, never inserted fresh,
   * so this returns null only before the very first setIndexerCursor() call.
   */
  async getIndexerCursor(): Promise<bigint | null> {
    const row = await this.db.indexerCursor.findUnique({
      where: { id: 1 },
    });
    return row ? row.lastProcessedBlock : null;
  }

  /**
   * Advance the event indexer cursor to `blockNumber`.
   *
   * Uses an upsert on id=1 so the first call creates the row and all
   * subsequent calls update it — no separate initialisation step needed.
   *
   * Called by FlightTracker after each successfully processed batch of
   * blocks. On restart, getIndexerCursor() returns this value and the
   * indexer resumes from blockNumber + 1, never re-processing confirmed
   * blocks or missing blocks between runs.
   *
   * Only advance the cursor AFTER the batch has been fully processed and
   * all upsertTrackedFlight() calls have completed — if the process crashes
   * mid-batch, the batch is safely re-processed on restart (events are
   * idempotent via upsertTrackedFlight's conflict handling).
   */
  async setIndexerCursor(blockNumber: bigint): Promise<void> {
    await this.db.indexerCursor.upsert({
      where:  { id: 1 },
      create: { id: 1, lastProcessedBlock: blockNumber },
      update: { lastProcessedBlock: blockNumber },
    });

    this.logger.debug({ blockNumber: blockNumber.toString() }, "Indexer cursor advanced");
  }

  // ── Internal helpers exposed for testing ──────────────────────────────────

  /** @internal — exposes Prisma client for integration tests. */
  _client(): PrismaClient { return this.db; }

  /** @internal — exposed for use in row mapper tests. */
  static _mapFlight   = mapFlight;
  static _mapOutbox   = mapOutbox;
  static _toPrismaStatus   = toPrismaStatus;
  static _fromPrismaStatus = fromPrismaStatus;
}
