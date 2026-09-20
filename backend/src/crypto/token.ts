import { randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Gateway bearer tokens: `leash_<tokenId:8B hex>_<secret:32B hex>`.
 * The tokenId gives O(1) row lookup; only argon2id(secret) is stored at rest.
 * Agent identity derives ONLY from this token (M-01) — never from headers.
 */
export interface GeneratedToken {
  token: string;
  tokenId: string;
  secret: string;
}

const TOKEN_RE = /^leash_([0-9a-f]{16})_([0-9a-f]{64})$/;

export function generateGatewayToken(): GeneratedToken {
  const tokenId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return { token: `leash_${tokenId}_${secret}`, tokenId, secret };
}

export function parseGatewayToken(token: string): { tokenId: string; secret: string } | null {
  const m = TOKEN_RE.exec(token);
  if (!m?.[1] || !m[2]) return null;
  return { tokenId: m[1], secret: m[2] };
}

export async function hashTokenSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifyTokenSecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

/** Constant-time comparison for non-hashed short-lived comparisons. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
