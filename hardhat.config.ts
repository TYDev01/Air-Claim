import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "0x" + "0".repeat(64);
const CELOSCAN_API_KEY = process.env.CELOSCAN_API_KEY ?? "";
const CELO_RPC = process.env.CELO_RPC ?? "https://forno.celo.org";
const ALFAJORES_RPC = process.env.ALFAJORES_RPC ?? "https://alfajores-forno.celo-testnet.org";

// Fork mode is enabled via FORK=true env var (used for integration tests against mainnet)
const FORK_ENABLED = process.env.FORK === "true";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: FORK_ENABLED ? 42220 : 31337,
      forking: FORK_ENABLED
        ? {
            url: CELO_RPC,
            // Pin to a recent block for deterministic integration tests.
            // Update this block number before running fork tests if you want fresher state.
            blockNumber: undefined,
          }
        : undefined,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    alfajores: {
      url: ALFAJORES_RPC,
      chainId: 44787,
      accounts: [PRIVATE_KEY],
    },
    celo: {
      url: CELO_RPC,
      chainId: 42220,
      accounts: [PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: {
      celo: CELOSCAN_API_KEY,
      alfajores: CELOSCAN_API_KEY,
    },
    customChains: [
      {
        network: "celo",
        chainId: 42220,
        urls: {
          apiURL: "https://api.celoscan.io/api",
          browserURL: "https://celoscan.io",
        },
      },
      {
        network: "alfajores",
        chainId: 44787,
        urls: {
          apiURL: "https://api-alfajores.celoscan.io/api",
          browserURL: "https://alfajores.celoscan.io",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
