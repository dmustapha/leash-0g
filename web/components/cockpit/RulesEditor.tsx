// File: web/components/cockpit/RulesEditor.tsx
// gatewayRules editor (Gate-② parity, spec §3c): view + edit the agent's message rules
// post-create via PATCH /api/agents/:id/rules. ≤32 rows; every change is recorded in the
// audit trail (traced as a 'config' record).
'use client';

import { useState } from 'react';
import type { GatewayRule } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

export const RULES_MAX = 32;

const ACTION_LABEL: Record<GatewayRule['action'], string> = {
  block: 'Block the message',
  modify: 'Rewrite the match',
  require_approval: 'Ask me first',
};

export function RulesEditor({
  rules,
  onSave,
}: {
  rules: GatewayRule[];
  onSave: (rules: GatewayRule[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<GatewayRule[]>(rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update(i: number, patch: Partial<GatewayRule>) {
    setSaved(false);
    setDraft((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setSaved(false);
    if (draft.length >= RULES_MAX) {
      setError(`You can have at most ${RULES_MAX} rules.`);
      return;
    }
    setError(null);
    setDraft((prev) => [...prev, { action: 'block', match: '' }]);
  }

  function removeRow(i: number) {
    setSaved(false);
    setError(null);
    setDraft((prev) => prev.filter((_, j) => j !== i));
  }

  async function save() {
    if (draft.length > RULES_MAX) {
      setError(`You can have at most ${RULES_MAX} rules.`);
      return;
    }
    if (draft.some((r) => !r.match.trim())) {
      setError('Every rule needs text to match on.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(
        draft.map((r) => ({
          action: r.action,
          match: r.match.trim(),
          ...(r.action === 'modify' && r.replacement !== undefined
            ? { replacement: r.replacement }
            : {}),
        })),
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rules. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Message rules" className="card" data-testid="rules-editor" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <h2 style={{ fontSize: '1rem' }}>Message rules</h2>
        <span style={{ flex: 1 }} />
        <span className="badge">{draft.length}/{RULES_MAX}</span>
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        Rules screen everything your agent says to its brain. Match some text and choose what
        happens: block it, rewrite it, or ask you first. Changes are recorded in the audit trail.
      </p>

      {draft.length === 0 ? (
        <p data-testid="rules-empty" style={{ fontSize: '0.86rem', color: 'var(--color-ink-faint)' }}>
          No rules yet — everything passes through unchanged.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.6rem' }}>
          {draft.map((r, i) => (
            <li key={i} className="panel" data-testid={`rule-row-${i}`} style={{ padding: '0.7rem 0.8rem', display: 'grid', gap: '0.5rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="label" htmlFor={`rule-action-${i}`}>When it sees</label>
                <input
                  id={`rule-match-${i}`}
                  aria-label={`Rule ${i + 1} text to match`}
                  className="field"
                  style={{ flex: 1, minWidth: '10rem' }}
                  value={r.match}
                  onChange={(e) => update(i, { match: e.target.value })}
                  placeholder="text to match"
                  disabled={busy}
                />
                <select
                  id={`rule-action-${i}`}
                  aria-label={`Rule ${i + 1} action`}
                  className="field"
                  style={{ width: 'auto' }}
                  value={r.action}
                  onChange={(e) => update(i, { action: e.target.value as GatewayRule['action'] })}
                  disabled={busy}
                >
                  {(Object.keys(ACTION_LABEL) as GatewayRule['action'][]).map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABEL[a]}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeRow(i)} disabled={busy} data-testid={`remove-rule-${i}`}>
                  Remove
                </button>
              </div>
              {r.action === 'modify' ? (
                <input
                  aria-label={`Rule ${i + 1} replacement text`}
                  className="field"
                  value={r.replacement ?? ''}
                  onChange={(e) => update(i, { replacement: e.target.value })}
                  placeholder="replace the match with…"
                  disabled={busy}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" data-testid="rules-saved" style={{ color: 'var(--color-allow)', fontSize: '0.85rem' }}>
          Rules saved and recorded in the audit trail.
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={addRow} disabled={busy} data-testid="add-rule-btn">
          Add rule
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy} data-testid="save-rules-btn">
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      </div>

      <Disclosure label="How do rules work under the hood?">
        Each rule is a case-insensitive text match applied to every message your agent sends
        through its LEASH gateway, in order — the first matching rule wins. Block rejects the
        request, modify substitutes the matched text before it reaches the model, and
        ask-me-first holds the request until you approve or deny it. Every change to this list
        is appended to the agent&apos;s tamper-evident trace chain as a config record.
      </Disclosure>
    </section>
  );
}
