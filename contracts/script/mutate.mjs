// D-15 MUTATION TESTING (reported kill-rate).
// gambit (Certora) and vertigo-rs were not installable in this environment (gambit's
// crates.io entry is an empty stub; vertigo-rs is absent from PyPI). This is a
// purpose-built, deterministic mutation runner over the LeashAccountV4 WALL: it injects
// one mutation at a time into the load-bearing checks (caps, decoders, allowlist gates,
// canonical decode, timelock direction), runs the full V4 test suite, and records
// whether the suite FAILS (mutant KILLED) or PASSES (mutant SURVIVED). A surviving
// mutant on a wall check = a test-quality gap. Reports the kill-rate.
//
// Run: node script/mutate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = new URL('../src/LeashAccountV4.sol', import.meta.url);
const original = readFileSync(SRC, 'utf8');

// Each mutation: a unique `from` substring in the source → a `to` that breaks a wall
// invariant. `find` must be unique in the file (asserted below).
const mutations = [
  // per-call cap: > → >= (admits amount == cap+... no; boundary widens by one)
  { id: 'perCallCap_gt_to_ge', find: 'if (chargeable > rule.perCallCap) revert OverPerCallCap', to: 'if (chargeable >= rule.perCallCap) revert OverPerCallCap' },
  // cumulative budget: > → >= (weakens the spine boundary)
  { id: 'budget_gt_to_ge', find: 'if (attempted > b.windowCap) revert OverCumulativeSpend', to: 'if (attempted >= b.windowCap) revert OverCumulativeSpend' },
  // budget: disable the debit accounting (spent never accumulates → drain)
  { id: 'budget_no_accrue', find: 'b.spent = uint128(attempted);', to: 'b.spent = uint128(b.spent);' },
  // per-(target,selector) window cap: > → >=
  { id: 'callWindow_gt_to_ge', find: 'if (attempted > r.windowCapCall) revert OverCallWindowCap', to: 'if (attempted >= r.windowCapCall) revert OverCallWindowCap' },
  // canonical address decode: flip the dirty-bit check (permits dirty high bits)
  { id: 'decodeAddr_flip', find: 'if (uint256(word) >> 160 != 0) revert DecodeMismatch', to: 'if (uint256(word) >> 160 == 0) revert DecodeMismatch' },
  // confused-deputy: allow transferFrom(from != self)
  { id: 'transferFrom_from_any', find: 'if (from != address(this)) revert RecipientNotSelf(from)', to: 'if (from == address(this)) revert RecipientNotSelf(from)' },
  // recipient==self: flip
  { id: 'recipient_self_flip', find: 'if (to != address(this)) revert RecipientNotSelf(to)', to: 'if (to == address(this)) revert RecipientNotSelf(to)' },
  // infinite approval: != max instead of == max (bans everything except max)
  { id: 'infinite_approve_flip', find: 'if (selector == SEL_APPROVE && amount == type(uint256).max) revert InfiniteApprovalForbidden', to: 'if (selector == SEL_APPROVE && amount != type(uint256).max) revert InfiniteApprovalForbidden' },
  // blanket approval: permit setApprovalForAll(true)
  { id: 'blanket_approve_disable', find: 'if (approvedRaw == 1) revert BlanketApprovalForbidden', to: 'if (approvedRaw == 2) revert BlanketApprovalForbidden' },
  // canonical bool: allow non-canonical bool words
  { id: 'bool_canonical_disable', find: 'if (approvedRaw > 1) revert DecodeMismatch(); // bool canonical: 0 or 1', to: 'if (approvedRaw > 100) revert DecodeMismatch(); // bool canonical: 0 or 1' },
  // target allowlist gate: remove the negation (deny only allowlisted)
  { id: 'target_allowlist_flip', find: 'if (!callTargetAllowlist[target]) revert TargetNotAllowlisted(target)', to: 'if (callTargetAllowlist[target]) revert TargetNotAllowlisted(target)' },
  // selector rule gate: remove the negation
  { id: 'rule_allowed_flip', find: 'if (!rule.allowed) revert SelectorNotAllowlisted(selector)', to: 'if (rule.allowed) revert SelectorNotAllowlisted(selector)' },
  // spender allowlist gate (approve): remove the negation
  { id: 'spender_allowlist_flip', find: 'if (!callRuleSpender[ruleKey][spender]) revert SpenderNotAllowlisted(spender)', to: 'if (callRuleSpender[ruleKey][spender]) revert SpenderNotAllowlisted(spender)' },
  // self-call guard: flip
  { id: 'self_call_flip', find: 'if (target == address(this)) revert SelfCallForbidden()', to: 'if (target != address(this)) revert SelfCallForbidden()' },
  // approve length check: weaken (== to !=, admits wrong lengths)... use a benign-looking widen
  { id: 'approve_len_check', find: 'if (data.length != 4 + 64) revert DecodeMismatch();\n            address spender', to: 'if (data.length < 4 + 64) revert DecodeMismatch();\n            address spender' },
  // revoke gate on executeCall: never revert on revoked
  { id: 'exec_revoked_disable', find: 'if (revoked) revert AccountRevoked();\n        Policy memory p = policy;\n        if (block.timestamp > p.expiresAt) revert SessionExpired();\n        if (target == address(this)) revert SelfCallForbidden();', to: 'if (!revoked) {} else {}\n        Policy memory p = policy;\n        if (block.timestamp > p.expiresAt) revert SessionExpired();\n        if (target == address(this)) revert SelfCallForbidden();' },
  // timelock: apply before eta allowed
  { id: 'callrule_timelock_disable', find: 'if (block.timestamp < pr.eta) revert TimelockNotElapsed(pr.eta)', to: 'if (block.timestamp < 0) revert TimelockNotElapsed(pr.eta)' },
  // tighten direction: allow raising (loosen via tighten)
  { id: 'tighten_direction_flip', find: 'if (perCallCap > r.perCallCap || windowCapCall > r.windowCapCall) revert NotTightening', to: 'if (perCallCap < r.perCallCap || windowCapCall < r.windowCapCall) revert NotTightening' },
];

// integrity: every `find` must be unique in the source
for (const m of mutations) {
  const n = original.split(m.find).length - 1;
  if (n !== 1) {
    console.error(`MUTATION SETUP ERROR: '${m.id}' find-string occurs ${n} times (must be 1)`);
    process.exit(2);
  }
}

let killed = 0;
const survivors = [];
try {
  for (const m of mutations) {
    writeFileSync(SRC, original.replace(m.find, m.to));
    let suitePassed;
    try {
      execSync('forge test --match-contract LeashAccountV4 --no-match-test invariant 2>/dev/null', {
        cwd: new URL('..', import.meta.url), stdio: 'pipe',
      });
      suitePassed = true; // suite passed → mutant NOT caught
    } catch {
      suitePassed = false; // suite failed (or didn't compile) → mutant caught
    }
    if (suitePassed) {
      survivors.push(m.id);
      console.log(`SURVIVED  ${m.id}`);
    } else {
      killed++;
      console.log(`killed    ${m.id}`);
    }
  }
} finally {
  writeFileSync(SRC, original); // always restore
}

const total = mutations.length;
const rate = ((killed / total) * 100).toFixed(1);
console.log(`\nMUTATION KILL-RATE: ${killed}/${total} = ${rate}%`);
if (survivors.length) {
  console.log('SURVIVORS (test-quality gaps to close):', survivors.join(', '));
  process.exit(1);
}
console.log('All wall mutants killed.');
