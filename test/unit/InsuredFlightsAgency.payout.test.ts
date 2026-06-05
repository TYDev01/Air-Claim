import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  FlightOracle,
  InsuredFlightsAgency,
  PriceFeedDouble,
  StablecoinDouble,
  ReentrancyAttacker,
} from "../../typechain-types";

// ─── helpers ─────────────────────────────────────────────────────────────────

const flightId = (raw: string) => ethers.keccak256(ethers.toUtf8Bytes(raw));
const toWei    = (n: string)   => ethers.parseEther(n);

const BASE_FEE        = toWei("0.001");
const DELAY_THRESHOLD = 30;
const MAX_STALENESS   = 3600;
const CHECK_COOLDOWN  = 300;

// Feed: $0.50 per CELO, 8 decimals
const CELO_PRICE    = 50_000_000n;
const FEED_DECIMALS = 8;

enum FlightStatus { Scheduled = 0, Delayed = 1, Cancelled = 2, Landed = 3 }

// ─── deploy ───────────────────────────────────────────────────────────────────

async function deploy(owner: SignerWithAddress, stableDecimals = 18) {
  const oracle     = await (await ethers.getContractFactory("FlightOracle")).deploy(owner.address) as FlightOracle;
  const feed       = await (await ethers.getContractFactory("PriceFeedDouble")).deploy(CELO_PRICE, FEED_DECIMALS) as PriceFeedDouble;
  const stablecoin = await (await ethers.getContractFactory("StablecoinDouble")).deploy("cUSD", "cUSD", stableDecimals) as StablecoinDouble;
  const ifa        = await (await ethers.getContractFactory("InsuredFlightsAgency")).deploy(
    await oracle.getAddress(), await feed.getAddress(), await stablecoin.getAddress(),
    DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
  ) as InsuredFlightsAgency;
  return { oracle, feed, stablecoin, ifa };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InsuredFlightsAgency — payout paths", () => {
  let owner: SignerWithAddress;
  let p1: SignerWithAddress;

  const TICKET = toWei("100");           // 100 CELO ticket
  const PAYOUT_CELO = TICKET / 10n;      // 10 CELO payout

  // Expected stablecoin amount: 10 CELO × $0.50 / 1 = $5.00
  // Formula: celoWei * price / 10^(18 + feedDec - stableDec)
  //   = 10e18 * 50_000_000 / 10^(18+8-18) = 10e18 * 0.5e-8 * 1e10 = 5e18
  const PAYOUT_CUSD_18DEC = (PAYOUT_CELO * CELO_PRICE) / (10n ** BigInt(18 + FEED_DECIMALS - 18));

  // For a 6-decimal stablecoin (USDC):
  // = 10e18 * 50_000_000 / 10^(18+8-6) = 5_000_000
  const PAYOUT_USDC_6DEC  = (PAYOUT_CELO * CELO_PRICE) / (10n ** BigInt(18 + FEED_DECIMALS - 6));

  // ── shared setup helper ─────────────────────────────────────────────────

  async function setupAndConfirm(
    ifa: InsuredFlightsAgency,
    oracle: FlightOracle,
    passenger: SignerWithAddress,
    fid: string,
  ) {
    const premium    = await ifa.premiumFor([TICKET]);
    const flightDate = BigInt(await time.latest()) + 86_400n;
    await ifa.connect(passenger).insureFlight(
      fid, "ET309", "ADD", "LHR", flightDate,
      [passenger.address], [TICKET], { value: premium },
    );
    await oracle.connect(owner).updateFlight(fid, FlightStatus.Delayed, DELAY_THRESHOLD + 1, "src");
    await ifa.connect(owner).checkFlightDelay(fid);
  }

  beforeEach(async () => {
    [owner, p1] = await ethers.getSigners();
  });

  // ── stablecoin payout — 18-decimal (cUSD) ────────────────────────────────

  describe("stablecoin payout (18-decimal cUSD)", () => {
    let ifa: InsuredFlightsAgency;
    let stablecoin: StablecoinDouble;
    let feed: PriceFeedDouble;
    let oracle: FlightOracle;

    const FID = flightId("ET309-STABLE18");

    beforeEach(async () => {
      ({ ifa, stablecoin, feed, oracle } = await deploy(owner, 18));
      // Fund ifa with CELO for fallback and stablecoin for preferred path
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
      await stablecoin.mint(await ifa.getAddress(), toWei("100")); // 100 cUSD
      await setupAndConfirm(ifa, oracle, p1, FID);
    });

    it("pays in stablecoin when feed is valid and reserve is sufficient", async () => {
      const tx = await ifa.connect(p1).claimInsurance(FID);
      await expect(tx).to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, true);
    });

    it("transfers the correct cUSD amount to the passenger", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.changeTokenBalance(stablecoin, p1, PAYOUT_CUSD_18DEC);
    });

    it("stablecoin balance of IFA decreases by the correct amount", async () => {
      const before = await stablecoin.balanceOf(await ifa.getAddress());
      await ifa.connect(p1).claimInsurance(FID);
      const after  = await stablecoin.balanceOf(await ifa.getAddress());
      expect(before - after).to.equal(PAYOUT_CUSD_18DEC);
    });

    it("CELO balance of IFA is unchanged when stablecoin path taken", async () => {
      const before = await ethers.provider.getBalance(await ifa.getAddress());
      await ifa.connect(p1).claimInsurance(FID);
      const after  = await ethers.provider.getBalance(await ifa.getAddress());
      expect(after).to.equal(before);
    });
  });

  // ── stablecoin payout — 6-decimal (USDC) ─────────────────────────────────

  describe("stablecoin payout (6-decimal USDC)", () => {
    let ifa: InsuredFlightsAgency;
    let stablecoin: StablecoinDouble;
    let oracle: FlightOracle;

    const FID = flightId("ET309-STABLE6");

    beforeEach(async () => {
      ({ ifa, stablecoin, oracle } = await deploy(owner, 6));
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
      await stablecoin.mint(await ifa.getAddress(), 100_000_000n); // 100 USDC (6 dec)
      await setupAndConfirm(ifa, oracle, p1, FID);
    });

    it("transfers the correct USDC amount with 6-decimal scaling", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.changeTokenBalance(stablecoin, p1, PAYOUT_USDC_6DEC);
    });

    it("emits InsuranceClaimed with paidInStablecoin=true", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, true);
    });
  });

  // ── CELO fallback — stablecoin reserve insufficient ───────────────────────

  describe("CELO fallback — stablecoin reserve short", () => {
    let ifa: InsuredFlightsAgency;
    let oracle: FlightOracle;

    const FID = flightId("ET309-CELO-SHORT");

    beforeEach(async () => {
      ({ ifa, oracle } = await deploy(owner, 18));
      // Fund with CELO only — no stablecoin minted
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
      await setupAndConfirm(ifa, oracle, p1, FID);
    });

    it("falls back to CELO when stablecoin balance is zero", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });

    it("passenger receives correct CELO payout", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.changeEtherBalance(p1, PAYOUT_CELO);
    });
  });

  // ── CELO fallback — feed stale ────────────────────────────────────────────

  describe("CELO fallback — stale price feed", () => {
    let ifa: InsuredFlightsAgency;
    let feed: PriceFeedDouble;
    let stablecoin: StablecoinDouble;
    let oracle: FlightOracle;

    const FID = flightId("ET309-STALE");

    beforeEach(async () => {
      ({ ifa, feed, stablecoin, oracle } = await deploy(owner, 18));
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupAndConfirm(ifa, oracle, p1, FID);
      // Make feed stale beyond MAX_STALENESS
      await feed.setStale(MAX_STALENESS + 1);
    });

    it("falls back to CELO on stale feed (paidInStablecoin=false)", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });

    it("passenger still receives CELO payout despite stale feed", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.changeEtherBalance(p1, PAYOUT_CELO);
    });
  });

  // ── CELO fallback — feed returns zero answer ──────────────────────────────

  describe("CELO fallback — zero price answer", () => {
    let ifa: InsuredFlightsAgency;
    let feed: PriceFeedDouble;
    let stablecoin: StablecoinDouble;
    let oracle: FlightOracle;

    const FID = flightId("ET309-ZERO");

    beforeEach(async () => {
      ({ ifa, feed, stablecoin, oracle } = await deploy(owner, 18));
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupAndConfirm(ifa, oracle, p1, FID);
      await feed.setAnswer(0n);
    });

    it("falls back to CELO on zero answer", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── CELO fallback — feed returns negative answer ──────────────────────────

  describe("CELO fallback — negative price answer", () => {
    let ifa: InsuredFlightsAgency;
    let feed: PriceFeedDouble;
    let stablecoin: StablecoinDouble;
    let oracle: FlightOracle;

    const FID = flightId("ET309-NEG");

    beforeEach(async () => {
      ({ ifa, feed, stablecoin, oracle } = await deploy(owner, 18));
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });
      await stablecoin.mint(await ifa.getAddress(), toWei("100"));
      await setupAndConfirm(ifa, oracle, p1, FID);
      await feed.setAnswer(-1n);
    });

    it("falls back to CELO on negative answer", async () => {
      await expect(ifa.connect(p1).claimInsurance(FID))
        .to.emit(ifa, "InsuranceClaimed")
        .withArgs(1n, FID, p1.address, PAYOUT_CELO, false);
    });
  });

  // ── reentrancy guard ──────────────────────────────────────────────────────

  describe("reentrancy guard", () => {
    let ifa: InsuredFlightsAgency;
    let oracle: FlightOracle;
    let attacker: ReentrancyAttacker;

    const FID = flightId("ET309-REENTRANT");

    beforeEach(async () => {
      ({ ifa, oracle } = await deploy(owner, 18));
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("50") });

      // Deploy attacker — it will be the insured passenger
      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      attacker = (await AttackerFactory.deploy(
        await ifa.getAddress(),
        FID,
      )) as ReentrancyAttacker;

      // Insure the attacker contract as the passenger
      const premium    = await ifa.premiumFor([TICKET]);
      const flightDate = BigInt(await time.latest()) + 86_400n;
      await ifa.connect(p1).insureFlight(
        FID, "ET309", "ADD", "LHR", flightDate,
        [await attacker.getAddress()], [TICKET], { value: premium },
      );

      await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, DELAY_THRESHOLD + 1, "src");
      await ifa.connect(owner).checkFlightDelay(FID);
    });

    it("blocks the reentrant claimInsurance call via ReentrancyGuard", async () => {
      await attacker.attack();
      // The re-entrant call inside receive() must have failed
      expect(await attacker.reentrantSucceeded()).to.be.false;
    });

    it("first (legitimate) claim still succeeds despite reentrant attempt", async () => {
      // attack() calls claimInsurance once; that must succeed even though
      // the re-entrant call inside receive() is blocked.
      await expect(attacker.attack()).to.not.be.reverted;
    });

    it("attacker's claimed flag is true after the first call", async () => {
      await attacker.attack();
      const info = await ifa.passengerInfo(FID, await attacker.getAddress());
      expect(info.claimed).to.be.true;
    });
  });
});
