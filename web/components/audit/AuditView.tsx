// File: web/components/audit/AuditView.tsx
// Audit trail: batch list (seq range, Merkle root, storage tx, verify link) + owner-client
// decrypt-and-view. Unlock = re-derive the KEK (wallet signature or passphrase) against the
// stored blob, or import the downloaded backup file. ECIES decrypt and hash-chain verification
// all happen IN THE BROWSER — the privkey never leaves this device.
'use client';

import { useRef, useState } from 'react';
import type { Address, AuditBatch, TraceRecord } from '@/lib/types';
import { decryptBlob, parseBlob, kekSignMessage, type EncryptedBlob } from '@/lib/crypto/kek';
import { decryptAuditCiphertext } from '@/lib/crypto/audit-key';
import { parseJsonl, verifyBatch, type BatchChainResult, type ChainAnchors } from '@/lib/hash-chain';
import { config, STORAGE_EXPLORER_URL } from '@/lib/config';
import { Disclosure } from '@/components/ui/Disclosure';

function toHexStr(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function AuditView({
  batches,
  storedBlob,
  signMessage,
  ownerAddress,
}: {
  batches: AuditBatch[];
  /** serialized EncryptedBlob from the backend, if it returns one */
  storedBlob: string | null;
  signMessage: (message: string) => Promise<string>;
  /** Connected owner wallet — the KEK sign message is bound to it (security M-01). */
  ownerAddress: Address | null;
}) {
  const [privKey, setPrivKey] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [importedBlob, setImportedBlob] = useState<EncryptedBlob | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{
    batchId: string;
    records: TraceRecord[];
    chain: BatchChainResult;
  } | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  /** Tail hashes of batches verified this session — threads expectedPrev across batches. */
  const anchorsRef = useRef<ChainAnchors>(new Map());

  const blob: EncryptedBlob | null =
    importedBlob ?? (storedBlob ? safeParse(storedBlob) : null);

  function safeParse(s: string): EncryptedBlob | null {
    try {
      return parseBlob(s);
    } catch {
      return null;
    }
  }

  async function unlock() {
    if (!blob) return;
    setBusy(true);
    setUnlockError(null);
    try {
      let secret: string;
      if (blob.mode === 'signature') {
        if (!ownerAddress) {
          setUnlockError('Connect the wallet you created this agent with, then try again.');
          return;
        }
        secret = await signMessage(kekSignMessage(ownerAddress, config.chainId));
      } else {
        secret = passphrase;
      }
      const key = await decryptBlob(blob, secret);
      setPrivKey(toHexStr(key));
    } catch {
      setUnlockError(
        blob.mode === 'signature'
          ? 'That signature did not unlock the key. Make sure you are using the same wallet you created the agent with.'
          : 'Wrong passphrase. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(file: File) {
    setUnlockError(null);
    try {
      const j = JSON.parse(await file.text()) as { auditPrivKey?: string; encryptedBlob?: EncryptedBlob };
      if (j.auditPrivKey) {
        setPrivKey(j.auditPrivKey);
      } else if (j.encryptedBlob) {
        setImportedBlob(j.encryptedBlob);
      } else {
        setUnlockError('That file does not look like a LEASH audit key backup.');
      }
    } catch {
      setUnlockError('Could not read that file.');
    }
  }

  async function viewBatch(batch: AuditBatch) {
    if (!privKey) return;
    setViewError(null);
    setBusy(true);
    try {
      const res = await fetch(batch.ciphertextUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      const plaintext = decryptAuditCiphertext(privKey, ciphertext);
      const records = parseJsonl(new TextDecoder().decode(plaintext));
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
    <div style={{ display: 'grid', gap: '1.1rem' }}>
      {/* Unlock panel */}
      {!privKey ? (
        <section aria-label="Unlock audit key" className="card" style={{ padding: '1.1rem', display: 'grid', gap: '0.8rem' }}>
          <h2 style={{ fontSize: '1rem' }}>Unlock your audit key</h2>
          <p style={{ fontSize: '0.88rem', color: 'var(--color-ink-dim)' }}>
            Your audit trail is encrypted so only you can read it. Unlock the key here — it stays
            in your browser.
          </p>
          {blob ? (
            <div style={{ display: 'grid', gap: '0.6rem', justifyItems: 'start' }}>
              {blob.mode === 'passphrase' ? (
                <div style={{ display: 'grid', gap: '0.35rem', width: 'min(100%, 22rem)' }}>
                  <label htmlFor="unlock-pass" className="label" style={{ color: 'var(--color-ink)' }}>
                    Passphrase
                  </label>
                  <input
                    id="unlock-pass"
                    type="password"
                    className="field"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              ) : null}
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void unlock()} data-testid="unlock-btn">
                {busy
                  ? 'Unlocking…'
                  : blob.mode === 'signature'
                    ? 'Unlock with wallet signature'
                    : 'Unlock with passphrase'}
              </button>
            </div>
          ) : (
            <p style={{ fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
              No stored key found for this agent on the server.
            </p>
          )}
          <Disclosure label="Use my downloaded backup file instead">
            <label style={{ display: 'grid', gap: '0.4rem' }}>
              <span>Select the leash-audit-key-*.json file you saved at create time.</span>
              <input
                type="file"
                accept="application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importBackup(f);
                }}
              />
            </label>
          </Disclosure>
          {unlockError ? (
            <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem' }}>
              {unlockError}
            </p>
          ) : null}
        </section>
      ) : (
        <p className="pill pill-allow" style={{ justifySelf: 'start' }} data-testid="key-unlocked">
          Audit key unlocked (kept in this browser only)
        </p>
      )}

      {/* Batch list */}
      <section aria-label="Audit batches" className="card" style={{ overflow: 'hidden' }}>
        <h2 style={{ fontSize: '1rem', padding: '0.9rem 1.1rem', borderBottom: '1px solid var(--color-line-soft)' }}>
          Sealed batches
        </h2>
        {batches.length === 0 ? (
          <p style={{ padding: '1.1rem', color: 'var(--color-ink-faint)', fontSize: '0.9rem' }}>
            No audit batches yet. Once your agent acts, its records are sealed into encrypted
            batches on 0G Storage and listed here.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {batches.map((b) => (
              <li key={b.batchId} style={{ padding: '0.8rem 1.1rem', borderBottom: '1px solid var(--color-line-soft)', display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
                  title={privKey ? undefined : 'Unlock your audit key first'}
                >
                  Decrypt &amp; view
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {viewError ? (
        <div className="toast toast-err" role="alert">
          {viewError}
        </div>
      ) : null}

      {/* Decrypted records */}
      {viewing ? (
        <section aria-label="Decrypted records" className="card" style={{ padding: '1.1rem', display: 'grid', gap: '0.8rem' }}>
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '1rem' }}>Batch {viewing.batchId}</h2>
            {viewing.chain.ok ? (
              <span className="pill pill-allow" data-testid="chain-ok">
                {viewing.chain.anchored === 'genesis'
                  ? 'Chain verified from genesis'
                  : 'Chain verified (slice only)'}
                {' · '}
                {viewing.chain.count} records
              </span>
            ) : (
              <span className="pill pill-deny" data-testid="chain-broken">
                Chain broken at record {viewing.chain.brokenAtSeq} ({viewing.chain.reason})
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gap: '0.5rem', maxHeight: '30rem', overflowY: 'auto' }}>
            {viewing.records.map((r) => (
              <details key={r.seq} className="panel" style={{ padding: '0.55rem 0.8rem' }}>
                <summary style={{ cursor: 'pointer', display: 'flex', gap: '0.6rem', alignItems: 'baseline', fontSize: '0.85rem' }}>
                  <span className="badge">#{r.seq}</span>
                  <span className={`pill ${r.kind === 'block' || r.kind === 'revoke' || r.kind === 'error' ? 'pill-deny' : r.kind === 'consent' ? 'pill-accent' : 'pill-idle'}`}>{r.kind}</span>
                  <span style={{ color: 'var(--color-ink-dim)' }}>{new Date(r.ts).toLocaleString()}</span>
                </summary>
                <pre className="code" style={{ marginTop: '0.5rem', overflow: 'auto' }}>{JSON.stringify(r, null, 2)}</pre>
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
