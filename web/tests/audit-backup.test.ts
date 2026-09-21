import { describe, it, expect } from 'vitest';
import { generateAuditKeypair, buildAuditBackup } from '@/lib/crypto/audit-key';

/**
 * C-6 (spec §8 row "backup file contains NO plaintext privkey"): the
 * downloadable backup must carry the ENCRYPTED blob only.
 */
describe('audit key backup (C-6)', () => {
  it('contains the encrypted blob and NEVER the plaintext privkey', () => {
    const keypair = generateAuditKeypair();
    const blob = { mode: 'signature' as const, v: 2, iv: 'aWY=', ct: 'Y3Q=', salt: 's' };
    const content = buildAuditBackup({ agentId: 'agent-1', pubKeyHex: keypair.pubKeyHex, blob });

    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed['encryptedBlob']).toMatchObject({ mode: 'signature' });
    expect(parsed['auditPubKey']).toBe(keypair.pubKeyHex);
    // No plaintext key field of any spelling…
    expect(Object.keys(parsed).join(',')).not.toMatch(/priv/i);
    // …and the raw privkey hex never appears anywhere in the file.
    expect(content.includes(keypair.privKeyHex)).toBe(false);
    expect(content.toLowerCase().includes(keypair.privKeyHex.toLowerCase())).toBe(false);
  });
});
