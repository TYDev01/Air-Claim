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
