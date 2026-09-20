import { describe, it, expect } from 'vitest';
import { generateGatewayToken, hashTokenSecret, verifyTokenSecret, parseGatewayToken } from '../../src/crypto/token.js';

describe('gateway tokens', () => {
  it('generates parseable tokens with distinct id and secret', async () => {
    const t = generateGatewayToken();
    expect(t.token).toMatch(/^leash_[0-9a-f]{16}_[0-9a-f]{64}$/);
    const parsed = parseGatewayToken(t.token);
    expect(parsed).not.toBeNull();
    expect(parsed?.tokenId).toBe(t.tokenId);
    expect(parsed?.secret).toBe(t.secret);
  });

  it('argon2id-hashes the secret and verifies it', async () => {
    const t = generateGatewayToken();
    const hash = await hashTokenSecret(t.secret);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyTokenSecret(hash, t.secret)).toBe(true);
    expect(await verifyTokenSecret(hash, t.secret.slice(0, -1) + '0')).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(parseGatewayToken('nope')).toBeNull();
    expect(parseGatewayToken('leash_short')).toBeNull();
    expect(parseGatewayToken('')).toBeNull();
  });

  it('two generated tokens never collide', () => {
    expect(generateGatewayToken().token).not.toBe(generateGatewayToken().token);
  });
});
