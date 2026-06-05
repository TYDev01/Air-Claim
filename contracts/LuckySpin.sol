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

    // -------------------------------------------------------------------------
    // External — settle bet
    // -------------------------------------------------------------------------

    /// @notice Settle a pending bet by revealing the operator seed.
    ///
    ///         Flow inside this function:
    ///           1. Load the stored Bet.
    ///           2. Recompute userEntropy from immutable on-chain data.
    ///           3. Call randomness.revealAndConsume() — verifies the commitment
    ///              and returns the combined seed.
    ///           4. Draw 5 numbers from the seed via _drawNumbers().
    ///           5. Count matches via _countMatches().
    ///           6. Mark bet settled (EFFECT before INTERACTION).
    ///           7. Transfer payout if matches >= 3.
    ///
    ///         Anyone may call this after the operator has committed — in practice
    ///         the operator calls it as part of the off-chain round-close flow.
    ///
    /// @param betId        The id returned (via SpinPlaced event) at placeBet time.
    /// @param operatorSeed The operator's secret pre-image whose keccak256 was
    ///                     committed before the player placed their bet.
    function settleBet(uint256 betId, bytes32 operatorSeed)
        external
        nonReentrant
    {
        // ── checks ───────────────────────────────────────────────────────────
        Bet storage b = _bets[betId];
        require(b.player != address(0), "LS: unknown bet");
        require(!b.settled,             "LS: already settled");

        // Recompute userEntropy from locked on-chain data.
        // The operator cannot alter this — it is derived from the stored Bet.
        bytes32 userEntropy = keccak256(
            abi.encodePacked(b.player, b.picks, b.stake, betId)
        );

        // ── reveal ───────────────────────────────────────────────────────────
        // Calls CommitRevealRandomness.revealAndConsume — verifies the
        // commitment, mixes entropy, marks the request consumed, returns seed.
        uint256 seed = randomness.revealAndConsume(b.requestId, operatorSeed, userEntropy);

        // ── draw and match ───────────────────────────────────────────────────
        uint8[5] memory drawn   = _drawNumbers(seed);
        uint8          matches  = _countMatches(b.picks, drawn);

        // ── effects ──────────────────────────────────────────────────────────
        b.settled = true;

        // ── payout ───────────────────────────────────────────────────────────
        uint256 payout = _computePayout(b.stake, matches);

        if (payout > 0) {
            require(address(this).balance >= payout, "LS: house insolvent");
            (bool ok, ) = b.player.call{value: payout}("");
            require(ok, "LS: transfer failed");
        }

        emit SpinResult(betId, b.player, b.picks, drawn, matches, payout);
    }

    // -------------------------------------------------------------------------
    // Internal — payout calculation
    // -------------------------------------------------------------------------

    /// @dev Returns the payout for a given stake and match count.
    ///      3 matches → stake × MULTIPLIER_3 (5)
    ///      4 matches → stake × MULTIPLIER_4 (10)
    ///      5 matches → stake × MULTIPLIER_5 (25)
    ///      < 3       → 0
    ///
    ///      The house solvency check in placeBet ensures balance >= stake*25
    ///      at bet time. Between placeBet and settleBet the house balance can
    ///      only decrease if another bet is settled — the check in settleBet
    ///      above catches any edge case.
    function _computePayout(uint256 stake, uint8 matches)
        internal
        pure
        returns (uint256)
    {
        if (matches == 5) return stake * uint256(MULTIPLIER_5);
        if (matches == 4) return stake * uint256(MULTIPLIER_4);
        if (matches == 3) return stake * uint256(MULTIPLIER_3);
        return 0;
    }

    // -------------------------------------------------------------------------
    // External — place bet
    // -------------------------------------------------------------------------

    /// @notice Place a LuckySpin bet.
    ///
    ///         The operator must call IRandomnessSource.commit() BEFORE this
    ///         function is called and pass the resulting requestId here. This
    ///         locks the operator's entropy before seeing the player's picks,
    ///         preventing seed grinding.
    ///
    ///         userEntropy is derived deterministically from the bet's on-chain
    ///         data (player address, picks, stake, betId) and stored in the Bet
    ///         record. settleBet() later passes this stored value to
    ///         revealAndConsume() — the operator cannot manipulate it.
    ///
    /// @param picks      Five distinct numbers each in [1, 20]. Order does not
    ///                   matter for matching but must be supplied for entropy.
    /// @param requestId  Pending IRandomnessSource request id from the operator.
    function placeBet(uint8[5] calldata picks, uint256 requestId)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        // ── input validation ─────────────────────────────────────────────────

        uint256 stake = msg.value;
        require(stake > 0,       "LS: zero stake");
        require(stake <= stakeCap, "LS: stake exceeds cap");

        // Validate picks: each in [1, NUMBER_MAX], all distinct.
        _validatePicks(picks);

        // Request must be pending (committed, not yet consumed).
        require(randomness.isPending(requestId), "LS: request not pending");

        // Ensure this requestId is not already tied to another bet.
        require(_requestToBet[requestId] == 0, "LS: requestId in use");

        // ── house solvency check ─────────────────────────────────────────────
        // msg.value is already included in address(this).balance at this point.
        // Worst-case payout = stake * MULTIPLIER_5 (25×).
        // The house must hold at least that amount after receiving the stake.
        uint256 maxPayout = stake * uint256(MULTIPLIER_5);
        require(address(this).balance >= maxPayout, "LS: house cannot cover payout");

        // ── write bet ────────────────────────────────────────────────────────
        // userEntropy = keccak256(player, picks, stake, betId) is recomputed
        // in settleBet() from the stored Bet fields — nothing to store here.
        uint256 betId = _nextBetId++;

        _bets[betId] = Bet({
            player:      msg.sender,
            stake:       stake,
            picks:       picks,
            requestId:   requestId,
            settled:     false
        });

        _requestToBet[requestId] = betId;

        emit SpinPlaced(betId, msg.sender, stake, picks, requestId);
    }

    // -------------------------------------------------------------------------
    // Internal — draw and match logic
    // -------------------------------------------------------------------------

    /// @dev Draws 5 distinct numbers from [1, NUMBER_MAX] using a partial
    ///      Fisher-Yates shuffle driven by the commit-reveal seed.
    ///
    ///      Algorithm:
    ///        1. Initialise a virtual pool [1 .. NUMBER_MAX] in memory.
    ///        2. For each of the 5 draw slots:
    ///             a. Derive a sub-seed by hashing (seed, slotIndex).
    ///             b. Pick a random index within the remaining pool.
    ///             c. Record the value at that index as the drawn number.
    ///             d. Replace that slot with the last element and shrink the pool.
    ///        Each iteration re-hashes the seed so the draws are independent;
    ///        the swap-and-shrink guarantees all 5 drawn numbers are distinct.
    ///
    ///      Gas note: NUMBER_MAX = 20, so the pool is a 20-element memory array
    ///      (uint8[20]). Memory allocation is cheap at this size.
    ///
    /// @param seed  Final uint256 seed from IRandomnessSource.revealAndConsume().
    /// @return drawn  Five distinct numbers each in [1, NUMBER_MAX].
    function _drawNumbers(uint256 seed)
        internal
        pure
        returns (uint8[5] memory drawn)
    {
        // Initialise virtual pool [1 .. NUMBER_MAX].
        uint8[20] memory pool;
        for (uint8 i = 0; i < NUMBER_MAX; i++) {
            pool[i] = i + 1;
        }

        uint256 remaining = NUMBER_MAX;

        for (uint256 slot = 0; slot < PICK_COUNT; slot++) {
            // Derive an independent index for each slot.
            uint256 idx = uint256(keccak256(abi.encodePacked(seed, slot))) % remaining;

            drawn[slot] = pool[idx];

            // Swap the picked element with the last element and shrink the pool
            // so it can never be picked again.
            pool[idx] = pool[remaining - 1];
            remaining--;
        }
    }

    /// @dev Counts how many of the player's picks appear in the drawn numbers.
    ///      Order is irrelevant — only set membership matters.
    ///      O(PICK_COUNT²) = O(25) — constant cost, acceptable for n=5.
    ///
    /// @param picks  Player's five chosen numbers (stored in Bet).
    /// @param drawn  Five numbers produced by _drawNumbers().
    /// @return count  Number of matching values in [0, 5].
    function _countMatches(uint8[5] memory picks, uint8[5] memory drawn)
        internal
        pure
        returns (uint8 count)
    {
        for (uint256 i = 0; i < PICK_COUNT; i++) {
            for (uint256 j = 0; j < PICK_COUNT; j++) {
                if (picks[i] == drawn[j]) {
                    count++;
                    break; // each pick can match at most one drawn number
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal — pick validation
    // -------------------------------------------------------------------------

    /// @dev Reverts if any pick is outside [1, NUMBER_MAX] or if any two picks
    ///      are equal. Uses an O(n²) check which is acceptable for n=5.
    function _validatePicks(uint8[5] calldata picks) internal pure {
        for (uint256 i = 0; i < PICK_COUNT; i++) {
            require(picks[i] >= 1 && picks[i] <= NUMBER_MAX, "LS: pick out of range");
            for (uint256 j = i + 1; j < PICK_COUNT; j++) {
                require(picks[i] != picks[j], "LS: duplicate pick");
            }
        }
    }

    // -------------------------------------------------------------------------
    // View — bet info
    // -------------------------------------------------------------------------

    /// @notice Returns the userEntropy that will be passed to revealAndConsume
    ///         for a given betId. The operator uses this off-chain to prepare
    ///         the settleBet call.
    /// @dev    Recomputes from stored Bet data — no extra storage slot needed.
    function userEntropyFor(uint256 betId) external view returns (bytes32) {
        Bet storage b = _bets[betId];
        require(b.player != address(0), "LS: unknown bet");
        return keccak256(abi.encodePacked(b.player, b.picks, b.stake, betId));
    }

    /// @notice Returns the betId associated with a requestId, or 0 if none.
    function betIdForRequest(uint256 requestId) external view returns (uint256) {
        return _requestToBet[requestId];
    }
}
