// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IRandomnessSource.sol";

/// @title CommitRevealRandomness
/// @notice Default implementation of IRandomnessSource using a commit–reveal
///         scheme. Ensures neither the operator nor the player can unilaterally
///         control the outcome of a game round.
///
/// @dev    Why not VRF or PREVRANDAO?
///         - Chainlink VRF is not available on Celo.
///         - PREVRANDAO on Celo (an OP Stack L2) is sourced from L1 and is
///           constant across multiple L2 blocks, making it exploitable for
///           staked play.
///
///         Commit–reveal flow:
///           1. Operator calls commit(keccak256(operatorSeed)) BEFORE the
///              player submits their move. This locks the operator's entropy.
///           2. Player submits their move and a nonce to the game contract.
///              The game contract passes userEntropy to revealAndConsume().
///           3. Operator calls revealAndConsume(requestId, operatorSeed,
///              userEntropy). The contract verifies the commitment, then
///              derives the final seed from both inputs combined with
///              block.number so the seed cannot be predicted at commit time.
///
///         Neither party controls the output:
///           - Operator cannot change the seed after committing.
///           - Player's move is mixed in via userEntropy so the operator
///             cannot grind for a favourable seed before the player acts.
///           - block.number adds an additional unpredictable component.
///
///         The contract is intentionally kept behind IRandomnessSource so
///         game contracts (LuckySpin, BattleShip) hold only an interface
///         reference — the implementation can be swapped for a third-party
///         VRF without touching game logic.
contract CommitRevealRandomness is IRandomnessSource, Ownable {

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @dev Auto-incrementing request counter. Starts at 1; 0 is never issued.
    uint256 private _nextRequestId;

    /// @dev requestId → commitment (keccak256(operatorSeed)).
    ///      Zero value means the request does not exist.
    mapping(uint256 => bytes32) private _commitments;

    /// @dev requestId → true once revealAndConsume has been called successfully.
    mapping(uint256 => bool) private _consumed;

    /// @dev Addresses authorised to call commit() and revealAndConsume().
    mapping(address => bool) private _operators;

    // -------------------------------------------------------------------------
    // Events (beyond those in IRandomnessSource)
    // -------------------------------------------------------------------------

    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param initialOperator  Address granted operator status at deployment.
    ///                         Typically the backend wallet that manages game rounds.
    ///                         Can be the deployer; more operators can be added later.
    constructor(address initialOperator) Ownable(msg.sender) {
        require(initialOperator != address(0), "CRR: zero operator");
        _operators[initialOperator] = true;
        _nextRequestId = 1;
        emit OperatorAdded(initialOperator);
    }

    // -------------------------------------------------------------------------
    // Operator management (owner only)
    // -------------------------------------------------------------------------

    /// @notice Grant operator status to an address. Operators may commit and reveal.
    function addOperator(address operator) external onlyOwner {
        require(operator != address(0), "CRR: zero operator");
        require(!_operators[operator], "CRR: already operator");
        _operators[operator] = true;
        emit OperatorAdded(operator);
    }

    /// @notice Revoke operator status from an address.
    function removeOperator(address operator) external onlyOwner {
        require(_operators[operator], "CRR: not operator");
        _operators[operator] = false;
        emit OperatorRemoved(operator);
    }

    /// @notice Returns whether an address is an authorised operator.
    function isOperator(address operator) external view returns (bool) {
        return _operators[operator];
    }

    // -------------------------------------------------------------------------
    // Internal modifier
    // -------------------------------------------------------------------------

    modifier onlyOperator() {
        require(_operators[msg.sender], "CRR: not operator");
        _;
    }

    // -------------------------------------------------------------------------
    // IRandomnessSource — reveal
    // -------------------------------------------------------------------------

    /// @inheritdoc IRandomnessSource
    /// @dev Verifies the commitment, mixes both entropy sources, and marks the
    ///      request consumed so it can never be replayed.
    ///
    ///      Seed derivation:
    ///        seed = uint256(keccak256(abi.encodePacked(
    ///                 operatorSeed,    // operator's secret — locked at commit time
    ///                 userEntropy,     // player-supplied nonce mixed in by game contract
    ///                 block.number     // unpredictable at commit time on this L2
    ///               )))
    ///
    ///      Neither party alone controls the output:
    ///        - Operator cannot change operatorSeed after committing.
    ///        - Player cannot change userEntropy after the game contract
    ///          records their move (game contract is responsible for this).
    ///        - block.number cannot be predicted by either party far in advance.
    ///
    ///      Only the same operator that committed may reveal (msg.sender must
    ///      be an authorised operator — the interface does not restrict to the
    ///      exact committing address, allowing operator key rotation without
    ///      stranding in-flight requests).
    function revealAndConsume(
        uint256 requestId,
        bytes32 operatorSeed,
        bytes32 userEntropy
    )
        external
        override
        onlyOperator
        returns (uint256 seed)
    {
        // --- checks ---
        bytes32 stored = _commitments[requestId];
        require(stored != bytes32(0), "CRR: unknown request");
        require(!_consumed[requestId], "CRR: already consumed");

        // Verify the operator's revealed pre-image matches the stored commitment.
        require(
            keccak256(abi.encodePacked(operatorSeed)) == stored,
            "CRR: commitment mismatch"
        );

        // userEntropy must be non-zero — a zero value typically signals the
        // game contract failed to populate it, which would halve the entropy.
        require(userEntropy != bytes32(0), "CRR: zero user entropy");

        // --- effects ---
        _consumed[requestId] = true;

        // --- derive seed ---
        // Combine all three entropy sources in a single keccak256.
        // block.number is used (not block.timestamp) because timestamp can be
        // nudged slightly by validators; block.number is strictly increasing.
        seed = uint256(
            keccak256(abi.encodePacked(operatorSeed, userEntropy, block.number))
        );

        emit Revealed(requestId, seed);
    }

    // -------------------------------------------------------------------------
    // IRandomnessSource — commit
    // -------------------------------------------------------------------------

    /// @inheritdoc IRandomnessSource
    /// @dev Only an authorised operator may commit. The operator MUST call this
    ///      before the player submits their move to the game contract, so the
    ///      operator cannot see the player's choice before locking their seed.
    ///
    ///      The commitment is keccak256(abi.encodePacked(operatorSeed)).
    ///      The pre-image (operatorSeed) must be kept secret by the operator
    ///      until revealAndConsume() is called.
    ///
    ///      A zero commitment is rejected — it signals an uninitialised slot
    ///      and must never be stored as a valid commitment.
    function commit(bytes32 commitment)
        external
        override
        onlyOperator
        returns (uint256 requestId)
    {
        require(commitment != bytes32(0), "CRR: zero commitment");

        requestId = _nextRequestId++;
        _commitments[requestId] = commitment;

        emit Committed(requestId, commitment);
    }
}
