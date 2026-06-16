/**
 * Chain configuration for AirClaim.
 *
 * Mirrors the networks the backend's `ChainClient` supports: Celo mainnet,
 * Alfajores testnet, and a local hardhat node. We only surface chains that
 * actually have a deployment on record (see `getContractAddresses`).
 */
import { celo, celoAlfajores, hardhat } from "viem/chains";
import type { Chain } from "viem";

/**
 * The viem chains AirClaim supports, in display order.
 *
 * Note: only chains with deployed addresses should be passed to the wagmi
 * config; Alfajores is included here for completeness but has no address book
 * entry yet, so callers that need addresses must guard accordingly.
 *
 * @returns A non-empty tuple of viem `Chain` objects.
 */
export function getSupportedChains(): readonly [Chain, ...Chain[]] {
  return [celo, celoAlfajores, hardhat];
}

/**
 * Resolve the default chain the UI should target.
 *
 * Reads `NEXT_PUBLIC_CHAIN_ID` (inlined at build time) and matches it against
 * the supported chains. Falls back to Celo mainnet when the var is unset, blank,
 * or names an unsupported chain — the UI always has a sane chain to point at.
 *
 * @returns The default viem `Chain`.
 */
export function getDefaultChain(): Chain {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const chainId = raw ? Number(raw) : undefined;
  const match = getSupportedChains().find((chain) => chain.id === chainId);
  return match ?? celo;
}
