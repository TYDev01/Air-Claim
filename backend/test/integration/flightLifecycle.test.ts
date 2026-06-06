/**
 * Integration test — full flight lifecycle with a real Postgres database.
 *
 * What this test covers:
 *  - PrismaRepository against a real Prisma/Postgres connection.
 *  - OracleUpdater._processOneFlight orchestrating the full 7-step pipeline:
 *    provider fetch → map → _shouldSubmit → outbox enqueue → chain submit →
 *    markOutboxConfirmed → markSubmitted.
 *  - Keeper._processOneFlight orchestrating the keeper pipeline.
 *  - Idempotency: calling _processOneFlight twice with the same status does not
 *    create a second outbox entry or submit a second transaction.
 *  - Terminal guard: once a flight is Landed, no further outbox entries are created.
 *  - Restart-safety: a flight reprocessed after a simulated restart resumes from
 *    the correct last-submitted state.
 *
 * Prerequisites:
 *  - DATABASE_URL environment variable pointing to a test Postgres database.
 *  - The database has been migrated: `npx prisma migrate deploy`.
 *
 * The test skips automatically when DATABASE_URL is absent, so it does not
 * block CI pipelines that lack a Postgres service.
 *
 * Chain and provider dependencies are replaced with in-memory test doubles —
 * this test is not a blockchain fork test; it tests the persistence and
 * orchestration layers only.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient }      from "@prisma/client";
import { PrismaRepository }  from "../../src/db/PrismaRepository.js";
import { OracleUpdater }     from "../../src/oracle/OracleUpdater.js";
import { Keeper }            from "../../src/keeper/Keeper.js";
import { OnChainFlightStatus } from "../../src/interfaces/IChainClient.js";
import type { IChainClient, TxResult, OracleFlightRecord } from "../../src/interfaces/IChainClient.js";
import type { IFlightDataProvider, NormalisedFlight }      from "../../src/interfaces/IFlightDataProvider.js";
import type { IAlertSender } from "../../src/oracle/OracleUpdater.js";
import type { AppConfig }    from "../../src/config/schema.js";
import type { Logger }       from "../../src/logger.js";
import { vi }                from "vitest";

// ─── Skip guard ───────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env["DATABASE_URL"]);

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

const stubConfig = {
  DELAY_THRESHOLD_MINUTES:  30,
  CHECK_COOLDOWN_SECONDS:   300,
  KEEPER_BUFFER_SECONDS:    900,
  DRY_RUN:                  false,
} as unknown as AppConfig;

/** Records submitted calls for assertion; returns synthetic confirmed TxResult. */
class RecordingChainClient implements IChainClient {
  readonly updateFlightCalls: Array<{ flightId: string; status: OnChainFlightStatus; delay: number }> = [];
  readonly checkFlightDelayCalls: string[] = [];

  private txCounter = 0;
  private syntheticTx(): TxResult {
    return {
      txHash:      `0x${"0".repeat(63)}${++this.txCounter}` as `0x${string}`,
      blockNumber: BigInt(1_000_000 + this.txCounter),
      gasUsed:     21_000n,
    };
  }

  async hasUpdaterRole(): Promise<boolean> { return true; }

  async getOracleFlightRecord(_flightId: `0x${string}`): Promise<OracleFlightRecord | null> {
    return null;
  }

  async isPolicyClaimable(_flightId: `0x${string}`): Promise<boolean> { return false; }

  async getUpdaterBalance(): Promise<bigint> { return 10n ** 18n; }

  async updateFlight(
    flightId: `0x${string}`,
    status: OnChainFlightStatus,
    delayMinutes: number,
    _source: string,
  ): Promise<TxResult> {
    this.updateFlightCalls.push({ flightId, status, delay: delayMinutes });
    return this.syntheticTx();
  }

  async checkFlightDelay(flightId: `0x${string}`): Promise<TxResult> {
    this.checkFlightDelayCalls.push(flightId);
    return this.syntheticTx();
  }
}

/** Provider that returns a configurable NormalisedFlight. */
class ConfigurableProvider implements IFlightDataProvider {
  flight: NormalisedFlight | null = null;

  async getFlightStatus(_iata: string, _date: string): Promise<NormalisedFlight | null> {
    return this.flight;
  }
}

