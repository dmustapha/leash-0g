/**
 * AQ-A1 D-5 — the cross-cycle-memory probe (gates G-1 re-run, G-2 payoff, G-3 budget, B-2 identity).
 *
 * Sibling of `q2vis-contract-matrix.mts` (which owns the DECISION_CONTRACT wording under G-1). This
 * one owns the CARRY: it measures the server-composed `cycleMemory` (D-1) + the altitude wording that
 * tells the model how to use it. Same laws as the contract probe:
 *   - the winning altitude is the OUTPUT of this probe, never hand-written (G-1 lineage). Candidate
 *     wordings are spliced in place of whatever `CYCLE_MEMORY_TEXT` currently ships.
 *   - every scenario carries its deterministically-correct expected decision, scored by production's
 *     OWN `parseDecision` (which runs `decisionSchema`) — parse-rate alone is never sufficient (S-11).
 *   - FIRST attempt only, no retry (S-10). The production retry is correct and stays in the runtime.
 *
 * INTERLEAVED, PAIRED BY SCENARIO (the G-4 method law): every (scenario × arm) sample is one job in a
 * single flat list run in CONC batches, so the arms are compared within the same run and the same
 * noise band — cross-run comparisons at this noise level are not evidence.
 *
 * Arms: `memoryless` (no carry — byte-identical to the current production prompt, the G-1 baseline)
 * vs the carry altitudes (`carryTerse`/`carryMed`/`carryFirm`). G-2 asks: the memoryless arm FAILS
 * the memory-dependent scenarios (proving they need memory), a carry arm reaches ≥93% correct.
 *
 * Run:
 *   cd /Users/MAC/leash/backend
 *   KEY=$(grep '^ZERO_G_COMPUTE_API_KEY=' .env | cut -d= -f2-) \
 *     npx tsx scripts/aq-a1-memory-matrix.mts --arms=memoryless,carryMed --n=15 --tag=round1
 *
 * Flags: --arms (csv of ARMS keys) --scen (csv of MEM_SCEN keys or `all`) --n (per scen×arm)
 *        --conc --tag (output filename suffix) --longctx (also run the B-2 identity probe)
 * SPENDS real 0G Compute credits (ruled a non-issue for A1 testing). KEY is read into a var, never printed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildReasonRequest, completionContent, parseDecision, CYCLE_MEMORY_TEXT, CYCLE_FLAGS_TEXT } from '../src/runtime/prompt.js';
import type { ReasonContext } from '../src/runtime/prompt.js';
import { deriveCycleFlags, type CycleMemory } from '../src/runtime/cycle-memory.js';
import type { AgentGoal } from '../src/types.js';

const KEY = process.env.KEY;
if (!KEY) throw new Error('KEY (ZERO_G_COMPUTE_API_KEY) not set');
const MODEL = '0gm-1.0-35b-a3b';
const ENDPOINT = 'https://router-api.0g.ai/v1/chat/completions';
const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-a1';

const arg = (name: string, dflt: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const now = Math.floor(Date.now() / 1000);
const BENE = '0xF00F000000000000000000000000000000000b0Be';

const pol = (over: Record<string, unknown> = {}) => ({
  perTransferCapWei: '20000000000000000', // 0.02
  windowCapWei: '100000000000000000', // 0.1
  windowSeconds: 3600,
  expiresAt: now + 86400,
  allowlist: [BENE],
  revoked: false,
  spentInWindowWei: '0',
  remainingWindowWei: '100000000000000000',
  windowResetsAtUnix: now + 3600,
  ...over,
});

const treasuryGoal = { type: 'treasury', beneficiary: BENE, targetBalanceWei: '50000000000000000', topUpWei: '10000000000000000' } as AgentGoal;

/** Build a CycleMemory with its rendered display (the runtime renders display server-side; here the
 * probe constructs the whole carry object `buildReasonRequest` will serialize + append rules for). */
const cm = (
  last: CycleMemory['lastCycle'],
  delta: CycleMemory['delta'],
  recent: CycleMemory['recentOutcomes'],
): CycleMemory => ({ lastCycle: last, delta, recentOutcomes: recent });

/**
 * A memory-dependent scenario: the observation (ctx) + the carry (cycleMemory) + the
 * deterministically-correct MEMORY-AWARE decision, and — for the honest G-2 story — what a correct
 * MEMORYLESS agent does on the SAME observation (the two differ exactly when memory is load-bearing).
 */
