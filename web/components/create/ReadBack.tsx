// File: web/components/create/ReadBack.tsx
// Phase-5 (D-B3/D-B4/D-B6) — THE load-bearing, security-critical unit of the create funnel.
//
// It renders a QUARANTINED ElevationDraft (a model suggestion, never authority) in two visually
// distinct tiers so the owner reads it back and confirms:
//   • "What it does"  — low-stakes descriptive fields, all editable.
//   • "The leash"     — money / authority, visually distinct (amber-bordered), demands a
//                       deliberate touch. The money-power line is stated in plain language so a
//                       wrong-role draft is human-catchable.
//
// SECURITY INVARIANTS enforced here (spec §8):
//   1. Never-guess-money — the recipient/allowlist ADDRESS field is ALWAYS blank-required
//      (never pre-filled from the draft; the draft never carries an address). The fee field is
//      blank-required UNLESS draft.suggestedFeeBaseUnits is present (i.e. the user stated it).
//   2. Quarantine — `rationale` and every model-authored string render as PLAIN TEXT. There is
//      no dangerouslySetInnerHTML anywhere in this file (react/no-danger is on).
//
// Authored ROLE-NEUTRAL: it parameterizes entirely on the draft (no "this is a new agent"
// hardcoding) so Phase 5.5 reuses it at direction-time (spec §9).
'use client';

import { useMemo, useState } from 'react';
import type { AgentRole, DirectionDraft, ElevationDraft } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

/** Plain-language label for a role — no jargon on the surface (00 §2c). */
const ROLE_LABEL: Record<AgentRole, string> = {
  treasury: 'Manages an allowance itself',
  sentinel: 'Watches and requests top-ups',
  executor: 'Acts on requests from another agent',
  requester: 'Orders a job and pays for good work',
  provider: 'Does a job for others',
  evaluator: 'Judges others’ work',
};

/** Roles that can move money — drives which leash inputs the owner must complete. */
function roleMovesMoney(role: AgentRole): boolean {
  return role === 'treasury' || role === 'executor' || role === 'requester';
}

function unsure(draft: ElevationDraft, path: string): boolean {
  return draft.unsureFields.includes(path);
}

/** Inline "not sure — please check" flag (D-B6). Conditional per field, never a separate step. */
function UnsureFlag({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      data-testid="unsure-flag"
      role="note"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        fontSize: '0.75rem',
        color: 'var(--color-accent)',
        marginTop: '0.2rem',
      }}
    >
      not sure about this — please check
    </span>
  );
}

/** A labeled editable field (input or textarea), local to the read-back. */
function EditField({
  label,
  testid,
  value,
  onChange,
  placeholder,
  required,
  requiredHint,
  multiline,
  showUnsure,
}: {
  label: string;
  testid: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  requiredHint?: string;
  multiline?: boolean;
  showUnsure?: boolean;
}) {
  const missing = required && !value.trim();
  const fieldId = `field-${testid}`;
  return (
    <div style={{ display: 'grid', gap: '0.3rem' }}>
      <label htmlFor={fieldId} className="label" style={{ color: 'var(--color-ink)' }}>
        {label}
        {required ? <span style={{ color: 'var(--color-deny)' }}> *</span> : null}
      </label>
      {requiredHint ? (
        <p style={{ fontSize: '0.78rem', color: 'var(--color-ink-dim)', margin: 0 }}>{requiredHint}</p>
      ) : null}
      {multiline ? (
        <textarea
          id={fieldId}
          className="field"
          data-testid={testid}
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={fieldId}
          className="field"
          data-testid={testid}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={missing ? true : undefined}
        />
      )}
      <UnsureFlag show={!!showUnsure} />
    </div>
  );
}

export type CreateReadBackProps = {
  /** Defaults to 'create' so existing callers are unchanged. */
  mode?: 'create';
  draft: ElevationDraft;
  /** `recipient` is the owner-typed address authority (never from the model) — undefined for
   *  spend-incapable roles. Kept out of the draft so the quarantined suggestion stays clean. */
  onConfirm: (edited: ElevationDraft, recipient?: string) => void;
  onBack: () => void;
};

export type DirectReadBackProps = {
  mode: 'direct';
  draft: DirectionDraft;
  /** `recipient` stays the owner-typed, out-of-band address contract — undefined for
   *  roles that cannot move money. Never merged into the quarantined draft. */
  onConfirm: (edited: DirectionDraft, recipient?: string) => void;
  onBack: () => void;
};

export type ReadBackProps = CreateReadBackProps | DirectReadBackProps;

