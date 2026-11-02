// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Sellable Verdict Registry
/// @notice Publishes the latest Sellable probe result for a token. The probe and
///         full report stay off-chain; reportHash lets clients verify a report
///         against the on-chain attestation.
contract SellableVerdictRegistry {
    enum Verdict {
        Unreported,
        Sellable,
        HighTax,
        Honeypot,
        Inconclusive
    }

    struct Report {
        Verdict verdict;
        bool hasLoss;
        uint16 lossBps;
        uint64 publishedAt;
        bytes32 reportHash;
    }

    address public owner;
    address public publisher;
    mapping(address token => Report report) private latestReports;

    event VerdictPublished(
        address indexed token,
        Verdict verdict,
        bool hasLoss,
        uint16 lossBps,
        bytes32 reportHash,
        uint64 publishedAt,
        address indexed publisher
    );
    event PublisherChanged(address indexed previousPublisher, address indexed newPublisher);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();
    error InvalidVerdict();
    error InvalidLoss();

    constructor(address initialPublisher) {
        if (initialPublisher == address(0)) revert ZeroAddress();
        owner = msg.sender;
        publisher = initialPublisher;
        emit OwnershipTransferred(address(0), msg.sender);
        emit PublisherChanged(address(0), initialPublisher);
    }

    function publish(
        address token,
        Verdict verdict,
        bool hasLoss,
        uint16 lossBps,
        bytes32 reportHash
    ) external {
        if (msg.sender != publisher) revert Unauthorized();
        if (token == address(0)) revert ZeroAddress();
        if (verdict == Verdict.Unreported || uint8(verdict) > uint8(Verdict.Inconclusive)) {
            revert InvalidVerdict();
        }
        if (hasLoss && lossBps > 10_000) revert InvalidLoss();

        uint64 publishedAt = uint64(block.timestamp);
        latestReports[token] = Report(verdict, hasLoss, hasLoss ? lossBps : 0, publishedAt, reportHash);
        emit VerdictPublished(token, verdict, hasLoss, hasLoss ? lossBps : 0, reportHash, publishedAt, msg.sender);
    }

    function getLatest(address token) external view returns (Report memory) {
        return latestReports[token];
    }

    function setPublisher(address newPublisher) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newPublisher == address(0)) revert ZeroAddress();
        address previous = publisher;
        publisher = newPublisher;
        emit PublisherChanged(previous, newPublisher);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
