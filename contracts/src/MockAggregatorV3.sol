// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockAggregatorV3 — a TEST-ONLY Chainlink `AggregatorV3Interface` feed.
/// @notice Faithful 8-decimal equity-price feed for the Robinhood Chain slice
///         (rung 3: real feed interface, mock data). Price, timestamps, round ids
///         and a hard-revert toggle are all owner-settable so the demo can drive
///         every one of the wall's four fail-closed predicates on demand:
///           - `setRevert(true)`        → `latestRoundData()` reverts (predicate 1)
///           - `setAnswer(0 or <0)`     → `answer <= 0`        (predicate 2)
///           - `setStale(age)`          → old `updatedAt`      (predicate 3)
///           - `setRoundMismatch()`     → `answeredInRound < roundId` (predicate 4)
///         The interface is byte-identical to Chainlink's, so swapping this mock
///         for a real `AggregatorV3Interface` address is a one-line config change.
contract MockAggregatorV3 {
    uint8 public constant decimals = 8;
    string public constant description = "MOCK / equity-price feed (8dp)";
    uint256 public constant version = 1;

    int256 private _answer;
    uint256 private _updatedAt;
    uint256 private _startedAt;
    uint80 private _roundId;
    uint80 private _answeredInRound;
    bool private _revert;

    constructor(int256 initialAnswer) {
        _answer = initialAnswer;
        _roundId = 1;
        _answeredInRound = 1;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
    }

    /// @notice Set a fresh price with `updatedAt == now` and a bumped round.
    function setAnswer(int256 answer) external {
        _answer = answer;
        _roundId += 1;
        _answeredInRound = _roundId;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
    }

    /// @notice Force the feed stale: `updatedAt` set `age` seconds in the past.
    function setStale(uint256 age) external {
        _updatedAt = block.timestamp - age;
    }

    /// @notice Force `updatedAt` into the FUTURE (an invalid timestamp → fail closed).
    function setFuture(uint256 ahead) external {
        _updatedAt = block.timestamp + ahead;
    }

    /// @notice Force `answeredInRound < roundId` (predicate 4 — incomplete round).
    function setRoundMismatch() external {
        _roundId += 2;
        // _answeredInRound left behind → answeredInRound < roundId.
    }

    /// @notice Toggle a hard revert on `latestRoundData()` (predicate 1).
    function setRevert(bool on) external {
        _revert = on;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        require(!_revert, "feed down");
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}
