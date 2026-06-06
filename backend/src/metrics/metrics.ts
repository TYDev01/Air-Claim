/**
 * Prometheus metrics for the AirClaim oracle backend.
 *
 * Call registerMetrics() once at boot (before the Scheduler starts) to:
 *  1. Enable prom-client default Node.js metrics (event loop lag, GC, memory, etc.).
 *  2. Register all custom AirClaim metrics in the default registry.
 *
 * Exported metric objects are updated directly by the Scheduler tick wrappers —
 * OracleUpdater and Keeper themselves remain metrics-free (single responsibility).
 *
 * All metrics use the "airclaim_" prefix to avoid collision in shared Prometheus
 * instances.
 */

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  type Registry,
  register as defaultRegistry,
} from "prom-client";

// ─── Custom metric objects ────────────────────────────────────────────────────

/** Total oracle_update transactions submitted (confirmed or failed). */
export let oracleUpdatesTotal: Counter;

/** Total keeper_check transactions submitted (confirmed or failed). */
export let keeperChecksTotal: Counter;

/** Current number of non-terminal tracked flights. */
export let activeFlightsGauge: Gauge;

/** Last block number successfully processed by the FlightTracker indexer. */
export let indexerLastBlockGauge: Gauge;

/** Current CELO balance of the updater wallet, in wei (as a float for Prometheus). */
export let updaterBalanceWeiGauge: Gauge;

/** Wall-clock duration of each oracle tick in seconds. */
export let oracleTickDurationSeconds: Histogram;

/** Wall-clock duration of each keeper tick in seconds. */
export let keeperTickDurationSeconds: Histogram;

/** Wall-clock duration of each indexer tick in seconds. */
export let indexerTickDurationSeconds: Histogram;

// ─── registerMetrics ─────────────────────────────────────────────────────────

/**
 * Register all metrics with the prom-client default registry and enable
 * Node.js default metrics collection.
 *
 * Must be called exactly once at process startup, before the Scheduler starts.
 * Calling twice throws (prom-client prevents duplicate metric registration).
 *
 * @param registry  Optional custom registry (used in tests to isolate metrics).
 *                  Defaults to prom-client's global default registry.
 */
export function registerMetrics(registry: Registry = defaultRegistry): void {
  collectDefaultMetrics({ register: registry, prefix: "airclaim_node_" });

  oracleUpdatesTotal = new Counter({
    name:    "airclaim_oracle_updates_total",
    help:    "Total number of oracle_update transactions submitted to FlightOracle",
    labelNames: ["outcome"], // "confirmed" | "failed"
    registers: [registry],
  });

  keeperChecksTotal = new Counter({
    name:    "airclaim_keeper_checks_total",
    help:    "Total number of keeper_check transactions submitted to InsuredFlightsAgency",
    labelNames: ["outcome"], // "confirmed" | "failed"
    registers: [registry],
  });

  activeFlightsGauge = new Gauge({
    name:    "airclaim_active_flights",
    help:    "Current number of non-terminal tracked flights",
    registers: [registry],
  });

  indexerLastBlockGauge = new Gauge({
    name:    "airclaim_indexer_last_block",
    help:    "Last block number successfully processed by the FlightInsured event indexer",
    registers: [registry],
  });

  updaterBalanceWeiGauge = new Gauge({
    name:    "airclaim_updater_balance_wei",
    help:    "Current CELO balance of the updater wallet in wei (as float64)",
    registers: [registry],
  });

  oracleTickDurationSeconds = new Histogram({
    name:    "airclaim_oracle_tick_duration_seconds",
    help:    "Wall-clock duration of each OracleUpdater.run() tick",
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  });

  keeperTickDurationSeconds = new Histogram({
    name:    "airclaim_keeper_tick_duration_seconds",
    help:    "Wall-clock duration of each Keeper.run() tick",
    buckets: [0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  });

  indexerTickDurationSeconds = new Histogram({
    name:    "airclaim_indexer_tick_duration_seconds",
    help:    "Wall-clock duration of each FlightTracker.sync() tick",
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });
}
