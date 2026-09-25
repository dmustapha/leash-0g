// File: web/components/create/draft-to-prefill.ts
// Phase-5 (D-B3): pure mapping from a CONFIRMED ElevationDraft (+ the owner-typed recipient) onto
// a WizardPrefill that seeds the wizard's review step. Kept in its own module (not the page) so it
// is importable + unit-testable and does not violate Next's page-export constraints.
//
// NEVER-GUESS-MONEY (spec §8): the recipient/allowlist address comes ONLY from `recipient`
// (owner-typed in the read-back), NEVER from the model draft. The requester's settlement token
// and per-token caps are NOT in the draft, so they are left BLANK for the owner to complete in the
// wizard review — nothing is fabricated here.
import type { Address } from 'viem';
import type { ElevationDraft, PolicyInput } from '@/lib/types';
import type { WizardPrefill } from './CreateWizard';

const DEFAULT_WINDOW_SECONDS = 24 * 3600;

function defaultExpiry(): number {
  return Math.floor(Date.now() / 1000) + 7 * 86400;
}

export function draftToPrefill(draft: ElevationDraft, recipient?: string): WizardPrefill {
  const role = draft.proposedRole;
  const label = draft.capabilityLabel?.trim();
  const withLabel = <T extends object>(o: T): T & { capabilityLabel?: string } =>
    label ? { ...o, capabilityLabel: label } : o;

  const zeroPolicy: PolicyInput = {
    perTransferCapWei: '0',
    windowCapWei: '0',
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    expiresAt: defaultExpiry(),
  };
  const nativePolicy = (): PolicyInput => {
    const p = draft.suggestedPolicy;
    return p
      ? { perTransferCapWei: p.perTransferCapWei, windowCapWei: p.windowCapWei, windowSeconds: p.windowSeconds, expiresAt: defaultExpiry() }
      : { perTransferCapWei: '10000000000000000', windowCapWei: '50000000000000000', windowSeconds: DEFAULT_WINDOW_SECONDS, expiresAt: defaultExpiry() };
  };

  if (role === 'provider') {
    return withLabel({
      name: label || 'New provider',
      policy: zeroPolicy,
      allowlist: [],
      goal: { type: 'provider', serviceSpec: draft.serviceSpec ?? '' },
    });
  }
  if (role === 'evaluator') {
    return withLabel({
      name: label || 'New evaluator',
      policy: zeroPolicy,
      allowlist: [],
      goal: { type: 'evaluator', rubricRef: draft.rubricRef ?? '' },
    });
  }
  if (role === 'treasury') {
    return withLabel({
      name: label || 'New allowance keeper',
      policy: nativePolicy(),
      allowlist: recipient ? [recipient as Address] : [],
      goal: {
        beneficiary: (recipient ?? '') as Address, // treasury watches + pays the same wallet
        targetBalanceWei: '100000000000000000',
        topUpWei: '10000000000000000',
      },
    });
  }
  if (role === 'executor') {
    return withLabel({
      name: label || 'New executor',
      policy: nativePolicy(),
      allowlist: recipient ? [recipient as Address] : [],
      goal: { type: 'executor' },
    });
  }
  if (role === 'sentinel') {
    // Spend-incapable watcher (roleMovesMoney→false, so no recipient is collected in
    // the read-back): it watches a beneficiary wallet and only ASKS a linked agent to
    // pay. The beneficiary is left BLANK for the owner to complete in the wizard.
    return withLabel({
      name: label || 'New watcher',
      policy: zeroPolicy,
      allowlist: [],
      goal: {
        type: 'sentinel',
        beneficiary: '' as Address,
        targetBalanceWei: '100000000000000000',
        topUpWei: '10000000000000000',
      },
    });
  }
  // requester: token, per-token caps, and provider/evaluator links are NOT in the draft — left
  // BLANK for the owner to fill in the wizard review. Recipient is the owner-typed address.
  return withLabel({
    name: label || 'New requester',
    policy: zeroPolicy,
    allowlist: recipient ? [recipient as Address] : [],
    goal: {
      type: 'requester',
      jobSpecSource: '',
      providerAgentId: '',
      evaluatorAgentId: '',
      feeToken: '' as Address,
      feeRecipient: (recipient ?? '') as Address,
      feeCapPerJobWei: draft.suggestedFeeBaseUnits ?? '',
    },
  });
}
