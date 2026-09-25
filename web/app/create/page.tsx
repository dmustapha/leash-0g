// File: web/app/create/page.tsx
// Create-agent page (Phase 5): the intent-first FUNNEL wraps the role-first wizard.
// 2-screen happy path: FunnelEntry (intent OR template) → ReadBack (tiered, edit, confirm) →
// CreateWizard jumped to `review`. "Set it up manually" skips the funnel to the wizard.
// The wizard still owns the real create action — browser audit keypair, signature-derived KEK,
// backend create call — unchanged from Phase 1–4.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { makeApi } from '@/lib/api';
import { config } from '@/lib/config';
import { readAccountBalance, sendNativeOnchain } from '@/lib/chain';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { useAgentId } from '@/lib/use-agent-id';
import { generateAuditKeypair, hexToBytes, buildAuditBackup } from '@/lib/crypto/audit-key';
import {
  encryptWithPassphrase,
  encryptWithSignature,
  kekSignMessage,
  probeDeterministicSignature,
  serializeBlob,
  type EncryptedBlob,
} from '@/lib/crypto/kek';
import {
  CreateWizard,
  PassphraseRequiredError,
  type WizardInput,
  type WizardPrefill,
  type WizardResult,
} from '@/components/create/CreateWizard';
import { FunnelEntry } from '@/components/create/FunnelEntry';
import { ReadBack } from '@/components/create/ReadBack';
import { draftToPrefill } from '@/components/create/draft-to-prefill';
import type { ElevationDraft, JobSpecSummary } from '@/lib/types';

function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type Screen = 'funnel' | 'readback' | 'wizard';

export default function CreatePage() {
  const wallet = useOwnerWallet();
  const { setAgentId } = useAgentId();
  const api = useMemo(() => makeApi(wallet.getToken), [wallet.getToken]);

  const [screen, setScreen] = useState<Screen>('funnel');
  const [draft, setDraft] = useState<ElevationDraft | null>(null);
  const [prefill, setPrefill] = useState<WizardPrefill | undefined>(undefined);

  // Phase-4: the owner's existing provider/evaluator agents, for a requester's links.
  const [jobAgents, setJobAgents] = useState<{ providers: { id: string; name: string }[]; evaluators: { id: string; name: string }[] }>({
    providers: [],
    evaluators: [],
  });
  // Phase-5 (D-A2): the owner's saved job specs, for the requester job-handle picker.
  const [jobSpecs, setJobSpecs] = useState<JobSpecSummary[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const [{ agents }, specs] = await Promise.all([
          api.listAgents(),
          api.listJobSpecs().catch(() => ({ specs: [] as JobSpecSummary[] })),
        ]);
        const active = agents.filter((a) => a.status === 'active');
        setJobAgents({
          providers: active.filter((a) => a.role === 'provider').map((a) => ({ id: a.agentId, name: a.name })),
          evaluators: active.filter((a) => a.role === 'evaluator').map((a) => ({ id: a.agentId, name: a.name })),
        });
        setJobSpecs(specs.specs);
      } catch {
        /* the pickers just show empty — non-fatal */
      }
    })();
  }, [api]);

  const onCreate = useCallback(
    async (input: WizardInput, passphrase?: string): Promise<WizardResult> => {
      // 1. Audit keypair, in-browser. Privkey never leaves this device unencrypted.
      const keypair = generateAuditKeypair();

      // 2. KEK: deterministic wallet signature over an owner+chain-bound message (derive
      //    twice + compare), else passphrase.
      let blob: EncryptedBlob;
      if (passphrase) {
        blob = await encryptWithPassphrase(hexToBytes(keypair.privKeyHex), passphrase);
      } else {
        if (!wallet.address) throw new Error('Connect your wallet first.');
        const message = kekSignMessage(wallet.address, config.chainId);
        const sig = await probeDeterministicSignature(wallet.signMessage, message);
        if (!sig) throw new PassphraseRequiredError();
        blob = await encryptWithSignature(hexToBytes(keypair.privKeyHex), sig);
      }

      // 3. Create via backend — server stores the encrypted blob blind.
      const response = await api.createAgent({
        name: input.name,
        policy: input.policy,
        allowlist: input.allowlist,
        goal: input.goal,
        auditPubKey: keypair.pubKeyHex,
        encryptedAuditKey: serializeBlob(blob),
        ...(input.tokenConfig ? { tokenConfig: input.tokenConfig } : {}),
        // Phase-5 (D-B9): thread the freeform capability label (inert display field).
        ...(input.capabilityLabel ? { capabilityLabel: input.capabilityLabel } : {}),
      });
      setAgentId(response.agentId);

      return {
        response,
        kekMode: blob.mode,
        downloadBackup: () =>
          download(
            `leash-audit-key-${response.agentId}.json`,
            buildAuditBackup({ agentId: response.agentId, pubKeyHex: keypair.pubKeyHex, blob }),
          ),
      };
    },
    [api, wallet.address, wallet.signMessage, setAgentId],
  );

  const fund = useMemo(
    () => ({
      send: async (to: Address, valueWei: bigint) => {
        if (!wallet.address) throw new Error('Connect your wallet first.');
        const provider = await wallet.getProvider();
        return sendNativeOnchain(provider, wallet.address, to, valueWei);
      },
      ...(config.e2eMode ? {} : { getBalance: (account: Address) => readAccountBalance(account) }),
    }),
    [wallet],
  );

  // — Funnel transitions —
  const onElevate = useCallback(
    async (intent: string) => {
      const { draft: d } = await api.elevate({ intent });
      setDraft(d);
      setScreen('readback');
    },
    [api],
  );
  const onPick = useCallback((d: ElevationDraft) => {
    setDraft(d);
    setScreen('readback');
  }, []);
  const onConfirm = useCallback((edited: ElevationDraft, recipient?: string) => {
    setPrefill(draftToPrefill(edited, recipient));
    setScreen('wizard');
  }, []);
  const onManual = useCallback(() => {
    setPrefill(undefined);
    setScreen('wizard');
  }, []);

  return (
    <div className="wrap-narrow" style={{ paddingBlock: 'clamp(2rem, 5vw, 4rem)', maxWidth: '640px' }}>
      {screen === 'funnel' ? (
        <FunnelEntry onElevate={onElevate} onPick={onPick} onManual={onManual} />
      ) : screen === 'readback' && draft ? (
        <ReadBack draft={draft} onConfirm={onConfirm} onBack={() => setScreen('funnel')} />
      ) : (
        <CreateWizard
          onCreate={onCreate}
          walletReady={wallet.authenticated}
          fund={fund}
          jobAgents={jobAgents}
          jobSpecs={jobSpecs}
          {...(prefill ? { prefill } : {})}
          onStartAgent={onManual}
        />
      )}
    </div>
  );
}
