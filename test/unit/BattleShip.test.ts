import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { BattleShip, RandomnessDouble } from "../../typechain-types";

// ─── helpers ─────────────────────────────────────────────────────────────────

const toWei = (n: string) => ethers.parseEther(n);

const STAKE_CAP   = toWei("10");
const HOUSE_FUND  = toWei("50"); // covers stake(1) * 2 many times
const PREDICTION  = 5;          // player's chosen box for most tests

// A seed where seed % 16 == PREDICTION → WIN
const WIN_SEED  = BigInt(PREDICTION);          // 5 % 16 = 5 ✓
// A seed where seed % 16 != PREDICTION → LOSE
const LOSE_SEED = BigInt(PREDICTION + 1);     // 6 % 16 = 6 ✗

// RandomnessDouble ignores operatorSeed — ZeroHash is valid 32 bytes.
const OP_SEED = ethers.ZeroHash;

// ─── deploy ───────────────────────────────────────────────────────────────────

async function deploy(owner: SignerWithAddress) {
  const rnd = await (await ethers.getContractFactory("RandomnessDouble")).deploy() as RandomnessDouble;
  const bs  = await (await ethers.getContractFactory("BattleShip")).deploy(
    await rnd.getAddress(), STAKE_CAP,
  ) as BattleShip;
  return { bs, rnd };
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe("BattleShip", () => {
  let owner: SignerWithAddress;
  let player: SignerWithAddress;
  let stranger: SignerWithAddress;

  let bs: BattleShip;
  let rnd: RandomnessDouble;

  beforeEach(async () => {
    [owner, player, stranger] = await ethers.getSigners();
    ({ bs, rnd } = await deploy(owner));
    await bs.connect(owner).fund({ value: HOUSE_FUND });
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("reverts on zero randomness address", async () => {
      const F = await ethers.getContractFactory("BattleShip");
      await expect(F.deploy(ethers.ZeroAddress, STAKE_CAP))
        .to.be.revertedWith("BS: zero randomness");
    });

    it("reverts on zero stakeCap", async () => {
      const F = await ethers.getContractFactory("BattleShip");
      await expect(F.deploy(await rnd.getAddress(), 0n))
        .to.be.revertedWith("BS: zero stake cap");
    });

    it("sets correct stakeCap and randomness address", async () => {
      expect(await bs.stakeCap()).to.equal(STAKE_CAP);
      expect(await bs.randomness()).to.equal(await rnd.getAddress());
    });
  });

  // ── config / house management ─────────────────────────────────────────────

  describe("setStakeCap", () => {
    it("reverts for non-owner", async () => {
      await expect(bs.connect(stranger).setStakeCap(toWei("1")))
        .to.be.revertedWithCustomError(bs, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero cap", async () => {
      await expect(bs.connect(owner).setStakeCap(0n))
        .to.be.revertedWith("BS: zero cap");
    });

    it("updates stakeCap and emits StakeCapUpdated", async () => {
      await expect(bs.connect(owner).setStakeCap(toWei("5")))
        .to.emit(bs, "StakeCapUpdated").withArgs(toWei("5"));
      expect(await bs.stakeCap()).to.equal(toWei("5"));
    });
  });

  describe("fund / withdrawHouse", () => {
    it("fund increases house balance and emits HouseFunded", async () => {
      await expect(bs.connect(owner).fund({ value: toWei("1") }))
        .to.emit(bs, "HouseFunded").withArgs(owner.address, toWei("1"));
    });

    it("withdrawHouse reverts for non-owner", async () => {
      await expect(bs.connect(stranger).withdrawHouse(toWei("1")))
        .to.be.revertedWithCustomError(bs, "OwnableUnauthorizedAccount");
    });

    it("withdrawHouse reverts when amount exceeds balance", async () => {
      const bal = await ethers.provider.getBalance(await bs.getAddress());
      await expect(bs.connect(owner).withdrawHouse(bal + 1n))
        .to.be.revertedWith("BS: insufficient balance");
    });

    it("withdrawHouse transfers CELO to owner and emits HouseWithdrawn", async () => {
      await expect(bs.connect(owner).withdrawHouse(toWei("1")))
        .to.emit(bs, "HouseWithdrawn").withArgs(owner.address, toWei("1"));
    });

    it("receive() accepts plain CELO and emits HouseFunded", async () => {
      await expect(owner.sendTransaction({ to: await bs.getAddress(), value: toWei("1") }))
        .to.emit(bs, "HouseFunded").withArgs(owner.address, toWei("1"));
    });
  });

  // ── placeBet ──────────────────────────────────────────────────────────────

  describe("placeBet", () => {
    let requestId: bigint;

    beforeEach(async () => {
      requestId = await rnd.prepareRequest.staticCall(WIN_SEED);
      await rnd.prepareRequest(WIN_SEED);
    });

    it("reverts on zero stake", async () => {
      await expect(bs.connect(player).placeBet(PREDICTION, requestId, { value: 0n }))
        .to.be.revertedWith("BS: zero stake");
    });

    it("reverts when stake exceeds cap", async () => {
      await expect(bs.connect(player).placeBet(PREDICTION, requestId, { value: STAKE_CAP + 1n }))
        .to.be.revertedWith("BS: stake exceeds cap");
    });

    it("reverts on prediction >= BOX_COUNT (16)", async () => {
      await expect(bs.connect(player).placeBet(16, requestId, { value: toWei("1") }))
        .to.be.revertedWith("BS: invalid box");
    });

    it("accepts all valid box indices [0, 15]", async () => {
      for (let box = 0; box <= 15; box++) {
        const seed  = BigInt(box);
        const reqId = await rnd.prepareRequest.staticCall(seed);
        await rnd.prepareRequest(seed);
        await expect(bs.connect(player).placeBet(box, reqId, { value: toWei("0.001") }))
          .to.not.be.reverted;
      }
    });

    it("reverts when request is not pending", async () => {
      await expect(bs.connect(player).placeBet(PREDICTION, 999n, { value: toWei("1") }))
        .to.be.revertedWith("BS: request not pending");
    });

    it("reverts when requestId already in use", async () => {
      await bs.connect(player).placeBet(PREDICTION, requestId, { value: toWei("1") });
      await expect(bs.connect(stranger).placeBet(PREDICTION, requestId, { value: toWei("1") }))
        .to.be.revertedWith("BS: requestId in use");
    });

    it("reverts when house cannot cover payout (balance < stake × 2)", async () => {
      const bal = await ethers.provider.getBalance(await bs.getAddress());
      await bs.connect(owner).withdrawHouse(bal);
      await expect(bs.connect(player).placeBet(PREDICTION, requestId, { value: toWei("0.01") }))
        .to.be.revertedWith("BS: house cannot cover payout");
    });

    it("emits BattlePlaced with correct args", async () => {
      const stake = toWei("1");
      await expect(bs.connect(player).placeBet(PREDICTION, requestId, { value: stake }))
        .to.emit(bs, "BattlePlaced")
        .withArgs(1n, player.address, stake, PREDICTION, requestId);
    });

    it("betIdForRequest returns the correct betId", async () => {
      await bs.connect(player).placeBet(PREDICTION, requestId, { value: toWei("1") });
      expect(await bs.betIdForRequest(requestId)).to.equal(1n);
    });

    it("userEntropyFor is deterministic from on-chain bet data", async () => {
      const stake = toWei("1");
      await bs.connect(player).placeBet(PREDICTION, requestId, { value: stake });
      const entropy  = await bs.userEntropyFor(1n);
      const expected = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "uint8", "uint256", "uint256"],
          [player.address, PREDICTION, stake, 1n],
        ),
      );
      expect(entropy).to.equal(expected);
    });
  });

  // ── settleBet — win ───────────────────────────────────────────────────────

  describe("settleBet — win", () => {
    const stake = toWei("1");
    let betId: bigint;

    beforeEach(async () => {
      const reqId = await rnd.prepareRequest.staticCall(WIN_SEED);
      await rnd.prepareRequest(WIN_SEED);
      await bs.connect(player).placeBet(PREDICTION, reqId, { value: stake });
      betId = await bs.betIdForRequest(reqId);
    });

    it("emits BattleResult with won=true and correct dropBox", async () => {
      const dropBox = Number(WIN_SEED % 16n);
      expect(dropBox).to.equal(PREDICTION); // confirm our seed engineering
      await expect(bs.connect(owner).settleBet(betId, OP_SEED))
        .to.emit(bs, "BattleResult")
        .withArgs(betId, player.address, PREDICTION, dropBox, true, stake * 2n);
    });

    it("player receives 2× stake on correct prediction", async () => {
      await expect(bs.connect(owner).settleBet(betId, OP_SEED))
        .to.changeEtherBalance(player, stake * 2n);
    });

    it("house balance decreases by 2×stake on win (snapshot taken post-placeBet)", async () => {
      const before = await ethers.provider.getBalance(await bs.getAddress());
      await bs.connect(owner).settleBet(betId, OP_SEED);
      const after  = await ethers.provider.getBalance(await bs.getAddress());
      // before already includes the received stake; payout is 2×stake → diff = 2×stake
      expect(before - after).to.equal(stake * 2n);
    });
  });

  // ── settleBet — lose ──────────────────────────────────────────────────────

  describe("settleBet — lose", () => {
    const stake = toWei("1");
    let betId: bigint;

    beforeEach(async () => {
      const reqId = await rnd.prepareRequest.staticCall(LOSE_SEED);
      await rnd.prepareRequest(LOSE_SEED);
      await bs.connect(player).placeBet(PREDICTION, reqId, { value: stake });
      betId = await bs.betIdForRequest(reqId);
    });

    it("emits BattleResult with won=false and payout=0", async () => {
      const dropBox = Number(LOSE_SEED % 16n);
      expect(dropBox).to.not.equal(PREDICTION);
      await expect(bs.connect(owner).settleBet(betId, OP_SEED))
        .to.emit(bs, "BattleResult")
        .withArgs(betId, player.address, PREDICTION, dropBox, false, 0n);
    });

    it("player receives nothing on wrong prediction", async () => {
      await expect(bs.connect(owner).settleBet(betId, OP_SEED))
        .to.changeEtherBalance(player, 0n);
    });

    it("house keeps stake on loss", async () => {
      const before = await ethers.provider.getBalance(await bs.getAddress());
      await bs.connect(owner).settleBet(betId, OP_SEED);
      const after  = await ethers.provider.getBalance(await bs.getAddress());
      // House received stake at placeBet and does not pay out → balance unchanged
      expect(after).to.equal(before);
    });
  });

  // ── settleBet — all 16 boxes ───────────────────────────────────────────────

  describe("settleBet — all 16 boxes win correctly", () => {
    const stake = toWei("0.001");

    for (let box = 0; box <= 15; box++) {
      it(`box ${box}: seed ${box} → dropBox ${box} → win`, async () => {
        const seed  = BigInt(box);
        expect(Number(seed % 16n)).to.equal(box); // confirm seed engineering

        const reqId = await rnd.prepareRequest.staticCall(seed);
        await rnd.prepareRequest(seed);
        await bs.connect(player).placeBet(box, reqId, { value: stake });
        const betId_ = await bs.betIdForRequest(reqId);

        await expect(bs.connect(owner).settleBet(betId_, OP_SEED))
          .to.emit(bs, "BattleResult")
          .withArgs(betId_, player.address, box, box, true, stake * 2n);
      });
    }
  });

  // ── settleBet — guards ────────────────────────────────────────────────────

  describe("settleBet — guards", () => {
    it("reverts on unknown betId", async () => {
      await expect(bs.connect(owner).settleBet(999n, OP_SEED))
        .to.be.revertedWith("BS: unknown bet");
    });

    it("reverts when already settled", async () => {
      const reqId = await rnd.prepareRequest.staticCall(WIN_SEED);
      await rnd.prepareRequest(WIN_SEED);
      await bs.connect(player).placeBet(PREDICTION, reqId, { value: toWei("1") });
      await bs.connect(owner).settleBet(1n, OP_SEED);
      await expect(bs.connect(owner).settleBet(1n, OP_SEED))
        .to.be.revertedWith("BS: already settled");
    });
  });

  // ── dropBox modulo — power-of-two correctness ─────────────────────────────

  describe("dropBox = seed % 16 (zero bias)", () => {
    it("large seed still maps to correct box", async () => {
      // 2^255 + 7 → (2^255 + 7) % 16 = 7 (since 2^255 = (2^4)^63 * 2^3, so 2^255 % 16 = 0)
      const largeSeed = (2n ** 255n) + 7n;
      const expected  = Number(largeSeed % 16n); // 7
      const reqId = await rnd.prepareRequest.staticCall(largeSeed);
      await rnd.prepareRequest(largeSeed);
      await bs.connect(player).placeBet(expected, reqId, { value: toWei("0.001") });
      await expect(bs.connect(owner).settleBet(await bs.betIdForRequest(reqId), OP_SEED))
        .to.emit(bs, "BattleResult")
        .withArgs(
          await bs.betIdForRequest(reqId) - 1n + 1n, // betId = current
          player.address, expected, expected, true, toWei("0.001") * 2n,
        );
    });
  });

  // ── pause ──────────────────────────────────────────────────────────────────

  describe("pause", () => {
    it("placeBet reverts when paused", async () => {
      const reqId = await rnd.prepareRequest.staticCall(WIN_SEED);
      await rnd.prepareRequest(WIN_SEED);
      await bs.connect(owner).pause();
      await expect(bs.connect(player).placeBet(PREDICTION, reqId, { value: toWei("1") }))
        .to.be.revertedWithCustomError(bs, "EnforcedPause");
    });

    it("settleBet works while paused (not gated by whenNotPaused)", async () => {
      const reqId = await rnd.prepareRequest.staticCall(WIN_SEED);
      await rnd.prepareRequest(WIN_SEED);
      await bs.connect(player).placeBet(PREDICTION, reqId, { value: toWei("1") });
      await bs.connect(owner).pause();
      await expect(bs.connect(owner).settleBet(1n, OP_SEED)).to.not.be.reverted;
    });
  });
});
