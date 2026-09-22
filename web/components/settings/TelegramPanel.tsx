// File: web/components/settings/TelegramPanel.tsx
// Telegram link / unlink / test ping (spec §3c). The deep-link is shown as a clickable link
// with a copy button (no QR dependency in this app — the URL itself is the QR-less path).
// 503 from any telegram route = the bot is not configured on this deployment; say so honestly.
'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { CopyButton } from '@/components/ui/CopyButton';
import { Disclosure } from '@/components/ui/Disclosure';

export function TelegramPanel({
  linked,
  linkedAt,
  onLink,
  onUnlink,
  onPing,
  onChanged,
}: {
  linked: boolean;
  linkedAt: string | null;
  onLink: () => Promise<{ url: string; expiresAt: string }>;
  onUnlink: () => Promise<void>;
  onPing: () => Promise<void>;
  /** Called after link/unlink so the page can refetch settings. */
  onChanged: () => Promise<void>;
}) {
  const [deepLink, setDeepLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<'link' | 'unlink' | 'ping' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function friendly(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 503) return 'Telegram is not set up on this deployment yet — in-app alerts still work fully.';
      if (e.status === 409) return 'Telegram is not linked yet — link it first.';
    }
    return e instanceof Error ? e.message : 'That did not go through. Try again.';
  }

  async function run(kind: 'link' | 'unlink' | 'ping', fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Telegram" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Telegram</h2>
        <span style={{ flex: 1 }} />
        {linked ? (
          <span className="pill pill-allow" data-testid="telegram-linked-pill">
            linked{linkedAt ? ` · ${new Date(linkedAt).toLocaleDateString()}` : ''}
          </span>
        ) : (
          <span className="pill pill-idle" data-testid="telegram-unlinked-pill">not linked</span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        Get alerts on your phone and approve or deny right from the message. Telegram only ever
        carries short summaries — never your agents&apos; reasoning or full records.
      </p>

      {!linked ? (
        <div style={{ display: 'grid', gap: '0.6rem', justifyItems: 'start' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            data-testid="telegram-link-btn"
            onClick={() =>
              void run('link', async () => {
                setDeepLink(await onLink());
              })
            }
          >
            {busy === 'link' ? 'Getting your link…' : 'Link Telegram'}
          </button>
          {deepLink ? (
            <div className="panel" style={{ padding: '0.8rem', display: 'grid', gap: '0.5rem' }} data-testid="telegram-deep-link">
              <p style={{ margin: 0, fontSize: '0.86rem' }}>
                Open this link on the device where you use Telegram, then press <strong>Start</strong>:
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <a
                  href={deepLink.url}
                  target="_blank"
                  rel="noreferrer"
                  className="code"
                  style={{ color: 'var(--color-accent)', wordBreak: 'break-all' }}
                >
                  {deepLink.url}
                </a>
                <CopyButton text={deepLink.url} />
              </div>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-ink-faint)' }}>
                One-time link, valid until {new Date(deepLink.expiresAt).toLocaleTimeString()}.
              </p>
              <Disclosure label="No Start button? (used this bot before)">
                Telegram only shows the <strong>Start</strong> button the first time you open a
                bot. If you&apos;ve linked before, open <span className="code">@leashapp_bot</span>{' '}
                and send this message instead:
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                  <span className="code" style={{ wordBreak: 'break-all' }}>
                    /start {new URL(deepLink.url).searchParams.get('start') ?? ''}
                  </span>
                  <CopyButton text={`/start ${new URL(deepLink.url).searchParams.get('start') ?? ''}`} />
                </div>
              </Disclosure>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="telegram-refresh-btn"
                onClick={() => void onChanged()}
              >
                I pressed Start — refresh status
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            data-testid="telegram-ping-btn"
            onClick={() =>
              void run('ping', async () => {
                await onPing();
                setNotice('Test message sent — check your Telegram.');
              })
            }
          >
            {busy === 'ping' ? 'Sending…' : 'Send test ping'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            data-testid="telegram-unlink-btn"
            onClick={() =>
              void run('unlink', async () => {
                await onUnlink();
                setDeepLink(null);
                await onChanged();
              })
            }
          >
            {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
      )}

      {notice ? (
        <p role="status" style={{ color: 'var(--color-allow)', fontSize: '0.85rem', margin: 0 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }} data-testid="telegram-error">
          {error}
        </p>
      ) : null}

      <Disclosure label="What can Telegram actually do?">
        Only receive summaries and approve or deny a pending request — the same decision you
        could make here. It can never change limits, create or revoke agents, or move money.
        Loosening a limit always needs your wallet, with its safety delay.
      </Disclosure>
    </section>
  );
}
