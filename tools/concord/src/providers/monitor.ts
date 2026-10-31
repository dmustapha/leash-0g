// providers/monitor.ts — probes the live health endpoint (VERIFIED: api.leash.ink/healthz => 200).
import type { EvidenceDemand, ProviderResult } from '../types.js';

export async function monitorProvider(d: EvidenceDemand): Promise<ProviderResult> {
  const url = d.check || process.env.CONCORD_MONITOR_URL || 'https://api.leash.ink/healthz';
  try {
    const res = await fetch(url, { method: 'GET' });
    const ok = res.status === 200;
    return { satisfied: ok, evidence_ref: `monitor:${res.status}:${new Date().toISOString()}` };
  } catch (e) {
    // Network error => fail-closed (cannot confirm health).
    return { satisfied: false, evidence_ref: `monitor:error:${new Date().toISOString()}`, detail: String(e) };
  }
}
