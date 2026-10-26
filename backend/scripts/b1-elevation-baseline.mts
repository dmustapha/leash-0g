/**
 * AQ-B1 — elevation baseline probe (SCOPE ①).
 *
 * The in-house instrument for B1, modelled on `q2vis-contract-matrix.mts`: it drives the REAL
 * production path (`elevateIntent` + the real SYSTEM_PROMPT + real deepseek-v3 `ELEVATION_MODEL`
 * + real retry → safeFallback + strict `elevationDraftSchema`) over a curated intent set, and
 * scores it with the SAME four falsifiable axes the kickoff names:
 *   role accuracy · unit/denomination correctness · cap independence · completeness.
 *
 * It measures the free-text funnel EXACTLY as F-0b-58 hit it: no role hint is passed (`role`
 * undefined), so the model classifies from the words alone — the dominated path.
 *
 * Scores are deterministic properties of the RETURNED ElevationDraft, read against each
 * scenario's expectation. Raw suggestedPolicy + unsureFields are captured verbatim per row so the
 * verdict is read by eye, not trusted from a regex (q2vis law: a green check certifies the
 * absence of a pattern, never the absence of the defect).
 *
 * Run:
 *   cd /Users/MAC/leash/backend
 *   KEY=$(grep '^ZERO_G_COMPUTE_API_KEY=' .env | cut -d= -f2-) npx tsx scripts/b1-elevation-baseline.mts --n=4
 *
 * SPENDS real 0G Compute credits (deepseek-v3; ~tens of calls). Key read into a shell var, never printed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { ComputeQueue } from '../src/gateway/compute-queue.js';
import { elevateIntent, elevationDraftSchema, type ElevationDraft } from '../src/create/elevation.js';

const KEY = process.env.KEY;
if (!KEY) throw new Error('KEY (ZERO_G_COMPUTE_API_KEY) not set');
const MODEL = 'deepseek-v3';
const BASE_URL = 'https://router-api.0g.ai/v1';
const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-b1';

const arg = (name: string, dflt: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;

const E18 = 10n ** 18n;
const CAP_SANE_MAX = 10n * E18; // 10 0G: a native per-transfer cap above this is an ops-wallet-scale blowout (F-0b-58 was 50 0G)

type Denom = 'native' | 'token' | 'none';

interface Scenario {
  id: string;
  intent: string;
  /** the correct role for this intent (the archetype the template/manual paths get right) */
  expectRole: ElevationDraft['proposedRole'];
  /** denomination the user's stated amount is in (if any) */
  denom: Denom;
  /** should a money-moving draft carry a suggestedPolicy at all? */
  expectNativeCaps: boolean;
  /** the user's explicitly-stated per-transfer figure as a bare number, if expert+native (for exact-match) */
  statedNative?: { perTransfer?: bigint; window?: bigint };
  /** the bare number the user stated for a NON-native (token) amount — the F-0b-58 corruption tell */
  statedTokenNumber?: bigint;
  /** a goal variable completeness demands be surfaced (asked or flagged unsure), not silently invented */
  keyVariable?: string;
  note: string;
}

const SCEN: Scenario[] = [
  {
    id: 'B1-01-f0b58-usdc-cap',
    intent: 'Keep my treasury topped up. Never move more than 50 USDC in one go.',
    expectRole: 'treasury',
    denom: 'token',
    expectNativeCaps: false, // a USDC constraint must NOT become a native 0G cap
    statedTokenNumber: 50n,
    keyVariable: 'targetBalance',
    note: 'THE HEADLINE. F-0b-58 reproduced: "50 USDC" became perTransferCapWei=50e18 and window==per-transfer.',
  },
  {
    id: 'B1-02-vague-topup',
    intent: 'keep my treasury topped up',
    expectRole: 'treasury',
    denom: 'none',
    expectNativeCaps: true, // scaffold-idea: elevation does the craft, conservative caps OK
    keyVariable: 'targetBalance',
    note: 'scaffold-idea persona; caps may be suggested but must be conservative + independent; threshold should be flagged.',
  },
  {
    id: 'B1-03-monitor-report',
    intent: 'monitor and report on activity related to 0G without moving funds',
    expectRole: 'provider',
    denom: 'none',
    expectNativeCaps: false,
    note: 'F-0b-49/50: "monitor/report, no funds" is a provider (produces work), NOT a sentinel (watches a balance).',
  },
  {
    id: 'B1-04-expert-precise-native',
    intent: 'top up my hot wallet; send at most 0.1 0G per transfer and no more than 1 0G per day',
    expectRole: 'treasury',
    denom: 'native',
    expectNativeCaps: true,
    statedNative: { perTransfer: E18 / 10n, window: E18 }, // 0.1 0G, 1 0G
    note: 'expert persona: precise native caps must survive uncorrupted AND be independent (0.1 != 1).',
  },
  {
    id: 'B1-05-watch-alert-only',
    intent: 'watch my wallet and alert me when it runs low, never spend anything',
    expectRole: 'sentinel',
    denom: 'none',
    expectNativeCaps: false,
    note: 'watch+ask, spend-incapable → sentinel (the correct use of the watcher archetype).',
  },
  {
    id: 'B1-06-research-provider',
    intent: 'read sources I give it and return grounded, cited summaries',
    expectRole: 'provider',
    denom: 'none',
    expectNativeCaps: false,
    note: 'provider; template path gets this right every time.',
  },
  {
    id: 'B1-07-requester-buyer',
    intent: 'order market forecasts from another agent and pay for verified work',
    expectRole: 'requester',
    denom: 'none',
    expectNativeCaps: false,
    note: 'requester (pays ERC-20 fee); money-power = can-move-money but via token fee not native policy.',
  },
  {
    id: 'B1-08-evaluator',
    intent: 'judge other agents work as a strict skeptic and score it',
    expectRole: 'evaluator',
    denom: 'none',
    expectNativeCaps: false,
    note: 'evaluator; spend-incapable.',
  },
  {
    id: 'B1-09-executor',
    intent: 'act on top-up requests that my sentinel sends me, within my own limits',
    expectRole: 'executor',
    denom: 'none',
    expectNativeCaps: true,
    keyVariable: 'caps',
    note: 'executor (moves native funds on inbound delegation); caps must be conservative + independent.',
  },
  {
    id: 'B1-10-expert-token-caps',
    intent: 'buy forecasts and pay up to 25 USDC per job, at most 100 USDC per day',
    expectRole: 'requester',
    denom: 'token',
    expectNativeCaps: false,
    statedTokenNumber: 25n,
    keyVariable: 'feeToken',
    note: 'requester with USDC figures — decimals unknown at create time; must not fabricate a converted base-units cap.',
  },
];

