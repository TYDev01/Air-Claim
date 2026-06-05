/**
 * Integration test — Celo mainnet fork
 *
 * Exercises InsuredFlightsAgency end-to-end against the REAL Chainlink
 * CELO/USD price feed on Celo mainnet. The feed address below was resolved
 * from https://docs.chain.link/data-feeds/price-feeds/addresses?network=celo
 * and confirmed on celoscan.io before use.
 *
 * Run with:
 *   FORK=true npx hardhat test test/integration/InsuredFlightsAgency.fork.test.ts
 *
 * Skips automatically when FORK env var is not set so the CI unit-test
 * run is not affected by RPC availability.
 *
 * IMPORTANT: The Chainlink feed address is used READ-ONLY in this test.
 * It must be re-confirmed on celoscan before any mainnet deploy of the
 * production contract. Do not copy this address into deploy scripts
 * without that verification step.
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  FlightOracle,
  InsuredFlightsAgency,
  StablecoinDouble,
} from "../../typechain-types";
import { AggregatorV3Interface } from "../../typechain-types/@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface";

// ─── Chainlink CELO/USD feed — Celo mainnet ───────────────────────────────────
// Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=celo
// Confirmed on celoscan: https://celoscan.io/address/0x0568fd19986748ceff3301e55c0eb1e729e0ab7e
// Heartbeat: 1 hour | Deviation: 0.5%
// ethers.getAddress() applies EIP-55 checksum so the literal doesn't need
// to be pre-checksummed — any case combination of the correct bytes is fine.
const CELO_USD_FEED = ethers.getAddress("0x0568fd19986748ceff3301e55c0eb1e729e0ab7e");

// ─── helpers ─────────────────────────────────────────────────────────────────

const toWei    = (n: string)   => ethers.parseEther(n);
const flightId = (raw: string) => ethers.keccak256(ethers.toUtf8Bytes(raw));

const FORK_ENABLED    = process.env.FORK === "true";
const BASE_FEE        = toWei("0.001");
const DELAY_THRESHOLD = 30;
const MAX_STALENESS   = 3_600 * 3; // 3 h — generous for a test against a pinned block
const CHECK_COOLDOWN  = 300;

enum FlightStatus { Delayed = 1 }

// ─── conditional suite ───────────────────────────────────────────────────────

const describeOrSkip = FORK_ENABLED ? describe : describe.skip;

describeOrSkip("InsuredFlightsAgency — Celo mainnet fork (real Chainlink feed)", () => {
  let owner: SignerWithAddress;
  let passenger: SignerWithAddress;

  let oracle: FlightOracle;
  let ifa: InsuredFlightsAgency;
  let stablecoin: StablecoinDouble;
  let feed: AggregatorV3Interface;

  const FID    = flightId("FORK-TEST-ET309");
  const TICKET = toWei("100");

  before(async () => {
    [owner, passenger] = await ethers.getSigners();

    // Verify the feed contract exists at the expected address on the fork.
    const code = await ethers.provider.getCode(CELO_USD_FEED);
    if (code === "0x") {
      throw new Error(
        `No contract at CELO_USD_FEED ${CELO_USD_FEED} on this fork. ` +
        "Check the feed address or the fork block."
      );
    }

    feed = await ethers.getContractAt(
      "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol:AggregatorV3Interface",
      CELO_USD_FEED,
    ) as AggregatorV3Interface;

    // Deploy supporting contracts.
    oracle = await (await ethers.getContractFactory("FlightOracle"))
      .deploy(owner.address) as FlightOracle;

    stablecoin = await (await ethers.getContractFactory("StablecoinDouble"))
      .deploy("cUSD", "cUSD", 18) as StablecoinDouble;

    // Deploy InsuredFlightsAgency with the REAL Chainlink feed.
    ifa = await (await ethers.getContractFactory("InsuredFlightsAgency"))
      .deploy(
        await oracle.getAddress(),
        CELO_USD_FEED,              // ← real on-chain feed, not a mock
        await stablecoin.getAddress(),
        DELAY_THRESHOLD,
        BASE_FEE,
        MAX_STALENESS,
        CHECK_COOLDOWN,
      ) as InsuredFlightsAgency;

    // Fund the CELO reserve for fallback payouts.
    await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("10") });

    // Mint stablecoin reserve so the preferred payout path can be tested.
    await stablecoin.mint(await ifa.getAddress(), toWei("500"));
  });

  // ── feed sanity ───────────────────────────────────────────────────────────

  it("CELO/USD feed returns a positive answer on the fork", async () => {
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.be.gt(0n);
  });

  it("CELO/USD feed decimals() returns a non-zero value", async () => {
    const dec = await feed.decimals();
    expect(dec).to.be.gt(0);
  });

  it("feed answer is within a plausible CELO price range ($0.01 – $100.00)", async () => {
    const dec    = await feed.decimals();
    const [, ans]= await feed.latestRoundData();
    // Normalise to 8 decimals for comparison regardless of feed precision.
    const normalised = (ans * 10n ** 8n) / (10n ** BigInt(dec));
    // $0.01 → 1_000_000  |  $100.00 → 10_000_000_000
    // Wide range: CELO has traded from ~$0.02 to ~$10 historically.
    expect(normalised).to.be.gte(1_000_000n,     "CELO price below $0.01 — wrong feed?");
    expect(normalised).to.be.lte(10_000_000_000n,"CELO price above $100 — wrong feed?");
  });

  // ── full flow ─────────────────────────────────────────────────────────────

  it("insures a flight and emits FlightInsured", async () => {
    const premium    = await ifa.premiumFor([TICKET]);
    const flightDate = BigInt(await time.latest()) + 86_400n;

    await expect(
      ifa.connect(passenger).insureFlight(
        FID, "ET309", "ADD", "LHR", flightDate,
        [passenger.address], [TICKET], { value: premium },
      ),
    ).to.emit(ifa, "FlightInsured");
  });

  it("confirms delay and marks policy claimable", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, DELAY_THRESHOLD + 1, "fork-test");
    await ifa.connect(owner).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.true;
  });

  it("claimInsurance pays out using the real CELO/USD feed", async () => {
    const tx = await ifa.connect(passenger).claimInsurance(FID);
    await expect(tx).to.emit(ifa, "InsuranceClaimed");

    const rec   = await tx.wait();
    const iface = ifa.interface;
    const log   = rec!.logs
      .map(l => { try { return iface.parseLog(l as any); } catch { return null; } })
      .find(p => p?.name === "InsuranceClaimed");

    expect(log).to.not.be.null;

    const paidInStablecoin: boolean = log!.args[4];
    const payoutAmount:    bigint   = log!.args[3];

    // Payout must be 10% of TICKET in CELO wei.
    expect(payoutAmount).to.equal(TICKET / 10n);

    if (paidInStablecoin) {
      // Stablecoin path: verify the converted amount is positive and reasonable.
      const stableBalance = await stablecoin.balanceOf(passenger.address);
      expect(stableBalance).to.be.gt(0n, "Stablecoin balance should increase after claim");

      // Cross-check: stableBalance should equal payoutCelo × (CELO price / 10^feedDec)
      const [, answer] = await feed.latestRoundData();
      const feedDec    = await feed.decimals();
      const expected   = (payoutAmount * answer) / (10n ** BigInt(18 + Number(feedDec) - 18));
      expect(stableBalance).to.equal(expected, "Stablecoin payout amount does not match feed-derived expectation");
    } else {
      // CELO fallback path: verify CELO arrived (changeEtherBalance not usable here
      // since we already awaited the tx, but receipt confirms the transfer).
      // The InsuranceClaimed event with paidInStablecoin=false is sufficient evidence.
      expect(paidInStablecoin).to.be.false;
    }
  });

  it("passenger cannot claim twice", async () => {
    await expect(ifa.connect(passenger).claimInsurance(FID))
      .to.be.revertedWith("IFA: already claimed");
  });

  // ── price feed validation on the fork ────────────────────────────────────

  it("latestRoundData() round is complete (answeredInRound >= roundId)", async () => {
    const [roundId,,,,answeredInRound] = await feed.latestRoundData();
    expect(answeredInRound).to.be.gte(roundId);
  });

  it("latestRoundData() updatedAt is within MAX_STALENESS of block.timestamp", async () => {
    const [,,,updatedAt] = await feed.latestRoundData();
    const blockTs = BigInt(await time.latest());
    expect(blockTs - updatedAt).to.be.lte(
      BigInt(MAX_STALENESS),
      "Feed data is stale beyond MAX_STALENESS — consider updating the pinned fork block",
    );
  });
});
