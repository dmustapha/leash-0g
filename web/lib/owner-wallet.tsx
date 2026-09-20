// File: web/lib/owner-wallet.tsx
// One owner-wallet surface for the whole app: { address, signMessage, provider, getToken }.
//  - Normal mode: Privy (@privy-io/react-auth) — login with wallet, Bearer = Privy access token.
//  - E2E mode (NEXT_PUBLIC_E2E_MODE=1, Playwright only): a local throwaway key stands in for the
//    wallet so the deterministic-signature KEK path runs for real against a mocked backend.
'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, type Address, type EIP1193Provider } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config';

export type OwnerWallet = {
  ready: boolean;
  authenticated: boolean;
  address: Address | null;
  login: () => void;
  logout: () => void;
  getToken: () => Promise<string | null>;
  signMessage: (message: string) => Promise<string>;
  getProvider: () => Promise<EIP1193Provider>;
};

const Ctx = createContext<OwnerWallet | null>(null);

// Throwaway, public, testnet-worthless key — E2E ONLY (never holds funds).
const E2E_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

function useE2eWallet(): OwnerWallet {
  return useMemo(() => {
    const account = privateKeyToAccount(E2E_KEY);
    return {
      ready: true,
      authenticated: true,
      address: account.address,
      login: () => undefined,
      logout: () => undefined,
      getToken: async () => 'e2e-test-token',
      signMessage: (message: string) => account.signMessage({ message }),
      getProvider: async () => {
        throw new Error('No injected provider in E2E mode');
      },
    };
  }, []);
}

function usePrivyWallet(): OwnerWallet {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];

  return useMemo<OwnerWallet>(
    () => ({
      ready,
      authenticated: authenticated && !!wallet,
      address: (wallet?.address as Address | undefined) ?? null,
      login,
      logout,
      getToken: () => getAccessToken(),
      signMessage: async (message: string) => {
        if (!wallet) throw new Error('Connect a wallet first');
        const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
        const client = createWalletClient({
          transport: custom(provider),
          account: wallet.address as Address,
        });
        return client.signMessage({ message });
      },
      getProvider: async () => {
        if (!wallet) throw new Error('Connect a wallet first');
        return (await wallet.getEthereumProvider()) as EIP1193Provider;
      },
    }),
    [ready, authenticated, wallet, login, logout, getAccessToken],
  );
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const value = usePrivyWallet();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function E2eBridge({ children }: { children: ReactNode }) {
  const value = useE2eWallet();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function OwnerWalletBridge({ children }: { children: ReactNode }) {
  if (config.e2eMode) return <E2eBridge>{children}</E2eBridge>;
  return <PrivyBridge>{children}</PrivyBridge>;
}

export function useOwnerWallet(): OwnerWallet {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOwnerWallet must be used inside OwnerWalletBridge');
  return v;
}