interface Row {
  id: string; i: number; expectRole: string; denom: Denom;
  ok: boolean | null; err: string | null; fellBack: boolean;
  role: string | null; role_match: boolean;
  moneyPower: string | null; confidence: string | null;
  hasNativePolicy: boolean;
  perTransferCapWei: string | null; windowCapWei: string | null; windowSeconds: number | null;
  cap_independent: boolean | null;   // window != perTransfer (null when no native policy)
  window_ge_pertransfer: boolean | null;
  native_cap_sane: boolean | null;   // perTransfer <= 10 0G
  denom_corruption: boolean | null;  // token intent → native cap == statedNumber * 1e18 (the F-0b-58 signature)
  unexpected_native_caps: boolean;   // native policy present where expectNativeCaps=false
  stated_native_exact: boolean | null; // expert native figures survived uncorrupted
  unsureFields: string[];
  completeness_flagged: boolean | null; // keyVariable surfaced in unsureFields (soft)
  rationale: string | null;
}

async function run() {
  const N = Number(arg('n', '4'));
  const CONC = Number(arg('conc', '4'));
  const tag = arg('tag', 'baseline');
  const queue = new ComputeQueue({ baseUrl: BASE_URL, apiKey: KEY!, maxConcurrent: 4 });

  const jobs: Array<() => Promise<Row>> = [];
  for (const sc of SCEN)
    for (let i = 0; i < N; i++)
      jobs.push(() => sample(queue, sc, i));

  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/M-elevation-baseline-${tag}.json`;
  console.error(`[b1] ${jobs.length} calls — ${SCEN.length} scen x N=${N}, model=${MODEL}`);
  const rows: Row[] = [];
  const t0 = Date.now();
  for (let i = 0; i < jobs.length; i += CONC) {
    const batch = await Promise.all(jobs.slice(i, i + CONC).map((f) => f().catch((e) => ({ err: String(e) }) as unknown as Row)));
    rows.push(...batch);
    writeFileSync(file, JSON.stringify(rows, null, 2));
    console.error(`[b1] ${rows.length}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  verdict(rows);
  console.error(`\n[b1] rows -> ${file}`);
}

