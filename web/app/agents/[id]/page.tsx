// File: web/app/agents/[id]/page.tsx
// Cockpit: live SSE stream, approvals, policy, status, and the always-visible revoke.
'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Address, Hex } from 'viem';
import { makeApi } from '@/lib/api';
import { config } from '@/lib/config';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { connectSse } from '@/lib/sse';
import type { AgentDetail, GatewayRule, StreamEvent } from '@/lib/types';
import { weiToOg } from '@/lib/format';
import {
  applyAllowlistOnchain,
  applyPolicyOnchain,
  applyWithdrawOnchain,
  proposePolicyOnchain,
  readAccountBalance,
  readGuardian,
  readPendingEtas,
  rearmOnchain,
  revokeOnchain,
  sendNativeOnchain,
  setGuardianOnchain,
  tightenPolicyOnchain,
  type PendingEtas,
  waitForTx,
} from '@/lib/chain';
import { StatusBar } from '@/components/cockpit/StatusBar';
import { FundPanel } from '@/components/cockpit/FundPanel';
import { StreamFeed, type FeedItem } from '@/components/cockpit/StreamFeed';
import { ApprovalCard } from '@/components/cockpit/ApprovalCard';
import { PolicyPanel } from '@/components/cockpit/PolicyPanel';
import { RevokeButton } from '@/components/cockpit/RevokeButton';
import { AgentControls } from '@/components/cockpit/AgentControls';
import { GuardianPanel } from '@/components/cockpit/GuardianPanel';
import { RulesEditor } from '@/components/cockpit/RulesEditor';

