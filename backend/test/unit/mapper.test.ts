/**
 * Unit tests for backend/src/providers/mapper.ts
 *
 * mapApiStatus() is the safety-critical function of the entire system — a wrong
 * mapping directly causes a wrong payout. These tests are exhaustive:
 *
 *  - Every documented API status value is covered.
 *  - Threshold boundary conditions are verified (at-threshold, below, above).
 *  - Null / missing delay fields are handled correctly.
 *  - Unknown statuses produce the Unknown sentinel with .unknown=true.
 *  - The discriminated union shape is verified so callers can narrow correctly.
 */

import { describe, it, expect } from "vitest";
import { mapApiStatus, UNKNOWN } from "../../src/providers/mapper.js";
import { OnChainFlightStatus }   from "../../src/interfaces/IChainClient.js";
import type { NormalisedFlight, ApiFlightStatus } from "../../src/interfaces/IFlightDataProvider.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const THRESHOLD = 30; // minutes — matches the contract default

function makeFlight(
  apiStatus: ApiFlightStatus,
  depDelay: number | null = null,
  arrDelay: number | null = null,
): NormalisedFlight {
  return {
    flightIata: "ET308",
    flightDate: "2025-01-15",
    apiStatus,
    departure: {
      iata:           "ADD",
      scheduledUtc:   "2025-01-15T06:00:00Z",
      estimatedUtc:   null,
      actualUtc:      null,
      delayMinutes:   depDelay,
    },
    arrival: {
      iata:           "NBO",
      scheduledUtc:   "2025-01-15T08:30:00Z",
      estimatedUtc:   null,
      actualUtc:      null,
      delayMinutes:   arrDelay,
    },
    rawDigest: "{}",
  };
}

// ─── "scheduled" ──────────────────────────────────────────────────────────────

describe('mapApiStatus — "scheduled"', () => {
  it("returns Scheduled with delayMinutes=0", () => {
    const result = mapApiStatus(makeFlight("scheduled"), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Scheduled);
      expect(result.delayMinutes).toBe(0);
    }
  });
});

// ─── "active" ─────────────────────────────────────────────────────────────────

describe('mapApiStatus — "active"', () => {
  it("returns Scheduled when departure delay is null (treat as 0)", () => {
    const result = mapApiStatus(makeFlight("active", null), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Scheduled);
      expect(result.delayMinutes).toBe(0);
    }
  });

  it("returns Scheduled when departure delay is below threshold", () => {
    const result = mapApiStatus(makeFlight("active", THRESHOLD - 1), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Scheduled);
      expect(result.delayMinutes).toBe(THRESHOLD - 1);
    }
  });

  it("returns Delayed when departure delay equals threshold (boundary — inclusive)", () => {
    const result = mapApiStatus(makeFlight("active", THRESHOLD), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Delayed);
      expect(result.delayMinutes).toBe(THRESHOLD);
    }
  });

  it("returns Delayed when departure delay exceeds threshold", () => {
    const result = mapApiStatus(makeFlight("active", THRESHOLD + 45), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Delayed);
      expect(result.delayMinutes).toBe(THRESHOLD + 45);
    }
  });

  it("returns Scheduled with delay=0 when delay is 0", () => {
    const result = mapApiStatus(makeFlight("active", 0), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Scheduled);
      expect(result.delayMinutes).toBe(0);
    }
  });
});

// ─── "cancelled" ─────────────────────────────────────────────────────────────

describe('mapApiStatus — "cancelled"', () => {
  it("returns Cancelled with delayMinutes=0", () => {
    const result = mapApiStatus(makeFlight("cancelled"), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Cancelled);
      expect(result.delayMinutes).toBe(0);
    }
  });
});

// ─── "landed" ────────────────────────────────────────────────────────────────

