// File: web/components/create/CreateWizard.tsx
// Guided create flow (00 §2c): ONE decision per step, plain language, jargon behind
// <Disclosure>. The heavy lifting (audit keypair, KEK, API call) is injected via onCreate so
// this component stays a pure, testable state machine.
'use client';

import { useMemo, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { ApiError } from '@/lib/api';
import { isValidOgAmount, ogToWei, weiToOg } from '@/lib/format';
import type { AgentGoal, CreateAgentResponse, Hex, PolicyInput, TokenConfigInput } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';
import { Field } from '@/components/ui/Field';
import { CopyButton } from '@/components/ui/CopyButton';
import { FundPanel } from '@/components/cockpit/FundPanel';

export class PassphraseRequiredError extends Error {
  constructor() {
    super('passphrase required');
    this.name = 'PassphraseRequiredError';
  }
}

export type WizardInput = {
  name: string;
  policy: PolicyInput;
  allowlist: Address[];
  goal: AgentGoal;
  /** Phase-4: present only for a requester (the sole token-capable role, F1). */
  tokenConfig?: TokenConfigInput;
};

/** Role variant chooser (spec §3c/§3b): ONE plain-language choice on the goal step. */
export type AgentRole = 'treasury' | 'sentinel' | 'executor' | 'requester' | 'provider' | 'evaluator';

/** A pickable existing agent (for the requester's provider/evaluator links). */
export type JobAgentOption = { id: string; name: string };

export type WizardResult = {
  response: CreateAgentResponse;
  kekMode: 'signature' | 'passphrase';
  downloadBackup: () => void;
};

export type CreateWizardProps = {
  onCreate: (input: WizardInput, passphrase?: string) => Promise<WizardResult>;
  walletReady: boolean;
  /** Fund-the-agent hooks for the done screen; omitted in unit tests. */
  fund?: {
    send: (to: Address, valueWei: bigint) => Promise<Hex>;
    getBalance?: (account: Address) => Promise<bigint>;
  };
  /** Phase-4: the owner's existing provider/evaluator agents, for a requester's links. */
  jobAgents?: { providers: JobAgentOption[]; evaluators: JobAgentOption[] };
};

type Step =
  | 'name'
  | 'goal'
  | 'transfer-cap'
  | 'budget'
  | 'allowlist'
  | 'sentinel-policy'
  | 'provider-service'
  | 'evaluator-rubric'
  | 'requester-config'
  | 'token-config'
  | 'expiry'
  | 'review'
  | 'passphrase'
  | 'creating'
  | 'done';

/** Step sequence per role (spec §3c): the sentinel swaps the three policy steps for the
 *  spend-incapable preset explainer; the executor keeps normal policy steps but has no
 *  goal amount fields. The treasury path is byte-identical to Phase 1. */
const STEP_ORDERS: Record<AgentRole, Step[]> = {
  treasury: ['name', 'goal', 'transfer-cap', 'budget', 'allowlist', 'expiry', 'review'],
  sentinel: ['name', 'goal', 'sentinel-policy', 'expiry', 'review'],
  executor: ['name', 'goal', 'transfer-cap', 'budget', 'allowlist', 'expiry', 'review'],
  // Phase-4 ACP roles (spec §3b). Provider/evaluator are spend-incapable (no
  // policy steps, like the sentinel); the requester is the sole governed
  // spender, so it gets the settlement-token config step.
  provider: ['name', 'goal', 'provider-service', 'expiry', 'review'],
  evaluator: ['name', 'goal', 'evaluator-rubric', 'expiry', 'review'],
  requester: ['name', 'goal', 'requester-config', 'token-config', 'expiry', 'review'],
};

const ROLE_OPTIONS: Array<{ value: AgentRole; label: string; explain: string }> = [
  {
    value: 'treasury',
    label: 'Manage an allowance itself',
    explain: 'It watches a wallet and tops it up on its own, within the limits you set.',
  },
  {
    value: 'sentinel',
    label: 'Watch and request top-ups',
    explain: 'It only watches and asks another agent to pay. It can never move money itself.',
  },
  {
    value: 'executor',
    label: 'Act on requests from another agent',
    explain: 'It waits for requests over a link you create, checks them against its own limits, then pays.',
  },
  {
    value: 'requester',
    label: 'Order a job and pay for good work',
    explain: 'It posts a job you defined, waits for a verified deliverable, then pays a capped on-chain fee — with your approval.',
  },
  {
    value: 'provider',
    label: 'Do a job for others',
    explain: 'It takes a job request, reasons on 0G, and delivers a verifiable work-product. It never moves money.',
  },
  {
    value: 'evaluator',
    label: 'Judge others’ work (skeptic)',
    explain: 'It reads a deliverable and the job spec and returns an honest accept/reject. It never moves money.',
  },
];

/** Roles that watch a beneficiary balance and set a top-up goal (treasury/sentinel). */
function isTopUpRole(role: AgentRole): boolean {
  return role === 'treasury' || role === 'sentinel';
}
/** Phase-4 ACP job roles. */
function isJobRole(role: AgentRole): boolean {
  return role === 'requester' || role === 'provider' || role === 'evaluator';
}

/** Friendly copy for the backend's create guardrails (spec §4 error shapes). */
function createErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'rate_limited') {
      const secs = e.retryAfter !== undefined ? ` Try again in about ${e.retryAfter} seconds.` : ' Try again in a little while.';
      return `You are creating agents a bit fast.${secs}`;
    }
    if (e.code === 'quota_exceeded') {
      const limit = e.limit !== undefined ? ` (${e.limit})` : '';
      return `You have reached the limit of agents for this wallet${limit}. Revoked agents count too.`;
    }
    if (e.code === 'allowlist_too_long') {
      const max = e.max !== undefined ? ` at most ${e.max} addresses` : ' fewer addresses';
      return `That allowlist is too long — use${max}.`;
    }
  }
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}

