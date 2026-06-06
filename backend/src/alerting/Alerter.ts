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

// ─── Shared HTTP client ───────────────────────────────────────────────────────

// 5-second timeout — alerts are best-effort; we never block the pipeline on them.
const alertHttp = axios.create({ timeout: 5_000 });

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

// ─── WebhookAlerter ───────────────────────────────────────────────────────────

/**
 * IAlertSender that HTTP POSTs to ALERT_WEBHOOK_URL.
 *
 * Payload shape is compatible with Slack incoming webhooks:
 *   { "text": "<message>" }
 *
 * Other webhook endpoints (PagerDuty Events API, generic HTTP triggers) that
 * accept a JSON body with a "text" key will also work without modification.
 *
 * Never throws — a failed delivery is logged at warn level and swallowed so
 * the oracle/keeper pipeline is never interrupted by a broken alert path.
 * The URL itself is never logged (it may contain a secret token in the path).
 */
export class WebhookAlerter implements IAlertSender {
  private readonly url:    string;
  private readonly logger: Logger;

  constructor(config: Pick<AppConfig, "ALERT_WEBHOOK_URL">, logger: Logger) {
    if (!config.ALERT_WEBHOOK_URL) {
      throw new Error("WebhookAlerter requires ALERT_WEBHOOK_URL to be set");
    }
    this.url    = config.ALERT_WEBHOOK_URL;
    this.logger = logger.child({ component: "WebhookAlerter" });
  }

  async send(message: string): Promise<void> {
    try {
      await alertHttp.post(
        this.url,
        { text: message },
        { headers: { "Content-Type": "application/json" } },
      );
      this.logger.debug("Webhook alert delivered");
    } catch (err) {
      // Never propagate — alert failure must not crash the pipeline.
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Webhook alert delivery failed — swallowing error",
      );
    }
  }
}
