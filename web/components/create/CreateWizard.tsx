// File: web/components/create/CreateWizard.tsx
// Guided create flow (00 §2c): ONE decision per step, plain language, jargon behind
// <Disclosure>. The heavy lifting (audit keypair, KEK, API call) is injected via onCreate so
// this component stays a pure, testable state machine.
'use client';

import { useMemo, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { isValidOgAmount, ogToWei, weiToOg } from '@/lib/format';
import type { CreateAgentResponse, GoalInput, Hex, PolicyInput } from '@/lib/types';
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
  goal: GoalInput;
};

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
};

type Step = 'name' | 'goal' | 'transfer-cap' | 'budget' | 'allowlist' | 'expiry' | 'review' | 'passphrase' | 'creating' | 'done';

const STEP_ORDER: Step[] = ['name', 'goal', 'transfer-cap', 'budget', 'allowlist', 'expiry', 'review'];
const DAY = 86_400;

export function CreateWizard({ onCreate, walletReady, fund }: CreateWizardProps) {
  const [step, setStep] = useState<Step>('name');
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

  const input = useMemo<WizardInput | null>(() => {
    if (
      !name.trim() ||
      !isAddress(beneficiary) ||
      !isValidOgAmount(targetBalance) ||
      !isValidOgAmount(topUp) ||
      !isValidOgAmount(perTransfer) ||
      !isValidOgAmount(windowAmount) ||
      !/^\d+$/.test(windowHours) ||
      Number(windowHours) < 1 ||
      !isAddress(payee) ||
      !/^\d+$/.test(expiryDays) ||
      Number(expiryDays) < 1
    ) {
      return null;
    }
    return {
      name: name.trim(),
      policy: {
        perTransferCapWei: ogToWei(perTransfer),
        windowCapWei: ogToWei(windowAmount),
        windowSeconds: Number(windowHours) * 3600,
        expiresAt: Math.floor(Date.now() / 1000) + Number(expiryDays) * DAY,
      },
      allowlist: [payee],
      goal: {
        beneficiary,
        targetBalanceWei: ogToWei(targetBalance),
        topUpWei: ogToWei(topUp),
      },
    };
  }, [name, beneficiary, targetBalance, topUp, perTransfer, windowAmount, windowHours, payee, expiryDays]);

  // Reviewed constraint: a single top-up is one payment, so it can never exceed the
  // per-payment cap the chain enforces.
  const topUpExceedsCap = useMemo(() => {
    if (!isValidOgAmount(topUp) || !isValidOgAmount(perTransfer)) return false;
    return BigInt(ogToWei(topUp)) > BigInt(ogToWei(perTransfer));
  }, [topUp, perTransfer]);

  const stepIndex = STEP_ORDER.indexOf(step);
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
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setStep('review');
    }
  }

  const nav = (next: Step) => (
    <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.5rem' }}>
      {stepIndex > 0 ? (
        <button type="button" className="btn btn-ghost" onClick={() => setStep(STEP_ORDER[stepIndex - 1] ?? 'name')}>
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
          {step === 'passphrase' ? 'One more thing' : `Step ${Math.max(stepIndex, 0) + 1} of ${STEP_ORDER.length}`}
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
          'transfer-cap',
          isAddress(beneficiary) && isValidOgAmount(targetBalance) && isValidOgAmount(topUp),
          'Enter a valid wallet address and amounts greater than zero, like 0.1.',
          <>
            <h1 style={{ fontSize: 'var(--text-h1)' }}>Who should it keep topped up?</h1>
            <Field
              id="goal-beneficiary"
              label="Who to keep topped up"
              hint="The wallet your agent watches and refills. We will also pre-fill it as the allowed recipient a few steps from now."
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              placeholder="0x…"
              autoFocus
            />
            <Field
              id="goal-target"
              label="Keep them at"
              hint="When their balance dips below this, your agent tops it back up."
              value={targetBalance}
              onChange={(e) => setTargetBalance(e.target.value)}
              inputMode="decimal"
              suffix="0G"
            />
            <Field
              id="goal-topup"
              label="Send at most, per top-up"
              value={topUp}
              onChange={(e) => setTopUp(e.target.value)}
              inputMode="decimal"
              suffix="0G"
            />
            <Disclosure label="How does the agent use this?">
              This goal is the agent&apos;s standing instruction: watch the beneficiary&apos;s
              balance and top it up toward the target, never sending more than the per-top-up
              amount at once. The on-chain caps you set next still bound every single payment,
              no matter what the agent decides.
            </Disclosure>
          </>,
          // The beneficiary is almost always the payee — seed the allowlist step so the
          // user does not retype the address (they can still change it there).
          () => {
            if (!payee.trim() && isAddress(beneficiary)) setPayee(beneficiary);
          },
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
              hint="Your agent can ONLY send to this address. Everything else is blocked by default. You can add more later from the cockpit."
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
              ['Keeps topped up', beneficiary],
              ['Keep them at', `${targetBalance} 0G`],
              ['Per top-up', `${topUp} 0G max`],
              ['Per payment', `${weiToOg(input?.policy.perTransferCapWei ?? '0')} 0G max`],
              ['Budget', `${weiToOg(input?.policy.windowCapWei ?? '0')} 0G every ${windowHours} hours`],
              ['Can pay', payee],
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
          <section aria-label="Fund your agent" className="panel" style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.7rem' }}>
            <h2 style={{ fontSize: '1rem' }}>Fund your agent</h2>
            <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.88rem', margin: 0 }}>
              The agent pays from its own on-chain account, which starts empty. Send some 0G so it
              can actually top your beneficiary up.
            </p>
            <FundPanel
              accountAddr={result.response.accountAddr}
              defaultAmountOg={weiToOg(2n * BigInt(input?.policy.windowCapWei ?? ogToWei(windowAmount)))}
              onSend={fund ? (valueWei) => fund.send(result.response.accountAddr, valueWei) : undefined}
              getBalance={fundGetBalance ? () => fundGetBalance(result.response.accountAddr) : undefined}
              skipHref={`/agents/${result.response.agentId}`}
            />
          </section>
        </div>
      )}
    </div>
  );
}
