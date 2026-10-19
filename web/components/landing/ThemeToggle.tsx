// File: web/components/landing/ThemeToggle.tsx
// STAGE G-1.2 — the light-mode control, lifted from the owner-locked design build
// (`design-reference/marketing.html`: button :316, handler :549-562, CSS :38-42).
//
// Scoped to the MARKETING page on purpose, and only for now. G-1.1 left five console
// colour tokens literal-and-dark in globals.css (`--color-line`, `--color-line-soft`,
// `--color-accent-soft`, `--color-allow-soft`, `--color-deny-soft`), so a toggle
// reachable from the cockpit would render light surfaces with dark hairlines and dark
// soft-fills — a half-themed console. The reference's own console surfaces DO carry
// this same control (`bind.html:217`, `signing.html:94`), so bringing it there is a
// DEFERRED OBLIGATION for G-2 once those five are retargeted, not a dropped part.
//
// Two implementation choices are load-bearing:
//
//  1. No render-time state. Both glyphs are in the DOM and CSS picks one
//     (`.leash-landing .theme-toggle` rules in landing.css keyed off
//     `:root[data-theme="light"]`). A React-state-driven icon would either mismatch
//     on hydration or flash the wrong glyph on a hard load in light mode, because the
//     anti-FOUC script in app/layout.tsx sets `data-theme` BEFORE React ever runs.
//
//  2. The mount effect re-applies the persisted value. The head script only runs on a
//     full document load; a client-side navigation INTO `/` never re-runs it. The
//     cleanup removes `data-theme` so navigating out to the console drops light mode
//     without needing a reload.
'use client';

import { useEffect } from 'react';

const KEY = 'leash-theme';

export default function ThemeToggle() {
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    } catch {
      // Private-mode / blocked storage: dark is the default, so there is nothing to do.
    }
    return () => document.documentElement.removeAttribute('data-theme');
  }, []);

  // Mirrors marketing.html:556-561 — light SETS the attribute, dark REMOVES it (rather
  // than setting `data-theme="dark"`), because the dark values live on the bare `:root`.
  const toggle = () => {
    const root = document.documentElement;
    const toLight = root.getAttribute('data-theme') !== 'light';
    if (toLight) root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem(KEY, toLight ? 'light' : 'dark');
    } catch {
      // Preference just won't persist; the toggle still works for this page view.
    }
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label="Toggle light or dark theme"
      title="Toggle theme"
    >
      {/* Paths verbatim from marketing.html:551-552. aria-hidden because the button
          carries the label; `focusable="false"` keeps IE/old-Edge out of the tab order. */}
      <svg
        className="theme-icon theme-icon-moon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
        focusable="false"
      >
        <path d="M13.5 9.3A5.5 5.5 0 1 1 6.7 2.5 4.3 4.3 0 0 0 13.5 9.3Z" />
      </svg>
      <svg
        className="theme-icon theme-icon-sun"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="8" cy="8" r="3.2" />
        <path
          d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M13 3l-1.1 1.1M4.1 11.9 3 13"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
