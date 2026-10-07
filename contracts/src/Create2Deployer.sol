// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Create2Deployer — a generic, account-agnostic CREATE2 dispatcher.
/// @notice Stage F′ (FP-4 P1). Replaces `LeashAccountV5FactoryDeterministic`, which embedded
///         `type(LeashAccountV5).creationCode` (~28KB) and so blew past EIP-170 (24,576B) — never
///         deployable. This deployer NEVER references the account type: the backend assembles the
///         account initcode off-chain (`creationCode ++ abi.encode(ctor args incl. the helper
///         singletons)`) and passes it in. The contract therefore stays a few hundred bytes.
///
///         Cross-chain same-address (FP-g / BR-1 / SE-6) holds because the account address is a pure
///         function `f(deployer, salt, keccak256(initcode))`: deploy THIS deployer and the two helper
///         singletons (SigningLib/DecodeLib) via the standard deterministic-deployment proxy
///         (0x4e59b44847b379578588920cA78FbF26c0B4956C) with fixed salts, and the deployer address +
///         the helper addresses baked into the initcode are identical on every chain → identical
///         account address everywhere. The backend's `assertSameAddress` REFUSES to route when any of
///         the three pinned singletons diverges across chains.
///
///         Front-run-safe by construction: different initcode can never land at a victim's predicted
///         address (the initcode hash is a preimage of the address), and two owners can never collide
///         (the owner is baked into the account initcode). A same-initcode front-run is a harmless
///         gas subsidy to the victim — the backend adopts the already-deployed slot.
contract Create2Deployer {
    /// @notice An account was deployed. Account-agnostic by design — owner/session/guardian live in
    ///         the initcode (and the backend's record), never decoded here.
    event Deployed(address indexed account, bytes32 indexed salt);

    /// @notice `create2` returned the zero address — initcode empty, or the (salt, initcode) slot is
    ///         already occupied (a redeploy). The opcode does not revert on collision; we do.
    error DeployFailed();

    /// @notice `create2` returned an address with no code — the initcode ran but deployed nothing.
    error EmptyAccount();

    /// @notice Deploy `initcode` at the CREATE2 address for `salt`. Returns the deployed address and
    ///         emits {Deployed}. Reverts (see errors) rather than returning a bad address.
    /// @dev Deliberately NOT payable — `create2` forwards 0 value; LeashAccountV5 takes no ETH at
    ///      construction. A future account version needing constructor-time ETH would need a payable
    ///      variant (and the determinism math would then also commit to the value).
    function deploy(bytes32 salt, bytes calldata initcode) external returns (address account) {
        bytes memory code = initcode;
        assembly ("memory-safe") {
            account := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (account == address(0)) revert DeployFailed();
        if (account.code.length == 0) revert EmptyAccount();
        emit Deployed(account, salt);
    }

    /// @notice The CREATE2 address for `salt` + `initCodeHash` under THIS deployer. The backend's
    ///         cross-chain prediction hook — eth_call'd per chain; routing is refused on divergence.
    function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initCodeHash))))
        );
    }
}
