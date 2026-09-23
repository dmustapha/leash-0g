// File: web/components/create/JobSpecEditor.tsx
// Phase-4 create-flow (spec §7): the owner-seeded job spec (F5) a requester
// executes. This is AUTHORITY — the fee amount + acceptance rules live here in
// server state, never in model/envelope text (F4). The acceptance rule set is
// the generic, config-driven floor (F2): structural checks only, no LLM.
'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { AcceptanceRule, JobSpecFields, OwnerJobSpec } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

/** Labeled wrapper that accepts any control (input OR textarea), unlike ui/Field. */
function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: '0.3rem' }}>
      <span className="label" style={{ color: 'var(--color-ink)' }}>{label}</span>
      {hint ? <p style={{ fontSize: '0.8rem', color: 'var(--color-ink-dim)', margin: 0 }}>{hint}</p> : null}
      {children}
    </div>
  );
}

const RULE_KINDS: AcceptanceRule['kind'][] = ['required', 'type', 'numberRange', 'stringLength', 'enum', 'arrayMinLength'];

type Draft = { kind: AcceptanceRule['kind']; path: string; a?: string; b?: string; type?: string };

function toRule(d: Draft): AcceptanceRule | null {
  if (!d.path.trim()) return null;
  switch (d.kind) {
    case 'required':
      return { kind: 'required', path: d.path };
    case 'type':
      return { kind: 'type', path: d.path, type: (d.type as 'string') || 'string' };
    case 'numberRange':
      return {
        kind: 'numberRange',
        path: d.path,
        ...(d.a ? { min: Number(d.a) } : {}),
        ...(d.b ? { max: Number(d.b) } : {}),
      };
    case 'stringLength':
      return {
        kind: 'stringLength',
        path: d.path,
        ...(d.a ? { min: Number(d.a) } : {}),
        ...(d.b ? { max: Number(d.b) } : {}),
      };
    case 'enum':
      return { kind: 'enum', path: d.path, values: (d.a ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
    case 'arrayMinLength':
      return { kind: 'arrayMinLength', path: d.path, min: Number(d.a ?? '1') };
  }
}

/** Human summary of a rule for the review list. */
export function ruleSummary(r: AcceptanceRule): string {
  switch (r.kind) {
    case 'required':
      return `"${r.path}" is required`;
    case 'type':
      return `"${r.path}" must be ${r.type}`;
    case 'numberRange':
      return `"${r.path}" is a number${r.min !== undefined ? ` ≥ ${r.min}` : ''}${r.max !== undefined ? ` ≤ ${r.max}` : ''}`;
    case 'stringLength':
      return `"${r.path}" text length${r.min !== undefined ? ` ≥ ${r.min}` : ''}${r.max !== undefined ? ` ≤ ${r.max}` : ''}`;
    case 'enum':
      return `"${r.path}" ∈ {${r.values.join(', ')}}`;
    case 'arrayMinLength':
      return `"${r.path}" is an array of ≥ ${r.min}`;
  }
}

export function JobSpecEditor({
  onSave,
  initial,
}: {
  onSave: (sourceRef: string, spec: OwnerJobSpec) => Promise<void>;
  initial?: { sourceRef: string; value: OwnerJobSpec };
}) {
  const [sourceRef, setSourceRef] = useState(initial?.sourceRef ?? '');
  const [question, setQuestion] = useState(initial?.value.spec.question ?? '');
  const [context, setContext] = useState(initial?.value.spec.context ?? '');
  const [schemaRef, setSchemaRef] = useState(initial?.value.spec.deliverableSchemaRef ?? '');
  const [acceptanceRef, setAcceptanceRef] = useState(initial?.value.spec.acceptanceRef ?? '');
  const [feeAmount, setFeeAmount] = useState(initial?.value.feeAmountWei ?? '');
  const [rules, setRules] = useState<AcceptanceRule[]>(initial?.value.acceptance.rules ?? []);
  const [draft, setDraft] = useState<Draft>({ kind: 'required', path: '' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function addRule() {
    const r = toRule(draft);
    if (!r) {
      setError('a rule needs a field path');
      return;
    }
    setRules((rs) => [...rs, r]);
    setDraft({ kind: 'required', path: '' });
    setError(null);
  }

  async function save() {
    if (!sourceRef.trim() || !question.trim() || !schemaRef.trim() || !acceptanceRef.trim() || !/^\d+$/.test(feeAmount) || rules.length === 0) {
      setError('fill the handle, question, schema, acceptance label, a numeric fee (base units), and at least one rule');
      return;
    }
    const spec: JobSpecFields = {
      question: question.trim(),
      ...(context.trim() ? { context: context.trim() } : {}),
      deliverableSchemaRef: schemaRef.trim(),
      acceptanceRef: acceptanceRef.trim(),
    };
    try {
      await onSave(sourceRef.trim(), { spec, acceptance: { label: acceptanceRef.trim(), rules }, feeAmountWei: feeAmount });
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    }
  }

  return (
    <section className="panel" data-testid="job-spec-editor" style={{ display: 'grid', gap: '0.9rem' }}>
      <header style={{ display: 'grid', gap: '0.2rem' }}>
        <strong style={{ fontSize: '1rem' }}>Define a job</strong>
        <span style={{ fontSize: '0.82rem', color: 'var(--color-ink-faint)' }}>
          The requester runs this exact spec. The fee and the pass/fail rules live here, on your side — the agents
          never invent them.
        </span>
      </header>

      <Labeled label="Handle" hint="A short id the requester points at (e.g. eth-4000).">
        <input className="field" data-testid="js-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
      </Labeled>
      <Labeled label="Question" hint="The real task the provider answers.">
        <textarea className="field" data-testid="js-question" rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </Labeled>
      <Labeled label="Context (optional)">
        <textarea className="field" data-testid="js-context" rows={2} value={context} onChange={(e) => setContext(e.target.value)} />
      </Labeled>
      <Labeled label="Deliverable schema" hint="What shape the answer must take (a description or a schema id).">
        <input className="field" data-testid="js-schema" value={schemaRef} onChange={(e) => setSchemaRef(e.target.value)} />
      </Labeled>
      <Labeled label="Acceptance label" hint="A name for this pass/fail rule set.">
        <input className="field" data-testid="js-acceptance" value={acceptanceRef} onChange={(e) => setAcceptanceRef(e.target.value)} />
      </Labeled>
      <Labeled label="Fee (token base units)" hint="6-dp for TestUSD: 5000000 = 5.00. Bounded again by the on-chain caps.">
        <input className="field" data-testid="js-fee" value={feeAmount} onChange={(e) => setFeeAmount(e.target.value)} inputMode="numeric" />
      </Labeled>

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <strong style={{ fontSize: '0.9rem' }}>Acceptance floor</strong>
        <span style={{ fontSize: '0.8rem', color: 'var(--color-ink-faint)' }}>
          Automatic structural checks — a garbage answer never reaches the evaluator. This is not a quality judge
          (that is the evaluator&apos;s job); it just enforces shape and ranges.
        </span>
        <ul data-testid="js-rules" style={{ display: 'grid', gap: '0.3rem', listStyle: 'none', margin: 0, padding: 0 }}>
          {rules.map((r, i) => (
            <li key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.82rem' }}>
              <span>{ruleSummary(r)}</span>
              <button className="btn btn-ghost btn-sm" data-testid={`js-rule-remove-${i}`} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                remove
              </button>
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="field" data-testid="js-rule-kind" value={draft.kind} onChange={(e) => setDraft({ kind: e.target.value as AcceptanceRule['kind'], path: draft.path })}>
            {RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input className="field" data-testid="js-rule-path" placeholder="field path (e.g. probability)" value={draft.path} onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))} />
          {draft.kind === 'type' ? (
            <select className="field" data-testid="js-rule-type" value={draft.type ?? 'string'} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
              {['string', 'number', 'boolean', 'object', 'array'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : null}
          {draft.kind === 'numberRange' || draft.kind === 'stringLength' ? (
            <>
              <input className="field" data-testid="js-rule-min" placeholder="min" value={draft.a ?? ''} onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))} style={{ width: 70 }} />
              <input className="field" data-testid="js-rule-max" placeholder="max" value={draft.b ?? ''} onChange={(e) => setDraft((d) => ({ ...d, b: e.target.value }))} style={{ width: 70 }} />
            </>
          ) : null}
          {draft.kind === 'enum' ? (
            <input className="field" data-testid="js-rule-values" placeholder="a, b, c" value={draft.a ?? ''} onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))} />
          ) : null}
          {draft.kind === 'arrayMinLength' ? (
            <input className="field" data-testid="js-rule-min" placeholder="min" value={draft.a ?? ''} onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))} style={{ width: 70 }} />
          ) : null}
          <button className="btn btn-ghost btn-sm" data-testid="js-rule-add" onClick={addRule}>
            add rule
          </button>
        </div>
      </div>

      {error ? <p style={{ color: 'var(--color-deny, #d66)', fontSize: '0.84rem', margin: 0 }} data-testid="js-error">{error}</p> : null}
      {saved ? <p style={{ color: 'var(--color-ink-dim)', fontSize: '0.84rem', margin: 0 }} data-testid="js-saved">Saved — a requester can now point at “{sourceRef}”.</p> : null}
      <button className="btn btn-primary" data-testid="js-save" onClick={save}>
        Save job
      </button>

      <Disclosure label="What is authority here?">
        <p style={{ fontSize: '0.8rem', color: 'var(--color-ink-faint)', margin: 0 }}>
          The fee amount and the acceptance rules are read from this saved spec at run time. A hijacked requester
          cannot invent a larger fee or a looser rule set — it can only execute what you defined.
        </p>
      </Disclosure>
    </section>
  );
}
