/**
 * Zod-validated configuration schema.
 *
 * All runtime configuration is read from environment variables here and
 * validated once at startup. Any missing or invalid value causes an
 * immediate, descriptive error and refuses to boot.
 *
 * Secrets (private keys, API keys) are read from env only. They are never
 * logged — pino's redact list covers the keys below. Never add them to
 * application logs, health endpoints, or metrics labels.
 */

import { z } from "zod";

// ─── helpers ──────────────────────────────────────────────────────────────────

const positiveInt = (defaultVal?: number) =>
  z.coerce.number().int().positive().default(defaultVal ?? (undefined as unknown as number));

const nonEmptyString = z.string().min(1);

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const hexPrivateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");

// ─── Schema ───────────────────────────────────────────────────────────────────

export const configSchema = z.object({
  // ── Chain ──────────────────────────────────────────────────────────────────

  /** WebSocket or HTTPS RPC endpoint for Celo. Prefer a private node in production. */
  CELO_RPC_URL: nonEmptyString,

  /** Expected chain ID. Service refuses to start if the RPC reports a different ID. */
  CHAIN_ID: z.coerce.number().int().positive().default(42220),

  // ── Wallet (secret) ────────────────────────────────────────────────────────

  /**
   * Private key of the updater wallet that holds UPDATER_ROLE on FlightOracle.
   * Never logged. Use a KMS / secret manager in production.
   */
  UPDATER_PRIVATE_KEY: hexPrivateKey,

  // ── Contract addresses ─────────────────────────────────────────────────────

  FLIGHT_ORACLE_ADDRESS: hexAddress,
  INSURED_FLIGHTS_AGENCY_ADDRESS: hexAddress,

  // ── AviationStack (secret) ─────────────────────────────────────────────────

  /** AviationStack API access key. Never logged. */
  AVIATIONSTACK_API_KEY: nonEmptyString,

  /**
   * Base URL for the AviationStack API.
   * Free plan uses HTTP; paid plans support HTTPS.
   * Override here so tests can point at a local stub.
   */
  AVIATIONSTACK_BASE_URL: nonEmptyString.default("https://api.aviationstack.com/v1"),

  // ── Database ───────────────────────────────────────────────────────────────

  /** Prisma-compatible connection string, e.g. postgresql://user:pass@host:5432/db */
  DATABASE_URL: nonEmptyString,

  // ── Transaction settings ───────────────────────────────────────────────────

  /**
   * Number of block confirmations to wait after a tx is mined before
   * treating it as final. Celo re-org depth is negligible but > 0.
   */
  TX_CONFIRMATIONS: positiveInt(3),

  /**
   * Seconds to wait for a tx to be mined before treating it as stuck
   * and resubmitting with a bumped fee.
   */
  TX_TIMEOUT_SECONDS: positiveInt(120),

  /**
   * Maximum number of submission attempts per outbox entry before the entry
   * is marked failed and an alert is fired.
   */
  TX_MAX_ATTEMPTS: positiveInt(5),

  /**
   * Percentage by which maxFeePerGas is bumped on each stuck-tx resubmit.
   * EIP-1559 requires at least 10 % to replace a pending tx.
   */
  TX_FEE_BUMP_PERCENT: positiveInt(20),

  /**
   * Absolute ceiling on maxFeePerGas in gwei.
   * Prevents runaway fees if the fee oracle returns an absurd value.
   */
  TX_MAX_FEE_GWEI: positiveInt(500),

  // ── Insurance / oracle parameters ──────────────────────────────────────────

  /**
   * Delay threshold in minutes — must match the contract's constructor param.
   * Used by the mapper to decide whether a delayed departure/arrival
   * should be reported as Delayed vs Scheduled.
   */
  DELAY_THRESHOLD_MINUTES: positiveInt(30),

  /**
   * Seconds between keeper checkFlightDelay calls for the same flight.
   * Must be >= the contract's checkCooldownSeconds (300 s on mainnet).
   */
  CHECK_COOLDOWN_SECONDS: positiveInt(300),

  /**
   * Buffer added to scheduledArrivalUtc to compute keeperEligibleAfter.
   * Allows the flight some grace time after scheduled landing before the
   * keeper starts opening claims.
   */
  KEEPER_BUFFER_SECONDS: positiveInt(900), // 15 minutes

  // ── Alerting ───────────────────────────────────────────────────────────────

  /**
   * Seconds since the last confirmed oracle update before a staleness alert fires.
   * Set to slightly more than the longest polling interval for active flights.
   */
  STALENESS_ALERT_SECONDS: positiveInt(3600),

  /**
   * Minimum CELO balance (in wei, as a string) of the updater wallet before a
   * low-balance alert fires. Default: 0.1 CELO.
   */
  MIN_UPDATER_BALANCE_WEI: z.string().default("100000000000000000"),

  /**
   * HTTPS webhook URL (Slack / Discord incoming webhook, or custom).
   * Optional — alerting is skipped if not set.
   */
  ALERT_WEBHOOK_URL: z.string().url().optional(),

  /**
   * Telegram bot token and chat ID for alert delivery.
   * Both must be set together; ignored if either is missing.
   */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // ── HTTP server ────────────────────────────────────────────────────────────

  /** Port for the Fastify health/metrics server. */
  HTTP_PORT: positiveInt(3000),

  /** Hostname to bind the HTTP server on (0.0.0.0 for Docker). */
  HTTP_HOST: z.string().default("0.0.0.0"),

  // ── Behaviour flags ────────────────────────────────────────────────────────

  /**
   * When true: log the exact transaction that would be sent but do NOT
   * broadcast it. Keeper and updater both honour this flag.
   */
  DRY_RUN: z
    .string()
    .transform(v => v === "true")
    .default("false"),

  /** Logging level passed to pino. */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // ── Indexer ────────────────────────────────────────────────────────────────

  /**
   * Block to start indexing FlightInsured events from on the very first run.
   * Defaults to 0 (genesis) — override with the contract deployment block for
   * a faster first-run backfill.
   */
  INDEX_FROM_BLOCK: z.coerce.bigint().default(0n),

  /**
   * Maximum number of blocks to fetch logs for in a single eth_getLogs call.
   * Public RPCs typically cap at 1 000–10 000. Tune per provider.
   */
  INDEX_BATCH_SIZE: positiveInt(2000),

  // ── AviationStack rate limiting ────────────────────────────────────────────

  /**
   * Maximum AviationStack API requests per hour this instance is allowed to make.
   * Compute from your plan's monthly allowance / 730.
   * Basic plan (10,000/month) ≈ 13/h. Professional (50,000/month) ≈ 68/h.
   */
  AVIATIONSTACK_MAX_RPH: positiveInt(13),
});

export type AppConfig = z.infer<typeof configSchema>;

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Parse and validate process.env against the schema.
 * Throws a formatted ZodError on any invalid or missing required field.
 * Call once at process startup — treat the returned object as immutable.
 */
export function loadConfig(): AppConfig {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.errors.map(
      e => `  ${e.path.join(".")}: ${e.message}`,
    );
    throw new Error(`Configuration error — fix the following env vars:\n${lines.join("\n")}`);
  }
  return result.data;
}
