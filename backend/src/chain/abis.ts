import { parseAbi } from 'viem';

/** Hand-derived from contracts/src/*.sol (the deployed, sourcify-verified sources). */

export const factoryAbi = parseAbi([
  'struct Policy { uint128 perTransferCap; uint128 windowCap; uint32 windowSeconds; uint64 expiresAt; }',
  'struct TokenPolicy { uint128 perTransferCapToken; uint128 windowCapToken; }',
  'function createAccount(address owner, address guardian, address sessionKey, Policy initialPolicy, address[] initialAllowlist, uint64 timelockDelay, address settlementToken, TokenPolicy initialTokenPolicy) returns (address account)',
  'event AccountCreated(address indexed account, address indexed owner, address sessionKey, address guardian)',
]);

/**
 * Stage E (SE-1): the DEDICATED V4 factory. `createAccountV4` is ARG-IDENTICAL
 * to the legacy `createAccount` (same 8 params, same struct fields) — only the
 * factory address + fn/event name + struct namespace differ. A governed-calldata
 * agent (accountVersion=4) is minted here; legacy v2/v3 stay on `factoryAbi`.
 * Hand-derived from contracts/src/LeashAccountV4Factory.sol.
 */
export const factoryV4Abi = parseAbi([
  'struct Policy { uint128 perTransferCap; uint128 windowCap; uint32 windowSeconds; uint64 expiresAt; }',
  'struct TokenPolicy { uint128 perTransferCapToken; uint128 windowCapToken; }',
  'function createAccountV4(address owner, address guardian, address sessionKey, Policy initialPolicy, address[] initialAllowlist, uint64 timelockDelay, address settlementToken, TokenPolicy initialTokenPolicy) returns (address account)',
  'event AccountCreatedV4(address indexed account, address indexed owner, address sessionKey, address guardian)',
]);

/**
 * Stage E (SE-6): the DETERMINISTIC (CREATE2) V4 factory — the SAME 8 construction
 * params as `factoryV4Abi` plus a trailing `bytes32 salt`. The account address is
 * a pure function of (factory addr, owner, salt, construction args): with the
 * factory at the same address on every chain (canonical CREATE2 deployer) and an
 * identical tuple, the same (owner, salt) lands the account at the SAME address
 * everywhere (E-6). `predictAccountV4` is the cross-chain verification hook
 * consumed by `ChainRegistry.assertSameAddress`. This is the factory
 * `LEASH_FACTORY_V4_ADDR` points at from SE-6 on (BR-1 one-address swap).
 * Hand-derived from contracts/src/LeashAccountV4FactoryDeterministic.sol.
 */
export const factoryV4DeterministicAbi = parseAbi([
  'struct Policy { uint128 perTransferCap; uint128 windowCap; uint32 windowSeconds; uint64 expiresAt; }',
  'struct TokenPolicy { uint128 perTransferCapToken; uint128 windowCapToken; }',
  'function createAccountV4(address owner, address guardian, address sessionKey, Policy initialPolicy, address[] initialAllowlist, uint64 timelockDelay, address settlementToken, TokenPolicy initialTokenPolicy, bytes32 salt) returns (address account)',
  'function predictAccountV4(address owner, address guardian, address sessionKey, Policy initialPolicy, address[] initialAllowlist, uint64 timelockDelay, address settlementToken, TokenPolicy initialTokenPolicy, bytes32 salt) view returns (address)',
  'event AccountCreatedV4(address indexed account, address indexed owner, address sessionKey, address guardian, bytes32 salt)',
  'error AccountAlreadyDeployed(address account)',
]);

/**
 * Stage F′ (FP-4 P1): the generic `Create2Deployer` — an account-agnostic CREATE2
 * dispatcher (contracts/src/Create2Deployer.sol). `deploy(salt, initcode)` runs the
 * backend-assembled V5 initcode; `predict(salt, initCodeHash)` is the on-chain
 * cross-check of the off-chain CREATE2 derivation. The `Deployed(account, salt)`
 * event is address-filtered to the deployer before binding. Hand-derived from the
 * contract source.
 */
export const create2DeployerAbi = parseAbi([
  'function deploy(bytes32 salt, bytes initcode) returns (address account)',
  'function predict(bytes32 salt, bytes32 initCodeHash) view returns (address)',
  'event Deployed(address indexed account, bytes32 indexed salt)',
  'error DeployFailed()',
  'error EmptyAccount()',
]);

