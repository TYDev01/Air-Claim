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
  type Transport,
  type Account,
  type Abi,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo, celoAlfajores, hardhat } from "viem/chains";

import type { IChainClient, TxResult, OracleFlightRecord } from "../interfaces/IChainClient.js";
import { OnChainFlightStatus } from "../interfaces/IChainClient.js";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";
import { loadAbis } from "./abis.js";

// ─── Internal state ───────────────────────────────────────────────────────────

interface ChainClientState {
  publicClient:  PublicClient;
  // Concrete account+chain binding so writeContract() doesn't require chain/account
  // to be passed on every call (the wide WalletClient type loses that binding).
  walletClient:  WalletClient<Transport, Chain, Account>;
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

/**
 * Decoded shape of InsuredFlightsAgency.policyInfo()'s PolicyView return struct.
 * Mirrors the Solidity struct field-for-field (see InsuredFlightsAgency.sol).
 * Note there is no `claimed` field — claim state is per-passenger, not per-policy.
 */
interface PolicyView {
  policyId:       bigint;
  flightId:       `0x${string}`;
  flightNumber:   string;
  departure:      string;
  arrival:        string;
  flightDate:     bigint;
  claimable:      boolean;
  exists:         boolean;
  passengerCount: bigint;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the viem Chain object for a given chain ID.
 *
 * Mirrors the networks supported by scripts/config/networkConfig.ts and the
 * deploy script so the backend can be rehearsed on Alfajores / a local fork
 * before mainnet:
 *   42220 — Celo mainnet
 *   44787 — Alfajores testnet
 *   31337 — Hardhat (local node or mainnet fork)
 */
function resolveChain(chainId: number): Chain {
  switch (chainId) {
    case 42220: return celo;
    case 44787: return celoAlfajores;
    case 31337: return hardhat;
    default:
      throw new Error(
        `Unsupported chainId ${chainId}. Supported: 42220 (celo), 44787 ` +
        `(alfajores), 31337 (hardhat). Add it to resolveChain() in ChainClient.ts.`,
      );
  }
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
    }) as PolicyView;

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

  // ── Write methods ─────────────────────────────────────────────────────────

  /**
   * Calls FlightOracle.updateFlight(flightId, status, delayMinutes, source).
   *
   * Routes through _sendWithRetry for nonce management, EIP-1559 fee
   * strategy, stuck-tx detection, and confirmation waiting.
   *
   * In DRY_RUN mode: logs the intended call with all arguments and returns
   * a synthetic TxResult with a zero hash — nothing is broadcast.
   */
  async updateFlight(
    flightId: `0x${string}`,
    status: OnChainFlightStatus,
    delayMinutes: number,
    source: string,
  ): Promise<TxResult> {
    const { config, walletClient, logger } = this.s;
    const label = `updateFlight(${flightId.slice(0, 10)}… status=${status} delay=${delayMinutes})`;

    if (config.DRY_RUN) {
      logger.info(
        { dryRun: true, flightId, status, delayMinutes, source, contract: this.s.flightOracleAddress },
        "DRY RUN — would call FlightOracle.updateFlight",
      );
      return { txHash: "0x0000000000000000000000000000000000000000000000000000000000000000", blockNumber: 0n, gasUsed: 0n };
    }

    return this._sendWithRetry(label, async ({ maxFeePerGas, maxPriorityFeePerGas, nonce }) => {
      const hash = await walletClient.writeContract({
        address:      this.s.flightOracleAddress,
        abi:          this.s.flightOracleAbi,
        functionName: "updateFlight",
        args:         [flightId, status, delayMinutes, source],
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
      });

      logger.debug({ label, hash, nonce, maxFeePerGas: String(maxFeePerGas) }, "updateFlight tx sent");
      return hash;
    });
  }

