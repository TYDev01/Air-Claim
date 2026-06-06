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

  async _shouldSubmit(_flight: TrackedFlight, _newStatus: OnChainFlightStatus, _newDelay: number): Promise<boolean> {
    throw new Error("Not yet implemented — see _shouldSubmit commit");
  }

  async _processOneFlight(_flight: TrackedFlight): Promise<void> {
    throw new Error("Not yet implemented — see _processOneFlight commit");
  }

  async run(): Promise<void> {
    throw new Error("Not yet implemented — see OracleUpdater.run commit");
  }
}
