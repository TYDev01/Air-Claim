/**
 * Unit tests for AviationStackProvider.
 *
 * Two layers tested:
 *
 *  _parseResponse (pure normalisation)
 *    - Converts RawFlight → NormalisedFlight with correct field mapping.
 *    - Handles null/missing fields defensively.
 *    - typeof guard: only number delay values produce a non-null delayMinutes.
 *    - Unrecognised flight_status normalises to "unknown".
 *    - rawDigest truncated to 500 characters.
 *
 *  getFlightStatus (orchestration)
 *    - Empty data array → returns null (flight not found).
 *    - API-level error object → throws (HTTP 200 with response.error).
 *    - Exact IATA match preferred over first record when multiple returned.
 *    - First record used as fallback when no exact IATA match exists.
 *    - Circuit breaker / network failure → throws (caller holds and retries).
 *
 * The provider's internal axios instance and cockatiel policy are replaced via
 * property injection after construction — no vi.mock() at the module level,
 * no changes to runtime code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AviationStackProvider } from "../../src/providers/AviationStackProvider.js";
import type { AppConfig }        from "../../src/config/schema.js";
import type { Logger }           from "../../src/logger.js";

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

const stubConfig = {
  AVIATIONSTACK_BASE_URL: "https://api.aviationstack.com",
  AVIATIONSTACK_API_KEY:  "test-key",
} as Pick<AppConfig, "AVIATIONSTACK_BASE_URL" | "AVIATIONSTACK_API_KEY">;

// ─── Raw flight fixture helpers ───────────────────────────────────────────────

function rawLeg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    airport: "Addis Ababa Bole", timezone: "Africa/Addis_Ababa",
    iata: "ADD", icao: "HAAB", terminal: null, gate: null,
    delay: null, scheduled: "2025-01-15T06:00:00+03:00",
    estimated: null, actual: null,
    estimated_runway: null, actual_runway: null,
    ...overrides,
  };
}

function rawFlight(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flight_date:   "2025-01-15",
    flight_status: "scheduled",
    departure:     rawLeg({ iata: "ADD", delay: null }),
    arrival:       rawLeg({ iata: "NBO", delay: null }),
    airline:       { name: "Ethiopian Airlines", iata: "ET", icao: "ETH" },
    flight:        { number: "308", iata: "ET308", icao: "ETH308", codeshared: null },
    aircraft:      null,
    live:          null,
    ...overrides,
  };
}

// ─── _parseResponse tests ─────────────────────────────────────────────────────

describe("AviationStackProvider._parseResponse", () => {
  let provider: AviationStackProvider;

  beforeEach(() => {
    provider = new AviationStackProvider(stubConfig, makeLogger());
  });

  it("maps a complete scheduled flight correctly", () => {
    const raw = rawFlight() as never;
    const result = provider._parseResponse(raw, "ET308");

    expect(result.flightIata).toBe("ET308");
    expect(result.flightDate).toBe("2025-01-15");
    expect(result.apiStatus).toBe("scheduled");
    expect(result.departure.iata).toBe("ADD");
    expect(result.arrival.iata).toBe("NBO");
  });

  it("maps departure delay correctly when delay is a number", () => {
    const raw = rawFlight({ departure: rawLeg({ delay: 45 }) }) as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(result.departure.delayMinutes).toBe(45);
  });

  it("sets delayMinutes=null when delay is null", () => {
    const raw = rawFlight({ departure: rawLeg({ delay: null }) }) as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(result.departure.delayMinutes).toBeNull();
  });

  it("sets delayMinutes=null when delay is a string (typeof guard)", () => {
    // AviationStack occasionally returns delay as a string in edge cases.
    // The typeof guard ensures we never silently coerce.
    const raw = rawFlight({ departure: rawLeg({ delay: "30" }) }) as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(result.departure.delayMinutes).toBeNull();
  });

  it("falls back to flightIata param when flight.iata is null", () => {
    const raw = rawFlight({ flight: { number: "308", iata: null, icao: "ETH308", codeshared: null } }) as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(result.flightIata).toBe("ET308");
  });

  it("uppercases the IATA code from the response", () => {
    const raw = rawFlight({ flight: { number: "308", iata: "et308", icao: "ETH308", codeshared: null } }) as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(result.flightIata).toBe("ET308");
  });

  it("maps known statuses correctly: active", () => {
    const raw = rawFlight({ flight_status: "active" }) as never;
    expect(provider._parseResponse(raw, "ET308").apiStatus).toBe("active");
  });

  it("maps known statuses correctly: landed", () => {
    const raw = rawFlight({ flight_status: "landed" }) as never;
    expect(provider._parseResponse(raw, "ET308").apiStatus).toBe("landed");
  });

  it("maps known statuses correctly: cancelled", () => {
    const raw = rawFlight({ flight_status: "cancelled" }) as never;
    expect(provider._parseResponse(raw, "ET308").apiStatus).toBe("cancelled");
  });

  it("maps incident to incident", () => {
    const raw = rawFlight({ flight_status: "incident" }) as never;
    expect(provider._parseResponse(raw, "ET308").apiStatus).toBe("incident");
  });

  it("maps unrecognised flight_status to 'unknown'", () => {
    const raw = rawFlight({ flight_status: "bogus-status" }) as never;
    expect(provider._parseResponse(raw, "ET308").apiStatus).toBe("unknown");
  });

  it("maps null flight_status to 'unknown'", () => {
    const raw = rawFlight({ flight_status: null }) as never;
    expect(provider._parseResponse(raw, "ET308").apiStatus).toBe("unknown");
  });

  it("produces a rawDigest string of at most 500 characters", () => {
    const raw = rawFlight() as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(typeof result.rawDigest).toBe("string");
    expect(result.rawDigest.length).toBeLessThanOrEqual(500);
  });

  it("maps scheduledUtc, estimatedUtc, actualUtc from leg fields", () => {
    const raw = rawFlight({
      departure: rawLeg({
        scheduled:  "2025-01-15T06:00:00+03:00",
        estimated:  "2025-01-15T06:20:00+03:00",
        actual:     "2025-01-15T06:25:00+03:00",
      }),
    }) as never;
    const result = provider._parseResponse(raw, "ET308");
    expect(result.departure.scheduledUtc).toBe("2025-01-15T06:00:00+03:00");
    expect(result.departure.estimatedUtc).toBe("2025-01-15T06:20:00+03:00");
    expect(result.departure.actualUtc).toBe("2025-01-15T06:25:00+03:00");
  });
});

// ─── getFlightStatus orchestration tests ──────────────────────────────────────

describe("AviationStackProvider.getFlightStatus", () => {
  let provider: AviationStackProvider;

  /** Replace the internal axios instance with a mock after construction. */
  function injectHttp(mockGet: ReturnType<typeof vi.fn>): void {
    (provider as unknown as Record<string, unknown>).http = { get: mockGet };
  }

  /** Replace the cockatiel policy with one that executes the callback directly. */
  function injectPassthroughPolicy(): void {
    (provider as unknown as Record<string, unknown>).policy = {
      execute: (fn: () => unknown) => fn(),
    };
  }

  /** Replace the policy with one that throws (circuit open simulation). */
  function injectOpenCircuitPolicy(error = new Error("circuit breaker open")): void {
    (provider as unknown as Record<string, unknown>).policy = {
      execute: () => { throw error; },
    };
  }

  beforeEach(() => {
    provider = new AviationStackProvider(stubConfig, makeLogger());
    injectPassthroughPolicy();
  });

  it("returns null when API response data array is empty", async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: { data: [], pagination: null } });
    injectHttp(mockGet);
    const result = await provider.getFlightStatus("ET308", "2025-01-15");
    expect(result).toBeNull();
  });

  it("returns null when API response data is null", async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: { data: null, pagination: null } });
    injectHttp(mockGet);
    const result = await provider.getFlightStatus("ET308", "2025-01-15");
    expect(result).toBeNull();
  });

  it("throws when response.error is present (HTTP 200 with API error)", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { error: { code: "invalid_access_key", message: "Access key invalid." }, data: null },
    });
    injectHttp(mockGet);
    await expect(provider.getFlightStatus("ET308", "2025-01-15")).rejects.toThrow("invalid_access_key");
  });

  it("returns a NormalisedFlight on a valid response", async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { data: [rawFlight()], pagination: null },
    });
    injectHttp(mockGet);
    const result = await provider.getFlightStatus("ET308", "2025-01-15");
    expect(result).not.toBeNull();
    expect(result!.flightIata).toBe("ET308");
    expect(result!.apiStatus).toBe("scheduled");
  });

  it("prefers the record whose flight.iata matches the requested IATA over first record", async () => {
    const first  = rawFlight({ flight_status: "active",    flight: { iata: "ET100" } });
    const target = rawFlight({ flight_status: "cancelled", flight: { iata: "ET308" } });
    const mockGet = vi.fn().mockResolvedValue({
      data: { data: [first, target], pagination: null },
    });
    injectHttp(mockGet);
    const result = await provider.getFlightStatus("ET308", "2025-01-15");
    expect(result!.apiStatus).toBe("cancelled");
  });

  it("falls back to first record when no exact IATA match exists", async () => {
    const first  = rawFlight({ flight_status: "landed", flight: { iata: "ET999" } });
    const second = rawFlight({ flight_status: "active", flight: { iata: "ET888" } });
    const mockGet = vi.fn().mockResolvedValue({
      data: { data: [first, second], pagination: null },
    });
    injectHttp(mockGet);
    const result = await provider.getFlightStatus("ET308", "2025-01-15");
    expect(result!.apiStatus).toBe("landed");
  });

  it("throws when the circuit breaker is open (does not call the API)", async () => {
    const mockGet = vi.fn();
    injectHttp(mockGet);
    injectOpenCircuitPolicy();
    await expect(provider.getFlightStatus("ET308", "2025-01-15")).rejects.toThrow("circuit breaker open");
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("throws on network error and does not return null", async () => {
    const mockGet = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    injectHttp(mockGet);
    await expect(provider.getFlightStatus("ET308", "2025-01-15")).rejects.toThrow("ECONNREFUSED");
  });

  it("passes flight_iata uppercased to the API request", async () => {
    const mockGet = vi.fn().mockResolvedValue({ data: { data: [], pagination: null } });
    injectHttp(mockGet);
    await provider.getFlightStatus("et308", "2025-01-15");
    const params = mockGet.mock.calls[0]?.[1]?.params;
    expect(params?.flight_iata).toBe("ET308");
  });
});
