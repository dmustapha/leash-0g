// File: web/app/providers.tsx
// Client provider stack. Privy wraps everything in normal mode; in E2E mode (Playwright) the
// OwnerWalletBridge serves a local throwaway signer instead and Privy is not mounted.
'use client';

import type { ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { config } from '@/lib/config';
import { zeroGGalileo } from '@/lib/chain';
import { OwnerWalletBridge } from '@/lib/owner-wallet';

export function Providers({ children }: { children: ReactNode }) {
  if (config.e2eMode || !config.privyAppId) {
    return <OwnerWalletBridge>{children}</OwnerWalletBridge>;
  }
  return (
    <PrivyProvider
      appId={config.privyAppId}
      config={{
        loginMethods: ['wallet'],
        appearance: { theme: 'dark', accentColor: '#c6f24d' },
        defaultChain: zeroGGalileo,
        supportedChains: [zeroGGalileo],
      }}
    >
      <OwnerWalletBridge>{children}</OwnerWalletBridge>
    </PrivyProvider>
  );
}
