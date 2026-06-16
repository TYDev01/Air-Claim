/**
 * Contract address resolution for AirClaim.
 *
 * Addresses mirror the committed `deployments/<network>.json` files at the repo
 * root — the on-chain source of truth. Do NOT hardcode addresses in components;
 * resolve them through {@link getContractAddresses} so a single edit here (kept
 * in sync with `deployments/`) propagates everywhere.
 */

/** EVM address as a 0x-prefixed hex string. */
export type Address = `0x${string}`;

/** The set of contract addresses AirClaim's UI needs for a given chain. */
export interface ContractAddresses {
  /** InsuredFlightsAgency — insure/claim/policy reads. */
  insuredFlightsAgency: Address;
  /** FlightOracle — delay confirmations. */
  flightOracle: Address;
  /** cUSD stablecoin used for payouts when the price feed is healthy. */
  stablecoin: Address;
  /** Chainlink-style CELO/USD price feed. */
  celoUsdFeed: Address;
}

/** Supported chain ids. Matches the backend's `ChainClient`. */
export const CHAIN_IDS = {
  celo: 42220,
  alfajores: 44787,
  hardhat: 31337,
} as const;

/**
 * Per-chain address book, mirrored from `deployments/<network>.json`.
 * Alfajores is intentionally absent until that network is deployed.
 */
const ADDRESS_BOOK: Record<number, ContractAddresses> = {
  // deployments/celo.json
  [CHAIN_IDS.celo]: {
    insuredFlightsAgency: "0x2578740ad058Af75dd2681B0979C9731e2755F27",
    flightOracle: "0x12aeCeB975C01BB3C062c90CF46Df7Ee1CA6BB0a",
    stablecoin: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
    celoUsdFeed: "0x0568fD19986748cEfF3301e55c0eb1E729E0Ab7e",
  },
  // deployments/hardhat.json
  [CHAIN_IDS.hardhat]: {
    insuredFlightsAgency: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    flightOracle: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    stablecoin: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    celoUsdFeed: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  },
};

/**
 * Resolve the AirClaim contract addresses for a chain id.
 *
 * @param chainId  EVM chain id (e.g. 42220 for Celo mainnet).
 * @returns        The contract address set for that chain.
 * @throws         If the chain id has no deployed addresses on record.
 */
export function getContractAddresses(chainId: number): ContractAddresses {
  const addresses = ADDRESS_BOOK[chainId];
  if (!addresses) {
    const known = Object.keys(ADDRESS_BOOK).join(", ");
    throw new Error(
      `No AirClaim deployment for chainId ${chainId}. Known chains: ${known}.`,
    );
  }
  return addresses;
}