/**
 * Stage F′ (FP-4 P1): the V5 account IMMUTABLE getters the RULING-B post-deploy
 * read-back asserts — `owner()`, `signingHelper()`, `decodeHelper()` must equal the
 * input owner + the canonical ChainConfig helpers BEFORE funds route (restores the
 * correctness the typed factory gave for free). Hand-derived from LeashAccountV5.
 */
export const leashAccountV6ReadAbi = parseAbi([
  'function owner() view returns (address)',
  'function signingHelper() view returns (address)',
  'function decodeHelper() view returns (address)',
  'function policyHelper() view returns (address)',
  'function envelopeModule() view returns (address)',
]);

export const leashAccountV5ReadAbi = parseAbi([
  'function owner() view returns (address)',
  'function signingHelper() view returns (address)',
  'function decodeHelper() view returns (address)',
]);

/** Minimal ERC-20 metadata reads — to detect + label the settlement asset. */
export const erc20MetaAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export const registryAbi = parseAbi([
  'function register(address account, address sessionKey, bytes auditPubKey, string name) returns (uint256 agentId)',
  'function setStatus(uint256 agentId, uint8 s)',
  'function getAgent(uint256 agentId) view returns ((address owner, address account, address sessionKey, bytes auditPubKey, string name, uint8 status))',
  'event AgentRegistered(uint256 indexed agentId, address indexed owner, address account, address sessionKey)',
]);

export const leashAccountAbi = parseAbi([
  'function execute(address to, uint256 value, bytes data)',
  // Phase-4 v3: the contract-encoded ERC-20 settlement path (agent supplies no calldata).
  'function executeTokenTransfer(address token, address to, uint256 amount)',
  'function revoke()',
  'function revoked() view returns (bool)',
  'function sessionKey() view returns (address)',
  'function guardian() view returns (address)',
  'function policy() view returns (uint128 perTransferCap, uint128 windowCap, uint32 windowSeconds, uint64 expiresAt)',
  'function allowlist(address) view returns (bool)',
  'function spentInWindow() view returns (uint128)',
  'function windowStart() view returns (uint64)',
  // Phase-4 v3 token settlement getters (v2 accounts have no code for these →
  // the runtime branches on settlementToken() != 0 before reading, F9).
  'function settlementToken() view returns (address)',
  'function tokenPolicy() view returns (uint128 perTransferCapToken, uint128 windowCapToken)',
  'function spentInWindowToken() view returns (uint128)',
  'function windowStartToken() view returns (uint64)',
  'event Executed(address indexed to, uint256 value, uint128 spentInWindow)',
  'event TokenExecuted(address indexed token, address indexed to, uint256 amount, uint128 spentInWindowToken)',
  'event Revoked(address indexed by)',
  // P3C-6(ii): ALL 17 LeashAccount custom errors — with these in the ABI viem
  // decodes reverts by name, and decodeLeashError (chain/errors.ts) maps them
  // to plain-language copy. Hand-derived from the deployed, sourcify-verified
  // contracts/src/LeashAccount.sol.
  'error NotOwner()',
  'error NotGuardianOrOwner()',
  'error NotSessionKey()',
  'error AccountRevoked()',
  'error AccountNotRevoked()',
  'error SessionExpired()',
  'error NotAllowlisted(address to)',
  'error ZeroAddress()',
  'error CalldataForbidden()',
  'error OverPerTransferCap(uint256 value, uint128 cap)',
  'error OverWindowCap(uint256 attempted, uint128 cap)',
  'error CallFailed()',
  'error NothingPending()',
  'error TimelockNotElapsed(uint64 eta)',
  'error NotLoosening()',
  'error NotTightening()',
  'error InvalidPolicy()',
  // Phase-4 v3 token-path errors (extend the decode ABI, spec §3b).
  'error NoSettlementToken()',
  'error TokenNotAllowlisted(address token)',
  'error OverPerTransferCapToken(uint256 amount, uint128 cap)',
  'error OverWindowCapToken(uint256 attempted, uint128 cap)',
  'error TokenTransferFailed()',
]);

/**
 * Stage D (LeashAccountV4) — extends leashAccountAbi with the THIRD governed
 * `executeCall` path + the grant grammar + one-shot JIT + per-token budget, and
 * the reads/errors the backend read-model + runtime need. Hand-derived from the
 * deployed, sourcify-verified contracts/src/LeashAccountV4.sol. Legacy v2/v3
 * accounts have no code for these; the runtime branches on account version (F9).
 */
