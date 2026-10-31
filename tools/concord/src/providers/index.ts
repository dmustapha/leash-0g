// providers/index.ts
import type { EvidenceDemand, ProviderResult } from '../types.js';
import { verifyProvider } from './verify.js';
import { secureProvider } from './secure.js';
import { releaseProvider } from './release.js';
import { monitorProvider } from './monitor.js';

export function runProvider(d: EvidenceDemand): Promise<ProviderResult> {
  switch (d.stage) {
    case 'verify': return verifyProvider(d);
    case 'secure': return secureProvider(d);
    case 'release': return releaseProvider(d);
    case 'monitor': return monitorProvider(d);
    default: throw new Error(`unknown stage: ${(d as any).stage}`);
  }
}
