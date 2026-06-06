/**
 * Typed viem wrapper implementing IChainClient.
 *
 * Responsibilities:
 *  - Owns the viem PublicClient (reads) and WalletClient (writes)
 *  - Manages the updater nonce sequentially to prevent gaps/collisions
 *  - Builds EIP-1559 fees with a configured ceiling and bump-on-stuck logic
 *  - Waits for TX_CONFIRMATIONS before resolving write calls
 *  - Verifies chain ID + UPDATER_ROLE at construction time
 *
 * ABIs are loaded from backend/abis/ via loadAbis() — never hand-written.
 * Addresses come from validated AppConfig — never from literals.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseGwei,
  formatGwei,
  keccak256,
  toBytes,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Abi,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";

import type { IChainClient, TxResult, OracleFlightRecord } from "../interfaces/IChainClient.js";
import { OnChainFlightStatus } from "../interfaces/IChainClient.js";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";
import { loadAbis } from "./abis.js";

// ─── Internal state ───────────────────────────────────────────────────────────

interface ChainClientState {
  publicClient:  PublicClient;
  walletClient:  WalletClient;
  updaterAddress: Address;
  flightOracleAbi: Abi;
  insuredFlightsAgencyAbi: Abi;
  flightOracleAddress: Address;
  ifaAddress: Address;
  config: AppConfig;
  logger: Logger;
  /** Monotonically increasing nonce; null until first fetch from chain. */
  nonce: bigint | null;
  /** Serialize nonce acquisition so concurrent writes don't race. */
  nonceLock: Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the viem Chain object for a given chain ID. */
function resolveChain(chainId: number): Chain {
  if (chainId === 42220) return celo;
  // For Alfajores or other networks, build a minimal chain descriptor.
  // Add entries here as new networks are supported.
  throw new Error(
    `Unsupported chainId ${chainId}. Add it to resolveChain() in ChainClient.ts.`,
  );
}

// ─── ChainClient ──────────────────────────────────────────────────────────────

export class ChainClient implements IChainClient {
  private readonly s: ChainClientState;

  /**
   * Private — use ChainClient.create() which runs async boot checks.
   */
  private constructor(state: ChainClientState) {
    this.s = state;
  }

