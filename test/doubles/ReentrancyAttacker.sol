// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title ReentrancyAttacker
/// @notice Test-only contract. On receiving CELO it immediately tries to
///         re-enter InsuredFlightsAgency.claimInsurance() with the same
///         flightId. ReentrancyGuard must block the second call.
///         Lives under test/ exclusively.
contract ReentrancyAttacker {
    address public target;
    bytes32 public flightId;
    bool    public attacked;

    constructor(address _target, bytes32 _flightId) {
        target   = _target;
        flightId = _flightId;
    }

    /// @notice Called by the test to initiate the first (legitimate) claim.
    function attack() external {
        (bool ok, ) = target.call(
            abi.encodeWithSignature("claimInsurance(bytes32)", flightId)
        );
        require(ok, "ReentrancyAttacker: initial call failed");
    }

    /// @notice Triggered when this contract receives CELO from claimInsurance.
    ///         Attempts to call claimInsurance again — should revert.
    receive() external payable {
        if (!attacked) {
            attacked = true;
            // This re-entrant call must be blocked by ReentrancyGuard.
            (bool ok, ) = target.call(
                abi.encodeWithSignature("claimInsurance(bytes32)", flightId)
            );
            // We do NOT require ok here — we just record whether it succeeded.
            // The test asserts ok == false.
            assembly { sstore(0x03, ok) } // slot 3 = reentrantSucceeded
        }
    }

    /// @notice Returns whether the re-entrant call succeeded (should be false).
    function reentrantSucceeded() external view returns (bool result) {
        assembly { result := sload(0x03) }
    }
}