const DAY = 86_400;

export function CreateWizard({ onCreate, walletReady, fund, jobAgents }: CreateWizardProps) {
  const [step, setStep] = useState<Step>('name');
  const [role, setRole] = useState<AgentRole>('treasury');
  const [name, setName] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [targetBalance, setTargetBalance] = useState('0.1');
  const [topUp, setTopUp] = useState('0.01');
  const [perTransfer, setPerTransfer] = useState('0.01');
  const [windowAmount, setWindowAmount] = useState('0.05');
  const [windowHours, setWindowHours] = useState('24');
  const [payee, setPayee] = useState('');
  const [expiryDays, setExpiryDays] = useState('7');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WizardResult | null>(null);
  // Phase-4 job-role fields.
  const [serviceSpec, setServiceSpec] = useState('');
  const [rubricRef, setRubricRef] = useState('');
  const [jobSpecSource, setJobSpecSource] = useState('');
  const [providerAgentId, setProviderAgentId] = useState('');
  const [evaluatorAgentId, setEvaluatorAgentId] = useState('');
  const [feeToken, setFeeToken] = useState('');
  const [feeRecipient, setFeeRecipient] = useState('');
  const [feeCapPerJob, setFeeCapPerJob] = useState('');
  const [tokenPerTransfer, setTokenPerTransfer] = useState('');
  const [tokenWindow, setTokenWindow] = useState('');

  const input = useMemo<WizardInput | null>(() => {
    if (!name.trim() || !/^\d+$/.test(expiryDays) || Number(expiryDays) < 1) return null;
    const expiresAt = Math.floor(Date.now() / 1000) + Number(expiryDays) * DAY;

    const zeroCaps: PolicyInput = { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 24 * 3600, expiresAt };

    // Phase-4 spend-incapable job roles (provider/evaluator): zero caps, empty
    // allowlist — deployed exactly like the sentinel; they never move funds.
    if (role === 'provider') {
      if (!serviceSpec.trim()) return null;
      return { name: name.trim(), policy: zeroCaps, allowlist: [], goal: { type: 'provider', serviceSpec: serviceSpec.trim() } };
    }
    if (role === 'evaluator') {
      if (!rubricRef.trim()) return null;
      return { name: name.trim(), policy: zeroCaps, allowlist: [], goal: { type: 'evaluator', rubricRef: rubricRef.trim() } };
    }

    // Phase-4 requester (F1): the sole governed spender. It never moves NATIVE
    // funds (zero native caps) but settles a governed ERC-20 fee — the token
    // config carries the per-token caps; the fee recipient is the allowlisted
    // target. Mirrors the backend enforcement boundary.
    if (role === 'requester') {
      if (
        !jobSpecSource.trim() ||
        !isAddress(feeToken) ||
        !isAddress(feeRecipient) ||
        !providerAgentId ||
        !evaluatorAgentId ||
        !/^\d+$/.test(feeCapPerJob) ||
        !/^\d+$/.test(tokenPerTransfer) ||
        !/^\d+$/.test(tokenWindow) ||
        BigInt(feeCapPerJob) > BigInt(tokenPerTransfer) // defence in depth (F4)
      ) {
        return null;
      }
      return {
        name: name.trim(),
        policy: zeroCaps,
        allowlist: [feeRecipient],
        goal: {
          type: 'requester',
          jobSpecSource: jobSpecSource.trim(),
          providerAgentId,
          evaluatorAgentId,
          feeToken,
          feeRecipient,
          feeCapPerJobWei: feeCapPerJob,
        },
        tokenConfig: {
          settlementToken: feeToken, // F1: settlementToken == feeToken
          perTransferCapTokenWei: tokenPerTransfer,
          windowCapTokenWei: tokenWindow,
        },
      };
    }

    if (role === 'sentinel') {
      // Spend-incapable preset (spec §3c): zero caps, empty allowlist. The goal amounts
      // are what it ASKS the executor to send — its own caps never bound them.
      if (!isAddress(beneficiary) || !isValidOgAmount(targetBalance) || !isValidOgAmount(topUp)) {
        return null;
      }
      return {
        name: name.trim(),
        policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 24 * 3600, expiresAt },
        allowlist: [],
        goal: {
          type: 'sentinel',
          beneficiary,
          targetBalanceWei: ogToWei(targetBalance),
          topUpWei: ogToWei(topUp),
        },
      };
    }

    // treasury + executor share the normal policy steps.
    if (
      !isValidOgAmount(perTransfer) ||
      !isValidOgAmount(windowAmount) ||
      !/^\d+$/.test(windowHours) ||
      Number(windowHours) < 1 ||
      !isAddress(payee)
    ) {
      return null;
    }
    const policy: PolicyInput = {
      perTransferCapWei: ogToWei(perTransfer),
      windowCapWei: ogToWei(windowAmount),
      windowSeconds: Number(windowHours) * 3600,
      expiresAt,
    };

    if (role === 'executor') {
      return { name: name.trim(), policy, allowlist: [payee], goal: { type: 'executor' } };
    }

    // Treasury: byte-compatible with Phase 1 — NO type field, validations unchanged.
    if (!isAddress(beneficiary) || !isValidOgAmount(targetBalance) || !isValidOgAmount(topUp)) {
      return null;
    }
    return {
      name: name.trim(),
      policy,
      allowlist: [payee],
      goal: {
        beneficiary,
        targetBalanceWei: ogToWei(targetBalance),
        topUpWei: ogToWei(topUp),
      },
    };
  }, [
    role, name, beneficiary, targetBalance, topUp, perTransfer, windowAmount, windowHours, payee, expiryDays,
    serviceSpec, rubricRef, jobSpecSource, providerAgentId, evaluatorAgentId, feeToken, feeRecipient, feeCapPerJob,
    tokenPerTransfer, tokenWindow,
  ]);

  // Reviewed constraint (TREASURY only): a single top-up is one payment, so it can never
  // exceed the per-payment cap the chain enforces. The sentinel never pays (its request
  // amount is bounded by the EXECUTOR's caps), and the executor has no top-up amount.
  const topUpExceedsCap = useMemo(() => {
    if (role !== 'treasury') return false;
    if (!isValidOgAmount(topUp) || !isValidOgAmount(perTransfer)) return false;
    return BigInt(ogToWei(topUp)) > BigInt(ogToWei(perTransfer));
  }, [role, topUp, perTransfer]);

  const stepOrder = STEP_ORDERS[role];
  const stepIndex = stepOrder.indexOf(step);
  const fundGetBalance = fund?.getBalance;

  async function submit(pass?: string) {
    if (!input) return;
    setStep('creating');
    setError(null);
    try {
      const r = await onCreate(input, pass);
      setResult(r);
      setStep('done');
    } catch (e) {
      if (e instanceof PassphraseRequiredError) {
        setStep('passphrase');
        return;
      }
      setError(createErrorMessage(e));
      setStep('review');
    }
  }

  const nav = (next: Step) => (
    <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.5rem' }}>
      {stepIndex > 0 ? (
        <button type="button" className="btn btn-ghost" onClick={() => setStep(stepOrder[stepIndex - 1] ?? 'name')}>
          Back
        </button>
      ) : null}
      <button type="submit" className="btn btn-primary" data-testid="wizard-next">
        {next === 'review' ? 'Review' : 'Next'}
      </button>
    </div>
  );

  function stepForm(next: Step, valid: boolean, invalidMsg: string, body: React.ReactNode, onAdvance?: () => void) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) {
            setError(invalidMsg);
            return;
          }
          setError(null);
          onAdvance?.();
          setStep(next);
        }}
        style={{ display: 'grid', gap: '0.9rem' }}
      >
        {body}
        {error ? (
          <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
            {error}
          </p>
        ) : null}
        {nav(next)}
      </form>
    );
  }

  return (
    <div className="card" style={{ padding: 'clamp(1.2rem, 3vw, 2rem)', display: 'grid', gap: '1.1rem' }}>
      {step !== 'done' && step !== 'creating' ? (
        <p className="eyebrow" aria-live="polite">
          {step === 'passphrase' ? 'One more thing' : `Step ${Math.max(stepIndex, 0) + 1} of ${stepOrder.length}`}
        </p>
      ) : null}

      {step === 'name' &&
        stepForm(
          'goal',
          !!name.trim(),
          'Give your agent a name.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>Name your agent</h1>
            <Field
              id="agent-name"
              label="Agent name"
              hint="Anything you like. You will see this name in the cockpit and audit trail."
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Treasury helper"
              autoFocus
            />
          </>,
        )}

      {step === 'goal' &&
        stepForm(
          stepOrder[stepOrder.indexOf('goal') + 1] ?? 'review',
          role === 'executor' ||
            isJobRole(role) ||
            (isAddress(beneficiary) && isValidOgAmount(targetBalance) && isValidOgAmount(topUp)),
          'Enter a valid wallet address and amounts greater than zero, like 0.1.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>What should this agent do?</h1>
            <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: '0.5rem' }} data-testid="role-chooser">
              <legend className="label" style={{ color: 'var(--color-ink)', padding: 0, marginBottom: '0.35rem' }}>
                Pick the job that fits
              </legend>
              {ROLE_OPTIONS.map((opt) => (
                <label key={opt.value} className="panel" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', padding: '0.7rem 0.85rem' }}>
                  <input
                    type="radio"
                    name="agent-role"
                    value={opt.value}
                    checked={role === opt.value}
                    onChange={() => setRole(opt.value)}
                    style={{ marginTop: '0.25rem' }}
                    data-testid={`role-${opt.value}`}
                  />
                  <span style={{ fontSize: '0.9rem' }}>
                    <strong>{opt.label}</strong>
                    <span style={{ display: 'block', color: 'var(--color-ink-dim)', fontSize: '0.82rem' }}>
                      {opt.explain}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {isTopUpRole(role) ? (
              <>
                <Field
                  id="goal-beneficiary"
                  label="Who to keep topped up"
                  hint={
                    role === 'treasury'
                      ? 'The wallet your agent watches and refills. We will also pre-fill it as the allowed recipient a few steps from now.'
                      : 'The wallet this agent watches. When it runs low, the agent asks a linked agent to top it up.'
                  }
                  value={beneficiary}
                  onChange={(e) => setBeneficiary(e.target.value)}
                  placeholder="0x…"
                />
                <Field
                  id="goal-target"
                  label="Keep them at"
                  hint="When their balance dips below this, a top-up is due."
                  value={targetBalance}
                  onChange={(e) => setTargetBalance(e.target.value)}
                  inputMode="decimal"
                  suffix="0G"
                />
                <Field
                  id="goal-topup"
                  label={role === 'treasury' ? 'Send at most, per top-up' : 'Ask for at most, per top-up'}
                  value={topUp}
                  onChange={(e) => setTopUp(e.target.value)}
                  inputMode="decimal"
                  suffix="0G"
                />
              </>
            ) : role === 'executor' ? (
              <p data-testid="executor-goal-note" style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem' }}>
                Nothing else to set here. This agent waits for requests from an agent you link to
                it, checks each one against its own limits (you set those next), and then pays —
                or asks you first.
              </p>
            ) : (
              <p data-testid="job-goal-note" style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem' }}>
                {role === 'provider'
                  ? 'This agent does jobs. Next you describe the service it offers — then link a requester to it.'
                  : role === 'evaluator'
                    ? 'This agent judges work as an honest skeptic. Next you name the rubric it applies.'
                    : 'This agent orders jobs and pays for good work. Next you point it at a job you defined, its provider and evaluator, and the capped fee.'}
              </p>
            )}
            <Disclosure label="How does the agent use this?">
              {role === 'executor'
                ? 'Requests from other agents carry no authority of their own. This agent re-reasons about every request and its own on-chain caps and allowlist bound anything it pays, no matter what it is asked.'
                : role === 'sentinel'
                  ? 'This goal is the standing instruction: watch the balance and request a top-up when it dips below target. The agent itself can never move money — the linked agent that acts checks every request against its own limits.'
                  : role === 'provider' || role === 'evaluator'
                    ? 'This agent is spend-incapable by construction — it holds a scoped session key with zero spending caps and an empty allowlist, so it can never move money no matter what it is asked. It is governed by the cockpit and the verifiable audit trail, not spend limits.'
                    : role === 'requester'
                      ? 'This is the only agent that spends. It settles a governed ERC-20 fee — the amount comes from the job you defined (never the agents), bounded again by the on-chain per-token caps, and released only with your approval after an independent evaluator accepts the work.'
                      : 'This goal is the agent’s standing instruction: watch the beneficiary’s balance and top it up toward the target, never sending more than the per-top-up amount at once. The on-chain caps you set next still bound every single payment, no matter what the agent decides.'}
            </Disclosure>
          </>,
          // The beneficiary is almost always the payee — seed the allowlist step so the
          // user does not retype the address (they can still change it there).
          () => {
            if (role === 'treasury' && !payee.trim() && isAddress(beneficiary)) setPayee(beneficiary);
          },
        )}

      {step === 'sentinel-policy' &&
        stepForm(
          'expiry',
          true,
          '',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>This agent can never move money</h1>
            <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.92rem' }} data-testid="sentinel-policy-note">
              Watcher agents get the strictest possible leash, set automatically: it can pay
              nobody (empty allowlist) and its payment limits are zero. Even if it is tricked,
              there is nothing to steal — it can only ASK a linked agent to pay, and that agent
              checks every request against its own limits.
            </p>
            <Disclosure label="What exactly is set on-chain?">
              Its LeashAccount is deployed with a per-payment cap of 0, a budget cap of 0, and an
              empty allowlist — every execute() reverts. Because it can never spend, there is no
              account to fund and no gas top-up to make.
            </Disclosure>
          </>,
        )}

      {step === 'provider-service' &&
        stepForm(
          'expiry',
          !!serviceSpec.trim(),
          'Describe the service this provider offers.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>What service does it offer?</h1>
            <Field
              id="provider-service"
              label="Service"
              hint="A short description a requester will see, e.g. “calibrated probability estimates for market questions”."
              value={serviceSpec}
              onChange={(e) => setServiceSpec(e.target.value)}
              placeholder="calibrated probability estimates…"
              autoFocus
            />
            <p data-testid="provider-spend-note" style={{ color: 'var(--color-ink-dim)', fontSize: '0.86rem' }}>
              This agent is spend-incapable — zero caps, empty allowlist. It only produces work.
            </p>
          </>,
        )}

      {step === 'evaluator-rubric' &&
        stepForm(
          'expiry',
          !!rubricRef.trim(),
          'Name the rubric this evaluator applies.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>How should it judge?</h1>
            <Field
              id="evaluator-rubric"
              label="Rubric"
              hint="A short name/description of the standard it holds work to, e.g. “strict calibration + grounded claims”."
              value={rubricRef}
              onChange={(e) => setRubricRef(e.target.value)}
              placeholder="strict calibration + grounded claims"
              autoFocus
            />
            <p data-testid="evaluator-spend-note" style={{ color: 'var(--color-ink-dim)', fontSize: '0.86rem' }}>
              Spend-incapable by construction. It is a skeptic — it defaults to reject and must justify any accept.
            </p>
          </>,
        )}

      {step === 'requester-config' &&
        stepForm(
          'token-config',
          !!jobSpecSource.trim() && !!providerAgentId && !!evaluatorAgentId && isAddress(feeRecipient) && /^\d+$/.test(feeCapPerJob),
          'Point at a saved job, pick its provider and evaluator, set the fee recipient and cap.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>Order a job</h1>
            <Field
              id="requester-jobspec"
              label="Job handle"
              hint="The handle of a job you defined (Jobs → Define a job)."
              value={jobSpecSource}
              onChange={(e) => setJobSpecSource(e.target.value)}
              placeholder="eth-4000"
              autoFocus
            />
            <label className="label" style={{ color: 'var(--color-ink)' }}>
              Provider agent
              <select
                className="field"
                data-testid="requester-provider"
                value={providerAgentId}
                onChange={(e) => setProviderAgentId(e.target.value)}
              >
                <option value="">— pick a provider —</option>
                {(jobAgents?.providers ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="label" style={{ color: 'var(--color-ink)' }}>
              Evaluator agent
              <select
                className="field"
                data-testid="requester-evaluator"
                value={evaluatorAgentId}
                onChange={(e) => setEvaluatorAgentId(e.target.value)}
              >
                <option value="">— pick an evaluator —</option>
                {(jobAgents?.evaluators ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              id="requester-fee-recipient"
              label="Pay the fee to"
              hint="The allowlisted recipient of the job fee (e.g. the provider’s payout wallet)."
              value={feeRecipient}
              onChange={(e) => setFeeRecipient(e.target.value)}
              placeholder="0x…"
            />
            <Field
              id="requester-fee-cap"
              label="Fee cap per job (token base units)"
              hint="A hard ceiling per job, on top of the seeded fee. 6-dp for TestUSD: 5000000 = 5.00."
              value={feeCapPerJob}
              onChange={(e) => setFeeCapPerJob(e.target.value)}
              inputMode="numeric"
            />
            <Disclosure label="Where does the fee amount come from?">
              From the job you defined, in server state — never from the agents. This cap and the
              on-chain per-token caps bound it again: a hijacked requester cannot overpay.
            </Disclosure>
          </>,
        )}

      {step === 'token-config' &&
        stepForm(
          'expiry',
          isAddress(feeToken) && /^\d+$/.test(tokenPerTransfer) && /^\d+$/.test(tokenWindow) && (feeCapPerJob === '' || BigInt(feeCapPerJob || '0') <= BigInt(tokenPerTransfer || '0')),
          'Enter the settlement token and per-token caps; the per-job fee cap must not exceed the per-transfer cap.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>Settlement limits</h1>
            <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem' }}>
              The one token this account can ever move, and the hard caps the contract enforces on it.
              The token is fixed at creation — a different token is a different account.
            </p>
            <Field
              id="token-address"
              label="Settlement token (ERC-20)"
              hint="Testnet only — a TestUSD-style token on 16602. Not real USDC."
              value={feeToken}
              onChange={(e) => setFeeToken(e.target.value)}
              placeholder="0x…"
              autoFocus
            />
            <Field
              id="token-per-transfer"
              label="Max per settlement (token base units)"
              hint="One hijacked payment can never exceed this. 6-dp: 10000000 = 10.00."
              value={tokenPerTransfer}
              onChange={(e) => setTokenPerTransfer(e.target.value)}
              inputMode="numeric"
            />
            <Field
              id="token-window"
              label="Max per window (token base units)"
              hint="Total the account can settle within its rolling window."
              value={tokenWindow}
              onChange={(e) => setTokenWindow(e.target.value)}
              inputMode="numeric"
            />
            <Disclosure label="What the contract enforces">
              Every settle is a contract-encoded transfer(to, amount) the account itself builds — the
              agent never supplies raw calldata. It reverts over the per-transfer cap, over the window
              cap, off the token, off the recipient allowlist, when expired, or after revoke.
            </Disclosure>
          </>,
        )}

      {step === 'transfer-cap' &&
        stepForm(
          'budget',
          isValidOgAmount(perTransfer),
          'Enter an amount greater than zero, like 0.01.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>How much per payment?</h1>
            <Field
              id="per-transfer"
              label="Most it can send in one payment"
              hint="Even if your agent is tricked, it can never send more than this in a single payment."
              value={perTransfer}
              onChange={(e) => setPerTransfer(e.target.value)}
              inputMode="decimal"
              suffix="0G"
            />
            <Disclosure label="How is this enforced?">
              This limit lives in a smart contract on the 0G blockchain (the per-transfer cap in your
              agent&apos;s LeashAccount). The agent&apos;s key physically cannot sign a bigger payment; the
              chain rejects it.
            </Disclosure>
          </>,
        )}

      {step === 'budget' &&
        stepForm(
          'allowlist',
          isValidOgAmount(windowAmount) && /^\d+$/.test(windowHours) && Number(windowHours) >= 1,
          'Enter a budget greater than zero and a whole number of hours.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>Set a rolling budget</h1>
            <Field
              id="window-amount"
              label="Total it can spend"
              hint="A ceiling across many payments, so it cannot drain funds through lots of small sends."
              value={windowAmount}
              onChange={(e) => setWindowAmount(e.target.value)}
              inputMode="decimal"
              suffix="0G"
            />
            <Field
              id="window-hours"
              label="…in this many hours"
              value={windowHours}
              onChange={(e) => setWindowHours(e.target.value)}
              inputMode="numeric"
              suffix="hours"
            />
            <Disclosure label="What happens when the budget runs out?">
              The window cap is enforced on-chain. Once spending in the current window reaches the
              cap, further payments revert until the window rolls over.
            </Disclosure>
          </>,
        )}

      {step === 'allowlist' &&
        stepForm(
          'expiry',
          isAddress(payee),
          'Enter a valid wallet address (starts with 0x, 42 characters).',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>Who can it pay?</h1>
            <Field
              id="payee"
              label="Allowed recipient"
              hint={
                role === 'executor'
                  ? 'This bounds who this agent can pay: whatever another agent asks for, payments can ONLY go to this address. You can add more later from the cockpit.'
                  : 'Your agent can ONLY send to this address. Everything else is blocked by default. You can add more later from the cockpit.'
              }
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="0x…"
            />
            <Disclosure label="Why only one address?">
              Default-deny is the safest start: the on-chain allowlist blocks every destination you
              have not explicitly approved. Additions later go through a short safety delay.
            </Disclosure>
          </>,
        )}

      {step === 'expiry' &&
        stepForm(
          'review',
          /^\d+$/.test(expiryDays) && Number(expiryDays) >= 1,
          'Enter a whole number of days, at least 1.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>How long should it run?</h1>
            <Field
              id="expiry-days"
              label="Agent expires after"
              hint="After this, the agent stops being able to pay at all until you renew it. A hard deadline, enforced on-chain."
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              inputMode="numeric"
              suffix="days"
            />
          </>,
        )}

      {step === 'review' && (
        <div style={{ display: 'grid', gap: '0.9rem' }}>
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Review and create</h1>
          <dl style={{ display: 'grid', gap: '0.55rem', margin: 0 }} data-testid="review-summary">
            {[
              ['Name', name.trim()],
              [
                'Job',
                role === 'treasury'
                  ? 'manages an allowance itself'
                  : role === 'sentinel'
                    ? 'watches and requests top-ups (never pays)'
                    : role === 'executor'
                      ? 'acts on requests from a linked agent'
                      : role === 'provider'
                        ? 'does jobs (spend-incapable)'
                        : role === 'evaluator'
                          ? 'judges work — skeptic (spend-incapable)'
                          : 'orders jobs and pays for good work',
              ],
              // treasury/sentinel top-up rows
              ...(isTopUpRole(role)
                ? [
                    [role === 'sentinel' ? 'Watches' : 'Keeps topped up', beneficiary],
                    ['Keep them at', `${targetBalance} 0G`],
                    [role === 'sentinel' ? 'Asks for, per top-up' : 'Per top-up', `${topUp} 0G max`],
                  ]
                : []),
              // Phase-4 job-role rows
              ...(role === 'provider' ? [['Service', serviceSpec]] : []),
              ...(role === 'evaluator' ? [['Rubric', rubricRef]] : []),
              ...(role === 'requester'
                ? [
                    ['Job handle', jobSpecSource],
                    ['Settlement token', feeToken],
                    ['Pays fee to', feeRecipient],
                    ['Fee cap per job', `${feeCapPerJob} base units`],
                    ['Max per settlement', `${tokenPerTransfer} base units`],
                    ['Max per window', `${tokenWindow} base units`],
                  ]
                : []),
              // native-spend policy rows (treasury/executor only)
              ...(role === 'sentinel'
                ? [
                    ['Per payment', 'nothing — it can never pay'],
                    ['Can pay', 'nobody (empty allowlist)'],
                  ]
                : isJobRole(role)
                  ? [['Moves native funds', role === 'requester' ? 'no — settles ERC-20 only' : 'no — spend-incapable']]
                  : [
                      ['Per payment', `${weiToOg(input?.policy.perTransferCapWei ?? '0')} 0G max`],
                      ['Budget', `${weiToOg(input?.policy.windowCapWei ?? '0')} 0G every ${windowHours} hours`],
                      ['Can pay', payee],
                    ]),
              ['Expires', `in ${expiryDays} days`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: '0.8rem', justifyContent: 'space-between', borderBottom: '1px solid var(--color-line-soft)', paddingBottom: '0.45rem' }}>
                <dt className="label">{k}</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.86rem', wordBreak: 'break-all', textAlign: 'right' }}>{v}</dd>
              </div>
            ))}
          </dl>
          <Disclosure label="What happens when I press create?">
            Your browser generates a private audit key (it never leaves this device), locks it with a
            signature from your wallet, and LEASH deploys your agent&apos;s constrained account
            on-chain with these limits. You will get a gateway token shown exactly once.
          </Disclosure>
          {topUpExceedsCap ? (
            <p role="alert" data-testid="goal-cap-error" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
              The per-top-up amount ({topUp} 0G) is higher than the per-payment limit ({perTransfer}{' '}
              0G), so a top-up could never go through. Lower the top-up or raise the per-payment
              limit.
            </p>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setStep('expiry')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!walletReady || !input || topUpExceedsCap}
              onClick={() => void submit()}
              data-testid="create-agent"
            >
              {walletReady ? 'Create agent' : 'Connect your wallet first'}
            </button>
          </div>
        </div>
      )}

      {step === 'passphrase' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (passphrase.length < 8) {
              setError('Choose a passphrase of at least 8 characters.');
              return;
            }
            setError(null);
            void submit(passphrase);
          }}
          style={{ display: 'grid', gap: '0.9rem' }}
        >
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Choose a passphrase</h1>
          <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.9rem' }}>
            Your wallet signs differently each time, so we cannot use it to lock your audit key.
            Pick a passphrase instead — you will need it to read your audit trail later.
          </p>
          <Field
            id="kek-passphrase"
            label="Passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            error={error}
            autoComplete="new-password"
          />
          <button type="submit" className="btn btn-primary">
            Lock my audit key
          </button>
        </form>
      )}

      {step === 'creating' && (
        <div role="status" aria-live="polite" style={{ display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <span className="dot-live" aria-hidden="true" />
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Creating your agent…</h1>
          <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.9rem' }}>
            Generating your audit key, asking your wallet for a signature, and deploying the
            on-chain account. This can take a minute.
          </p>
        </div>
      )}

      {step === 'done' && result && (
        <div style={{ display: 'grid', gap: '1rem' }} data-testid="create-done">
          <span className="pill pill-allow">Agent created</span>
          <h1 style={{ fontSize: 'var(--text-h1)' }}>Save your gateway token</h1>
          <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.9rem' }}>
            This token is shown <strong style={{ color: 'var(--color-ink)' }}>only once</strong>. Your
            agent uses it to reach its brain through LEASH.
          </p>
          <div className="panel" style={{ padding: '0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'center', justifyContent: 'space-between' }}>
            <code className="code" data-testid="gateway-token" style={{ color: 'var(--color-accent)' }}>
              {result.response.gatewayToken}
            </code>
            <CopyButton text={result.response.gatewayToken} />
          </div>
          <div style={{ display: 'grid', gap: '0.3rem', fontSize: '0.84rem', color: 'var(--color-ink-dim)', fontFamily: 'var(--font-mono)' }}>
            <span>Account: {result.response.accountAddr}</span>
            <span>Audit key locked with: {result.kekMode === 'signature' ? 'your wallet signature' : 'your passphrase'}</span>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={result.downloadBackup}>
              Download audit key backup
            </button>
            <a className="btn btn-primary" href={`/agents/${result.response.agentId}`}>
              Open the cockpit
            </a>
          </div>
          {role !== 'sentinel' ? (
            <section aria-label="Fund your agent" className="panel" style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.7rem' }}>
              <h2 style={{ fontSize: '1rem' }}>Fund your agent</h2>
              <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem', margin: 0 }}>
                The agent pays from its own on-chain account, which starts empty. Send some 0G so
                it can actually pay when the time comes.
              </p>
              <FundPanel
                accountAddr={result.response.accountAddr}
                defaultAmountOg={weiToOg(2n * BigInt(input?.policy.windowCapWei ?? ogToWei(windowAmount)))}
                onSend={fund ? (valueWei) => fund.send(result.response.accountAddr, valueWei) : undefined}
                getBalance={fundGetBalance ? () => fundGetBalance(result.response.accountAddr) : undefined}
                skipHref={`/agents/${result.response.agentId}`}
              />
            </section>
          ) : (
            <p data-testid="sentinel-no-fund-note" style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem' }}>
              Nothing to fund: this watcher can never move money, so its account stays empty.
              Next, link it to an agent that can act — from the Links page.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
