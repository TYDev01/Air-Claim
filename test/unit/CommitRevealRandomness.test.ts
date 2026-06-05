import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { CommitRevealRandomness } from "../../typechain-types";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** keccak256(abi.encodePacked(seed)) — mirrors the on-chain commitment formula */
function makeCommitment(seed: Uint8Array | string): string {
  return ethers.keccak256(
    typeof seed === "string" ? ethers.toUtf8Bytes(seed) : seed
  );
}

/** Derive the expected final seed matching the on-chain formula */
async function expectedSeed(
  operatorSeed: string,
  userEntropy: string,
  blockNumber: number,
): Promise<bigint> {
  const packed = ethers.solidityPacked(
    ["bytes32", "bytes32", "uint256"],
    [operatorSeed, userEntropy, blockNumber],
  );
  return BigInt(ethers.keccak256(packed));
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("CommitRevealRandomness", () => {
  let crr: CommitRevealRandomness;
  let owner: SignerWithAddress;
  let operator: SignerWithAddress;
  let operator2: SignerWithAddress;
  let stranger: SignerWithAddress;

  beforeEach(async () => {
    [owner, operator, operator2, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("CommitRevealRandomness");
    crr = (await Factory.deploy(operator.address)) as CommitRevealRandomness;
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("reverts on zero initialOperator", async () => {
      const Factory = await ethers.getContractFactory("CommitRevealRandomness");
      await expect(Factory.deploy(ethers.ZeroAddress))
        .to.be.revertedWith("CRR: zero operator");
    });

    it("sets the initial operator", async () => {
      expect(await crr.isOperator(operator.address)).to.be.true;
    });

    it("does not grant operator status to the owner by default", async () => {
      // owner != operator in this setup
      if (owner.address !== operator.address) {
        expect(await crr.isOperator(owner.address)).to.be.false;
      }
    });

    it("nextRequestId starts at 1", async () => {
      expect(await crr.nextRequestId()).to.equal(1n);
    });

    it("emits OperatorAdded for the initial operator", async () => {
      const Factory  = await ethers.getContractFactory("CommitRevealRandomness");
      const contract = await Factory.deploy(operator.address);
      await expect(contract.deploymentTransaction())
        .to.emit(contract, "OperatorAdded")
        .withArgs(operator.address);
    });
  });

  // ── operator management ────────────────────────────────────────────────────

  describe("operator management", () => {
    it("owner can add a new operator", async () => {
      await crr.connect(owner).addOperator(operator2.address);
      expect(await crr.isOperator(operator2.address)).to.be.true;
    });

    it("addOperator emits OperatorAdded", async () => {
      await expect(crr.connect(owner).addOperator(operator2.address))
        .to.emit(crr, "OperatorAdded")
        .withArgs(operator2.address);
    });

    it("addOperator reverts for non-owner", async () => {
      await expect(crr.connect(stranger).addOperator(operator2.address))
        .to.be.revertedWithCustomError(crr, "OwnableUnauthorizedAccount");
    });

    it("addOperator reverts on zero address", async () => {
      await expect(crr.connect(owner).addOperator(ethers.ZeroAddress))
        .to.be.revertedWith("CRR: zero operator");
    });

    it("addOperator reverts if already an operator", async () => {
      await expect(crr.connect(owner).addOperator(operator.address))
        .to.be.revertedWith("CRR: already operator");
    });

    it("owner can remove an operator", async () => {
      await crr.connect(owner).removeOperator(operator.address);
      expect(await crr.isOperator(operator.address)).to.be.false;
    });

    it("removeOperator emits OperatorRemoved", async () => {
      await expect(crr.connect(owner).removeOperator(operator.address))
        .to.emit(crr, "OperatorRemoved")
        .withArgs(operator.address);
    });

    it("removeOperator reverts for non-owner", async () => {
      await expect(crr.connect(stranger).removeOperator(operator.address))
        .to.be.revertedWithCustomError(crr, "OwnableUnauthorizedAccount");
    });

    it("removeOperator reverts if not an operator", async () => {
      await expect(crr.connect(owner).removeOperator(stranger.address))
        .to.be.revertedWith("CRR: not operator");
    });
  });

  // ── commit ─────────────────────────────────────────────────────────────────

  describe("commit()", () => {
    const seed       = ethers.randomBytes(32);
    const commitment = makeCommitment(seed);

    it("reverts when called by non-operator", async () => {
      await expect(crr.connect(stranger).commit(commitment))
        .to.be.revertedWith("CRR: not operator");
    });

    it("reverts on zero commitment", async () => {
      await expect(crr.connect(operator).commit(ethers.ZeroHash))
        .to.be.revertedWith("CRR: zero commitment");
    });

    it("returns requestId = 1 on first call", async () => {
      const tx  = await crr.connect(operator).commit(commitment);
      const rec = await tx.wait();
      // Parse the Committed event to read requestId
      const iface = crr.interface;
      const log   = rec!.logs.find(l => {
        try { iface.parseLog(l as any); return true; } catch { return false; }
      });
      const parsed = iface.parseLog(log as any)!;
      expect(parsed.args[0]).to.equal(1n);
    });

    it("increments requestId on successive commits", async () => {
      await crr.connect(operator).commit(commitment);
      expect(await crr.nextRequestId()).to.equal(2n);
      await crr.connect(operator).commit(makeCommitment(ethers.randomBytes(32)));
      expect(await crr.nextRequestId()).to.equal(3n);
    });

    it("emits Committed with correct requestId and commitment", async () => {
      await expect(crr.connect(operator).commit(commitment))
        .to.emit(crr, "Committed")
        .withArgs(1n, commitment);
    });

    it("stores commitment retrievable via getCommitment", async () => {
      await crr.connect(operator).commit(commitment);
      expect(await crr.getCommitment(1n)).to.equal(commitment);
    });

    it("isPending returns true after commit", async () => {
      await crr.connect(operator).commit(commitment);
      expect(await crr.isPending(1n)).to.be.true;
    });
  });

  // ── revealAndConsume ───────────────────────────────────────────────────────

  describe("revealAndConsume()", () => {
    const operatorSeed  = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
    const commitment    = ethers.keccak256(ethers.solidityPacked(["bytes32"], [operatorSeed]));
    const userEntropy   = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;

    let requestId: bigint;

    beforeEach(async () => {
      const tx  = await crr.connect(operator).commit(commitment);
      const rec = await tx.wait();
      const log = rec!.logs.find(l => { try { crr.interface.parseLog(l as any); return true; } catch { return false; } });
      requestId = crr.interface.parseLog(log as any)!.args[0] as bigint;
    });

    it("reverts when called by non-operator", async () => {
      await expect(crr.connect(stranger).revealAndConsume(requestId, operatorSeed, userEntropy))
        .to.be.revertedWith("CRR: not operator");
    });

    it("reverts on unknown requestId", async () => {
      await expect(crr.connect(operator).revealAndConsume(999n, operatorSeed, userEntropy))
        .to.be.revertedWith("CRR: unknown request");
    });

    it("reverts on commitment mismatch (wrong operatorSeed)", async () => {
      const wrongSeed = ethers.hexlify(ethers.randomBytes(32));
      await expect(crr.connect(operator).revealAndConsume(requestId, wrongSeed, userEntropy))
        .to.be.revertedWith("CRR: commitment mismatch");
    });

    it("reverts on zero userEntropy", async () => {
      await expect(crr.connect(operator).revealAndConsume(requestId, operatorSeed, ethers.ZeroHash))
        .to.be.revertedWith("CRR: zero user entropy");
    });

    it("returns deterministic seed matching on-chain formula", async () => {
      const tx  = await crr.connect(operator).revealAndConsume(requestId, operatorSeed, userEntropy);
      const rec = await tx.wait();

      const offChain = await expectedSeed(operatorSeed, userEntropy, rec!.blockNumber);

      // Read the seed from the Revealed event
      const log    = rec!.logs.find(l => { try { crr.interface.parseLog(l as any); return true; } catch { return false; } });
      const parsed = crr.interface.parseLog(log as any)!;
      expect(parsed.args[1]).to.equal(offChain);
    });

    it("emits Revealed(requestId, seed)", async () => {
      const tx  = await crr.connect(operator).revealAndConsume(requestId, operatorSeed, userEntropy);
      const rec = await tx.wait();
      const offChain = await expectedSeed(operatorSeed, userEntropy, rec!.blockNumber);
      await expect(tx).to.emit(crr, "Revealed").withArgs(requestId, offChain);
    });

    it("marks request consumed after reveal", async () => {
      await crr.connect(operator).revealAndConsume(requestId, operatorSeed, userEntropy);
      expect(await crr.isConsumed(requestId)).to.be.true;
      expect(await crr.isPending(requestId)).to.be.false;
    });

    it("reverts on second revealAndConsume for same requestId", async () => {
      await crr.connect(operator).revealAndConsume(requestId, operatorSeed, userEntropy);
      await expect(crr.connect(operator).revealAndConsume(requestId, operatorSeed, userEntropy))
        .to.be.revertedWith("CRR: already consumed");
    });
  });

  // ── view helpers ──────────────────────────────────────────────────────────

  describe("view helpers", () => {
    it("isPending returns false for never-issued id", async () => {
      expect(await crr.isPending(999n)).to.be.false;
    });

    it("getCommitment reverts for unknown requestId", async () => {
      await expect(crr.getCommitment(999n))
        .to.be.revertedWith("CRR: unknown request");
    });

    it("isConsumed returns false before reveal", async () => {
      const commitment = ethers.keccak256(ethers.randomBytes(32));
      await crr.connect(operator).commit(commitment);
      expect(await crr.isConsumed(1n)).to.be.false;
    });
  });

  // ── security: neither party controls the outcome alone ───────────────────

  describe("security — entropy independence", () => {
    it("different userEntropy produces a different seed (player entropy matters)", async () => {
      const opSeed    = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
      const comm      = ethers.keccak256(ethers.solidityPacked(["bytes32"], [opSeed]));
      const entropy1  = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
      const entropy2  = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;

      await crr.connect(operator).commit(comm);
      const tx1  = await crr.connect(operator).revealAndConsume(1n, opSeed, entropy1);
      const rec1 = await tx1.wait();
      const seed1 = await expectedSeed(opSeed, entropy1, rec1!.blockNumber);

      // Commit again for second round
      await crr.connect(operator).commit(comm);
      const tx2  = await crr.connect(operator).revealAndConsume(2n, opSeed, entropy2);
      const rec2 = await tx2.wait();
      const seed2 = await expectedSeed(opSeed, entropy2, rec2!.blockNumber);

      expect(seed1).to.not.equal(seed2);
    });

    it("different operatorSeed produces a different seed (operator entropy matters)", async () => {
      const opSeed1 = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
      const opSeed2 = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
      const entropy = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;

      await crr.connect(operator).commit(
        ethers.keccak256(ethers.solidityPacked(["bytes32"], [opSeed1]))
      );
      await crr.connect(operator).commit(
        ethers.keccak256(ethers.solidityPacked(["bytes32"], [opSeed2]))
      );

      const tx1  = await crr.connect(operator).revealAndConsume(1n, opSeed1, entropy);
      const rec1 = await tx1.wait();
      const seed1 = await expectedSeed(opSeed1, entropy, rec1!.blockNumber);

      const tx2  = await crr.connect(operator).revealAndConsume(2n, opSeed2, entropy);
      const rec2 = await tx2.wait();
      const seed2 = await expectedSeed(opSeed2, entropy, rec2!.blockNumber);

      expect(seed1).to.not.equal(seed2);
    });

    it("mismatched reveal (wrong operatorSeed) always reverts", async () => {
      const realSeed  = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
      const fakeSeed  = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
      const comm      = ethers.keccak256(ethers.solidityPacked(["bytes32"], [realSeed]));
      const entropy   = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;

      await crr.connect(operator).commit(comm);
      await expect(crr.connect(operator).revealAndConsume(1n, fakeSeed, entropy))
        .to.be.revertedWith("CRR: commitment mismatch");
    });
  });
});
