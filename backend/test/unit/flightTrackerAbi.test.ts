/**
 * Pins the indexer's FlightInsured event definition against the committed
 * InsuredFlightsAgency ABI (backend/abis/InsuredFlightsAgency.json).
 *
 * This is the regression guard for newTodo.md #1: the indexer once decoded a
 * FlightInsured shape that the deployed contract never emitted, so eth_getLogs
 * matched zero logs and no flight was ever tracked — and nothing caught it.
 * If the contract event and the indexer's FLIGHT_INSURED_EVENT ever drift
 * apart, the assertions below fail at build time instead of silently in prod.
 */

import { describe, it, expect } from "vitest";
import {
  encodeEventTopics,
  encodeAbiParameters,
  decodeEventLog,
  toEventHash,
  getAbiItem,
  type AbiEvent,
} from "viem";

import { loadAbis } from "../../src/chain/abis.js";
import { FLIGHT_INSURED_EVENT } from "../../src/db/FlightTracker.js";

describe("FlightTracker ↔ committed ABI", () => {
  const { insuredFlightsAgencyAbi } = loadAbis();
  const committed = getAbiItem({
    abi:  insuredFlightsAgencyAbi,
    name: "FlightInsured",
  }) as AbiEvent | undefined;

  it("FlightInsured exists in the committed ABI", () => {
    expect(committed).toBeDefined();
    expect(committed!.type).toBe("event");
  });

  it("indexer event signature matches the committed ABI's event hash (topic0)", () => {
    // Same name + ordered param types ⇒ same topic0. Any drift (renamed,
    // reordered, added, or retyped field) changes this hash.
    expect(toEventHash(FLIGHT_INSURED_EVENT)).toBe(toEventHash(committed!));
  });

  it("decodes a log encoded from the committed ABI with the expected field names", () => {
    const flightId   = `0x${"ab".repeat(32)}` as `0x${string}`;
    const passenger  = `0x${"11".repeat(20)}` as `0x${string}`;
    const flightDate = 1_760_000_000n; // unix seconds

    // Encode a log AS THE CONTRACT WOULD (against the committed ABI):
    //  - indexed args (policyId, flightId) → topics
    //  - non-indexed args                  → data
    const topics = encodeEventTopics({
      abi:       insuredFlightsAgencyAbi,
      eventName: "FlightInsured",
      args:      { policyId: 1n, flightId },
    });

    const nonIndexed = committed!.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed, [
      "ET309",
      "ADD",
      "LHR",
      flightDate,
      [passenger],
      1_000_000_000_000_000n,
    ]);

    // …and decode it with the indexer's own event definition.
    const decoded = decodeEventLog({
      abi:    [FLIGHT_INSURED_EVENT],
      topics,
      data,
    });

    expect(decoded.eventName).toBe("FlightInsured");
    const args = decoded.args as unknown as {
      flightId: string;
      flightNumber: string;
      departure: string;
      arrival: string;
      flightDate: bigint;
      passengers: readonly string[];
    };
    expect(args.flightId).toBe(flightId);
    expect(args.flightNumber).toBe("ET309");
    expect(args.departure).toBe("ADD");
    expect(args.arrival).toBe("LHR");
    expect(args.flightDate).toBe(flightDate);
    expect(args.passengers).toEqual([passenger]);
  });
});