async function sample(queue: ComputeQueue, sc: Scenario, i: number): Promise<Row> {
  const base: Row = {
    id: sc.id, i, expectRole: sc.expectRole, denom: sc.denom,
    ok: null, err: null, fellBack: false,
    role: null, role_match: false, moneyPower: null, confidence: null,
    hasNativePolicy: false, perTransferCapWei: null, windowCapWei: null, windowSeconds: null,
    cap_independent: null, window_ge_pertransfer: null, native_cap_sane: null,
    denom_corruption: null, unexpected_native_caps: false, stated_native_exact: null,
    unsureFields: [], completeness_flagged: null, rationale: null,
  };
  let draft: ElevationDraft;
  try {
    draft = await elevateIntent({ queue, model: MODEL }, { intent: sc.intent });
  } catch (e) {
    base.err = String(e);
    return base;
  }
  // production's own strict gate; a fallback draft is valid too
  base.ok = elevationDraftSchema.safeParse(draft).success;
  base.role = draft.proposedRole;
  base.role_match = draft.proposedRole === sc.expectRole;
  base.moneyPower = draft.moneyPower;
  base.confidence = draft.confidence;
  base.unsureFields = draft.unsureFields ?? [];
  base.rationale = draft.rationale ?? null;
  // the safeFallback signature: provider + the "could not auto-draft" rationale
  base.fellBack = /could not auto-draft/i.test(draft.rationale ?? '');

  const p = draft.suggestedPolicy;
  if (p) {
    base.hasNativePolicy = true;
    base.perTransferCapWei = p.perTransferCapWei;
    base.windowCapWei = p.windowCapWei;
    base.windowSeconds = p.windowSeconds;
    const pt = BigInt(p.perTransferCapWei);
    const win = BigInt(p.windowCapWei);
    base.cap_independent = pt !== win;
    base.window_ge_pertransfer = win >= pt;
    base.native_cap_sane = pt <= CAP_SANE_MAX;
    base.unexpected_native_caps = !sc.expectNativeCaps;
    if (sc.denom === 'token' && sc.statedTokenNumber !== undefined) {
      base.denom_corruption = pt === sc.statedTokenNumber * E18 || win === sc.statedTokenNumber * E18;
    }
    if (sc.statedNative) {
      const ptOk = sc.statedNative.perTransfer === undefined || pt === sc.statedNative.perTransfer;
      const winOk = sc.statedNative.window === undefined || win === sc.statedNative.window;
      base.stated_native_exact = ptOk && winOk;
    }
  }
  if (sc.keyVariable) {
    base.completeness_flagged = (draft.unsureFields ?? []).some((f) => f.toLowerCase().includes(sc.keyVariable!.toLowerCase()));
  }
  return base;
}

function verdict(rows: Row[]) {
  const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`);
  console.log('\n=== per scenario (N samples each) ===');
  console.log('scenario                     N  roleOK  fellBack  natPol  capIndep  winGE  sane  corrupt  statedExact  unsure');
  for (const sc of SCEN) {
    const r = rows.filter((x) => x.id === sc.id);
    if (!r.length) continue;
    const some = (f: (x: Row) => boolean | null) => r.filter((x) => f(x) === true).length;
    console.log(
      `${sc.id.padEnd(28)} ${String(r.length).padStart(2)}  `
      + `${pct(some((x) => x.role_match), r.length).padStart(6)}  `
      + `${String(some((x) => x.fellBack)).padStart(8)}  `
      + `${String(some((x) => x.hasNativePolicy)).padStart(6)}  `
      + `${pct(some((x) => x.cap_independent), r.filter((x) => x.hasNativePolicy).length).padStart(8)}  `
      + `${pct(some((x) => x.window_ge_pertransfer), r.filter((x) => x.hasNativePolicy).length).padStart(5)}  `
      + `${pct(some((x) => x.native_cap_sane), r.filter((x) => x.hasNativePolicy).length).padStart(4)}  `
      + `${String(some((x) => x.denom_corruption)).padStart(7)}  `
      + `${pct(some((x) => x.stated_native_exact), r.filter((x) => x.stated_native_exact !== null).length).padStart(11)}  `
      + `${(r.map((x) => x.unsureFields.length).reduce((a, b) => a + b, 0) / r.length).toFixed(1).padStart(6)}`,
    );
  }
  console.log('\n=== roll-up (all scenarios) ===');
  const withPol = rows.filter((x) => x.hasNativePolicy);
  console.log(JSON.stringify({
    n: rows.length,
    role_accuracy: pct(rows.filter((x) => x.role_match).length, rows.length),
    fell_back: rows.filter((x) => x.fellBack).length,
    native_policy_rows: withPol.length,
    cap_independent: pct(withPol.filter((x) => x.cap_independent === true).length, withPol.length),
    window_ge_pertransfer: pct(withPol.filter((x) => x.window_ge_pertransfer === true).length, withPol.length),
    native_cap_sane: pct(withPol.filter((x) => x.native_cap_sane === true).length, withPol.length),
    denom_corruptions: rows.filter((x) => x.denom_corruption === true).length,
    unexpected_native_caps: rows.filter((x) => x.unexpected_native_caps).length,
    errs: rows.filter((x) => x.err).length,
  }, null, 2));

  console.log('\n=== native policies emitted, verbatim (read by eye) ===');
  for (const x of withPol)
    console.log(`[${x.id} #${x.i}] role=${x.role} perTransfer=${x.perTransferCapWei} window=${x.windowCapWei} winSec=${x.windowSeconds} conf=${x.confidence} unsure=${JSON.stringify(x.unsureFields)}`);
  console.log('\n=== role misfiles, verbatim ===');
  for (const x of rows.filter((x) => !x.role_match))
    console.log(`[${x.id} #${x.i}] expected=${x.expectRole} got=${x.role} conf=${x.confidence}\n   rationale: ${x.rationale}`);
}

await run();
