// providers/release.ts — checks a GitLab environment/deployment status (or release-ready in SPRINT).
import { existsSync, readFileSync } from 'node:fs';
import type { EvidenceDemand, ProviderResult } from '../types.js';

// SPRINT default (per ARCH §15.4): the GitLab Environments API call is omitted; instead we read a
// release-readiness marker written by the deploy job. A release is "available" iff the marker is
// present and reads as ready. Fail-closed: no token AND no satisfied marker => satisfied:false.
//
// Resolution order for d.check:
//   - if d.check names an env var that is set to a truthy readiness value -> available
//   - else if d.check is a path to a marker file whose trimmed contents match d.expect
//     (default "available") -> available
//   - else NOT ready.

const TRUTHY = new Set(['available', 'ready', 'true', '1', 'ok']);

function markerSatisfies(raw: string, expect: string): boolean {
  const v = raw.trim().toLowerCase();
  if (expect && v === expect.trim().toLowerCase()) return true;
  return TRUTHY.has(v);
}

export async function releaseProvider(d: EvidenceDemand): Promise<ProviderResult> {
  const expect = d.expect || 'available';

  // 1. Env-var marker path (e.g. d.check = "RELEASE_READY").
  if (d.check && Object.prototype.hasOwnProperty.call(process.env, d.check)) {
    const val = process.env[d.check] ?? '';
    if (markerSatisfies(val, expect)) {
      return { satisfied: true, evidence_ref: `release:env:${d.check}=${val}` };
    }
    return { satisfied: false, evidence_ref: `release:env-not-ready:${d.check}`, detail: `env ${d.check}=${val}` };
  }

  // 2. Marker file path.
  if (d.check && existsSync(d.check)) {
    const contents = readFileSync(d.check, 'utf8');
    if (markerSatisfies(contents, expect)) {
      return { satisfied: true, evidence_ref: `release:marker:${d.check}` };
    }
    return { satisfied: false, evidence_ref: `release:marker-not-ready:${d.check}`, detail: contents.slice(0, 200) };
  }

  // 3. No marker reachable. Without a token to call the live Environments API we cannot
  //    confirm readiness, so we fail closed.
  const token = process.env.GITLAB_TOKEN ?? process.env.CI_JOB_TOKEN;
  if (!token) return { satisfied: false, evidence_ref: 'release:no-token' };
  return { satisfied: false, evidence_ref: 'release:no-marker', detail: `no env/file marker for check "${d.check}"` };
}
