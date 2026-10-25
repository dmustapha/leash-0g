// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title GasRepayDelegate — the AQ-FND M-3 zero-native bootstrap (EIP-7702 delegate).
/// @notice THE PROBLEM: a fresh agent session key holds a token-funded account but ZERO native
///         coin — it cannot submit even the swap that would buy its own gas. THE SHAPE (D-4,
///         self-funding — LEASH never sponsors): the session EOA signs a chain-pinned EIP-7702
///         authorization delegating to THIS immutable contract (probe P-GAS-1 proved type-4
///         txs execute on 0G). The ops RELAYER then submits ONE sponsored transaction calling
///         `bootstrap` on the EOA: the EOA executes its own intended calls — which include the
///         account-governed repayment of the relayer in a token the account holds — atomically.
///         The relayer is made whole in-tx; the TOKEN pays, the account's wall meters it.
///
///         SAFETY SHAPE:
///         · The delegate is IMMUTABLE (no proxy, no owner, no upgrade) and holds no authority
///           of its own — it runs AS the EOA, and every call it makes is one the EOA could
///           make itself. All value movement still crosses the ACCOUNT's governed wall
///           (allowlists + caps + windows): the repayment leg is `executeTokenTransfer` /
///           `executeCall` to an owner-allowlisted ops payee, metered like any other spend.
///         · Every batch needs a fresh VOUCHER signed by the EOA's own key over
///           (chainid, EOA, nonce, deadline, calls-hash, relayer) — the relayer can never
///           invent or replay a batch (nonce lives in the EOA's own storage).
///         · chain_id pinning rides the type-4 authorization itself (never chain_id 0) and is
///           re-checked in the voucher digest. Revoke = a type-4 authorization to address(0)
///           (proven on-chain in the probe), or rotating the session key away.
contract GasRepayDelegate {
    error Expired();
    error NotRelayer();
    error BadVoucherSignature();
    error NonceUsed(uint256 nonce);
    error CallFailed(uint256 index);
    error LengthMismatch();

    event Bootstrapped(uint256 indexed nonce, address indexed relayer, uint256 calls);

    /// @dev Lives in the DELEGATING EOA's own storage (slot keyed by this mapping) — replay
    ///      protection travels with the EOA, not the delegate.
    mapping(uint256 => bool) public usedNonce;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice Execute `calls` as the EOA, relayer-submitted. The voucher must be signed by
    ///         the EOA key itself (`address(this)` IS the EOA under 7702 delegation).
    function bootstrap(
        Call[] calldata calls,
        uint256 nonce,
        uint256 deadline,
        address relayer,
        bytes calldata sig
    ) external {
        if (block.timestamp > deadline) revert Expired();
        if (msg.sender != relayer) revert NotRelayer();
        if (usedNonce[nonce]) revert NonceUsed(nonce);
        usedNonce[nonce] = true;

        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), nonce, deadline, relayer, keccak256(abi.encode(calls)))
        );
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        if (sig.length != 65) revert BadVoucherSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        address recovered = ecrecover(signed, v, r, s);
        if (recovered == address(0) || recovered != address(this)) revert BadVoucherSignature();

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok,) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i);
        }
        emit Bootstrapped(nonce, relayer, calls.length);
    }
}
