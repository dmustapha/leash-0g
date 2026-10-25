// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * AQ-FND — the V6 per-asset policy helper, extracted PURE from `LeashAccountV6` to keep the
 * account under the 24,576-byte EIP-170 limit (the same lever as SigningLib/DecodeLib, FP-3).
 * Reads NO account storage: every function takes the stored values as arguments and reverts
 * on violation; the account performs all storage writes. A CONTRACT, not a Solidity `library`
 * (library calls compile to DELEGATECALL, violating C-03); the account calls it via STATICCALL
 * and pins its address as an immutable. Deployed deterministically alongside the other two
 * helper singletons so the cross-chain same-address initcode commits to it.
 *
 * The V6 policy structs are DECLARED here (the SigningLib.SigningIntentPolicy pattern) so the
 * account and the helper share one layout by construction.
 */
contract PolicyLib {
    error InvalidPolicy();
    error CapInvariant(uint128 windowCap, uint128 perTransferCap); // G-1 (NON-strict: == allowed)
    error OverWindowCap(uint256 attempted, uint128 cap); // G-2
    error NotTightening();
    error NotSubsetOfEnvelope(); // G-6
    error PayloadMismatch();

    /// @notice One governed asset (asset(0) = native). See LeashAccountV6 M-1.
    struct AssetPolicy {
        bool enabled;
        uint128 perTransferCap;
        uint128 windowCap;
        uint32 windowSeconds;
    }

    /// @notice The G-2 two-bucket sliding meter.
    struct WindowMeter {
        uint128 cur;
        uint128 prev;
        uint64 start;
    }

    /// @notice An owner-committed per-asset envelope ceiling (M-2).
    struct EnvelopeEntry {
        bool set;
        uint128 maxPerTransferCap;
        uint128 maxWindowCap;
        uint32 minWindowSeconds;
    }

    /// @notice Session-global bounds.
    struct SessionPolicy {
        uint32 ruleWindowSeconds;
        uint64 expiresAt;
    }

    // governed-proposal kinds (the account's generic propose/apply pair)
    uint8 public constant KIND_ASSET = 1;
    uint8 public constant KIND_ENVELOPE = 2;
    uint8 public constant KIND_SESSION = 3;
    uint8 public constant KIND_PAYEE = 4;

    /// @notice G-1 + shape validation for an asset policy write.
    function validateAsset(AssetPolicy calldata p) public pure {
        if (p.windowSeconds == 0) revert InvalidPolicy();
        if (p.windowCap < p.perTransferCap) revert CapInvariant(p.windowCap, p.perTransferCap);
    }

    function validateEnvelope(EnvelopeEntry calldata e) public pure {
        if (e.minWindowSeconds == 0 || e.maxWindowCap < e.maxPerTransferCap) revert InvalidPolicy();
    }

    /// @notice Validate a governed-proposal payload at PROPOSE time (fail early; the account
    ///         re-validates concrete writes at apply through the same code paths).
    function validatePayload(uint8 kind, bytes calldata payload) external pure {
        if (kind == KIND_ASSET) {
            (, AssetPolicy memory p) = abi.decode(payload, (address, AssetPolicy));
            if (p.windowSeconds == 0) revert InvalidPolicy();
            if (p.windowCap < p.perTransferCap) revert CapInvariant(p.windowCap, p.perTransferCap);
        } else if (kind == KIND_ENVELOPE) {
            (, EnvelopeEntry memory e) = abi.decode(payload, (address, EnvelopeEntry));
            if (e.minWindowSeconds == 0 || e.maxWindowCap < e.maxPerTransferCap) revert InvalidPolicy();
        } else if (kind == KIND_SESSION) {
            SessionPolicy memory sp = abi.decode(payload, (SessionPolicy));
            if (sp.ruleWindowSeconds == 0) revert InvalidPolicy();
        } else if (kind == KIND_PAYEE) {
            (, address payee) = abi.decode(payload, (address, address));
            if (payee == address(0)) revert InvalidPolicy();
        } else {
            revert InvalidPolicy();
        }
    }

    /// @notice G-6: the agent's caps must be a subset of the committed ceiling.
    function assertSubset(AssetPolicy calldata p, EnvelopeEntry calldata e) external pure {
        if (
            p.perTransferCap > e.maxPerTransferCap || p.windowCap > e.maxWindowCap
                || p.windowSeconds < e.minWindowSeconds
        ) revert NotSubsetOfEnvelope();
    }

    /// @notice Attenuation comparator: every dimension of `p` must be ≤ `cur`
    ///         (windowSeconds ≥ cur: a LONGER window is tighter).
    function assertTighterAsset(AssetPolicy calldata p, AssetPolicy calldata cur) external pure {
        if (
            p.perTransferCap > cur.perTransferCap || p.windowCap > cur.windowCap
                || p.windowSeconds < cur.windowSeconds
        ) revert NotTightening();
    }

    function assertTighterEnvelope(EnvelopeEntry calldata e, EnvelopeEntry calldata cur) external pure {
        if (
            e.maxPerTransferCap > cur.maxPerTransferCap || e.maxWindowCap > cur.maxWindowCap
                || e.minWindowSeconds < cur.minWindowSeconds
        ) revert NotTightening();
    }

    /// @notice The C-tier queueing decision for an agent enable: queue when the asked window
    ///         exceeds `sharpBps` of the ceiling, or when the write would WIDEN a live policy.
    function shouldQueue(AssetPolicy calldata p, AssetPolicy calldata cur, EnvelopeEntry calldata e, uint32 sharpBps)
        external
        pure
        returns (bool)
    {
        bool widensLive = cur.enabled
            && (
                p.perTransferCap > cur.perTransferCap || p.windowCap > cur.windowCap
                    || p.windowSeconds < cur.windowSeconds
            );
        bool sharp = uint256(p.windowCap) * 10_000 > uint256(e.maxWindowCap) * sharpBps;
        return sharp || widensLive;
    }

    /// @notice G-2: the two-bucket sliding debit. Estimate = `cur + prev·(W−offset)/W + amount`;
    ///         reverts past the cap; returns the rolled meter for the account to store. `view`
    ///         (reads block.timestamp) so the account STATICCALLs it.
    function slide(WindowMeter calldata m0, uint32 windowSeconds, uint256 amount, uint128 cap)
        external
        view
        returns (uint128 cur, uint128 prev, uint64 start, uint128 estimate)
    {
        uint256 w = windowSeconds;
        cur = m0.cur;
        prev = m0.prev;
        start = m0.start;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= 2 * w) {
            prev = 0;
            cur = 0;
            start = uint64(block.timestamp - (elapsed % w)); // keep the bucket grid aligned
        } else if (elapsed >= w) {
            prev = cur;
            cur = 0;
            start = uint64(uint256(start) + w);
        }
        uint256 offset = block.timestamp - start; // 0 .. w-1
        uint256 attempted = (uint256(prev) * (w - offset)) / w + uint256(cur) + amount;
        if (attempted > cap) revert OverWindowCap(attempted, cap);
        cur = uint128(uint256(cur) + amount); // ≤ attempted ≤ cap ⇒ fits uint128
        estimate = uint128(attempted);
    }
}
