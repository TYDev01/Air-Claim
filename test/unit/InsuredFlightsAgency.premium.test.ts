import { expect } from "chai";
import { ethers } from "hardhat";
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

const BASE_FEE          = toWei("0.001");   // 0.001 CELO flat fee per passenger
const DELAY_THRESHOLD   = 30;              // minutes
const MAX_STALENESS     = 3600;            // seconds
const CHECK_COOLDOWN    = 300;             // seconds
const CELO_PRICE        = 50_000_000n;     // $0.50 with 8 decimals
const FEED_DECIMALS     = 8;

// ─── shared deploy fixture ───────────────────────────────────────────────────

async function deployIFA(owner: SignerWithAddress) {
  const OracleFactory    = await ethers.getContractFactory("FlightOracle");
  const FeedFactory      = await ethers.getContractFactory("PriceFeedDouble");
  const StableFactory    = await ethers.getContractFactory("StablecoinDouble");
  const AgencyFactory    = await ethers.getContractFactory("InsuredFlightsAgency");

  const oracle    = (await OracleFactory.deploy(owner.address))              as FlightOracle;
  const feed      = (await FeedFactory.deploy(CELO_PRICE, FEED_DECIMALS))   as PriceFeedDouble;
  const stablecoin = (await StableFactory.deploy("cUSD", "cUSD", 18))       as StablecoinDouble;

  const ifa = (await AgencyFactory.deploy(
    await oracle.getAddress(),
    await feed.getAddress(),
    await stablecoin.getAddress(),
    DELAY_THRESHOLD,
    BASE_FEE,
    MAX_STALENESS,
    CHECK_COOLDOWN,
  )) as InsuredFlightsAgency;

  return { oracle, feed, stablecoin, ifa };
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("InsuredFlightsAgency — premium math", () => {
  let owner: SignerWithAddress;
  let passenger1: SignerWithAddress;
  let passenger2: SignerWithAddress;
  let stranger: SignerWithAddress;

  let ifa: InsuredFlightsAgency;

  const FID          = flightId("ET309");
  const FLIGHT_DATE  = BigInt(Math.floor(Date.now() / 1000) + 86_400); // tomorrow

  beforeEach(async () => {
    [owner, passenger1, passenger2, stranger] = await ethers.getSigners();
    ({ ifa } = await deployIFA(owner));
  });

  // ── constructor validation ────────────────────────────────────────────────

  describe("constructor", () => {
    it("reverts on zero oracle address", async () => {
      const Factory = await ethers.getContractFactory("InsuredFlightsAgency");
      const { feed, stablecoin } = await deployIFA(owner);
      await expect(
        Factory.deploy(
          ethers.ZeroAddress,
          await feed.getAddress(),
          await stablecoin.getAddress(),
          DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
        )
      ).to.be.revertedWith("IFA: zero oracle");
    });

    it("reverts on zero price feed address", async () => {
      const Factory = await ethers.getContractFactory("InsuredFlightsAgency");
      const { oracle, stablecoin } = await deployIFA(owner);
      await expect(
        Factory.deploy(
          await oracle.getAddress(),
          ethers.ZeroAddress,
          await stablecoin.getAddress(),
          DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
        )
      ).to.be.revertedWith("IFA: zero feed");
    });

    it("reverts on zero stablecoin address", async () => {
      const Factory = await ethers.getContractFactory("InsuredFlightsAgency");
      const { oracle, feed } = await deployIFA(owner);
      await expect(
        Factory.deploy(
          await oracle.getAddress(),
          await feed.getAddress(),
          ethers.ZeroAddress,
          DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
        )
      ).to.be.revertedWith("IFA: zero stablecoin");
    });

    it("reverts on zero delay threshold", async () => {
      const Factory = await ethers.getContractFactory("InsuredFlightsAgency");
      const { oracle, feed, stablecoin } = await deployIFA(owner);
      await expect(
        Factory.deploy(
          await oracle.getAddress(),
          await feed.getAddress(),
          await stablecoin.getAddress(),
          0, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
        )
      ).to.be.revertedWith("IFA: zero threshold");
    });

    it("reads stablecoinDecimals from the token at construction (18)", async () => {
      expect(await ifa.stablecoinDecimals()).to.equal(18);
    });

    it("reads stablecoinDecimals from a 6-decimal token", async () => {
      const Factory       = await ethers.getContractFactory("InsuredFlightsAgency");
      const StableFactory = await ethers.getContractFactory("StablecoinDouble");
      const FeedFactory   = await ethers.getContractFactory("PriceFeedDouble");
      const OracleFactory = await ethers.getContractFactory("FlightOracle");

      const oracle6   = await OracleFactory.deploy(owner.address);
      const feed6     = await FeedFactory.deploy(CELO_PRICE, 8);
      const stable6   = await StableFactory.deploy("USDC", "USDC", 6);

      const ifa6 = await Factory.deploy(
        await oracle6.getAddress(),
        await feed6.getAddress(),
        await stable6.getAddress(),
        DELAY_THRESHOLD, BASE_FEE, MAX_STALENESS, CHECK_COOLDOWN,
      );
      expect(await ifa6.stablecoinDecimals()).to.equal(6);
    });
  });

  // ── premiumFor view ───────────────────────────────────────────────────────

  describe("premiumFor()", () => {
    it("single passenger: 10% of ticket + baseFee", async () => {
      const ticket   = toWei("100");
      const expected = ticket / 10n + BASE_FEE;
      expect(await ifa.premiumFor([ticket])).to.equal(expected);
    });

    it("two passengers: sum of each (10% + baseFee)", async () => {
      const t1       = toWei("100");
      const t2       = toWei("200");
      const expected = (t1 / 10n + BASE_FEE) + (t2 / 10n + BASE_FEE);
      expect(await ifa.premiumFor([t1, t2])).to.equal(expected);
    });

    it("baseFee=0: premium equals exactly 10% of ticket", async () => {
      await ifa.connect(owner).setBaseFee(0n);
      const ticket = toWei("50");
      expect(await ifa.premiumFor([ticket])).to.equal(ticket / 10n);
    });

    it("returns 0 for an empty array", async () => {
      expect(await ifa.premiumFor([])).to.equal(0n);
    });
  });

  // ── insureFlight — premium validation ────────────────────────────────────

  describe("insureFlight — premium validation", () => {
    const ticket     = toWei("100");
    const onePassenger = async () => {
      const premium = await ifa.premiumFor([ticket]);
      return ifa.connect(passenger1).insureFlight(
        FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
        [passenger1.address], [ticket],
        { value: premium }
      );
    };

    it("accepts exact premium for single passenger", async () => {
      await expect(onePassenger()).to.not.be.reverted;
    });

    it("reverts when msg.value is too low (underpayment)", async () => {
      const premium = await ifa.premiumFor([ticket]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger1.address], [ticket],
          { value: premium - 1n }
        )
      ).to.be.revertedWith("IFA: wrong premium");
    });

    it("reverts when msg.value is too high (overpayment)", async () => {
      const premium = await ifa.premiumFor([ticket]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger1.address], [ticket],
          { value: premium + 1n }
        )
      ).to.be.revertedWith("IFA: wrong premium");
    });

    it("accepts exact premium for two passengers", async () => {
      const t1      = toWei("100");
      const t2      = toWei("200");
      const premium = await ifa.premiumFor([t1, t2]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger1.address, passenger2.address], [t1, t2],
          { value: premium }
        )
      ).to.not.be.reverted;
    });

    it("emits FlightInsured with correct policyId, flightId, and totalPremium", async () => {
      const premium = await ifa.premiumFor([ticket]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger1.address], [ticket],
          { value: premium }
        )
      )
        .to.emit(ifa, "FlightInsured")
        .withArgs(1n, FID, "ET309", [passenger1.address], premium);
    });

    it("auto-increments policyId on successive insure calls", async () => {
      const FID2    = flightId("KQ101");
      const premium = await ifa.premiumFor([ticket]);

      await ifa.connect(passenger1).insureFlight(
        FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
        [passenger1.address], [ticket], { value: premium }
      );

      const FLIGHT_DATE2 = FLIGHT_DATE + 3600n;
      const tx = await ifa.connect(passenger2).insureFlight(
        FID2, "KQ101", "NBO", "LHR", FLIGHT_DATE2,
        [passenger2.address], [ticket], { value: premium }
      );
      await expect(tx).to.emit(ifa, "FlightInsured").withArgs(
        2n, FID2, "KQ101", [passenger2.address], premium
      );
    });

    it("reverts on duplicate flightId", async () => {
      const premium = await ifa.premiumFor([ticket]);
      await ifa.connect(passenger1).insureFlight(
        FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
        [passenger1.address], [ticket], { value: premium }
      );
      await expect(
        ifa.connect(passenger2).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger2.address], [ticket], { value: premium }
        )
      ).to.be.revertedWith("IFA: policy exists");
    });

    it("reverts on mismatched passengers/ticketPrices arrays", async () => {
      const premium = await ifa.premiumFor([ticket]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger1.address], [ticket, ticket],
          { value: premium }
        )
      ).to.be.revertedWith("IFA: length mismatch");
    });

    it("reverts on zero ticket price", async () => {
      const premium = BASE_FEE; // 10% of 0 + baseFee
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [passenger1.address], [0n],
          { value: premium }
        )
      ).to.be.revertedWith("IFA: zero ticket price");
    });

    it("reverts on zero passenger address", async () => {
      const premium = await ifa.premiumFor([ticket]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
          [ethers.ZeroAddress], [ticket],
          { value: premium }
        )
      ).to.be.revertedWith("IFA: zero passenger");
    });

    it("reverts when flightDate is in the past", async () => {
      const pastDate = BigInt(Math.floor(Date.now() / 1000) - 1);
      const premium  = await ifa.premiumFor([ticket]);
      await expect(
        ifa.connect(passenger1).insureFlight(
          FID, "ET309", "ADD", "LHR", pastDate,
          [passenger1.address], [ticket],
          { value: premium }
        )
      ).to.be.revertedWith("IFA: flight date in past");
    });

    it("reservedForClaims increases by 10% of ticket price after insure", async () => {
      const premium  = await ifa.premiumFor([ticket]);
      const before   = await ifa.reservedForClaims();
      await ifa.connect(passenger1).insureFlight(
        FID, "ET309", "ADD", "LHR", FLIGHT_DATE,
        [passenger1.address], [ticket], { value: premium }
      );
      const after = await ifa.reservedForClaims();
      expect(after - before).to.equal(ticket / 10n);
    });
  });
});
