// File: web/components/shell/CommandPalette.tsx
// STAGE G-2.1 — the ⌘K command palette, ported from console.html:1234-1278.
// A real keyboard listbox: ⌘K/Ctrl+K opens, type to filter, Up/Down wrap, Enter runs,
// Escape closes and returns focus to the trigger. The background is `inert` while open
// (the artifact's bgInert), so Tab stays trapped in the dialog.
//
// RECONCILED to the real app: the artifact's commands toggle in-page `data-view`s; here
// the "Go to" commands navigate to real Next routes. The artifact's agent-scoped "Action"
// commands (Cut leash · ops-agent, Edit daily cap, Add payee) are NOT ported yet — they
// need live fleet data and their target surfaces (cockpit/policies) land in G-2.2/G-2.5.
// Porting dead action rows now would be a control that goes nowhere; they arrive with the
// surfaces that can honour them.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useAgentId } from '@/lib/use-agent-id';

type Command = { g: string; t: string; ic: string; href: string };

export default function CommandPalette() {
  const router = useRouter();
  const { agentId } = useAgentId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go: Command[] = [
      { g: 'Go to', t: 'Fleet', ic: '●', href: '/app' },
      { g: 'Go to', t: 'Inbox', ic: '✉', href: '/inbox' },
      { g: 'Go to', t: 'Digest', ic: '☰', href: '/digest' },
      ...(agentId ? [{ g: 'Go to', t: 'Cockpit', ic: '◎', href: `/agents/${agentId}` } as Command] : []),
      { g: 'Go to', t: 'Jobs', ic: '▦', href: '/jobs' },
      { g: 'Go to', t: 'Links', ic: '∞', href: '/links' },
      { g: 'Go to', t: 'Create agent', ic: '+', href: '/create' },
      ...(agentId ? [{ g: 'Go to', t: 'Audit', ic: '◷', href: `/agents/${agentId}/audit` } as Command] : []),
      { g: 'Go to', t: 'Alerts', ic: '◔', href: '/settings/alerts' },
    ];
    return go;
  }, [agentId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.t.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  // focus trap — inert the shell chrome while the dialog is open (the artifact's bgInert).
  // The overlay is PORTALED to document.body (below), so it sits OUTSIDE the inert subtree:
  // inert-ing `.console-main` (which contains this component's trigger) would otherwise trap
  // the palette's own input and focus would fall through to <body>.
  useEffect(() => {
    const aside = document.querySelector<HTMLElement>('.console-shell aside');
    const main = document.querySelector<HTMLElement>('.console-shell .console-main');
    if (aside) aside.inert = open;
    if (main) main.inert = open;
    if (open) inputRef.current?.focus();
    return () => {
      if (aside) aside.inert = false;
      if (main) main.inert = false;
    };
  }, [open]);

  const close = useCallback(() => {
    // Clear inert BEFORE returning focus: `focus()` on an element inside an inert subtree
    // is a browser no-op, and at this instant the [open] effect's cleanup hasn't run yet,
    // so `.console-main` (which holds the trigger) is still inert. Clearing it here first
    // lands focus back on the trigger; the effect cleanup then re-clears idempotently.
    const main = document.querySelector<HTMLElement>('.console-shell .console-main');
    const aside = document.querySelector<HTMLElement>('.console-shell aside');
    if (main) main.inert = false;
    if (aside) aside.inert = false;
    triggerRef.current?.focus();
    setOpen(false);
  }, []);

  const run = useCallback(
    (c: Command | undefined) => {
      if (!c) return;
      setOpen(false);
      router.push(c.href);
    },
    [router],
  );

  // ⌘K/Ctrl+K toggles from anywhere; the rest only while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuery('');
        setSel(0);
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => (filtered.length ? (s + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (filtered.length ? (s - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(filtered[sel]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, sel, close, run]);

  // keep the selection in range as the filter narrows
  useEffect(() => {
    if (sel >= filtered.length) setSel(0);
  }, [filtered.length, sel]);

  let lastGroup = '';

  return (
    <>
      <button
        type="button"
        className="kbd"
        ref={triggerRef}
        onClick={() => {
          setQuery('');
          setSel(0);
          setOpen(true);
        }}
        aria-haspopup="dialog"
      >
        ⌘K&nbsp; Command
      </button>

      {open &&
        createPortal(
          <>
            <div className="cmdk-scrim" onClick={close} aria-hidden="true" />
            <div className="cmdk-palette" role="dialog" aria-label="Command palette" aria-modal="true">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
              }}
              placeholder="Jump to a view…"
              aria-label="Command"
              role="combobox"
              aria-expanded="true"
              aria-controls="cmdk-opts"
              aria-activedescendant={filtered.length ? `cmdk-opt-${sel}` : undefined}
              autoComplete="off"
            />
            <div id="cmdk-opts" role="listbox" aria-label="Commands">
              {filtered.length === 0 ? (
                <div className="empty">No commands match “{query}”.</div>
              ) : (
                filtered.map((c, i) => {
                  const header = c.g !== lastGroup ? ((lastGroup = c.g), c.g) : null;
                  return (
                    <div key={c.href} style={{ display: 'contents' }}>
                      {header && <div className="grp">{header}</div>}
                      <button
                        type="button"
                        className="opt"
                        id={`cmdk-opt-${i}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={i === sel}
                        onMouseMove={() => setSel(i)}
                        onClick={() => run(c)}
                      >
                        <span className="ic" aria-hidden="true">
                          {c.ic}
                        </span>
                        <span>{c.t}</span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          </>,
          document.body,
        )}
    </>
  );
}
