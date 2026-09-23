// File: web/tests/job-spec-editor.test.tsx
// Phase-4 create-flow parity (spec §7/F5): the owner defines the job — the fee
// and the acceptance rules are authority (server state), never model text (F4).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobSpecEditor, ruleSummary } from '@/components/create/JobSpecEditor';

describe('JobSpecEditor', () => {
  it('builds + saves an owner job spec with a generic acceptance floor', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<JobSpecEditor onSave={onSave} />);

    await userEvent.type(screen.getByTestId('js-ref'), 'eth-4000');
    await userEvent.type(screen.getByTestId('js-question'), 'Will ETH close above $4000 this month?');
    await userEvent.type(screen.getByTestId('js-schema'), 'market-probability@v1');
    await userEvent.type(screen.getByTestId('js-acceptance'), 'market-floor');
    await userEvent.type(screen.getByTestId('js-fee'), '5000000');

    // add a numberRange rule: probability in [0,1]
    await userEvent.selectOptions(screen.getByTestId('js-rule-kind'), 'numberRange');
    await userEvent.type(screen.getByTestId('js-rule-path'), 'probability');
    await userEvent.type(screen.getByTestId('js-rule-min'), '0');
    await userEvent.type(screen.getByTestId('js-rule-max'), '1');
    await userEvent.click(screen.getByTestId('js-rule-add'));
    expect(screen.getByTestId('js-rules')).toHaveTextContent(/probability.*≥ 0.*≤ 1/);

    await userEvent.click(screen.getByTestId('js-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const call = onSave.mock.calls[0] ?? [];
    const ref = call[0];
    const spec = call[1];
    expect(ref).toBe('eth-4000');
    expect(spec.spec.question).toMatch(/ETH close above/);
    expect(spec.feeAmountWei).toBe('5000000');
    expect(spec.acceptance.rules).toEqual([{ kind: 'numberRange', path: 'probability', min: 0, max: 1 }]);
    expect(screen.getByTestId('js-saved')).toBeInTheDocument();
  });

  it('refuses to save without a rule or a numeric fee (the floor cannot be empty)', async () => {
    const onSave = vi.fn();
    render(<JobSpecEditor onSave={onSave} />);
    await userEvent.type(screen.getByTestId('js-ref'), 'x');
    await userEvent.type(screen.getByTestId('js-question'), 'q');
    await userEvent.type(screen.getByTestId('js-schema'), 's');
    await userEvent.type(screen.getByTestId('js-acceptance'), 'a');
    await userEvent.type(screen.getByTestId('js-fee'), 'notnumeric');
    await userEvent.click(screen.getByTestId('js-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('js-error')).toBeInTheDocument();
  });

  it('ruleSummary renders each generic rule kind in plain language', () => {
    expect(ruleSummary({ kind: 'required', path: 'p' })).toMatch(/required/);
    expect(ruleSummary({ kind: 'enum', path: 'v', values: ['a', 'b'] })).toMatch(/∈ \{a, b\}/);
    expect(ruleSummary({ kind: 'arrayMinLength', path: 'xs', min: 2 })).toMatch(/array of ≥ 2/);
  });
});
