// File: web/components/settings/OwnerAuditSection.tsx
// Owner-stream audit surface (spec §3d, FE parity §7): sealed daily-loop batches with Merkle
// root + 0G storage-tx links, the server-verified chain pill from GET /api/owner/records, and
// in-browser decrypt via the downloaded owner-stream key backup — the same discipline as the
// per-agent AuditView (kek unlock, ECIES decrypt, hash-chain verify, all client-side).
'use client';

import { useRef, useState } from 'react';
import type { OwnerAuditBatch, OwnerRecord } from '@/lib/types';
import { decryptBlob, kekSignMessage, type EncryptedBlob } from '@/lib/crypto/kek';
import { decryptAuditCiphertext } from '@/lib/crypto/audit-key';
import { parseJsonl, verifyBatch, type BatchChainResult, type ChainAnchors } from '@/lib/hash-chain';
import { config, STORAGE_EXPLORER_URL } from '@/lib/config';
import { Disclosure } from '@/components/ui/Disclosure';

function toHexStr(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function OwnerAuditSection({
  batches,
  chainVerified,
  signMessage,
  ownerAddress,
}: {
  batches: OwnerAuditBatch[];
  /** Server-side incremental verify verdict from GET /api/owner/records. */
  chainVerified: boolean | undefined;
  signMessage: (message: string) => Promise<string>;
  ownerAddress: string | null;
}) {
  const [privKey, setPrivKey] = useState<string | null>(null);
  const [importedBlob, setImportedBlob] = useState<EncryptedBlob | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{
    batchId: string;
    records: OwnerRecord[];
    chain: BatchChainResult;
  } | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const anchorsRef = useRef<ChainAnchors>(new Map());

  async function importBackup(file: File) {
    setUnlockError(null);
    try {
      const j = JSON.parse(await file.text()) as { encryptedBlob?: EncryptedBlob };
      if (j.encryptedBlob) setImportedBlob(j.encryptedBlob);
      else setUnlockError('That file does not look like a LEASH owner-stream key backup.');
    } catch {
      setUnlockError('Could not read that file.');
    }
  }

  async function unlock() {
    if (!importedBlob) return;
    setBusy(true);
    setUnlockError(null);
    try {
      let secret: string;
      if (importedBlob.mode === 'signature') {
        if (!ownerAddress) {
          setUnlockError('Connect the wallet you set this key up with, then try again.');
          return;
        }
        secret = await signMessage(kekSignMessage(ownerAddress, config.chainId));
      } else {
        secret = passphrase;
      }
      setPrivKey(toHexStr(await decryptBlob(importedBlob, secret)));
    } catch {
      setUnlockError(
        importedBlob.mode === 'signature'
          ? 'That signature did not unlock the key. Use the same wallet you set the key up with.'
          : 'Wrong passphrase. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function viewBatch(batch: OwnerAuditBatch) {
    if (!privKey) return;
    setViewError(null);
    setBusy(true);
    try {
      const res = await fetch(batch.ciphertextUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const plaintext = decryptAuditCiphertext(privKey, new Uint8Array(await res.arrayBuffer()));
      const records = parseJsonl<OwnerRecord>(new TextDecoder().decode(plaintext));
      setViewing({
        batchId: batch.batchId,
        records,
        chain: verifyBatch(records, batch.seqFrom, anchorsRef.current),
      });
    } catch {
      setViewError('Could not decrypt this batch. Check that you unlocked the right key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Daily-loop audit trail" className="card" style={{ overflow: 'hidden' }} data-testid="owner-audit-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.9rem 1.1rem', borderBottom: '1px solid var(--color-line-soft)', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Daily-loop audit trail</h2>
        {chainVerified !== undefined ? (
          chainVerified ? (
            <span className="pill pill-allow" data-testid="owner-chain-verified">record chain verified</span>
          ) : (
            <span className="pill pill-deny" data-testid="owner-chain-broken">record chain check FAILED</span>
          )
        ) : null}
      </div>

      <div style={{ padding: '0.9rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
          Every alert, decision, and digest is chained and sealed to 0G Storage, encrypted to
          your daily-loop key. Anyone can verify the seals; only you can read the contents.
        </p>

        {batches.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--color-ink-faint)', fontSize: '0.9rem' }} data-testid="owner-audit-empty">
            No sealed batches yet. Once your daily loop has activity (and your key is set), its
            records are sealed to 0G Storage and listed here.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {batches.map((b) => (
              <li key={b.batchId} style={{ padding: '0.7rem 0', borderTop: '1px solid var(--color-line-soft)', display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="badge">records {b.seqFrom}–{b.seqTo}</span>
                <span className="code" title="Merkle root" style={{ fontSize: '0.74rem' }}>
                  root {b.merkleRoot.slice(0, 10)}…
                </span>
                <a className="link-tx" href={`${STORAGE_EXPLORER_URL}/tx/${b.storageTx}`} target="_blank" rel="noreferrer">
                  verify on 0G
                </a>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!privKey || busy}
                  onClick={() => void viewBatch(b)}
                  title={privKey ? undefined : 'Unlock your key backup first'}
                >
                  Decrypt &amp; view
                </button>
              </li>
            ))}
          </ul>
        )}

        {!privKey ? (
          <Disclosure label="Decrypt in this browser with my key backup">
            <div style={{ display: 'grid', gap: '0.55rem', justifyItems: 'start' }}>
              <label style={{ display: 'grid', gap: '0.4rem' }}>
                <span>Select the leash-owner-stream-key.json file you saved at setup.</span>
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importBackup(f);
                  }}
                />
              </label>
              {importedBlob?.mode === 'passphrase' ? (
                <label style={{ display: 'grid', gap: '0.3rem', width: 'min(100%, 22rem)' }}>
                  <span className="label" style={{ color: 'var(--color-ink)' }}>Passphrase</span>
                  <input
                    type="password"
                    className="field"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="current-password"
                  />
                </label>
              ) : null}
              {importedBlob ? (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void unlock()}>
                  {busy ? 'Unlocking…' : importedBlob.mode === 'signature' ? 'Unlock with wallet signature' : 'Unlock with passphrase'}
                </button>
              ) : null}
              {unlockError ? (
                <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
                  {unlockError}
                </p>
              ) : null}
            </div>
          </Disclosure>
        ) : (
          <p className="pill pill-allow" style={{ justifySelf: 'start' }}>
            Key unlocked (kept in this browser only)
          </p>
        )}

        {viewError ? (
          <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
            {viewError}
          </p>
        ) : null}

        {viewing ? (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: '0.95rem', margin: 0 }}>Batch {viewing.batchId}</h3>
              {viewing.chain.ok ? (
                <span className="pill pill-allow">
                  {viewing.chain.anchored === 'genesis' ? 'Chain verified from genesis' : 'Chain verified (slice only)'}
                  {' · '}
                  {viewing.chain.count} records
                </span>
              ) : (
                <span className="pill pill-deny">
                  Chain broken at record {viewing.chain.brokenAtSeq} ({viewing.chain.reason})
                </span>
              )}
            </div>
            <div style={{ display: 'grid', gap: '0.5rem', maxHeight: '24rem', overflowY: 'auto' }}>
              {viewing.records.map((r) => (
                <details key={r.seq} className="panel" style={{ padding: '0.55rem 0.8rem' }}>
                  <summary style={{ cursor: 'pointer', display: 'flex', gap: '0.6rem', alignItems: 'baseline', fontSize: '0.85rem' }}>
                    <span className="badge">#{r.seq}</span>
                    <span className={`pill ${r.kind === 'alert' ? 'pill-accent' : 'pill-idle'}`}>{r.kind}</span>
                    <span style={{ color: 'var(--color-ink-dim)' }}>{new Date(r.ts).toLocaleString()}</span>
                  </summary>
                  <pre className="code" style={{ marginTop: '0.5rem', overflow: 'auto' }}>{JSON.stringify(r, null, 2)}</pre>
                </details>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
