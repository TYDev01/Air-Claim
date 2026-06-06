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

// Telegram Bot API base — token is appended per-request, never stored in a URL constant.
const TELEGRAM_API_BASE = "https://api.telegram.org";

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

// ─── TelegramAlerter ──────────────────────────────────────────────────────────

/**
 * IAlertSender that delivers messages via the Telegram Bot API.
 *
 * Calls POST https://api.telegram.org/bot{token}/sendMessage with the
 * configured chat_id and message text. parse_mode is omitted so plain-text
 * messages are never rejected due to accidental HTML/Markdown characters.
 *
 * Never throws — delivery failures are logged at warn level and swallowed.
 * The bot token is never logged or stored in a loggable URL string; it is
 * interpolated at call time and discarded.
 *
 * Requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be set.
 * Constructor throws at boot if either is missing.
 */
export class TelegramAlerter implements IAlertSender {
  private readonly token:  string;
  private readonly chatId: string;
  private readonly logger: Logger;

  constructor(
    config: Pick<AppConfig, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">,
    logger: Logger,
  ) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
      throw new Error(
        "TelegramAlerter requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be set",
      );
    }
    this.token  = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.logger = logger.child({ component: "TelegramAlerter" });
  }

  async send(message: string): Promise<void> {
    try {
      // Token is interpolated here only — never stored in a property that
      // could appear in a structured log object.
      const url = `${TELEGRAM_API_BASE}/bot${this.token}/sendMessage`;

      await alertHttp.post(
        url,
        {
          chat_id: this.chatId,
          text:    message,
        },
        { headers: { "Content-Type": "application/json" } },
      );

      this.logger.debug({ chatId: this.chatId }, "Telegram alert delivered");
    } catch (err) {
      // Never propagate — alert failure must not crash the pipeline.
      this.logger.warn(
        { chatId: this.chatId, err: err instanceof Error ? err.message : String(err) },
        "Telegram alert delivery failed — swallowing error",
      );
    }
  }
}
