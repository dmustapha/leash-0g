// File: web/app/agents/[id]/page.tsx
// Cockpit: live SSE stream, approvals, policy, status, and the always-visible revoke.
'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Address, Hex } from 'viem';
import { makeApi } from '@/lib/api';
import { config } from '@/lib/config';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { connectSse } from '@/lib/sse';
import type {
  AgentDetail,
  AgentNetworksView,
  NetworkChain,
  CallRule,
  CapabilityEnvelopeView,
  CapabilityRuleAction,
  Chain,
  Delegation,
  GatewayRule,
  PresetKey,
  ResolvedPreset,
  StreamEvent,
} from '@/lib/types';
import { ChainView } from '@/components/cockpit/ChainView';
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
import { MigrateGuardianBanner } from '@/components/cockpit/MigrateGuardianBanner';
import { RulesEditor } from '@/components/cockpit/RulesEditor';
import { DirectBox } from '@/components/cockpit/DirectBox';
import { StatusChat } from '@/components/cockpit/StatusChat';
import { CapabilityGrant } from '@/components/cockpit/CapabilityGrant';
import { CapabilityDecisionCard } from '@/components/cockpit/CapabilityDecisionCard';
import { CapabilityEnvelope } from '@/components/cockpit/CapabilityEnvelope';
import { NetworksPanel } from '@/components/cockpit/NetworksPanel';
import {
  applyCallRuleOnchain,
  authorizeOnceOnchain,
  proposeCallRuleOnchain,
  removeCallSelectorOnchain,
  tightenCallRuleOnchain,
  type CallRuleInput,
} from '@/lib/chain';

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
  // Phase 5.6: the owner's OWN linked capabilities this agent can chain to, the
  // agent-name map (human-readable timeline), and this agent's chains.
  const [chainCandidates, setChainCandidates] = useState<{ id: string; label: string }[]>([]);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [chains, setChains] = useState<{ chain: Chain; hops: Delegation[] }[]>([]);
  // Stage D: the capability envelope (grants + presets + recent JIT decisions).
  const [capabilities, setCapabilities] = useState<CapabilityEnvelopeView | null>(null);
  // SE-7: registered blockchain networks + this agent's per-chain presence (NOT /api/chains —
  // that is the delegation graph above).
  const [networks, setNetworks] = useState<NetworkChain[]>([]);
  const [agentNetworks, setAgentNetworks] = useState<AgentNetworksView | null>(null);
  // Deep-link focus: /agents/<id>?jit=<requestId> highlights & scrolls to that JIT card.
  const searchParams = useSearchParams();
  const focusJitId = searchParams.get('jit');

  const loadCapabilities = useCallback(async () => {
    try {
      setCapabilities(await api.listCapabilities(id));
    } catch {
      /* non-fatal: the envelope is a read-model convenience */
    }
  }, [api, id]);

  const loadNetworks = useCallback(async () => {
    try {
      const [{ chains }, view] = await Promise.all([api.listNetworks(), api.getAgentNetworks(id)]);
      setNetworks(chains);
      setAgentNetworks(view);
    } catch {
      /* non-fatal: multichain may be unavailable; the panel shows its loading state */
    }
  }, [api, id]);

  const loadChains = useCallback(async () => {
    try {
      const { chains: all } = await api.listChains();
      const mine = all.filter((c) => c.originAgentId === id);
      setChains(await Promise.all(mine.map((c) => api.getChain(c.id))));
    } catch {
      /* non-fatal: the chain view is a read-model convenience */
    }
  }, [api, id]);

  useEffect(() => {
    void (async () => {
      try {
        const [{ links }, { agents }] = await Promise.all([api.listLinks(), api.listAgents()]);
        const names: Record<string, string> = {};
        for (const a of agents) names[a.agentId] = a.name;
        setAgentNames(names);
        setChainCandidates(
          links
            .filter((l) => l.fromAgentId === id && l.status === 'active')
            .map((l) => ({ id: l.toAgentId, label: names[l.toAgentId] ?? `${l.toAgentId.slice(0, 8)}…` })),
        );
      } catch {
        /* non-fatal */
      }
      void loadChains();
      void loadCapabilities();
      void loadNetworks();
    })();
  }, [api, id, loadChains, loadCapabilities, loadNetworks]);
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
    async (
      p: { perTransferCapWei: string; windowCapWei: string; windowSeconds: number; expiresAt: number },
      loosening: boolean,
    ) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      const policy = {
        perTransferCap: BigInt(p.perTransferCapWei),
        windowCap: BigInt(p.windowCapWei),
        windowSeconds: p.windowSeconds,
        expiresAt: BigInt(p.expiresAt),
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
      // (e2eMode short-circuits this — Playwright has no live chain; the
      // never-show-unmined property is pinned by this non-e2e branch.)
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

  const windDown = useCallback(async () => {
    await api.windDown(id);
    await refresh();
  }, [api, id, refresh]);

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

  // ── Stage D: capability grant handlers (owner-signed, client-side) ──
  const requireProvider = useCallback(async () => {
    if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
    return { provider: await wallet.getProvider(), owner: wallet.address as Address, account: detail.addresses.account };
  }, [detail, wallet]);

  const toChainRule = (r: CallRule): CallRuleInput => ({
    target: r.target,
    selector: r.selector,
    recipientMode: r.recipientMode,
    spenderSet: r.spenderSet,
    perCallCap: r.perCallCap,
    windowCapCall: r.windowCapCall,
    ...(r.codehash ? { codehash: r.codehash } : {}),
  });

  const resolvePreset = useCallback(
    async (key: PresetKey): Promise<ResolvedPreset> => (await api.resolvePreset(id, key)).preset,
    [api, id],
  );

  const grantPresetRule = useCallback(
    async (rule: CallRule): Promise<string> => {
      const { provider, owner, account } = await requireProvider();
      return proposeCallRuleOnchain(provider, owner, account, toChainRule(rule));
    },
    [requireProvider],
  );

  const applyCallRule = useCallback(async () => {
    const { provider, owner, account } = await requireProvider();
    await applyCallRuleOnchain(provider, owner, account);
    await loadCapabilities();
  }, [requireProvider, loadCapabilities]);

  const recordPreset = useCallback(
    async (key: PresetKey, txHash: string) => {
      await api.recordPreset(id, key, txHash);
      await loadCapabilities();
    },
    [api, id, loadCapabilities],
  );

  const customRule = useCallback(
    async (action: CapabilityRuleAction, rule: CallRule) => {
      const { provider, owner, account } = await requireProvider();
      let txHash: string | undefined;
      if (action === 'propose') {
        txHash = await proposeCallRuleOnchain(provider, owner, account, toChainRule(rule));
      } else if (action === 'tighten') {
        txHash = await tightenCallRuleOnchain(provider, owner, account, {
          target: rule.target,
          selector: rule.selector,
          perCallCap: rule.perCallCap,
          windowCapCall: rule.windowCapCall,
        });
      } else {
        txHash = await removeCallSelectorOnchain(provider, owner, account, rule.target, rule.selector);
      }
      await api.capabilityRule(id, { action, rule, txHash });
      await loadCapabilities();
    },
    [requireProvider, api, id, loadCapabilities],
  );

  // JIT decision handlers — the request row carries its own approvalId + callHash.
  const jitApproveOnce = useCallback(
    async (approvalId: string, callHash: Hex) => {
      const { provider, owner, account } = await requireProvider();
      const expiry = Math.floor(Date.now() / 1000) + 15 * 60; // ~15 min JIT window
      const txHash = await authorizeOnceOnchain(provider, owner, account, callHash, expiry);
      await api.decideCapability(approvalId, { decision: 'approve_once', txHash });
      await loadCapabilities();
    },
    [requireProvider, api, loadCapabilities],
  );

  const jitAlwaysAllow = useCallback(
    async (approvalId: string, rule: CallRule) => {
      const { provider, owner, account } = await requireProvider();
      const txHash = await proposeCallRuleOnchain(provider, owner, account, toChainRule(rule));
      await api.decideCapability(approvalId, { decision: 'always_allow', txHash, rule });
      await loadCapabilities();
    },
    [requireProvider, api, loadCapabilities],
  );

  const jitDeny = useCallback(
    async (approvalId: string) => {
      await api.decideCapability(approvalId, { decision: 'deny' });
      await loadCapabilities();
    },
    [api, loadCapabilities],
  );

  // Pending JIT requests (need a decision) — from the read-model, bound to an approval.
  const pendingJit = useMemo(
    () => (capabilities?.recentRequests ?? []).filter((r) => r.status === 'pending' && r.approvalId),
    [capabilities],
  );

  // Deep-link: scroll to & highlight the focused JIT card once it's on screen.
  useEffect(() => {
    if (!focusJitId || pendingJit.length === 0) return;
    const el = document.getElementById(`jit-${focusJitId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusJitId, pendingJit]);

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
          {/* M-02 carry: same mismatch condition GuardianPanel warns on, surfaced up top. */}
          <MigrateGuardianBanner guardian={guardian} leashGuardian={detail.leashGuardianAddr} />
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

      {/* Stage D: JIT capability decisions — the agent paused to ask before something new. */}
      {pendingJit.map((r) => (
        <div
          key={r.id}
          id={`jit-${r.id}`}
          data-testid={`jit-card-${r.id}`}
          style={
            focusJitId === r.id
              ? { outline: '2px solid var(--color-accent)', borderRadius: 'var(--radius-md)' }
              : undefined
          }
        >
          <CapabilityDecisionCard
            request={r}
            accountAddr={detail?.addresses.account}
            onApproveOnce={(callHash) => jitApproveOnce(r.approvalId as string, callHash)}
            onAlwaysAllow={(rule) => jitAlwaysAllow(r.approvalId as string, rule)}
            onDeny={() => jitDeny(r.approvalId as string)}
          />
        </div>
      ))}

      {detail && detail.status !== 'revoked' ? (
        <section
          aria-label="Direct this agent"
          style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}
        >
          <DirectBox
            onDirect={async (intent) => (await api.direct(id, { intent })).direction}
            onConfirm={async (directionId, edited, recipient, chainPlan) => {
              await api.confirmDirection(id, directionId, {
                edited,
                ...(recipient ? { recipient } : {}),
                ...(chainPlan && chainPlan.length > 0 ? { chainPlan } : {}),
              });
              void loadChains();
            }}
            chainCandidates={chainCandidates}
          />
          <StatusChat onAsk={async (q) => api.agentStatus(id, q)} />
        </section>
      ) : null}

      {chains.length > 0 ? (
        <section aria-label="Chains" data-testid="chains-section" style={{ display: 'grid', gap: '1rem' }}>
          {chains.map(({ chain, hops }) => (
            <ChainView key={chain.id} chain={chain} hops={hops} agentNames={agentNames} />
          ))}
        </section>
      ) : null}

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
        <StreamFeed items={items} connection={connection} />
        <div style={{ display: 'grid', gap: '1rem' }}>
          {detail ? (
            // Anchor for the inbox limit_hit "Adjust policy" deep-link (spec §3c).
            <div id="policy-panel">
              <PolicyPanel
                detail={detail}
                onSubmitPolicy={submitPolicy}
                pending={pending}
                onApply={applyPending}
                onWindDown={windDown}
                onRearm={rearm}
              />
            </div>
          ) : null}
          {detail ? (
            // Anchor for the migrate-guardian banner CTA (M-02 carry).
            <div id="guardian-panel">
              <GuardianPanel guardian={guardian} leashGuardian={detail.leashGuardianAddr} onSetGuardian={setGuardianTx} />
            </div>
          ) : null}
          {detail ? (
            <RulesEditor rules={detail.agent?.gatewayRules ?? []} onSave={saveRules} />
          ) : null}
          {/* SE-7 (spec §7.C): per-chain presence + the onboard action, one address everywhere. */}
          <NetworksPanel
            view={agentNetworks}
            networks={networks}
            onOnboard={async (chainId) => {
              const result = await api.onboardNetwork(id, chainId);
              await loadNetworks();
              return result;
            }}
          />

          {detail && detail.status !== 'revoked' ? (
            <div id="capability-grant">
              <CapabilityGrant
                onResolvePreset={resolvePreset}
                onGrantPresetRule={grantPresetRule}
                onApplyCallRule={applyCallRule}
                onRecordPreset={recordPreset}
                onCustomRule={customRule}
              />
            </div>
          ) : null}
          {capabilities ? <CapabilityEnvelope envelope={capabilities} /> : null}
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
