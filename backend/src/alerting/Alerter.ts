/**
 * Alert sender implementations.
 *
 * IAlertSender is defined in oracle/OracleUpdater.ts (Phase 4) and re-exported
 * here for convenience. Three concrete implementations are provided:
 *
 *  NoopAlerter      — silently discards all alerts; used when no destination
 *                     is configured. Never throws.
 *  WebhookAlerter   — HTTP POST to ALERT_WEBHOOK_URL with a JSON payload.
 *                     Suitable for Slack incoming webhooks, PagerDuty, etc.
 *  TelegramAlerter  — Telegram Bot API sendMessage call.
 *  CompositeAlerter — fans a single alert out to multiple IAlertSender instances.
 *                     Used in main.ts to combine webhook + Telegram when both
 *                     are configured.
 *
 * All implementations:
 *  - Never throw — a failed alert must not crash the oracle pipeline.
 *  - Log failures at warn level so the operator can detect a broken alert path.
 *  - Redact secrets from all log output (axios config is never logged).
 */

import axios from "axios";
import type { IAlertSender } from "../oracle/OracleUpdater.js";
import type { AppConfig }    from "../config/schema.js";
import type { Logger }       from "../logger.js";

export type { IAlertSender };

// ─── NoopAlerter ─────────────────────────────────────────────────────────────

/**
 * Null-object IAlertSender — discards all alerts silently.
 *
 * Used when neither ALERT_WEBHOOK_URL nor TELEGRAM_BOT_TOKEN is set.
 * Satisfies the IAlertSender interface without requiring a real destination,
 * so the oracle and keeper pipelines need no null-checks on the alerter.
 */
export class NoopAlerter implements IAlertSender {
  async send(_message: string): Promise<void> {
    // Intentionally silent — no destination configured.
  }
}
