// File: web/components/create/templates.ts
// Phase-5 (D-B5): curated create templates — static, no LLM call. Each `draft` is a valid
// ElevationDraft; picking a template loads it straight into ReadBack. Money is never guessed:
// no template carries a recipient/allowlist address, and a fee is present ONLY where the
// archetype itself is inherently fee-free (providers/evaluators never move money at all).
// The treasury template SUGGESTS conservative native caps the owner must acknowledge in the
// read-back — it never pre-fills a payee.
import type { CreateTemplate } from '@/lib/types';

/** 0.01 0G in wei — a conservative single-payment suggestion for the treasury archetype. */
const OG_0_01 = '10000000000000000';
/** 0.05 0G in wei — a conservative rolling-budget suggestion. */
const OG_0_05 = '50000000000000000';

export const CREATE_TEMPLATES: CreateTemplate[] = [
  {
    id: 'market-forecaster',
    title: 'Market forecaster',
    blurb: 'Answers market questions with calibrated probability estimates. It only produces work — it can never move money.',
    draft: {
      proposedRole: 'provider',
      rationale:
        'You want an agent that gives calibrated probability estimates for market questions. That is a work-producing job, so it is set up as a provider: it reasons and delivers a verifiable answer, and never touches money.',
      capabilityLabel: 'market forecaster',
      serviceSpec: 'Calibrated probability estimates for market questions, with a short justification.',
      moneyPower: 'cannot-move-money',
      unsureFields: [],
      confidence: 'high',
    },
  },
  {
    id: 'research-summarizer',
    title: 'Research summarizer',
    blurb: 'Reads sources and returns a grounded, cited summary. It only produces work — it can never move money.',
    draft: {
      proposedRole: 'provider',
      rationale:
        'You want an agent that reads material and returns a concise, grounded summary. That is a work-producing job, so it is set up as a provider: it delivers a verifiable summary and never touches money.',
      capabilityLabel: 'research summarizer',
      serviceSpec: 'Grounded summaries of supplied sources, with claims traceable to the input.',
      moneyPower: 'cannot-move-money',
      unsureFields: [],
      confidence: 'high',
    },
  },
  {
    id: 'allowance-keeper',
    title: 'Allowance keeper',
    blurb: 'Watches a wallet and tops it up within limits you set. It can move money — you confirm the caps and the recipient.',
    draft: {
      proposedRole: 'treasury',
      rationale:
        'You want an agent that keeps a wallet funded on its own. That means it can move money, so it is set up as a treasury manager with conservative suggested limits. You confirm the caps below, and you must fill in which wallet it may top up — that is never guessed.',
      capabilityLabel: 'allowance keeper',
      suggestedPolicy: { perTransferCapWei: OG_0_01, windowCapWei: OG_0_05, windowSeconds: 24 * 3600 },
      moneyPower: 'can-move-money',
      // The beneficiary/payee ADDRESS is deliberately absent — never-guess-money (spec §8).
      unsureFields: ['goal.beneficiary'],
      confidence: 'low',
    },
  },
];
