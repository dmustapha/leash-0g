// File: web/components/ThemeToggle.tsx
// STAGE G-2.1 — the APP-WIDE light/dark control. Promoted out of the marketing-only
// scope (was components/landing/ThemeToggle.tsx) now that the console is themeable too
// (§0d: globals.css's five literal-dark tokens were retargeted to themeable aliases in
// this slice, and layout.tsx's anti-FOUC script is no longer pathname-gated to `/`).
//
// Two load-bearing choices, carried from the marketing version:
//  1. No render-time state. Both glyphs are in the DOM; CSS picks one off
//     `:root[data-theme="light"]` (rules live per scope: `.leash-landing .theme-icon-*`
//     in marketing.css, `.console-shell .theme-icon-*` in shell.css). A React-state icon
//     would flash the wrong glyph on a hard load, because the anti-FOUC script sets
//     `data-theme` BEFORE React runs.
//  2. The mount effect RE-APPLIES the persisted value. The head script only runs on a
//     full document load; a client-side navigation into a route never re-runs it.
//
// CHANGED from the marketing version: the unmount cleanup that removed `data-theme` is
// GONE. It existed to drop light mode when leaving the (then only-themeable) marketing
// page for the dark-only console. The console now themes, so dropping the attribute on
// navigation would wrongly reset a light-mode user mid-session.
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
  }, []);

  // Light SETS the attribute, dark REMOVES it (rather than setting data-theme="dark"),
  // because the dark values live on the bare `:root`.
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
