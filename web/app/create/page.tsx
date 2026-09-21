// File: web/app/create/page.tsx
// Create-agent page: wires the wizard to the real create action — browser-side audit keypair,
// signature-derived KEK (with determinism guard + passphrase fallback), backend create call.
'use client';

import { useCallback, useMemo } from 'react';
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
  type WizardResult,
} from '@/components/create/CreateWizard';

function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CreatePage() {
  const wallet = useOwnerWallet();
  const { setAgentId } = useAgentId();
  const api = makeApi(wallet.getToken);

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
      });
      setAgentId(response.agentId);

      return {
        response,
        kekMode: blob.mode,
        downloadBackup: () =>
          // C-6: encrypted blob ONLY — no plaintext privkey ever touches disk.
          // Recovery = unwrap the blob with the same wallet signature (or
          // passphrase) the audit page uses; losing BOTH loses the key, which
          // is the self-sovereignty trade recorded in the spec.
          download(
            `leash-audit-key-${response.agentId}.json`,
            buildAuditBackup({ agentId: response.agentId, pubKeyHex: keypair.pubKeyHex, blob }),
          ),
      };
    },
    [api, wallet.address, wallet.signMessage, setAgentId],
  );

  // Fund-the-agent hooks for the done screen: a plain native transfer from the owner wallet
  // plus a live balance readback. Balance polling is skipped in E2E mode (no live chain).
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

  return (
    <div className="wrap-narrow" style={{ paddingBlock: 'clamp(2rem, 5vw, 4rem)', maxWidth: '640px' }}>
      <CreateWizard onCreate={onCreate} walletReady={wallet.authenticated} fund={fund} />
    </div>
  );
}
