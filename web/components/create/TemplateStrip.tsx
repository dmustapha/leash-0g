// File: web/components/create/TemplateStrip.tsx
// Phase-5 (D-B5): a strip of curated CreateTemplate cards. Picking one loads its draft straight
// into ReadBack — NO LLM call. The reliable floor under spec-elevation (a bad model draft never
// blocks the user; a template always works).
'use client';

import { CREATE_TEMPLATES } from './templates';
import type { ElevationDraft } from '@/lib/types';

export function TemplateStrip({ onPick }: { onPick: (draft: ElevationDraft) => void }) {
  return (
    <section data-testid="template-strip" aria-label="Start from a template" style={{ display: 'grid', gap: '0.6rem' }}>
      <p className="label" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>…or start from a template</p>
      <div style={{ display: 'grid', gap: '0.6rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}>
        {CREATE_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="panel"
            data-testid={`template-${t.id}`}
            onClick={() => onPick(t.draft)}
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              padding: '0.85rem 0.95rem',
              display: 'grid',
              gap: '0.35rem',
              border: '1px solid var(--color-line-soft)',
            }}
          >
            <strong style={{ fontSize: '0.95rem' }}>{t.title}</strong>
            <span style={{ fontSize: '0.82rem', color: 'var(--color-ink-dim)' }}>{t.blurb}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
