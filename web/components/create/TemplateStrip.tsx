// File: web/components/create/TemplateStrip.tsx
// Phase-5 (D-B5): a strip of curated CreateTemplate cards. Picking one loads its draft straight
// into ReadBack — NO LLM call. The reliable floor under spec-elevation (a bad model draft never
// blocks the user; a template always works).
'use client';

import { CREATE_TEMPLATES } from './templates';
import type { ElevationDraft } from '@/lib/types';

export function TemplateStrip({ onPick }: { onPick: (draft: ElevationDraft) => void }) {
  return (
    <section data-testid="template-strip" aria-label="Start from a template" style={{ marginTop: 'var(--s-5)' }}>
      <p className="section-title">
        …or start from a template <span className="n">reliable floor, no guessing</span>
      </p>
      <div className="chooser" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
        {CREATE_TEMPLATES.map((t) => (
          <button key={t.id} type="button" className="choice" data-testid={`template-${t.id}`} onClick={() => onPick(t.draft)}>
            <span className="cn">{t.title}</span>
            <span className="cd">{t.blurb}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
