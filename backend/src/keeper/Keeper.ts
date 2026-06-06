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

  async _processOneFlight(_flight: TrackedFlight): Promise<void> {
    throw new Error("Not yet implemented — see Keeper._processOneFlight commit");
  }

  async run(): Promise<number> {
    throw new Error("Not yet implemented — see Keeper.run commit");
  }
}
