/**
 * Scheduler — coordinates the three periodic pipelines:
 *
 *  Indexer tick   (fixed 60 s)  — FlightTracker.sync() indexes new FlightInsured events.
 *  Oracle tick    (adaptive)    — OracleUpdater.run() fetches API status and submits updates.
 *  Keeper tick    (fixed 5 min) — Keeper.run() calls checkFlightDelay() on eligible flights.
 *
 * Adaptive oracle cadence:
 *  - Any flight currently in-flight (scheduledDeparture ≤ now ≤ scheduledDeparture + 12h):
 *    poll every POLL_INFLIGHT_MS (3 minutes).
 *  - All flights are >4 hours from departure (or no active flights):
 *    poll every POLL_PREFLIGHT_MS (30 minutes).
 *  - Otherwise (within 4 hours of departure): poll every POLL_PREFLIGHT_MS / 4 (7.5 min)
 *    as a middle ground — close enough to catch last-minute delays.
 *
 * Each pipeline runs independently via self-rescheduling setTimeout chains.
 * A tick that throws is caught, logged, and rescheduled — a single failure
 * never stops the loop.
 *
 * Graceful shutdown: stop() sets a flag and clears all pending timers.
 * In-progress ticks are awaited before the promise resolves.
 */

import type { OracleUpdater } from "../oracle/OracleUpdater.js";
import type { Keeper }        from "../keeper/Keeper.js";
import type { FlightTracker } from "../db/FlightTracker.js";
import type { IFlightRepository, TrackedFlight } from "../interfaces/IFlightRepository.js";
import type { AppConfig }     from "../config/schema.js";
import type { Logger }        from "../logger.js";

// ─── Cadence constants ────────────────────────────────────────────────────────

const POLL_INFLIGHT_MS   = 3  * 60 * 1_000;  //  3 minutes — in-flight flights
const POLL_NEAR_MS       = 7.5 * 60 * 1_000; //  7.5 min   — within 4h of departure
const POLL_PREFLIGHT_MS  = 30 * 60 * 1_000;  // 30 minutes — >4h pre-departure / idle
const INDEXER_INTERVAL_MS = 60 * 1_000;      //  1 minute   — fixed
const KEEPER_INTERVAL_MS  = 5  * 60 * 1_000; //  5 minutes  — fixed

// How long after departure we consider a flight "in-flight" for polling purposes.
const INFLIGHT_WINDOW_MS = 12 * 60 * 60 * 1_000; // 12 hours
// Threshold for "near departure" (faster polling).
const NEAR_DEPARTURE_MS  =  4 * 60 * 60 * 1_000; //  4 hours

// ─── Scheduler ───────────────────────────────────────────────────────────────

export class Scheduler {
  private readonly updater:  OracleUpdater;
  private readonly keeper:   Keeper;
  private readonly tracker:  FlightTracker;
  private readonly repo:     IFlightRepository;
  private readonly config:   AppConfig;
  private readonly logger:   Logger;

  /** Set to false by stop() — causes self-rescheduling loops to exit. */
  private running = false;

  /** Pending timer handles — cleared by stop(). */
  private oracleTimer:  ReturnType<typeof setTimeout> | null = null;
  private keeperTimer:  ReturnType<typeof setTimeout> | null = null;
  private indexerTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Promises for in-progress ticks — awaited by stop() for graceful shutdown.
   * Replaced with a resolved promise when no tick is running.
   */
  private oracleInFlight:  Promise<void> = Promise.resolve();
  private keeperInFlight:  Promise<void> = Promise.resolve();
  private indexerInFlight: Promise<void> = Promise.resolve();

  /**
   * Construct the Scheduler.
   *
   * @param updater  OracleUpdater — called on each oracle tick.
   * @param keeper   Keeper        — called on each keeper tick.
   * @param tracker  FlightTracker — called on each indexer tick.
   * @param repo     IFlightRepository — queried by _computeOracleInterval.
   * @param config   Validated AppConfig — reads DRY_RUN, etc.
   * @param logger   Root logger; child with component="Scheduler" created internally.
   */
  constructor(
    updater:  OracleUpdater,
    keeper:   Keeper,
    tracker:  FlightTracker,
    repo:     IFlightRepository,
    config:   AppConfig,
    logger:   Logger,
  ) {
    this.updater  = updater;
    this.keeper   = keeper;
    this.tracker  = tracker;
    this.repo     = repo;
    this.config   = config;
    this.logger   = logger.child({ component: "Scheduler" });
  }

