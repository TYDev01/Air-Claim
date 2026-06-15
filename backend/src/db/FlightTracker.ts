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
// Decoded from the InsuredFlightsAgency ABI — field names MUST match the
// Solidity event definition exactly (see InsuredFlightsAgency.sol). The on-chain
// field names are the source of truth; this backend maps them to its own domain
// vocabulary in sync():
//   flightNumber → flightIata
//   departure    → originIata
//   arrival      → destIata
//   flightDate   → scheduledDepartureUtc

interface FlightInsuredArgs {
  policyId:     bigint;
  flightId:     `0x${string}`;
  flightNumber: string;
  departure:    string;
  arrival:      string;
  flightDate:   bigint;  // unix timestamp (seconds) of scheduled departure
  passengers:   readonly `0x${string}`[];
  totalPremium: bigint;
}

/**
 * The FlightInsured event signature the indexer matches and decodes. Exported so
 * a test can pin it against the committed InsuredFlightsAgency ABI — if the
 * contract event ever changes without this string being updated, that test
 * fails instead of the indexer silently matching zero logs at runtime.
 */
export const FLIGHT_INSURED_EVENT = parseAbiItem(
  "event FlightInsured(uint256 indexed policyId, bytes32 indexed flightId, string flightNumber, string departure, string arrival, uint64 flightDate, address[] passengers, uint256 totalPremium)",
);

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
      event:     FLIGHT_INSURED_EVENT,
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
      if (!args.flightId || !args.flightNumber) {
        log.warn({ txHash: entry.transactionHash }, "FlightInsured log missing required fields — skipping");
        continue;
      }
      decoded.push(args);
    }

    return decoded;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Index all new FlightInsured events since the last processed block.
   *
   * Called by the Scheduler on each indexer tick (typically every 60 s).
   * Processes blocks in INDEX_BATCH_SIZE chunks so a single call never
   * requests more logs than the RPC provider allows in one eth_getLogs call.
   *
   * Cursor is advanced per-batch (not once at the end) so a crash mid-run
   * resumes from the last completed batch rather than re-processing everything.
   *
   * For each FlightInsured event:
   *  - Upserts a TrackedFlight row via repo.upsertTrackedFlight()
   *  - Sets keeperEligibleAfter = scheduledDeparture + estimated flight
   *    duration (config.KEEPER_BUFFER_SECONDS used as a conservative estimate
   *    when actual arrival time is unavailable from the event)
   *
   * @returns Number of new FlightInsured events processed in this call.
   */
  async sync(): Promise<number> {
    const latestBlock = await this.publicClient.getBlockNumber();
    const cursorRaw   = await this.repo.getIndexerCursor();

    // On first run fall back to INDEX_FROM_BLOCK (contract deployment block).
    const fromBlock = cursorRaw !== null
      ? cursorRaw + 1n
      : this.config.INDEX_FROM_BLOCK;

    if (fromBlock > latestBlock) {
      this.logger.debug(
        { fromBlock: fromBlock.toString(), latestBlock: latestBlock.toString() },
        "Indexer already at chain tip — nothing to sync",
      );
      return 0;
    }

    const batchSize   = BigInt(this.config.INDEX_BATCH_SIZE);
    let   processed   = 0;
    let   batchStart  = fromBlock;

    while (batchStart <= latestBlock) {
      const batchEnd = batchStart + batchSize - 1n < latestBlock
        ? batchStart + batchSize - 1n
        : latestBlock;

      let events: FlightInsuredArgs[];
      try {
        events = await this._fetchNewEvents(batchStart, batchEnd);
      } catch (err) {
        this.logger.error(
          { err, batchStart: batchStart.toString(), batchEnd: batchEnd.toString() },
          "Failed to fetch events — stopping sync at this batch; will retry next tick",
        );
        break; // Advance cursor only for completed batches; retry next tick.
      }

      for (const args of events) {
        try {
          // On-chain field names → backend domain vocabulary:
          //   flightDate (uint64 unix seconds) → scheduledDepartureUtc
          const scheduledDepartureUtc = new Date(Number(args.flightDate) * 1_000);

          // keeperEligibleAfter: departure + KEEPER_BUFFER_SECONDS as a
          // conservative stand-in when no arrival time is known from the event.
          const keeperEligibleAfter = new Date(
            scheduledDepartureUtc.getTime() + this.config.KEEPER_BUFFER_SECONDS * 1_000,
          );

          const data: CreateTrackedFlight = {
            flightId:             args.flightId,
            flightIata:           args.flightNumber.toUpperCase(), // flightNumber → flightIata
            flightDate:           scheduledDepartureUtc.toISOString().slice(0, 10),
            originIata:           (args.departure ?? "").toUpperCase(), // departure → origin
            destIata:             (args.arrival ?? "").toUpperCase(),   // arrival → destination
            scheduledDepartureUtc,
            scheduledArrivalUtc:  null, // not available in the event; updated by oracle later
            keeperEligibleAfter,
          };

          await this.repo.upsertTrackedFlight(data);
          processed++;
        } catch (err) {
          // A single bad event must not stop the batch — log and continue.
          this.logger.error(
            { err, flightId: args.flightId, flightNumber: args.flightNumber },
            "Failed to upsert tracked flight — skipping event",
          );
        }
      }

      // Advance cursor after each completed batch for crash-safe resumption.
      await this.repo.setIndexerCursor(batchEnd);

      this.logger.debug(
        { batchStart: batchStart.toString(), batchEnd: batchEnd.toString(), events: events.length },
        "Indexer batch complete",
      );

      batchStart = batchEnd + 1n;
    }

    if (processed > 0) {
      this.logger.info({ processed }, "FlightTracker sync complete — new flights tracked");
    }

    return processed;
  }
}
