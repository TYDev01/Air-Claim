import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { LuckySpin, RandomnessDouble } from "../../typechain-types";

// ─── off-chain draw simulation (mirrors _drawNumbers on-chain) ────────────────

function simulateDraw(seed: bigint): number[] {
  const pool: number[] = Array.from({ length: 20 }, (_, i) => i + 1);
  const drawn: number[] = [];
  let remaining = 20;

  for (let slot = 0; slot < 5; slot++) {
    const packed = ethers.solidityPacked(["uint256", "uint256"], [seed, BigInt(slot)]);
    const hash   = BigInt(ethers.keccak256(packed));
    const idx    = Number(hash % BigInt(remaining));
    drawn.push(pool[idx]);
    pool[idx] = pool[remaining - 1];
    remaining--;
  }
  return drawn;
}

function countMatches(picks: number[], drawn: number[]): number {
  return picks.filter(p => drawn.includes(p)).length;
}

/** Build picks that give exactly `targetMatches` against a seed's draw. */
function picksFor(seed: bigint, targetMatches: number): number[] {
  const drawn  = simulateDraw(seed);
  const inDraw = drawn.slice(0, targetMatches);             // first N drawn numbers
  const notIn  = [];
  for (let n = 1; n <= 20 && notIn.length < 5 - targetMatches; n++) {
    if (!drawn.includes(n)) notIn.push(n);
  }
  // Combine and ensure we have 5 distinct picks in [1,20]
  const combined = [...new Set([...inDraw, ...notIn])].slice(0, 5);
  // Pad if needed (shouldn't happen with 20 numbers)
  for (let n = 1; n <= 20 && combined.length < 5; n++) {
    if (!combined.includes(n)) combined.push(n);
  }
  return combined;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const toWei = (n: string) => ethers.parseEther(n);

const STAKE_CAP  = toWei("10");
const HOUSE_FUND = toWei("50"); // covers stake(1) * 25 = 25 ETH comfortably
const BASE_SEED  = 9_999_999_999n; // arbitrary; draw simulated off-chain

// ─── deploy ───────────────────────────────────────────────────────────────────

async function deploy(owner: SignerWithAddress) {
  const rndFactory = await ethers.getContractFactory("RandomnessDouble");
  const rnd        = await rndFactory.deploy() as RandomnessDouble;

  const lsFactory = await ethers.getContractFactory("LuckySpin");
  const ls        = await lsFactory.deploy(await rnd.getAddress(), STAKE_CAP) as LuckySpin;

  return { ls, rnd };
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe("LuckySpin", () => {
  let owner: SignerWithAddress;
  let player: SignerWithAddress;
  let stranger: SignerWithAddress;

  let ls: LuckySpin;
  let rnd: RandomnessDouble;

  beforeEach(async () => {
    [owner, player, stranger] = await ethers.getSigners();
    ({ ls, rnd } = await deploy(owner));
    // Fund the house
    await ls.connect(owner).fund({ value: HOUSE_FUND });
  });

  // ── constructor ───────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("reverts on zero randomness address", async () => {
      const F = await ethers.getContractFactory("LuckySpin");
      await expect(F.deploy(ethers.ZeroAddress, STAKE_CAP))
        .to.be.revertedWith("LS: zero randomness");
    });

    it("reverts on zero stakeCap", async () => {
      const F = await ethers.getContractFactory("LuckySpin");
      await expect(F.deploy(await rnd.getAddress(), 0n))
        .to.be.revertedWith("LS: zero stake cap");
    });

    it("sets correct stakeCap", async () => {
      expect(await ls.stakeCap()).to.equal(STAKE_CAP);
    });

    it("stores randomness address", async () => {
      expect(await ls.randomness()).to.equal(await rnd.getAddress());
    });
  });

  // ── owner config ──────────────────────────────────────────────────────────

  describe("setStakeCap", () => {
    it("reverts for non-owner", async () => {
      await expect(ls.connect(stranger).setStakeCap(toWei("1")))
        .to.be.revertedWithCustomError(ls, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero cap", async () => {
      await expect(ls.connect(owner).setStakeCap(0n))
        .to.be.revertedWith("LS: zero cap");
    });

    it("updates stakeCap and emits event", async () => {
      await expect(ls.connect(owner).setStakeCap(toWei("20")))
        .to.emit(ls, "StakeCapUpdated").withArgs(toWei("20"));
      expect(await ls.stakeCap()).to.equal(toWei("20"));
    });
  });

  describe("fund / withdrawHouse", () => {
    it("fund increases house balance", async () => {
      await expect(() => ls.connect(owner).fund({ value: toWei("1") }))
        .to.changeEtherBalance(ls, toWei("1"));
    });

    it("fund emits HouseFunded", async () => {
      await expect(ls.connect(owner).fund({ value: toWei("1") }))
        .to.emit(ls, "HouseFunded").withArgs(owner.address, toWei("1"));
    });

    it("withdrawHouse reverts for non-owner", async () => {
      await expect(ls.connect(stranger).withdrawHouse(toWei("1")))
        .to.be.revertedWithCustomError(ls, "OwnableUnauthorizedAccount");
    });

    it("withdrawHouse reverts when amount exceeds balance", async () => {
      const bal = await ethers.provider.getBalance(await ls.getAddress());
      await expect(ls.connect(owner).withdrawHouse(bal + 1n))
        .to.be.revertedWith("LS: insufficient balance");
    });

    it("withdrawHouse transfers CELO to owner", async () => {
      await expect(ls.connect(owner).withdrawHouse(toWei("1")))
        .to.changeEtherBalance(owner, toWei("1"));
    });
  });

  // ── placeBet ──────────────────────────────────────────────────────────────

  describe("placeBet", () => {
    let requestId: bigint;

    beforeEach(async () => {
      requestId = await rnd.prepareRequest.staticCall(BASE_SEED);
      await rnd.prepareRequest(BASE_SEED);
    });

    it("reverts on zero stake", async () => {
      await expect(ls.connect(player).placeBet([1,2,3,4,5], requestId, { value: 0n }))
        .to.be.revertedWith("LS: zero stake");
    });

    it("reverts when stake exceeds cap", async () => {
      await expect(ls.connect(player).placeBet([1,2,3,4,5], requestId, { value: STAKE_CAP + 1n }))
        .to.be.revertedWith("LS: stake exceeds cap");
    });

    it("reverts on pick out of range (0)", async () => {
      await expect(ls.connect(player).placeBet([0,2,3,4,5], requestId, { value: toWei("1") }))
        .to.be.revertedWith("LS: pick out of range");
    });

    it("reverts on pick out of range (21)", async () => {
      await expect(ls.connect(player).placeBet([1,2,3,4,21], requestId, { value: toWei("1") }))
        .to.be.revertedWith("LS: pick out of range");
    });

    it("reverts on duplicate picks", async () => {
      await expect(ls.connect(player).placeBet([1,2,3,4,4], requestId, { value: toWei("1") }))
        .to.be.revertedWith("LS: duplicate pick");
    });

    it("reverts when request is not pending", async () => {
      await expect(ls.connect(player).placeBet([1,2,3,4,5], 999n, { value: toWei("1") }))
        .to.be.revertedWith("LS: request not pending");
    });

    it("reverts when requestId already used by another bet", async () => {
      await ls.connect(player).placeBet([1,2,3,4,5], requestId, { value: toWei("1") });
      // requestId is still technically pending (not revealed), but already mapped to betId 1
      await expect(ls.connect(stranger).placeBet([1,2,3,4,5], requestId, { value: toWei("1") }))
        .to.be.revertedWith("LS: requestId in use");
    });

    it("reverts when house cannot cover max payout (stake * 25)", async () => {
      // Drain house then try to bet
      const bal = await ethers.provider.getBalance(await ls.getAddress());
      await ls.connect(owner).withdrawHouse(bal);

      // Small stake but house is empty
      await expect(ls.connect(player).placeBet([1,2,3,4,5], requestId, { value: toWei("0.01") }))
        .to.be.revertedWith("LS: house cannot cover payout");
    });

    it("emits SpinPlaced with correct args", async () => {
      const stake = toWei("1");
      const picks: [number,number,number,number,number] = [1,2,3,4,5];
      await expect(ls.connect(player).placeBet(picks, requestId, { value: stake }))
        .to.emit(ls, "SpinPlaced")
        .withArgs(1n, player.address, stake, picks, requestId);
    });

    it("betIdForRequest returns the new betId", async () => {
      await ls.connect(player).placeBet([1,2,3,4,5], requestId, { value: toWei("1") });
      expect(await ls.betIdForRequest(requestId)).to.equal(1n);
    });

    it("userEntropyFor is deterministic and depends on bet data", async () => {
      const stake = toWei("1");
      await ls.connect(player).placeBet([1,2,3,4,5], requestId, { value: stake });
      const entropy = await ls.userEntropyFor(1n);
      // Mirror abi.encodePacked(player, uint8[5] picks, uint256 stake, uint256 betId)
      const expected = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "uint8[5]", "uint256", "uint256"],
          [player.address, [1, 2, 3, 4, 5], stake, 1n]
        )
      );
      expect(entropy).to.equal(expected);
    });
  });

  // ── settleBet — payout matrix ─────────────────────────────────────────────

  describe("settleBet — payout matrix", () => {
    const stake = toWei("1");
    // RandomnessDouble ignores operatorSeed — ZeroHash is always valid 32 bytes.
    const OP_SEED = ethers.ZeroHash;

    async function playRound(seed: bigint, picks: number[]) {
      const reqId = await rnd.prepareRequest.staticCall(seed);
      await rnd.prepareRequest(seed);
      await ls.connect(player).placeBet(
        picks as [number,number,number,number,number],
        reqId,
        { value: stake },
      );
      return { betId: await ls.betIdForRequest(reqId) };
    }

    // SpinResult emits uint8[5] which ethers v6 returns as bigint[] — convert for assertion.
    const bn = (arr: number[]) => arr.map(BigInt);

    it("pays 0 for 0 matches (house keeps stake)", async () => {
      const picks = picksFor(BASE_SEED, 0);
      expect(countMatches(picks, simulateDraw(BASE_SEED))).to.equal(0);
      const { betId } = await playRound(BASE_SEED, picks);
      await expect(ls.connect(owner).settleBet(betId, OP_SEED))
        .to.emit(ls, "SpinResult")
        .withArgs(betId, player.address, bn(picks), bn(simulateDraw(BASE_SEED)), 0, 0n);
    });

    it("pays stake×5 for 3 matches", async () => {
      const SEED3  = 7n;
      const picks3 = picksFor(SEED3, 3);
      expect(countMatches(picks3, simulateDraw(SEED3))).to.equal(3);
      const { betId } = await playRound(SEED3, picks3);
      await expect(ls.connect(owner).settleBet(betId, OP_SEED))
        .to.emit(ls, "SpinResult")
        .withArgs(betId, player.address, bn(picks3), bn(simulateDraw(SEED3)), 3, stake * 5n);
    });

    it("pays stake×10 for 4 matches", async () => {
      const SEED4  = 3n;
      const picks4 = picksFor(SEED4, 4);
      expect(countMatches(picks4, simulateDraw(SEED4))).to.equal(4);
      const { betId } = await playRound(SEED4, picks4);
      await expect(ls.connect(owner).settleBet(betId, OP_SEED))
        .to.emit(ls, "SpinResult")
        .withArgs(betId, player.address, bn(picks4), bn(simulateDraw(SEED4)), 4, stake * 10n);
    });

    it("pays stake×25 for 5 matches", async () => {
      const drawn5 = simulateDraw(SEED5);
      const picks5 = drawn5 as [number,number,number,number,number];
      expect(countMatches(picks5, drawn5)).to.equal(5);
      const { betId } = await playRound(SEED5, picks5);
      await expect(ls.connect(owner).settleBet(betId, OP_SEED))
        .to.emit(ls, "SpinResult")
        .withArgs(betId, player.address, bn(picks5), bn(drawn5), 5, stake * 25n);
    });

    it("changeEtherBalance: player receives stake×25 on 5 matches", async () => {
      const drawn5 = simulateDraw(SEED5);
      const { betId } = await playRound(SEED5, drawn5);
      await expect(ls.connect(owner).settleBet(betId, OP_SEED))
        .to.changeEtherBalance(player, stake * 25n);
    });
  });

  // ── settleBet — guard rails ───────────────────────────────────────────────

  describe("settleBet — guards", () => {
    it("reverts on unknown betId", async () => {
      await expect(ls.connect(owner).settleBet(999n, ethers.ZeroHash))
        .to.be.revertedWith("LS: unknown bet");
    });

    it("reverts when already settled", async () => {
      const reqId = await rnd.prepareRequest.staticCall(BASE_SEED);
      await rnd.prepareRequest(BASE_SEED);
      await ls.connect(player).placeBet([1,2,3,4,5], reqId, { value: toWei("1") });
      const opSeed = ethers.hexlify(ethers.randomBytes(32));
      await ls.connect(owner).settleBet(1n, opSeed);
      await expect(ls.connect(owner).settleBet(1n, opSeed))
        .to.be.revertedWith("LS: already settled");
    });
  });

  // ── _drawNumbers: distinct numbers in range ────────────────────────────────

  describe("_drawNumbers (via SpinResult event)", () => {
    it("drawn numbers are all distinct and in [1, 20]", async () => {
      // Use several seeds and verify via SpinResult event
      // Use a tiny stake so 4 bets × 25× payout stays within the house fund.
      const tinyStake = toWei("0.001");
      for (const seed of [1n, 42n, 999n, 12345n]) {
        const drawn = simulateDraw(seed);
        const reqId = await rnd.prepareRequest.staticCall(seed);
        await rnd.prepareRequest(seed);

        await ls.connect(player).placeBet(
          drawn as [number,number,number,number,number],
          reqId,
          { value: tinyStake }
        );
        const tx = await ls.connect(owner).settleBet(
          await ls.betIdForRequest(reqId),
          ethers.ZeroHash,
        );
        const rec = await tx.wait();
        const iface = ls.interface;
        const log   = rec!.logs.find(l => { try { iface.parseLog(l as any); return true; } catch { return false; } });
        const parsed = iface.parseLog(log as any)!;
        const drawnOnChain: number[] = parsed.args[3].map(Number);

        expect(drawnOnChain).to.have.lengthOf(5);
        expect(new Set(drawnOnChain).size).to.equal(5); // all distinct
        drawnOnChain.forEach(n => {
          expect(n).to.be.gte(1);
          expect(n).to.be.lte(20);
        });
      }
    });
  });

  // ── pause ──────────────────────────────────────────────────────────────────

  describe("pause", () => {
    it("placeBet reverts when paused", async () => {
      const reqId = await rnd.prepareRequest.staticCall(BASE_SEED);
      await rnd.prepareRequest(BASE_SEED);
      await ls.connect(owner).pause();
      await expect(ls.connect(player).placeBet([1,2,3,4,5], reqId, { value: toWei("1") }))
        .to.be.revertedWithCustomError(ls, "EnforcedPause");
    });
  });
});

// constant re-used across describe blocks
const SEED5 = 1n;
