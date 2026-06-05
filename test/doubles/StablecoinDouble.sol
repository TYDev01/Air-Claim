// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title StablecoinDouble
/// @notice Minimal ERC-20 test double for the stablecoin slot in
///         InsuredFlightsAgency. Lives under test/ exclusively.
///         Has a public mint() so tests can fund the contract reserve.
contract StablecoinDouble is ERC20 {
    uint8 private _dec;

    constructor(string memory name, string memory symbol, uint8 dec_)
        ERC20(name, symbol)
    {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
