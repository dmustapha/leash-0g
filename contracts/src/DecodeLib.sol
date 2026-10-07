// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * Stage F′ FP-3 — governed-CALL structured-arg decode, extracted PURE from `LeashAccountV5` to bring
 * the account under the 24,576-byte EIP-170 limit (ratified 2026-10-07, after SigningLib was not
 * enough). The decode logic reads NO account storage: it takes the account's `self` address and the
 * rule's `recipientMode` as arguments and does all shape/`==self`/arithmetic reverts here. The storage
 * policy checks that DID interleave the decode (the spender allowlist `callRuleSpender`, the recipient
 * `allowlist`, the bridge `bridgeRemoteToken` pin) are RETURNED for the account to perform — the only
 * safe way to relocate a storage-coupled decoder (Solidity cannot pass storage refs to a delegatecall
 * library). Behaviour is byte-identical to the former inlined `_checkStructuredArgs`/`_checkBridgeArgs`;
 * the full governed-call suite re-verifies it.
 *
 * A CONTRACT, not a Solidity `library` — library calls compile to DELEGATECALL, violating the C-03
 * "no delegatecall in the wall" invariant. As a deployed stateless singleton with `external pure`
 * functions, the account calls it via STATICCALL (0xfa), preserving C-03; its address is an account
 * immutable.
 */
interface IAggregatorV3Minimal {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract DecodeLib {
    error DecodeMismatch();
    error InfiniteApprovalForbidden();
    error BlanketApprovalForbidden();
    error RecipientNotSelf(address recipient);
    error BandOnlyForSwap(bytes4 selector);
    error PriceBandAssetMismatch(address expected, address got);
    error PremiumBreach(uint256 impliedPrice, uint256 maxPrice);
    error StaleOracle(uint256 updatedAt, uint256 maxStaleness);
    error OraclePriceInvalid();
    error OracleCallFailed();
    error NotAllowlisted(address to);

    bytes4 internal constant SEL_APPROVE = 0x095ea7b3;
    bytes4 internal constant SEL_INCREASE_ALLOWANCE = 0x39509351;
    bytes4 internal constant SEL_TRANSFER = 0xa9059cbb;
    bytes4 internal constant SEL_TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 internal constant SEL_DEPOSIT = 0x6e553f65;
    bytes4 internal constant SEL_BRIDGE_ETH_TO = 0xe11013dd;
    bytes4 internal constant SEL_BRIDGE_ERC20_TO = 0x540abf73;
    bytes4 internal constant SEL_OUTBOUND_TRANSFER = 0x7b3a3c8b;
    bytes4 internal constant SEL_WITHDRAW_ETH = 0x25e16063;
    bytes4 internal constant SEL_SWAP = 0x9908fc8b;

    /**
     * The decode result. The account must, after calling:
     *  - if `spenderToAllow != address(0)`   → require `callRuleSpender[ruleKey][spenderToAllow]`;
     *  - if `recipientToAllowlist != address(0)` → require `allowlist[recipientToAllowlist]` (set only
     *    when `recipientMode != self`; the self-mode `== self` check is already done here);
     *  - if `bridgeLocalToken != address(0)` → require the `bridgeRemoteToken[bridgeLocalToken]` pin
     *    equals `bridgeRemoteClaim` (and is set).
     */
    struct Decoded {
        uint256 chargeable;
        address spendToken;
        bool checkBoolReturn;
        address spenderToAllow;
        address recipientToAllowlist;
        address bridgeLocalToken;
        address bridgeRemoteClaim;
    }

    function _decodeAddress(bytes calldata data, uint256 offset) private pure returns (address) {
        bytes32 word = bytes32(data[offset:offset + 32]);
        if (uint256(word) >> 160 != 0) revert DecodeMismatch();
        return address(uint160(uint256(word)));
    }

    function _decodeUint(bytes calldata data, uint256 offset) private pure returns (uint256) {
        return uint256(bytes32(data[offset:offset + 32]));
    }