  /**
   * Calls InsuredFlightsAgency.checkFlightDelay(flightId).
   *
   * Opens the claim window on-chain once a delay has been confirmed by the
   * oracle. Routes through _sendWithRetry for the same nonce/fee/confirmation
   * semantics as updateFlight.
   *
   * The caller (Keeper) must gate on keeper_last_called_at to avoid calling
   * within the contract's own CHECK_COOLDOWN_SECONDS window — this method
   * does not enforce the cooldown itself, it simply submits when asked.
   *
   * In DRY_RUN mode: logs the intended call and returns a synthetic TxResult.
   */
  async checkFlightDelay(flightId: `0x${string}`): Promise<TxResult> {
    const { config, walletClient, logger } = this.s;
    const label = `checkFlightDelay(${flightId.slice(0, 10)}…)`;

    if (config.DRY_RUN) {
      logger.info(
        { dryRun: true, flightId, contract: this.s.ifaAddress },
        "DRY RUN — would call InsuredFlightsAgency.checkFlightDelay",
      );
      return { txHash: "0x0000000000000000000000000000000000000000000000000000000000000000", blockNumber: 0n, gasUsed: 0n };
    }

    return this._sendWithRetry(label, async ({ maxFeePerGas, maxPriorityFeePerGas, nonce }) => {
      const hash = await walletClient.writeContract({
        address:      this.s.ifaAddress,
        abi:          this.s.insuredFlightsAgencyAbi,
        functionName: "checkFlightDelay",
        args:         [flightId],
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
      });

      logger.debug({ label, hash, nonce, maxFeePerGas: String(maxFeePerGas) }, "checkFlightDelay tx sent");
      return hash;
    });
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

  /**
   * Returns the next nonce for the updater wallet, serialized through a
   * promise-chain lock so concurrent callers never receive the same value.
   *
   * Strategy:
   *  - First call: fetch `eth_getTransactionCount` (pending) from the RPC
   *    to seed the local counter. This handles restarts correctly — the RPC
   *    already knows about any pending txs from a previous run.
   *  - Subsequent calls: increment the in-memory counter without an RPC
   *    round-trip. This is safe because all writes go through a single process.
   *  - On any submission error, the caller must call _resetNonce() to re-sync
   *    from the RPC in case of a reorg or replacement.
   *
   * The nonceLock promise chain serializes acquisitions so that two concurrent
   * updateFlight / checkFlightDelay calls always receive distinct nonces.
   */
  async _nextNonce(): Promise<number> {
    let resolveNext!: () => void;
    const prev = this.s.nonceLock;
    this.s.nonceLock = new Promise<void>(res => { resolveNext = res; });

    await prev; // wait for any in-flight acquisition to finish

    try {
      if (this.s.nonce === null) {
        // First acquisition — seed from chain (includes pending txs).
        const onChain = await this.s.publicClient.getTransactionCount({
          address: this.s.updaterAddress,
          blockTag: "pending",
        });
        this.s.nonce = BigInt(onChain);
        this.s.logger.debug({ nonce: onChain }, "Nonce seeded from chain");
      }

      const current = this.s.nonce;
      this.s.nonce  = current + 1n;
      return Number(current);
    } finally {
      resolveNext(); // release the lock for the next waiter
    }
  }

  /**
   * Submit a pre-encoded contract write and wait for on-chain confirmation.
   *
   * Retry loop (up to TX_MAX_ATTEMPTS):
   *  1. Build EIP-1559 fees (fresh on attempt 0; bumped on retries).
   *  2. Acquire the next nonce via _nextNonce().
   *  3. Send the transaction via walletClient.writeContract().
   *  4. Wait up to TX_TIMEOUT_SECONDS for TX_CONFIRMATIONS blocks.
   *     - If confirmed: return TxResult.
   *     - If timeout (stuck): log the old hash, bump fees, resubmit with
   *       the SAME nonce (replacing the pending tx in the mempool).
   *  5. On any non-timeout error: call _resetNonce() and rethrow if
   *     attempts are exhausted.
   *
   * @param label     Human-readable label for logs (e.g. "updateFlight ET309").
   * @param writeFn   Async function that receives { maxFeePerGas, maxPriorityFeePerGas,
   *                  nonce } and calls walletClient.writeContract(), returning the tx hash.
   */
  async _sendWithRetry(
    label: string,
    writeFn: (fees: {
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce: number;
    }) => Promise<Hash>,
  ): Promise<TxResult> {
    const { config, publicClient, logger } = this.s;
    const timeoutMs = config.TX_TIMEOUT_SECONDS * 1_000;

    let prevMaxFeeGwei: bigint | undefined;
    let currentNonce:   number | undefined;
    let lastHash:       Hash   | undefined;

    for (let attempt = 0; attempt < config.TX_MAX_ATTEMPTS; attempt++) {
      const fees = await this._buildEip1559Fees(attempt, prevMaxFeeGwei);
      prevMaxFeeGwei = fees.maxFeePerGas / 1_000_000_000n; // store as gwei for next bump

      // On a stuck-tx retry we reuse the same nonce to replace the pending tx.
      // On a fresh attempt (or after a reset) we acquire a new one.
      if (attempt === 0 || currentNonce === undefined) {
        currentNonce = await this._nextNonce();
      }

      let txHash: Hash;
      try {
        txHash   = await writeFn({ ...fees, nonce: currentNonce });
        lastHash = txHash;
        logger.info({ label, attempt, txHash, nonce: currentNonce }, "TX submitted");
      } catch (err) {
        await this._resetNonce();
        if (attempt >= config.TX_MAX_ATTEMPTS - 1) {
          throw new Error(`${label}: submission failed after ${attempt + 1} attempts`, { cause: err });
        }
        logger.warn({ label, attempt, err }, "TX submission error — retrying");
        continue;
      }

      // Wait for confirmation with a timeout.
      try {
        const receipt = await Promise.race([
          publicClient.waitForTransactionReceipt({
            hash:                txHash,
            confirmations:       config.TX_CONFIRMATIONS,
            pollingInterval:     2_000,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("TX_TIMEOUT")), timeoutMs),
          ),
        ]);

        if (receipt.status === "reverted") {
          await this._resetNonce();
          throw new Error(`${label}: transaction reverted (hash ${txHash})`);
        }

        logger.info(
          { label, txHash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed) },
          "TX confirmed",
        );

        return {
          txHash,
          blockNumber: receipt.blockNumber,
          gasUsed:     receipt.gasUsed,
        };
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === "TX_TIMEOUT";

        if (isTimeout && attempt < config.TX_MAX_ATTEMPTS - 1) {
          logger.warn(
            { label, attempt, txHash, timeoutSeconds: config.TX_TIMEOUT_SECONDS },
            "TX stuck — bumping fee and resubmitting with same nonce",
          );
          // Keep currentNonce: the bumped tx replaces the stuck pending one.
          continue;
        }

        await this._resetNonce();
        throw new Error(
          `${label}: failed after ${attempt + 1} attempts. Last hash: ${lastHash ?? "none"}`,
          { cause: err },
        );
      }
    }

    // Unreachable — loop always throws or returns — but satisfies TypeScript.
    throw new Error(`${label}: exhausted all ${config.TX_MAX_ATTEMPTS} attempts`);
  }

  /**
   * Re-sync the nonce counter from the chain.
   * Must be called after any submission error to guard against gaps caused
   * by a reorg, a dropped tx, or an out-of-band transaction from the same key.
   */
  async _resetNonce(): Promise<void> {
    const onChain = await this.s.publicClient.getTransactionCount({
      address:  this.s.updaterAddress,
      blockTag: "pending",
    });
    this.s.nonce = BigInt(onChain);
    this.s.logger.warn({ nonce: onChain }, "Nonce reset from chain after error");
  }

  /** Exposed for testing — returns internal state reference. @internal */
  _state(): ChainClientState { return this.s; }
}
