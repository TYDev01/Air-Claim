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
   * Create a PrismaRepository.
   *
   * @param logger  Root logger; a child with component="PrismaRepository" is created.
   *
   * The Prisma client is instantiated here but the underlying connection pool is
   * established lazily on the first query. Call connect() to eagerly verify DB
   * reachability at boot (recommended for /healthz and boot checks).
   */
  constructor(logger: Logger) {
    this.db     = new PrismaClient();
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

  async getTrackedFlight(_flightId: string): Promise<TrackedFlight | null> {
    throw new Error("Not yet implemented — see getTrackedFlight commit");
  }

  async listActiveFlights(): Promise<TrackedFlight[]> {
    throw new Error("Not yet implemented — see listActiveFlights commit");
  }

  async listKeeperEligibleFlights(_cooldownSeconds: number): Promise<TrackedFlight[]> {
    throw new Error("Not yet implemented — see listKeeperEligibleFlights commit");
  }

  async markSubmitted(_flightId: string, _status: SubmittedStatus, _delayMinutes: number, _at: Date): Promise<void> {
    throw new Error("Not yet implemented — see markSubmitted commit");
  }

  async markKeeperCalled(_flightId: string, _at: Date): Promise<void> {
    throw new Error("Not yet implemented — see markKeeperCalled commit");
  }

  async markTerminal(_flightId: string): Promise<void> {
    throw new Error("Not yet implemented — see markTerminal commit");
  }

  async createOutboxEntry(_data: CreateOutboxEntry): Promise<OutboxEntry | null> {
    throw new Error("Not yet implemented — see createOutboxEntry commit");
  }

  async listPendingOutboxEntries(): Promise<OutboxEntry[]> {
    throw new Error("Not yet implemented — see listPendingOutboxEntries commit");
  }

  async markOutboxSubmitted(_id: string, _txHash: string): Promise<void> {
    throw new Error("Not yet implemented — see markOutboxSubmitted commit");
  }

  async markOutboxConfirmed(_id: string, _at: Date): Promise<void> {
    throw new Error("Not yet implemented — see markOutboxConfirmed commit");
  }

  async markOutboxFailed(_id: string, _error: string): Promise<void> {
    throw new Error("Not yet implemented — see markOutboxFailed commit");
  }

  async getIndexerCursor(): Promise<bigint | null> {
    throw new Error("Not yet implemented — see getIndexerCursor commit");
  }

  async setIndexerCursor(_blockNumber: bigint): Promise<void> {
    throw new Error("Not yet implemented — see setIndexerCursor commit");
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
