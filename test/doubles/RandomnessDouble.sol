// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../../contracts/interfaces/IRandomnessSource.sol";

/// @title RandomnessDouble
/// @notice Test-only IRandomnessSource implementation.
///         Lives under test/ exclusively — MUST NOT be imported by any
///         contract under contracts/ or referenced in any deploy script.
///
///         Allows unit tests to:
///           - Obtain a requestId without running the real commit–reveal flow.
///           - Configure the exact seed returned by revealAndConsume() so
///             game-outcome tests are fully deterministic.
///           - Simulate a revert on revealAndConsume() to test error paths.
///           - Verify that game contracts pass the expected userEntropy.
contract RandomnessDouble is IRandomnessSource {

    // -------------------------------------------------------------------------
    // Configurable state
    // -------------------------------------------------------------------------

    /// @dev requestId → seed to return on revealAndConsume.
    mapping(uint256 => uint256) public mockSeeds;

    /// @dev requestId → whether revealAndConsume should revert.
    mapping(uint256 => bool) public mockReverts;

    /// @dev requestId → userEntropy recorded by the last revealAndConsume call.
    ///      Tests can assert the game contract passed the correct value.
    mapping(uint256 => bytes32) public recordedUserEntropy;

    /// @dev requestId → commitment (always non-zero for issued ids).
    mapping(uint256 => bytes32) private _commitments;

    /// @dev requestId → consumed flag.
    mapping(uint256 => bool) private _consumed;

    uint256 private _nextRequestId;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        _nextRequestId = 1;
    }

    // -------------------------------------------------------------------------
    // Test helpers
    // -------------------------------------------------------------------------

    /// @notice Pre-issue a requestId and configure the seed it will return.
    ///         Call this from the test before the player calls placeBet().
    /// @param seed  The seed revealAndConsume will return for this request.
    /// @return requestId  The issued id to pass to placeBet().
    function prepareRequest(uint256 seed) external returns (uint256 requestId) {
        requestId = _nextRequestId++;
        // Store a non-zero commitment so isPending() returns true.
        _commitments[requestId] = keccak256(abi.encodePacked(seed, requestId));
        mockSeeds[requestId]    = seed;
    }

    /// @notice Make revealAndConsume revert for a specific requestId.
    function setRevertOnReveal(uint256 requestId, bool shouldRevert) external {
        mockReverts[requestId] = shouldRevert;
    }

    /// @notice Override the seed for an already-prepared request.
    function setSeed(uint256 requestId, uint256 seed) external {
        mockSeeds[requestId] = seed;
    }

    // -------------------------------------------------------------------------
    // IRandomnessSource implementation
    // -------------------------------------------------------------------------

    /// @dev Issues a real requestId; stores a dummy commitment.
    ///      In tests, use prepareRequest() instead of commit() for full control.
    function commit(bytes32 commitment)
        external
        override
        returns (uint256 requestId)
    {
        require(commitment != bytes32(0), "RandomnessDouble: zero commitment");
        requestId = _nextRequestId++;
        _commitments[requestId] = commitment;
    }

    /// @dev Returns the pre-configured seed. Records userEntropy for assertions.
    ///      Marks the request consumed so game contracts see consistent state.
    function revealAndConsume(
        uint256 requestId,
        bytes32 /* operatorSeed */,
        bytes32 userEntropy
    )
        external
        override
        returns (uint256 seed)
    {
        require(_commitments[requestId] != bytes32(0), "RandomnessDouble: unknown request");
        require(!_consumed[requestId],                 "RandomnessDouble: already consumed");

        if (mockReverts[requestId]) {
            revert("RandomnessDouble: forced revert");
        }

        // Record what the game contract sent so tests can assert it.
        recordedUserEntropy[requestId] = userEntropy;

        _consumed[requestId] = true;

        seed = mockSeeds[requestId];
    }

    function isPending(uint256 requestId) external view override returns (bool) {
        return _commitments[requestId] != bytes32(0) && !_consumed[requestId];
    }

    function getCommitment(uint256 requestId)
        external
        view
        override
        returns (bytes32)
    {
        require(_commitments[requestId] != bytes32(0), "RandomnessDouble: unknown request");
        return _commitments[requestId];
    }
}