interface MemScenario {
  key: string;
  ctx: Omit<ReasonContext, 'cycleMemory'>;
  cycleMemory: CycleMemory;
  /** memory-aware correct action (what the carry arm should produce). */
  expect: { action: string; amountWei?: string };
  /** does memory FLIP the decision vs a correct memoryless read? (G-2 separation only holds where true) */
  flips: boolean;
  note: string;
}

const recent = (over: Partial<CycleMemory['recentOutcomes']> = {}): CycleMemory['recentOutcomes'] => ({
  window: 10, sends: 0, standDowns: 0, failures: 0, blocked: 0, ...over,
});

const MEM_SCEN: MemScenario[] = [
  // 1) REPEATED-FAILURE — the cleanest flip. Current observation says "below target, funded, window
  // open" → a memoryless agent sends the top-up. The carry says the last two identical sends
  // REVERTED; the rule "do not blindly resend the same amount" → stand down.
  {
    key: 'repeated-failure',
    ctx: { goal: treasuryGoal, beneficiaryBalanceWei: '12000000000000000', accountBalanceWei: '500000000000000000', policy: pol(), nowSec: now },
    cycleMemory: cm(
      { action: 'send', amountWei: '10000000000000000', outcome: 'reverted', agoSeconds: 30 },
      { beneficiaryBalanceWei: '0', accountBalanceWei: '0', remainingWindowWei: '0', capabilitiesChanged: false },
      recent({ failures: 3 }),
    ),
    expect: { action: 'stand_down' },
    flips: true,
    note: 'two+ identical sends just reverted; the current observation is unchanged → retrying is futile',
  },
  // 2) REDUNDANT-TOP-UP — a flip via propagation/timing. The carry shows a large top-up LANDED 8s ago
  // that already moved the beneficiary to the edge of target; the current reading lags. A memoryless
  // agent tops up the tiny residual gap every cycle; the carry agent waits one cycle.
  {
    key: 'redundant-top-up',
    ctx: { goal: treasuryGoal, beneficiaryBalanceWei: '48000000000000000', accountBalanceWei: '500000000000000000', policy: pol(), nowSec: now },
    cycleMemory: cm(
      { action: 'send', amountWei: '40000000000000000', outcome: 'landed', agoSeconds: 8 },
      { beneficiaryBalanceWei: '40000000000000000', accountBalanceWei: '-40000000000000000', remainingWindowWei: '-40000000000000000', capabilitiesChanged: false },
      recent({ sends: 1 }),
    ),
    expect: { action: 'stand_down' },
    flips: true,
    note: 'a 0.04 top-up landed 8s ago (beneficiary +0.04) and is within 0.002 of target → do not micro-top-up again',
  },
  // 3) DRAIN-DETECTION — included per spec. For a TOP-UP agent whose job is to keep the beneficiary
  // funded, a drain does NOT flip send→stand (it keeps topping up — that is the point). Measured here
  // to CONFIRM the carry does not cause a wrong stand-down: the correct action remains a top-up. The
  // drain's product value is owner alerting (out of this decision gate's scope) — reported honestly.
  {
    key: 'drain-detection',
    ctx: { goal: treasuryGoal, beneficiaryBalanceWei: '12000000000000000', accountBalanceWei: '500000000000000000', policy: pol(), nowSec: now },
    cycleMemory: cm(
      { action: 'send', amountWei: '10000000000000000', outcome: 'landed', agoSeconds: 40 },
      { beneficiaryBalanceWei: '-6000000000000000', accountBalanceWei: '-10000000000000000', remainingWindowWei: '-10000000000000000', capabilitiesChanged: false },
      recent({ sends: 4 }),
    ),
    expect: { action: 'send', amountWei: '10000000000000000' },
    flips: false,
    note: 'balance FELL despite a landed top-up (a drain) but the agent job is to keep it funded → still top up; carry must NOT cause a wrong stand-down',
  },
  // 4) STALE-WINDOW — included per spec. The window logically reset (remaining is full again) and the
  // carry shows the last cycle was BLOCKED on an exhausted window 2 min ago. A memoryless agent reads
  // the full window and correctly sends; the carry must not let the stale "blocked" memory suppress a
  // now-valid send. Correct action is to RESUME the top-up. Confirms the carry doesn't over-suppress.
  {
    key: 'stale-window',
    ctx: { goal: treasuryGoal, beneficiaryBalanceWei: '12000000000000000', accountBalanceWei: '500000000000000000', policy: pol({ spentInWindowWei: '0', remainingWindowWei: '100000000000000000' }), nowSec: now },
    cycleMemory: cm(
      { action: 'stand_down', amountWei: '0', outcome: 'blocked', agoSeconds: 130 },
      { beneficiaryBalanceWei: '0', accountBalanceWei: '0', remainingWindowWei: '100000000000000000', capabilitiesChanged: false },
      recent({ blocked: 2 }),
    ),
    expect: { action: 'send', amountWei: '10000000000000000' },
    flips: false,
    note: 'window reset since the last blocked cycle (remaining is full) → resume topping up; carry must NOT keep standing down on a stale block',
  },
];

