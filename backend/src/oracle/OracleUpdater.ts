/**
 * OracleUpdater — the oracle write pipeline.
 *
 * For each active tracked flight on every scheduler tick:
 *  1. Fetch current status from AviationStack via IFlightDataProvider.
 *  2. Map API status → on-chain enum via mapApiStatus().
 *  3. Compare to last-submitted state — skip if unchanged (idempotency).
 *  4. Enqueue a tx_outbox entry (idempotency guard in repo).
 *  5. Submit via ChainClient.updateFlight() with nonce/fee/retry management.
 *  6. Mark the outbox entry confirmed and update the tracked flight row.
 *  7. On any failure: mark outbox failed and fire an alert.
 *
 * Fail-safe: if mapApiStatus() returns Unknown, the flight is held —
 * nothing is written on-chain; an alert is fired instead.
 *
 * DRY_RUN mode: logs the full intended call but broadcasts nothing.
 */

import type { IFlightDataProvider } from "../interfaces/IFlightDataProvider.js";
import type { IChainClient }        from "../interfaces/IChainClient.js";
import { OnChainFlightStatus }      from "../interfaces/IChainClient.js";
import type { IFlightRepository, TrackedFlight } from "../interfaces/IFlightRepository.js";
import { mapApiStatus, UNKNOWN }    from "../providers/mapper.js";
import type { AppConfig }           from "../config/schema.js";
import type { Logger }              from "../logger.js";
import { oracleUpdatesTotal }       from "../metrics/metrics.js";

// ─── Alerter interface ────────────────────────────────────────────────────────
// Thin interface so OracleUpdater doesn't depend on a concrete alerter.
// Implemented by the Alerter module in Phase 5.

export interface IAlertSender {
  send(message: string): Promise<void>;
}

// ─── OracleUpdater ────────────────────────────────────────────────────────────

export class OracleUpdater {
  private readonly provider: IFlightDataProvider;
  private readonly chain:    IChainClient;
  private readonly repo:     IFlightRepository;
  private readonly alerter:  IAlertSender;
  private readonly config:   AppConfig;
  private readonly logger:   Logger;

  /**
   * Construct the OracleUpdater.
   *
   * All dependencies are injected — no singletons, no hidden imports.
   * This makes the updater fully testable with doubles for every dependency.
   *
   * @param provider  IFlightDataProvider implementation (AviationStackProvider in prod).
   * @param chain     IChainClient implementation (ChainClient in prod).
   * @param repo      IFlightRepository implementation (PrismaRepository in prod).
   * @param alerter   IAlertSender implementation (WebhookAlerter / NoopAlerter in prod).
   * @param config    Validated AppConfig — reads DRY_RUN, DELAY_THRESHOLD_MINUTES, etc.
   * @param logger    Root logger; child with component="OracleUpdater" created internally.
   */
  constructor(
    provider: IFlightDataProvider,
    chain:    IChainClient,
    repo:     IFlightRepository,
    alerter:  IAlertSender,
    config:   AppConfig,
    logger:   Logger,
  ) {
    this.provider = provider;
    this.chain    = chain;
    this.repo     = repo;
    this.alerter  = alerter;
    this.config   = config;
    this.logger   = logger.child({ component: "OracleUpdater" });
  }

  // ── Pipeline methods ──────────────────────────────────────────────────────

  /**
   * Determine whether a new oracle update should be submitted.
   *
   * Returns false (skip) when:
   *  - The new status is identical to the last submitted status AND
   *    the delay minutes have not changed — exact duplicate, no-op.
   *  - The flight is already terminal (Landed or Cancelled confirmed) —
   *    the oracle does not need further updates regardless of API data.
   *  - The new status would be a regression (e.g. Delayed → Scheduled) —
   *    the contract accepts any update but a regression is likely a data
   *    glitch; we hold and log a warning rather than writing it.
   *
   * Returns true (submit) when:
   *  - Status has genuinely changed (e.g. Scheduled → Delayed).
   *  - Status is the same but delayMinutes has increased — the contract
   *    stores the latest value; updated delay is worth writing.
   *
   * Note: this check is advisory. The DB-level idempotency guard in
   * createOutboxEntry() provides the hard guarantee against double-submission.
   */
  _shouldSubmit(
    flight:    TrackedFlight,
    newStatus: OnChainFlightStatus,
    newDelay:  number,
  ): boolean {
    const { lastSubmittedStatus, lastSubmittedDelayMinutes, isTerminal } = flight;

    if (isTerminal) {
      this.logger.debug({ flightId: flight.flightId }, "Skipping — flight is terminal");
      return false;
    }

    // Detect regressions: on-chain state should only move forward.
    // Scheduled(0) → Delayed(1) → Cancelled(2) or Landed(3) is forward.
    // Any decrease is suspicious.
    if (newStatus < lastSubmittedStatus) {
      this.logger.warn(
        {
          flightId:  flight.flightId,
          current:   lastSubmittedStatus,
          incoming:  newStatus,
        },
        "Status regression detected — holding, not submitting",
      );
      return false;
    }

    // Exact duplicate — same status, same delay.
    if (newStatus === lastSubmittedStatus && newDelay === lastSubmittedDelayMinutes) {
      this.logger.debug({ flightId: flight.flightId }, "No state change — skipping submission");
      return false;
    }

    return true;
  }

