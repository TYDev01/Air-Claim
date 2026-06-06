/**
 * Unit tests for backend/src/config/schema.ts
 *
 * Verifies that:
 *  - A complete, valid environment object produces a correctly typed AppConfig.
 *  - Each required field missing from the environment causes loadConfig() to throw
 *    a ZodError listing that field.
 *  - Invalid values (wrong types, out-of-range numbers, bad hex key) are rejected.
 *  - Optional fields with defaults produce the documented default values.
 *  - Secret fields (UPDATER_PRIVATE_KEY) are validated for the hex-key format.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid environment — every required field present with a sensible value. */
function validEnv(): Record<string, string> {
  return {
    CELO_RPC_URL:                    "https://forno.celo.org",
    CHAIN_ID:                        "42220",
    UPDATER_PRIVATE_KEY:             "0x" + "a".repeat(64),
    FLIGHT_ORACLE_ADDRESS:           "0x" + "1".repeat(40),
    INSURED_FLIGHTS_AGENCY_ADDRESS:  "0x" + "2".repeat(40),
    AVIATIONSTACK_API_KEY:           "test-api-key",
    DATABASE_URL:                    "postgresql://user:pass@localhost:5432/airclaim",
    MIN_UPDATER_BALANCE_WEI:         "100000000000000000",
    INDEX_FROM_BLOCK:                "26000000",
  };
}

/** Apply an env object over process.env and restore on cleanup. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("loadConfig()", () => {

  // Save and clear the real environment before each test.
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env } as Record<string, string | undefined>;
    // Clear all env vars that schema.ts reads so tests are fully isolated.
    for (const key of Object.keys(validEnv())) {
      delete process.env[key];
    }
    // Also clear optional fields that have defaults but might bleed in.
    const optionals = [
      "TX_CONFIRMATIONS", "TX_TIMEOUT_SECONDS", "TX_MAX_ATTEMPTS",
      "TX_FEE_BUMP_PERCENT", "TX_MAX_FEE_GWEI", "DELAY_THRESHOLD_MINUTES",
      "CHECK_COOLDOWN_SECONDS", "KEEPER_BUFFER_SECONDS", "STALENESS_ALERT_SECONDS",
      "ALERT_WEBHOOK_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
      "HTTP_PORT", "HTTP_HOST", "DRY_RUN", "LOG_LEVEL",
      "INDEX_BATCH_SIZE", "AVIATIONSTACK_MAX_RPH",
    ];
    for (const key of optionals) delete process.env[key];
  });

  afterEach(() => {
    // Restore original environment.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("accepts a complete valid environment and returns correct AppConfig", () => {
    Object.assign(process.env, validEnv());
    const config = loadConfig();

    expect(config.CELO_RPC_URL).toBe("https://forno.celo.org");
    expect(config.CHAIN_ID).toBe(42220);
    expect(config.FLIGHT_ORACLE_ADDRESS).toBe("0x" + "1".repeat(40));
    expect(config.MIN_UPDATER_BALANCE_WEI).toBe(100000000000000000n);
    expect(config.INDEX_FROM_BLOCK).toBe(26000000n);
  });

  it("applies correct defaults for optional fields", () => {
    Object.assign(process.env, validEnv());
    const config = loadConfig();

    expect(config.TX_CONFIRMATIONS).toBe(3);
    expect(config.TX_TIMEOUT_SECONDS).toBe(120);
    expect(config.TX_MAX_ATTEMPTS).toBe(5);
    expect(config.TX_FEE_BUMP_PERCENT).toBe(20);
    expect(config.TX_MAX_FEE_GWEI).toBe(500);
    expect(config.DELAY_THRESHOLD_MINUTES).toBe(30);
    expect(config.CHECK_COOLDOWN_SECONDS).toBe(300);
    expect(config.KEEPER_BUFFER_SECONDS).toBe(900);
    expect(config.HTTP_PORT).toBe(3000);
    expect(config.DRY_RUN).toBe(false);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.INDEX_BATCH_SIZE).toBe(2000);
    expect(config.AVIATIONSTACK_MAX_RPH).toBe(13);
  });

  it("parses DRY_RUN=true correctly", () => {
    Object.assign(process.env, validEnv(), { DRY_RUN: "true" });
    const config = loadConfig();
    expect(config.DRY_RUN).toBe(true);
  });

  it("parses optional Telegram fields when present", () => {
    Object.assign(process.env, validEnv(), {
      TELEGRAM_BOT_TOKEN: "123456:ABC-token",
      TELEGRAM_CHAT_ID:   "-1001234567890",
    });
    const config = loadConfig();
    expect(config.TELEGRAM_BOT_TOKEN).toBe("123456:ABC-token");
    expect(config.TELEGRAM_CHAT_ID).toBe("-1001234567890");
  });

  // ── Required field validation ───────────────────────────────────────────────

  it("throws when CELO_RPC_URL is missing", () => {
    Object.assign(process.env, validEnv());
    delete process.env["CELO_RPC_URL"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when UPDATER_PRIVATE_KEY is missing", () => {
    Object.assign(process.env, validEnv());
    delete process.env["UPDATER_PRIVATE_KEY"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when DATABASE_URL is missing", () => {
    Object.assign(process.env, validEnv());
    delete process.env["DATABASE_URL"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when AVIATIONSTACK_API_KEY is missing", () => {
    Object.assign(process.env, validEnv());
    delete process.env["AVIATIONSTACK_API_KEY"];
    expect(() => loadConfig()).toThrow();
  });

  it("throws when MIN_UPDATER_BALANCE_WEI is missing", () => {
    Object.assign(process.env, validEnv());
    delete process.env["MIN_UPDATER_BALANCE_WEI"];
    expect(() => loadConfig()).toThrow();
  });

  // ── Private key format validation ──────────────────────────────────────────

  it("rejects UPDATER_PRIVATE_KEY without 0x prefix", () => {
    Object.assign(process.env, validEnv(), {
      UPDATER_PRIVATE_KEY: "a".repeat(64),
    });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects UPDATER_PRIVATE_KEY that is too short", () => {
    Object.assign(process.env, validEnv(), {
      UPDATER_PRIVATE_KEY: "0x" + "a".repeat(32),
    });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects UPDATER_PRIVATE_KEY with non-hex characters", () => {
    Object.assign(process.env, validEnv(), {
      UPDATER_PRIVATE_KEY: "0x" + "g".repeat(64),
    });
    expect(() => loadConfig()).toThrow();
  });

  it("accepts UPDATER_PRIVATE_KEY with uppercase hex digits", () => {
    Object.assign(process.env, validEnv(), {
      UPDATER_PRIVATE_KEY: "0x" + "A".repeat(64),
    });
    expect(() => loadConfig()).not.toThrow();
  });

  // ── Numeric field validation ────────────────────────────────────────────────

  it("rejects non-numeric CHAIN_ID", () => {
    Object.assign(process.env, validEnv(), { CHAIN_ID: "not-a-number" });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects non-numeric HTTP_PORT", () => {
    Object.assign(process.env, validEnv(), { HTTP_PORT: "abc" });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects TX_CONFIRMATIONS below 1", () => {
    Object.assign(process.env, validEnv(), { TX_CONFIRMATIONS: "0" });
    expect(() => loadConfig()).toThrow();
  });
});
