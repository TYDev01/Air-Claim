/**
 * Keeper — opens claim windows on InsuredFlightsAgency.
 *
 * For each tracked flight past its keeperEligibleAfter window and outside
 * the cooldown period, calls InsuredFlightsAgency.checkFlightDelay(flightId).
 * This opens the claim window on-chain without requiring passenger interaction.
 *
 * The keeper runs independently of the oracle updater — it does not care
 * about the current API status; it only checks whether the on-chain policy
 * is already claimable and, if not, submits the check transaction.
 *
 * Fail-safe: skips any flight whose policy is already claimable on-chain
 * (verified via a read call before submitting) to avoid wasted gas.
 *
 * DRY_RUN mode: logs the intended call but does not broadcast.
 */

import type { IChainClient }   from "../interfaces/IChainClient.js";
import type { IFlightRepository, TrackedFlight } from "../interfaces/IFlightRepository.js";
import type { IAlertSender }   from "../oracle/OracleUpdater.js";
import type { AppConfig }      from "../config/schema.js";
import type { Logger }         from "../logger.js";

export class Keeper {
  private readonly chain:   IChainClient;
  private readonly repo:    IFlightRepository;
  private readonly alerter: IAlertSender;
  private readonly config:  AppConfig;
  private readonly logger:  Logger;

  /**
   * Construct the Keeper.
   *
   * All dependencies are injected — no singletons, fully testable with doubles.
   *
   * @param chain    IChainClient — provides checkFlightDelay() and isPolicyClaimable().
   * @param repo     IFlightRepository — provides keeper-eligible flight list + state writes.
   * @param alerter  IAlertSender — fires alerts on repeated failures.
   * @param config   Validated AppConfig — reads CHECK_COOLDOWN_SECONDS, DRY_RUN, etc.
   * @param logger   Root logger; child with component="Keeper" created internally.
   */
  constructor(
    chain:   IChainClient,
    repo:    IFlightRepository,
    alerter: IAlertSender,
    config:  AppConfig,
    logger:  Logger,
  ) {
    this.chain   = chain;
    this.repo    = repo;
    this.alerter = alerter;
    this.config  = config;
    this.logger  = logger.child({ component: "Keeper" });
  }

  // ── Pipeline methods (implemented in subsequent commits) ──────────────────

  /**
   * Run the keeper pipeline for a single eligible flight.
   *
   * Steps:
   *  1. Read isPolicyClaimable() on-chain — skip if already open (no gas waste).
   *  2. Record markKeeperCalled() BEFORE submitting (crash-safe cooldown enforcement).
   *  3. Create a keeper_check outbox entry (idempotency guard).
   *  4. Submit chain.checkFlightDelay() and record the tx hash.
   *  5. Mark outbox confirmed.
   *  6. On any error in steps 3-5: mark outbox failed + alert.
   *
   * DRY_RUN mode: chain.checkFlightDelay() logs the intended call and returns
   * a synthetic TxResult — no broadcast occurs.
   */
  async _processOneFlight(flight: TrackedFlight): Promise<void> {
    const log = this.logger.child({ flightId: flight.flightId, flightIata: flight.flightIata });

    // ── Step 1: on-chain claimable check ──────────────────────────────────
    let alreadyClaimable: boolean;
    try {
      alreadyClaimable = await this.chain.isPolicyClaimable(flight.flightId as `0x${string}`);
    } catch (err) {
      log.warn({ err }, "isPolicyClaimable read failed — skipping flight this tick");
      return;
    }

    if (alreadyClaimable) {
      log.debug("Policy already claimable — skipping keeper call, marking terminal");
      await this.repo.markTerminal(flight.flightId);
      return;
    }

    // ── Step 2: record cooldown timestamp BEFORE submission ───────────────
    const now = new Date();
    await this.repo.markKeeperCalled(flight.flightId, now);

    // ── Step 3: enqueue outbox ────────────────────────────────────────────
    const entry = await this.repo.createOutboxEntry({
      flightId:             flight.flightId,
      kind:                 "keeper_check",
      intendedStatus:       null,
      intendedDelayMinutes: null,
    });

    if (!entry) {
      log.debug("Keeper outbox entry already active — skipping (idempotency)");
      return;
    }

    // ── Steps 4-5: submit + confirm ───────────────────────────────────────
    try {
      const result = await this.chain.checkFlightDelay(flight.flightId as `0x${string}`);

      await this.repo.markOutboxSubmitted(entry.id, result.txHash);
      await this.repo.markOutboxConfirmed(entry.id, new Date());

      log.info(
        { txHash: result.txHash, gasUsed: result.gasUsed.toString() },
        "checkFlightDelay confirmed on-chain",
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.repo.markOutboxFailed(entry.id, errMsg);
      await this.alerter.send(
        `[AirClaim] Keeper CHECK FAILED for ${flight.flightIata}: ${errMsg.slice(0, 200)}`,
      );
      log.error({ err }, "Keeper checkFlightDelay failed — outbox marked failed, alert sent");
    }
  }

  async run(): Promise<number> {
    throw new Error("Not yet implemented — see Keeper.run commit");
  }
}
