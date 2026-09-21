// File: web/tests/rules-editor.test.tsx
// gatewayRules editor: add/remove/edit rows, submit shape, empty-match rejection, the
// 32-row cap, and the audit-trail notice.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RulesEditor, RULES_MAX } from '@/components/cockpit/RulesEditor';
import type { GatewayRule } from '@/lib/types';

describe('RulesEditor', () => {
  it('renders existing rules and the audit-trail notice', () => {
    const rules: GatewayRule[] = [
      { action: 'block', match: 'seed phrase' },
      { action: 'modify', match: 'apikey-123', replacement: '[redacted]' },
    ];
    render(<RulesEditor rules={rules} onSave={vi.fn()} />);
    expect(screen.getByTestId('rule-row-0')).toBeInTheDocument();
    expect(screen.getByLabelText('Rule 1 text to match')).toHaveValue('seed phrase');
    expect(screen.getByLabelText('Rule 2 replacement text')).toHaveValue('[redacted]');
    expect(screen.getByText(/recorded in the audit trail/i)).toBeInTheDocument();
  });

  it('adds and removes rows, then submits the cleaned shape', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RulesEditor rules={[{ action: 'block', match: 'old' }]} onSave={onSave} />);

    await user.click(screen.getByTestId('add-rule-btn'));
    await user.type(screen.getByLabelText('Rule 2 text to match'), '  password  ');
    await user.selectOptions(screen.getByLabelText('Rule 2 action'), 'require_approval');
    await user.click(screen.getByTestId('remove-rule-0'));
    await user.click(screen.getByTestId('save-rules-btn'));

    expect(onSave).toHaveBeenCalledWith([{ action: 'require_approval', match: 'password' }]);
    expect(await screen.findByTestId('rules-saved')).toBeInTheDocument();
  });

  it('rejects an empty match without calling onSave', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RulesEditor rules={[]} onSave={onSave} />);
    await user.click(screen.getByTestId('add-rule-btn'));
    await user.click(screen.getByTestId('save-rules-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs text to match/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it(`refuses to add a rule beyond ${RULES_MAX}`, async () => {
    const user = userEvent.setup();
    const full: GatewayRule[] = Array.from({ length: RULES_MAX }, (_, i) => ({
      action: 'block',
      match: `rule-${i}`,
    }));
    render(<RulesEditor rules={full} onSave={vi.fn()} />);
    expect(screen.getByText(`${RULES_MAX}/${RULES_MAX}`)).toBeInTheDocument();
    await user.click(screen.getByTestId('add-rule-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`at most ${RULES_MAX}`));
    expect(screen.queryByTestId(`rule-row-${RULES_MAX}`)).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no rules', () => {
    render(<RulesEditor rules={[]} onSave={vi.fn()} />);
    expect(screen.getByTestId('rules-empty')).toHaveTextContent(/everything passes through/i);
  });
});
