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
  CapabilityGrantRow,
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
import { PriceBandPanel } from '@/components/cockpit/PriceBandPanel';
import { CapabilityDecisionCard } from '@/components/cockpit/CapabilityDecisionCard';
import { CapabilityEnvelope } from '@/components/cockpit/CapabilityEnvelope';
import { NetworksPanel } from '@/components/cockpit/NetworksPanel';
import { GasPolicyToggle } from '@/components/cockpit/GasPolicyToggle';
import { GasRoutePlan } from '@/components/cockpit/GasRoutePlan';
import { nativeSymbol } from '@/lib/networks';
import {
  applyCallRuleOnchain,
  applySpendBudgetOnchain,
  enableRequireBandForSwapOnchain,
  readPriceBandSet,
  readRequireBandForSwap,
  tightenPriceBandOnchain,
  readPendingCallRule,
  authorizeOnceOnchain,
  proposeCallRuleOnchain,
  proposeSpendBudgetOnchain,
  removeCallSelectorOnchain,
  tightenCallRuleOnchain,
  proposeSigningGrantOnchain,
  applySigningGrantOnchain,
  tightenSigningGrantOnchain,
  removeSigningDescriptorOnchain,
  proposeEnvelopeOnchain,
  applyEnvelopeOnchain,
  readEnvelope,
  proposeVetoConfigOnchain,
  applyVetoConfigOnchain,
  readVetoConfig,
  type CallRuleInput,
  type EnvelopeEntryInput,
} from '@/lib/chain';
import { EnvelopeForm, VetoConfigForm, type EnvelopeFields, type VetoFields } from '@/components/cockpit/EnvelopeForm';
import type { AccountVersion } from '@/lib/abi/leashAccountV5';
import { SigningGrantPanel, type ProposeGrantArgs } from '@/components/cockpit/SigningGrantPanel';
import type { SigningEnvelopeView, SigningDescriptorView, GasSurveyView } from '@/lib/types';

type Approval = Extract<StreamEvent, { type: 'approval' }>;
type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** RH2 (B1) + AQ-FND (⑥ live fix): the account grammar version the owner-arming txs encode
 *  against. The backend surfaces `agent.accountVersion` on `GET /:id` (read-model projection).
 *  V6 (the create default) keeps the shared call-rule/band selectors byte-identical but swaps
 *  the budget pair for the kinded governed pair — chain.ts gates on this version. Legacy v2 or
 *  an absent field falls back to V4. */
