// File: web/tests/revoke-pair.test.tsx
// REVOKE PAIR: confirm step, honest per-agent results, and the C-2 partial-failure state
// with a prominent owner-wallet fallback CTA per failed agent.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevokePairButton } from '@/components/links/RevokePairButton';
import type { RevokeBatchResult } from '@/lib/types';

const NAMES = { a1: 'Watcher', a2: 'Executor' };
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

describe('RevokePairButton', () => {
  it('requires a confirm before firing the batch', async () => {
    const user = userEvent.setup();
    const onRevokeBatch = vi.fn().mockResolvedValue([]);
    render(<RevokePairButton agentNames={NAMES} onRevokeBatch={onRevokeBatch} onWalletRevoke={vi.fn()} />);
    await user.click(screen.getByTestId('revoke-pair-btn'));
    expect(onRevokeBatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/cut both agents off/i);
    await user.click(screen.getByTestId('confirm-revoke-pair-btn'));
    expect(onRevokeBatch).toHaveBeenCalledOnce();
  });

  it('renders honest per-agent results including alreadyRevoked', async () => {
    const user = userEvent.setup();
    const results: RevokeBatchResult[] = [
      { agentId: 'a1', ok: true, txHash: `0x${'b'.repeat(64)}` },
      { agentId: 'a2', ok: true, alreadyRevoked: true },
    ];
    render(
      <RevokePairButton agentNames={NAMES} onRevokeBatch={vi.fn().mockResolvedValue(results)} onWalletRevoke={vi.fn()} />,
    );
    await user.click(screen.getByTestId('revoke-pair-btn'));
    await user.click(screen.getByTestId('confirm-revoke-pair-btn'));
    expect(await screen.findByTestId('revoke-result-a1')).toHaveTextContent('revoked');
    expect(screen.getByTestId('revoke-result-a2')).toHaveTextContent('already revoked');
    expect(screen.queryByTestId('revoke-fallback-a1')).not.toBeInTheDocument();
  });

  it('partial failure renders the fallback CTA for the failed agent and fires the wallet revoke', async () => {
    const user = userEvent.setup();
    const results: RevokeBatchResult[] = [
      { agentId: 'a1', ok: true, txHash: `0x${'b'.repeat(64)}` },
      {
        agentId: 'a2',
        ok: false,
        error: 'guardian_revoke_failed',
        ownerRevokeFallback: { accountAddr: ACCOUNT, method: 'revoke()', hint: 'use your wallet' },
      },
    ];
    const onWalletRevoke = vi.fn().mockResolvedValue('0xwallettx');
    render(
      <RevokePairButton
        agentNames={NAMES}
        onRevokeBatch={vi.fn().mockResolvedValue(results)}
        onWalletRevoke={onWalletRevoke}
      />,
    );
    await user.click(screen.getByTestId('revoke-pair-btn'));
    await user.click(screen.getByTestId('confirm-revoke-pair-btn'));

    const fallback = await screen.findByTestId('revoke-fallback-a2');
    expect(fallback).toHaveTextContent(/works even if LEASH is down/i);
    expect(screen.getByTestId('revoke-result-a2')).toHaveTextContent(/FAILED/);
    expect(screen.queryByTestId('revoke-fallback-a1')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('wallet-revoke-a2'));
    expect(onWalletRevoke).toHaveBeenCalledWith(ACCOUNT);
    expect(await screen.findByTestId('wallet-revoke-tx-a2')).toHaveTextContent('0xwallettx');
  });

  it('surfaces a whole-batch failure as an error', async () => {
    const user = userEvent.setup();
    render(
      <RevokePairButton
        agentNames={NAMES}
        onRevokeBatch={vi.fn().mockRejectedValue(new Error('network down'))}
        onWalletRevoke={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('revoke-pair-btn'));
    await user.click(screen.getByTestId('confirm-revoke-pair-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });
});
