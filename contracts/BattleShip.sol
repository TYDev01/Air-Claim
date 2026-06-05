// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IRandomnessSource.sol";

/// @title BattleShip
/// @notice Games-Lounge game. Player predicts which of 16 boxes (0–15) a
///         drone drops into and stakes native CELO (up to a cap). The drop
///         box is determined via IRandomnessSource (commit–reveal). A correct
///         prediction pays 2× the stake. An incorrect prediction forfeits it.
///
/// @dev    Commit–reveal flow mirrors LuckySpin:
///           1. Operator calls IRandomnessSource.commit() — receives requestId.
///           2. Player calls placeBet(box, requestId) with CELO stake.
///              Contract locks box and userEntropy on-chain.
///           3. Operator calls settleBet(betId, operatorSeed).
///              Contract recomputes userEntropy from storage, calls
///              revealAndConsume(), resolves drop = seed % 16, pays if correct.
///
///         House-balance check: contract rejects any bet whose maximum
///         possible payout (stake × 2) exceeds the house balance at bet time.
contract BattleShip is Ownable, ReentrancyGuard, Pausable {

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint8  public constant BOX_COUNT   = 16;   // boxes 0–15
    uint8  public constant WIN_MULTIPLIER = 2; // correct prediction pays 2× stake

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
        uint256 stake;      // CELO wei
        uint8   prediction; // player's chosen box in [0, BOX_COUNT)
        uint256 requestId;  // IRandomnessSource request id for this bet
        bool    settled;
    }

    /// @dev Auto-incrementing bet counter. 0 is reserved.
    uint256 private _nextBetId;

    mapping(uint256 => Bet)     private _bets;

    /// @dev requestId → betId reverse index.
    mapping(uint256 => uint256) private _requestToBet;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event BattlePlaced(
        uint256 indexed betId,
        address indexed player,
        uint256         stake,
        uint8           prediction,
        uint256         requestId
    );

    event BattleResult(
        uint256 indexed betId,
        address indexed player,
        uint8           prediction,
        uint8           dropBox,
        bool            won,
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
        require(_randomness != address(0), "BS: zero randomness");
        require(_stakeCap   >  0,          "BS: zero stake cap");

        randomness = IRandomnessSource(_randomness);
        stakeCap   = _stakeCap;
        _nextBetId = 1;
    }

    // -------------------------------------------------------------------------
    // Owner configuration
    // -------------------------------------------------------------------------

    /// @notice Update the maximum stake per bet.
    function setStakeCap(uint256 _cap) external onlyOwner {
        require(_cap > 0, "BS: zero cap");
        stakeCap = _cap;
        emit StakeCapUpdated(_cap);
    }

    /// @notice Owner funds the house balance with native CELO.
    function fund() external payable onlyOwner {
        require(msg.value > 0, "BS: zero fund");
        emit HouseFunded(msg.sender, msg.value);
    }

    /// @notice Owner withdraws surplus from the house balance.
    function withdrawHouse(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0,                      "BS: zero amount");
        require(amount <= address(this).balance, "BS: insufficient balance");
        (bool ok, ) = owner().call{value: amount}("");
        require(ok, "BS: transfer failed");
        emit HouseWithdrawn(owner(), amount);
    }

    /// @notice Pause / unpause the contract (emergency stop).
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Allows plain CELO top-ups to the house balance.
    receive() external payable {
        emit HouseFunded(msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------
    // External — place bet
    // -------------------------------------------------------------------------

    /// @notice Place a BattleShip bet.
    ///
    ///         The operator must call IRandomnessSource.commit() BEFORE this
    ///         function is called and pass the resulting requestId here. This
    ///         locks the operator's entropy before seeing the player's prediction.
    ///
    ///         userEntropy is derived from the player's on-chain data
    ///         (address, prediction, stake, betId) so the operator cannot
    ///         manipulate it at settleBet time.
    ///
    /// @param prediction  The box the player predicts the drone drops into [0, 15].
    /// @param requestId   Pending IRandomnessSource request id from the operator.
    function placeBet(uint8 prediction, uint256 requestId)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        // ── input validation ─────────────────────────────────────────────────

        uint256 stake = msg.value;
        require(stake > 0,          "BS: zero stake");
        require(stake <= stakeCap,  "BS: stake exceeds cap");
        require(prediction < BOX_COUNT, "BS: invalid box");

        require(randomness.isPending(requestId),   "BS: request not pending");
        require(_requestToBet[requestId] == 0,     "BS: requestId in use");

        // ── house solvency check ─────────────────────────────────────────────
        // msg.value is already in address(this).balance at this point.
        // Worst-case payout = stake * WIN_MULTIPLIER (2×).
        uint256 maxPayout = stake * uint256(WIN_MULTIPLIER);
        require(address(this).balance >= maxPayout, "BS: house cannot cover payout");

        // ── write bet ────────────────────────────────────────────────────────
        uint256 betId = _nextBetId++;

        _bets[betId] = Bet({
            player:     msg.sender,
            stake:      stake,
            prediction: prediction,
            requestId:  requestId,
            settled:    false
        });

        _requestToBet[requestId] = betId;

        emit BattlePlaced(betId, msg.sender, stake, prediction, requestId);
    }

    // -------------------------------------------------------------------------
    // View — bet helpers
    // -------------------------------------------------------------------------

    /// @notice Returns the userEntropy for a betId, recomputed from stored data.
    ///         The operator reads this off-chain before calling settleBet.
    function userEntropyFor(uint256 betId) external view returns (bytes32) {
        Bet storage b = _bets[betId];
        require(b.player != address(0), "BS: unknown bet");
        return keccak256(abi.encodePacked(b.player, b.prediction, b.stake, betId));
    }

    /// @notice Returns the betId associated with a requestId, or 0 if none.
    function betIdForRequest(uint256 requestId) external view returns (uint256) {
        return _requestToBet[requestId];
    }
}
