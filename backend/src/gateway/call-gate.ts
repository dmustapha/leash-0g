import { decodeAbiParameters } from 'viem';
import {
  classify,
  decodeCall,
  type Classification,
  type DecodedCall,
  type GrantState,
  type Novelty,
  WRAPPER_SELECTORS,
} from '../governed-call/index.js';

/**
 * The governed-call gate (spec §3b, D-5/D-8) — the OFF-CHAIN classifier the
 * runtime consults BEFORE submitting an `executeCall` (so a novel call becomes a
 * JIT request instead of a guaranteed on-chain revert + P3C-6 futile-retry burn).
 * It ONLY narrows: the on-chain wall is the guarantee; this gate can never let an
 * out-of-envelope call reach the chain (D-13b). Loopback-only (it runs inside the
 * runtime service, never on a public surface).
 *
 * D-5 (call wrapping, C-03): a multicall/batch wrapper is decoded RECURSIVELY and
 * EVERY leaf is re-checked against the grammar to a depth cap; a leaf that is
 * forbidden makes the whole wrapper forbidden; an UNKNOWN batcher (a wrapper we
 * cannot decode) is REFUSED (fail-closed), never surfaced.
 */

const MAX_UNWRAP_DEPTH = 4;
const MAX_LEAVES = 64;

export interface GateResult {
  decoded: DecodedCall;
  classification: Classification;
  /** decoded leaves when the call was a wrapper (for the legible card + trace). */
  leaves?: GateResult[];
}

export function classifyIntendedCall(
  target: string,
  value: bigint,
  data: string,
  grant: GrantState,
  self: string,
): GateResult {
  return classifyInner(target, value, data, grant, self, 0);
}

function classifyInner(
  target: string,
  value: bigint,
  data: string,
  grant: GrantState,
  self: string,
  depth: number,
): GateResult {
  const decoded = decodeCall(target, value, data);
  const selector = decoded.selector.toLowerCase();

  // Not a wrapper → the ordinary three-lane classify.
  if (!WRAPPER_SELECTORS.has(selector)) {
    return { decoded, classification: classify(decoded, grant, self) };
  }

  // A wrapper. Depth cap first (a nested-wrapper bomb is refused, not surfaced).
  if (depth >= MAX_UNWRAP_DEPTH) {
    return { decoded, classification: { lane: 'forbidden', reason: 'unknown_batcher' } };
  }

  const leafCalls = tryUnwrap(decoded);
  if (leafCalls === null) {
    // Undecodable wrapper = unknown batcher → REFUSE (fail-closed, D-5).
    return { decoded, classification: { lane: 'forbidden', reason: 'unknown_batcher' } };
  }

  // Every leaf targets the SAME contract (the router calls itself — Uniswap/Multicall3
  // self-batch pattern). Re-check each leaf against the grammar, recursively.
  const leaves: GateResult[] = [];
  const novelty: Novelty[] = [];
  let anyForbidden: Classification | null = null;
  for (const leafData of leafCalls) {
    const res = classifyInner(target, 0n, leafData, grant, self, depth + 1);
    leaves.push(res);
    if (res.classification.lane === 'forbidden') anyForbidden = res.classification;
    else if (res.classification.lane === 'l2') novelty.push(...res.classification.novelty);
  }

  // Fail-closed aggregation: any forbidden leaf → forbidden; else any novel → L2; else L1.
  let classification: Classification;
  if (anyForbidden) classification = anyForbidden;
  else if (novelty.length > 0) classification = { lane: 'l2', novelty: [...new Set(novelty)] };
  else classification = { lane: 'l1', reason: 'in_envelope' };

  return { decoded, classification, leaves };
}

/**
 * Decode a known wrapper's inner call bytes. Returns the leaf calldata array, or
 * `null` if the wrapper cannot be decoded canonically (→ unknown-batcher refuse).
 */
function tryUnwrap(decoded: DecodedCall): string[] | null {
  const spec = WRAPPER_SELECTORS.get(decoded.selector.toLowerCase());
  if (!spec) return null;
  try {
    const argData = ('0x' + decoded.data.slice(10)) as `0x${string}`;
    let leaves: readonly `0x${string}`[];
    if (spec.kind === 'multicall_bytes' && spec.signature.includes('uint256 deadline')) {
      const [, arr] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'bytes[]' }],
        argData,
      ) as [bigint, readonly `0x${string}`[]];
      leaves = arr;
    } else {
      const [arr] = decodeAbiParameters([{ type: 'bytes[]' }], argData) as [readonly `0x${string}`[]];
      leaves = arr;
    }
    if (leaves.length > MAX_LEAVES) return null; // return-bomb / gas-grief bound (M-02)
    return leaves.map((l) => l.toLowerCase());
  } catch {
    return null;
  }
}
