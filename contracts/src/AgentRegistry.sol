// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title AgentRegistry — minimal on-chain agent identity registry (ERC-7857 deferred).
/// @notice Records: who the agent is, who owns it, which LeashAccount constrains it,
///         which session key acts for it, and which pubkey its audit trail is encrypted to.
/// @dev    `register` is PERMISSIONLESS and entries are NOT authoritative: anyone can
///         register any (account, sessionKey) tuple, and in LEASH the registrant
///         (registry "owner") is the ops key, not the user. The Postgres `owner_addr`
///         column is the AUTHORITY for owner-API access; the user's wallet governs the
///         LeashAccount (contract owner) and all owner routes. Treat this registry as
///         a discovery/index surface only.
contract AgentRegistry {
    enum Status {
        Active,
        Revoked
    }

    struct Agent {
        address owner;
        address account;
        address sessionKey;
        bytes auditPubKey;
        string name;
        Status status;
    }

    error NotAgentOwner();
    error AgentNotFound();
    error ZeroAddress();

    event AgentRegistered(uint256 indexed agentId, address indexed owner, address account, address sessionKey);
    event AgentStatusChanged(uint256 indexed agentId, Status status);
    event AgentMetadataUpdated(uint256 indexed agentId);

    uint256 public nextAgentId;
    mapping(uint256 => Agent) internal _agents;
    mapping(uint256 => bool) internal _exists;

    modifier onlyAgentOwner(uint256 agentId) {
        if (!_exists[agentId]) revert AgentNotFound();
        if (_agents[agentId].owner != msg.sender) revert NotAgentOwner();
        _;
    }

    function register(address account, address sessionKey, bytes calldata auditPubKey, string calldata name)
        external
        returns (uint256 agentId)
    {
        if (account == address(0) || sessionKey == address(0)) revert ZeroAddress();
        agentId = nextAgentId++;
        _agents[agentId] = Agent({
            owner: msg.sender,
            account: account,
            sessionKey: sessionKey,
            auditPubKey: auditPubKey,
            name: name,
            status: Status.Active
        });
        _exists[agentId] = true;
        emit AgentRegistered(agentId, msg.sender, account, sessionKey);
    }

    function setStatus(uint256 agentId, Status s) external onlyAgentOwner(agentId) {
        _agents[agentId].status = s;
        emit AgentStatusChanged(agentId, s);
    }

    function setMetadata(uint256 agentId, address sessionKey, bytes calldata auditPubKey, string calldata name)
        external
        onlyAgentOwner(agentId)
    {
        if (sessionKey == address(0)) revert ZeroAddress();
        Agent storage a = _agents[agentId];
        a.sessionKey = sessionKey;
        a.auditPubKey = auditPubKey;
        a.name = name;
        emit AgentMetadataUpdated(agentId);
    }

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        if (!_exists[agentId]) revert AgentNotFound();
        return _agents[agentId];
    }
}
