/**
 * AirClaim celoscan verification script.
 *
 * Reads the deployed addresses from deployments/<network>.json (written by
 * deploy.ts) and calls `hardhat verify` for each contract with the correct
 * constructor arguments.
 *
 * Usage
 * ─────
 *   npx hardhat run scripts/verify.ts --network celo
 *   npx hardhat run scripts/verify.ts --network alfajores
 *
 * Requires
 * ────────
 *   - deployments/<network>.json to exist (run deploy.ts first)
 *   - CELOSCAN_API_KEY in .env
 */

import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getNetworkConfig } from "./config/networkConfig";

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`\n[verify] ${msg}`); }
function sep()            { console.log("─".repeat(60)); }

async function verifyContract(
  name: string,
  address: string,
  constructorArgs: unknown[],
): Promise<void> {
  if (!address || address === "0x0000000000000000000000000000000000000000") {
    console.log(`  ${name.padEnd(30)} SKIPPED (zero address)`);
    return;
  }

  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ${name.padEnd(30)} ✓ verified  ${address}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Already Verified") || msg.includes("already verified")) {
      console.log(`  ${name.padEnd(30)} ℹ already verified  ${address}`);
    } else {
      console.error(`  ${name.padEnd(30)} ✗ FAILED  ${address}`);
      console.error(`    ${msg}`);
    }
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const networkName = network.name;
  const cfg         = getNetworkConfig(networkName);

  // Load deployment addresses written by deploy.ts.
  const addressFile = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(addressFile)) {
    throw new Error(
      `deployments/${networkName}.json not found. Run deploy.ts first:\n` +
      `  npx hardhat run scripts/deploy.ts --network ${networkName}`
    );
  }

  const deployed = JSON.parse(fs.readFileSync(addressFile, "utf8")) as {
    deployer:               string;
    flightOracle:           string;
    commitRevealRandomness: string;
    insuredFlightsAgency:   string;
    luckySpin:              string;
    battleShip:             string;
    celoUsdFeed:            string;
    stablecoin:             string;
    dryRun:                 string;
  };

  if (deployed.dryRun === "true") {
    throw new Error(
      "deployments file was produced by a dry-run — no contracts were actually deployed. " +
      "Run deploy.ts with MAINNET_DEPLOY_CONFIRMED=true first."
    );
  }

  sep();
  console.log(`  Verifying contracts on ${networkName}`);
  sep();

  // ── 1. FlightOracle ───────────────────────────────────────────────────────
  log("1 / 5  FlightOracle");
  await verifyContract("FlightOracle", deployed.flightOracle, [
    deployed.deployer,  // admin
  ]);

  // ── 2. CommitRevealRandomness ──────────────────────────────────────────────
  log("2 / 5  CommitRevealRandomness");
  const operatorAddress = process.env.OPERATOR_ADDRESS || deployed.deployer;
  await verifyContract("CommitRevealRandomness", deployed.commitRevealRandomness, [
    operatorAddress,
  ]);

  // ── 3. InsuredFlightsAgency ────────────────────────────────────────────────
  log("3 / 5  InsuredFlightsAgency");
  await verifyContract("InsuredFlightsAgency", deployed.insuredFlightsAgency, [
    deployed.flightOracle,
    deployed.celoUsdFeed,
    deployed.stablecoin,
    cfg.delayThresholdMinutes,
    cfg.baseFee,
    cfg.feedMaxStaleness,
    cfg.checkCooldownSeconds,
  ]);

  // ── 4. LuckySpin ──────────────────────────────────────────────────────────
  log("4 / 5  LuckySpin");
  await verifyContract("LuckySpin", deployed.luckySpin, [
    deployed.commitRevealRandomness,
    cfg.luckySpinStakeCap,
  ]);

  // ── 5. BattleShip ─────────────────────────────────────────────────────────
  log("5 / 5  BattleShip");
  await verifyContract("BattleShip", deployed.battleShip, [
    deployed.commitRevealRandomness,
    cfg.battleShipStakeCap,
  ]);

  // ── summary ───────────────────────────────────────────────────────────────
  sep();
  const explorerBase = networkName === "celo"
    ? "https://celoscan.io/address/"
    : "https://alfajores.celoscan.io/address/";

  console.log("\n  Explorer links\n");
  const contracts: [string, string][] = [
    ["FlightOracle",           deployed.flightOracle],
    ["CommitRevealRandomness", deployed.commitRevealRandomness],
    ["InsuredFlightsAgency",   deployed.insuredFlightsAgency],
    ["LuckySpin",              deployed.luckySpin],
    ["BattleShip",             deployed.battleShip],
  ];
  for (const [name, addr] of contracts) {
    console.log(`  ${name.padEnd(26)} ${explorerBase}${addr}`);
  }
  console.log();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