type Approval = Extract<StreamEvent, { type: 'approval' }>;
type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export default function CockpitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const wallet = useOwnerWallet();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [pending, setPending] = useState<PendingEtas>({ policy: 0, allowlist: 0, withdraw: 0 });
  const [chainVerified, setChainVerified] = useState<boolean | undefined>(undefined);
  const [guardian, setGuardian] = useState<Address | undefined>(undefined);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const d = await api.getAgent(id);
      setDetail(d);
      setLoadError(null);
      // Server-verified pill (Gate-② parity): LEASH's own integrity check of the trace
      // chain, surfaced honestly next to the status. Tolerate a failed fetch silently —
      // the pill simply stays absent.
      try {
        setChainVerified((await api.getTraces(id)).chainVerified);
      } catch {
        /* pill stays absent */
      }
      // Timelock queues + guardian live on-chain, not in the backend. Skipped in E2E (no
      // live chain); a transient RPC failure keeps the last known values.
      if (!config.e2eMode) {
        try {
          setPending(await readPendingEtas(d.addresses.account));
        } catch {
          /* keep last known pending etas */
        }
        try {
          setGuardian(await readGuardian(d.addresses.account));
        } catch {
          /* keep last known guardian */
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your agent.');
    }
  }, [api, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE with auto-reconnect.
  useEffect(() => {
    if (!wallet.authenticated) return;
    const handle = connectSse({
      url: api.streamUrl(id),
      getToken: wallet.getToken,
      onStatusChange: setConnection,
      onEvent: (data) => {
        const ev = data as StreamEvent;
        const nid = `ev-${seqRef.current++}`;
        if (ev.type === 'reasoning') {
          setItems((prev) => [...prev.slice(-199), { kind: 'reasoning', text: ev.text, id: nid }]);
        } else if (ev.type === 'trace') {
          setItems((prev) => [...prev.slice(-199), { kind: 'trace', event: ev, id: nid }]);
        } else if (ev.type === 'approval') {
          setApprovals((prev) =>
            prev.some((a) => a.approvalId === ev.approvalId) ? prev : [...prev, ev],
          );
        } else if (ev.type === 'status') {
          setDetail((prev) => (prev ? { ...prev, status: ev.status } : prev));
        } else if (ev.type === 'delegation') {
          setItems((prev) => [...prev.slice(-199), { kind: 'delegation', event: ev, id: nid }]);
        }
      },
    });
    return () => handle.close();
  }, [api, id, wallet.authenticated, wallet.getToken]);

  const decide = useCallback(
    async (approvalId: string, decision: 'approve' | 'deny', reason?: string) => {
      await api.decideApproval(approvalId, { decision, reason });
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
    },
    [api],
  );

  const revokeGuardian = useCallback(async () => {
    await api.revoke(id);
    await refresh();
  }, [api, id, refresh]);

  const revokeFallback = useCallback(async () => {
    if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
    const provider = await wallet.getProvider();
    const tx = await revokeOnchain(provider, wallet.address as Address, detail.addresses.account);
    await refresh();
    return tx;
  }, [detail, wallet, refresh]);

  const submitPolicy = useCallback(
    async (p: { perTransferCapWei: string; windowCapWei: string }, loosening: boolean) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      const policy = {
        perTransferCap: BigInt(p.perTransferCapWei),
        windowCap: BigInt(p.windowCapWei),
        windowSeconds: detail.policy.windowSeconds,
        expiresAt: BigInt(detail.policy.expiresAt),
      };
      const fn = loosening ? proposePolicyOnchain : tightenPolicyOnchain;
      await fn(provider, wallet.address as Address, detail.addresses.account, policy);
      await refresh();
    },
    [detail, wallet, refresh],
  );

  const applyPending = useCallback(
    async (kind: keyof PendingEtas) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      const fn = { policy: applyPolicyOnchain, allowlist: applyAllowlistOnchain, withdraw: applyWithdrawOnchain }[kind];
      await fn(provider, wallet.address as Address, detail.addresses.account);
      setPending((prev) => ({ ...prev, [kind]: 0 }));
      await refresh();
    },
    [detail, wallet, refresh],
  );

  const rearm = useCallback(async () => {
    if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
    const provider = await wallet.getProvider();
    const tx = await rearmOnchain(provider, wallet.address as Address, detail.addresses.account);
    await refresh();
    return tx;
  }, [detail, wallet, refresh]);

  const setGuardianTx = useCallback(
    async (newGuardian: Address) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      const tx = await setGuardianOnchain(provider, wallet.address as Address, detail.addresses.account, newGuardian);
      // Security-critical display (gate M-03): never show the change before it
      // is mined — wait for the receipt, then read the truth back from chain.
      if (!config.e2eMode) {
        await waitForTx(tx as Hex);
        setGuardian(await readGuardian(detail.addresses.account));
      } else {
        setGuardian(newGuardian);
      }
      return tx;
    },
    [detail, wallet],
  );

  const saveRules = useCallback(
    async (rules: GatewayRule[]) => {
      await api.patchRules(id, rules);
      await refresh();
    },
    [api, id, refresh],
  );

  const fundAgent = useCallback(
    async (valueWei: bigint) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      return sendNativeOnchain(provider, wallet.address as Address, detail.addresses.account, valueWei);
    },
    [detail, wallet],
  );

  const lowBalance =
    detail !== null && BigInt(detail.accountBalance) < BigInt(detail.policy.windowCapWei);

  if (!wallet.ready) {
    return <PageShell title="Cockpit"><p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading…</p></PageShell>;
  }
  if (!wallet.authenticated) {
    return (
      <PageShell title="Cockpit">
        <div className="card" style={{ padding: '1.4rem', display: 'grid', gap: '0.8rem', justifyItems: 'start' }}>
          <p>Connect your wallet to open your agent&apos;s cockpit.</p>
          <button type="button" className="btn btn-primary" onClick={wallet.login}>
            Connect wallet
          </button>
        </div>
      </PageShell>
    );
  }
  if (loadError && !detail) {
    return (
      <PageShell title="Cockpit">
        <div className="toast toast-err" role="alert">
          <p>We could not load this agent ({loadError}).</p>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Cockpit"
      aside={
        <Link href={`/agents/${id}/audit`} className="nav-link">
          Audit trail →
        </Link>
      }
    >
      {detail ? (
        <>
          <StatusBar detail={detail} chainVerified={chainVerified} />
          <AgentControls
            status={detail.status}
            onStart={async () => {
              await api.start(id);
              await refresh();
            }}
            onStop={async () => {
              await api.stop(id);
              await refresh();
            }}
            onRotate={async () => (await api.rotate(id)).gatewayToken}
          />
          {lowBalance ? (
            <section
              aria-label="Low balance warning"
              className="panel"
              data-testid="low-balance-warning"
              style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.7rem', borderColor: 'rgba(255,184,76,0.4)' }}
            >
              <p style={{ margin: 0, fontSize: '0.9rem' }}>
                <strong>Running low.</strong> The agent holds {weiToOg(detail.accountBalance)} 0G —
                less than one full budget window ({weiToOg(detail.policy.windowCapWei)} 0G). Top it
                up so payments do not start failing.
              </p>
              <FundPanel
                accountAddr={detail.addresses.account}
                defaultAmountOg={weiToOg(2n * BigInt(detail.policy.windowCapWei))}
                onSend={wallet.address ? fundAgent : undefined}
                getBalance={
                  config.e2eMode ? undefined : () => readAccountBalance(detail.addresses.account)
                }
                initialBalanceWei={detail.accountBalance}
                onFunded={() => void refresh()}
                idPrefix="cockpit-fund"
              />
            </section>
          ) : null}
        </>
      ) : (
        <p role="status" style={{ color: 'var(--color-ink-dim)' }}>Loading status…</p>
      )}

      {approvals.map((a) => (
        <ApprovalCard key={a.approvalId} approval={a} onDecide={(d, r) => decide(a.approvalId, d, r)} />
      ))}

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
        <StreamFeed items={items} connection={connection} />
        <div style={{ display: 'grid', gap: '1rem' }}>
          {detail ? (
            <PolicyPanel detail={detail} onSubmitPolicy={submitPolicy} pending={pending} onApply={applyPending} />
          ) : null}
          {detail ? <GuardianPanel guardian={guardian} leashGuardian={detail.leashGuardianAddr} onSetGuardian={setGuardianTx} /> : null}
          {detail ? (
            <RulesEditor rules={detail.agent?.gatewayRules ?? []} onSave={saveRules} />
          ) : null}
          <RevokeButton
            revoked={detail?.status === 'revoked'}
            onRevoke={revokeGuardian}
            onRevokeOnchain={revokeFallback}
            onRearm={rearm}
          />
        </div>
      </div>
    </PageShell>
  );
}

function PageShell({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="wrap" style={{ paddingBlock: 'clamp(1.5rem, 4vw, 3rem)', display: 'grid', gap: '1.1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1 style={{ fontSize: 'var(--text-h1)' }}>{title}</h1>
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
    </div>
  );
}
