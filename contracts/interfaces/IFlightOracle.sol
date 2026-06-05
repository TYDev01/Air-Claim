// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IFlightOracle
/// @notice Read interface that InsuredFlightsAgency depends on to query flight status.
///         The implementation (FlightOracle.sol) is the authoritative data source;
///         this interface decouples the insurance logic from any particular oracle design.
interface IFlightOracle {
    // -------------------------------------------------------------------------
    // Enums
    // -------------------------------------------------------------------------

    /// @notice Lifecycle states of a tracked flight.
    enum FlightStatus {
        Scheduled,  // 0 — flight has not yet departed
        Delayed,    // 1 — flight departed or is expected to depart late
        Cancelled,  // 2 — flight was cancelled
        Landed      // 3 — flight arrived at destination
    }

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    /// @notice Full data record for one flight.
    /// @param status       Current lifecycle status.
    /// @param delayMinutes Reported delay in whole minutes (0 if on-time or unknown).
    /// @param source       Arbitrary label identifying the data source (e.g. "FlightAware").
    /// @param updatedAt    Unix timestamp of the last write.
    struct FlightRecord {
        FlightStatus status;
        uint32       delayMinutes;
        string       source;
        uint64       updatedAt;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted whenever an authorised updater writes a new flight record.
    /// @param flightId     The flight identifier that was updated.
    /// @param status       New status.
    /// @param delayMinutes New delay value in minutes.
    /// @param updatedAt    Block timestamp of the update.
    event FlightStatusUpdated(
        bytes32 indexed flightId,
        FlightStatus    status,
        uint32          delayMinutes,
        uint64          updatedAt
    );

    // -------------------------------------------------------------------------
    // Read functions
    // -------------------------------------------------------------------------

    /// @notice Returns the complete stored record for a flight.
    /// @param flightId  keccak256 hash of the flight identifier string.
    /// @return record   The full FlightRecord; `updatedAt == 0` means never written.
    function getFlightRecord(bytes32 flightId)
        external
        view
        returns (FlightRecord memory record);

    /// @notice Convenience helper: returns only the delay in minutes.
    /// @param flightId  keccak256 hash of the flight identifier string.
    /// @return          Delay in minutes; 0 if on-time or not yet written.
    function getDelayMinutes(bytes32 flightId)
        external
        view
        returns (uint32);

    /// @notice Convenience helper: returns only the current status.
    /// @param flightId  keccak256 hash of the flight identifier string.
    /// @return          The FlightStatus enum value.
    function getStatus(bytes32 flightId)
        external
        view
        returns (FlightStatus);
}
