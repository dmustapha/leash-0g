// File: web/components/settings/StreamKeySetup.tsx
// Owner-stream key setup (S10, spec §3c): generate an ECIES keypair IN THE BROWSER exactly like
// the agent audit-key flow (same crypto helpers, same C-6 rule — the backup holds the ENCRYPTED
// blob, never the plaintext privkey), FORCE the backup download, and only after the owner
// confirms the download is the pubkey submitted (PATCH streamPubkey, set-once).
'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { config } from '@/lib/config';
import { buildOwnerStreamBackup, generateAuditKeypair, hexToBytes } from '@/lib/crypto/audit-key';
import {
  encryptWithPassphrase,
  encryptWithSignature,
  kekSignMessage,
  probeDeterministicSignature,
  type EncryptedBlob,
} from '@/lib/crypto/kek';
import { Disclosure } from '@/components/ui/Disclosure';
import { Field } from '@/components/ui/Field';

function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type Step = 'intro' | 'passphrase' | 'backup' | 'submitting' | 'done';

export function StreamKeySetup({
  keySet,
  ownerAddress,
  signMessage,
  onSubmit,
}: {
  /** streamPubkeySet from GET /api/owner/settings. */
  keySet: boolean;
  ownerAddress: string | null;
  signMessage: (message: string) => Promise<string>;
  /** PATCH {streamPubkey} upstream (409 = already set). */
  onSubmit: (pubKeyHex: string) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>('intro');
  const [keypair, setKeypair] = useState<{ privKeyHex: string; pubKeyHex: string } | null>(null);
  const [blob, setBlob] = useState<EncryptedBlob | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (keySet || step === 'done') {
    return (
      <section aria-label="Owner-stream key" className="card" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Your daily-loop key</h2>
          <span style={{ flex: 1 }} />
          <span className="pill pill-allow" data-testid="stream-key-set-pill">set</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
          Your alerts, decisions, and digests are sealed to 0G Storage encrypted so only you can
          read them — with the key you backed up. Changing (rotating) this key is not available
          yet; keep the backup file safe.
        </p>
      </section>
    );
  }

  async function generate(pass?: string) {
    setError(null);
    try {
      const kp = keypair ?? generateAuditKeypair();
      setKeypair(kp);
      let wrapped: EncryptedBlob;
      if (pass !== undefined) {
        wrapped = await encryptWithPassphrase(hexToBytes(kp.privKeyHex), pass);
      } else {
        if (!ownerAddress) throw new Error('Connect your wallet first.');
        const message = kekSignMessage(ownerAddress, config.chainId);
        const sig = await probeDeterministicSignature(signMessage, message);
        if (!sig) {
          setStep('passphrase');
          return;
        }
        wrapped = await encryptWithSignature(hexToBytes(kp.privKeyHex), sig);
      }
      setBlob(wrapped);
      setStep('backup');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate your key. Try again.');
    }
  }

  async function submit() {
    if (!keypair || !confirmed) return;
    setStep('submitting');
    setError(null);
    try {
      await onSubmit(keypair.pubKeyHex);
      setStep('done');
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'A daily-loop key is already set for this wallet — refresh the page.'
          : e instanceof Error
            ? e.message
            : 'Could not save your key. Try again.',
      );
      setStep('backup');
    }
  }

  return (
    <section
      aria-label="Owner-stream key setup"
      className="raised"
      data-testid="stream-key-setup"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.7rem', borderColor: 'rgba(198,242,77,0.45)' }}
    >
      <h2 style={{ fontSize: '1rem', margin: 0 }}>One-time setup: your daily-loop key</h2>
      <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--color-ink-dim)' }}>
        Every alert, decision, and digest gets sealed to 0G Storage encrypted so ONLY you can
        read it. Your browser makes the key; LEASH keeps just the public half. Alerts already
        work without it — the sealed history starts flowing to 0G once the key exists.
      </p>

      {step === 'intro' ? (
        <button
          type="button"
          className="btn btn-primary"
          style={{ justifySelf: 'start' }}
          data-testid="stream-key-generate-btn"
          onClick={() => void generate()}
        >
          Generate my key
        </button>
      ) : null}

      {step === 'passphrase' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (passphrase.length < 8) {
              setError('Choose a passphrase of at least 8 characters.');
              return;
            }
            void generate(passphrase);
          }}
          style={{ display: 'grid', gap: '0.7rem' }}
        >
          <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--color-ink-dim)' }}>
            Your wallet signs differently each time, so we cannot use it to lock this key. Pick a
            passphrase instead — you will need it to read your daily-loop history later.
          </p>
          <Field
            id="stream-key-passphrase"
            label="Passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            error={error}
            autoComplete="new-password"
          />
          <button type="submit" className="btn btn-primary" style={{ justifySelf: 'start' }}>
            Lock my key
          </button>
        </form>
      ) : null}

      {(step === 'backup' || step === 'submitting') && keypair && blob ? (
        <div style={{ display: 'grid', gap: '0.7rem' }} data-testid="stream-key-backup-step">
          <p style={{ margin: 0, fontSize: '0.88rem' }}>
            <strong>Save your backup first.</strong> LEASH stores only the public half — this
            file is the ONLY copy of your key. Lose it and your sealed history stays locked
            forever.
          </p>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              data-testid="stream-key-download-btn"
              onClick={() => {
                download(
                  'leash-owner-stream-key.json',
                  buildOwnerStreamBackup({
                    ownerAddr: ownerAddress ?? '',
                    pubKeyHex: keypair.pubKeyHex,
                    blob,
                  }),
                );
                setDownloaded(true);
              }}
            >
              Download key backup
            </button>
          </div>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.86rem' }}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!downloaded}
              data-testid="stream-key-confirm-checkbox"
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              I downloaded the backup file and put it somewhere safe.
              {!downloaded ? (
                <span style={{ display: 'block', color: 'var(--color-ink-faint)', fontSize: '0.78rem' }}>
                  Download it first — this box unlocks after.
                </span>
              ) : null}
            </span>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            style={{ justifySelf: 'start' }}
            disabled={!confirmed || step === 'submitting'}
            data-testid="stream-key-submit-btn"
            onClick={() => void submit()}
          >
            {step === 'submitting' ? 'Saving…' : 'Turn on my sealed history'}
          </button>
        </div>
      ) : null}

      {error && step !== 'passphrase' ? (
        <p role="alert" style={{ color: 'var(--color-deny)', fontSize: '0.85rem', margin: 0 }}>
          {error}
        </p>
      ) : null}

      <Disclosure label="What exactly happens here?">
        Your browser generates a secp256k1 keypair. The private key is locked with your wallet
        signature (or a passphrase) and offered only as a download — it never reaches LEASH.
        The public key is registered once; every daily-loop record is then ECIES-encrypted to it
        before being sealed to 0G Storage. Rotation is not available yet.
      </Disclosure>
    </section>
  );
}
