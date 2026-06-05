// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title PriceFeedDouble
/// @notice Test-only AggregatorV3Interface implementation.
///         Lives under test/ exclusively — MUST NOT be imported by any
///         contract under contracts/ or referenced in any deploy script.
///
///         Allows unit tests to simulate:
///           - Healthy rounds with configurable price and decimals
///           - Stale rounds (updatedAt in the past beyond maxStaleness)
///           - Zero / negative answers
///           - Incomplete rounds (answeredInRound < roundId)
///           - decimals() revert (unusable feed)
///           - latestRoundData() revert (unusable feed)
contract PriceFeedDouble is AggregatorV3Interface {

    // -------------------------------------------------------------------------
    // Configurable state (set by tests)
    // -------------------------------------------------------------------------

    int256  public mockAnswer;
    uint8   public mockDecimals;
    uint256 public mockUpdatedAt;
    uint80  public mockRoundId;
    uint80  public mockAnsweredInRound;

    bool    public revertOnDecimals;
    bool    public revertOnLatestRoundData;

    // -------------------------------------------------------------------------
    // Constructor — sensible defaults for a healthy feed
    // -------------------------------------------------------------------------

    /// @param _answer    Initial price answer (e.g. 0.5e8 for $0.50 with 8 decimals).
    /// @param _decimals  Feed precision (typically 8 for Chainlink USD feeds).
    constructor(int256 _answer, uint8 _decimals) {
        mockAnswer          = _answer;
        mockDecimals        = _decimals;
        mockUpdatedAt       = block.timestamp;
        mockRoundId         = 1;
        mockAnsweredInRound = 1;
    }

    // -------------------------------------------------------------------------
    // Test helpers — called by test scripts to configure scenarios
    // -------------------------------------------------------------------------

    function setAnswer(int256 _answer) external {
        mockAnswer = _answer;
    }

    function setDecimals(uint8 _decimals) external {
        mockDecimals = _decimals;
    }

    function setUpdatedAt(uint256 _updatedAt) external {
        mockUpdatedAt = _updatedAt;
    }

    function setRoundData(uint80 _roundId, uint80 _answeredInRound) external {
        mockRoundId         = _roundId;
        mockAnsweredInRound = _answeredInRound;
    }

    /// @notice Make the feed appear stale by setting updatedAt to a past timestamp.
    /// @param secondsAgo  How many seconds in the past to set updatedAt.
    function setStale(uint256 secondsAgo) external {
        mockUpdatedAt = block.timestamp - secondsAgo;
    }

    /// @notice Simulate an incomplete round (answeredInRound < roundId).
    function setIncompleteRound() external {
        mockRoundId         = 5;
        mockAnsweredInRound = 4; // answeredInRound < roundId
    }

    function setRevertOnDecimals(bool _revert) external {
        revertOnDecimals = _revert;
    }

    function setRevertOnLatestRoundData(bool _revert) external {
        revertOnLatestRoundData = _revert;
    }

    // -------------------------------------------------------------------------
    // AggregatorV3Interface implementation
    // -------------------------------------------------------------------------

    function decimals() external view override returns (uint8) {
        require(!revertOnDecimals, "PriceFeedDouble: decimals reverted");
        return mockDecimals;
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        require(!revertOnLatestRoundData, "PriceFeedDouble: latestRoundData reverted");
        return (
            mockRoundId,
            mockAnswer,
            mockUpdatedAt,
            mockUpdatedAt,
            mockAnsweredInRound
        );
    }

    // ── Unused AggregatorV3Interface functions required by the interface ──────

    function description() external pure override returns (string memory) {
        return "PriceFeedDouble";
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(uint80)
        external
        pure
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert("PriceFeedDouble: getRoundData not implemented");
    }
}