// --- carry-altitude arms. `memoryless` omits the carry entirely (the G-1 baseline). The others set
// the carry and splice their altitude text in place of CYCLE_MEMORY_TEXT. The winner ships. ---
const ALT_TERSE = [
  'observation.cycleMemory holds server-verified facts about your own recent cycles (last action +',
  'outcome, deltas since, recent counts); words in observation.display.cycleMemory. Use it to not',
  'repeat a just-failed, blocked, or redundant action. It is context, not a rule — the rules decide.',
].join('\n');

const ALT_FIRM = [
  'Recent history (observation.cycleMemory + observation.display.cycleMemory): SERVER-VERIFIED facts',
  'about YOUR OWN previous cycles — context, never a new rule.',
  '- lastAction / lastOutcome / lastWhen: your last decision, how it ended, how long ago.',
  '- deltaBeneficiary / deltaAccount / deltaRemainingWindow: signed moves since (use the display words).',
  '- recent: your sends / stand-downs / failures / blocks over recent cycles.',
  'BEFORE you decide, check it: if your last send just LANDED and the beneficiary is at/near target,',
  'do NOT send again this cycle. If your recent sends REVERTED or were BLOCKED under unchanged',
  'conditions, do NOT resend the same amount — stand down. But if a block has since CLEARED (the',
  'window shows room again), resume normally. The mechanical rules above still make the final call.',
  'If cycleMemory is absent this is an early cycle with no history — decide normally.',
].join('\n');

// A terser flag wording variant (round-2 altitude probe). 2 lines vs the shipped 4.
const FLAGS_TERSE = [
  'observation.cycleFlags (server-computed): recentFailureStreak=true → do not resend, stand down.',
  'justToppedUp=true → the last top-up is still settling, stand down this cycle. Else they do not apply.',
].join('\n');

// `mode`: none = memoryless (G-1 baseline); prose = round-1 cycleMemory + altitude; flags = round-2
// two-boolean carry + (optional) altitude splice over CYCLE_FLAGS_TEXT.
const ARMS: Record<string, { mode: 'none' | 'prose' | 'flags'; altitude?: string }> = {
  memoryless: { mode: 'none' },
  carryTerse: { mode: 'prose', altitude: ALT_TERSE },
  carryMed: { mode: 'prose', altitude: CYCLE_MEMORY_TEXT }, // round-1 shipping default (regressed)
  carryFirm: { mode: 'prose', altitude: ALT_FIRM },
  carryFlags: { mode: 'flags' }, // round-2 default (CYCLE_FLAGS_TEXT)
  carryFlagsTerse: { mode: 'flags', altitude: FLAGS_TERSE },
};

interface Row {
  tag: string; scen: string; arm: string; i: number; flips: boolean;
  http: number | null; finish: string | null;
  content_len: number; rc_len: number; loop_count: number;
  completion_tokens: number | null; prompt_tokens: number | null;
  parses: boolean; action: string | null; amountWei: string | null;
  action_match: boolean; amount_match: boolean; correct: boolean;
  err: string | null;
}

