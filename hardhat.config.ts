import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";
import * as glob from "glob";

dotenv.config();

// Include test/doubles/*.sol in compilation so TypeChain generates types for
// test doubles. These files NEVER appear in contracts/ or deploy scripts.
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(
  async (_args, _hre, runSuper): Promise<string[]> => {
    const existing: string[] = await runSuper();
    const doublesPattern = path.join(__dirname, "test", "doubles", "**", "*.sol");
    const doubles: string[] = glob.sync(doublesPattern);
    return [...existing, ...doubles];
  }
);

// Fall back to Hardhat account #0 dev key so network config initialises for
// dry-runs and gas estimates even without a real PRIVATE_KEY in .env.
// This key controls no real funds — it is the public Hardhat test account.
const PRIVATE_KEY =
  process.env.PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
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
