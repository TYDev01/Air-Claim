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
const DELAY_THRESHOLD = 30;   // minutes
const MAX_STALENESS   = 3600;
const CHECK_COOLDOWN  = 300;  // 5 minutes
const CELO_PRICE      = 50_000_000n;

enum FlightStatus { Scheduled = 0, Delayed = 1, Cancelled = 2, Landed = 3 }

// ─── shared deploy ────────────────────────────────────────────────────────────

async function deploy(owner: SignerWithAddress) {
  const oracle     = await (await ethers.getContractFactory("FlightOracle")).deploy(owner.address) as FlightOracle;
  const feed       = await (await ethers.getContractFactory("PriceFeedDouble")).deploy(CELO_PRICE, 8) as PriceFeedDouble;
  const stablecoin = await (await ethers.getContractFactory("StablecoinDouble")).deploy("cUSD","cUSD",18) as StablecoinDouble;
  const ifa        = await (await ethers.getContractFactory("InsuredFlightsAgency")).deploy(
    await oracle.getAddress(), await feed.getAddress(), await stablecoin.getAddress(),
    DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
  ) as InsuredFlightsAgency;
  return { oracle, feed, stablecoin, ifa };
}

// ─── fixture: insured flight ─────────────────────────────────────────────────

async function insureOne(
  ifa: InsuredFlightsAgency,
  passenger: SignerWithAddress,
  fid: string,
  ticket = toWei("100"),
) {
  const premium    = await ifa.premiumFor([ticket]);
  const flightDate = BigInt(await time.latest()) + 86_400n;
  await ifa.connect(passenger).insureFlight(
    fid, "ET309", "ADD", "LHR", flightDate,
    [passenger.address], [ticket], { value: premium },
  );
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InsuredFlightsAgency — delay logic", () => {
  let owner: SignerWithAddress;
  let passenger: SignerWithAddress;
  let anyone: SignerWithAddress;

  let oracle: FlightOracle;
  let ifa: InsuredFlightsAgency;

  const FID = flightId("ET309");

  beforeEach(async () => {
    [owner, passenger, anyone] = await ethers.getSigners();
    ({ oracle, ifa } = await deploy(owner));
    await insureOne(ifa, passenger, FID);
  });

  // ── no policy ─────────────────────────────────────────────────────────────

  it("reverts when no policy exists for the flightId", async () => {
    const unknown = flightId("UNKNOWN");
    await expect(ifa.connect(anyone).checkFlightDelay(unknown))
      .to.be.revertedWith("IFA: no policy");
  });

  // ── oracle not yet written ────────────────────────────────────────────────

  it("returns silently (no revert) when oracle has never been written", async () => {
    await expect(ifa.connect(anyone).checkFlightDelay(FID)).to.not.be.reverted;
    const info = await ifa.policyInfo(FID);
    expect(info.claimable).to.be.false;
  });

  // ── status does not qualify ───────────────────────────────────────────────

  it("does not mark claimable when status is Scheduled", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Scheduled, 60, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.false;
  });

  it("does not mark claimable when status is Landed", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Landed, 60, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.false;
  });

  // ── delay below threshold ─────────────────────────────────────────────────

  it("does not mark claimable when delay equals threshold (not strictly above)", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, DELAY_THRESHOLD, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.false;
  });

  it("does not mark claimable when delay is below threshold", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, DELAY_THRESHOLD - 1, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.false;
  });

  // ── delay above threshold — Delayed status ────────────────────────────────

  it("marks claimable when status=Delayed and delay > threshold", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, DELAY_THRESHOLD + 1, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.true;
  });

  it("emits DelayConfirmed with correct flightId, policyId, delayMinutes", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, 90, "src");
    await expect(ifa.connect(anyone).checkFlightDelay(FID))
      .to.emit(ifa, "DelayConfirmed")
      .withArgs(FID, 1n, 90);
  });

  // ── delay above threshold — Cancelled status ──────────────────────────────

  it("marks claimable when status=Cancelled (delay minutes irrelevant)", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Cancelled, 0, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.true;
  });

  it("marks claimable for Cancelled even when delayMinutes is 0 (below threshold)", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Cancelled, 0, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);
    expect((await ifa.policyInfo(FID)).claimable).to.be.true;
  });

  // ── idempotency ───────────────────────────────────────────────────────────

  it("second call on already-claimable flight is a no-op (no revert, no double-emit)", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, 90, "src");

    // First call — sets claimable, emits event.
    await ifa.connect(anyone).checkFlightDelay(FID);

    // Advance past cooldown.
    await time.increase(CHECK_COOLDOWN + 1);

    // Second call — no revert, no second DelayConfirmed event.
    const tx = await ifa.connect(anyone).checkFlightDelay(FID);
    await expect(tx).to.not.emit(ifa, "DelayConfirmed");
    expect((await ifa.policyInfo(FID)).claimable).to.be.true;
  });

  // ── rate limit ────────────────────────────────────────────────────────────

  it("reverts on second call within checkCooldownSeconds", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Scheduled, 0, "src");
    await ifa.connect(anyone).checkFlightDelay(FID); // first call ok

    await expect(ifa.connect(anyone).checkFlightDelay(FID))
      .to.be.revertedWith("IFA: check too soon");
  });

  it("allows a second call after checkCooldownSeconds has elapsed", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Scheduled, 0, "src");
    await ifa.connect(anyone).checkFlightDelay(FID);

    await time.increase(CHECK_COOLDOWN + 1);

    await expect(ifa.connect(anyone).checkFlightDelay(FID)).to.not.be.reverted;
  });

  it("updates lastCheckTimestamp on each call", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Scheduled, 0, "src");

    await ifa.connect(anyone).checkFlightDelay(FID);
    const ts1 = await ifa.lastCheckTimestamp(FID);

    await time.increase(CHECK_COOLDOWN + 1);

    await ifa.connect(anyone).checkFlightDelay(FID);
    const ts2 = await ifa.lastCheckTimestamp(FID);

    expect(ts2).to.be.gt(ts1);
  });

  it("rate-limit is per-flight — different flights have independent cooldowns", async () => {
    const FID2 = flightId("KQ101");
    await insureOne(ifa, passenger, FID2, toWei("100"));

    await oracle.connect(owner).updateFlight(FID,  FlightStatus.Scheduled, 0, "src");
    await oracle.connect(owner).updateFlight(FID2, FlightStatus.Scheduled, 0, "src");

    await ifa.connect(anyone).checkFlightDelay(FID);  // consumes FID cooldown
    // FID2 cooldown is still fresh — should succeed
    await expect(ifa.connect(anyone).checkFlightDelay(FID2)).to.not.be.reverted;
  });

  // ── anyone can call ───────────────────────────────────────────────────────

  it("can be called by any address (permissionless)", async () => {
    await oracle.connect(owner).updateFlight(FID, FlightStatus.Delayed, 90, "src");
    await expect(ifa.connect(anyone).checkFlightDelay(FID)).to.not.be.reverted;
  });

  // ── paused ────────────────────────────────────────────────────────────────

  it("reverts when contract is paused", async () => {
    await ifa.connect(owner).pause();
    await expect(ifa.connect(anyone).checkFlightDelay(FID))
      .to.be.revertedWithCustomError(ifa, "EnforcedPause");
  });
});
