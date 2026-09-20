// File: web/components/ui/Field.tsx
// Labeled input with inline error, wired for a11y (aria-invalid + aria-describedby).
import type { InputHTMLAttributes, ReactNode } from 'react';

type Props = {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  suffix?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export function Field({ id, label, hint, error, suffix, ...input }: Props) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div style={{ display: 'grid', gap: '0.35rem' }}>
      <label htmlFor={id} className="label" style={{ color: 'var(--color-ink)' }}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} style={{ fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>
          {hint}
        </p>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          id={id}
          className="field"
          aria-invalid={error ? true : undefined}
          aria-describedby={[errId, hintId].filter(Boolean).join(' ') || undefined}
          {...input}
        />
        {suffix ? (
          <span className="badge" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={errId} role="alert" style={{ fontSize: '0.82rem', color: 'var(--color-deny)' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
