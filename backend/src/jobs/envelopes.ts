import { z } from 'zod';

/**
 * The four Phase-4 ACP envelope kinds (spec §3b). These are OPAQUE to the
 * coordination layer — `kind`/`payload` stay generic in links/delegations
 * (generality guard); they are interpreted ONLY here and in the job runtime.
 * Every payload is UNTRUSTED (crosses an agent boundary), so it is
 * strict-validated (`.strict()`) before any use, exactly like Phase-2's
 * transfer.request. Delegations carry ZERO authority: the fee amount and
 * settlement target come from server link/spec state, never from these
 * payloads (F4).
 *
 * Link topology (F6 — requester is the hub):
 *   requester → provider   : job.request
 *   provider  → requester  : job.deliver   (also fans to evaluator via requester)
 *   requester → evaluator  : job.evaluate
 *   evaluator → requester  : job.verdict
 */

export const JOB_KINDS = ['job.request', 'job.deliver', 'job.evaluate', 'job.verdict'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const hex40 = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const nonEmpty = z.string().min(1).max(4000);
/** A 0G Storage Merkle root (content address) — 0x + 64 hex. */
const root32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/**
 * The owner-seeded job spec (F5) — lives in SERVER state, is signed by the
 * requester, and is what the provider fulfils. The requester EXECUTES it; it
 * never invents the question (autonomous need-detection is deferred).
 */
export const jobSpecSchema = z
  .object({
    question: z.string().min(1).max(8000),
    context: z.string().max(16_000).optional(),
    /** Opaque handle to the deliverable JSON schema the provider must satisfy. */
    deliverableSchemaRef: z.string().min(1).max(200),
    /** Opaque handle to the acceptance rule set (F2 — generic engine, see acceptance.ts). */
    acceptanceRef: z.string().min(1).max(200),
  })
  .strict();
export type JobSpec = z.infer<typeof jobSpecSchema>;

// ---- envelope payload schemas (UNTRUSTED, strict) ----

export const jobRequestPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    spec: jobSpecSchema,
    /** Echoed for the provider's context; authority still comes from server state. */
    feeToken: hex40,
    feeAmountWei: z.string().regex(/^\d{1,30}$/),
    deadlineUnix: z.number().int().positive(),
  })
  .strict();
export type JobRequestPayload = z.infer<typeof jobRequestPayloadSchema>;

export const jobDeliverPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    /** 0G Storage Merkle root of the (owner-encrypted) deliverable. */
    deliverableRoot: root32,
    /** Short plain-text summary — QUARANTINED-untrusted at the edge (F-quar). */
    deliverableSummary: nonEmpty,
    /** Provider session-key signature over the deliverable root (F7 — PoA). */
    providerSig: z.string().min(1).max(400),
  })
  .strict();
export type JobDeliverPayload = z.infer<typeof jobDeliverPayloadSchema>;

export const jobEvaluatePayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    deliverableRoot: root32,
    /** keccak hash of the canonical job spec (binds the verdict to the spec). */
    jobSpecHash: root32,
  })
  .strict();
export type JobEvaluatePayload = z.infer<typeof jobEvaluatePayloadSchema>;

export const jobVerdictPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    verdict: z.enum(['accept', 'reject']),
    /** 0G Storage root of the evaluator's reasoned rationale. */
    rationaleRef: root32,
    /** Evaluator session-key signature over (jobId|verdict|deliverableRoot) (F7). */
    evaluatorSig: z.string().min(1).max(400),
  })
  .strict();
export type JobVerdictPayload = z.infer<typeof jobVerdictPayloadSchema>;

/** Parse an inbound job envelope by kind. Returns null on any mismatch. */
export function parseJobPayload(kind: string, payload: unknown):
  | { kind: 'job.request'; payload: JobRequestPayload }
  | { kind: 'job.deliver'; payload: JobDeliverPayload }
  | { kind: 'job.evaluate'; payload: JobEvaluatePayload }
  | { kind: 'job.verdict'; payload: JobVerdictPayload }
  | null {
  switch (kind) {
    case 'job.request': {
      const r = jobRequestPayloadSchema.safeParse(payload);
      return r.success ? { kind, payload: r.data } : null;
    }
    case 'job.deliver': {
      const r = jobDeliverPayloadSchema.safeParse(payload);
      return r.success ? { kind, payload: r.data } : null;
    }
    case 'job.evaluate': {
      const r = jobEvaluatePayloadSchema.safeParse(payload);
      return r.success ? { kind, payload: r.data } : null;
    }
    case 'job.verdict': {
      const r = jobVerdictPayloadSchema.safeParse(payload);
      return r.success ? { kind, payload: r.data } : null;
    }
    default:
      return null;
  }
}

export function isJobKind(kind: string): kind is JobKind {
  return (JOB_KINDS as readonly string[]).includes(kind);
}
