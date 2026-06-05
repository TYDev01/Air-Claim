// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IRandomnessSource
/// @notice Single seam through which all game contracts obtain randomness.
///         The default implementation is CommitRevealRandomness (commit–reveal scheme).
///         The interface is defined separately so the implementation can be swapped for a
///         third-party VRF in the future without touching any game-contract logic.
///
/// @dev    Chainlink VRF is NOT available on Celo. PREVRANDAO is constant across multiple
///         L2 blocks (it mirrors L1 PREVRANDAO) and is exploitable for staked play — do not
///         use it. The commit–reveal scheme implemented here ensures neither the operator
///         nor the player can unilaterally control the outcome.
interface IRandomnessSource {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when the operator commits a hash for a future round.
    /// @param requestId   Unique identifier for this randomness request.
    /// @param commitment  keccak256(abi.encodePacked(operatorSeed)) stored on-chain.
    event Committed(uint256 indexed requestId, bytes32 commitment);

    /// @notice Emitted when a round is revealed and the seed is finalised.
    /// @param requestId   Unique identifier for this randomness request.
    /// @param seed        The final combined seed available for consumption.
    event Revealed(uint256 indexed requestId, uint256 seed);

    // -------------------------------------------------------------------------
    // Request lifecycle
    // -------------------------------------------------------------------------

    /// @notice Operator creates a new randomness request by committing a hash.
    ///         Must be called before the player places their bet so the operator
    ///         cannot learn the player's move before committing.
    /// @param commitment  keccak256(abi.encodePacked(operatorSeed)) — the pre-image
    ///                    (operatorSeed) must be kept secret until reveal time.
    /// @return requestId  Unique identifier to pass back to revealAndConsume.
    function commit(bytes32 commitment) external returns (uint256 requestId);

    /// @notice Operator reveals the pre-image; the contract verifies the commitment,
    ///         then combines the operator seed with the user entropy to produce the
    ///         final seed. Marks the request as consumed.
    /// @param requestId   The id returned by commit.
    /// @param operatorSeed The secret pre-image: keccak256(abi.encodePacked(operatorSeed)) == commitment.
    /// @param userEntropy  Entropy contributed by the player (e.g. keccak256(playerNonce + address)).
    ///                     Neither party alone controls the output.
    /// @return seed        The finalised uint256 seed ready for use in game logic.
    function revealAndConsume(
        uint256 requestId,
        bytes32 operatorSeed,
        bytes32 userEntropy
    ) external returns (uint256 seed);

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /// @notice Returns whether a request id has been committed but not yet revealed.
    /// @param requestId  The id to query.
    /// @return           True if the commitment exists and the seed has not been consumed.
    function isPending(uint256 requestId) external view returns (bool);

    /// @notice Returns the stored commitment for a request id.
    ///         Reverts if the request does not exist.
    /// @param requestId  The id to query.
    /// @return           The bytes32 commitment stored at commit time.
    function getCommitment(uint256 requestId) external view returns (bytes32);
}
