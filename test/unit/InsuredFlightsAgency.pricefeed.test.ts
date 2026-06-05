import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  FlightOracle,
  InsuredFlightsAgency,
  PriceFeedDouble,
  StablecoinDouble,
} from "../../typechain-types";

// ─── helpers ─────────────────────────────────────────────────────────────────

const flightId = (raw: string) => ethers.keccak256(ethers.toUtf8Bytes(raw));
const toWei    = (n: string)   => ethers.parseEther(n);

const BASE_FEE        = toWei("0.001");
const DELAY_THRESHOLD = 30;
const MAX_STALENESS   = 3600;
const CHECK_COOLDOWN  = 300;

enum FlightStatus { Delayed = 1 }

// ─── deploy helper ────────────────────────────────────────────────────────────

async function deploy(
  owner: SignerWithAddress,
  feedAnswer: bigint,
  feedDecimals: number,
  stableDecimals = 18,
) {
  const oracle     = await (await ethers.getContractFactory("FlightOracle")).deploy(owner.address) as FlightOracle;
  const feed       = await (await ethers.getContractFactory("PriceFeedDouble")).deploy(feedAnswer, feedDecimals) as PriceFeedDouble;
  const stablecoin = await (await ethers.getContractFactory("StablecoinDouble")).deploy("cUSD", "cUSD", stableDecimals) as StablecoinDouble;
  const ifa        = await (await ethers.getContractFactory("InsuredFlightsAgency")).deploy(
    await oracle.getAddress(), await feed.getAddress(), await stablecoin.getAddress(),
    DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
  ) as InsuredFlightsAgency;
  return { oracle, feed, stablecoin, ifa };
}

// ─── full-scenario helper ─────────────────────────────────────────────────────

async function setupClaimable(
  ifa: InsuredFlightsAgency,
  oracle: FlightOracle,
  owner: SignerWithAddress,
  passenger: SignerWithAddress,
  fid: string,
  ticket = toWei("100"),
) {
  const premium    = await ifa.premiumFor([ticket]);
  const flightDate = BigInt(await time.latest()) + 86_400n;
  await ifa.connect(passenger).insureFlight(
    fid, "FL001", "AAA", "BBB", flightDate,
    [passenger.address], [ticket], { value: premium },
  );
  await oracle.connect(owner).updateFlight(fid, FlightStatus.Delayed, DELAY_THRESHOLD + 1, "src");
  await ifa.connect(owner).checkFlightDelay(fid);
  // Fund CELO reserve for fallback
  await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InsuredFlightsAgency — price-feed safety", () => {
  let owner: SignerWithAddress;
  let p1: SignerWithAddress;

  const TICKET       = toWei("100");
  const PAYOUT_CELO  = TICKET / 10n;

  beforeEach(async () => {
    [owner, p1] = await ethers.getSigners();
  });

  // ── answeredInRound < roundId (incomplete round) ──────────────────────────

  describe("incomplete round (answeredInRound < roundId)", () => {
    it("falls back to CELO — stablecoin reserve present but round incomplete", async () => {
      const FID = flightId("FL-INCOMPLETE");
      const { oracle, feed, stablecoin, ifa } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      await feed.setIncompleteRound(); // answeredInRound = 4, roundId = 5

      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── updatedAt == 0 (uninitialised round) ──────────────────────────────────

  describe("uninitialised round (updatedAt == 0)", () => {
    it("falls back to CELO when updatedAt is zero", async () => {
      const FID = flightId("FL-ZEROTS");
      const { oracle, feed, stablecoin, ifa } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      await feed.setUpdatedAt(0); // explicitly zero

      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── decimals() reverts ────────────────────────────────────────────────────

  describe("decimals() reverts on the feed", () => {
    it("falls back to CELO when decimals() throws", async () => {
      const FID = flightId("FL-DECREV");
      const { oracle, feed, stablecoin, ifa } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      await feed.setRevertOnDecimals(true);

      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── latestRoundData() reverts ─────────────────────────────────────────────

  describe("latestRoundData() reverts on the feed", () => {
    it("falls back to CELO when latestRoundData() throws", async () => {
      const FID = flightId("FL-LRDREV");
      const { oracle, feed, stablecoin, ifa } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      await feed.setRevertOnLatestRoundData(true);

      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── decimal scaling correctness ───────────────────────────────────────────

  describe("decimal scaling — various feed/stablecoin combinations", () => {
    // Helper: expected stablecoin payout
    function expected(celoWei: bigint, price: bigint, feedDec: number, stableDec: number) {
      return (celoWei * price) / (10n ** BigInt(18 + feedDec - stableDec));
    }

    interface Case {
      label: string;
      feedPrice: bigint;
      feedDec: number;
      stableDec: number;
    }

    const cases: Case[] = [
      { label: "8-dec feed / 18-dec cUSD",  feedPrice: 50_000_000n,        feedDec: 8,  stableDec: 18 },
      { label: "8-dec feed / 6-dec USDC",   feedPrice: 50_000_000n,        feedDec: 8,  stableDec: 6  },
      { label: "18-dec feed / 18-dec cUSD", feedPrice: 500_000_000_000_000_000n, feedDec: 18, stableDec: 18 },
    ];

    for (const c of cases) {
      it(`correct payout: ${c.label}`, async () => {
        const FID = flightId(`FL-SCALE-${c.label}`);
        const { oracle, stablecoin, ifa } = await deploy(owner, c.feedPrice, c.feedDec, c.stableDec);

        // Mint enough stablecoin
        const exp = expected(PAYOUT_CELO, c.feedPrice, c.feedDec, c.stableDec);
        await stablecoin.mint(await ifa.getAddress(), exp * 10n);

        await setupClaimable(ifa, oracle, owner, p1, FID);

        await expect(ifa.connect(p1).claimInsurance(FID))
          .to.changeTokenBalance(stablecoin, p1, exp);
      });
    }
  });

  // ── maxStaleness boundary ─────────────────────────────────────────────────

  describe("maxStaleness boundary", () => {
    it("accepts a feed updated exactly at the staleness boundary", async () => {
      const FID = flightId("FL-BOUNDARY-OK");
      const { oracle, stablecoin, ifa, feed } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      // Set updatedAt = now - (MAX_STALENESS - 2). By the time claimInsurance
      // executes in the next block (+1s), age = MAX_STALENESS - 1 which is
      // strictly less than MAX_STALENESS, so the feed is still valid.
      await feed.setStale(MAX_STALENESS - 2);
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, true);
    });

    it("falls back to CELO one second past the staleness boundary", async () => {
      const FID = flightId("FL-BOUNDARY-FAIL");
      const { oracle, stablecoin, ifa, feed } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      await feed.setStale(MAX_STALENESS + 1);
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── setMaxStaleness owner setter ──────────────────────────────────────────

  describe("setMaxStaleness", () => {
    it("reverts for non-owner", async () => {
      const { ifa } = await deploy(owner, 50_000_000n, 8);
      await expect(ifa.connect(p1).setMaxStaleness(7200))
        .to.be.revertedWithCustomError(ifa, "OwnableUnauthorizedAccount");
    });

    it("owner can tighten staleness window and trip it", async () => {
      const FID = flightId("FL-TIGHT-STALE");
      const { oracle, stablecoin, ifa, feed } = await deploy(owner, 50_000_000n, 8);
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupClaimable(ifa, oracle, owner, p1, FID);

      // Tighten to 60 seconds, then make feed 61 seconds old
      await ifa.connect(owner).setMaxStaleness(60);
      await feed.setStale(61);

      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });
});
