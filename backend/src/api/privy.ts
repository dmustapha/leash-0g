import { PrivyClient } from '@privy-io/server-auth';

/**
 * Owner authentication: verify the Privy access token and resolve the owner's
 * wallet address. All owner routes compare this address to agents.owner_addr —
 * the stored Privy wallet address is the authority (see migrations/001 note:
 * the on-chain registry entry is registered by the ops key, so registry owner
 * is ops; Postgres owner_addr is what governs owner-API access, and the same
 * address is the LeashAccount contract owner).
 */
export interface PrivyVerifier {
  verify(authorizationHeader: string | undefined): Promise<{ ownerAddr: string }>;
}

export function createPrivyVerifier(appId: string, appSecret: string): PrivyVerifier {
  const client = new PrivyClient(appId, appSecret);
  return {
    async verify(authorizationHeader) {
      const token = /^Bearer (.+)$/.exec(authorizationHeader ?? '')?.[1];
      if (!token) throw new Error('missing bearer token');
      const claims = await client.verifyAuthToken(token);
      const user = await client.getUserById(claims.userId);
      const wallet = user.linkedAccounts.find(
        (a): a is Extract<(typeof user.linkedAccounts)[number], { type: 'wallet' }> => a.type === 'wallet',
      );
      if (!wallet?.address) throw new Error('no wallet linked to Privy user');
      return { ownerAddr: wallet.address.toLowerCase() };
    },
  };
}