// ONE component, two shapes. Create mode is unchanged; direct mode renders a DirectionDraft.
export function ReadBack(props: ReadBackProps) {
  if (props.mode === 'direct') return <DirectReadBack {...props} />;
  return <CreateReadBack {...props} />;
}

function CreateReadBack({ draft, onConfirm, onBack }: CreateReadBackProps) {
  const role = draft.proposedRole;
  const movesMoney = roleMovesMoney(role);

  // — "What it does" editable state (descriptive tier) —
  const [capabilityLabel, setCapabilityLabel] = useState(draft.capabilityLabel ?? '');
  const [serviceSpec, setServiceSpec] = useState(draft.serviceSpec ?? '');
  const [rubricRef, setRubricRef] = useState(draft.rubricRef ?? '');
  const [jobQuestion, setJobQuestion] = useState(draft.jobSpec?.fields.question ?? '');

  // — "The leash" editable state (money / authority tier) —
  // Caps are SHOWN as suggestions the owner must acknowledge (pre-filled, editable).
  const [perTransferWei, setPerTransferWei] = useState(draft.suggestedPolicy?.perTransferCapWei ?? '');
  const [windowWei, setWindowWei] = useState(draft.suggestedPolicy?.windowCapWei ?? '');
  const [tokenPerTransferWei, setTokenPerTransferWei] = useState(draft.suggestedTokenPerTransferWei ?? '');
  const [tokenWindowWei, setTokenWindowWei] = useState(draft.suggestedTokenWindowWei ?? '');
  // NEVER pre-filled: the recipient/allowlist address. Always blank-required (never-guess-money).
  const [recipient, setRecipient] = useState('');
  // Fee blank-required UNLESS the user's own intent stated an amount (suggestedFeeBaseUnits).
  const [fee, setFee] = useState(draft.suggestedFeeBaseUnits ?? '');

  const [error, setError] = useState<string | null>(null);

  const moneyPowerLine = useMemo(
    () =>
      draft.moneyPower === 'can-move-money'
        ? 'This agent can move money.'
        : 'This agent can never move money.',
    [draft.moneyPower],
  );

  function confirm() {
    // The recipient address is authority the model must never supply — the owner types it here.
    if (movesMoney && !recipient.trim()) {
      setError('Enter the wallet address this agent may pay. It is never guessed for you.');
      return;
    }
    setError(null);

    const edited: ElevationDraft = {
      ...draft,
      ...(capabilityLabel.trim() ? { capabilityLabel: capabilityLabel.trim() } : {}),
      ...(serviceSpec.trim() ? { serviceSpec: serviceSpec.trim() } : {}),
      ...(rubricRef.trim() ? { rubricRef: rubricRef.trim() } : {}),
      ...(draft.jobSpec
        ? { jobSpec: { fields: { ...draft.jobSpec.fields, question: jobQuestion.trim() }, acceptance: draft.jobSpec.acceptance } }
        : {}),
      ...(perTransferWei.trim() || windowWei.trim()
        ? {
            suggestedPolicy: {
              perTransferCapWei: perTransferWei.trim(),
              windowCapWei: windowWei.trim(),
              windowSeconds: draft.suggestedPolicy?.windowSeconds ?? 24 * 3600,
            },
          }
        : {}),
      ...(tokenPerTransferWei.trim() ? { suggestedTokenPerTransferWei: tokenPerTransferWei.trim() } : {}),
      ...(tokenWindowWei.trim() ? { suggestedTokenWindowWei: tokenWindowWei.trim() } : {}),
      // The fee is passed through ONLY if present; a blank fee is left for the owner to fill in
      // the wizard review — never fabricated here.
      ...(fee.trim() ? { suggestedFeeBaseUnits: fee.trim() } : {}),
    };
    // The owner-typed recipient is passed alongside the draft (never merged into it) so the
    // quarantined suggestion never carries fabricated address authority. Undefined when the role
    // cannot move money.
    onConfirm(edited, movesMoney ? recipient.trim() : undefined);
  }

  return (
    <section className="card" data-testid="read-back" style={{ padding: 'clamp(1.2rem, 3vw, 2rem)', display: 'grid', gap: '1.2rem' }}>
      <header style={{ display: 'grid', gap: '0.4rem' }}>
        <p className="eyebrow">Read it back</p>
        <h1 style={{ fontSize: 'var(--text-h1)' }}>Here’s what I understood</h1>
        {/* rationale is UNTRUSTED model text — rendered as PLAIN TEXT (no HTML). */}
        <p data-testid="read-back-rationale" style={{ color: 'var(--color-ink-dim)', fontSize: '0.92rem', margin: 0 }}>
          {draft.rationale}
        </p>
        {draft.confidence === 'low' ? (
          <p data-testid="read-back-low-confidence" style={{ color: 'var(--color-accent)', fontSize: '0.82rem', margin: 0 }}>
            I wasn’t fully sure about parts of this — the flagged fields are worth a second look.
          </p>
        ) : null}
      </header>

      {/* ───────── Tier 1: "What it does" (low-stakes descriptive) ───────── */}
      <section data-testid="tier-what-it-does" aria-label="What it does" className="panel" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.9rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>What it does</h2>

        <div style={{ display: 'grid', gap: '0.3rem' }}>
          <span className="label" style={{ color: 'var(--color-ink)' }}>Kind of agent</span>
          <p data-testid="read-back-role" style={{ margin: 0, fontSize: '0.92rem' }}>{ROLE_LABEL[role]}</p>
          <UnsureFlag show={unsure(draft, 'proposedRole')} />
        </div>

        <EditField
          label="What it’s for"
          testid="rb-capability"
          value={capabilityLabel}
          onChange={setCapabilityLabel}
          placeholder="e.g. market forecaster"
          showUnsure={unsure(draft, 'capabilityLabel')}
        />

        {role === 'provider' ? (
          <EditField
            label="Service it offers"
            testid="rb-service"
            value={serviceSpec}
            onChange={setServiceSpec}
            multiline
            placeholder="what work it produces"
            showUnsure={unsure(draft, 'serviceSpec')}
          />
        ) : null}
        {role === 'evaluator' ? (
          <EditField
            label="How it judges"
            testid="rb-rubric"
            value={rubricRef}
            onChange={setRubricRef}
            placeholder="the standard it holds work to"
            showUnsure={unsure(draft, 'rubricRef')}
          />
        ) : null}
        {draft.jobSpec ? (
          <EditField
            label="The job’s question"
            testid="rb-job-question"
            value={jobQuestion}
            onChange={setJobQuestion}
            multiline
            placeholder="the task the provider answers"
            showUnsure={unsure(draft, 'jobSpec.fields.question')}
          />
        ) : null}
      </section>

      {/* ───────── Tier 2: "The leash" (money / authority — visually distinct) ───────── */}
      <section
        data-testid="tier-the-leash"
        aria-label="The leash"
        style={{
          padding: '1rem 1.1rem',
          display: 'grid',
          gap: '0.9rem',
          border: '1px solid var(--color-accent)',
          borderRadius: 'var(--radius-md)',
          background: 'rgba(255,184,76,0.05)',
        }}
      >
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>The leash</h2>

        {/* Plain-language money-power line — the wrong-role catch (D-B4). */}
        <p
          data-testid="read-back-money-power"
          style={{
            margin: 0,
            fontSize: '0.95rem',
            fontWeight: 600,
            color: draft.moneyPower === 'can-move-money' ? 'var(--color-accent)' : 'var(--color-ink)',
          }}
        >
          {moneyPowerLine}
        </p>

        {movesMoney ? (
          <>
            {draft.suggestedPolicy ? (
              <>
                <EditField
                  label="Most it can send in one payment (wei)"
                  testid="rb-per-transfer"
                  value={perTransferWei}
                  onChange={setPerTransferWei}
                  requiredHint="A suggestion — acknowledge or change it. Bounded again on-chain."
                  showUnsure={unsure(draft, 'suggestedPolicy.perTransferCapWei')}
                />
                <EditField
                  label="Total it can spend per window (wei)"
                  testid="rb-window"
                  value={windowWei}
                  onChange={setWindowWei}
                  requiredHint="A suggestion — acknowledge or change it."
                  showUnsure={unsure(draft, 'suggestedPolicy.windowCapWei')}
                />
              </>
            ) : null}
            {role === 'requester' ? (
              <>
                <EditField
                  label="Max per settlement (token base units)"
                  testid="rb-token-per-transfer"
                  value={tokenPerTransferWei}
                  onChange={setTokenPerTransferWei}
                  requiredHint="A suggestion — acknowledge or change it."
                />
                <EditField
                  label="Max per window (token base units)"
                  testid="rb-token-window"
                  value={tokenWindowWei}
                  onChange={setTokenWindowWei}
                  requiredHint="A suggestion — acknowledge or change it."
                />
              </>
            ) : null}

            {/* Fee — blank-required UNLESS the user's intent stated an amount (D-B4). */}
            <EditField
              label="Fee per job (token base units)"
              testid="rb-fee"
              value={fee}
              onChange={setFee}
              placeholder={draft.suggestedFeeBaseUnits ? undefined : 'you must enter this — it is never guessed'}
              requiredHint={
                draft.suggestedFeeBaseUnits
                  ? 'From your own words — confirm or change it.'
                  : 'Left blank on purpose. Enter the fee yourself, or set it in the next step.'
              }
            />

            {/* Recipient — ALWAYS blank-required, NEVER pre-filled (never-guess-money, spec §8). */}
            <EditField
              label="Who it can pay"
              testid="rb-recipient"
              value={recipient}
              onChange={setRecipient}
              placeholder="0x… — you must enter this"
              required
              requiredHint="A wallet address is never guessed for you. Type the one address this agent may pay."
            />
          </>
        ) : (
          <p data-testid="read-back-no-money-note" style={{ margin: 0, fontSize: '0.88rem', color: 'var(--color-ink-dim)' }}>
            Nothing to set here. This agent holds zero spending caps and an empty allowlist by
            construction — there is no money for it to move, no matter what it is asked.
          </p>
        )}

        <Disclosure label="Why is money handled separately?">
          Money and authority are the scary part, so they live in their own tier and are never
          guessed. A wallet address is always yours to type; caps are suggestions you acknowledge;
          and everything is bounded again on-chain — this read-back is the first gate, not the only
          one.
        </Disclosure>
      </section>

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: '0.6rem' }}>
        <button type="button" className="btn btn-ghost" data-testid="read-back-back" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" data-testid="read-back-confirm" onClick={confirm}>
          Looks right — continue
        </button>
      </div>
    </section>
  );
}

