// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IFlightOracle.sol";

/// @title FlightOracle
/// @notice Authoritative on-chain store of flight status records, updated by a
///         permissioned off-chain relay. InsuredFlightsAgency reads from this
///         contract via the IFlightOracle interface.
///
/// @dev    Access control uses OpenZeppelin AccessControl:
///           - DEFAULT_ADMIN_ROLE  → contract owner; can grant/revoke all roles.
///           - UPDATER_ROLE        → off-chain relay account(s) authorised to write
///                                   flight records. Rotatable without redeployment.
///
///         flightId convention: keccak256(abi.encodePacked(rawFlightIdString)).
///         All callers (oracle relay, insurance contract, front-end) must hash
///         consistently using this encoding.
contract FlightOracle is IFlightOracle, AccessControl {
    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @dev Keyed by keccak256(abi.encodePacked(rawFlightId)).
    mapping(bytes32 => FlightRecord) private _records;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param admin   Address that receives DEFAULT_ADMIN_ROLE and initial UPDATER_ROLE.
    ///                Typically the deployer; can delegate UPDATER_ROLE to a relay later.
    constructor(address admin) {
        require(admin != address(0), "FlightOracle: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPDATER_ROLE, admin);
    }

    // -------------------------------------------------------------------------
    // Write — UPDATER_ROLE only
    // -------------------------------------------------------------------------

    /// @notice Creates or overwrites the record for a flight.
    /// @param flightId      keccak256(abi.encodePacked(rawFlightId)).
    /// @param status        New lifecycle status.
    /// @param delayMinutes  Reported delay in whole minutes; 0 if on-time.
    /// @param source        Arbitrary data-source label (e.g. "FlightAware").
    function updateFlight(
        bytes32     flightId,
        FlightStatus status,
        uint32      delayMinutes,
        string calldata source
    ) external onlyRole(UPDATER_ROLE) {
        require(flightId != bytes32(0), "FlightOracle: zero flightId");

        uint64 ts = uint64(block.timestamp);

        _records[flightId] = FlightRecord({
            status:       status,
            delayMinutes: delayMinutes,
            source:       source,
            updatedAt:    ts
        });

        emit FlightStatusUpdated(flightId, status, delayMinutes, ts);
    }

    // -------------------------------------------------------------------------
    // IFlightOracle — read functions
    // -------------------------------------------------------------------------

    /// @inheritdoc IFlightOracle
    function getFlightRecord(bytes32 flightId)
        external
        view
        override
        returns (FlightRecord memory)
    {
        return _records[flightId];
    }

    /// @inheritdoc IFlightOracle
    function getDelayMinutes(bytes32 flightId)
        external
        view
        override
        returns (uint32)
    {
        return _records[flightId].delayMinutes;
    }

    /// @inheritdoc IFlightOracle
    function getStatus(bytes32 flightId)
        external
        view
        override
        returns (FlightStatus)
    {
        return _records[flightId].status;
    }
}