export const leashAccountV4Abi = parseAbi([
  // the three spend paths (execute + executeTokenTransfer inherited semantics, verbatim)
  'function execute(address to, uint256 value, bytes data)',
  'function executeTokenTransfer(address token, address to, uint256 amount)',
  'function executeCall(address target, uint256 value, bytes data)',
  // grant grammar (owner-only): add/loosen timelocked, tighten/remove instant
  'function proposeCallRule(address target, bytes4 selector, uint8 recipientMode, address[] spenders, uint128 perCallCap, uint128 windowCapCall, bytes32 codehash)',
  'function applyCallRule()',
  'function tightenCallRule(address target, bytes4 selector, uint128 perCallCap, uint128 windowCapCall)',
  'function removeCallSelector(address target, bytes4 selector)',
  'function removeCallTarget(address target)',
  // one-shot JIT (owner-only, instant)
  'function authorizeOnce(bytes32 callHash, uint64 expiry)',
  // per-token cumulative outflow budget (the spine)
  'function proposeSpendBudget(address token, uint128 windowCap)',
  'function applySpendBudget()',
  'function tightenSpendBudget(address token, uint128 windowCap)',
  // reads (the read-model mirrors these; the on-chain account stays authoritative)
  'function callTargetAllowlist(address) view returns (bool)',
  'function callRules(bytes32) view returns (bool allowed, uint8 recipientMode, uint128 perCallCap, uint128 windowCapCall, uint128 spentInWindowCall, uint64 windowStartCall)',
  'function callRuleSpender(bytes32, address) view returns (bool)',
  'function callTargetCodehash(address) view returns (bytes32)',
  'function spendBudget(address) view returns (bool set, uint128 windowCap, uint128 spent, uint64 windowStart)',
  'function oneShotAuthEta(bytes32) view returns (uint64)',
  'function pendingCallRule() view returns (address target, bytes4 selector, uint8 recipientMode, uint128 perCallCap, uint128 windowCapCall, bytes32 codehash, uint64 eta)',
  'function pendingBudgetEta() view returns (uint64)',
  // events
  'event CallExecuted(address indexed target, bytes4 indexed selector, uint256 chargeable, bool oneShot)',
  'event CallRuleProposed(address indexed target, bytes4 indexed selector, uint64 eta)',
  'event CallRuleChanged(address indexed target, bytes4 indexed selector, uint128 perCallCap, uint128 windowCapCall)',
  'event CallRuleRemoved(address indexed target, bytes4 indexed selector)',
  'event CallTargetRemoved(address indexed target)',
  'event SpendBudgetProposed(address indexed token, uint128 windowCap, uint64 eta)',
  'event SpendBudgetChanged(address indexed token, uint128 windowCap)',
  'event OneShotAuthorized(bytes32 indexed callHash, uint64 expiry)',
  'event OneShotConsumed(bytes32 indexed callHash)',
  // Stage D errors (extend the decode ABI so reverts map to plain-language copy)
  'error TargetNotAllowlisted(address target)',
  'error SelectorNotAllowlisted(bytes4 selector)',
  'error SelfCallForbidden()',
  'error InfiniteApprovalForbidden()',
  'error BlanketApprovalForbidden()',
  'error RecipientNotSelf(address recipient)',
  'error SpenderNotAllowlisted(address spender)',
  'error OverPerCallCap(uint256 amount, uint128 cap)',
  'error OverCumulativeSpend(uint256 attempted, uint128 cap)',
  'error OverCallWindowCap(uint256 attempted, uint128 cap)',
  'error BudgetNotSet(address token)',
  'error DecodeMismatch()',
  'error CodehashMismatch()',
  'error OneShotExpired()',
  'error EmptyCodeTarget(address target)',
  // RH band wall (oracle price-sanity for governed swaps) — read + errors so a
  // band refusal decodes to plain language in the cockpit (FR3b).
  'function priceBand(bytes32) view returns (bool set, address feed, address asset, uint32 maxDeviationBps, uint64 maxStaleness)',
  'function requireBandForSwap() view returns (bool)',
  'error PremiumBreach(uint256 impliedPrice, uint256 maxPrice)',
  'error StaleOracle(uint256 updatedAt, uint256 maxStaleness)',
  'error OracleCallFailed()',
  'error OraclePriceInvalid()',
  'error BandRequired(address target)',
  'error BandOnlyForSwap(bytes4 selector)',
  'error PriceBandAssetMismatch(address expected, address actual)',
]);

