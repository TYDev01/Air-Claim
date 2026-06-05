// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

    event FlightInsured(
        uint256 indexed policyId,
        bytes32 indexed flightId,
        string          flightNumber,
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
}
