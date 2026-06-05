import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { FlightOracle } from "../../typechain-types";

// ─── helpers ─────────────────────────────────────────────────────────────────

const flightId = (raw: string) =>
  ethers.keccak256(ethers.toUtf8Bytes(raw));

enum FlightStatus {
  Scheduled = 0,
  Delayed   = 1,
  Cancelled = 2,
  Landed    = 3,
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("FlightOracle", () => {
  let oracle: FlightOracle;
  let admin: SignerWithAddress;
  let updater: SignerWithAddress;
  let stranger: SignerWithAddress;

  const UPDATER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
  const FID = flightId("ET309");

  beforeEach(async () => {
    [admin, updater, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("FlightOracle");
    oracle = (await Factory.deploy(admin.address)) as FlightOracle;
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("reverts on zero admin address", async () => {
      const Factory = await ethers.getContractFactory("FlightOracle");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "FlightOracle: zero admin"
      );
    });

    it("grants DEFAULT_ADMIN_ROLE to the admin", async () => {
      const DEFAULT_ADMIN_ROLE = await oracle.DEFAULT_ADMIN_ROLE();
      expect(await oracle.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("grants UPDATER_ROLE to the admin at deployment", async () => {
      expect(await oracle.hasRole(UPDATER_ROLE, admin.address)).to.be.true;
    });
  });

  // ── access control ─────────────────────────────────────────────────────────

  describe("access control", () => {
    it("allows admin to write a flight record", async () => {
      await expect(
        oracle.connect(admin).updateFlight(FID, FlightStatus.Delayed, 45, "FlightAware")
      ).to.not.be.reverted;
    });

    it("allows a granted UPDATER_ROLE account to write", async () => {
      await oracle.connect(admin).grantRole(UPDATER_ROLE, updater.address);
      await expect(
        oracle.connect(updater).updateFlight(FID, FlightStatus.Delayed, 45, "FlightAware")
      ).to.not.be.reverted;
    });

    it("reverts when a stranger attempts to write", async () => {
      await expect(
        oracle.connect(stranger).updateFlight(FID, FlightStatus.Delayed, 45, "FlightAware")
      ).to.be.reverted;
    });

    it("reverts after UPDATER_ROLE is revoked", async () => {
      await oracle.connect(admin).grantRole(UPDATER_ROLE, updater.address);
      await oracle.connect(admin).revokeRole(UPDATER_ROLE, updater.address);
      await expect(
        oracle.connect(updater).updateFlight(FID, FlightStatus.Delayed, 45, "FlightAware")
      ).to.be.reverted;
    });

    it("reverts on zero flightId", async () => {
      await expect(
        oracle.connect(admin).updateFlight(
          ethers.ZeroHash, FlightStatus.Delayed, 45, "FlightAware"
        )
      ).to.be.revertedWith("FlightOracle: zero flightId");
    });
  });

  // ── write and event ────────────────────────────────────────────────────────

  describe("updateFlight", () => {
    it("emits FlightStatusUpdated with correct args", async () => {
      const tx = await oracle
        .connect(admin)
        .updateFlight(FID, FlightStatus.Delayed, 60, "FlightAware");

      const receipt = await tx.wait();
      const block   = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(oracle, "FlightStatusUpdated")
        .withArgs(FID, FlightStatus.Delayed, 60, block!.timestamp);
    });

    it("overwrites an existing record on second write", async () => {
      await oracle.connect(admin).updateFlight(FID, FlightStatus.Scheduled, 0, "src1");
      await oracle.connect(admin).updateFlight(FID, FlightStatus.Delayed, 90, "src2");

      const record = await oracle.getFlightRecord(FID);
      expect(record.status).to.equal(FlightStatus.Delayed);
      expect(record.delayMinutes).to.equal(90);
      expect(record.source).to.equal("src2");
    });

    it("stores all four fields correctly", async () => {
      const tx = await oracle
        .connect(admin)
        .updateFlight(FID, FlightStatus.Cancelled, 120, "OAG");

      const receipt = await tx.wait();
      const block   = await ethers.provider.getBlock(receipt!.blockNumber);
      const record  = await oracle.getFlightRecord(FID);

      expect(record.status).to.equal(FlightStatus.Cancelled);
      expect(record.delayMinutes).to.equal(120);
      expect(record.source).to.equal("OAG");
      expect(record.updatedAt).to.equal(block!.timestamp);
    });
  });

  // ── read functions ─────────────────────────────────────────────────────────

  describe("read functions", () => {
    beforeEach(async () => {
      await oracle.connect(admin).updateFlight(FID, FlightStatus.Delayed, 75, "FlightAware");
    });

    it("getFlightRecord returns the correct record", async () => {
      const record = await oracle.getFlightRecord(FID);
      expect(record.status).to.equal(FlightStatus.Delayed);
      expect(record.delayMinutes).to.equal(75);
      expect(record.source).to.equal("FlightAware");
      expect(record.updatedAt).to.be.gt(0n);
    });

    it("getDelayMinutes returns the correct delay", async () => {
      expect(await oracle.getDelayMinutes(FID)).to.equal(75);
    });

    it("getStatus returns the correct status", async () => {
      expect(await oracle.getStatus(FID)).to.equal(FlightStatus.Delayed);
    });

    it("returns zero-value record for an unknown flightId", async () => {
      const unknown = flightId("UNKNOWN999");
      const record  = await oracle.getFlightRecord(unknown);
      expect(record.updatedAt).to.equal(0n);
      expect(record.delayMinutes).to.equal(0);
    });

    it("getDelayMinutes returns 0 for unknown flightId", async () => {
      expect(await oracle.getDelayMinutes(flightId("NONE"))).to.equal(0);
    });

    it("getStatus returns Scheduled (0) for unknown flightId", async () => {
      expect(await oracle.getStatus(flightId("NONE"))).to.equal(FlightStatus.Scheduled);
    });
  });

  // ── all statuses ───────────────────────────────────────────────────────────

  describe("FlightStatus enum values", () => {
    const cases: [string, FlightStatus, number][] = [
      ["Scheduled", FlightStatus.Scheduled, 0],
      ["Delayed",   FlightStatus.Delayed,   45],
      ["Cancelled", FlightStatus.Cancelled, 999],
      ["Landed",    FlightStatus.Landed,    0],
    ];

    for (const [label, status, delay] of cases) {
      it(`stores and retrieves status ${label}`, async () => {
        await oracle.connect(admin).updateFlight(FID, status, delay, "test");
        expect(await oracle.getStatus(FID)).to.equal(status);
        expect(await oracle.getDelayMinutes(FID)).to.equal(delay);
      });
    }
  });
});
