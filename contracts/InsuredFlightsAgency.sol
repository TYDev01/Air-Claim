// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./interfaces/IFlightOracle.sol";

/// @title InsuredFlightsAgency
/// @notice Parametric flight-delay insurance on Celo. Passengers pay a premium
///         when insuring a flight; if the flight is delayed past the threshold they
///         can claim 10 % of their ticket price, paid in stablecoin (when reserve
///         allows) or native CELO.
///
/// @dev    Price feed safety: every call to latestRoundData() is validated for
///         positive answer, freshness, and round completeness before being used to
///         move money.  On any feed failure the contract falls back to native-CELO
///         payout rather than paying a wrong amount.
///
///         Celo L2 sequencer note: as of June 2026, Chainlink does not publish a
///         sequencer-uptime feed for Celo. Strict staleness checks are therefore
///         the primary freshness guard. If a sequencer feed is deployed before
///         mainnet launch, _getValidatedCeloPrice() should be updated to check it
///         and revert during downtime / grace-period windows.
contract InsuredFlightsAgency is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Immutables — injected at construction, never hardcoded as literals
    // -------------------------------------------------------------------------

    /// @notice Chainlink CELO/USD price feed (AggregatorV3Interface).
    ///         Address resolved from the official Chainlink price-feed page for Celo
    ///         and confirmed on celoscan before mainnet deploy.
    AggregatorV3Interface public immutable priceFeed;

    /// @notice Stablecoin used for payouts when the reserve is sufficient.
    ///         Treated as a generic ERC-20; decimals read dynamically.
    IERC20 public immutable stablecoin;

    /// @notice Decimals of the injected stablecoin, read once at construction.
    uint8 public immutable stablecoinDecimals;

    // -------------------------------------------------------------------------
    // Mutable configuration (owner-adjustable)
    // -------------------------------------------------------------------------

    /// @notice Oracle that reports flight status and delay minutes.
    IFlightOracle public flightOracle;

    /// @notice Minimum delay (in minutes) before a flight is claimable.
    uint32 public delayThresholdMinutes;

    /// @notice Flat fee added to each passenger's premium on top of 10 % of ticket price.
    uint256 public baseFee;

    /// @notice Maximum age of a price-feed round before it is treated as stale.
    ///         Should be set to the feed's documented heartbeat + a small buffer.
    uint256 public maxStalenessSeconds;

    /// @notice Minimum seconds between successive checkFlightDelay calls for the
    ///         same flight, to prevent spam / oracle manipulation.
    uint256 public checkCooldownSeconds;

    // -------------------------------------------------------------------------
    // Policy storage
    // -------------------------------------------------------------------------

    struct PassengerInfo {
        address passenger;
        uint256 ticketPrice; // in wei (CELO)
        bool    claimed;
    }

    struct Policy {
        bytes32        flightId;        // keccak256 of raw flight identifier
        string         flightNumber;
        string         departure;
        string         arrival;
        uint64         flightDate;      // Unix timestamp of scheduled departure
        bool           claimable;       // set true once delay confirmed past threshold
        bool           exists;
        PassengerInfo[] passengers;
    }

    /// @dev Auto-incrementing policy counter; 0 is reserved (never issued).
    uint256 private _nextPolicyId;

    mapping(uint256 => Policy)  private _policies;

    /// @dev flightId → policyId; one active policy per flightId at a time.
    mapping(bytes32 => uint256) private _flightPolicy;

    /// @dev flightId → last checkFlightDelay call timestamp (rate-limit).
    mapping(bytes32 => uint256) private _lastCheckTimestamp;

    /// @dev Total CELO (wei) reserved to cover outstanding claimable policies.
    ///      Owner withdrawals must leave at least this amount in the contract.
    uint256 public reservedForClaims;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @dev The indexer derives tracked-flight metadata directly from this event,
    ///      so departure/arrival/flightDate are emitted here (they are already
    ///      stored in the Policy struct) to avoid a follow-up policyInfo() read
    ///      per policy. Field names are the on-chain source of truth; the backend
    ///      maps flightNumber→flightIata, departure→origin, arrival→destination,
    ///      flightDate→scheduledDeparture.
    event FlightInsured(
        uint256 indexed policyId,
        bytes32 indexed flightId,
        string          flightNumber,
        string          departure,
        string          arrival,
        uint64          flightDate,
        address[]       passengers,
        uint256         totalPremium
    );

    event DelayConfirmed(
        bytes32 indexed flightId,
        uint256 indexed policyId,
        uint32          delayMinutes
    );

    event InsuranceClaimed(
        uint256 indexed policyId,
        bytes32 indexed flightId,
        address indexed passenger,
        uint256         amount,
        bool            paidInStablecoin
    );

    event OracleUpdated(address indexed newOracle);
    event DelayThresholdUpdated(uint32 newThreshold);
    event BaseFeeUpdated(uint256 newBaseFee);
    event MaxStalenessUpdated(uint256 newMaxStaleness);
    event CheckCooldownUpdated(uint256 newCooldown);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _oracle               Deployed FlightOracle address.
    /// @param _priceFeed            Chainlink CELO/USD AggregatorV3Interface address.
    ///                              Injected per network — never a mock in production.
    /// @param _stablecoin           ERC-20 stablecoin used for payouts (e.g. cUSD).
    /// @param _delayThresholdMinutes Minimum delay to trigger a valid claim (default 30).
    /// @param _baseFee              Flat CELO fee (wei) per passenger on top of 10 % premium.
    /// @param _maxStalenessSeconds  Price-feed staleness window (e.g. 3600 for 1 h heartbeat).
    /// @param _checkCooldownSeconds Minimum gap between delay-check calls per flight.
    constructor(
        address _oracle,
        address _priceFeed,
        address _stablecoin,
        uint32  _delayThresholdMinutes,
        uint256 _baseFee,
        uint256 _maxStalenessSeconds,
        uint256 _checkCooldownSeconds
    ) Ownable(msg.sender) {
        require(_oracle    != address(0), "IFA: zero oracle");
        require(_priceFeed != address(0), "IFA: zero feed");
        require(_stablecoin != address(0), "IFA: zero stablecoin");
        require(_delayThresholdMinutes > 0, "IFA: zero threshold");
        require(_maxStalenessSeconds   > 0, "IFA: zero staleness");

        flightOracle           = IFlightOracle(_oracle);
        priceFeed              = AggregatorV3Interface(_priceFeed);
        stablecoin             = IERC20(_stablecoin);
        stablecoinDecimals     = _fetchStablecoinDecimals(_stablecoin);
        delayThresholdMinutes  = _delayThresholdMinutes;
        baseFee                = _baseFee;
        maxStalenessSeconds    = _maxStalenessSeconds;
        checkCooldownSeconds   = _checkCooldownSeconds;
        _nextPolicyId          = 1;
    }

    // -------------------------------------------------------------------------
    // Internal helpers — constructor only
    // -------------------------------------------------------------------------

    /// @dev Reads decimals() from the stablecoin; falls back to 18 on failure.
    function _fetchStablecoinDecimals(address token) private view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    // -------------------------------------------------------------------------
    // Owner configuration
    // -------------------------------------------------------------------------

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "IFA: zero oracle");
        flightOracle = IFlightOracle(_oracle);
        emit OracleUpdated(_oracle);
    }

    function setDelayThreshold(uint32 _minutes) external onlyOwner {
        require(_minutes > 0, "IFA: zero threshold");
        delayThresholdMinutes = _minutes;
        emit DelayThresholdUpdated(_minutes);
    }

    function setBaseFee(uint256 _fee) external onlyOwner {
        baseFee = _fee;
        emit BaseFeeUpdated(_fee);
    }

    function setMaxStaleness(uint256 _seconds) external onlyOwner {
        require(_seconds > 0, "IFA: zero staleness");
        maxStalenessSeconds = _seconds;
        emit MaxStalenessUpdated(_seconds);
    }

    function setCheckCooldown(uint256 _seconds) external onlyOwner {
        checkCooldownSeconds = _seconds;
        emit CheckCooldownUpdated(_seconds);
    }

    // -------------------------------------------------------------------------
    // External — view helpers
    // -------------------------------------------------------------------------

    /// @notice Summary struct returned by policyInfo() — avoids a raw storage
    ///         pointer being exposed and keeps the ABI clean for front-ends.
    struct PolicyView {
        uint256      policyId;
        bytes32      flightId;
        string       flightNumber;
        string       departure;
        string       arrival;
        uint64       flightDate;
        bool         claimable;
        bool         exists;
        uint256      passengerCount;
    }

    /// @notice Returns summary metadata for the policy associated with a flightId.
    ///         Does not include the passenger list — use passengerInfo() for that.
    /// @param flightId  keccak256(abi.encodePacked(rawFlightIdentifier)).
    /// @return view_    Populated PolicyView; exists=false if no policy found.
    function policyInfo(bytes32 flightId)
        external
        view
        returns (PolicyView memory view_)
    {
        uint256 policyId = _flightPolicy[flightId];
        if (policyId == 0) return view_; // zero-value struct, exists=false

        Policy storage p = _policies[policyId];
        view_ = PolicyView({
            policyId:       policyId,
            flightId:       p.flightId,
            flightNumber:   p.flightNumber,
            departure:      p.departure,
            arrival:        p.arrival,
            flightDate:     p.flightDate,
            claimable:      p.claimable,
            exists:         p.exists,
            passengerCount: p.passengers.length
        });
    }

    /// @notice Returns the PassengerInfo record for a specific passenger on a flight.
    /// @param flightId   keccak256(abi.encodePacked(rawFlightIdentifier)).
    /// @param passenger  Wallet address to look up.
    /// @return found       True if the passenger is insured on this flight.
    /// @return ticketPrice The passenger's insured ticket price in CELO wei.
    /// @return claimed     Whether this passenger has already claimed.
    function passengerInfo(bytes32 flightId, address passenger)
        external
        view
        returns (bool found, uint256 ticketPrice, bool claimed)
    {
        uint256 policyId = _flightPolicy[flightId];
        if (policyId == 0) return (false, 0, false);

        Policy storage p = _policies[policyId];
        for (uint256 i = 0; i < p.passengers.length; i++) {
            if (p.passengers[i].passenger == passenger) {
                return (true, p.passengers[i].ticketPrice, p.passengers[i].claimed);
            }
        }
    }

    /// @notice Returns all passenger records for a policy by policyId.
    ///         Primarily for off-chain tooling and subgraph indexers.
    /// @param policyId  The policy identifier returned by insureFlight.
    function passengerList(uint256 policyId)
        external
        view
        returns (PassengerInfo[] memory)
    {
        require(_policies[policyId].exists, "IFA: no policy");
        return _policies[policyId].passengers;
    }

    /// @notice Returns the policyId for a given flightId, or 0 if none exists.
    function policyIdFor(bytes32 flightId) external view returns (uint256) {
        return _flightPolicy[flightId];
    }

    /// @notice Returns the timestamp of the last checkFlightDelay call for a flight.
    ///         Use to calculate when the next check is permitted.
    function lastCheckTimestamp(bytes32 flightId) external view returns (uint256) {
        return _lastCheckTimestamp[flightId];
    }

    // -------------------------------------------------------------------------
    // External — emergency stop (owner only)
    // -------------------------------------------------------------------------

    /// @notice Pause the contract. Blocks insureFlight, checkFlightDelay, and
    ///         claimInsurance. Owner-only emergency stop.
    ///
    ///         Use when: a vulnerability is discovered, a price-feed anomaly is
    ///         detected, or a regulatory hold is required. Does NOT freeze
    ///         withdrawals — the owner can still drain the surplus reserve while
    ///         paused so funds are not permanently locked.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the contract and resume normal operation.
    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Internal — price feed
    // -------------------------------------------------------------------------

    /// @notice Result of a price-feed read attempt.
    /// @param valid      True only when all safety checks passed.
    /// @param price      Raw answer from latestRoundData(), denominated in feed units.
    /// @param feedDecimals Number of decimals the feed uses (read dynamically).
    struct PriceFeedResult {
        bool    valid;
        int256  price;
        uint8   feedDecimals;
    }

    /// @dev Reads the Chainlink CELO/USD feed and validates:
    ///        1. answer > 0 (price must be positive)
    ///        2. updatedAt != 0 (round must have been populated)
    ///        3. updatedAt >= block.timestamp - maxStalenessSeconds (freshness)
    ///        4. answeredInRound >= roundId (round must be complete)
    ///      Returns valid=false on ANY failure so callers can fall back to
    ///      native-CELO payout rather than reverting or paying a wrong amount.
    ///
    ///      Feed decimals are read via decimals() on every call — never assumed
    ///      to be 8 or 18 — so the function remains correct if the feed is
    ///      replaced with one of different precision.
    ///
    ///      Celo L2 note: no Chainlink sequencer-uptime feed exists for Celo as
    ///      of June 2026. Staleness check is therefore the primary freshness guard.
    function _getValidatedCeloPrice() internal view returns (PriceFeedResult memory result) {
        // Read decimals first — separate call, isolated try/catch.
        uint8 feedDecimals;
        try priceFeed.decimals() returns (uint8 d) {
            feedDecimals = d;
        } catch {
            // If decimals() reverts the feed is unusable.
            return PriceFeedResult({ valid: false, price: 0, feedDecimals: 0 });
        }

        // Read the latest round.
        uint80  roundId;
        int256  answer;
        uint256 updatedAt;
        uint80  answeredInRound;
        try priceFeed.latestRoundData() returns (
            uint80  _roundId,
            int256  _answer,
            uint256 /* startedAt */,
            uint256 _updatedAt,
            uint80  _answeredInRound
        ) {
            roundId        = _roundId;
            answer         = _answer;
            updatedAt      = _updatedAt;
            answeredInRound = _answeredInRound;
        } catch {
            // Feed call reverted — unusable.
            return PriceFeedResult({ valid: false, price: 0, feedDecimals: 0 });
        }

        // Validate answer sign.
        if (answer <= 0) {
            return PriceFeedResult({ valid: false, price: 0, feedDecimals: 0 });
        }

        // Validate round was ever populated.
        if (updatedAt == 0) {
            return PriceFeedResult({ valid: false, price: 0, feedDecimals: 0 });
        }

        // Validate freshness against the configured staleness window.
        // slither-disable-next-line timestamp
        if (block.timestamp - updatedAt > maxStalenessSeconds) {
            return PriceFeedResult({ valid: false, price: 0, feedDecimals: 0 });
        }

        // Validate round completeness.
        if (answeredInRound < roundId) {
            return PriceFeedResult({ valid: false, price: 0, feedDecimals: 0 });
        }

        return PriceFeedResult({ valid: true, price: answer, feedDecimals: feedDecimals });
    }

    // -------------------------------------------------------------------------
    // External — policy creation
    // -------------------------------------------------------------------------

    /// @notice Insure one or more passengers on a single flight.
    ///
    ///         Premium per passenger = 10 % of ticketPrice[i] + baseFee.
    ///         The caller must send exactly the sum of all passenger premiums as
    ///         msg.value (native CELO). Any excess is not refunded — callers
    ///         should compute the exact amount off-chain using premiumFor().
    ///
    ///         Only one active policy per flightId is allowed. A second call for
    ///         the same flightId reverts.
    ///
    /// @param flightId      keccak256(abi.encodePacked(rawFlightIdentifier)).
    /// @param flightNumber  Human-readable flight code, e.g. "ET309".
    /// @param departure     IATA departure airport code, e.g. "ADD".
    /// @param arrival       IATA arrival airport code, e.g. "LHR".
    /// @param flightDate    Scheduled departure as a Unix timestamp.
    /// @param passengers    Array of passenger wallet addresses.
    /// @param ticketPrices  Parallel array of ticket prices in CELO wei.
    ///                      Must be the same length as passengers.
    function insureFlight(
        bytes32        flightId,
        string calldata flightNumber,
        string calldata departure,
        string calldata arrival,
        uint64          flightDate,
        address[] calldata passengers,
        uint256[] calldata ticketPrices
    ) external payable whenNotPaused nonReentrant {
        // --- input validation ---
        require(flightId != bytes32(0),             "IFA: zero flightId");
        require(bytes(flightNumber).length > 0,     "IFA: empty flightNumber");
        require(passengers.length > 0,              "IFA: no passengers");
        require(passengers.length == ticketPrices.length, "IFA: length mismatch");
        require(flightDate > block.timestamp,       "IFA: flight date in past");
        require(_flightPolicy[flightId] == 0,       "IFA: policy exists");

        // --- premium calculation ---
        uint256 totalPremium = 0;
        for (uint256 i = 0; i < passengers.length; i++) {
            require(passengers[i] != address(0), "IFA: zero passenger");
            require(ticketPrices[i] > 0,         "IFA: zero ticket price");
            // 10 % of ticket price, rounded down, plus flat base fee
            totalPremium += (ticketPrices[i] / 10) + baseFee;
        }
        require(msg.value == totalPremium, "IFA: wrong premium");

        // --- reserve accounting ---
        // Worst-case payout = 10 % of each ticket price summed across passengers.
        // This is added to reservedForClaims so owner withdrawals can never
        // touch funds owed to active policies.
        uint256 maxPayout = 0;
        for (uint256 i = 0; i < passengers.length; i++) {
            maxPayout += ticketPrices[i] / 10;
        }
        reservedForClaims += maxPayout;

        // --- write policy ---
        uint256 policyId = _nextPolicyId++;
        Policy storage p = _policies[policyId];
        p.flightId    = flightId;
        p.flightNumber = flightNumber;
        p.departure   = departure;
        p.arrival     = arrival;
        p.flightDate  = flightDate;
        p.claimable   = false;
        p.exists      = true;

        for (uint256 i = 0; i < passengers.length; i++) {
            p.passengers.push(PassengerInfo({
                passenger:   passengers[i],
                ticketPrice: ticketPrices[i],
                claimed:     false
            }));
        }

        _flightPolicy[flightId] = policyId;

        // --- event ---
        // Copy to memory array for the event (storage arrays can't be passed directly).
        address[] memory passengersCopy = new address[](passengers.length);
        for (uint256 i = 0; i < passengers.length; i++) {
            passengersCopy[i] = passengers[i];
        }

        emit FlightInsured(
            policyId,
            flightId,
            flightNumber,
            departure,
            arrival,
            flightDate,
            passengersCopy,
            totalPremium
        );
    }

    /// @notice Returns the exact premium a caller must send for a given set of
    ///         ticket prices. Use this off-chain to build the insureFlight call.
    /// @param ticketPrices  Array of ticket prices in CELO wei.
    /// @return total        Total msg.value required.
    function premiumFor(uint256[] calldata ticketPrices)
        external
        view
        returns (uint256 total)
    {
        for (uint256 i = 0; i < ticketPrices.length; i++) {
            total += (ticketPrices[i] / 10) + baseFee;
        }
    }

    // -------------------------------------------------------------------------
    // External — claim
    // -------------------------------------------------------------------------

    /// @notice Claim insurance payout for a delayed or cancelled flight.
    ///
    ///         Checks (in order):
    ///           1. A policy exists for flightId.
    ///           2. The policy has been marked claimable (delay confirmed).
    ///           3. msg.sender is an insured passenger on the policy.
    ///           4. msg.sender has not already claimed.
    ///
    ///         Payout = 10 % of the caller's insured ticket price.
    ///
    ///         Payment path (checks-effects-interactions strictly observed):
    ///           - State is updated (claimed flag, reservedForClaims) BEFORE any
    ///             value transfer to prevent reentrancy.
    ///           - If the price feed is valid and the contract's stablecoin balance
    ///             covers the converted amount, pays in stablecoin via SafeERC20.
    ///           - Otherwise pays native CELO.
    ///           - On any price-feed failure the contract always falls back to CELO
    ///             rather than reverting, so claims are never permanently blocked by
    ///             a stale oracle.
    ///
    /// @param flightId  keccak256(abi.encodePacked(rawFlightIdentifier)).
    function claimInsurance(bytes32 flightId)
        external
        whenNotPaused
        nonReentrant
    {
        // ── CHECKS ──────────────────────────────────────────────────────────

        uint256 policyId = _flightPolicy[flightId];
        require(policyId != 0, "IFA: no policy");

        Policy storage p = _policies[policyId];
        require(p.exists,    "IFA: no policy");
        require(p.claimable, "IFA: not claimable");

        // Locate the caller in the passenger list.
        uint256 passengerIndex = type(uint256).max;
        for (uint256 i = 0; i < p.passengers.length; i++) {
            if (p.passengers[i].passenger == msg.sender) {
                passengerIndex = i;
                break;
            }
        }
        require(passengerIndex != type(uint256).max, "IFA: not insured");

        PassengerInfo storage pi = p.passengers[passengerIndex];
        require(!pi.claimed, "IFA: already claimed");

        // Payout amount: 10 % of the passenger's insured ticket price.
        uint256 payoutCelo = pi.ticketPrice / 10;
        require(payoutCelo > 0, "IFA: zero payout");

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Mark claimed and reduce the reserve BEFORE any external call.

        pi.claimed = true;

        // reservedForClaims was incremented by payoutCelo at insure-time.
        // Safe: payoutCelo <= reservedForClaims by construction.
        reservedForClaims -= payoutCelo;

        // ── INTERACTIONS ─────────────────────────────────────────────────────

        // Attempt stablecoin payout first.
        PriceFeedResult memory pr = _getValidatedCeloPrice();
        bool paidInStablecoin = false;

        if (pr.valid) {
            uint256 stablecoinAmount = _celoToStablecoin(payoutCelo, pr);

            if (
                stablecoinAmount > 0 &&
                stablecoin.balanceOf(address(this)) >= stablecoinAmount
            ) {
                stablecoin.safeTransfer(msg.sender, stablecoinAmount);
                paidInStablecoin = true;
            }
        }

        // Fall back to native CELO if stablecoin path was not taken.
        if (!paidInStablecoin) {
            require(address(this).balance >= payoutCelo, "IFA: insufficient CELO reserve");
            (bool sent, ) = msg.sender.call{value: payoutCelo}("");
            require(sent, "IFA: CELO transfer failed");
        }

        emit InsuranceClaimed(policyId, flightId, msg.sender, payoutCelo, paidInStablecoin);
    }

    // -------------------------------------------------------------------------
    // External — reserve management (owner only)
    // -------------------------------------------------------------------------

    /// @notice Withdraw unallocated CELO from the contract to the owner.
    ///
    ///         The contract holds two classes of CELO:
    ///           1. reservedForClaims — owed to claimable passengers; untouchable.
    ///           2. Surplus — premiums that exceed worst-case payouts, profit, etc.
    ///
    ///         This function only releases surplus. It reverts if the requested
    ///         amount would reduce the contract balance below reservedForClaims.
    ///
    /// @param amount  CELO (wei) to withdraw. Must be <= withdrawableCelo().
    function withdrawCelo(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "IFA: zero amount");
        require(amount <= withdrawableCelo(), "IFA: insufficient surplus");

        (bool sent, ) = owner().call{value: amount}("");
        require(sent, "IFA: CELO transfer failed");

        emit CeloWithdrawn(owner(), amount);
    }

    /// @notice Withdraw stablecoin held by the contract to the owner.
    ///
    ///         Solvency note — why there is no stablecoin reserve guard:
    ///         Every claim is fully collateralised in CELO. insureFlight()
    ///         adds the worst-case payout to reservedForClaims (CELO wei), and
    ///         withdrawCelo() can never reduce the CELO balance below that
    ///         reserve. claimInsurance() pays stablecoin only when a valid feed
    ///         AND a sufficient stablecoin balance are both present, and
    ///         otherwise falls back to native CELO — which is always available
    ///         because of the CELO reserve. Stablecoin is therefore a
    ///         *preferred*, never a *required*, payout path: draining it to zero
    ///         cannot make any outstanding claim unpayable, only shift it to CELO.
    ///
    ///         Consequently this function intentionally guards only against
    ///         withdrawing more than the contract holds — there is no separate
    ///         stablecoin reserve to protect. Operators who want stablecoin
    ///         (rather than CELO) payouts must keep the contract topped up.
    ///
    /// @param amount  Stablecoin units to withdraw.
    function withdrawStablecoin(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "IFA: zero amount");
        require(
            stablecoin.balanceOf(address(this)) >= amount,
            "IFA: insufficient stablecoin"
        );
        stablecoin.safeTransfer(owner(), amount);
        emit StablecoinWithdrawn(owner(), amount);
    }

    /// @notice Returns the amount of CELO (wei) the owner may currently withdraw.
    ///         Equals contract balance minus reservedForClaims.
    ///         Returns 0 rather than underflowing if the reserve exceeds balance
    ///         (should not happen in normal operation but guards against edge cases).
    function withdrawableCelo() public view returns (uint256) {
        uint256 bal = address(this).balance;
        if (bal <= reservedForClaims) return 0;
        return bal - reservedForClaims;
    }

    /// @notice Allows the contract to receive plain CELO transfers (e.g. owner
    ///         topping up the CELO payout reserve directly).
    receive() external payable {}

    // -------------------------------------------------------------------------
    // Additional events for reserve management
    // -------------------------------------------------------------------------

    event CeloWithdrawn(address indexed to, uint256 amount);
    event StablecoinWithdrawn(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // External — delay confirmation
    // -------------------------------------------------------------------------

    /// @notice Reads the flight oracle and, if the delay exceeds the threshold,
    ///         marks the policy as claimable. Anyone may call this — it is
    ///         rate-limited per flight to prevent spam and oracle manipulation.
    ///
    ///         Conditions that mark a flight claimable:
    ///           - An active policy exists for the flightId.
    ///           - The oracle record has been written (updatedAt != 0).
    ///           - The oracle status is Delayed or Cancelled.
    ///           - delayMinutes > delayThresholdMinutes.
    ///
    ///         The function is idempotent: calling it again on an already-claimable
    ///         flight is a no-op (does not revert, just returns early).
    ///
    /// @param flightId  keccak256(abi.encodePacked(rawFlightIdentifier)).
    function checkFlightDelay(bytes32 flightId)
        external
        whenNotPaused
        nonReentrant
    {
        // --- rate limit ---
        require(
            block.timestamp >= _lastCheckTimestamp[flightId] + checkCooldownSeconds,
            "IFA: check too soon"
        );
        _lastCheckTimestamp[flightId] = block.timestamp;

        // --- policy must exist ---
        uint256 policyId = _flightPolicy[flightId];
        require(policyId != 0, "IFA: no policy");

        Policy storage p = _policies[policyId];
        require(p.exists, "IFA: no policy");

        // --- already claimable: no-op ---
        if (p.claimable) return;

        // --- read oracle ---
        IFlightOracle.FlightRecord memory record = flightOracle.getFlightRecord(flightId);

        // Oracle has never been written — nothing to confirm yet.
        if (record.updatedAt == 0) return;

        // Cancelled flights are always claimable — skip the delay check.
        if (record.status == IFlightOracle.FlightStatus.Cancelled) {
            p.claimable = true;
            emit DelayConfirmed(flightId, policyId, record.delayMinutes);
            return;
        }

        // For any other status, only Delayed qualifies and the delay must
        // strictly exceed the configured threshold.
        if (record.status != IFlightOracle.FlightStatus.Delayed) return;
        if (record.delayMinutes <= delayThresholdMinutes) return;

        // --- mark claimable ---
        p.claimable = true;

        emit DelayConfirmed(flightId, policyId, record.delayMinutes);
    }

    // -------------------------------------------------------------------------
    // Internal — price feed (continued)
    // -------------------------------------------------------------------------

    /// @dev Converts a CELO amount (wei, 18 decimals) to stablecoin units using
    ///      a validated price feed result.
    ///
    ///      Scaling logic:
    ///        stablecoinAmount = celoWei * price / 10^(18 + feedDecimals - stablecoinDecimals)
    ///
    ///      where:
    ///        - celoWei is in 1e18 units
    ///        - price   is in feedDecimals units (e.g. 1e8 for 8-decimal feed)
    ///        - result  is in stablecoinDecimals units
    ///
    ///      Returns 0 if the price result is invalid (caller must fall back to CELO).
    function _celoToStablecoin(uint256 celoWei, PriceFeedResult memory pr)
        internal
        view
        returns (uint256)
    {
        if (!pr.valid) return 0;

        // Combined exponent: 18 (CELO decimals) + feedDecimals - stablecoinDecimals
        // Use uint256 arithmetic; feedDecimals and stablecoinDecimals are both uint8 (max 255).
        uint256 divisorExp = 18 + uint256(pr.feedDecimals) - uint256(stablecoinDecimals);
        uint256 divisor    = 10 ** divisorExp;

        // celoWei * price / divisor
        // price > 0 is guaranteed by the validity check in _getValidatedCeloPrice.
        return (celoWei * uint256(pr.price)) / divisor;
    }
}
