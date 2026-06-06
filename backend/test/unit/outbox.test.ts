/**
 * Unit tests for the transaction outbox state machine.
 *
 * These tests exercise the outbox lifecycle rules defined in IFlightRepository
 * using an in-memory double that faithfully implements every rule from
 * PrismaRepository's createOutboxEntry, markOutbox*, and related methods.
 *
 * Rules under test:
 *  1. createOutboxEntry returns a new pending entry when none exists.
 *  2. createOutboxEntry returns null (idempotent no-op) when a pending entry
 *     already exists for the same flightId + kind.
 *  3. createOutboxEntry returns null when a submitted entry already exists.
 *  4. createOutboxEntry creates a new entry when the only existing entry is failed
 *     (failed does not block a retry).
 *  5. markOutboxSubmitted transitions pending → submitted and records txHash.
 *  6. markOutboxConfirmed transitions submitted → confirmed and records confirmedAt.
 *  7. markOutboxFailed records lastError and increments attempts.
 *  8. A full pending → submitted → confirmed lifecycle produces expected state.
 *  9. A full pending → submitted → failed → new-pending lifecycle works.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  IFlightRepository,
  OutboxEntry,
  OutboxKind,
  OutboxStatus,
  CreateOutboxEntry,
  TrackedFlight,
  CreateTrackedFlight,
} from "../../src/interfaces/IFlightRepository.js";
import { OnChainFlightStatus } from "../../src/interfaces/IChainClient.js";

// ─── In-memory outbox double ──────────────────────────────────────────────────

/**
 * Minimal in-memory IFlightRepository that implements only the outbox methods
 * and the cursor methods needed for this test suite. All other methods throw.
 * Lives in the test directory per the production-grade rule.
 */
class InMemoryOutboxRepo implements IFlightRepository {
  private entries: Map<string, OutboxEntry> = new Map();
  private counter = 0;

  private nextId(): string { return `entry-${++this.counter}`; }

  async createOutboxEntry(data: CreateOutboxEntry): Promise<OutboxEntry | null> {
    // Idempotency: return null if a pending or submitted entry already exists.
    for (const e of this.entries.values()) {
      if (
        e.flightId === data.flightId &&
        e.kind     === data.kind     &&
        (e.status  === "pending" || e.status === "submitted")
      ) {
        return null;
      }
    }

    const entry: OutboxEntry = {
      id:                   this.nextId(),
      flightId:             data.flightId,
      kind:                 data.kind,
      intendedStatus:       data.intendedStatus,
      intendedDelayMinutes: data.intendedDelayMinutes,
      status:               "pending",
      txHash:               null,
      attempts:             0,
      lastError:            null,
      submittedAt:          null,
      confirmedAt:          null,
      createdAt:            new Date(),
    };

    this.entries.set(entry.id, entry);
    return { ...entry };
  }

  async listPendingOutboxEntries(): Promise<OutboxEntry[]> {
    return [...this.entries.values()].filter(e => e.status === "pending").map(e => ({ ...e }));
  }

