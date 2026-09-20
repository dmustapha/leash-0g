// File: web/lib/config.ts
// Public env config. All values are NEXT_PUBLIC_* (inlined at build). Never put secrets here.

export const config = {
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '',
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
  rpcUrl: process.env.NEXT_PUBLIC_ZERO_G_RPC ?? 'https://evmrpc-testnet.0g.ai',
  chainId: Number(process.env.NEXT_PUBLIC_ZERO_G_CHAIN_ID ?? '16602'),
  registryAddr: process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDR ?? '',
  factoryAddr: process.env.NEXT_PUBLIC_LEASH_FACTORY_ADDR ?? '',
  /** E2E mode: Playwright runs with a local throwaway key instead of Privy login. */
  e2eMode: process.env.NEXT_PUBLIC_E2E_MODE === '1',
} as const;

export const EXPLORER_URL = 'https://chainscan-galileo.0g.ai';
export const STORAGE_EXPLORER_URL = 'https://storagescan-galileo.0g.ai';
