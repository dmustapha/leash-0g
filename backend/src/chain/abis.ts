import { parseAbi } from 'viem';

/** Hand-derived from contracts/src/*.sol (the deployed, sourcify-verified sources). */

export const factoryAbi = parseAbi([
  'struct Policy { uint128 perTransferCap; uint128 windowCap; uint32 windowSeconds; uint64 expiresAt; }',
  'function createAccount(address owner, address guardian, address sessionKey, Policy initialPolicy, address[] initialAllowlist, uint64 timelockDelay) returns (address account)',
  'event AccountCreated(address indexed account, address indexed owner, address sessionKey, address guardian)',
]);

export const registryAbi = parseAbi([
  'function register(address account, address sessionKey, bytes auditPubKey, string name) returns (uint256 agentId)',
  'function setStatus(uint256 agentId, uint8 s)',
  'function getAgent(uint256 agentId) view returns ((address owner, address account, address sessionKey, bytes auditPubKey, string name, uint8 status))',
  'event AgentRegistered(uint256 indexed agentId, address indexed owner, address account, address sessionKey)',
]);

export const leashAccountAbi = parseAbi([
  'function execute(address to, uint256 value, bytes data)',
  'function revoke()',
  'function revoked() view returns (bool)',
  'function sessionKey() view returns (address)',
  'function guardian() view returns (address)',
  'function policy() view returns (uint128 perTransferCap, uint128 windowCap, uint32 windowSeconds, uint64 expiresAt)',
  'function allowlist(address) view returns (bool)',
  'function spentInWindow() view returns (uint128)',
  'event Executed(address indexed to, uint256 value, uint128 spentInWindow)',
  'event Revoked(address indexed by)',
]);
