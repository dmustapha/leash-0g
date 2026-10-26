import { describe, it, expect, vi } from 'vitest';
import { assertBridgeRoutable } from '../../src/runtime/bridge-gate.js';
import {
  SameAddressMismatchError,
  UnregisteredChainError,
  type ChainRegistry,
} from '../../src/chain/registry.js';
import type { AgentRow } from '../../src/types.js';

/**
 * SE-8 carry #1 — the HARD pre-routing gate. `assertSameAddress`'s first
 * production caller: full shape (persisted tuple + salt, expectedAccountAddr
 * bound, homeChainId deployed-bytecode requirement) on home + destination.
 */

const BRIDGE = '0x4200000000000000000000000000000000000010';
const ACCOUNT = '0x' + '55'.repeat(20);
const HOME = 84532;
const DEST = 11155111;

const TUPLE = {
  ownerAddr: '0x' + '01'.repeat(20),
  guardianAddr: '0x' + '02'.repeat(20),
  sessionKeyAddr: '0x' + '03'.repeat(20),
  policy: { perTransferCap: '100', windowCap: '300', windowSeconds: 3600, expiresAt: 2000000000 },
  allowlist: [],
  timelockDelay: 0,
  settlementToken: '0x0000000000000000000000000000000000000000',
  tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
};

function agent(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'a1',
    chainId: HOME,
    accountAddr: ACCOUNT,
    accountVersion: 4,
    accountSalt: '0x' + 'ab'.repeat(32),
    accountCreateTuple: TUPLE,
    ...over,
  } as AgentRow;
}

function fakeRegistry(over: Partial<Record<string, unknown>> = {}): ChainRegistry {
  const cfgs: Record<number, unknown> = {
    [HOME]: {
      chainId: HOME,
      bridgeAllowlist: [BRIDGE],
      bridgeDestinations: { [BRIDGE]: DEST },
    },
    [DEST]: { chainId: DEST },
  };
  return {
    getChainConfig: (id: number) => {
      const c = cfgs[id];
      if (!c) throw new UnregisteredChainError(id);
      return c;
    },
    // SE-9 (L-02): the gate cross-checks the destination RPC's self-reported id.
    // By default each chain reports its own id (honest RPC → passes).
    getChainOps: (id: number) => ({ getChainId: async () => id }),
    assertSameAddress: vi.fn().mockResolvedValue(ACCOUNT),
    ...over,
  } as unknown as ChainRegistry;
}

describe('SE-8 assertBridgeRoutable — the HARD pre-routing gate (carry #1)', () => {
  it('PASSES for an allowlisted bridge with a registered destination + verified same-address', async () => {
    const reg = fakeRegistry();
    const out = await assertBridgeRoutable(reg, agent(), BRIDGE);
    expect(out).toEqual({ destinationChainId: DEST, verifiedAddr: ACCOUNT });
    // assertSameAddress called in its FULL production shape (M-01/L-02 bindings)
    const call = (reg.assertSameAddress as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.expectedAccountAddr).toBe(ACCOUNT);
    expect(call.homeChainId).toBe(HOME);
    expect(call.chainIds).toEqual([HOME, DEST]);
    expect(call.accountSalt).toBe(agent().accountSalt);
    expect(call.create.guardianAddr).toBe(TUPLE.guardianAddr); // create-time guardian, never the lane key
  });

  it('REFUSES an off-allowlist bridge target', async () => {
    await expect(assertBridgeRoutable(fakeRegistry(), agent(), '0x' + '99'.repeat(20))).rejects.toMatchObject({
      name: 'BridgeRoutingRefusedError',
      reason: 'bridge_not_allowlisted',
    });
  });

  it('REFUSES a bridge with no configured destination (far leg unverifiable)', async () => {
    const reg = fakeRegistry();
    (reg.getChainConfig as unknown) = (id: number) => {
      if (id === HOME) return { chainId: HOME, bridgeAllowlist: [BRIDGE], bridgeDestinations: {} };
      throw new UnregisteredChainError(id);
    };
    await expect(assertBridgeRoutable(reg, agent(), BRIDGE)).rejects.toMatchObject({ reason: 'no_destination' });
  });

  it('REFUSES when the destination chain is unregistered (default-deny, E-11)', async () => {
    const reg = fakeRegistry();
    (reg.getChainConfig as unknown) = (id: number) => {
      if (id === HOME) return { chainId: HOME, bridgeAllowlist: [BRIDGE], bridgeDestinations: { [BRIDGE]: 424242 } };
      throw new UnregisteredChainError(id);
    };
    await expect(assertBridgeRoutable(reg, agent(), BRIDGE)).rejects.toMatchObject({
      reason: 'destination_unregistered',
    });
  });

  it('REFUSES a non-V4 / salt-less agent (no deterministic address to verify)', async () => {
    await expect(assertBridgeRoutable(fakeRegistry(), agent({ accountVersion: 2 }), BRIDGE)).rejects.toMatchObject({
      reason: 'no_persisted_tuple',
    });
    await expect(assertBridgeRoutable(fakeRegistry(), agent({ accountSalt: null }), BRIDGE)).rejects.toMatchObject({
      reason: 'no_persisted_tuple',
    });
  });

  it('REFUSES a tuple-less agent (cannot replay byte-exact)', async () => {
    await expect(
      assertBridgeRoutable(fakeRegistry(), agent({ accountCreateTuple: null }), BRIDGE),
    ).rejects.toMatchObject({ reason: 'no_persisted_tuple' });
  });

  it('REFUSES when the destination RPC self-reports a DIFFERENT chain id (L-02)', async () => {
    const reg = fakeRegistry({
      // a mis-pointed destination RPC: reports some other chain, not DEST
      getChainOps: (id: number) => ({ getChainId: async () => (id === DEST ? 999999 : id) }),
    });
    await expect(assertBridgeRoutable(reg, agent(), BRIDGE)).rejects.toMatchObject({
      name: 'BridgeRoutingRefusedError',
      reason: 'destination_chainid_mismatch',
    });
  });

  it('WRAPS a SameAddressMismatchError as same_address_refused (funds never route)', async () => {
    const reg = fakeRegistry({
      assertSameAddress: vi
        .fn()
        .mockRejectedValue(new SameAddressMismatchError(DEST, 'predicted_address', '0xaaa', '0xbbb')),
    });
    await expect(assertBridgeRoutable(reg, agent(), BRIDGE)).rejects.toMatchObject({
      name: 'BridgeRoutingRefusedError',
      reason: 'same_address_refused',
    });
  });

  it('case-insensitive bridge matching (checksummed target vs lowercased allowlist)', async () => {
    const out = await assertBridgeRoutable(fakeRegistry(), agent(), BRIDGE.toUpperCase().replace('0X', '0x'));
    expect(out.destinationChainId).toBe(DEST);
  });
});

