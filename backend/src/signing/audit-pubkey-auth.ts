import { recoverTypedDataAddress, type Hex } from 'viem';
import type { Pool, PoolClient } from 'pg';

/**
 * NC-2 (tear-apart): the audit/stream pubkey rotation routes used to be
 * authenticated by Privy SESSION only (access-control) — a forged/stolen
 * session or a DB-admin could repoint FUTURE audit batches to an attacker's
 * pubkey and silently leak forward audit confidentiality. The fix: the owner
 * must sign the rotation with an EIP-712 SetAuditPubkey message; we recover the
 * signer with ecrecover and assert it equals the authenticated owner before any
 * key write. Session auth stays (it scopes the route); this adds a crypto wall
 * on top, fail-closed — a missing/wrong signature → no rotation.
 */

/** The literal `target` for the owner-stream routes (the agent routes use the agentId). */
export const OWNER_STREAM_TARGET = 'owner-stream';

export const SET_AUDIT_PUBKEY_TYPES = {
  SetAuditPubkey: [
    { name: 'owner', type: 'address' },
    { name: 'target', type: 'string' },
    { name: 'pubkey', type: 'string' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface SetAuditPubkeyMessage {
  owner: Hex;
  target: string;
  pubkey: string;
  nonce: bigint;
}

function domain(chainId: number) {
  return { name: 'LEASH', version: '1', chainId } as const;
}

export class RotationSignatureError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RotationSignatureError';
  }
}

/**
 * Recover the SetAuditPubkey signer and assert it equals `ownerAddr`. Throws
 * RotationSignatureError (→ 403 at the route) on any mismatch. Pure crypto — no
 * DB, no replay check (that is the caller's monotonic-nonce txn).
 */
export async function recoverSetAuditPubkeySigner(args: {
  chainId: number;
  ownerAddr: string;
  target: string;
  pubkey: string;
  nonce: bigint;
  signature: string;
}): Promise<void> {
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: domain(args.chainId),
      types: SET_AUDIT_PUBKEY_TYPES,
      primaryType: 'SetAuditPubkey',
      message: {
        owner: args.ownerAddr as Hex,
        target: args.target,
        pubkey: args.pubkey,
        nonce: args.nonce,
      } satisfies SetAuditPubkeyMessage,
      signature: args.signature as Hex,
    });
  } catch {
    throw new RotationSignatureError('invalid signature');
  }
  if (recovered.toLowerCase() !== args.ownerAddr.toLowerCase()) {
    throw new RotationSignatureError('signature does not match owner');
  }
}

/**
 * Advance the per-(owner, target) monotonic replay nonce inside `client`'s open
 * txn. Throws RotationSignatureError when `nonce <= last_nonce` so a signature
 * cannot be replayed. Call AFTER recoverSetAuditPubkeySigner, in the SAME txn as
 * the key write, so the nonce only advances when the rotation commits.
 */
export async function consumeRotationNonce(
  client: PoolClient,
  ownerAddr: string,
  target: string,
  nonce: bigint,
): Promise<void> {
  const res = await client.query<{ last_nonce: string }>(
    `INSERT INTO audit_pubkey_rotation_nonce (owner_addr, target, last_nonce)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_addr, target)
       DO UPDATE SET last_nonce = EXCLUDED.last_nonce, updated_at = now()
       WHERE audit_pubkey_rotation_nonce.last_nonce < EXCLUDED.last_nonce
     RETURNING last_nonce`,
    [ownerAddr.toLowerCase(), target, nonce.toString()],
  );
  if (res.rowCount === 0) throw new RotationSignatureError('nonce already used');
}

/** Read the current monotonic nonce for a (owner, target); -1 when none set. */
export async function currentRotationNonce(
  pool: Pool,
  ownerAddr: string,
  target: string,
): Promise<bigint> {
  const res = await pool.query<{ last_nonce: string }>(
    `SELECT last_nonce FROM audit_pubkey_rotation_nonce WHERE owner_addr = $1 AND target = $2`,
    [ownerAddr.toLowerCase(), target],
  );
  return res.rows[0] ? BigInt(res.rows[0].last_nonce) : -1n;
}
