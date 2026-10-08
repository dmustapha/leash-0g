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

    // ---------- Stage F′ FP-4 Slice-4 — CoW GPv2Order `kind` discriminant + pinned constants ----------
    /// @notice The signing descriptor family discriminant (D-FP4-3-R6). `KIND_STANDARD` is the existing
    ///         money-triad path (flat OR nested — distinguished as today by `nestedTypeHash`); `KIND_ORDER`
    ///         is the CoW GPv2Order family (nullable spender — I-1 — + three wall-pinned address leaves).
    ///         `KIND_BATCH = 2` is RESERVED for Slice-5 (Permit2 batch) and is rejected at grant-time here.
    uint8 internal constant KIND_STANDARD = 0;
    uint8 internal constant KIND_ORDER = 1;
    /// @notice FP-4 Slice-5 — the Permit2 `PermitBatchTransferFrom` (SignatureTransfer) family: an
    ///         ARRAY-of-`TokenPermissions` fold, per-token caps, per-token Σ bound, per-token loop-debit.
    uint8 internal constant KIND_BATCH = 2;

    /// @notice FP-4 Slice-5 — the Permit2 `PermitBatchTransferFrom` EIP-712 constants, asserted in-test vs
    ///         viem keccak + Permit2's published `_PERMIT_BATCH_TRANSFER_FROM_TYPEHASH` /
    ///         `_TOKEN_PERMISSIONS_TYPEHASH` (a wrong constant is a LOUD test failure, never a silent ship).
    ///         The signed struct is `PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,
    ///         uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)` — the typehash
    ///         injects `spender` (Permit2 sets it to `msg.sender` at verify; the wall allowlists it).
    bytes32 internal constant PBTF_TYPEHASH =
        0xfcf35f5ac6a2c28868dc44c302166470266239195f02b0ee408334829333b766;
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        0x618358ac3db8dc274f0cd8829da7e234bd48cd73c4a740aede1adec9846d06a1;

    /// @notice FP-4 Slice-5 — one reviewed `(token → cap)` entry of the batch allowlist (R-1). A batch may
    ///         move ONLY tokens in this list; per-token Σ over the batch is bounded by its `cap`. Dynamic
    ///         `TokenCap[]` is memory-constructible (R-1 §7 — a mapping-in-struct is not) and is passed to
    ///         `reconstructAndBoundBatch` as an explicit `TokenCap[] memory caps` arg (see the note below).
    struct TokenCap {
        address token;
        uint128 cap;
    }

    /// @notice CoW protocol-universal pinned leaf words (asserted in-test vs viem keccak + CoW published
    ///         values — a wrong constant is a LOUD test failure, never a silent ship; §7 / risk §10).
    ///         `appData` is pinned to the ZERO hash = CoW "no appData / no CIP-7 pre/post-hook" so no hook
    ///         can ride along (§8). `kind`/`sellTokenBalance`/`buyTokenBalance` are EIP-712 `string` fields
    ///         whose SUBMITTED leaf is the pre-hashed word `keccak256(bytes(value))` (§3a) — intrinsic to
    ///         EIP-712, so the wall reads them exactly as these fixed constants (no on-chain decode).
    bytes32 internal constant COW_APPDATA_NONE = bytes32(0);
    bytes32 internal constant COW_KIND_SELL = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775; // keccak256("sell")
    bytes32 internal constant COW_BAL_ERC20 = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9; // keccak256("erc20")

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
        // --- FP-4 Slice-4 (appended — storage-layout-safe; existing descriptors default kind=0/buyToken=0) ---
        uint8 kind; // KIND_STANDARD (0) / KIND_ORDER (1) / KIND_BATCH (2)
        address buyToken; // KIND_ORDER only — reviewed per-pair proceeds token, wall-pinned (G11(b)); 0 otherwise
        // --- FP-4 Slice-5 (EIP-170 caps-hash commit, Dami 2026-10-08; §4.1/§10) ---
        bytes32 tokenCapsHash; // KIND_BATCH only — keccak256(abi.encode(TokenCap[])) of the reviewed allowlist; 0 otherwise
    }
    // FP-4 Slice-5 caps-hash commit (Dami 2026-10-08, measured-gate decision): the per-token cap allowlist is
    // NOT stored on-chain as an array — that cost +1,514 B over the 24,576 ceiling (the account is already on
    // helper-extraction headroom). Instead the policy commits a single `bytes32 tokenCapsHash` (the caps,
    // owner-reviewed + hashed at grant-time, timelocked). The session key SUBMITS the reviewed caps array at
    // arm; `reconstructAndBound` verifies `keccak256(abi.encode(caps)) == s.tokenCapsHash` before the per-token
    // bounds. Security is identical (same owner-reviewed caps, wall-enforced); only the storage moves. The
    // per-arm policy memory copy gains ONE word, so STANDARD/ORDER stay byte-identical (R-6).

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
        // --- FP-4 Slice-4 (CoW order) ---
        uint8 kind; // KIND_STANDARD (0) / KIND_ORDER (1) / KIND_BATCH (2)
        address buyToken; // KIND_ORDER only — reviewed per-pair proceeds token (G11(b)); 0 for standard
        // FP-4 Slice-5 (caps-hash commit): the reviewed per-token cap allowlist is NOT a field here — the
        // owner passes the full `caps` array as a SEPARATE arg to proposeSigningGrantNested; the account
        // validates it (`validateBatchCaps`) + stores only `keccak256(abi.encode(caps))` in the policy.
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
    function validateGrant(SigningGrantParams memory p, TokenCap[] memory caps)
        public
        pure
        returns (uint256 totalLeaves, bytes32 tokenCapsHash)
    {
        if (p.domainSeparator == bytes32(0) || p.typeHash == bytes32(0)) revert InvalidPolicy();
        if (p.token == address(0)) revert ZeroAddress();
        if (p.numTopFields == 0 || p.numTopFields > 32) revert InvalidPolicy();

        // FP-4 Slice-4 — CoW GPv2Order: nullable spender (I-1), fixed 12-field FLAT layout, three
        // wall-pinned address leaves. Validated here (not the standard path) so a non-order descriptor
        // can NEVER carry `spenderLeafIndex == 0xFF` (any other kind with 0xFF already reverts below via
        // the `>= totalLeaves` check since 255 ≥ 32 — made explicit by the discriminant). KIND_BATCH is
        // reserved for Slice-5 and rejected; any kind > KIND_ORDER is InvalidPolicy (fail-closed).
        if (p.kind == KIND_ORDER) {
            if (p.spenderLeafIndex != type(uint8).max) revert InvalidPolicy(); // I-1
            if (p.nestedTypeHash != bytes32(0) || p.nestedLeafCount != 0 || p.nestedLeafStart != 0) {
                revert InvalidPolicy(); // order is FLAT — no fold
            }
            if (p.numTopFields != 12) revert InvalidPolicy(); // GPv2Order is 12 fields
            if (p.amountLeafIndex != 3 || p.deadlineLeafIndex != 5) revert InvalidPolicy(); // sellAmount / validTo
            if (p.expiryLeafIndex != type(uint8).max) revert InvalidPolicy(); // no secondary expiry for order
            if (p.buyToken == address(0)) revert ZeroAddress(); // G11(b): a wall-pinned order carries its proceeds token
            return (12, bytes32(0));
        }
        // FP-4 Slice-5 — Permit2 PermitBatchTransferFrom: an array-of-struct fold with per-token caps. The
        // four scalar leaf indices are UNUSED (the wall derives positions from N = (len-3)/2 at arm time), so
        // all MUST be the 0xFF sentinel; the fold spec names the `TokenPermissions` sub-type (nestedTypeHash
        // != 0, two leaves, array-first). The `tokenCaps` allowlist is validated at grant-time: non-empty,
        // each token nonzero, each cap > 0, NO duplicate token (a dup would split one token's budget across
        // two caps — reject here). Scalar `token`/`perIntentCap` are ignored for batch (the budget is the
        // per-token `spendBudget`, caps come from `tokenCaps`); `token != address(0)` already passed above.
        if (p.kind == KIND_BATCH) {
            uint8 ff = type(uint8).max;
            if (
                p.spenderLeafIndex != ff || p.amountLeafIndex != ff || p.deadlineLeafIndex != ff
                    || p.expiryLeafIndex != ff
            ) revert InvalidPolicy(); // scalar indices unused — wall derives from N
            if (p.nestedTypeHash == bytes32(0) || p.nestedLeafCount != 2 || p.nestedLeafStart != 0) {
                revert InvalidPolicy(); // TokenPermissions = token+amount, array is the first top member
            }
            if (p.numTopFields != 4) revert InvalidPolicy(); // permitted, spender, nonce, deadline
            // Validate the caps allowlist CONTENTS (non-empty, cap>0, no dup) + return its commitment hash
            // (caps-hash commit) — the account stores ONLY `tokenCapsHash`. Leaf count is per-arm for batch
            // (advisory 0); the arm re-derives + re-bounds N.
            return (0, validateBatchCaps(caps));
        }

        // Any non-batch grant MUST carry an empty caps array (a non-batch grant with caps is mis-authored).
        if (caps.length != 0) revert InvalidPolicy();
        if (p.kind != KIND_STANDARD) revert InvalidPolicy(); // unknown kind — not built here

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

    /// @notice FP-4 Slice-5 — validate a batch grant's reviewed per-token cap allowlist AND return its
    ///         commitment hash (the value stored in the policy; the arm re-derives + compares). Checks:
    ///         non-empty, each `token != 0`, each `cap > 0`, NO duplicate token (a dup would split one
    ///         token's budget across two caps). The account calls this at grant-time and stores ONLY the
    ///         returned hash (caps-hash commit, EIP-170). `keccak256(abi.encode(caps))` is the canonical
    ///         commitment — the engine computes the identical hash off-chain (`onChainGrantParams`).
    function validateBatchCaps(TokenCap[] memory caps) public pure returns (bytes32) {
        uint256 nCaps = caps.length;
        if (nCaps == 0) revert InvalidPolicy(); // at least one reviewed token
        for (uint256 i = 0; i < nCaps; i++) {
            if (caps[i].token == address(0)) revert ZeroAddress();
            if (caps[i].cap == 0) revert InvalidPolicy();
            for (uint256 j = i + 1; j < nCaps; j++) {
                if (caps[i].token == caps[j].token) revert InvalidPolicy(); // no dup token
            }
        }
        return keccak256(abi.encode(caps));
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
        TokenCap[] memory caps,
        bytes32[] memory fields,
        uint256 nowTs,
        uint256 chainId,
        address account,
        uint64 epoch,
        address coSigner,
        bytes memory coSignerSig,
        bytes memory sessionSig,
        address sessionKey
    ) public pure returns (bytes32 digest, address spender, uint256[] memory debits, uint256 deadline) {
        // FP-4 Slice-5 — ONE lib entry for ALL kinds (standard/nested/order/batch) so the account carries a
        // SINGLE external-call encoder + return decoder (the decisive EIP-170 lever, §10 — two separate
        // `reconstruct*` entries cost ~1.9 KB of duplicated call glue over the 24,576 ceiling). The digest
        // path is byte-identical to Slice-4 for STANDARD/ORDER (structHash); batch uses structHashBatch
        // (R-6: flat/nested/order unchanged). The result is delivered as an interleaved `(token, Σ)[]`
        // `debits` array — for standard/order one pair (or empty when amount==0); for batch the per-token Σ.
        uint256 amount;
        bytes32 sh = s.kind == KIND_BATCH
            ? structHashBatch(fields)
            : structHash(s.typeHash, s.nestedTypeHash, s.nestedLeafStart, s.nestedLeafCount, s.numFields, fields);
        digest = keccak256(abi.encodePacked(hex"1901", s.domainSeparator, sh));

        // Both signature factors, in ONE audited path shared by every kind (FP-4 Slice-5 §4.4(2)).
        _verifyFactors(digest, chainId, account, epoch, coSigner, coSignerSig, sessionSig, sessionKey);

        // FP-4 Slice-5 — Permit2 PermitBatchTransferFrom: array-of-struct fold + token-keyed per-token Σ cap.
        // The session key submits the reviewed caps array; the wall verifies it against the committed hash
        // (caps-hash commit) — a submitted set that is not the owner-reviewed one fails fail-closed BEFORE any
        // bound. Identical security to storing the array; the commitment was owner-set + timelocked at grant.
        if (s.kind == KIND_BATCH) {
            if (keccak256(abi.encode(caps)) != s.tokenCapsHash) revert DecodeMismatch();
            (spender, debits, deadline) = _boundBatch(caps, fields, nowTs, s.maxDeadlineWindow);
            return (digest, spender, debits, deadline);
        }

        // FP-4 Slice-4 — CoW GPv2Order order branch. The digest above used the FLAT path (nestedTypeHash==0,
        // byte-identical to FP-1), with leaves [8]/[10]/[11] being the pre-hashed string words keccak256("sell")
        // /keccak256("erc20") — the §3a override lives entirely off-chain, so the wall reads them as the fixed
        // constants below. Fields are the fixed GPv2Order layout (G2). All THREE address leaves are
        // canonical-masked (I-4) + wall-pinned (confused-deputy guards); every pin is fail-closed DecodeMismatch.
        if (s.kind == KIND_ORDER) {
            bytes32 w;
            w = fields[0]; // sellToken == budget token
            if (uint256(w) >> 160 != 0 || address(uint160(uint256(w))) != s.token) revert DecodeMismatch();
            w = fields[1]; // buyToken == reviewed per-pair proceeds token (G11(b))
            if (uint256(w) >> 160 != 0 || address(uint160(uint256(w))) != s.buyToken) revert DecodeMismatch();
            w = fields[2]; // receiver == self (proceeds return to the account)
            if (uint256(w) >> 160 != 0 || address(uint160(uint256(w))) != account) revert DecodeMismatch();
            if (fields[6] != COW_APPDATA_NONE) revert DecodeMismatch(); // no CIP-7 hook rides along
            if (fields[8] != COW_KIND_SELL) revert DecodeMismatch(); // sell semantics (pre-hashed string leaf)
            if (uint256(fields[9]) != 0) revert DecodeMismatch(); // partiallyFillable == false
            if (fields[10] != COW_BAL_ERC20 || fields[11] != COW_BAL_ERC20) revert DecodeMismatch(); // sell/buy balance = erc20
            // sellAmount + feeAmount (I-2) — Solidity 0.8 CHECKED add: hostile words near 2²⁵⁶ Panic(0x11)-revert
            // fail-closed BEFORE the cap check (no arm, no debit — C-2). feeAmount is a separate sellToken outflow.
            amount = uint256(fields[3]) + uint256(fields[7]);
            deadline = uint256(fields[5]); // validTo
            spender = address(0); // no spender for order (I-1)
            if (amount > s.perIntentCap) revert OverPerIntentCap(amount, s.perIntentCap);
            if (deadline <= nowTs) revert DeadlineInPast();
            if (deadline > nowTs + s.maxDeadlineWindow) revert DeadlineTooFar(deadline);
            return (digest, spender, _pair(s.token, amount), deadline);
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
        debits = _pair(s.token, amount);
    }

    /// @notice A one-pair `(token, amount)` debit vector for the standard/order path, or an EMPTY vector when
    ///         `amount == 0` (a zero-notional arm — e.g. a cancel/zero-approval — moves no value, skip debit).
    ///         Same interleaved shape the batch path returns, so the account loops ONE debit path for all kinds.
    function _pair(address token, uint256 amount) private pure returns (uint256[] memory out) {
        if (amount == 0) return new uint256[](0);
        out = new uint256[](2);
        out[0] = uint256(uint160(token));
        out[1] = amount;
    }

    /// @notice BOTH signature factors over an arm's `digest`, factored out of `reconstructAndBound` so the
    ///         Slice-5 batch arm shares ONE audited path (FP-4 Slice-5 §4.4(2), risk §10 "two return shapes").
    ///         Factor 1 = the session key signed this exact digest (`BadIntentSignature`) — folded in so the
    ///         account carries NO ECDSA codegen (EIP-170, D-FP4-2d). Factor 2 = the co-signer second factor
    ///         (D-FP4-2b): SR-9 `coSigner == address(0)` ⇒ inert; SR-4 runs on EVERY arm before any state
    ///         write; SR-1/SR-3 the approval binds chainId + account + signingEpoch (see verifyCoSigner).
    function _verifyFactors(
        bytes32 digest,
        uint256 chainId,
        address account,
        uint64 epoch,
        address coSigner,
        bytes memory coSignerSig,
        bytes memory sessionSig,
        address sessionKey
    ) private pure {
        (address recSession, ECDSA.RecoverError e1,) = ECDSA.tryRecover(digest, sessionSig);
        if (!(e1 == ECDSA.RecoverError.NoError && recSession == sessionKey)) revert BadIntentSignature();
        if (coSigner != address(0) && !verifyCoSigner(digest, chainId, account, epoch, coSignerSig, coSigner)) {
            revert BadCoSignerSignature();
        }
    }

    /// @notice FP-4 Slice-5 — the Permit2 `PermitBatchTransferFrom` array-of-struct `hashStruct` (§4.3). The
    ///         `2N+3` submitted leaves are [token₀,amount₀,…,token_{N-1},amount_{N-1}, spender, nonce, deadline].
    ///         Per element `elemHashᵢ = keccak256(TOKEN_PERMISSIONS_TYPEHASH ‖ tokenᵢ ‖ amountᵢ)`; the array
    ///         member folds to `arrayHash = keccak256(‖ elemHashᵢ)`; `structHash = keccak256(PBTF_TYPEHASH ‖
    ///         arrayHash ‖ spender ‖ nonce ‖ deadline)` — EXACTLY Permit2's digest for the real typed-data.
    ///         A dedicated function (not a `structHash` param path) keeps the flat/nested/order branches
    ///         byte-identical (R-6). Fail-closed `DecodeMismatch` on a mis-shaped leaf array.
    function structHashBatch(bytes32[] memory leaves) public pure returns (bytes32) {
        if (leaves.length < 5 || (leaves.length - 3) % 2 != 0) revert DecodeMismatch(); // 2N+3, N ≥ 1
        uint256 n = (leaves.length - 3) / 2;
        bytes memory arrayBuf;
        for (uint256 i = 0; i < n; i++) {
            bytes32 elemHash =
                keccak256(abi.encodePacked(TOKEN_PERMISSIONS_TYPEHASH, leaves[2 * i], leaves[2 * i + 1]));
            arrayBuf = abi.encodePacked(arrayBuf, elemHash);
        }
        bytes32 arrayHash = keccak256(arrayBuf);
        return keccak256(
            abi.encodePacked(PBTF_TYPEHASH, arrayHash, leaves[2 * n], leaves[2 * n + 1], leaves[2 * n + 2])
        );
    }

    /// @notice FP-4 Slice-5 — canonical-decode + per-token-bound a Permit2 `PermitBatchTransferFrom` arm,
    ///         returning the DISTINCT `(token, Σ)` pairs the account loop-debits (§4.4). An INTERNAL helper of
    ///         the unified `reconstructAndBound` (the digest + both signature factors are done by the caller);
    ///         all defects fail-closed `DecodeMismatch` unless a named error fits (`OverPerIntentCap`,
    ///         `DeadlineInPast`/`DeadlineTooFar`).
    ///
    ///         Token-KEYED accumulation (R-1 binding): the per-token Σ is keyed by token, NOT an in-order
    ///         running sum — an attacker interleaving `[A:cap, B:1, A:1]` cannot reset A's running total. Each
    ///         distinct token is debited ONCE (its Σ) by the account. `amount > 0` rejects zero-padding;
    ///         per-element `amount ≤ cap` is a defense-in-depth fail-fast (checked adds also guard the Σ).
    function _boundBatch(TokenCap[] memory caps, bytes32[] memory fields, uint256 nowTs, uint64 maxDeadlineWindow)
        private
        pure
        returns (address spender, uint256[] memory debits, uint256 deadline)
    {
        // Re-derive + re-bound N at arm time — never trust the submitted length (the grant's structural
        // bound does not pin a per-arm N). `fields.length ≤ 32` ⇒ `N ≤ 14` (reuse the 32-leaf ceiling, R-1).
        if (fields.length > 32 || fields.length < 5 || (fields.length - 3) % 2 != 0) revert DecodeMismatch();
        uint256 n = (fields.length - 3) / 2;

        // Token-keyed accumulation into distinct slots (≤ N; O(N²), N ≤ 14).
        address[] memory tks = new address[](n);
        uint256[] memory sums = new uint256[](n);
        uint256 distinct = 0;
        for (uint256 i = 0; i < n; i++) {
            bytes32 tWord = fields[2 * i];
            if (uint256(tWord) >> 160 != 0) revert DecodeMismatch(); // canonical token (I-4)
            address token = address(uint160(uint256(tWord)));
            uint256 amt = uint256(fields[2 * i + 1]);
            if (amt == 0) revert DecodeMismatch(); // reject zero-amount padding (R-1)
            uint128 cap = _capFor(caps, token); // reverts DecodeMismatch if token ∉ allowlist (N-01)
            if (amt > cap) revert OverPerIntentCap(amt, cap); // per-element fail-fast (defense-in-depth)
            uint256 j = 0;
            for (; j < distinct; j++) {
                if (tks[j] == token) break;
            }
            if (j == distinct) {
                tks[j] = token;
                sums[j] = amt;
                distinct++;
            } else {
                sums[j] = sums[j] + amt; // CHECKED add (0.8) — a Σ overflow Panic(0x11)s fail-closed
            }
        }
        // Per-token Σ ≤ cap (the binding R-1 aggregate bound).
        for (uint256 j = 0; j < distinct; j++) {
            uint128 cap = _capFor(caps, tks[j]);
            if (sums[j] > cap) revert OverPerIntentCap(sums[j], cap);
        }
        // Emit the trimmed distinct `(token, Σ)` pairs INTERLEAVED in ONE `uint256[]` (even = token-as-uint,
        // odd = Σ) — a single dynamic-array return is markedly cheaper account-side ABI-decoder codegen than
        // two typed arrays (measured EIP-170 lever, §10). The account steps the loop by 2.
        debits = new uint256[](distinct * 2);
        for (uint256 j = 0; j < distinct; j++) {
            debits[2 * j] = uint256(uint160(tks[j]));
            debits[2 * j + 1] = sums[j];
        }

        // spender (allowlist-checked by the account — I-1 kept, batch is NOT order's 0xFF); canonical (I-4).
        bytes32 spWord = fields[2 * n];
        if (uint256(spWord) >> 160 != 0) revert DecodeMismatch();
        spender = address(uint160(uint256(spWord)));
        // fields[2n+1] = Permit2 nonce — carried only into the digest, not policy-bound.

        // The single top-level deadline, windowed (PBTF has NO per-element expiration — §9 G1).
        deadline = uint256(fields[2 * n + 2]);
        if (deadline <= nowTs) revert DeadlineInPast();
        if (deadline > nowTs + maxDeadlineWindow) revert DeadlineTooFar(deadline);
    }

    /// @notice Resolve `token`'s reviewed cap from the batch allowlist; `DecodeMismatch` if not present (a
    ///         token the owner never reviewed cannot move — N-01 default-deny, fail-closed).
    function _capFor(TokenCap[] memory caps, address token) private pure returns (uint128) {
        for (uint256 i = 0; i < caps.length; i++) {
            if (caps[i].token == token) return caps[i].cap;
        }
        revert DecodeMismatch();
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
