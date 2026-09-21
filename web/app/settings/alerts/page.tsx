// File: web/app/settings/alerts/page.tsx
// Alert settings (spec §3c): per-kind × channel prefs, digest hour + opt-out, Telegram
// link/unlink/ping, the guided owner-stream key setup (S10), and the owner-stream audit
// surface. Every input the daily loop needs lives here (parity rule, §7).
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { makeApi } from '@/lib/api';
import { useOwnerWallet } from '@/lib/owner-wallet';
import type { AlertPrefs, OwnerAuditBatch, OwnerSettingsView } from '@/lib/types';
import { AlertPrefsPanel } from '@/components/settings/AlertPrefs';
import { TelegramPanel } from '@/components/settings/TelegramPanel';
import { StreamKeySetup } from '@/components/settings/StreamKeySetup';
import { OwnerAuditSection } from '@/components/settings/OwnerAuditSection';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function AlertSettingsPage() {
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [settings, setSettings] = useState<OwnerSettingsView | null>(null);
  const [batches, setBatches] = useState<OwnerAuditBatch[]>([]);
  const [chainVerified, setChainVerified] = useState<boolean | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.getOwnerSettings());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your settings.');
    }
    // Audit surface is best-effort — the settings page must not die on it.
    try {
      setBatches(await api.getOwnerAudit());
    } catch {
      /* list stays empty */
    }
    try {
      setChainVerified((await api.getOwnerRecords()).chainVerified);
    } catch {
      /* pill stays absent */
    }
  }, [api]);

  useEffect(() => {
    if (wallet.authenticated) void refresh();
  }, [wallet.authenticated, refresh]);

  const patchPrefs = useCallback(
    async (next: AlertPrefs) => {
      await api.patchOwnerSettings({ alertPrefs: next });
      setSettings((prev) => (prev ? { ...prev, alertPrefs: next } : prev));
    },
    [api],
  );

  const patchDigest = useCallback(
    async (patch: { digestHourUtc?: number; digestOptout?: boolean }) => {
      setDigestError(null);
      try {
        await api.patchOwnerSettings(patch);
        setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      } catch (e) {
        setDigestError(e instanceof Error ? e.message : 'Could not save that.');
      }
    },
    [api],
  );

  const submitStreamKey = useCallback(
    async (pubKeyHex: string) => {
      await api.patchOwnerSettings({ streamPubkey: pubKeyHex });
      setSettings((prev) => (prev ? { ...prev, streamPubkeySet: true } : prev));
    },
    [api],
  );

  if (!wallet.ready) {
    return (
      <Shell>
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading…</p>
      </Shell>
    );
  }
  if (!wallet.authenticated) {
    return (
      <Shell>
        <div className="card" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <p>Connect your wallet to manage your alert settings.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      </Shell>
    );
  }
  if (loadError && !settings) {
    return (
      <Shell>
        <div className="toast toast-err" role="alert">
          <p>We could not load your settings ({loadError}).</p>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </Shell>
    );
  }
  if (!settings) {
    return (
      <Shell>
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading your settings…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <StreamKeySetup
        keySet={settings.streamPubkeySet}
        ownerAddress={wallet.address}
        signMessage={wallet.signMessage}
        onSubmit={submitStreamKey}
      />

      <AlertPrefsPanel prefs={settings.alertPrefs} onChange={patchPrefs} />

      <section aria-label="Daily digest schedule" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Daily digest</h2>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
          One message a day with what your agents did — only when there is something to tell,
          and only if Telegram is linked.
        </p>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: '0.25rem' }}>
            <span className="label">Send it at (UTC)</span>
            <select
              className="field"
              value={settings.digestHourUtc ?? 8}
              disabled={settings.digestOptout}
              data-testid="digest-hour-select"
              onChange={(e) => void patchDigest({ digestHourUtc: Number(e.target.value) })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'inline-flex', gap: '0.45rem', alignItems: 'center', fontSize: '0.88rem' }}>
            <input
              type="checkbox"
              checked={settings.digestOptout}
              data-testid="digest-optout-checkbox"
              onChange={(e) => void patchDigest({ digestOptout: e.target.checked })}
            />
            Do not send me a daily digest
          </label>
        </div>
        {digestError ? (
          <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
            {digestError}
          </p>
        ) : null}
      </section>

      <TelegramPanel
        linked={settings.telegramLinked}
        linkedAt={settings.telegramLinkedAt}
        onLink={() => api.telegramLink()}
        onUnlink={async () => {
          await api.telegramUnlink();
        }}
        onPing={async () => {
          await api.telegramPing();
        }}
        onChanged={refresh}
      />

      <OwnerAuditSection
        batches={batches}
        chainVerified={chainVerified}
        signMessage={wallet.signMessage}
        ownerAddress={wallet.address}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="wrap" style={{ paddingBlock: 'clamp(1.5rem, 4vw, 3rem)', display: 'grid', gap: '1.1rem', maxWidth: '860px' }}>
      <h1 style={{ fontSize: 'var(--text-h1)' }}>Alert settings</h1>
      {children}
    </div>
  );
}
