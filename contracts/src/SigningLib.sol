// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * Stage F′ FP-3 — governed-signing PURE helpers, extracted from `LeashAccountV5` to bring the account
 * under the 24,576-byte EIP-170 runtime-code limit (the FP-1 account was already 878B over; the
 * nested-decode added ~2KB). These are `public pure` (so they are deployed in THIS library, not
 * inlined into the account — the codesize saving) and touch NO storage, `msg.*`, `block.*`, or
 * `this` — a deterministic relocation of math, reviewed RELOCATION-SAFE (security-auditor, 2026-10-07).
 *
 * BINDING CONTRACT (security-auditor F-3): `validateGrant` REVERTS internally on every defect (never
 * returns a status). The account MUST call it unconditionally BEFORE any `pendingSigningGrant` write,
 * with NO try/catch — a reverting call aborts the whole propose tx, preserving the inlined fail-closed
 * semantics exactly. The library is deploy-time-linked (immutable address baked into the account
 * bytecode) and has zero authority over value: a wrong `structHash` can only fail the session-sig
 * recover (`BadIntentSignature`) or arm an inert digest no protocol honors — the account's caps,
 * spender set, deadline/expiry bounds, and budget debit all re-check the fields directly.
 */
// NOTE: a CONTRACT, not a Solidity `library` — library calls compile to DELEGATECALL, which would
// violate the C-03 "no delegatecall in the wall" invariant. As a deployed singleton contract with
// `external pure` functions, the account calls it via STATICCALL (opcode 0xfa), preserving C-03. It
// holds no state and is immutable once deployed; the account stores its address as an immutable.
contract SigningLib {
    error InvalidPolicy();
    error ZeroAddress();
    error DecodeMismatch();

    /// @notice The owner grant params for a flat or one-level-nested signing descriptor (moved here so
    ///         both `LeashAccountV5.proposeSigningGrant*` and `validateGrant` share the one type).
    struct SigningGrantParams {
        uint256 descriptorId;
        bytes32 domainSeparator;
        bytes32 typeHash;
        uint8 numTopFields;
        uint8 spenderLeafIndex;
        uint8 amountLeafIndex;
        uint8 deadlineLeafIndex;
        uint8 expiryLeafIndex; // 0xFF ⇒ none
        bytes32 nestedTypeHash; // 0 ⇒ flat
        uint8 nestedLeafStart;
        uint8 nestedLeafCount;
        address token;
        uint128 perIntentCap;
        uint64 maxDeadlineWindow;
    }

    /// @notice Reconstruct the EIP-712 `hashStruct` from the submitted leaf words — verbatim of the
    ///         former `LeashAccountV5._signingStructHash`. FLAT (`nestedTypeHash==0`): identical to
    ///         FP-1. NESTED: fold the one contiguous sub-struct run into a single hash word, then
    ///         assemble the top-level encodeData. Fail-closed `DecodeMismatch` on a mis-shaped array.
    function structHash(
        bytes32 typeHash,
        bytes32 nestedTypeHash,
        uint8 nestedLeafStart,
        uint8 nestedLeafCount,
        uint8 numTopFields,
        bytes32[] memory leaves
    ) public pure returns (bytes32) {
        if (nestedTypeHash == bytes32(0)) {
            if (leaves.length != numTopFields) revert DecodeMismatch();
            return keccak256(abi.encodePacked(typeHash, leaves));
        }
        uint256 totalLeaves = uint256(numTopFields) + nestedLeafCount - 1;
        if (leaves.length != totalLeaves) revert DecodeMismatch();
        if (nestedLeafCount == 0 || uint256(nestedLeafStart) + nestedLeafCount > totalLeaves) {
            revert DecodeMismatch();
        }
        bytes memory nestedBuf = abi.encodePacked(nestedTypeHash);
        for (uint256 i = 0; i < nestedLeafCount; i++) {
            nestedBuf = abi.encodePacked(nestedBuf, leaves[uint256(nestedLeafStart) + i]);
        }
        bytes32 nestedHash = keccak256(nestedBuf);
        bytes memory top = abi.encodePacked(typeHash);
        for (uint256 i = 0; i < nestedLeafStart; i++) {
            top = abi.encodePacked(top, leaves[i]);
        }
        top = abi.encodePacked(top, nestedHash);
        for (uint256 i = uint256(nestedLeafStart) + nestedLeafCount; i < leaves.length; i++) {
            top = abi.encodePacked(top, leaves[i]);
        }
        return keccak256(top);
    }

    /// @notice Validate a grant's fold spec + role-index layout (verbatim of the former
    ///         `LeashAccountV5._stageSigningGrant` prologue — FP-3 review R-3). Reverts on ANY defect;
    ///         returns the flat leaf-array length the submitter must later provide. The account keeps
    ///         the `pendingSigningGrant` storage write.
    function validateGrant(SigningGrantParams memory p) public pure returns (uint256 totalLeaves) {
        if (p.domainSeparator == bytes32(0) || p.typeHash == bytes32(0)) revert InvalidPolicy();
        if (p.token == address(0)) revert ZeroAddress();
        if (p.numTopFields == 0 || p.numTopFields > 32) revert InvalidPolicy();

        if (p.nestedTypeHash == bytes32(0)) {
            if (p.nestedLeafCount != 0 || p.nestedLeafStart != 0) revert InvalidPolicy();
            totalLeaves = p.numTopFields;
        } else {
            if (p.nestedLeafCount == 0) revert InvalidPolicy();
            if (p.nestedLeafStart >= p.numTopFields) revert InvalidPolicy();
            totalLeaves = uint256(p.numTopFields) + p.nestedLeafCount - 1;
            if (totalLeaves > 32) revert InvalidPolicy();
            if (uint256(p.nestedLeafStart) + p.nestedLeafCount > totalLeaves) revert InvalidPolicy();
        }

        if (p.spenderLeafIndex >= totalLeaves || p.amountLeafIndex >= totalLeaves || p.deadlineLeafIndex >= totalLeaves)
        {
            revert InvalidPolicy();
        }
        if (
            p.spenderLeafIndex == p.amountLeafIndex || p.spenderLeafIndex == p.deadlineLeafIndex
                || p.amountLeafIndex == p.deadlineLeafIndex
        ) {
            revert InvalidPolicy();
        }
        if (p.expiryLeafIndex != type(uint8).max) {
            if (p.expiryLeafIndex >= totalLeaves) revert InvalidPolicy();
            if (
                p.expiryLeafIndex == p.spenderLeafIndex || p.expiryLeafIndex == p.amountLeafIndex
                    || p.expiryLeafIndex == p.deadlineLeafIndex
            ) {
                revert InvalidPolicy();
            }
        }
    }
}