  // ── Adaptive cadence ──────────────────────────────────────────────────────

  /**
   * Compute the delay (ms) before the next oracle tick based on active flight states.
   *
   * Logic:
   *  1. If any non-terminal flight's departure has passed and is within the
   *     12-hour in-flight window → POLL_INFLIGHT_MS (3 min).
   *  2. Else if any flight departs within the next 4 hours → POLL_NEAR_MS (7.5 min).
   *  3. Otherwise → POLL_PREFLIGHT_MS (30 min).
   *
   * Falls back to POLL_PREFLIGHT_MS when the repo call fails or returns empty.
   */
  async _computeOracleInterval(): Promise<number> {
    let flights: TrackedFlight[];
    try {
      flights = await this.repo.listActiveFlights();
    } catch (err) {
      this.logger.warn({ err }, "Failed to read active flights for interval calc — using preflight cadence");
      return POLL_PREFLIGHT_MS;
    }

    if (flights.length === 0) return POLL_PREFLIGHT_MS;

    const now = Date.now();

    for (const flight of flights) {
      const dep = flight.scheduledDepartureUtc.getTime();
      if (dep <= now && now <= dep + INFLIGHT_WINDOW_MS) {
        return POLL_INFLIGHT_MS; // At least one flight is airborne — fastest cadence.
      }
    }

    for (const flight of flights) {
      const dep = flight.scheduledDepartureUtc.getTime();
      if (dep > now && dep - now <= NEAR_DEPARTURE_MS) {
        return POLL_NEAR_MS; // At least one flight departs within 4 h.
      }
    }

    return POLL_PREFLIGHT_MS;
  }

  // ── Tick handlers (implemented in subsequent commits) ─────────────────────

  /**
   * Run one oracle tick and self-reschedule the next one.
   *
   * 1. Calls OracleUpdater.run() — processes all active flights.
   * 2. Computes the next delay via _computeOracleInterval() based on current
   *    flight states after the run (interval shrinks as departure approaches).
   * 3. Schedules itself again unless stop() has set running=false.
   *
   * Errors from OracleUpdater.run() are caught and logged — the loop always
   * reschedules regardless of outcome so a provider outage doesn't freeze it.
   */
  async _oracleTick(): Promise<void> {
    const start = Date.now();
    try {
      const processed = await this.updater.run();
      this.logger.info(
        { processed, durationMs: Date.now() - start },
        "Oracle tick complete",
      );
    } catch (err) {
      this.logger.error({ err, durationMs: Date.now() - start }, "Oracle tick threw — will reschedule");
    }

    if (!this.running) return;

    const nextMs = await this._computeOracleInterval();
    this.logger.debug({ nextMs }, "Oracle next tick scheduled");
    this.oracleTimer = setTimeout(() => {
      this.oracleInFlight = this._oracleTick();
    }, nextMs);
  }

  /**
   * Run one keeper tick and self-reschedule the next one at a fixed 5-minute interval.
   *
   * 1. Calls Keeper.run() — dispatches checkFlightDelay() for all eligible flights.
   * 2. Logs dispatched count + wall-clock duration.
   * 3. Errors from Keeper.run() are caught and logged — the loop always reschedules.
   * 4. Schedules itself again unless stop() has set running=false.
   *
   * Interval is fixed (KEEPER_INTERVAL_MS = 5 min) — keeper eligibility is
   * gated by keeperEligibleAfter and CHECK_COOLDOWN_SECONDS in the repo query,
   * so running the keeper more frequently than necessary is safe (no-ops quickly).
   */
  async _keeperTick(): Promise<void> {
    const start = Date.now();
    try {
      const dispatched = await this.keeper.run();
      this.logger.info(
        { dispatched, durationMs: Date.now() - start },
        "Keeper tick complete",
      );
    } catch (err) {
      this.logger.error({ err, durationMs: Date.now() - start }, "Keeper tick threw — will reschedule");
    }

    if (!this.running) return;

    this.keeperTimer = setTimeout(() => {
      this.keeperInFlight = this._keeperTick();
    }, KEEPER_INTERVAL_MS);
  }

  async _indexerTick(): Promise<void> {
    throw new Error("Not yet implemented — see Scheduler._indexerTick commit");
  }

  async start(): Promise<void> {
    throw new Error("Not yet implemented — see Scheduler.start commit");
  }

  async stop(): Promise<void> {
    throw new Error("Not yet implemented — see Scheduler.stop commit");
  }
}