async function sample(tag: string, sc: MemScenario, armKey: string, i: number): Promise<Row> {
  const arm = ARMS[armKey]!;
  const ctx: ReasonContext =
    arm.mode === 'prose' ? { ...sc.ctx, cycleMemory: sc.cycleMemory }
    : arm.mode === 'flags' ? { ...sc.ctx, cycleFlags: deriveCycleFlags(sc.cycleMemory) }
    : { ...sc.ctx };
  const body = buildReasonRequest(MODEL, ctx) as Record<string, unknown>;
  // Splice the altitude variant in place of whatever carry text buildReasonRequest appended (prose →
  // CYCLE_MEMORY_TEXT, flags → CYCLE_FLAGS_TEXT). A 0-hit means prompt.ts drifted — fail loudly.
  const shipped = arm.mode === 'prose' ? CYCLE_MEMORY_TEXT : arm.mode === 'flags' ? CYCLE_FLAGS_TEXT : null;
  if (shipped && arm.altitude && arm.altitude !== shipped) {
    const msgs = body.messages as Array<{ role: string; content: string }>;
    const hits = msgs.filter((m) => m.content.includes(shipped)).length;
    if (hits !== 1) throw new Error(`carry-altitude splice failed for ${sc.key}/${armKey}: ${hits} hits (prompt.ts drifted?)`);
    body.messages = msgs.map((m) =>
      m.role === 'system' && m.content.includes(shipped) ? { ...m, content: m.content.replace(shipped, arm.altitude!) } : m,
    );
  }

  const base: Row = {
    tag, scen: sc.key, arm: armKey, i, flips: sc.flips, http: null, finish: null,
    content_len: 0, rc_len: 0, loop_count: 0, completion_tokens: null, prompt_tokens: null,
    parses: false, action: null, amountWei: null, action_match: false, amount_match: false, correct: false, err: null,
  };
  let j: Record<string, any> | null = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    base.http = res.status;
    j = (await res.json().catch(() => null)) as Record<string, any> | null;
  } catch (e) {
    base.err = String(e);
    return base;
  }
  const msg = j?.choices?.[0]?.message ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const rc = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  base.finish = j?.choices?.[0]?.finish_reason ?? null;
  base.content_len = content.length;
  base.rc_len = rc.length;
  base.loop_count = (rc.match(/"action"\s*:/g) ?? []).length;
  base.completion_tokens = j?.usage?.completion_tokens ?? null;
  base.prompt_tokens = j?.usage?.prompt_tokens ?? null;
  base.err = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null);

  // `completionContent` applies production's scavenge fallback, so a row with content_len=0 AND
  // parses=true means the scavenge fired (decision read from reasoning_content) — not a parse miss.
  const d = parseDecision(completionContent(j));
  base.parses = !!d;
  if (d) {
    base.action = d.action;
    base.amountWei = d.amountWei;
    base.action_match = d.action === sc.expect.action;
    base.amount_match = sc.expect.amountWei === undefined || d.amountWei === sc.expect.amountWei;
    base.correct = base.action_match && base.amount_match;
  }
  return base;
}

/**
 * B-2 identity sanity: a long-context retrieval probe through the SAME gateway/model. `0gm-1.0-35b-a3b`
 * is only ASSUMED Qwen3-30B-A3B-class; if a needle planted ~6k tokens deep is retrieved, the
 * rot-headroom numbers the A1 brief inherits hold for at least this length. Cheap, rides along.
 */
async function longCtxProbe(): Promise<{ ok: boolean; found: boolean; prompt_tokens: number | null; answer: string }> {
  const NEEDLE = 'The vault passphrase is CERULEAN-GIRAFFE-4417.';
  const filler = Array.from({ length: 220 }, (_, i) => `Line ${i}: routine treasury log entry, nothing notable, balance nominal, window healthy.`);
  filler.splice(130, 0, NEEDLE);
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You answer with ONLY the exact phrase requested, nothing else.' },
      { role: 'user', content: `${filler.join('\n')}\n\nWhat is the vault passphrase? Answer with only the phrase.` },
    ],
    temperature: 0,
    max_tokens: 2048,
  };
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => null)) as Record<string, any> | null;
    const txt = `${j?.choices?.[0]?.message?.content ?? ''}${j?.choices?.[0]?.message?.reasoning_content ?? ''}`;
    return { ok: res.ok, found: /CERULEAN-GIRAFFE-4417/.test(txt), prompt_tokens: j?.usage?.prompt_tokens ?? null, answer: (j?.choices?.[0]?.message?.content ?? '').slice(0, 120) };
  } catch (e) {
    return { ok: false, found: false, prompt_tokens: null, answer: String(e) };
  }
}

// --------------------------------- run ------------------------------------

