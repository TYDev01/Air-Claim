/**
 * main.ts — AirClaim oracle backend process entry point.
 *
 * Boot sequence:
 *  1.  Load + validate config (zod — throws on missing/invalid env vars).
 *  2.  Create logger.
 *  3.  Register Prometheus metrics.
 *  4.  Connect Prisma / PrismaRepository.
 *  5.  Create ChainClient (static factory — runs boot checks: role, balance).
 *  6.  Create PublicClient for FlightTracker (read-only, no key needed).
 *  7.  Load contract ABIs from artifacts.
 *  8.  Create AviationStackProvider.
 *  9.  Create alerter (buildAlerter selects Noop/Webhook/Telegram/Composite).
 *  10. Wire OracleUpdater, Keeper, FlightTracker, Scheduler.
 *  11. Create + start Fastify HTTP server.
 *  12. Start Scheduler (fires indexer immediately, oracle after 60 s, keeper after 5 min).
 *  13. Set updaterBalanceWeiGauge at boot; refresh every 10 minutes.
 *  14. Register SIGTERM / SIGINT for graceful shutdown.
 *  15. Register uncaughtException / unhandledRejection for fatal-exit logging.
 */

import { createPublicClient, http, defineChain } from "viem";
import { PrismaClient }                from "@prisma/client";

import { loadConfig }                  from "./config/schema.js";
import { createLogger }                from "./logger.js";
import { registerMetrics, updaterBalanceWeiGauge } from "./metrics/metrics.js";
import { loadAbis }                    from "./chain/abis.js";
import { ChainClient }                 from "./chain/ChainClient.js";
import { PrismaRepository }            from "./db/PrismaRepository.js";
import { FlightTracker }               from "./db/FlightTracker.js";
import { AviationStackProvider }       from "./providers/AviationStackProvider.js";
import { buildAlerter }                from "./alerting/Alerter.js";
import { OracleUpdater }               from "./oracle/OracleUpdater.js";
import { Keeper }                      from "./keeper/Keeper.js";
import { Scheduler }                   from "./scheduler/Scheduler.js";
import { createHttpServer }            from "./http/server.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ── 1. Config ──────────────────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logger not yet available — write directly to stderr and exit.
    process.stderr.write(`[FATAL] Config validation failed:\n${String(err)}\n`);
    process.exit(1);
  }

  // ── 2. Logger ──────────────────────────────────────────────────────────────
  const logger = createLogger(config);
  logger.info({ dryRun: config.DRY_RUN }, "AirClaim oracle backend starting");

  // ── 3. Metrics ─────────────────────────────────────────────────────────────
  registerMetrics();

  // ── 4. Database ────────────────────────────────────────────────────────────
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    logger.info("Prisma connected");
  } catch (err) {
    logger.fatal({ err }, "Prisma connection failed — exiting");
    process.exit(1);
  }
  const repo = new PrismaRepository(prisma);

  // ── 5. ChainClient (wallet — includes boot role + balance checks) ──────────
  let chainClient: ChainClient;
  try {
    chainClient = await ChainClient.create(config, logger);
    logger.info("ChainClient initialised — updater role verified");
  } catch (err) {
    logger.fatal({ err }, "ChainClient boot check failed — exiting");
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── 6. PublicClient for FlightTracker (read-only, no signing key) ──────────
  const viemChain = defineChain({
    id:              config.CHAIN_ID,
    name:            "Celo",
    nativeCurrency:  { name: "CELO", symbol: "CELO", decimals: 18 },
    rpcUrls:         { default: { http: [config.CELO_RPC_URL] } },
  });
  const publicClient = createPublicClient({
    chain:     viemChain,
    transport: http(config.CELO_RPC_URL),
  });

  // ── 7. ABIs ────────────────────────────────────────────────────────────────
  const { insuredFlightsAgencyAbi } = loadAbis();

  // ── 8. Flight data provider ────────────────────────────────────────────────
  const provider = new AviationStackProvider(config, logger);

  // ── 9. Alerter ─────────────────────────────────────────────────────────────
  const alerter = buildAlerter(config, logger);

  // ── 10. Pipeline components ────────────────────────────────────────────────
  const updater = new OracleUpdater(provider, chainClient, repo, alerter, config, logger);
  const keeper  = new Keeper(chainClient, repo, alerter, config, logger);
  const tracker = new FlightTracker(
    publicClient,
    repo,
    config.INSURED_FLIGHTS_AGENCY_ADDRESS as `0x${string}`,
    insuredFlightsAgencyAbi,
    config,
    logger,
  );
  const scheduler = new Scheduler(updater, keeper, tracker, repo, config, logger);

  // ── 11. HTTP server ────────────────────────────────────────────────────────
  const fastify = createHttpServer(config, logger);
  try {
    await fastify.listen({ port: config.HTTP_PORT, host: config.HTTP_HOST });
    logger.info({ port: config.HTTP_PORT, host: config.HTTP_HOST }, "HTTP server listening");
  } catch (err) {
    logger.fatal({ err }, "HTTP server failed to start — exiting");
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── 12. Scheduler ──────────────────────────────────────────────────────────
  await scheduler.start();
  logger.info("Scheduler started");

  // ── 13. Updater balance gauge ──────────────────────────────────────────────
  const refreshBalanceGauge = async (): Promise<void> => {
    try {
      const balance = await chainClient.getUpdaterBalance();
      updaterBalanceWeiGauge.set(Number(balance));
    } catch {
      // Non-fatal — gauge staleness is acceptable.
    }
  };
  await refreshBalanceGauge();
  const balanceTimer = setInterval(refreshBalanceGauge, 10 * 60 * 1_000);

  // ── 14. Graceful shutdown ──────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Shutdown signal received — draining");

    clearInterval(balanceTimer);

    try {
      await scheduler.stop();
      logger.info("Scheduler drained");

      await fastify.close();
      logger.info("HTTP server closed");

      await prisma.$disconnect();
      logger.info("Prisma disconnected — shutdown complete");

      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown — forcing exit");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });

  // ── 15. Unhandled error safety net ────────────────────────────────────────
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — exiting");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason: String(reason) }, "Unhandled promise rejection — exiting");
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`[FATAL] Unhandled error in main():\n${String(err)}\n`);
  process.exit(1);
});
