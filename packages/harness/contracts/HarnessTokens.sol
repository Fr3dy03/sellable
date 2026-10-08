// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Base20} from "./Base20.sol";

/// @notice Clean control token. Should pass pre-check and the probe.
contract BenignToken is Base20 {
    constructor() Base20("Benign Harness Token", "BHT", 18, 1_000_000 ether) {}
}

/// @notice Classic honeypot: after setPair, transfers TO the pair (the sell
/// leg) revert, while buys (pair -> user) pass. Pre-check must catch the
/// setPair selector; the probe must produce SELLABLE=false.
contract HoneypotToken is Base20 {
    address public pair;
    bool public pairSet;

    constructor() Base20("Honeypot Harness", "HNY", 18, 1_000_000 ether) {}

    function setPair(address _pair) external onlyOwner {
        pair = _pair;
        pairSet = true;
    }

    function _beforeTransfer(address, address to, uint256) internal override {
        if (pairSet && to == pair) revert("SELL BLOCKED");
    }
}

/// @notice 5% fee-on-transfer on buy and sell legs (recipient gets amount - fee).
contract TaxToken is Base20 {
    uint256 public immutable feeBps = 500; // 5%
    address public constant sink = 0x0000000000000000000000000000000000000FEE;

    constructor() Base20("Tax Harness", "TAX", 18, 1_000_000 ether) {}

    function _taxed(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (from == address(0) || to == address(0) || to == sink || from == sink) {
            unchecked {
                balanceOf[from] -= amount;
                balanceOf[to] += amount;
            }
            emit Transfer(from, to, amount);
            return;
        }
        uint256 fee = (amount * feeBps) / 10_000;
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[sink] += fee;
            balanceOf[to] += amount - fee;
        }
        emit Transfer(from, to, amount - fee);
        if (fee > 0) emit Transfer(from, sink, fee);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _taxed(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _taxed(from, to, amount);
        return true;
    }
}

/// @notice Owner can blacklist wallets — sells blocked for those addresses.
contract BlacklistToken is Base20 {
    mapping(address => bool) public isBlacklisted;

    constructor() Base20("Blacklist Harness", "BLK", 18, 1_000_000 ether) {}

    function setBlacklist(address account, bool flagged) external onlyOwner {
        isBlacklisted[account] = flagged;
    }

    function _beforeTransfer(address from, address to, uint256) internal override {
        require(!isBlacklisted[from] && !isBlacklisted[to], "BLACKLISTED");
    }
}

/// @notice Owner can mint unlimited supply later (inflation rug risk).
contract MintLaterToken is Base20 {
    constructor() Base20("MintLater Harness", "MINT", 18, 1_000_000 ether) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/// @notice Impersonates official USDT: same name/symbol, wrong decimals (18 vs 6).
contract FakeUSDT is Base20 {
    constructor() Base20("Tether USD", "USDT", 18, 1_000_000 ether) {}
}