  async markOutboxSubmitted(id: string, txHash: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Entry ${id} not found`);
    e.status      = "submitted";
    e.txHash      = txHash;
    e.submittedAt = new Date();
    e.attempts   += 1;
  }

  async markOutboxConfirmed(id: string, at: Date): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Entry ${id} not found`);
    e.status      = "confirmed";
    e.confirmedAt = at;
  }

  async markOutboxFailed(id: string, error: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Entry ${id} not found`);
    e.status    = "failed";
    e.lastError = error.slice(0, 2000);
    e.attempts += 1;
  }

  // ── Unimplemented stubs (throw if called unexpectedly) ─────────────────────
  async upsertTrackedFlight(_d: CreateTrackedFlight): Promise<TrackedFlight> { throw new Error("not used"); }
  async getTrackedFlight(_id: string): Promise<TrackedFlight | null>         { throw new Error("not used"); }
  async listActiveFlights(): Promise<TrackedFlight[]>                         { throw new Error("not used"); }
  async listKeeperEligibleFlights(_s: number): Promise<TrackedFlight[]>       { throw new Error("not used"); }
  async markSubmitted(_id: string, _s: OnChainFlightStatus, _d: number, _at: Date): Promise<void> { throw new Error("not used"); }
  async markKeeperCalled(_id: string, _at: Date): Promise<void>               { throw new Error("not used"); }
  async markTerminal(_id: string): Promise<void>                              { throw new Error("not used"); }
  async getIndexerCursor(): Promise<bigint | null>                            { throw new Error("not used"); }
  async setIndexerCursor(_b: bigint): Promise<void>                          { throw new Error("not used"); }

  // Test helpers
  getEntry(id: string): OutboxEntry | undefined { return this.entries.get(id); }
  allEntries(): OutboxEntry[] { return [...this.entries.values()]; }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FLIGHT_ID  = "0x" + "a".repeat(64);
const ORACLE_KIND: OutboxKind = "oracle_update";
const KEEPER_KIND: OutboxKind = "keeper_check";

function oraclePayload(): CreateOutboxEntry {
  return {
    flightId:             FLIGHT_ID,
    kind:                 ORACLE_KIND,
    intendedStatus:       OnChainFlightStatus.Delayed,
    intendedDelayMinutes: 45,
  };
}

function keeperPayload(): CreateOutboxEntry {
  return {
    flightId:             FLIGHT_ID,
    kind:                 KEEPER_KIND,
    intendedStatus:       null,
    intendedDelayMinutes: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Outbox state machine", () => {
  let repo: InMemoryOutboxRepo;

  beforeEach(() => {
    repo = new InMemoryOutboxRepo();
  });

  // ── Rule 1: fresh entry creation ──────────────────────────────────────────

  it("createOutboxEntry returns a pending entry when none exists", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe<OutboxStatus>("pending");
    expect(entry!.txHash).toBeNull();
    expect(entry!.confirmedAt).toBeNull();
    expect(entry!.lastError).toBeNull();
    expect(entry!.attempts).toBe(0);
  });

  it("createOutboxEntry sets flightId, kind, intendedStatus correctly", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    expect(entry!.flightId).toBe(FLIGHT_ID);
    expect(entry!.kind).toBe(ORACLE_KIND);
    expect(entry!.intendedStatus).toBe(OnChainFlightStatus.Delayed);
    expect(entry!.intendedDelayMinutes).toBe(45);
  });

  it("keeper_check entry has null intendedStatus and intendedDelayMinutes", async () => {
    const entry = await repo.createOutboxEntry(keeperPayload());
    expect(entry!.intendedStatus).toBeNull();
    expect(entry!.intendedDelayMinutes).toBeNull();
  });

  // ── Rule 2: idempotency on pending ────────────────────────────────────────

  it("createOutboxEntry returns null when a pending entry already exists", async () => {
    await repo.createOutboxEntry(oraclePayload());
    const second = await repo.createOutboxEntry(oraclePayload());
    expect(second).toBeNull();
    expect(repo.allEntries()).toHaveLength(1);
  });

  // ── Rule 3: idempotency on submitted ──────────────────────────────────────

  it("createOutboxEntry returns null when a submitted entry already exists", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxSubmitted(entry!.id, "0xdeadbeef");

    const second = await repo.createOutboxEntry(oraclePayload());
    expect(second).toBeNull();
  });

  // ── Rule 4: failed does not block a new entry ─────────────────────────────

  it("createOutboxEntry creates a new entry when only a failed entry exists", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxFailed(entry!.id, "rpc timeout");

    const retry = await repo.createOutboxEntry(oraclePayload());
    expect(retry).not.toBeNull();
    expect(retry!.status).toBe<OutboxStatus>("pending");
    expect(repo.allEntries()).toHaveLength(2);
  });

  // ── Rule 5: markOutboxSubmitted ───────────────────────────────────────────

  it("markOutboxSubmitted transitions status to submitted and records txHash", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxSubmitted(entry!.id, "0xabc123");

    const updated = repo.getEntry(entry!.id)!;
    expect(updated.status).toBe<OutboxStatus>("submitted");
    expect(updated.txHash).toBe("0xabc123");
    expect(updated.submittedAt).toBeInstanceOf(Date);
    expect(updated.attempts).toBe(1);
  });

  // ── Rule 6: markOutboxConfirmed ───────────────────────────────────────────

  it("markOutboxConfirmed transitions status to confirmed and records confirmedAt", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxSubmitted(entry!.id, "0xabc123");
    const confirmedAt = new Date();
    await repo.markOutboxConfirmed(entry!.id, confirmedAt);

    const updated = repo.getEntry(entry!.id)!;
    expect(updated.status).toBe<OutboxStatus>("confirmed");
    expect(updated.confirmedAt).toBe(confirmedAt);
  });

  // ── Rule 7: markOutboxFailed ──────────────────────────────────────────────

  it("markOutboxFailed records lastError and increments attempts", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxFailed(entry!.id, "connection refused");

    const updated = repo.getEntry(entry!.id)!;
    expect(updated.status).toBe<OutboxStatus>("failed");
    expect(updated.lastError).toBe("connection refused");
    expect(updated.attempts).toBe(1);
  });

  it("markOutboxFailed truncates lastError to 2000 characters", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxFailed(entry!.id, "x".repeat(3000));
    expect(repo.getEntry(entry!.id)!.lastError).toHaveLength(2000);
  });

  // ── Rule 8: full happy-path lifecycle ─────────────────────────────────────

  it("pending → submitted → confirmed lifecycle produces correct final state", async () => {
    const entry = await repo.createOutboxEntry(oraclePayload());
    expect(entry!.status).toBe<OutboxStatus>("pending");

    await repo.markOutboxSubmitted(entry!.id, "0xabc");
    expect(repo.getEntry(entry!.id)!.status).toBe<OutboxStatus>("submitted");

    const confirmedAt = new Date();
    await repo.markOutboxConfirmed(entry!.id, confirmedAt);

    const final = repo.getEntry(entry!.id)!;
    expect(final.status).toBe<OutboxStatus>("confirmed");
    expect(final.txHash).toBe("0xabc");
    expect(final.confirmedAt).toBe(confirmedAt);
    expect(final.lastError).toBeNull();
  });

  // ── Rule 9: failure and retry lifecycle ───────────────────────────────────

  it("pending → failed → new-pending → confirmed retry lifecycle works", async () => {
    const first = await repo.createOutboxEntry(oraclePayload());
    await repo.markOutboxFailed(first!.id, "nonce too low");

    // A new entry can be created after failure.
    const retry = await repo.createOutboxEntry(oraclePayload());
    expect(retry).not.toBeNull();
    expect(retry!.status).toBe<OutboxStatus>("pending");

    await repo.markOutboxSubmitted(retry!.id, "0xretry");
    await repo.markOutboxConfirmed(retry!.id, new Date());

    expect(repo.getEntry(retry!.id)!.status).toBe<OutboxStatus>("confirmed");
    // Original failed entry is untouched.
    expect(repo.getEntry(first!.id)!.status).toBe<OutboxStatus>("failed");
  });

  // ── Orthogonal kinds do not block each other ──────────────────────────────

  it("pending oracle_update does not block a keeper_check for the same flight", async () => {
    await repo.createOutboxEntry(oraclePayload());
    const keeperEntry = await repo.createOutboxEntry(keeperPayload());
    expect(keeperEntry).not.toBeNull();
    expect(repo.allEntries()).toHaveLength(2);
  });
});
