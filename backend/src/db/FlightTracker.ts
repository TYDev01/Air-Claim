/**
 * FlightTracker — indexes FlightInsured events from InsuredFlightsAgency
 * and maintains the tracked_flight table.
 *
 * On each sync() call it:
 *  1. Reads the current indexer cursor from the DB.
 *  2. Fetches the next batch of blocks via eth_getLogs.
 *  3. For each FlightInsured event, upserts a TrackedFlight row.
 *  4. Advances the cursor to the last processed block.
 *
 * Restart-safe: the cursor persists across restarts so no block is
 * processed twice and no block is skipped. Small reorgs are handled
 * by re-processing the last INDEX_BATCH_SIZE blocks on restart if the
 * cursor is within the reorg window (caller responsibility).
 */

import { type PublicClient, type Abi, parseAbiItem, decodeEventLog } from "viem";
import type { IFlightRepository, CreateTrackedFlight } from "../interfaces/IFlightRepository.js";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";

// ─── FlightInsured event shape ────────────────────────────────────────────────
// Decoded from the InsuredFlightsAgency ABI — field names must match the
// Solidity event definition exactly.

interface FlightInsuredArgs {
  flightId:             `0x${string}`;
  flightIata:           string;
  origin:               string;
  destination:          string;
  scheduledDeparture:   bigint;  // unix timestamp (seconds)
  insured:              `0x${string}`;
}

// ─── FlightTracker ────────────────────────────────────────────────────────────

export class FlightTracker {
  private readonly publicClient: PublicClient;
  private readonly repo:         IFlightRepository;
  private readonly ifa:          `0x${string}`;
  private readonly ifaAbi:       Abi;
  private readonly config:       AppConfig;
  private readonly logger:       Logger;

  constructor(
    publicClient: PublicClient,
    repo:         IFlightRepository,
    ifaAddress:   `0x${string}`,
    ifaAbi:       Abi,
    config:       AppConfig,
    logger:       Logger,
  ) {
    this.publicClient = publicClient;
    this.repo         = repo;
    this.ifa          = ifaAddress;
    this.ifaAbi       = ifaAbi;
    this.config       = config;
    this.logger       = logger.child({ component: "FlightTracker" });
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Fetch one batch of FlightInsured logs from the chain.
   *
   * Queries eth_getLogs for the InsuredFlightsAgency address between
   * fromBlock and toBlock (inclusive). Block range is capped to
   * INDEX_BATCH_SIZE to respect RPC provider limits.
   *
   * @param fromBlock  First block to include (inclusive).
   * @param toBlock    Last block to include (inclusive); must be >= fromBlock.
   * @returns          Array of decoded FlightInsured event argument objects.
   *                   Empty array when no events exist in the range.
   * @throws           On RPC error — caller (sync) handles retry/backoff.
   */
  async _fetchNewEvents(
    fromBlock: bigint,
    toBlock:   bigint,
  ): Promise<FlightInsuredArgs[]> {
    const log = this.logger.child({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString() });

    log.debug("Fetching FlightInsured events");

    const logs = await this.publicClient.getLogs({
      address:   this.ifa,
      event:     parseAbiItem(
        "event FlightInsured(bytes32 indexed flightId, string flightIata, string origin, string destination, uint256 scheduledDeparture, address indexed insured)",
      ),
      fromBlock,
      toBlock,
    });

    if (logs.length === 0) {
      log.debug("No FlightInsured events in range");
      return [];
    }

    log.info({ count: logs.length }, "FlightInsured events fetched");

    // Decode each log using the ABI. getLogs with a typed event already
    // decodes args — we cast to the expected shape after validating.
    const decoded: FlightInsuredArgs[] = [];
    for (const entry of logs) {
      if (!entry.args) {
        log.warn({ txHash: entry.transactionHash }, "FlightInsured log missing args — skipping");
        continue;
      }
      const args = entry.args as unknown as FlightInsuredArgs;
      if (!args.flightId || !args.flightIata) {
        log.warn({ txHash: entry.transactionHash }, "FlightInsured log missing required fields — skipping");
        continue;
      }
      decoded.push(args);
    }

    return decoded;
  }

  // ── sync (implemented in next commit) ────────────────────────────────────

  async sync(): Promise<void> {
    throw new Error("Not yet implemented — see FlightTracker.sync commit");
  }
}
