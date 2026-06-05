// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IRandomnessSource.sol";

/// @title LuckySpin
/// @notice Games-Lounge game. Player picks 5 distinct numbers in [1, 20] and
///         stakes native CELO (up to a cap). Five numbers are drawn via
///         IRandomnessSource (commit–reveal). Payouts: 3 matches → ×5 stake,
///         4 matches → ×10, 5 matches → ×25. Fewer than 3 matches → no payout.
///
/// @dev    Flow:
///           1. Operator calls IRandomnessSource.commit() off-chain; receives requestId.
///           2. Player calls placeBet(picks, requestId) with their CELO stake.
///              Contract verifies the request is pending and stores the bet.
///           3. Operator calls IRandomnessSource.revealAndConsume(requestId,
///              operatorSeed, userEntropy) where userEntropy is derived from
///              the player's address, picks, and stake — all committed on-chain
///              at step 2.
///           4. The game contract's settleBet() is called (by anyone) after the
///              reveal; it reads the seed, draws numbers, counts matches, and pays.
///
///         House-balance check: the contract rejects any bet whose maximum
///         possible payout (stake × 25) exceeds the house balance at bet time.
contract LuckySpin is Ownable, ReentrancyGuard, Pausable {

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint8  public constant PICK_COUNT   = 5;
    uint8  public constant NUMBER_MAX   = 20;
    uint8  public constant MULTIPLIER_3 = 5;
    uint8  public constant MULTIPLIER_4 = 10;
    uint8  public constant MULTIPLIER_5 = 25;

    // -------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------

    /// @notice Randomness source — injected at construction; never hardcoded.
    IRandomnessSource public immutable randomness;

    // -------------------------------------------------------------------------
    // Mutable configuration
    // -------------------------------------------------------------------------

    /// @notice Maximum CELO stake (wei) accepted per bet. Owner-adjustable.
    uint256 public stakeCap;

    // -------------------------------------------------------------------------
    // Bet storage
    // -------------------------------------------------------------------------

    struct Bet {
        address player;
        uint256 stake;        // CELO wei
        uint8[5] picks;       // player's 5 chosen numbers in [1, 20]
        uint256 requestId;    // IRandomnessSource request id used for this bet
        bool    settled;
    }

    /// @dev Auto-incrementing bet counter. 0 is reserved.
    uint256 private _nextBetId;

    mapping(uint256 => Bet)     private _bets;

    /// @dev requestId → betId. Enables settleBet() to look up the bet from
    ///      the requestId after the randomness source fires the Revealed event.
    mapping(uint256 => uint256) private _requestToBet;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event SpinPlaced(
        uint256 indexed betId,
        address indexed player,
        uint256         stake,
        uint8[5]        picks,
        uint256         requestId
    );

    event SpinResult(
        uint256 indexed betId,
        address indexed player,
        uint8[5]        picks,
        uint8[5]        drawn,
        uint8           matches,
        uint256         payout
    );

    event StakeCapUpdated(uint256 newCap);
    event HouseFunded(address indexed from, uint256 amount);
    event HouseWithdrawn(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _randomness  Deployed CommitRevealRandomness (IRandomnessSource) address.
    /// @param _stakeCap    Initial maximum stake in CELO wei per bet.
    constructor(address _randomness, uint256 _stakeCap)
        Ownable(msg.sender)
    {
        require(_randomness != address(0), "LS: zero randomness");
        require(_stakeCap   >  0,          "LS: zero stake cap");

        randomness   = IRandomnessSource(_randomness);
        stakeCap     = _stakeCap;
        _nextBetId   = 1;
    }

    // -------------------------------------------------------------------------
    // Owner configuration
    // -------------------------------------------------------------------------

    /// @notice Update the maximum stake per bet.
    function setStakeCap(uint256 _cap) external onlyOwner {
        require(_cap > 0, "LS: zero cap");
        stakeCap = _cap;
        emit StakeCapUpdated(_cap);
    }

    /// @notice Owner funds the house balance with native CELO.
    function fund() external payable onlyOwner {
        require(msg.value > 0, "LS: zero fund");
        emit HouseFunded(msg.sender, msg.value);
    }

    /// @notice Owner withdraws surplus from the house balance.
    /// @param amount  CELO wei to withdraw.
    function withdrawHouse(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0,                      "LS: zero amount");
        require(amount <= address(this).balance, "LS: insufficient balance");
        (bool ok, ) = owner().call{value: amount}("");
        require(ok, "LS: transfer failed");
        emit HouseWithdrawn(owner(), amount);
    }

    /// @notice Pause / unpause the contract (emergency stop).
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Allows plain CELO top-ups to the house balance.
    receive() external payable {
        emit HouseFunded(msg.sender, msg.value);
    }
}