const tag = arg('tag', 'run');
const N = Number(arg('n', '15'));
const CONC = Number(arg('conc', '6'));
const scenArg = arg('scen', 'all');
const scens = scenArg === 'all' ? MEM_SCEN : MEM_SCEN.filter((s) => scenArg.split(',').includes(s.key));
if (scens.length === 0) throw new Error(`no scenarios matched ${scenArg}`);
const armKeys = arg('arms', 'memoryless,carryMed').split(',');
for (const k of armKeys) if (!ARMS[k]) throw new Error(`unknown arm ${k}`);

const jobs: Array<() => Promise<Row>> = [];
for (const sc of scens) for (const ak of armKeys) for (let i = 0; i < N; i++) jobs.push(() => sample(tag, sc, ak, i));

mkdirSync(OUT, { recursive: true });
const file = `${OUT}/M-memory-matrix-${tag}.json`;
console.error(`[aq-a1] ${jobs.length} calls — ${scens.length} scen x ${armKeys.length} arms x N=${N}, conc=${CONC}`);
const rows: Row[] = [];
const t0 = Date.now();
for (let i = 0; i < jobs.length; i += CONC) {
  const batch = await Promise.all(jobs.slice(i, i + CONC).map((f) => f().catch((e) => ({ err: String(e) }) as unknown as Row)));
  rows.push(...batch);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  console.error(`[aq-a1] ${rows.length}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
}

let longCtx: Awaited<ReturnType<typeof longCtxProbe>> | null = null;
if (has('longctx')) {
  longCtx = await longCtxProbe();
  writeFileSync(`${OUT}/B2-longctx-${tag}.json`, JSON.stringify(longCtx, null, 2));
}

// ------------------------------- verdict ----------------------------------

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`);
console.log('\n=== per scenario x arm (first-attempt, production decisionSchema) ===');
console.log('scenario           flips  arm         N  parse  correct  trunc  loopMax  medCompTok  medPromptTok');
for (const sc of scens) {
  for (const ak of armKeys) {
    const r = rows.filter((x) => x.scen === sc.key && x.arm === ak);
    if (r.length === 0) continue;
    const ct = r.map((x) => x.completion_tokens ?? 0).sort((a, b) => a - b);
    const pt = r.map((x) => x.prompt_tokens ?? 0).sort((a, b) => a - b);
    console.log(
      `${sc.key.padEnd(18)} ${String(sc.flips).padEnd(6)} ${ak.padEnd(11)} ${String(r.length).padStart(2)}  `
      + `${pct(r.filter((x) => x.parses).length, r.length).padStart(5)}  `
      + `${pct(r.filter((x) => x.correct).length, r.length).padStart(7)}  `
      + `${String(r.filter((x) => x.finish === 'length').length).padStart(5)}  `
      + `${String(Math.max(...r.map((x) => x.loop_count))).padStart(7)}  `
      + `${String(ct[Math.floor(ct.length / 2)] ?? 0).padStart(10)}  `
      + `${String(pt[Math.floor(pt.length / 2)] ?? 0).padStart(12)}`,
    );
  }
}

console.log('\n=== gate roll-up per arm ===');
for (const ak of armKeys) {
  const r = rows.filter((x) => x.arm === ak);
  if (r.length === 0) continue;
  const flip = r.filter((x) => x.flips);
  const nonflip = r.filter((x) => !x.flips);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  console.log(JSON.stringify({
    arm: ak, n: r.length,
    'G-1_parse': pct(r.filter((x) => x.parses).length, r.length),
    'G-1_truncation': r.filter((x) => x.finish === 'length').length,
    'G-1_loop_p100': Math.max(...r.map((x) => x.loop_count)),
    'G-1_mean_completion_tokens': mean(r.map((x) => x.completion_tokens ?? 0)),
    'G-3_mean_prompt_tokens': mean(r.map((x) => x.prompt_tokens ?? 0)),
    'G-3_max_prompt_tokens': Math.max(...r.map((x) => x.prompt_tokens ?? 0)),
    'G-2_correct_FLIP_scenarios': pct(flip.filter((x) => x.correct).length, flip.length),
    'correct_nonflip_scenarios': pct(nonflip.filter((x) => x.correct).length, nonflip.length),
    errs: r.filter((x) => x.err).length,
  }));
}
if (longCtx) console.log(`\n=== B-2 long-context identity ===\n${JSON.stringify(longCtx)}`);
console.error(`\n[aq-a1] rows -> ${file}`);