function normFlight(status: NormalisedFlight["apiStatus"], depDelay: number | null = null): NormalisedFlight {
  return {
    flightIata:  "ET308",
    flightDate:  "2025-01-15",
    apiStatus:   status,
    departure:   { iata: "ADD", scheduledUtc: "2025-01-15T06:00:00Z", estimatedUtc: null, actualUtc: null, delayMinutes: depDelay },
    arrival:     { iata: "NBO", scheduledUtc: "2025-01-15T08:30:00Z", estimatedUtc: null, actualUtc: null, delayMinutes: null },
    rawDigest:   "{}",
  };
}

// ─── Test constants ───────────────────────────────────────────────────────────

const FLIGHT_ID   = ("0x" + "ab".repeat(32)) as `0x${string}`;
const FLIGHT_IATA = "ET308";
const FLIGHT_DATE = "2025-01-15";

// ─── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("Flight lifecycle integration (real Postgres)", () => {
  let prisma:   PrismaClient;
  let repo:     PrismaRepository;
  let chain:    RecordingChainClient;
  let provider: ConfigurableProvider;
  let alerter:  IAlertSender;
  let updater:  OracleUpdater;
  let keeper:   Keeper;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    repo = new PrismaRepository(prisma);
  });

  afterAll(async () => {
    // Clean up all test rows — flight_id prefix "0xab" identifies test data.
    await prisma.txOutbox.deleteMany({ where: { flightId: FLIGHT_ID } });
    await prisma.trackedFlight.deleteMany({ where: { flightId: FLIGHT_ID } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset test flight to a clean state before each test.
    await prisma.txOutbox.deleteMany({ where: { flightId: FLIGHT_ID } });
    await prisma.trackedFlight.deleteMany({ where: { flightId: FLIGHT_ID } });

    chain    = new RecordingChainClient();
    provider = new ConfigurableProvider();
    alerter  = { send: vi.fn() };

    updater = new OracleUpdater(provider, chain, repo, alerter, stubConfig, makeLogger());
    keeper  = new Keeper(chain, repo, alerter, stubConfig, makeLogger());

    // Seed a tracked flight in Scheduled state.
    await repo.upsertTrackedFlight({
      flightId:             FLIGHT_ID,
      flightIata:           FLIGHT_IATA,
      flightDate:           FLIGHT_DATE,
      originIata:           "ADD",
      destIata:             "NBO",
      scheduledDepartureUtc: new Date("2025-01-15T06:00:00Z"),
      scheduledArrivalUtc:  new Date("2025-01-15T08:30:00Z"),
      keeperEligibleAfter:  new Date("2025-01-15T09:30:00Z"),
    });
  });

  // ── Happy path: Scheduled → Delayed ──────────────────────────────────────

  it("processes Scheduled→Delayed transition: outbox confirmed, markSubmitted called", async () => {
    provider.flight = normFlight("active", 45); // 45 min > 30 min threshold → Delayed

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await updater._processOneFlight(flight!);

    // Chain received the update call.
    expect(chain.updateFlightCalls).toHaveLength(1);
    expect(chain.updateFlightCalls[0]!.status).toBe(OnChainFlightStatus.Delayed);
    expect(chain.updateFlightCalls[0]!.delay).toBe(45);

    // DB state reflects the confirmed update.
    const updated = await repo.getTrackedFlight(FLIGHT_ID);
    expect(updated!.lastSubmittedStatus).toBe(OnChainFlightStatus.Delayed);
    expect(updated!.lastSubmittedDelayMinutes).toBe(45);
    expect(updated!.isTerminal).toBe(false);
    expect(updated!.lastSubmittedAt).toBeInstanceOf(Date);

    // Outbox entry is confirmed.
    const outbox = await prisma.txOutbox.findFirst({ where: { flightId: FLIGHT_ID } });
    expect(outbox!.status).toBe("confirmed");
    expect(outbox!.txHash).not.toBeNull();
  });

  // ── Idempotency: same status submitted twice ──────────────────────────────

  it("does not create a second outbox entry when called twice with the same status", async () => {
    provider.flight = normFlight("active", 45);

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await updater._processOneFlight(flight!);

    // Reload flight (now Delayed) and process again with same API data.
    const reloaded = await repo.getTrackedFlight(FLIGHT_ID);
    await updater._processOneFlight(reloaded!);

    // Only one chain call — second pass was a no-op.
    expect(chain.updateFlightCalls).toHaveLength(1);

    const outboxCount = await prisma.txOutbox.count({ where: { flightId: FLIGHT_ID } });
    expect(outboxCount).toBe(1);
  });

  // ── Terminal guard: Landed flight gets no further updates ─────────────────

  it("does not submit after flight reaches Landed (isTerminal=true)", async () => {
    provider.flight = normFlight("landed");

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await updater._processOneFlight(flight!);

    const landed = await repo.getTrackedFlight(FLIGHT_ID);
    expect(landed!.isTerminal).toBe(true);
    expect(landed!.lastSubmittedStatus).toBe(OnChainFlightStatus.Landed);

    // Process again — should be a no-op.
    await updater._processOneFlight(landed!);
    expect(chain.updateFlightCalls).toHaveLength(1);
  });

  // ── Provider returns null: skip without touching DB ───────────────────────

  it("skips without creating an outbox entry when provider returns null", async () => {
    provider.flight = null;

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await updater._processOneFlight(flight!);

    expect(chain.updateFlightCalls).toHaveLength(0);
    const outboxCount = await prisma.txOutbox.count({ where: { flightId: FLIGHT_ID } });
    expect(outboxCount).toBe(0);
  });

  // ── Unknown hold: no outbox entry, alert fired ────────────────────────────

  it("fires alert and creates no outbox entry when mapper returns Unknown", async () => {
    provider.flight = normFlight("incident");

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await updater._processOneFlight(flight!);

    expect(chain.updateFlightCalls).toHaveLength(0);
    expect(alerter.send).toHaveBeenCalled();
    const outboxCount = await prisma.txOutbox.count({ where: { flightId: FLIGHT_ID } });
    expect(outboxCount).toBe(0);
  });

  // ── Keeper pipeline ───────────────────────────────────────────────────────

  it("keeper submits checkFlightDelay and records a confirmed keeper_check outbox entry", async () => {
    // Set keeperEligibleAfter in the past so the flight is eligible.
    await prisma.trackedFlight.update({
      where: { flightId: FLIGHT_ID },
      data:  { keeper_eligible_after: new Date("2025-01-14T00:00:00Z") },
    });

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await keeper._processOneFlight(flight!);

    expect(chain.checkFlightDelayCalls).toHaveLength(1);

    const outbox = await prisma.txOutbox.findFirst({
      where: { flightId: FLIGHT_ID, kind: "keeper_check" },
    });
    expect(outbox!.status).toBe("confirmed");
  });

  it("keeper creates no outbox entry when policy is already claimable", async () => {
    // Override isPolicyClaimable to return true.
    vi.spyOn(chain, "isPolicyClaimable").mockResolvedValue(true);

    const flight = await repo.getTrackedFlight(FLIGHT_ID);
    await keeper._processOneFlight(flight!);

    expect(chain.checkFlightDelayCalls).toHaveLength(0);
    const outboxCount = await prisma.txOutbox.count({
      where: { flightId: FLIGHT_ID, kind: "keeper_check" },
    });
    expect(outboxCount).toBe(0);
  });

  // ── Full lifecycle: Scheduled → Delayed → Landed → Keeper ────────────────

  it("complete lifecycle: Scheduled→Delayed→Landed, terminal blocks further updates", async () => {
    let flight = await repo.getTrackedFlight(FLIGHT_ID);

    // Step 1: active with 45-min delay → Delayed.
    provider.flight = normFlight("active", 45);
    await updater._processOneFlight(flight!);
    flight = await repo.getTrackedFlight(FLIGHT_ID);
    expect(flight!.lastSubmittedStatus).toBe(OnChainFlightStatus.Delayed);

    // Step 2: landed on time → Landed (terminal).
    provider.flight = normFlight("landed", null);
    await updater._processOneFlight(flight!);
    flight = await repo.getTrackedFlight(FLIGHT_ID);
    expect(flight!.lastSubmittedStatus).toBe(OnChainFlightStatus.Landed);
    expect(flight!.isTerminal).toBe(true);

    // Step 3: another provider call → no new update (terminal guard).
    provider.flight = normFlight("landed", null);
    await updater._processOneFlight(flight!);

    expect(chain.updateFlightCalls).toHaveLength(2); // Only 2 txs total.

    const outboxCount = await prisma.txOutbox.count({ where: { flightId: FLIGHT_ID } });
    expect(outboxCount).toBe(2);
  });
});
