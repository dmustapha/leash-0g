// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
    // Signatures byte-identical to the LeashAccountV5 declarations ⇒ identical revert selectors, so the
    // reconstruct-and-bound extraction (FP-4 Slice-2, D-FP4-2d EIP-170 relief) is behavior-transparent.
    error DeadlineInPast();
    error DeadlineTooFar(uint256 deadline);
    error OverPerIntentCap(uint256 amount, uint128 cap);
    error BadCoSignerSignature();
    error BadIntentSignature();

    /// @notice A registered signing descriptor's policy (moved here from LeashAccountV5 so the account can
    ///         hand the whole struct to `reconstructAndBound` in ONE call — field order is VERBATIM, so the
    ///         account's `mapping(uint256 => SigningIntentPolicy)` storage layout is byte-identical).
    struct SigningIntentPolicy {
        bool set;
        bytes32 domainSeparator;
        bytes32 typeHash;
        uint8 numFields;
        uint8 spenderIndex;
        uint8 amountIndex;
        uint8 deadlineIndex;
        address token;
        uint128 perIntentCap;
        uint64 maxDeadlineWindow;
        bytes32 nestedTypeHash;
        uint8 nestedLeafStart;
        uint8 nestedLeafCount;
        uint8 expiryLeafIndex; // 0xFF ⇒ no secondary expiry field
    }

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

    /// @notice Reconstruct the strict-canonical EIP-712 `digest` AND canonical-decode + bound the arm's
    ///         spender/amount/deadline(/expiry) in ONE call — the pure half of `authorizeSigningIntent`,
    ///         extracted for EIP-170 (FP-4 Slice-2, D-FP4-2d). Removes from the account: the separate
    ///         structHash call glue, the `abi.encodePacked(0x1901,…)` digest keccak, the field decode, and
    ///         the bound checks. The SPENDER-ALLOWLIST check + budget debit + arm write STAY in the account
    ///         (storage). Reverts `DecodeMismatch` (non-canonical spender word), `OverPerIntentCap`,
    ///         `DeadlineInPast`/`DeadlineTooFar` (deadline AND secondary expiry). `nowTs` = account `block.timestamp`.
    function reconstructAndBound(
        SigningIntentPolicy memory s,
        bytes32[] memory fields,
        uint256 nowTs,
        uint256 chainId,
        address account,
        uint64 epoch,
        address coSigner,
        bytes memory coSignerSig,
        bytes memory sessionSig,
        address sessionKey
    ) public pure returns (bytes32 digest, address spender, uint256 amount, uint256 deadline) {
        bytes32 sh = structHash(s.typeHash, s.nestedTypeHash, s.nestedLeafStart, s.nestedLeafCount, s.numFields, fields);
        digest = keccak256(abi.encodePacked(hex"1901", s.domainSeparator, sh));

        // Factor 1 — the session key must have signed this exact digest. Folded in with the co-signer check
        // so the account carries NO ECDSA codegen (EIP-170, D-FP4-2d). Same `BadIntentSignature` selector.
        (address recSession, ECDSA.RecoverError e1,) = ECDSA.tryRecover(digest, sessionSig);
        if (!(e1 == ECDSA.RecoverError.NoError && recSession == sessionKey)) revert BadIntentSignature();

        // Factor 2 — co-signer second factor (FP-4 Slice-2, D-FP4-2b; folded in to save a whole external
        // call's glue over a separate hook). SR-9: `coSigner == address(0)` ⇒ inert, never calls recover.
        // SR-4: runs on EVERY arm (amount==0 / nested / expiry) before the account's budget debit + arm
        // write. SR-1/SR-3: the approval binds chainId + account + signingEpoch (see verifyCoSigner).
        if (coSigner != address(0) && !verifyCoSigner(digest, chainId, account, epoch, coSignerSig, coSigner)) {
            revert BadCoSignerSignature();
        }

        bytes32 word = fields[s.spenderIndex];
        if (uint256(word) >> 160 != 0) revert DecodeMismatch();
        spender = address(uint160(uint256(word)));
        amount = uint256(fields[s.amountIndex]);
        deadline = uint256(fields[s.deadlineIndex]);
        if (amount > s.perIntentCap) revert OverPerIntentCap(amount, s.perIntentCap);
        if (deadline <= nowTs) revert DeadlineInPast();
        if (deadline > nowTs + s.maxDeadlineWindow) revert DeadlineTooFar(deadline);
        if (s.expiryLeafIndex != type(uint8).max) {
            uint256 expiry = uint256(fields[s.expiryLeafIndex]);
            if (expiry <= nowTs) revert DeadlineInPast();
            if (expiry > nowTs + s.maxDeadlineWindow) revert DeadlineTooFar(expiry);
        }
    }

    /// @notice The co-signer second-factor approval struct hash (FP-4 Slice-2, `07 #15`/D-FP4-2b).
    ///         The co-signer does NOT sign the raw protocol `intentDigest` — a stateless signature over
    ///         that digest would (a) replay across the account's IDENTICAL CREATE2 address on another
    ///         chain whenever the protocol's own EIP-712 domain omits `chainId` (optional per EIP-712),
    ///         and (b) be reusable on an epoch-bump re-arm that overwrites `armedIntent[digest]`. So the
    ///         approval binds `chainId` + `account` (cross-chain / cross-account) AND `epoch` (one-shot
    ///         PER signing epoch — a tighten/remove/revoke/rotate bump auto-invalidates stale approvals).
    ///         No separate nonce storage: `AlreadyArmed` (live) + deadline-in-past (expired, same-fields
    ///         ⇒ same-deadline) already block same-epoch reuse. The account holds `signingEpoch`,
    ///         `address(this)`, `block.chainid` and passes them in — this helper is PURE.
    bytes32 internal constant COSIGNER_APPROVAL_TYPEHASH =
        keccak256("CoSignerApproval(bytes32 intentDigest,uint256 chainId,address account,uint64 epoch)");

    /// @notice Recover the co-signer approval signature and compare to the expected co-signer.
    ///         Returns `true` ONLY when the signature is well-formed (OZ `tryRecover` rejects malleable
    ///         high-S / bad-length / zero-recover — the error is CHECKED, never ignored) AND recovers to
    ///         exactly `coSigner`. The account reverts `BadCoSignerSignature` on `false`, keeping the
    ///         authority (the revert decision) in the account — this helper is pure math, like structHash.
    function verifyCoSigner(
        bytes32 intentDigest,
        uint256 chainId,
        address account,
        uint64 epoch,
        bytes memory sig,
        address coSigner
    ) public pure returns (bool) {
        bytes32 approvalHash =
            keccak256(abi.encode(COSIGNER_APPROVAL_TYPEHASH, intentDigest, chainId, account, epoch));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(approvalHash, sig);
        return err == ECDSA.RecoverError.NoError && recovered == coSigner;
    }
}