// AQ-FND M-4 — multi-domain rails: the destination comes from the DECODED call
// (CCTP domain / CCIP selector → rail-domains.ts), not the one-dest config map.
describe('M-4 assertBridgeRoutable — decoded rail destinations', () => {
  const RAIL = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'; // CCTP TokenMessenger (no bridgeDestinations entry)
  const railRegistry = (over: Partial<Record<string, unknown>> = {}) =>
    fakeRegistry({
      getChainConfig: (id: number) => {
        const cfgs: Record<number, unknown> = {
          [HOME]: { chainId: HOME, bridgeAllowlist: [BRIDGE, RAIL], bridgeDestinations: { [BRIDGE]: DEST } },
          [DEST]: { chainId: DEST },
          421614: { chainId: 421614 },
        };
        const c = cfgs[id];
        if (!c) throw new UnregisteredChainError(id);
        return c;
      },
      ...over,
    });
  const decodedWith = (dest: { kind: 'cctp_domain' | 'ccip_selector'; value: string }) =>
    ({ args: { bridgeDestination: dest } }) as never;

  it('resolves the destination from a decoded CCTP domain when the target has no config entry', async () => {
    const out = await assertBridgeRoutable(railRegistry(), agent(), RAIL, decodedWith({ kind: 'cctp_domain', value: '0' }));
    expect(out.destinationChainId).toBe(DEST); // domain 0 = Eth Sepolia
  });

  it('REFUSES an unknown rail domain (default-deny, never guesses)', async () => {
    await expect(
      assertBridgeRoutable(railRegistry(), agent(), RAIL, decodedWith({ kind: 'cctp_domain', value: '42' })),
    ).rejects.toMatchObject({ name: 'BridgeRoutingRefusedError', reason: 'unknown_rail_domain' });
  });

  it('REFUSES a rail call with no decoded destination AND no config entry', async () => {
    await expect(assertBridgeRoutable(railRegistry(), agent(), RAIL)).rejects.toMatchObject({
      name: 'BridgeRoutingRefusedError',
      reason: 'no_destination',
    });
  });

  it('REFUSES when the calldata destination disagrees with a config-named single destination', async () => {
    // BRIDGE is configured for DEST; calldata names Arbitrum Sepolia (domain 3) — refuse.
    await expect(
      assertBridgeRoutable(railRegistry(), agent(), BRIDGE, decodedWith({ kind: 'cctp_domain', value: '3' })),
    ).rejects.toMatchObject({ name: 'BridgeRoutingRefusedError', reason: 'destination_mismatch' });
  });

  it('config destination still wins when calldata agrees (back-compat with single-dest bridges)', async () => {
    const out = await assertBridgeRoutable(railRegistry(), agent(), BRIDGE, decodedWith({ kind: 'cctp_domain', value: '0' }));
    expect(out.destinationChainId).toBe(DEST);
  });
});
