/**
 * AirClaim deployment script.
 *
 * Deploys all contracts in dependency order and writes a JSON address file
 * to deployments/<network>.json.
 *
 * Usage
 * ─────
 *   # Local hardhat node (deploys test doubles for feed + stablecoin)
 *   npx hardhat run scripts/deploy.ts
 *
 *   # Alfajores testnet (rehearsal — deploys PriceFeedDouble, no real feed)
 *   npx hardhat run scripts/deploy.ts --network alfajores
 *
 *   # Celo mainnet dry-run (prints addresses + gas estimates, no broadcast)
 *   npx hardhat run scripts/deploy.ts --network celo
 *   (requires MAINNET_DEPLOY_CONFIRMED=true in .env to actually broadcast)
 *
 * Environment variables (all in .env, never committed)
 * ────────────────────────────────────────────────────
 *   PRIVATE_KEY               Deployer account private key
 *   UPDATER_ADDRESS           Address for FlightOracle UPDATER_ROLE (default: deployer)
 *   OPERATOR_ADDRESS          Address for CommitRevealRandomness operator (default: deployer)
 *   MAINNET_DEPLOY_CONFIRMED  Must be "true" to broadcast on celo mainnet
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getNetworkConfig } from "./config/networkConfig";

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`\n[deploy] ${msg}`); }
function sep()            { console.log("─".repeat(60)); }

interface DeployResult {
  /** Deployed contract address (ethers.ZeroAddress on dry-run). */
  address: string;
  /** Block the deployment tx was mined in, or null on dry-run / unavailable. */
  blockNumber: number | null;
}

