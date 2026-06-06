/**
 * Structured JSON logger (pino).
 *
 * Secrets listed in REDACT_PATHS are replaced with "[Redacted]" in every log
 * line — they never appear in stdout/stderr regardless of log level.
 */

import pino, { type Logger } from "pino";
import type { AppConfig } from "./config/schema.js";

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * JSON-path patterns pino will redact before writing any log line.
 * Covers the most likely accidental-logging shapes for our secrets.
 * Extend this list if new secret fields are added to AppConfig.
 */
const REDACT_PATHS: string[] = [
  // Config object fields
  "config.UPDATER_PRIVATE_KEY",
  "config.AVIATIONSTACK_API_KEY",
  "config.DATABASE_URL",
  "config.TELEGRAM_BOT_TOKEN",
  "config.ALERT_WEBHOOK_URL",
  // Flat keys (if accidentally spread into a log call)
  "UPDATER_PRIVATE_KEY",
  "AVIATIONSTACK_API_KEY",
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "ALERT_WEBHOOK_URL",
  // HTTP request/response shapes
  "req.headers.authorization",
  "req.headers['x-api-key']",
  // Generic catch-alls
  "*.privateKey",
  "*.apiKey",
  "*.secret",
  "*.password",
];

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the application-wide pino logger.
 *
 * @param config  Validated AppConfig — reads LOG_LEVEL only; secrets are not
 *                passed through to pino so they cannot appear in a serialiser.
 * @returns       Root Logger instance. Pass child loggers (logger.child({...}))
 *                to individual components for structured context.
 */
export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">): Logger {
  const isDev =
    process.env["NODE_ENV"] !== "production" &&
    process.stdout.isTTY;

  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: "[Redacted]",
    },
    // Pretty-print in TTY dev sessions; emit raw JSON in production/Docker.
    transport: isDev
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
      : undefined,
    base: {
      service: "airclaim-oracle-backend",
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
