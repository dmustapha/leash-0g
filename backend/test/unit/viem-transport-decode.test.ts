import { describe, it, expect } from 'vitest';
import { createPublicClient, custom, keccak256, toHex, type Hex } from 'viem';
import { viemLaneTransport } from '../../src/runtime/tx-intents/viem-transport.js';
import { decodeLeashError } from '../../src/chain/errors.js';
import { leashAccountAbi } from '../../src/chain/abis.js';

/**
 * Gate-2 B-2: a contract refusal must still decode into a plain reason on the lane path. On geth-style
 * nodes the revert data is in the RPC error's `data` field (NOT the message), so a bare estimateGas hides
 * it; simulating WITH the contract call lets viem decode it (what the legacy writeContract path did).
 */
const FROM = ('0x' + '11'.repeat(20)) as Hex;
const TO = ('0x' + '22'.repeat(20)) as Hex;
const NOT_OWNER = keccak256(toHex('NotOwner()')).slice(0, 10) as Hex;

function clientThatReverts() {
  return createPublicClient({
    transport: custom({
      async request({ method }) {
        if (method === 'eth_call' || method === 'eth_estimateGas') {
          // the geth shape: code 3, a bare message, the revert bytes in `data`
          throw Object.assign(new Error('execution reverted'), { code: 3, data: NOT_OWNER });
        }
        if (method === 'eth_chainId') return '0x1';
        return null;
      },
    }),
  });
}

describe('lane transport decodes wall refusals (review B-2)', () => {
  it('WITH the contract call it decodes the custom error into a plain refusal', async () => {
    const t = viemLaneTransport(clientThatReverts(), 1);
    let err: unknown;
    await t.estimate({ from: FROM, to: TO, data: '0x', value: 0n, sim: { abi: leashAccountAbi, functionName: 'execute', args: [TO, 0n, '0x'] } }).catch((e: unknown) => { err = e; });
    expect(err).toBeDefined();
    expect(decodeLeashError(err)?.errorName).toBe('NotOwner');
  });

  it('WITHOUT it the revert is not decodable (the regression the review reproduced) — so the lane must always pass it', async () => {
    const t = viemLaneTransport(clientThatReverts(), 1);
    let err: unknown;
    await t.estimate({ from: FROM, to: TO, data: '0x', value: 0n }).catch((e: unknown) => { err = e; });
    expect(err).toBeDefined();
    expect(decodeLeashError(err)).toBeNull();
  });
});
