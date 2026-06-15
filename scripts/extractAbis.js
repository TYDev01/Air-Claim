/**
 * Extract contract ABIs from Hardhat artifacts into backend/abis/.
 *
 * The backend loads these committed JSON files at runtime (see
 * backend/src/chain/abis.ts) and must never hand-write or guess them. Run this
 * after any contract change — `npm run abis:extract` — and commit the result.
 * CI runs `npm run abis:check`, which extracts and fails if the committed ABIs
 * differ from a fresh compile, so an indexer/ABI drift like newTodo.md #1 can
 * never land silently again.
 *
 * Usage:
 *   npx hardhat compile && node scripts/extractAbis.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT      = path.join(__dirname, "..");
const ABIS_DIR  = path.join(ROOT, "backend", "abis");

/** [artifact path relative to artifacts/, output file name] */
const CONTRACTS = [
  ["contracts/FlightOracle.sol/FlightOracle.json",                   "FlightOracle.json"],
  ["contracts/InsuredFlightsAgency.sol/InsuredFlightsAgency.json",   "InsuredFlightsAgency.json"],
];

function main() {
  fs.mkdirSync(ABIS_DIR, { recursive: true });

  for (const [artifactRel, outName] of CONTRACTS) {
    const artifactPath = path.join(ROOT, "artifacts", artifactRel);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(
        `Artifact not found: ${artifactPath}\n` +
        `Run "npx hardhat compile" before extracting ABIs.`,
      );
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const outPath  = path.join(ABIS_DIR, outName);
    fs.writeFileSync(outPath, JSON.stringify(artifact.abi, null, 2) + "\n");
    console.log(`  ${outName.padEnd(28)} ← ${artifactRel}`);
  }

  console.log("ABIs extracted to backend/abis/");
}

main();