/** Minimal Chainlink AggregatorV3 read — the band feed the runtime prices swaps from (FR3b). */
export const aggregatorV3Abi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * Stage F′ (LeashAccountV5) — the governed-signing surface (FP-1 spine + FP-3 nested decode).
 * The session key submits the EIP-712 leaf words + its signature over the reconstructed digest via
 * `authorizeSigningIntent` (the runtime arm); the owner onboards a protocol via `proposeSigningGrant`
 * (flat) / `proposeSigningGrantNested` (one-level nested, Permit2) + `applySigningGrant` (timelocked).
 * Reads mirror the on-chain policy + armed read-model. Hand-derived from contracts/src/LeashAccountV5.sol.
 */
export const leashAccountV5SigningAbi = parseAbi([
  // the session-key arm (the runtime write) — returns the armed/reconstructed digest. FP-4 Slice-5:
  // `caps` (the reviewed per-token TokenCap[] allowlist) is submitted at arm for `kind==batch` and the
  // wall verifies `keccak256(abi.encode(caps)) == policy.tokenCapsHash`; EMPTY `[]` for standard/order.
  'function authorizeSigningIntent(uint256 descriptorId, bytes32[] fields, (address token, uint128 cap)[] caps, bytes sessionSig, bytes coSignerSig) returns (bytes32 digest)',
  'function disarmSigningIntent(bytes32 digest)',
  // FP-4 Slice-2 co-signer second factor (`07 #15`) — owner setter (instant add / timelocked weaken) + reads.
  'function setCoSigner(address next)',
  'function applyCoSigner()',
  'function coSigner() view returns (address)',
  'function pendingCoSigner() view returns (address)',
  'function pendingCoSignerEta() view returns (uint64)',
  // owner grant grammar — the unified nested propose (flat = zeroed fold), shared apply (timelocked
  // loosen). FP-4 Slice-4 appended `kind` + `buyToken` to the params; Slice-5 appended the `caps` arg
  // (the reviewed TokenCap[] for a batch grant — validated + hashed to `tokenCapsHash` at grant time;
  // empty for standard/order). The pre-Slice-4 flat `proposeSigningGrant` was folded away (no longer on-chain).
  'function proposeSigningGrantNested((uint256 descriptorId, bytes32 domainSeparator, bytes32 typeHash, uint8 numTopFields, uint8 spenderLeafIndex, uint8 amountLeafIndex, uint8 deadlineLeafIndex, uint8 expiryLeafIndex, bytes32 nestedTypeHash, uint8 nestedLeafStart, uint8 nestedLeafCount, address token, uint128 perIntentCap, uint64 maxDeadlineWindow, uint8 kind, address buyToken) p, address[] spenders, (address token, uint128 cap)[] caps)',
  'function applySigningGrant()',
  'function tightenSigningGrant(uint256 descriptorId, uint128 perIntentCap, uint64 maxDeadlineWindow)',
  'function removeSigningDescriptor(uint256 descriptorId)',
  // reads
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function signingEpoch() view returns (uint64)',
  // NB: the `signingIntentPolicy` + `pendingSigningGrant` public auto-getters were reclaimed to `internal`
  // in FP-4 Slice-5 (EIP-170 headroom; they had zero external readers — the read-model is event-driven), so
  // they are NO LONGER on-chain and must not be declared here. The policy/pending state is read off events.
  'function signingSpender(uint256, address) view returns (bool)',
  'function armedIntent(bytes32) view returns (bool set, uint64 expiry, uint64 epoch)',
  // events
  'event SigningIntentAuthorized(uint256 indexed descriptorId, bytes32 indexed digest, address spender, uint256 amount, uint64 deadline)',
  'event SigningGrantProposed(uint256 indexed descriptorId, uint64 eta)',
  'event SigningGrantChanged(uint256 indexed descriptorId, address token, uint128 perIntentCap)',
  // errors (decode reverts to plain language in the cockpit / drill)
  'error DescriptorNotRegistered(uint256 descriptorId)',
  'error BadIntentSignature()',
  'error DeadlineInPast()',
  'error DeadlineTooFar(uint256 deadline)',
  'error OverPerIntentCap(uint256 amount, uint128 cap)',
  'error SpenderNotAllowlisted(address spender)',
  'error AlreadyArmed()',
  'error DecodeMismatch()',
  'error InvalidPolicy()',
  'error NotSessionKey()',
  'error AccountRevoked()',
  'error SessionExpired()',
  'error TimelockNotElapsed(uint64 eta)',
  'error NothingPending()',
  'error ZeroAddress()',
]);
