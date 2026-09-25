// File: web/tests/funnel-entry.test.tsx
// Phase-5 (spec §3a): the intent-first front door. Intent submit → onElevate; template pick →
// onPick; manual escape → onManual; an elevation failure shows a legible retry, not a blank screen.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FunnelEntry } from '@/components/create/FunnelEntry';

describe('FunnelEntry', () => {
  it('intent submit calls onElevate with the trimmed intent', async () => {
    const user = userEvent.setup();
    const onElevate = vi.fn().mockResolvedValue(undefined);
    render(<FunnelEntry onElevate={onElevate} onPick={vi.fn()} onManual={vi.fn()} />);
    await user.type(screen.getByTestId('funnel-intent'), '  give me market odds  ');
    await user.click(screen.getByTestId('funnel-elevate'));
    expect(onElevate).toHaveBeenCalledWith('give me market odds');
  });

  it('submit is disabled with an empty intent', () => {
    render(<FunnelEntry onElevate={vi.fn()} onPick={vi.fn()} onManual={vi.fn()} />);
    expect(screen.getByTestId('funnel-elevate')).toBeDisabled();
  });

  it('a template pick calls onPick with that template draft (no LLM call)', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onElevate = vi.fn();
    render(<FunnelEntry onElevate={onElevate} onPick={onPick} onManual={vi.fn()} />);
    await user.click(screen.getByTestId('template-market-forecaster'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].proposedRole).toBe('provider');
    expect(onElevate).not.toHaveBeenCalled();
  });

  it('the manual escape calls onManual', async () => {
    const user = userEvent.setup();
    const onManual = vi.fn();
    render(<FunnelEntry onElevate={vi.fn()} onPick={vi.fn()} onManual={onManual} />);
    await user.click(screen.getByTestId('funnel-manual'));
    expect(onManual).toHaveBeenCalledTimes(1);
  });

  it('an elevation failure shows a legible retry, not a blank screen', async () => {
    const user = userEvent.setup();
    const onElevate = vi.fn().mockRejectedValue(new Error('boom'));
    render(<FunnelEntry onElevate={onElevate} onPick={vi.fn()} onManual={vi.fn()} />);
    await user.type(screen.getByTestId('funnel-intent'), 'odds please');
    await user.click(screen.getByTestId('funnel-elevate'));
    expect(await screen.findByTestId('funnel-error')).toHaveTextContent(/try again/i);
    // Still usable: the intent box and templates remain on screen.
    expect(screen.getByTestId('funnel-intent')).toBeInTheDocument();
    expect(screen.getByTestId('template-strip')).toBeInTheDocument();
  });
});
