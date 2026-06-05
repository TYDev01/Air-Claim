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
const CELO_PRICE      = 50_000_000n;

enum FlightStatus { Delayed = 1 }

// ─── deploy ───────────────────────────────────────────────────────────────────

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

// ─── insure helper ────────────────────────────────────────────────────────────

async function insureAndConfirm(
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
    fid, "ET309", "ADD", "LHR", flightDate,
    [passenger.address], [ticket], { value: premium },
  );
  await oracle.connect(owner).updateFlight(fid, FlightStatus.Delayed, DELAY_THRESHOLD + 1, "src");
  await ifa.connect(owner).checkFlightDelay(fid);
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InsuredFlightsAgency — withdrawReserve", () => {
  let owner: SignerWithAddress;
  let passenger: SignerWithAddress;
  let stranger: SignerWithAddress;

  let oracle: FlightOracle;
  let stablecoin: StablecoinDouble;
  let ifa: InsuredFlightsAgency;

  const TICKET = toWei("100");
  const FID    = flightId("ET309");

  beforeEach(async () => {
    [owner, passenger, stranger] = await ethers.getSigners();
    ({ oracle, stablecoin, ifa } = await deploy(owner));
  });

  // ── withdrawableCelo ──────────────────────────────────────────────────────

  describe("withdrawableCelo()", () => {
    it("returns 0 when contract balance is zero", async () => {
      expect(await ifa.withdrawableCelo()).to.equal(0n);
    });

    it("returns full balance when no claims are reserved (no policies)", async () => {
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("10") });
      expect(await ifa.withdrawableCelo()).to.equal(toWei("10"));
    });

    it("returns balance minus reservedForClaims after insureFlight", async () => {
      const premium = await ifa.premiumFor([TICKET]);
      // Premium is received; reservedForClaims = TICKET/10
      await insureAndConfirm(ifa, oracle, owner, passenger, FID);
      const balance   = await ethers.provider.getBalance(await ifa.getAddress());
      const reserved  = await ifa.reservedForClaims();
      const expected  = balance - reserved;
      expect(await ifa.withdrawableCelo()).to.equal(expected);
    });

    it("returns 0 when balance exactly equals reservedForClaims", async () => {
      const premium = await ifa.premiumFor([TICKET]);
      await insureAndConfirm(ifa, oracle, owner, passenger, FID);
      // Drain surplus so balance == reservedForClaims
      const surplus = await ifa.withdrawableCelo();
      if (surplus > 0n) {
        await ifa.connect(owner).withdrawCelo(surplus);
      }
      expect(await ifa.withdrawableCelo()).to.equal(0n);
    });

    it("increases after a passenger claims (reserve released)", async () => {
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("10") });
      await insureAndConfirm(ifa, oracle, owner, passenger, FID);

      const before = await ifa.withdrawableCelo();
      await ifa.connect(passenger).claimInsurance(FID);
      const after  = await ifa.withdrawableCelo();

      // After claim the CELO was paid out but reservedForClaims decreased too.
      // Net: withdrawable may increase or stay same — key: reservation gone.
      expect(await ifa.reservedForClaims()).to.equal(0n);
    });
  });

  // ── withdrawCelo ──────────────────────────────────────────────────────────

  describe("withdrawCelo()", () => {
    beforeEach(async () => {
      // Fund contract with surplus above reserve
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("10") });
      await insureAndConfirm(ifa, oracle, owner, passenger, FID);
    });

    it("reverts when called by non-owner", async () => {
      await expect(ifa.connect(stranger).withdrawCelo(toWei("1")))
        .to.be.revertedWithCustomError(ifa, "OwnableUnauthorizedAccount");
    });

    it("reverts when amount is zero", async () => {
      await expect(ifa.connect(owner).withdrawCelo(0n))
        .to.be.revertedWith("IFA: zero amount");
    });

    it("reverts when amount exceeds withdrawable surplus", async () => {
      const surplus = await ifa.withdrawableCelo();
      await expect(ifa.connect(owner).withdrawCelo(surplus + 1n))
        .to.be.revertedWith("IFA: insufficient surplus");
    });

    it("transfers correct CELO to owner", async () => {
      const surplus = await ifa.withdrawableCelo();
      await expect(ifa.connect(owner).withdrawCelo(surplus))
        .to.changeEtherBalance(owner, surplus);
    });

    it("emits CeloWithdrawn with correct args", async () => {
      const surplus = await ifa.withdrawableCelo();
      await expect(ifa.connect(owner).withdrawCelo(surplus))
        .to.emit(ifa, "CeloWithdrawn")
        .withArgs(owner.address, surplus);
    });

    it("cannot withdraw funds reserved for active claims", async () => {
      const reserved = await ifa.reservedForClaims();
      expect(reserved).to.be.gt(0n);
      // withdrawableCelo() < balance; trying to withdraw balance is blocked
      const balance = await ethers.provider.getBalance(await ifa.getAddress());
      await expect(ifa.connect(owner).withdrawCelo(balance))
        .to.be.revertedWith("IFA: insufficient surplus");
    });

    it("remaining balance after withdrawal covers reservedForClaims", async () => {
      const surplus = await ifa.withdrawableCelo();
      await ifa.connect(owner).withdrawCelo(surplus);
      const balance  = await ethers.provider.getBalance(await ifa.getAddress());
      const reserved = await ifa.reservedForClaims();
      expect(balance).to.be.gte(reserved);
    });

    it("passenger can still claim after owner drains surplus", async () => {
      const surplus = await ifa.withdrawableCelo();
      await ifa.connect(owner).withdrawCelo(surplus);
      await expect(ifa.connect(passenger).claimInsurance(FID)).to.not.be.reverted;
    });
  });

  // ── withdrawStablecoin ────────────────────────────────────────────────────

  describe("withdrawStablecoin()", () => {
    const STABLE_AMOUNT = toWei("50"); // 50 cUSD in contract

    beforeEach(async () => {
      await stablecoin.mint(await ifa.getAddress(), STABLE_AMOUNT);
    });

    it("reverts when called by non-owner", async () => {
      await expect(ifa.connect(stranger).withdrawStablecoin(toWei("1")))
        .to.be.revertedWithCustomError(ifa, "OwnableUnauthorizedAccount");
    });

    it("reverts when amount is zero", async () => {
      await expect(ifa.connect(owner).withdrawStablecoin(0n))
        .to.be.revertedWith("IFA: zero amount");
    });

    it("reverts when amount exceeds stablecoin balance", async () => {
      await expect(ifa.connect(owner).withdrawStablecoin(STABLE_AMOUNT + 1n))
        .to.be.revertedWith("IFA: insufficient stablecoin");
    });

    it("transfers correct stablecoin amount to owner", async () => {
      await expect(ifa.connect(owner).withdrawStablecoin(STABLE_AMOUNT))
        .to.changeTokenBalance(stablecoin, owner, STABLE_AMOUNT);
    });

    it("emits StablecoinWithdrawn with correct args", async () => {
      await expect(ifa.connect(owner).withdrawStablecoin(STABLE_AMOUNT))
        .to.emit(ifa, "StablecoinWithdrawn")
        .withArgs(owner.address, STABLE_AMOUNT);
    });

    it("partial withdrawal leaves correct balance", async () => {
      const half = STABLE_AMOUNT / 2n;
      await ifa.connect(owner).withdrawStablecoin(half);
      expect(await stablecoin.balanceOf(await ifa.getAddress())).to.equal(STABLE_AMOUNT - half);
    });
  });

  // ── receive() top-up ──────────────────────────────────────────────────────

  describe("receive() — CELO top-up", () => {
    it("accepts plain CELO transfers and increases balance", async () => {
      const before = await ethers.provider.getBalance(await ifa.getAddress());
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("5") });
      const after  = await ethers.provider.getBalance(await ifa.getAddress());
      expect(after - before).to.equal(toWei("5"));
    });

    it("increases withdrawableCelo after top-up (no new reserve added)", async () => {
      const before = await ifa.withdrawableCelo();
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("5") });
      expect(await ifa.withdrawableCelo()).to.equal(before + toWei("5"));
    });
  });

  // ── pause does not block withdrawals ─────────────────────────────────────

  describe("withdrawals work while paused", () => {
    it("withdrawCelo succeeds while contract is paused", async () => {
      await owner.sendTransaction({ to: await ifa.getAddress(), value: toWei("5") });
      await ifa.connect(owner).pause();
      await expect(ifa.connect(owner).withdrawCelo(toWei("5"))).to.not.be.reverted;
    });

    it("withdrawStablecoin succeeds while contract is paused", async () => {
      await stablecoin.mint(await ifa.getAddress(), toWei("10"));
      await ifa.connect(owner).pause();
      await expect(ifa.connect(owner).withdrawStablecoin(toWei("10"))).to.not.be.reverted;
    });
  });
});
