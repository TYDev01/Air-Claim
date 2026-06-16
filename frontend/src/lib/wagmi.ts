/**
 * wagmi configuration for AirClaim.
 *
 * Builds a wagmi `Config` over the chains AirClaim supports, with an HTTP
 * transport per chain and an injected (browser-wallet) connector. A richer
 * connector set (WalletConnect / Coinbase) can be layered on later; the
 * injected connector covers MetaMask, Valora-in-browser, and the like.
 */
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Config } from "wagmi";

import { getSupportedChains } from "./chains";

/**
 * Create the AirClaim wagmi config.
 *
 * Constructed lazily (via a factory rather than a module-level singleton) so it
 * can be instantiated once inside the client-side Providers tree, keeping it out
 * of any server bundle.
 *
 * @returns A wagmi `Config` covering AirClaim's supported chains.
 */
export function createWagmiConfig(): Config {
  const chains = getSupportedChains();
  const transports = Object.fromEntries(
    chains.map((chain) => [chain.id, http()]),
  );

  return createConfig({
    chains,
    connectors: [injected()],
    transports,
    ssr: true,
  });
}