function accountVersionFor(detail: AgentDetail | null): AccountVersion {
  const v = detail?.agent?.accountVersion;
  return v === 6 ? 6 : v === 5 ? 5 : 4;
}

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
  // RH2 B2 (TA-ABI-5 close): the governed-signing envelope (reviewed descriptors + standing grants).
  const [signing, setSigning] = useState<SigningEnvelopeView | null>(null);
  // SE-7: registered blockchain networks + this agent's per-chain presence (NOT /api/chains —
  // that is the delegation graph above).
  const [networks, setNetworks] = useState<NetworkChain[]>([]);
  const [agentNetworks, setAgentNetworks] = useState<AgentNetworksView | null>(null);
  // AQ-FND M-3: per-chain holdings + the planned gas route (null = not read / unavailable).
  const [gasSurvey, setGasSurvey] = useState<GasSurveyView | null>(null);
  // FR4 (F-9): live requireBandForSwap() for the band-arm panel (null = not read yet).
  const [bandArmed, setBandArmed] = useState<boolean | null>(null);
  const [bandSet, setBandSet] = useState<boolean>(false);
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

  // RH2 B2: load the signing envelope (non-fatal — V5-only; absent for V4/legacy).
  const loadSigning = useCallback(async () => {
    try {
      setSigning(await api.listSigning(id));
    } catch {
      /* non-fatal: the signing envelope is a read-model convenience (V5 accounts only) */
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

  const loadGasSurvey = useCallback(async () => {
    try {
      setGasSurvey(await api.getGasSurvey(id));
    } catch {
      /* non-fatal: the survey is a read-only convenience (503 for external/unwired agents) */
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
      void loadSigning();
      void loadNetworks();
      void loadGasSurvey();
    })();
  }, [api, id, loadChains, loadCapabilities, loadSigning, loadNetworks, loadGasSurvey]);
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
          setPending(await readPendingEtas(d.addresses.account, agentNetworks?.homeChainId));
        } catch {
          /* keep last known pending etas */
        }
        try {
          setGuardian(await readGuardian(d.addresses.account, agentNetworks?.homeChainId));
        } catch {
          /* keep last known guardian */
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your agent.');
    }
  }, [api, id, agentNetworks?.homeChainId]);

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
          setItems((prev) => [...prev.slice(-199), { kind: 'reasoning', text: ev.text, id: nid, ...(ev.meta ? { meta: ev.meta } : {}) }]);
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
    const tx = await revokeOnchain(provider, wallet.address as Address, detail.addresses.account, agentNetworks?.homeChainId);
    await refresh();
    return tx;
  }, [detail, wallet, refresh, agentNetworks?.homeChainId]);

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
      await fn(provider, wallet.address as Address, detail.addresses.account, policy, agentNetworks?.homeChainId);
      await refresh();
    },
    [detail, wallet, refresh, agentNetworks?.homeChainId],
  );

  const applyPending = useCallback(
    async (kind: keyof PendingEtas) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      const fn = { policy: applyPolicyOnchain, allowlist: applyAllowlistOnchain, withdraw: applyWithdrawOnchain }[kind];
      await fn(provider, wallet.address as Address, detail.addresses.account, agentNetworks?.homeChainId);
      setPending((prev) => ({ ...prev, [kind]: 0 }));
      await refresh();
    },
    [detail, wallet, refresh, agentNetworks?.homeChainId],
  );

  const rearm = useCallback(async () => {
    if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
    const provider = await wallet.getProvider();
    const tx = await rearmOnchain(provider, wallet.address as Address, detail.addresses.account, agentNetworks?.homeChainId);
    await refresh();
    return tx;
  }, [detail, wallet, refresh, agentNetworks?.homeChainId]);

  const setGuardianTx = useCallback(
    async (newGuardian: Address) => {
      if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
      const provider = await wallet.getProvider();
      const tx = await setGuardianOnchain(provider, wallet.address as Address, detail.addresses.account, newGuardian, agentNetworks?.homeChainId);
      // Security-critical display (gate M-03): never show the change before it
      // is mined — wait for the receipt, then read the truth back from chain.
      // (e2eMode short-circuits this — Playwright has no live chain; the
      // never-show-unmined property is pinned by this non-e2e branch.)
      if (!config.e2eMode) {
        await waitForTx(tx as Hex, agentNetworks?.homeChainId);
        setGuardian(await readGuardian(detail.addresses.account, agentNetworks?.homeChainId));
      } else {
        setGuardian(newGuardian);
      }
      return tx;
    },
    [detail, wallet, agentNetworks?.homeChainId],
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
      return sendNativeOnchain(provider, wallet.address as Address, detail.addresses.account, valueWei, agentNetworks?.homeChainId);
    },
    [detail, wallet, agentNetworks?.homeChainId],
  );

  // ── Stage D: capability grant handlers (owner-signed, client-side) ──
  const requireProvider = useCallback(async () => {
    if (!detail || !wallet.address) throw new Error('Connect your wallet first.');
    return {
      provider: await wallet.getProvider(),
      owner: wallet.address as Address,
      account: detail.addresses.account,
      // F-11: owner writes must land on the AGENT'S chain, not the platform default.
      chainId: agentNetworks?.homeChainId,
      // RH2 (B1): the account's on-chain grammar version → the owner-write helpers pick the
      // V5 superset ABI for a V5 trader (band propose/apply + shared call-rule/spend grammar)
      // and keep the V4 ABI for V4/legacy. Absent on legacy detail payloads ⇒ V4 fallback
      // (the shared selectors are byte-identical, so V4 behavior is unchanged).
      version: accountVersionFor(detail),
    };
  }, [detail, wallet, agentNetworks?.homeChainId]);

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
      const { provider, owner, account, chainId, version } = await requireProvider();
      return proposeCallRuleOnchain(provider, owner, account, toChainRule(rule), chainId, version);
    },
    [requireProvider],
  );

  const applyCallRule = useCallback(async () => {
    const { provider, owner, account, chainId, version } = await requireProvider();
    await applyCallRuleOnchain(provider, owner, account, chainId, version);
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
      const { provider, owner, account, chainId, version } = await requireProvider();
      let txHash: string | undefined;
      if (action === 'propose') {
        txHash = await proposeCallRuleOnchain(provider, owner, account, toChainRule(rule), chainId, version);
      } else if (action === 'tighten') {
        txHash = await tightenCallRuleOnchain(provider, owner, account, {
          target: rule.target,
          selector: rule.selector,
          perCallCap: rule.perCallCap,
          windowCapCall: rule.windowCapCall,
        }, chainId, version);
      } else {
        txHash = await removeCallSelectorOnchain(provider, owner, account, rule.target, rule.selector, chainId, version);
      }
      await api.capabilityRule(id, { action, rule, txHash });
      await loadCapabilities();
    },
    [requireProvider, api, id, loadCapabilities],
  );

  // FR3 (F-8b): owner-signed per-token spend budget — propose (timelocked) + apply.
  const proposeBudget = useCallback(
    async (token: string, windowCap: string) => {
      const { provider, owner, account, chainId, version } = await requireProvider();
      await proposeSpendBudgetOnchain(provider, owner, account, token as Address, windowCap, chainId, version);
    },
    [requireProvider],
  );

  const applyBudget = useCallback(
    async (token: string, windowCap: string) => {
      const { provider, owner, account, chainId, version } = await requireProvider();
      await applySpendBudgetOnchain(provider, owner, account, token as Address, windowCap, chainId, version);
    },
    [requireProvider],
  );

  // AQ-FND M-2: owner envelope (the ceiling the agent self-extends within). propose (timelocked)
  // + apply (re-submits the same payload for the module's commit check), both owner-signed on the
  // account's bound envelope module; the live envelope is read on-chain for the display.
  const toEnvelopeEntry = (f: EnvelopeFields): EnvelopeEntryInput => ({
    asset: f.asset as Address,
    maxPerTransferCap: f.maxPerTransferCap,
    maxWindowCap: f.maxWindowCap,
    minWindowSeconds: f.minWindowSeconds,
  });
  const proposeEnvelope = useCallback(
    async (f: EnvelopeFields) => {
      const { provider, owner, account, chainId } = await requireProvider();
      await proposeEnvelopeOnchain(provider, owner, account, toEnvelopeEntry(f), chainId);
    },
    [requireProvider],
  );
  const applyEnvelope = useCallback(
    async (f: EnvelopeFields) => {
      const { provider, owner, account, chainId } = await requireProvider();
      await applyEnvelopeOnchain(provider, owner, account, toEnvelopeEntry(f), chainId);
    },
    [requireProvider],
  );
  const readEnvelopeForAsset = useCallback(
    async (asset: string) => {
      const { account, chainId } = await requireProvider();
      const e = await readEnvelope(account, asset as Address, chainId);
      return e.set ? e : null;
    },
    [requireProvider],
  );
  const proposeVeto = useCallback(
    async (f: VetoFields) => {
      const { provider, owner, account, chainId } = await requireProvider();
      await proposeVetoConfigOnchain(provider, owner, account, f, chainId);
    },
    [requireProvider],
  );
  const applyVeto = useCallback(
    async (f: VetoFields) => {
      const { provider, owner, account, chainId } = await requireProvider();
      await applyVetoConfigOnchain(provider, owner, account, f, chainId);
    },
    [requireProvider],
  );
  const readVetoCfg = useCallback(
    async () => {
      const { account, chainId } = await requireProvider();
      const v = await readVetoConfig(account, chainId);
      return v.set ? v : null;
    },
    [requireProvider],
  );

  // FR4 (F-9): arm the band wall in-product — two owner txs on the agent's chain.
  const homeNetwork = useMemo(
    () => networks.find((n) => n.chainId === agentNetworks?.homeChainId),
    [networks, agentNetworks?.homeChainId],
  );
  const traderGoal = detail?.agent?.goal;
  const bandCapable = useMemo(
    () =>
      (homeNetwork?.capabilities ?? []).includes('oracleBand') &&
      traderGoal?.type === 'trader' &&
      typeof homeNetwork?.router === 'string',
    [homeNetwork, traderGoal?.type],
  );
  useEffect(() => {
    if (!bandCapable || !detail || config.e2eMode) return;
    let cancelled = false;
    const account = detail.addresses.account;
    const chainId = agentNetworks?.homeChainId;
    void Promise.all([
      readRequireBandForSwap(account, chainId),
      typeof homeNetwork?.router === 'string'
        ? readPriceBandSet(account, homeNetwork.router as Address, chainId)
        : Promise.resolve(false),
    ])
      .then(([armed, set]) => {
        if (cancelled) return;
        setBandArmed(armed);
        setBandSet(set);
      })
      .catch(() => {
        /* keep last known band state */
      });
    return () => {
      cancelled = true;
    };
  }, [bandCapable, detail, agentNetworks?.homeChainId, homeNetwork]);

  const bandTighten = useCallback(
    async (band: { feed: string; asset: string; maxDeviationBps: number; maxStalenessSec: number }) => {
      const { provider, owner, account, chainId, version } = await requireProvider();
      if (typeof homeNetwork?.router !== 'string') throw new Error('This network has no canonical router configured.');
      const tx = await tightenPriceBandOnchain(
        provider,
        owner,
        account,
        {
          target: homeNetwork.router as Address,
          feed: band.feed as Address,
          asset: band.asset as Address,
          maxDeviationBps: band.maxDeviationBps,
          maxStalenessSec: band.maxStalenessSec,
        },
        chainId,
        version,
      );
      await waitForTx(tx as Hex, chainId);
      setBandSet(true);
    },
    [requireProvider, homeNetwork?.router],
  );

  const bandEnable = useCallback(async () => {
    const { provider, owner, account, chainId, version } = await requireProvider();
    const tx = await enableRequireBandForSwapOnchain(provider, owner, account, chainId, version);
    await waitForTx(tx as Hex, chainId);
    setBandArmed(await readRequireBandForSwap(account, chainId));
  }, [requireProvider]);

  // FR3 (F-8c): apply a matured PROPOSED rule from the envelope (the custom-rule
  // flow's missing second half) — sign applyCallRule, then record proposed→active.
  const applyGrant = useCallback(
    async (grant: CapabilityGrantRow) => {
      const { provider, owner, account, chainId, version } = await requireProvider();
      // Review fix: the contract holds ONE pending-rule slot and applyCallRule()
      // is argless — a later proposal overwrites the slot. Verify the slot IS
      // this row before signing, or the wrong rule activates while the mirror
      // records this one as active.
      const pending = await readPendingCallRule(account, chainId);
      if (pending.eta === 0) {
        throw new Error('Nothing is pending on-chain for this agent — this rule may already be applied.');
      }
      if (
        pending.target !== grant.target.toLowerCase() ||
        pending.selector !== grant.selector.toLowerCase()
      ) {
        throw new Error(
          'The pending rule on-chain is a different one (a later proposal replaced this slot). Apply that rule first, then re-propose this one.',
        );
      }
      const txHash = await applyCallRuleOnchain(provider, owner, account, chainId, version);
      await api.capabilityRule(id, {
        action: 'apply',
        rule: {
          target: grant.target,
          selector: grant.selector,
          recipientMode: grant.recipientMode,
          spenderSet: grant.spenderSet,
          perCallCap: grant.perCallCap,
          windowCapCall: grant.windowCapCall,
          ...(grant.codehash ? { codehash: grant.codehash as Hex } : {}),
        },
        ...(txHash ? { txHash } : {}),
      });
      await loadCapabilities();
    },
    [requireProvider, api, id, loadCapabilities],
  );

  // ── RH2 B2 (TA-ABI-5 close): governed-signing grant handlers ──────────────────
  // The owner signs every grant tx CLIENT-SIDE via Privy (the SAME non-custodial path
  // as the capability grants above); the backend only records the read-model mirror
  // (POST /signing/rule) + returns the onChainGrant params. These helpers encode against
  // the V5 signing ABI (the panel is shown only for V5 accounts). propose = loosen
  // (timelocked) → apply; tighten + remove are instant.
  const proposeSigning = useCallback(
    async (args: ProposeGrantArgs) => {
      const { provider, owner, account, chainId } = await requireProvider();
      // The backend re-derives the exact on-chain grant params (idempotent) — fetch the
      // canonical struct to sign, never trust a client-computed one.
      const res = await api.signingRule(id, {
        action: 'set',
        rule: {
          descriptorId: args.descriptor.descriptorId,
          spenderSet: args.spenders,
          perIntentCap: args.perIntentCap,
          maxDeadlineWindow: args.maxDeadlineWindow,
          token: args.token,
          ...(args.descriptor.onChainGrant.tokenCaps.length > 0
            ? { tokenCaps: args.descriptor.onChainGrant.tokenCaps }
            : {}),
        },
      });
      const grant = res.onChainGrant ?? args.descriptor.onChainGrant;
      await proposeSigningGrantOnchain(
        provider,
        owner,
        account,
        {
          grant,
          spenders: args.spenders as Address[],
          perIntentCap: args.perIntentCap,
          maxDeadlineWindow: args.maxDeadlineWindow,
          token: args.token as Address,
        },
        chainId,
      );
      await loadSigning();
    },
    [requireProvider, api, id, loadSigning],
  );

  const applySigning = useCallback(async () => {
    const { provider, owner, account, chainId } = await requireProvider();
    await applySigningGrantOnchain(provider, owner, account, chainId);
    await loadSigning();
  }, [requireProvider, loadSigning]);

  const tightenSigning = useCallback(
    async (args: {
      descriptor: SigningDescriptorView;
      perIntentCap: string;
      maxDeadlineWindow: number;
      token: string;
      spenders: string[];
    }) => {
      const { provider, owner, account, chainId } = await requireProvider();
      await tightenSigningGrantOnchain(
        provider,
        owner,
        account,
        {
          descriptorId: args.descriptor.descriptorId,
          perIntentCap: args.perIntentCap,
          maxDeadlineWindow: args.maxDeadlineWindow,
        },
        chainId,
      );
      // Record the tightened read-model (instant — fail-safe to record eagerly).
      await api.signingRule(id, {
        action: 'set',
        rule: {
          descriptorId: args.descriptor.descriptorId,
          spenderSet: args.spenders,
          perIntentCap: args.perIntentCap,
          maxDeadlineWindow: args.maxDeadlineWindow,
          token: args.token,
          ...(args.descriptor.onChainGrant.tokenCaps.length > 0
            ? { tokenCaps: args.descriptor.onChainGrant.tokenCaps }
            : {}),
        },
      });
      await loadSigning();
    },
    [requireProvider, api, id, loadSigning],
  );

  const removeSigning = useCallback(
    async (descriptor: SigningDescriptorView) => {
      const { provider, owner, account, chainId } = await requireProvider();
      await removeSigningDescriptorOnchain(provider, owner, account, descriptor.descriptorId, chainId);
      await api.signingRule(id, {
        action: 'remove',
        rule: {
          descriptorId: descriptor.descriptorId,
          spenderSet: [],
          perIntentCap: '0',
          maxDeadlineWindow: 0,
          token: '0x0000000000000000000000000000000000000000',
        },
      });
      await loadSigning();
    },
    [requireProvider, api, id, loadSigning],
  );

  // JIT decision handlers — the request row carries its own approvalId + callHash.
  const jitApproveOnce = useCallback(
    async (approvalId: string, callHash: Hex) => {
      const { provider, owner, account, chainId, version } = await requireProvider();
      const expiry = Math.floor(Date.now() / 1000) + 15 * 60; // ~15 min JIT window
      const txHash = await authorizeOnceOnchain(provider, owner, account, callHash, expiry, chainId, version);
      await api.decideCapability(approvalId, { decision: 'approve_once', txHash });
      await loadCapabilities();
    },
    [requireProvider, api, loadCapabilities],
  );

  const jitAlwaysAllow = useCallback(
    async (approvalId: string, rule: CallRule) => {
      const { provider, owner, account, chainId, version } = await requireProvider();
      const txHash = await proposeCallRuleOnchain(provider, owner, account, toChainRule(rule), chainId, version);
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

  // SE-7: amounts are denominated in the HOME chain's gas token (RH/Base/Eth/Arb = ETH).
  const currency = nativeSymbol(agentNetworks?.homeChainId);

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
        <span className="hash">
          <Link href={`/agents/${id}/audit`}>Audit trail →</Link>
        </span>
      }
    >
      {detail ? (
        <>
          {/* M-02 carry: same mismatch condition GuardianPanel warns on, surfaced up top. */}
          <MigrateGuardianBanner guardian={guardian} leashGuardian={detail.leashGuardianAddr} />
          <StatusBar detail={detail} chainVerified={chainVerified} currency={currency} />
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
                <strong>Running low.</strong> The agent holds {weiToOg(detail.accountBalance)} {currency} —
                less than one full budget window ({weiToOg(detail.policy.windowCapWei)} {currency}). Top it
                up so payments do not start failing.
              </p>
              <FundPanel
                chainId={agentNetworks?.homeChainId}
                accountAddr={detail.addresses.account}
                defaultAmountOg={weiToOg(2n * BigInt(detail.policy.windowCapWei))}
                onSend={wallet.address ? fundAgent : undefined}
                getBalance={
                  config.e2eMode ? undefined : () => readAccountBalance(detail.addresses.account)
                }
                initialBalanceWei={detail.accountBalance}
                onFunded={() => void refresh()}
                idPrefix="cockpit-fund"
                currency={currency}
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

      {/* The cockpit grid (console.html .cockpit-grid, 1fr/380px): the live stream + the
          "what this agent can do on its own" capability surfaces fill the main column; the
          Limits/Guardian/Message-rules/Networks control rail sits at a fixed 380px on the right.
          Collapses to one column < 1100px (see .cockpit-grid in console.css). */}
      <div className="cockpit-grid">
        <div style={{ display: 'grid', gap: '1rem', alignItems: 'start' }}>
          <StreamFeed items={items} connection={connection} chainId={agentNetworks?.homeChainId} />
          {detail && detail.status !== 'revoked' && bandCapable && traderGoal?.type === 'trader' ? (
            <PriceBandPanel
              routerAddr={homeNetwork?.router ?? ''}
              defaultAsset={traderGoal.holdToken}
              armed={bandArmed === true}
              bandSet={bandSet}
              onTighten={bandTighten}
              onEnable={bandEnable}
            />
          ) : null}
          {detail && detail.status !== 'revoked' ? (
            <div id="capability-grant">
              <CapabilityGrant
                onResolvePreset={resolvePreset}
                onGrantPresetRule={grantPresetRule}
                onApplyCallRule={applyCallRule}
                onRecordPreset={recordPreset}
                onCustomRule={customRule}
                onProposeBudget={proposeBudget}
                onApplyBudget={applyBudget}
              />
            </div>
          ) : null}
          {detail && detail.status !== 'revoked' && accountVersionFor(detail) === 6 ? (
            <section aria-label="Owner envelope" className="card" id="owner-envelope" data-testid="owner-envelope" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
              <h2 style={{ fontSize: '1rem', margin: 0 }}>Set what the agent may do on its own</h2>
              <EnvelopeForm onProposeEnvelope={proposeEnvelope} onApplyEnvelope={applyEnvelope} onReadEnvelope={readEnvelopeForAsset} />
              <VetoConfigForm onProposeVeto={proposeVeto} onApplyVeto={applyVeto} onReadVeto={readVetoCfg} />
            </section>
          ) : null}
          {capabilities ? <CapabilityEnvelope envelope={capabilities} onApplyGrant={applyGrant} /> : null}
          {/* RH2 B2 (TA-ABI-5 close): the owner governed-signing grant surface — V5 accounts only.
              This is the shipped arm path that did not exist (previously only the [DEPLOY] script). */}
          {detail &&
          detail.status !== 'revoked' &&
          accountVersionFor(detail) === 5 &&
          signing ? (
            <div id="signing-grant">
              <SigningGrantPanel
                available={signing.available}
                rules={signing.rules}
                onProposeGrant={proposeSigning}
                onApplyGrant={applySigning}
                onTightenGrant={tightenSigning}
                onRemoveGrant={removeSigning}
              />
            </div>
          ) : null}
        </div>
        <div style={{ display: 'grid', gap: '1rem', alignItems: 'start' }}>
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
                currency={currency}
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
              void loadGasSurvey();
              return result;
            }}
          />
          {/* AQ-FND M-3: where the agent gets gas (per-chain holdings + route) and the relayer opt-in. */}
          <GasRoutePlan survey={gasSurvey} />
          {detail && accountVersionFor(detail) === 6 ? (
            <GasPolicyToggle
              initial={detail.agent?.allowRelayerBootstrap === true}
              setGasPolicy={async (next) => {
                await api.setGasPolicy(id, next);
                void loadGasSurvey();
              }}
            />
          ) : null}
        </div>
      </div>

      {/* Direction & status chat — full-width below the grid (console.html renderCockpit order). */}
      {detail && detail.status !== 'revoked' ? (
        <section aria-label="Direct this agent" style={{ display: 'grid', gap: '1rem', alignItems: 'start' }}>
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

      {/* Delegation chain — full-width below (console.html renderCockpit order). */}
      {chains.length > 0 ? (
        <section aria-label="Chains" data-testid="chains-section" style={{ display: 'grid', gap: '1rem' }}>
          {chains.map(({ chain, hops }) => (
            <ChainView key={chain.id} chain={chain} hops={hops} agentNames={agentNames} />
          ))}
        </section>
      ) : null}

      {/* Danger zone — full-width at the foot (console.html renderCockpit order). */}
      <RevokeButton
        revoked={detail?.status === 'revoked'}
        onRevoke={revokeGuardian}
        onRevokeOnchain={revokeFallback}
        onRearm={rearm}
      />
    </PageShell>
  );
}

// G-2.5: the shell topbar owns the "Cockpit" title; `.cockpit-view` scopes the cockpit styles
// and auto-reskins the component panels. The per-agent identity rides a `.cockpit-head` built
// from real `detail` inside the page body (below), not here.
function PageShell({ aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cockpit-view" style={{ display: 'grid', gap: '1.1rem' }}>
      {aside ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span style={{ flex: 1 }} />
          {aside}
        </div>
      ) : null}
      {children}
    </div>
  );
}
