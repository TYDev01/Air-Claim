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
const CELO_PRICE      = 50_000_000n; // $0.50 with 8 dec

enum FlightStatus { Scheduled = 0, Delayed = 1, Cancelled = 2, Landed = 3 }

// ─── shared deploy ────────────────────────────────────────────────────────────

async function deploy(owner: SignerWithAddress) {
  const oracle      = await (await ethers.getContractFactory("FlightOracle")).deploy(owner.address) as FlightOracle;
  const feed        = await (await ethers.getContractFactory("PriceFeedDouble")).deploy(CELO_PRICE, 8) as PriceFeedDouble;
  const stablecoin  = await (await ethers.getContractFactory("StablecoinDouble")).deploy("cUSD","cUSD",18) as StablecoinDouble;
  const ifa         = await (await ethers.getContractFactory("InsuredFlightsAgency")).deploy(
    await oracle.getAddress(), await feed.getAddress(), await stablecoin.getAddress(),
    DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
  ) as InsuredFlightsAgency;
  return { oracle, feed, stablecoin, ifa };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InsuredFlightsAgency — claim matrix", () => {
  let owner: SignerWithAddress;
  let p1: SignerWithAddress;
  let p2: SignerWithAddress;
  let stranger: SignerWithAddress;

  let oracle: FlightOracle;
  let ifa: InsuredFlightsAgency;

  const FID    = flightId("ET309");
  const TICKET = toWei("100");

  // Helper: fund ifa with enough CELO for claims
  async function fundIfa(amount = toWei("100")) {
    await owner.sendTransaction({ to: await ifa.getAddress(), value: amount });
  }

  // Helper: insure FID for p1 (and optionally p2)
  async function insure(passengers: SignerWithAddress[], tickets?: bigint[]) {
    const tix     = tickets ?? passengers.map(() => TICKET);
    const premium = await ifa.premiumFor(tix);
    const flightDate = BigInt(await time.latest()) + 86_400n;
    await ifa.connect(p1).insureFlight(
      FID, "ET309", "ADD", "LHR", flightDate,
      passengers.map(s => s.address), tix, { value: premium },
    );
  }

  // Helper: confirm delay via oracle + checkFlightDelay
  async function confirmDelay(status = FlightStatus.Delayed, delayMin = DELAY_THRESHOLD + 1) {
    await oracle.connect(owner).updateFlight(FID, status, delayMin, "src");
    await ifa.connect(owner).checkFlightDelay(FID);
  }

  beforeEach(async () => {
    [owner, p1, p2, stranger] = await ethers.getSigners();
    ({ oracle, ifa } = await deploy(owner));
    await fundIfa();
  });

  // ── gate: no policy ───────────────────────────────────────────────────────

  it("reverts when no policy exists for the flightId", async () => {
    await expect(ifa.connect(p1).claimInsurance(flightId("NONE")))
      .to.be.revertedWith("IFA: no policy");
  });

  // ── gate: not claimable ───────────────────────────────────────────────────

  it("reverts when policy is not yet claimable (flight still Scheduled)", async () => {
    await insure([p1]);
    await expect(ifa.connect(p1).claimInsurance(FID))
      .to.be.revertedWith("IFA: not claimable");
  });

  it("reverts when delay was below threshold (policy never marked claimable)", async () => {
    await insure([p1]);
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, DELAY_THRESHOLD - 1, "src");
    await ifa.connect(owner).checkFlightDelay(FID);
    await expect(ifa.connect(p1).claimInsurance(FID))
      .to.be.revertedWith("IFA: not claimable");
  });

  // ── gate: caller not insured ──────────────────────────────────────────────

  it("reverts when caller is not in the passenger list", async () => {
    await insure([p1]);
    await confirmDelay();
    await expect(ifa.connect(stranger).claimInsurance(FID))
      .to.be.revertedWith("IFA: not insured");
  });

  it("reverts when caller is a second passenger on a different flight", async () => {
    await insure([p1]);
    await confirmDelay();
    // p2 was never insured on FID
    await expect(ifa.connect(p2).claimInsurance(FID))
      .to.be.revertedWith("IFA: not insured");
  });

  // ── gate: already claimed ─────────────────────────────────────────────────

  it("reverts on a second claim by the same passenger", async () => {
    await insure([p1]);
    await confirmDelay();
    await ifa.connect(p1).claimInsurance(FID); // first claim OK
    await expect(ifa.connect(p1).claimInsurance(FID))
      .to.be.revertedWith("IFA: already claimed");
  });

  // ── successful claim — single passenger ───────────────────────────────────

  it("succeeds for an insured passenger on a claimable flight", async () => {
    await insure([p1]);
    await confirmDelay();
    await expect(ifa.connect(p1).claimInsurance(FID)).to.not.be.reverted;
  });

  it("emits InsuranceClaimed with correct policyId, flightId, passenger", async () => {
    await insure([p1]);
    await confirmDelay();
    await expect(ifa.connect(p1).claimInsurance(FID))
      .to.emit(ifa, "InsuranceClaimed")
      .withArgs(1n, FID, p1.address, TICKET / 10n, false);
  });

  it("passengerInfo.claimed becomes true after claim", async () => {
    await insure([p1]);
    await confirmDelay();
    expect((await ifa.passengerInfo(FID, p1.address)).claimed).to.be.false;
    await ifa.connect(p1).claimInsurance(FID);
    expect((await ifa.passengerInfo(FID, p1.address)).claimed).to.be.true;
  });

  it("decrements reservedForClaims by the payout amount", async () => {
    await insure([p1]);
    await confirmDelay();
    const before = await ifa.reservedForClaims();
    await ifa.connect(p1).claimInsurance(FID);
    expect(await ifa.reservedForClaims()).to.equal(before - TICKET / 10n);
  });

  it("transfers 10% of ticket price in CELO to passenger", async () => {
    await insure([p1]);
    await confirmDelay();
    const expected = TICKET / 10n;
    await expect(ifa.connect(p1).claimInsurance(FID))
      .to.changeEtherBalance(p1, expected);
  });

  // ── multi-passenger — independent claims ──────────────────────────────────

  it("each passenger can claim independently; claims are independent", async () => {
    await insure([p1, p2]);
    await confirmDelay();

    // p1 claims
    await expect(ifa.connect(p1).claimInsurance(FID)).to.not.be.reverted;
    expect((await ifa.passengerInfo(FID, p1.address)).claimed).to.be.true;
    expect((await ifa.passengerInfo(FID, p2.address)).claimed).to.be.false;

    // p2 claims
    await expect(ifa.connect(p2).claimInsurance(FID)).to.not.be.reverted;
    expect((await ifa.passengerInfo(FID, p2.address)).claimed).to.be.true;
  });

  it("p1 claiming does not prevent p2 from claiming", async () => {
    await insure([p1, p2]);
    await confirmDelay();
    await ifa.connect(p1).claimInsurance(FID);
    await expect(ifa.connect(p2).claimInsurance(FID)).to.not.be.reverted;
  });

  it("p2 gets 10% of their own ticket price (different tickets)", async () => {
    const t1 = toWei("100");
    const t2 = toWei("200");
    await insure([p1, p2], [t1, t2]);
    await confirmDelay();

    await ifa.connect(p1).claimInsurance(FID); // p1 gets t1/10

    await expect(ifa.connect(p2).claimInsurance(FID))
      .to.changeEtherBalance(p2, t2 / 10n);
  });

  // ── Cancelled flight ──────────────────────────────────────────────────────

  it("claim succeeds after Cancelled confirmation", async () => {
    await insure([p1]);
    await confirmDelay(FlightStatus.Cancelled, 0);
    await expect(ifa.connect(p1).claimInsurance(FID)).to.not.be.reverted;
  });

  // ── paused ────────────────────────────────────────────────────────────────

  it("reverts when contract is paused", async () => {
    await insure([p1]);
    await confirmDelay();
    await ifa.connect(owner).pause();
    await expect(ifa.connect(p1).claimInsurance(FID))
      .to.be.revertedWithCustomError(ifa, "EnforcedPause");
  });

  it("succeeds after unpause", async () => {
    await insure([p1]);
    await confirmDelay();
    await ifa.connect(owner).pause();
    await ifa.connect(owner).unpause();
    await expect(ifa.connect(p1).claimInsurance(FID)).to.not.be.reverted;
  });
});
