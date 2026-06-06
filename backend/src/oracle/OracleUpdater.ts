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

  // ── Pipeline methods (implemented in subsequent commits) ──────────────────

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

  async _processOneFlight(_flight: TrackedFlight): Promise<void> {
    throw new Error("Not yet implemented — see _processOneFlight commit");
  }

  async run(): Promise<void> {
    throw new Error("Not yet implemented — see OracleUpdater.run commit");
  }
}
