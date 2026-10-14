// NC-2: the owner must prove an audit/stream pubkey rotation with an EIP-712
// signature the backend verifies by ecrecover (not just a Privy session). This
// mirrors backend/src/signing/audit-pubkey-auth.ts — keep the two in lockstep.
import type { SignTypedData } from '../owner-wallet';

export const OWNER_STREAM_TARGET = 'owner-stream';

export const SET_AUDIT_PUBKEY_TYPES = {
  SetAuditPubkey: [
    { name: 'owner', type: 'address' },
    { name: 'target', type: 'string' },
    { name: 'pubkey', type: 'string' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Sign SetAuditPubkey(owner,target,pubkey,nonce) and return { signature, nonce }. */
export async function signSetAuditPubkey(
  signTypedData: SignTypedData,
  args: { owner: string; chainId: number; target: string; pubkey: string; nonce: bigint },
): Promise<{ signature: string; nonce: string }> {
  const signature = await signTypedData({
    domain: { name: 'LEASH', version: '1', chainId: args.chainId },
    types: SET_AUDIT_PUBKEY_TYPES,
    primaryType: 'SetAuditPubkey',
    message: { owner: args.owner, target: args.target, pubkey: args.pubkey, nonce: args.nonce },
  });
  return { signature, nonce: args.nonce.toString() };
}
