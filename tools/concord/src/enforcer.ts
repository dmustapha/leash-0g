import type { Objection, ProviderResult, Verdict } from './types.js';
import { runProvider } from './providers/index.js';

// The enforcer is DETERMINISTIC: no LLM. It tallies objections against provider results.
// Fail-closed on every ambiguity.
export async function enforce(objections: Objection[]): Promise<{ verdict: Verdict; results: Record<string, ProviderResult> }> {
  const results: Record<string, ProviderResult> = {};
  for (const obj of objections) {
    if (obj.status === 'withdrawn') continue;                 // skeptic conceded; not blocking
    if (obj.status !== 'resolved') return fail(results);      // still open => NO_AGREE
    const known = ['SECURITY', 'REGRESSION', 'CONTRACT', 'SCOPE'];
    if (!known.includes(obj.type)) return fail(results);      // unknown type => NO_AGREE
    let r: ProviderResult;
    try {
      r = await runProvider(obj.evidence_demand);             // may throw
    } catch (e) {
      results[obj.id] = { satisfied: false, evidence_ref: 'provider-error', detail: String(e) };
      return fail(results);                                   // provider threw => NO_AGREE
    }
    results[obj.id] = r;
    if (!r.satisfied || !r.evidence_ref) return fail(results); // unsatisfied/no evidence => NO_AGREE
  }
  return { verdict: 'AGREE', results };
}

function fail(results: Record<string, ProviderResult>) { return { verdict: 'NO_AGREE' as Verdict, results }; }