  /**
   * Construct and boot-check a ChainClient.
   *
   * Boot checks (both abort startup on failure):
   *  1. Live chain ID must match config.CHAIN_ID.
   *  2. Configured updater address must hold UPDATER_ROLE on FlightOracle.
   *
   * @throws if either check fails — the process must not start in this state.
   */
  static async create(config: AppConfig, logger: Logger): Promise<ChainClient> {
    const chain   = resolveChain(config.CHAIN_ID);
    const account = privateKeyToAccount(config.UPDATER_PRIVATE_KEY as `0x${string}`);

    const publicClient = createPublicClient({
      chain,
      transport: http(config.CELO_RPC_URL),
    });

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.CELO_RPC_URL),
    });

    const { flightOracleAbi, insuredFlightsAgencyAbi } = loadAbis();

    const state: ChainClientState = {
      publicClient,
      walletClient,
      updaterAddress: account.address,
      flightOracleAbi,
      insuredFlightsAgencyAbi,
      flightOracleAddress: config.FLIGHT_ORACLE_ADDRESS as Address,
      ifaAddress:          config.INSURED_FLIGHTS_AGENCY_ADDRESS as Address,
      config,
      logger: logger.child({ component: "ChainClient" }),
      nonce:     null,
      nonceLock: Promise.resolve(),
    };

    const client = new ChainClient(state);

    // ── Boot check 1: chain ID ───────────────────────────────────────────────
    const liveChainId = await publicClient.getChainId();
    if (liveChainId !== config.CHAIN_ID) {
      throw new Error(
        `Chain ID mismatch: config says ${config.CHAIN_ID} but RPC reports ${liveChainId}. ` +
        `Check CELO_RPC_URL and CHAIN_ID in .env.`,
      );
    }
    logger.info({ chainId: liveChainId }, "Chain ID verified");

    // ── Boot check 2: updater role ───────────────────────────────────────────
    const hasRole = await client.hasUpdaterRole(account.address);
    if (!hasRole) {
      throw new Error(
        `Updater address ${account.address} does not hold UPDATER_ROLE on ` +
        `FlightOracle (${config.FLIGHT_ORACLE_ADDRESS}). ` +
        `Grant the role before starting the service.`,
      );
    }
    logger.info({ updater: account.address }, "UPDATER_ROLE verified");

    return client;
  }

  // ── Read methods ──────────────────────────────────────────────────────────

  /**
   * Returns true if `address` holds UPDATER_ROLE on FlightOracle.
   *
   * UPDATER_ROLE = keccak256("UPDATER_ROLE") — computed locally to avoid
   * an extra RPC call; the value is a constant in the contract.
   */
  async hasUpdaterRole(address: Address): Promise<boolean> {
    const UPDATER_ROLE = keccak256(toBytes("UPDATER_ROLE"));

    const hasRole = await this.s.publicClient.readContract({
      address: this.s.flightOracleAddress,
      abi:     this.s.flightOracleAbi,
      functionName: "hasRole",
      args: [UPDATER_ROLE, address],
    });

    return hasRole as boolean;
  }

  /**
   * Reads the current FlightRecord from FlightOracle for `flightId`.
   *
   * FlightOracle.getFlightRecord returns a struct:
   *   { status: uint8, delayMinutes: uint32, source: string, updatedAt: uint64 }
   *
   * Returns null when the oracle has no record yet (updatedAt == 0 indicates
   * the slot was never written — the contract initialises storage to zero).
   */
  async getOracleFlightRecord(flightId: `0x${string}`): Promise<OracleFlightRecord | null> {
    const raw = await this.s.publicClient.readContract({
      address:      this.s.flightOracleAddress,
      abi:          this.s.flightOracleAbi,
      functionName: "getFlightRecord",
      args:         [flightId],
    }) as { status: number; delayMinutes: number; source: string; updatedAt: bigint };

    // updatedAt == 0n means the mapping slot is uninitialised — no record exists.
    if (raw.updatedAt === 0n) return null;

    return {
      status:        raw.status as OnChainFlightStatus,
      delayMinutes:  Number(raw.delayMinutes),
      source:        raw.source,
      updatedAt:     Number(raw.updatedAt),
    };
  }

  /**
   * Returns true if the IFA policy for `flightId` is already claimable.
   *
   * Calls InsuredFlightsAgency.policyInfo(flightId) which returns a
   * PolicyView struct. We only need the `claimable` boolean field —
   * if true the keeper can skip this flight (claim window already open).
   *
   * Returns false both when the policy is not yet claimable AND when no
   * policy exists for the flight (flightId unknown to IFA). The keeper
   * guards against the latter via the tracked_flight table.
   */
  async isPolicyClaimable(flightId: `0x${string}`): Promise<boolean> {
    const raw = await this.s.publicClient.readContract({
      address:      this.s.ifaAddress,
      abi:          this.s.insuredFlightsAgencyAbi,
      functionName: "policyInfo",
      args:         [flightId],
    }) as { claimable: boolean; claimed: boolean };

    return raw.claimable;
  }

  /**
   * Returns the updater wallet's current native CELO balance in wei.
   *
   * Called by the health/metrics layer and the alerting subsystem to detect
   * when the wallet is running low on gas. The threshold is configured via
   * MIN_UPDATER_BALANCE_WEI in AppConfig.
   */
  async getUpdaterBalance(): Promise<bigint> {
    return this.s.publicClient.getBalance({
      address: this.s.updaterAddress,
    });
  }

  // ── Write methods (implemented in subsequent commits) ─────────────────────

  async updateFlight(
    _flightId: `0x${string}`,
    _status: OnChainFlightStatus,
    _delayMinutes: number,
    _source: string,
  ): Promise<TxResult> {
    throw new Error("Not yet implemented — see updateFlight commit");
  }

  async checkFlightDelay(_flightId: `0x${string}`): Promise<TxResult> {
    throw new Error("Not yet implemented — see checkFlightDelay commit");
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Build EIP-1559 fee parameters for a transaction attempt.
   *
   * On attempt 0: query the fee history oracle for current base fee + tip.
   * On attempt N > 0: bump the previous maxFeePerGas by TX_FEE_BUMP_PERCENT
   *   to replace a stuck pending transaction (EIP-1559 requires ≥ 10 % bump).
   *
   * The result is always capped at TX_MAX_FEE_GWEI to prevent runaway fees
   * from an abnormal fee oracle response.
   *
   * @param attempt          Zero-based retry count for this outbox entry.
   * @param prevMaxFeeGwei   maxFeePerGas (in gwei) from the previous attempt,
   *                         or undefined on the first attempt.
   * @returns                { maxFeePerGas, maxPriorityFeePerGas } in wei.
   */
  async _buildEip1559Fees(
    attempt: number,
    prevMaxFeeGwei?: bigint,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const { config, publicClient, logger } = this.s;

    const ceilingWei = parseGwei(String(config.TX_MAX_FEE_GWEI));

    if (attempt > 0 && prevMaxFeeGwei !== undefined) {
      // Bump the previous fee by TX_FEE_BUMP_PERCENT to replace the stuck tx.
      const bumpFactor  = BigInt(100 + config.TX_FEE_BUMP_PERCENT);
      const bumpedWei   = (prevMaxFeeGwei * bumpFactor) / 100n;
      const maxFeePerGas = bumpedWei > ceilingWei ? ceilingWei : bumpedWei;

      if (bumpedWei > ceilingWei) {
        logger.warn(
          { bumpedGwei: formatGwei(bumpedWei), ceilingGwei: config.TX_MAX_FEE_GWEI },
          "Bumped fee exceeds ceiling — clamping to TX_MAX_FEE_GWEI",
        );
      }

      // Keep the priority fee proportional; cap at maxFeePerGas.
      const maxPriorityFeePerGas = maxFeePerGas / 10n;

      logger.debug(
        { attempt, maxFeeGwei: formatGwei(maxFeePerGas) },
        "Built bumped EIP-1559 fees",
      );

      return { maxFeePerGas, maxPriorityFeePerGas };
    }

    // First attempt: derive from the fee history oracle.
    const feeHistory = await publicClient.getFeeHistory({
      blockCount:       4,
      rewardPercentiles: [50],
    });

    // baseFeePerGas of the next block (last entry in the array).
    const baseFees    = feeHistory.baseFeePerGas ?? [];
    const latestBase  = baseFees[baseFees.length - 1] ?? 0n;

    // 50th-percentile miner tip from recent blocks.
    const rewards     = feeHistory.reward ?? [];
    const tips        = rewards.map(r => r[0] ?? 0n);
    const medianTip   = tips.length > 0
      ? tips.reduce((a, b) => a + b, 0n) / BigInt(tips.length)
      : parseGwei("1"); // 1 gwei floor

    // maxFeePerGas = 2× baseFee + tip (standard heuristic for EIP-1559).
    const rawMax        = latestBase * 2n + medianTip;
    const maxFeePerGas  = rawMax > ceilingWei ? ceilingWei : rawMax;
    const maxPriorityFeePerGas = medianTip > maxFeePerGas ? maxFeePerGas : medianTip;

    logger.debug(
      { attempt, baseFeeGwei: formatGwei(latestBase), maxFeeGwei: formatGwei(maxFeePerGas) },
      "Built EIP-1559 fees from fee history",
    );

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  /** Exposed for testing — returns internal state reference. @internal */
  _state(): ChainClientState { return this.s; }
}