// ───────── Phase 5.5 (spec §9): direct-mode read-back over a DirectionDraft ─────────
// A running agent's redirect. Same discipline as create: understanding is UNTRUSTED plain
// text; the recipient address is owner-typed + blank-required (never-guess-money); the
// suggestedPolicy is SHOWN read-only, never armed here (a loosen rides the timelocked path).

/** Keys that are money authority — never rendered or accepted inside a goalPatch (spec §8). */
const FORBIDDEN_PATCH_KEY = /address|recipient|allowlist|token|fee|payee|wallet/i;

/** A goalPatch entry we render as an editable descriptive field: primitive value, safe key. */
function editablePatchEntries(patch: Record<string, unknown>): [string, string][] {
  return Object.entries(patch)
    .filter(([k]) => !FORBIDDEN_PATCH_KEY.test(k))
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k, String(v)]);
}

/** Plain-language label for a goalPatch key — no jargon on the surface. */
function patchLabel(key: string): string {
  const map: Record<string, string> = {
    targetBalanceWei: 'Keep the balance at (wei)',
    topUpWei: 'Top up by at most (wei)',
    serviceSpec: 'Service it offers',
    rubricRef: 'How it judges',
    question: 'The job’s question',
  };
  return map[key] ?? key;
}

function DirectReadBack({ draft, onConfirm, onBack }: DirectReadBackProps) {
  const role = draft.currentRole;
  const movesMoney = roleMovesMoney(role);

  // Editable descriptive patch fields (never any money-authority key).
  const initial = useMemo(() => editablePatchEntries(draft.goalPatch), [draft.goalPatch]);
  const [patch, setPatch] = useState<Record<string, string>>(() => Object.fromEntries(initial));

  // NEVER pre-filled: the recipient. Always blank-required for a can-move-money role.
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);

  const moneyPowerLine = useMemo(
    () =>
      draft.moneyPower === 'can-move-money'
        ? 'This agent can move money.'
        : 'This agent can never move money.',
    [draft.moneyPower],
  );

  function confirm() {
    if (movesMoney && !recipient.trim()) {
      setError('Enter the wallet address this agent may pay. It is never guessed for you.');
      return;
    }
    setError(null);
    // Rebuild the goalPatch: overwrite only the descriptive fields the owner could edit, and
    // preserve any non-editable (non-money) keys untouched. Money-authority keys never existed.
    const editedGoalPatch: Record<string, unknown> = { ...draft.goalPatch };
    for (const [k, v] of Object.entries(patch)) {
      const original = draft.goalPatch[k];
      editedGoalPatch[k] = typeof original === 'number' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    const edited: DirectionDraft = { ...draft, goalPatch: editedGoalPatch };
    onConfirm(edited, movesMoney ? recipient.trim() : undefined);
  }

  return (
    <section className="card" data-testid="read-back" style={{ padding: 'clamp(1.2rem, 3vw, 2rem)', display: 'grid', gap: '1.2rem' }}>
      <header style={{ display: 'grid', gap: '0.4rem' }}>
        <p className="eyebrow">Redirect</p>
        <h1 style={{ fontSize: 'var(--text-h1)' }}>Here is how I understand the new task</h1>
        {/* understanding is UNTRUSTED agent-facing text — rendered as PLAIN TEXT (no HTML). */}
        <p data-testid="read-back-understanding" style={{ color: 'var(--color-ink-dim)', fontSize: '0.92rem', margin: 0 }}>
          {draft.understanding}
        </p>
        {draft.confidence === 'low' ? (
          <p data-testid="read-back-low-confidence" style={{ color: 'var(--color-accent)', fontSize: '0.82rem', margin: 0 }}>
            I wasn’t fully sure about parts of this — the flagged fields are worth a second look.
          </p>
        ) : null}
      </header>

      {/* ───────── Tier 1: "What changes" (low-stakes descriptive) ───────── */}
      <section data-testid="tier-what-it-does" aria-label="What changes" className="panel" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.9rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>What changes</h2>
        {initial.length === 0 ? (
          <p data-testid="read-back-no-patch" style={{ margin: 0, fontSize: '0.88rem', color: 'var(--color-ink-dim)' }}>
            Nothing descriptive to change here — this only redirects the agent’s task.
          </p>
        ) : (
          initial.map(([key]) => (
            <EditField
              key={key}
              label={patchLabel(key)}
              testid={`rb-patch-${key}`}
              value={patch[key] ?? ''}
              onChange={(v) => setPatch((p) => ({ ...p, [key]: v }))}
              showUnsure={draft.unsureFields.includes(`goalPatch.${key}`)}
            />
          ))
        )}
      </section>

      {/* ───────── Tier 2: "The leash" (money / authority — visually distinct) ───────── */}
      <section
        data-testid="tier-the-leash"
        aria-label="The leash"
        style={{
          padding: '1rem 1.1rem',
          display: 'grid',
          gap: '0.9rem',
          border: '1px solid var(--color-accent)',
          borderRadius: 'var(--radius-md)',
          background: 'rgba(255,184,76,0.05)',
        }}
      >
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>The leash</h2>

        <p
          data-testid="read-back-money-power"
          style={{
            margin: 0,
            fontSize: '0.95rem',
            fontWeight: 600,
            color: draft.moneyPower === 'can-move-money' ? 'var(--color-accent)' : 'var(--color-ink)',
          }}
        >
          {moneyPowerLine}
        </p>

        {/* suggestedPolicy is SHOWN read-only — never armed here (a raise rides the timelock). */}
        {draft.suggestedPolicy ? (
          <div data-testid="read-back-suggested-policy" className="panel" style={{ padding: '0.7rem 0.8rem', display: 'grid', gap: '0.4rem' }}>
            <p style={{ margin: 0, fontSize: '0.86rem' }}>
              Suggested limits (not applied): up to{' '}
              <strong>{draft.suggestedPolicy.perTransferCapWei}</strong> wei per payment,{' '}
              <strong>{draft.suggestedPolicy.windowCapWei}</strong> wei per window.
            </p>
            <Disclosure label="Why isn’t this limit applied now?">
              Raising a limit is a separate, time-locked step. This is only a suggestion to read —
              nothing here changes the on-chain caps. To raise a limit, use the agent’s Limits
              panel: it proposes the change and applies it after a short on-chain safety delay.
            </Disclosure>
          </div>
        ) : null}

        {movesMoney ? (
          <EditField
            label="Who it can pay"
            testid="rb-recipient"
            value={recipient}
            onChange={setRecipient}
            placeholder="0x… — you must enter this"
            required
            requiredHint="A wallet address is never guessed for you. Type the one address this agent may pay."
          />
        ) : (
          <p data-testid="read-back-no-money-note" style={{ margin: 0, fontSize: '0.88rem', color: 'var(--color-ink-dim)' }}>
            Nothing to set here. This agent cannot move money, so redirecting its task never gives
            it a way to spend.
          </p>
        )}

        <Disclosure label="Why is money handled separately?">
          Money and authority are the scary part, so they live in their own tier and are never
          guessed. A wallet address is always yours to type, and any limit change is a separate
          time-locked step — this read-back is a redirect, not a way to loosen the leash.
        </Disclosure>
      </section>

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: '0.6rem' }}>
        <button type="button" className="btn btn-ghost" data-testid="read-back-back" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" data-testid="read-back-confirm" onClick={confirm}>
          Confirm and redirect
        </button>
      </div>
    </section>
  );
}
