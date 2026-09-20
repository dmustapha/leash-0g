// File: web/components/ui/Disclosure.tsx
// Progressive disclosure: plain language on the surface, jargon behind an expandable detail
// (00 §2c). Native <details>/<summary> — keyboard and screen-reader support for free.
import type { ReactNode } from 'react';

export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details
      style={{
        border: '1px solid var(--color-line-soft)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-1)',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          padding: '0.55rem 0.8rem',
          fontSize: '0.85rem',
          color: 'var(--color-ink-dim)',
          listStylePosition: 'inside',
        }}
      >
        {label}
      </summary>
      <div style={{ padding: '0 0.9rem 0.8rem', fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        {children}
      </div>
    </details>
  );
}
