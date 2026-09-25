// File: web/tests/read-back.test.tsx
// Phase-5 (D-B3/D-B4/D-B6): the load-bearing, security-critical read-back unit.
// Covers: both tiers render; the address field is NEVER pre-filled and IS blank-required; the fee
// is blank unless the draft carried a stated amount; the money-power line reflects draft.moneyPower;
// editing a field then confirm passes the edited draft; an unsure field shows the inline flag; and
// the rationale renders as PLAIN TEXT (no dangerouslySetInnerHTML anywhere).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadBack } from '@/components/create/ReadBack';
import type { ElevationDraft } from '@/lib/types';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function providerDraft(over: Partial<ElevationDraft> = {}): ElevationDraft {
  return {
    proposedRole: 'provider',
    rationale: 'A work-producing agent that gives calibrated odds.',
    capabilityLabel: 'market forecaster',
    serviceSpec: 'calibrated probabilities',
    moneyPower: 'cannot-move-money',
    unsureFields: [],
    confidence: 'high',
    ...over,
  };
}

function treasuryDraft(over: Partial<ElevationDraft> = {}): ElevationDraft {
  return {
    proposedRole: 'treasury',
    rationale: 'An agent that keeps a wallet topped up.',
    capabilityLabel: 'allowance keeper',
    suggestedPolicy: { perTransferCapWei: '10000000000000000', windowCapWei: '50000000000000000', windowSeconds: 86400 },
    moneyPower: 'can-move-money',
    unsureFields: ['goal.beneficiary'],
    confidence: 'low',
    ...over,
  };
}

describe('ReadBack — tiers + quarantine + never-guess-money', () => {
  it('renders BOTH tiers and the plain-text rationale', () => {
    render(<ReadBack draft={providerDraft()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('read-back')).toBeInTheDocument();
    expect(screen.getByTestId('tier-what-it-does')).toBeInTheDocument();
    expect(screen.getByTestId('tier-the-leash')).toBeInTheDocument();
    expect(screen.getByTestId('read-back-rationale')).toHaveTextContent('calibrated odds');
  });

  it('money-power line reflects draft.moneyPower (catchable wrong-role)', () => {
    render(<ReadBack draft={providerDraft()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('read-back-money-power')).toHaveTextContent(/can never move money/i);
    cleanup();
    render(<ReadBack draft={treasuryDraft()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('read-back-money-power')).toHaveTextContent(/can move money/i);
  });

  it('a spend-incapable role shows NO address/fee inputs (nothing to arm)', () => {
    render(<ReadBack draft={providerDraft()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByTestId('rb-recipient')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rb-fee')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-back-no-money-note')).toBeInTheDocument();
  });

  it('address field is NEVER pre-filled and IS blank-required (never-guess-money)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ReadBack draft={treasuryDraft()} onConfirm={onConfirm} onBack={vi.fn()} />);
    // Blank on render — no address ever came from the draft.
    expect(screen.getByTestId('rb-recipient')).toHaveValue('');
    // Confirm with a blank address is blocked.
    await user.click(screen.getByTestId('read-back-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/never guessed/i);
    // Fill it, then confirm succeeds and the recipient is passed OUT-OF-BAND (not in the draft).
    await user.type(screen.getByTestId('rb-recipient'), RECIPIENT);
    await user.click(screen.getByTestId('read-back-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [edited, recipient] = onConfirm.mock.calls[0]!;
    expect(recipient).toBe(RECIPIENT);
    // The recipient is NOT smuggled into the quarantined draft object.
    expect(JSON.stringify(edited)).not.toContain(RECIPIENT);
  });

  it('fee is blank unless the draft carried a stated amount (suggestedFeeBaseUnits)', () => {
    render(<ReadBack draft={treasuryDraft()} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('rb-fee')).toHaveValue(''); // no stated amount → blank
    cleanup();
    render(<ReadBack draft={treasuryDraft({ suggestedFeeBaseUnits: '5000000' })} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTestId('rb-fee')).toHaveValue('5000000'); // stated → shown
  });

  it('an unsure field shows the inline "please check" flag (D-B6)', () => {
    render(<ReadBack draft={treasuryDraft({ unsureFields: ['suggestedPolicy.perTransferCapWei'] })} onConfirm={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getAllByTestId('unsure-flag').length).toBeGreaterThan(0);
  });

  it('editing a descriptive field then confirm passes the EDITED draft', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ReadBack draft={providerDraft()} onConfirm={onConfirm} onBack={vi.fn()} />);
    const svc = screen.getByTestId('rb-service');
    await user.clear(svc);
    await user.type(svc, 'sharper odds with sources');
    await user.click(screen.getByTestId('read-back-confirm'));
    const [edited] = onConfirm.mock.calls[0]!;
    expect(edited.serviceSpec).toBe('sharper odds with sources');
  });

  it('back button calls onBack', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ReadBack draft={providerDraft()} onConfirm={vi.fn()} onBack={onBack} />);
    await user.click(screen.getByTestId('read-back-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('SOURCE never contains dangerouslySetInnerHTML (quarantine, react/no-danger)', () => {
    const src = readFileSync(resolve(process.cwd(), 'components/create/ReadBack.tsx'), 'utf8');
    // No ACTUAL use as a JSX prop (the string may appear in an explanatory comment).
    expect(src).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});