    /// @dev `recipientMode == 0` ⇒ must be self (checked here, pure). Else ⇒ returned for the account
    ///      to check `allowlist[.]`. Mirrors the former `_checkRecipient`.
    function _recipient(address to, uint8 recipientMode, address self) private pure returns (address allowlistCheck) {
        if (recipientMode == 0) {
            if (to != self) revert RecipientNotSelf(to);
            return address(0);
        }
        return to;
    }

    function decodeStructuredArgs(
        bytes4 selector,
        uint256 value,
        bytes calldata data,
        address self,
        uint8 recipientMode,
        address target
    ) public pure returns (Decoded memory d) {
        if (selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address spender = _decodeAddress(data, 4);
            uint256 amount = _decodeUint(data, 36);
            if (selector == SEL_APPROVE && amount == type(uint256).max) revert InfiniteApprovalForbidden();
            return Decoded(amount, target, true, spender, address(0), address(0), address(0));
        }
        if (selector == SEL_TRANSFER) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address to = _decodeAddress(data, 4);
            uint256 amount = _decodeUint(data, 36);
            return Decoded(amount, target, true, address(0), _recipient(to, recipientMode, self), address(0), address(0));
        }
        if (selector == SEL_TRANSFER_FROM) {
            if (data.length != 4 + 96) revert DecodeMismatch();
            address from = _decodeAddress(data, 4);
            address to = _decodeAddress(data, 36);
            uint256 amount = _decodeUint(data, 68);
            if (from != self) revert RecipientNotSelf(from);
            return Decoded(amount, target, true, address(0), _recipient(to, recipientMode, self), address(0), address(0));
        }
        if (selector == SEL_SET_APPROVAL_FOR_ALL) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            address operator = _decodeAddress(data, 4);
            uint256 approvedRaw = _decodeUint(data, 36);
            if (approvedRaw > 1) revert DecodeMismatch();
            if (approvedRaw == 1) revert BlanketApprovalForbidden();
            return Decoded(0, target, false, operator, address(0), address(0), address(0));
        }
        if (selector == SEL_DEPOSIT) {
            if (data.length != 4 + 64) revert DecodeMismatch();
            uint256 assets = _decodeUint(data, 4);
            address receiver = _decodeAddress(data, 36);
            return Decoded(assets, target, false, address(0), _recipient(receiver, recipientMode, self), address(0), address(0));
        }
        if (selector == SEL_SWAP) {
            if (data.length != 4 + 192) revert DecodeMismatch();
            address tokenIn = _decodeAddress(data, 4);
            uint256 amountIn = _decodeUint(data, 68);
            address recipient = _decodeAddress(data, 132);
            return Decoded(amountIn, tokenIn, false, address(0), _recipient(recipient, recipientMode, self), address(0), address(0));
        }
        if (isBridgeSelector(selector)) {
            return _decodeBridgeArgs(selector, value, data, self);
        }
        return Decoded(value, address(0), false, address(0), address(0), address(0), address(0));
    }

    function isBridgeSelector(bytes4 selector) public pure returns (bool) {
        return selector == SEL_BRIDGE_ETH_TO || selector == SEL_BRIDGE_ERC20_TO || selector == SEL_WITHDRAW_ETH
            || selector == SEL_OUTBOUND_TRANSFER;
    }

    function _decodeBridgeArgs(bytes4 selector, uint256 value, bytes calldata data, address self)
        private
        pure
        returns (Decoded memory)
    {
        if (selector == SEL_BRIDGE_ETH_TO) {
            if (data.length != 4 + 128) revert DecodeMismatch();
            address to = _decodeAddress(data, 4);
            uint256 minGas = _decodeUint(data, 36);
            if (minGas >> 32 != 0) revert DecodeMismatch();
            if (_decodeUint(data, 68) != 0x60) revert DecodeMismatch();
            if (_decodeUint(data, 100) != 0) revert DecodeMismatch();
            if (to != self) revert RecipientNotSelf(to);
            return Decoded(value, address(0), false, address(0), address(0), address(0), address(0));
        }
        if (selector == SEL_BRIDGE_ERC20_TO) {
            if (data.length != 4 + 224) revert DecodeMismatch();
            if (value != 0) revert DecodeMismatch();
            address localToken = _decodeAddress(data, 4);
            address remoteToken = _decodeAddress(data, 36);
            address to = _decodeAddress(data, 68);
            uint256 amount = _decodeUint(data, 100);
            uint256 minGas = _decodeUint(data, 132);
            if (minGas >> 32 != 0) revert DecodeMismatch();
            if (_decodeUint(data, 164) != 0xc0) revert DecodeMismatch();
            if (_decodeUint(data, 196) != 0) revert DecodeMismatch();
            if (to != self) revert RecipientNotSelf(to);
            // the bridgeRemoteToken pin check is storage → returned for the account.
            return Decoded(amount, localToken, false, address(0), address(0), localToken, remoteToken);
        }
        if (selector == SEL_OUTBOUND_TRANSFER) {
            if (data.length != 4 + 160) revert DecodeMismatch();
            if (value != 0) revert DecodeMismatch();
            address l1Token = _decodeAddress(data, 4);
            address to = _decodeAddress(data, 36);
            uint256 amount = _decodeUint(data, 68);
            if (_decodeUint(data, 100) != 0x80) revert DecodeMismatch();
            if (_decodeUint(data, 132) != 0) revert DecodeMismatch();
            if (to != self) revert RecipientNotSelf(to);
            return Decoded(amount, l1Token, false, address(0), address(0), address(0), address(0));
        }
        // SEL_WITHDRAW_ETH
        if (data.length != 4 + 32) revert DecodeMismatch();
        address dest = _decodeAddress(data, 4);
        if (dest != self) revert RecipientNotSelf(dest);
        return Decoded(value, address(0), false, address(0), address(0), address(0), address(0));
    }

    /// @notice The oracle price-band check for a governed swap — the former `LeashAccountV5._checkPriceBand`
    ///         body (the storage read `priceBand[ruleKey]` + the `band.set` early-return stay in the
    ///         account; the band fields are passed in). Decodes the swap, reads the Chainlink feed via
    ///         STATICCALL, and reverts on asset-mismatch / staleness / premium breach. `external view`
    ///         so the account invokes it via STATICCALL (C-03 preserved; the feed read is itself a
    ///         staticcall). Only called when the band is set.
    function checkPriceBand(
        address feed,
        address asset,
        uint32 maxDeviationBps,
        uint64 maxStaleness,
        bytes4 selector,
        bytes calldata data
    ) external view {
        if (selector != SEL_SWAP) revert BandOnlyForSwap(selector);
        if (data.length != 4 + 192) revert DecodeMismatch();
        address tokenOut = _decodeAddress(data, 36);
        uint256 amountIn = _decodeUint(data, 68);
        uint256 amountOutMin = _decodeUint(data, 100);
        if (tokenOut != asset) revert PriceBandAssetMismatch(asset, tokenOut);
        if (amountOutMin == 0) revert PremiumBreach(type(uint256).max, 0);

        try IAggregatorV3Minimal(feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0) revert OraclePriceInvalid();
            if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
                revert StaleOracle(updatedAt, maxStaleness);
            }
            if (answeredInRound < roundId) revert OraclePriceInvalid();

            uint256 impliedPrice18 = (amountIn * 1e18) / amountOutMin;
            uint256 oracle18 = uint256(answer) * 1e10;
            uint256 maxPrice = (oracle18 * (10_000 + maxDeviationBps)) / 10_000;
            if (impliedPrice18 > maxPrice) revert PremiumBreach(impliedPrice18, maxPrice);
        } catch {
            revert OracleCallFailed();
        }
    }
}