  /**
   * Run the full oracle update pipeline for a single tracked flight.
   *
   * Steps:
   *  1. Fetch current status from the flight data provider.
   *  2. Map API status → on-chain enum + delayMinutes via mapApiStatus().
   *  3. If mapper returns Unknown: alert and return (fail safe — do not write).
   *  4. Run _shouldSubmit() idempotency + regression check.
   *  5. Create a pending outbox entry (idempotency guard in repo).
   *  6. Submit via chain.updateFlight() and record the tx hash.
   *  7. Mark outbox confirmed + update tracked flight row.
   *  8. On any error in steps 5-7: mark outbox failed + alert.
   */
  async _processOneFlight(flight: TrackedFlight): Promise<void> {
    const log = this.logger.child({ flightId: flight.flightId, flightIata: flight.flightIata });

    // ── Step 1: fetch ──────────────────────────────────────────────────────
    let normalised;
    try {
      normalised = await this.provider.getFlightStatus(flight.flightIata, flight.flightDate);
    } catch (err) {
      log.warn({ err }, "Provider fetch failed — skipping flight this tick");
      return; // Circuit may be open; scheduler will retry next tick.
    }

    if (!normalised) {
      log.info("Provider returned null (flight not found) — skipping");
      return;
    }

    // ── Step 2: map ────────────────────────────────────────────────────────
    const mapped = mapApiStatus(normalised, this.config.DELAY_THRESHOLD_MINUTES);

    // ── Step 3: Unknown → hold + alert ────────────────────────────────────
    if (mapped.unknown) {
      log.warn({ reason: mapped.reason, rawDigest: normalised.rawDigest }, "Mapper returned Unknown — holding");
      await this.alerter.send(
        `[AirClaim] Oracle HOLD for ${flight.flightIata} (${flight.flightId.slice(0, 10)}…): ${mapped.reason}`,
      );
      return;
    }

    // ── Step 4: idempotency check ─────────────────────────────────────────
    if (!this._shouldSubmit(flight, mapped.status, mapped.delayMinutes)) {
      return; // No state change or regression — nothing to do.
    }

    log.info(
      { newStatus: mapped.status, delayMinutes: mapped.delayMinutes },
      "Status transition detected — submitting oracle update",
    );

    // ── Step 5: enqueue outbox ────────────────────────────────────────────
    const entry = await this.repo.createOutboxEntry({
      flightId:            flight.flightId,
      kind:                "oracle_update",
      intendedStatus:      mapped.status,
      intendedDelayMinutes: mapped.delayMinutes,
    });

    if (!entry) {
      log.debug("Outbox entry already active — skipping (idempotency)");
      return;
    }

    // ── Steps 6-7: submit + confirm ───────────────────────────────────────
    try {
      await this.repo.markOutboxSubmitted(entry.id, "pending_hash");

      const result = await this.chain.updateFlight(
        flight.flightId as `0x${string}`,
        mapped.status,
        mapped.delayMinutes,
        `aviationstack:${normalised.apiStatus}`,
      );

      await this.repo.markOutboxSubmitted(entry.id, result.txHash);
      await this.repo.markOutboxConfirmed(entry.id, new Date());
      await this.repo.markSubmitted(
        flight.flightId,
        mapped.status,
        mapped.delayMinutes,
        new Date(),
      );

      oracleUpdatesTotal.inc({ outcome: "confirmed" });
      log.info(
        { txHash: result.txHash, gasUsed: result.gasUsed.toString() },
        "Oracle update confirmed on-chain",
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.repo.markOutboxFailed(entry.id, errMsg);
      await this.alerter.send(
        `[AirClaim] Oracle UPDATE FAILED for ${flight.flightIata}: ${errMsg.slice(0, 200)}`,
      );
      oracleUpdatesTotal.inc({ outcome: "failed" });
      log.error({ err }, "Oracle update failed — outbox marked failed, alert sent");
    }
  }

  /**
   * Process all active tracked flights for this scheduler tick.
   *
   * Fetches the non-terminal flight list from the repository, then runs
   * _processOneFlight() for each with a bounded concurrency of 5 — enough
   * to keep AviationStack requests in flight without overwhelming the RPC
   * or exhausting the rate limit budget in a single burst.
   *
   * Individual flight errors are isolated inside _processOneFlight() and
   * never propagate here — a failure on one flight must not skip others.
   *
   * @returns Number of flights processed (attempted, not necessarily updated).
   */
  async run(): Promise<number> {
    const flights = await this.repo.listActiveFlights();

    if (flights.length === 0) {
      this.logger.debug("No active flights to process");
      return 0;
    }

    this.logger.info({ count: flights.length }, "OracleUpdater run starting");

    // Process in batches of CONCURRENCY to bound simultaneous HTTP + RPC calls.
    const CONCURRENCY = 5;
    for (let i = 0; i < flights.length; i += CONCURRENCY) {
      const batch = flights.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(flight =>
          this._processOneFlight(flight).catch(err => {
            // Belt-and-suspenders: _processOneFlight catches its own errors,
            // but guard here too so a programming mistake doesn't abort the loop.
            this.logger.error(
              { err, flightId: flight.flightId },
              "Unexpected error from _processOneFlight — isolated",
            );
          }),
        ),
      );
    }

    this.logger.info({ count: flights.length }, "OracleUpdater run complete");
    return flights.length;
  }
}