describe('mapApiStatus — "landed"', () => {
  it("returns Landed with delayMinutes=0 when arrival delay is null", () => {
    const result = mapApiStatus(makeFlight("landed", null, null), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Landed);
      expect(result.delayMinutes).toBe(0);
    }
  });

  it("returns Landed when arrival delay is below threshold", () => {
    const result = mapApiStatus(makeFlight("landed", null, THRESHOLD - 1), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Landed);
      expect(result.delayMinutes).toBe(0);
    }
  });

  it("returns Delayed when arrival delay equals threshold (boundary — inclusive)", () => {
    const result = mapApiStatus(makeFlight("landed", null, THRESHOLD), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Delayed);
      expect(result.delayMinutes).toBe(THRESHOLD);
    }
  });

  it("returns Delayed when arrival delay exceeds threshold", () => {
    const result = mapApiStatus(makeFlight("landed", null, THRESHOLD + 60), THRESHOLD);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Delayed);
      expect(result.delayMinutes).toBe(THRESHOLD + 60);
    }
  });
});

// ─── Unknown-hold statuses ────────────────────────────────────────────────────

describe('mapApiStatus — Unknown hold statuses', () => {
  it('"incident" returns unknown=true with a reason string', () => {
    const result = mapApiStatus(makeFlight("incident"), THRESHOLD);
    expect(result.unknown).toBe(true);
    if (result.unknown) {
      expect(result.status).toBe(UNKNOWN);
      expect(result.delayMinutes).toBeNull();
      expect(result.reason).toMatch(/incident/);
    }
  });

  it('"diverted" returns unknown=true with a reason string', () => {
    const result = mapApiStatus(makeFlight("diverted"), THRESHOLD);
    expect(result.unknown).toBe(true);
    if (result.unknown) {
      expect(result.status).toBe(UNKNOWN);
      expect(result.reason).toMatch(/diverted/);
    }
  });

  it('"unknown" (API explicit unknown) returns unknown=true', () => {
    const result = mapApiStatus(makeFlight("unknown"), THRESHOLD);
    expect(result.unknown).toBe(true);
    if (result.unknown) {
      expect(result.status).toBe(UNKNOWN);
      expect(result.delayMinutes).toBeNull();
    }
  });
});

// ─── Discriminated union shape ────────────────────────────────────────────────

describe("mapApiStatus — MapResult discriminated union", () => {
  it("known result has unknown=false, numeric status, numeric delayMinutes", () => {
    const result = mapApiStatus(makeFlight("scheduled"), THRESHOLD);
    expect(typeof result.unknown).toBe("boolean");
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(typeof result.status).toBe("number");
      expect(typeof result.delayMinutes).toBe("number");
    }
  });

  it("unknown result has unknown=true, UNKNOWN sentinel status, null delayMinutes, reason string", () => {
    const result = mapApiStatus(makeFlight("incident"), THRESHOLD);
    expect(result.unknown).toBe(true);
    if (result.unknown) {
      expect(result.status).toBe("Unknown");
      expect(result.delayMinutes).toBeNull();
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ─── Threshold sensitivity ────────────────────────────────────────────────────

describe("mapApiStatus — threshold sensitivity", () => {
  it("correctly switches from Scheduled to Delayed as threshold changes", () => {
    const flight = makeFlight("active", 45);

    // threshold=60 → delay(45) < threshold → Scheduled
    const r1 = mapApiStatus(flight, 60);
    expect(r1.unknown).toBe(false);
    if (!r1.unknown) expect(r1.status).toBe(OnChainFlightStatus.Scheduled);

    // threshold=30 → delay(45) ≥ threshold → Delayed
    const r2 = mapApiStatus(flight, 30);
    expect(r2.unknown).toBe(false);
    if (!r2.unknown) expect(r2.status).toBe(OnChainFlightStatus.Delayed);
  });

  it("threshold=0 means any positive delay is Delayed", () => {
    const result = mapApiStatus(makeFlight("active", 1), 0);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.status).toBe(OnChainFlightStatus.Delayed);
    }
  });
});
