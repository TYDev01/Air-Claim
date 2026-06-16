/**
 * Loads contract ABIs from committed JSON files under backend/abis/.
 *
 * The JSON files are extracted from Hardhat compilation artifacts and
 * committed alongside the backend source. They must never be hand-written
 * or guessed — re-extract from artifacts whenever contracts change.
 *
 * Re-extract from the project root:
 *   npx hardhat compile && npm run abis:extract
 *
 * CI runs `npm run abis:check`, which fails if the committed copies here have
 * drifted from a fresh compile (see scripts/extractAbis.js).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { Abi } from "viem";

// ─── Path resolution ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
// Resolves to backend/abis/ regardless of whether we are in src/ or dist/
const ABIS_DIR   = join(__dirname, "..", "..", "abis");

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Read and parse an ABI JSON file from backend/abis/.
 *
 * @param name  Contract name without extension, e.g. "FlightOracle".
 * @returns     Parsed ABI array typed as viem `Abi`.
 * @throws      If the file is missing or contains invalid JSON — indicates the
 *              ABI file was not extracted from artifacts before building.
 */
function readAbi(name: string): Abi {
  const filePath = join(ABIS_DIR, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(
      `ABI file not found: ${filePath}\n` +
      `Re-extract from Hardhat artifacts before building the backend.\n` +
      `See the extraction command at the top of backend/src/chain/abis.ts`,
      { cause },
    );
  }

  try {
    return JSON.parse(raw) as Abi;
  } catch (cause) {
    throw new Error(`Invalid JSON in ABI file: ${filePath}`, { cause });
  }
}

// ─── Exported ABIs ────────────────────────────────────────────────────────────

/**
 * Loads all contract ABIs on first access (lazy, module-level singleton).
 * Calling this multiple times is safe — Node's module cache prevents re-reads.
 */
export function loadAbis(): { flightOracleAbi: Abi; insuredFlightsAgencyAbi: Abi } {
  return {
    flightOracleAbi:          readAbi("FlightOracle"),
    insuredFlightsAgencyAbi:  readAbi("InsuredFlightsAgency"),
  };
}
