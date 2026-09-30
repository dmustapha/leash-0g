// File: web/components/cockpit/NetworksPanel.tsx
// SE-7 (spec §7.C): the agent's multichain presence — home network + onboarded networks,
// the SAME account address on every one (that is the product point). Onboarding replays the
// account's deployment tuple byte-exactly on the new chain (CREATE2), so the address is
// verified identical, not just displayed twice. Refusals are typed and rendered in plain
// language (lib/networks.ts) — never a raw code. NOTE: "network" = blockchain, not an agent
// chain (delegation graph) — those live in ChainView.
'use client';

import { useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { shortAddr } from '@/lib/format';
import { chainName, networkTxUrl, plainOnboardRefusal } from '@/lib/networks';
import type { AgentNetworkRow, AgentNetworksView, NetworkChain, OnboardNetworkResult } from '@/lib/types';
import { CopyButton } from '@/components/ui/CopyButton';
import { Disclosure } from '@/components/ui/Disclosure';

export function NetworksPanel({
  view,
  networks,
  onOnboard,
}: {
  /** GET /api/agents/:id/networks; null = still loading/unavailable. */
  view: AgentNetworksView | null;
  /** The registered blockchain network table (GET /api/networks). */
  networks: NetworkChain[];
  /** POST the onboard; ApiError.code carries the typed refusal reason on 409/503. */
  onOnboard: (chainId: number) => Promise<OnboardNetworkResult>;
}) {
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<OnboardNetworkResult | null>(null);

  // Networks the agent is not on yet — the only valid onboarding targets.
  const candidates = useMemo(() => {
    if (!view) return [];
    const present = new Set(view.chains.map((c) => c.chainId));
    return networks.filter((n) => !present.has(n.chainId));
  }, [view, networks]);

  async function onboard() {
    const chainId = Number(selected);
    if (!Number.isInteger(chainId)) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await onOnboard(chainId);
      setSuccess(result);
      setSelected('');
    } catch (e) {
      if (e instanceof ApiError) setError(plainOnboardRefusal(e.code));
      else setError(e instanceof Error ? e.message : 'Onboarding failed. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Networks"
      className="card"
      data-testid="networks-panel"
      style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Networks</h2>
        <span style={{ flex: 1 }} />
        {view ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <span className="badge" data-testid="networks-account-addr" title={view.accountAddr}>
              {shortAddr(view.accountAddr)}
            </span>
            <CopyButton text={view.accountAddr} label="Copy address" />
          </span>
        ) : (
          <span className="pill pill-idle">checking…</span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-ink-dim)' }}>
        One agent, one address, every network. Your agent&apos;s account keeps the exact same
        address on each chain it is onboarded to — anyone can pay it anywhere without asking
        which network it is on.
      </p>

      {view ? (
        <>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {view.chains.map((row) => (
              <NetworkRow key={row.chainId} row={row} networks={networks} />
            ))}
          </div>

          {view.onboardable ? (
            <div style={{ display: 'grid', gap: '0.6rem' }} data-testid="onboard-form">
              <h3 className="label" style={{ margin: 0 }}>Onboard to another network</h3>
              {candidates.length === 0 ? (
                <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
                  This agent is already on every network LEASH knows about.
                </p>
              ) : (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <label htmlFor="onboard-chain" className="label">Network</label>
                  <select
                    id="onboard-chain"
                    data-testid="onboard-chain-select"
                    value={selected}
                    disabled={busy}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">Choose a network…</option>
                    {candidates.map((n) => (
                      <option key={n.chainId} value={n.chainId}>{n.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    data-testid="onboard-confirm-btn"
                    disabled={busy || selected === ''}
                    onClick={() => void onboard()}
                  >
                    {busy ? 'Onboarding…' : 'Onboard'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p
              className="pill pill-idle"
              data-testid="not-onboardable"
              style={{ fontSize: '0.82rem', whiteSpace: 'normal' }}
            >
              This agent&apos;s account predates deterministic deployment, so its address cannot
              be reproduced on other networks. New agents are multichain-ready from day one.
            </p>
          )}

          {success ? (
            <div className="toast toast-ok" role="status" data-testid="onboard-success">
              <p style={{ margin: 0 }}>
                {success.alreadyOnboarded
                  ? `Already onboarded to ${chainName(success.chainId, networks)} — nothing to do.`
                  : `Onboarded to ${chainName(success.chainId, networks)} — same address, verified on-chain.`}
              </p>
              <TxLinks chainId={success.chainId} createTx={success.createTx} registerTx={success.registerTx} />
            </div>
          ) : null}
          {error ? (
            <p role="alert" data-testid="onboard-error" style={{ color: 'var(--color-deny)', fontSize: '0.84rem', margin: 0 }}>
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p role="status" style={{ margin: 0, fontSize: '0.86rem', color: 'var(--color-ink-dim)' }}>
          Loading networks…
        </p>
      )}

      <Disclosure label="How is the address kept identical?">
        The account is deployed with CREATE2: its address is derived only from its deployment
        recipe (the account tuple), never from chain history. Onboarding replays that recipe
        byte-exactly on the new network, and LEASH verifies the freshly deployed account landed
        on the very same address before registering it. If anything about the recipe no longer
        matches, onboarding refuses rather than risk a different address.
      </Disclosure>
    </section>
  );
}

function NetworkRow({ row, networks }: { row: AgentNetworkRow; networks: NetworkChain[] }) {
  return (
    <div
      className="panel"
      data-testid={`network-row-${row.chainId}`}
      style={{ padding: '0.6rem 0.75rem', display: 'grid', gap: '0.35rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.9rem' }}>{chainName(row.chainId, networks)}</strong>
        <span className="pill" style={{ fontSize: '0.7rem' }}>
          {row.role === 'home' ? 'home network' : 'onboarded'}
        </span>
        {row.adopted ? (
          <span className="pill" style={{ fontSize: '0.7rem' }} title="An account already existed at this address on this chain and was verified and adopted, not redeployed.">
            adopted
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span className="badge" title={row.accountAddr}>{shortAddr(row.accountAddr)}</span>
      </div>
      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-ink-dim)' }}>
        {row.role === 'home'
          ? 'Where this account was born — the source of its deployment recipe.'
          : 'Same CREATE2 address, byte-exact tuple replay — verified identical to the home account.'}
      </p>
      <TxLinks chainId={row.chainId} createTx={row.createTx} registerTx={row.registerTx} />
    </div>
  );
}

function TxLinks({ chainId, createTx, registerTx }: { chainId: number; createTx?: string; registerTx?: string }) {
  const links = [
    { label: 'deploy tx', hash: createTx },
    { label: 'register tx', hash: registerTx },
  ].filter((l): l is { label: string; hash: string } => typeof l.hash === 'string');
  if (links.length === 0) return null;
  return (
    <p style={{ margin: 0, display: 'flex', gap: '0.7rem', fontSize: '0.8rem' }}>
      {links.map(({ label, hash }) => {
        const url = networkTxUrl(chainId, hash);
        return url ? (
          <a key={label} className="link-tx" href={url} target="_blank" rel="noreferrer">
            {label} ↗
          </a>
        ) : (
          <span key={label} className="code" title={hash}>
            {label} {shortAddr(hash)}
          </span>
        );
      })}
    </p>
  );
}
