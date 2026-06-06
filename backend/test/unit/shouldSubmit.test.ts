/**
 * Unit tests for OracleUpdater._shouldSubmit()
 *
 * _shouldSubmit is the idempotency + regression guard that prevents writing
 * a no-op, a duplicate, or a backwards status transition to the oracle contract.
 *
 * This file tests the function in complete isolation — all OracleUpdater
 * constructor dependencies are minimal no-op stubs. Only the flight argument,
 * newStatus, and newDelay values drive the outcome.
 */

import { describe, it, expect, vi } from "vitest";
import { OracleUpdater }            from "../../src/oracle/OracleUpdater.js";
import { OnChainFlightStatus }      from "../../src/interfaces/IChainClient.js";
import type { TrackedFlight }       from "../../src/interfaces/IFlightRepository.js";
import type { AppConfig }           from "../../src/config/schema.js";
import type { Logger }              from "../../src/logger.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

/** Minimal logger stub — captures warn calls for regression assertions. */
function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    // pino Logger has more fields, but _shouldSubmit only uses debug/warn/child.
  } as unknown as Logger;
}

/** Minimal config stub — _shouldSubmit doesn't read any config fields. */
const stubConfig = {} as AppConfig;

/** Build an OracleUpdater with all dependencies stubbed to no-ops. */
function makeUpdater(logger = makeLogger()): OracleUpdater {
  const noopProvider = { getFlightStatus: vi.fn() } as never;
  const noopChain    = {} as never;
  const noopRepo     = {} as never;
  const noopAlerter  = { send: vi.fn() } as never;
  return new OracleUpdater(noopProvider, noopChain, noopRepo, noopAlerter, stubConfig, logger);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const { Scheduled, Delayed, Cancelled, Landed } = OnChainFlightStatus;

function makeFlight(overrides: Partial<TrackedFlight> = {}): TrackedFlight {
  return {
    id:                       "uuid-1",
    flightId:                 "0x" + "a".repeat(64),
    flightIata:               "ET308",
    flightDate:               "2025-01-15",
    originIata:               "ADD",
    destIata:                 "NBO",
    scheduledDepartureUtc:    new Date("2025-01-15T06:00:00Z"),
    scheduledArrivalUtc:      new Date("2025-01-15T08:30:00Z"),
    lastSubmittedStatus:      Scheduled,
    lastSubmittedDelayMinutes: 0,
    lastSubmittedAt:          null,
    isTerminal:               false,
    keeperEligibleAfter:      null,
    keeperLastCalledAt:       null,
    createdAt:                new Date(),
    updatedAt:                new Date(),
    ...overrides,
  };
}

// ─── Terminal guard ───────────────────────────────────────────────────────────

describe("_shouldSubmit — terminal guard", () => {
  it("returns false when flight.isTerminal=true, regardless of new status", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ isTerminal: true, lastSubmittedStatus: Landed });
    expect(updater._shouldSubmit(flight, Landed, 0)).toBe(false);
  });

  it("returns false even when new status would be a genuine transition on a terminal flight", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ isTerminal: true, lastSubmittedStatus: Delayed });
    expect(updater._shouldSubmit(flight, Landed, 0)).toBe(false);
  });
});

// ─── Regression guard ─────────────────────────────────────────────────────────

describe("_shouldSubmit — regression guard", () => {
  it("returns false when newStatus < lastSubmittedStatus (Delayed → Scheduled)", () => {
    const logger  = makeLogger();
    const updater = makeUpdater(logger);
    const flight  = makeFlight({ lastSubmittedStatus: Delayed });
    expect(updater._shouldSubmit(flight, Scheduled, 0)).toBe(false);
  });

  it("logs a warn when a regression is detected", () => {
    const logger  = makeLogger();
    const updater = makeUpdater(logger);
    const flight  = makeFlight({ lastSubmittedStatus: Delayed });
    updater._shouldSubmit(flight, Scheduled, 0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns false for Cancelled → Scheduled regression", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Cancelled });
    expect(updater._shouldSubmit(flight, Scheduled, 0)).toBe(false);
  });

  it("returns false for Landed → Delayed regression", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Landed });
    expect(updater._shouldSubmit(flight, Delayed, 60)).toBe(false);
  });

  it("returns false for Landed → Scheduled regression", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Landed });
    expect(updater._shouldSubmit(flight, Scheduled, 0)).toBe(false);
  });
});

// ─── Exact duplicate guard ────────────────────────────────────────────────────

describe("_shouldSubmit — exact duplicate guard", () => {
  it("returns false when status and delay are identical to last submitted", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Scheduled, lastSubmittedDelayMinutes: 0 });
    expect(updater._shouldSubmit(flight, Scheduled, 0)).toBe(false);
  });

  it("returns false for Delayed duplicate with same delay value", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Delayed, lastSubmittedDelayMinutes: 45 });
    expect(updater._shouldSubmit(flight, Delayed, 45)).toBe(false);
  });

  it("returns true when status is same but delay has increased (not a pure duplicate)", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Delayed, lastSubmittedDelayMinutes: 30 });
    expect(updater._shouldSubmit(flight, Delayed, 60)).toBe(true);
  });

  it("returns true when status is same but delay has decreased (not duplicate — caller may skip, but function allows)", () => {
    // _shouldSubmit only blocks: terminal, regression (lower status), exact duplicate.
    // A delay decrease within the same status level is not a status regression
    // (Delayed → Delayed) — the status ordinal is equal, not less. So it returns true.
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Delayed, lastSubmittedDelayMinutes: 60 });
    expect(updater._shouldSubmit(flight, Delayed, 30)).toBe(true);
  });
});

// ─── Valid transitions — returns true ─────────────────────────────────────────

describe("_shouldSubmit — valid transitions return true", () => {
  it("Scheduled → Delayed is a valid forward transition", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Scheduled, lastSubmittedDelayMinutes: 0 });
    expect(updater._shouldSubmit(flight, Delayed, 45)).toBe(true);
  });

  it("Scheduled → Cancelled is a valid forward transition", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Scheduled });
    expect(updater._shouldSubmit(flight, Cancelled, 0)).toBe(true);
  });

  it("Scheduled → Landed is a valid forward transition", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Scheduled });
    expect(updater._shouldSubmit(flight, Landed, 0)).toBe(true);
  });

  it("Delayed → Cancelled is a valid forward transition", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Delayed, lastSubmittedDelayMinutes: 45 });
    expect(updater._shouldSubmit(flight, Cancelled, 0)).toBe(true);
  });

  it("Delayed → Landed is a valid forward transition", () => {
    const updater = makeUpdater();
    const flight  = makeFlight({ lastSubmittedStatus: Delayed, lastSubmittedDelayMinutes: 45 });
    expect(updater._shouldSubmit(flight, Landed, 0)).toBe(true);
  });
});
