import { describe, it, expect } from 'vitest';
import { parseExtraChains } from '../../src/config.js';
import { ChainRegistry, type ChainConfig } from '../../src/chain/registry.js';

/**
 * RH2 (two-factory, SE-9) — a chain may carry a default (same-address) wall
 * factory AND named SECONDARY wall-capability factories (e.g. `oracleBand` → the
 * price-band wall). The security property: a create targets a capability BY NAME;
 * the resolved factory address is operator-config, never caller input — and an
 * off-config factory is DEFAULT-DENY, so an arbitrary factory can never be
 * injected into the deploy path.
 */

const SIGNING = { opsPrivateKey: '0x' + '11'.repeat(32), guardianPrivateKey: '0x' + '22'.repeat(32) };
const DEFAULT_V4 = '0x' + '44'.repeat(20);
const BAND = '0x85e1758d29d2f5026e8b36664e41c6c891d0ff70';

function rhEntry(extra: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      chainId: 46630,
      name: 'Robinhood Chain testnet',
      rpcUrl: 'http://rpc-rh.leash-test.local',
      registryAddr: '0x' + 'cc'.repeat(20),
      factoryV4Addr: DEFAULT_V4,
      ...extra,
    },
  ]);
}

describe('RH2 — capabilityFactories config parse (fail-loud, bounded, lowercased)', () => {
  it('parses a named capability factory and lowercases it', () => {
    const c = parseExtraChains(rhEntry({ capabilityFactories: { oracleBand: BAND.toUpperCase().replace('0X', '0x') } }))[0]!;
    expect(c.capabilityFactories).toEqual({ oracleBand: BAND });
  });

  it('absent capabilityFactories ⇒ undefined (default-only chain)', () => {
    const c = parseExtraChains(rhEntry())[0]!;
    expect(c.capabilityFactories).toBeUndefined();
  });

  it('rejects a non-address capability factory (L-03 fail-loud)', () => {
    expect(() => parseExtraChains(rhEntry({ capabilityFactories: { oracleBand: '0xnope' } }))).toThrow();
  });

  it('rejects more than 8 capability factories (L-02 bound)', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`cap${i}`, '0x' + String(i).padStart(2, '0').repeat(20)]));
    expect(() => parseExtraChains(rhEntry({ capabilityFactories: many }))).toThrow(/too many capabilityFactories/);
  });
});

describe('RH2 — registry capability-factory resolution (default-deny)', () => {
  const rh: ChainConfig = {
    chainId: 46630, name: 'Robinhood Chain testnet', rpcUrl: 'http://rpc-rh.leash-test.local',
    factoryV4Addr: DEFAULT_V4, registryAddr: '0x' + 'cc'.repeat(20), accountVersion: 4, gasFloorWei: 0n,
    capabilityFactories: { oracleBand: BAND },
  };
  const registry = new ChainRegistry([rh], SIGNING);

  it('resolves a named capability factory, undefined for an unknown name', () => {
    expect(registry.getCapabilityFactory(46630, 'oracleBand')).toBe(BAND);
    expect(registry.getCapabilityFactory(46630, 'bogus')).toBeUndefined();
  });

  it('getChainOpsForFactory accepts the default and the capability factory', () => {
    expect(() => registry.getChainOpsForFactory(46630, DEFAULT_V4)).not.toThrow();
    expect(() => registry.getChainOpsForFactory(46630, BAND)).not.toThrow();
  });

  it('getChainOpsForFactory DEFAULT-DENIES an off-config factory address', () => {
    expect(() => registry.getChainOpsForFactory(46630, '0x' + 'de'.repeat(20))).toThrow(/default-deny/);
  });

  it('the default-factory lane is the shared cached ops lane (byte-identical wire)', () => {
    expect(registry.getChainOpsForFactory(46630, DEFAULT_V4)).toBe(registry.getChainOps(46630));
  });

  it('the capability-factory lane is distinct from the default lane', () => {
    expect(registry.getChainOpsForFactory(46630, BAND)).not.toBe(registry.getChainOps(46630));
  });
});
