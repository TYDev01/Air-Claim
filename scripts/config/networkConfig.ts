import { ethers } from "ethers";

/**
 * Per-network deployment configuration.
 *
 * ALL external addresses are listed here with their source and celoscan
 * verification status. Nothing is hardcoded as a literal in contract source.
 *
 * Before broadcasting any mainnet transaction, re-confirm every address below
 * against its authoritative source and report to the project owner for sign-off.
 */

export interface NetworkConfig {
  // ── Chainlink ─────────────────────────────────────────────────────────────
  /**
   * Chainlink CELO/USD AggregatorV3Interface proxy.
   * Source : https://docs.chain.link/data-feeds/price-feeds/addresses?network=celo
   * Confirm: celoscan.io before EVERY mainnet deploy — proxy upgrades happen.
   */
  celoUsdFeed: string;

  /**
   * Max age (seconds) of a price-feed round before it is treated as stale.
   * Set to feed heartbeat + a small buffer.
   * Celo mainnet CELO/USD heartbeat: 3600 s (1 h).
   */
  feedMaxStaleness: number;

  // ── Stablecoins ───────────────────────────────────────────────────────────
  /**
   * Default stablecoin for insurance payouts (Mento cUSD or USDC).
   * Source: https://docs.celo.org/token-addresses
   * Confirm on celoscan before deploy.
   */
  stablecoin: string;

  // ── Game parameters ───────────────────────────────────────────────────────
  /** Maximum native CELO stake (wei) per LuckySpin bet. */
  luckySpinStakeCap: bigint;

  /** Maximum native CELO stake (wei) per BattleShip bet. */
  battleShipStakeCap: bigint;

  // ── Insurance parameters ──────────────────────────────────────────────────
  /** Delay threshold in minutes before a flight is claimable. */
  delayThresholdMinutes: number;

  /** Flat premium fee in CELO wei added per passenger on top of 10% of ticket. */
  baseFee: bigint;

  /** Minimum seconds between checkFlightDelay calls for the same flight. */
  checkCooldownSeconds: number;

  // ── Roles ─────────────────────────────────────────────────────────────────
  /**
   * Address that receives UPDATER_ROLE on FlightOracle at deploy time.
   * Typically the off-chain relay hot wallet.
   * Override via UPDATER_ADDRESS env var; defaults to deployer.
   */
  updaterAddress?: string;

  /**
   * Address that receives operator status on CommitRevealRandomness at deploy.
   * Typically the game-backend hot wallet.
   * Override via OPERATOR_ADDRESS env var; defaults to deployer.
   */
  operatorAddress?: string;
}

// ─── Celo mainnet (chainId 42220) ─────────────────────────────────────────────
const celoMainnet: NetworkConfig = {
  // Chainlink CELO/USD feed
  // Source : https://docs.chain.link/data-feeds/price-feeds/addresses?network=celo
  // Verified on celoscan: https://celoscan.io/address/0x0568fd19986748ceff3301e55c0eb1e729e0ab7e
  // Confirmed live via fork test (June 2026): answer ~$0.062, decimals=8, fresh round.
  // ⚠️  Re-confirm this address on celoscan before every mainnet deploy.
  celoUsdFeed: ethers.getAddress("0x0568fd19986748ceff3301e55c0eb1e729e0ab7e"),

  feedMaxStaleness: 3_600 + 300, // 1-hour heartbeat + 5-minute buffer

  // Mento cUSD on Celo mainnet
  // Source : https://docs.celo.org/token-addresses
  // Verified: https://celoscan.io/token/0x765de816845861e75a25fca122bb6898b8b1282a
  // ⚠️  Re-confirm before mainnet deploy.
  stablecoin: ethers.getAddress("0x765de816845861e75a25fca122bb6898b8b1282a"),

  luckySpinStakeCap:   ethers.parseEther("10"),  // 10 CELO max stake per spin
  battleShipStakeCap:  ethers.parseEther("10"),  // 10 CELO max stake per battle

  delayThresholdMinutes: 30,
  baseFee:               ethers.parseEther("0.001"), // ~$0.0001 at current price
  checkCooldownSeconds:  300,  // 5 minutes between delay checks
};

// ─── Alfajores testnet (chainId 44787) ────────────────────────────────────────
const alfajores: NetworkConfig = {
  // ⚠️  Chainlink does NOT publish a CELO/USD feed on Alfajores as of June 2026.
  // The zero address is a deliberate sentinel — the deploy script will detect
  // it and deploy a PriceFeedDouble (test double) so the Alfajores rehearsal
  // can exercise the full deployment flow without a real feed.
  // DO NOT use the zero address or a PriceFeedDouble on mainnet.
  celoUsdFeed: ethers.ZeroAddress,

  feedMaxStaleness: 86_400, // 24 h — generous for testnet

  // cUSD on Alfajores
  // Source: https://docs.celo.org/token-addresses
  // Verified: https://alfajores.celoscan.io/token/0x874069fa1eb16d44d622f2e0ca25eea172369bc1
  stablecoin: ethers.getAddress("0x874069fa1eb16d44d622f2e0ca25eea172369bc1"),

  luckySpinStakeCap:   ethers.parseEther("1"),   // lower cap on testnet
  battleShipStakeCap:  ethers.parseEther("1"),

  delayThresholdMinutes: 30,
  baseFee:               ethers.parseEther("0.001"),
  checkCooldownSeconds:  60, // shorter cooldown for testnet testing
};

// ─── Hardhat local (chainId 31337) ────────────────────────────────────────────
// Used by `npx hardhat run scripts/deploy.ts` without a network flag.
// Feed address is zero — deploy script deploys a PriceFeedDouble locally.
const hardhatLocal: NetworkConfig = {
  celoUsdFeed:           ethers.ZeroAddress,
  feedMaxStaleness:      86_400,
  stablecoin:            ethers.ZeroAddress, // deploy script deploys a StablecoinDouble
  luckySpinStakeCap:     ethers.parseEther("10"),
  battleShipStakeCap:    ethers.parseEther("10"),
  delayThresholdMinutes: 30,
  baseFee:               ethers.parseEther("0.001"),
  checkCooldownSeconds:  300,
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  celo:      celoMainnet,
  alfajores: alfajores,
  hardhat:   hardhatLocal,
  localhost: hardhatLocal,
};

/**
 * Returns the NetworkConfig for the active Hardhat network.
 * Throws if the network is not registered.
 */
export function getNetworkConfig(networkName: string): NetworkConfig {
  const cfg = NETWORK_CONFIGS[networkName];
  if (!cfg) {
    throw new Error(
      `No NetworkConfig registered for network "${networkName}". ` +
      `Add it to scripts/config/networkConfig.ts before deploying.`
    );
  }
  return cfg;
}