async function deployContract(
  name: string,
  args: unknown[],
  dryRun: boolean,
): Promise<DeployResult> {
  const factory = await ethers.getContractFactory(name);

  if (dryRun) {
    // Estimate deployment gas without broadcasting.
    // Swap any ZeroAddress or placeholder args with ethers.ZeroAddress so
    // the ABI encoder doesn't error on non-address strings.
    const safeArgs = args.map(a =>
      typeof a === "string" && !ethers.isAddress(a) ? ethers.ZeroAddress : a
    );
    try {
      const deployTx = await factory.getDeployTransaction(...safeArgs);
      const gasEst   = await ethers.provider.estimateGas(deployTx);
      console.log(`  ${name.padEnd(30)} gas estimate: ${gasEst.toLocaleString()}`);
    } catch {
      console.log(`  ${name.padEnd(30)} gas estimate: (unavailable on dry-run with unresolved deps)`);
    }
    // Return ZeroAddress as a stand-in so downstream contracts can still estimate.
    return { address: ethers.ZeroAddress, blockNumber: null };
  }

  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const tx   = contract.deploymentTransaction()!;
  const rec  = await tx.wait();
  console.log(`  ${name.padEnd(30)} → ${addr}  (gas used: ${rec!.gasUsed.toLocaleString()}, block: ${rec!.blockNumber})`);
  return { address: addr, blockNumber: rec!.blockNumber };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const networkName = network.name;
  const cfg         = getNetworkConfig(networkName);
  const [deployer]  = await ethers.getSigners();

  const updaterAddress  = process.env.UPDATER_ADDRESS  || deployer.address;
  const operatorAddress = process.env.OPERATOR_ADDRESS || deployer.address;

  // ── mainnet guard ──────────────────────────────────────────────────────────
  const isMainnet = networkName === "celo";
  const dryRun    = isMainnet && process.env.MAINNET_DEPLOY_CONFIRMED !== "true";

  sep();
  if (isMainnet) {
    console.log("  ⚠️   CELO MAINNET DEPLOY");
    if (dryRun) {
      console.log("  Mode: DRY RUN (set MAINNET_DEPLOY_CONFIRMED=true to broadcast)");
    } else {
      console.log("  Mode: LIVE BROADCAST — transactions will be signed and sent");
    }
  } else {
    console.log(`  Network : ${networkName}`);
    console.log("  Mode    : live broadcast");
  }
  sep();

  console.log(`  Deployer  : ${deployer.address}`);
  console.log(`  Updater   : ${updaterAddress}`);
  console.log(`  Operator  : ${operatorAddress}`);
  console.log(`  Feed addr : ${cfg.celoUsdFeed}`);
  console.log(`  Stablecoin: ${cfg.stablecoin}`);

  // ── resolve test doubles for non-mainnet networks ─────────────────────────
  let feedAddress       = cfg.celoUsdFeed;
  let stablecoinAddress = cfg.stablecoin;
  let testDoubleNote    = "";

  if (feedAddress === ethers.ZeroAddress) {
    if (isMainnet) {
      throw new Error(
        "celoUsdFeed is ZeroAddress for mainnet — this must never happen. " +
        "Verify the Chainlink feed address in networkConfig.ts before deploying."
      );
    }
    log("No Chainlink feed configured — deploying PriceFeedDouble (TEST ONLY)");
    // $0.50 with 8 decimals — placeholder for testnet/local
    feedAddress = (await deployContract("PriceFeedDouble", [50_000_000n, 8], dryRun)).address;
    testDoubleNote += "\n  ⚠️  PriceFeedDouble used — NOT suitable for mainnet.";
  }

  if (stablecoinAddress === ethers.ZeroAddress) {
    if (isMainnet) {
      throw new Error(
        "stablecoin is ZeroAddress for mainnet — verify the stablecoin address " +
        "in networkConfig.ts before deploying."
      );
    }
    log("No stablecoin configured — deploying StablecoinDouble (TEST ONLY)");
    stablecoinAddress = (await deployContract("StablecoinDouble", ["cUSD", "cUSD", 18], dryRun)).address;
    testDoubleNote += "\n  ⚠️  StablecoinDouble used — NOT suitable for mainnet.";
  }

  // ── 1. FlightOracle ───────────────────────────────────────────────────────
  log("1 / 5  FlightOracle");
  const oracleAddress = (await deployContract("FlightOracle", [deployer.address], dryRun)).address;

  // Grant UPDATER_ROLE to the designated updater (may differ from deployer).
  if (!dryRun && updaterAddress !== deployer.address) {
    const oracle = await ethers.getContractAt("FlightOracle", oracleAddress);
    const UPDATER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
    const tx = await oracle.grantRole(UPDATER_ROLE, updaterAddress);
    await tx.wait();
    console.log(`  UPDATER_ROLE granted to ${updaterAddress}`);
  }

  // ── 2. CommitRevealRandomness ──────────────────────────────────────────────
  log("2 / 5  CommitRevealRandomness");
  const randomnessAddress = (await deployContract(
    "CommitRevealRandomness",
    [operatorAddress],
    dryRun,
  )).address;

  // ── 3. InsuredFlightsAgency ────────────────────────────────────────────────
  log("3 / 5  InsuredFlightsAgency");
  const ifaDeploy = await deployContract(
    "InsuredFlightsAgency",
    [
      oracleAddress,
      feedAddress,
      stablecoinAddress,
      cfg.delayThresholdMinutes,
      cfg.baseFee,
      cfg.feedMaxStaleness,
      cfg.checkCooldownSeconds,
    ],
    dryRun,
  );
  const ifaAddress = ifaDeploy.address;
  // Captured so the backend indexer can start from the IFA deployment block
  // (wired into the backend .env as INDEX_FROM_BLOCK) instead of genesis.
  const ifaDeployBlock = ifaDeploy.blockNumber;

  // ── 4. LuckySpin ──────────────────────────────────────────────────────────
  log("4 / 5  LuckySpin");
  const luckySpinAddress = (await deployContract(
    "LuckySpin",
    [randomnessAddress, cfg.luckySpinStakeCap],
    dryRun,
  )).address;

  // ── 5. BattleShip ─────────────────────────────────────────────────────────
  log("5 / 5  BattleShip");
  const battleShipAddress = (await deployContract(
    "BattleShip",
    [randomnessAddress, cfg.battleShipStakeCap],
    dryRun,
  )).address;

  // ── summary ───────────────────────────────────────────────────────────────
  sep();
  console.log("\n  Deployment summary\n");
  const summary: Record<string, string> = {
    network:               networkName,
    deployer:              deployer.address,
    flightOracle:          oracleAddress,
    commitRevealRandomness: randomnessAddress,
    insuredFlightsAgency:  ifaAddress,
    // Deployment block of InsuredFlightsAgency — copy into the backend .env as
    // INDEX_FROM_BLOCK so the FlightInsured indexer backfills from here, not genesis.
    insuredFlightsAgencyBlock: ifaDeployBlock !== null ? String(ifaDeployBlock) : "",
    luckySpin:             luckySpinAddress,
    battleShip:            battleShipAddress,
    celoUsdFeed:           feedAddress,
    stablecoin:            stablecoinAddress,
    timestamp:             new Date().toISOString(),
    dryRun:                String(dryRun),
  };

  for (const [key, val] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(28)}: ${val}`);
  }

  if (testDoubleNote) {
    console.log(testDoubleNote);
  }

  // ── write address file ────────────────────────────────────────────────────
  if (!dryRun) {
    const outDir  = path.join(__dirname, "..", "deployments");
    const outFile = path.join(outDir, `${networkName}.json`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
    log(`Addresses written to deployments/${networkName}.json`);
    if (ifaDeployBlock !== null) {
      log(`Set INDEX_FROM_BLOCK=${ifaDeployBlock} in the backend .env (IFA deploy block).`);
    }
  }

  // ── celoscan verification reminder ────────────────────────────────────────
  if (isMainnet && !dryRun) {
    sep();
    console.log("\n  Next step: verify contracts on celoscan\n");
    console.log("  npx hardhat run scripts/verify.ts --network celo");
  }

  if (dryRun) {
    sep();
    console.log(
      "\n  DRY RUN complete. Review the addresses and gas estimates above.\n" +
      "  To broadcast on mainnet, set MAINNET_DEPLOY_CONFIRMED=true in .env\n" +
      "  and re-run after owner sign-off.\n",
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
