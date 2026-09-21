// File: web/tests/alert-settings.test.tsx
// Alert settings surfaces (spec §3c): prefs toggles (in-app locked for decisions, Telegram
// PATCHes the merged map with honest S11 defaults), the owner-stream key setup gate (submit
// only after backup confirmed), and Telegram link states incl. the 503 bot-unconfigured path.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api';
import { AlertPrefsPanel, telegramDefault } from '@/components/settings/AlertPrefs';
import { TelegramPanel } from '@/components/settings/TelegramPanel';
import { StreamKeySetup } from '@/components/settings/StreamKeySetup';

describe('AlertPrefsPanel', () => {
  it('in-app is locked on for decision kinds; Telegram defaults decision ON / info OFF', () => {
    render(<AlertPrefsPanel prefs={{}} onChange={vi.fn()} />);
    const inApp = screen.getByTestId('inapp-approval_required');
    expect(inApp).toBeChecked();
    expect(inApp).toBeDisabled();
    // Honest defaults (S11): decision kinds ON, info kinds OFF.
    expect(screen.getByTestId('telegram-approval_required')).toBeChecked();
    expect(screen.getByTestId('telegram-limit_hit')).toBeChecked();
    expect(screen.getByTestId('telegram-revoked')).not.toBeChecked();
    expect(telegramDefault('decision')).toBe(true);
    expect(telegramDefault('info')).toBe(false);
  });

  it('toggling a kind sends the FULL merged prefs map', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<AlertPrefsPanel prefs={{ throttle: { telegram: true } }} onChange={onChange} />);
    await user.click(screen.getByTestId('telegram-approval_required'));
    expect(onChange).toHaveBeenCalledWith({
      throttle: { telegram: true },
      approval_required: { telegram: false },
    });
  });

  it('explicit prefs override the defaults', () => {
    render(
      <AlertPrefsPanel
        prefs={{ approval_required: { telegram: false }, revoked: { telegram: true } }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('telegram-approval_required')).not.toBeChecked();
    expect(screen.getByTestId('telegram-revoked')).toBeChecked();
  });
});

describe('TelegramPanel', () => {
  const noop = () => Promise.resolve();

  it('unlinked: link button reveals the deep-link as a clickable link with copy', async () => {
    const user = userEvent.setup();
    const onLink = vi
      .fn()
      .mockResolvedValue({ url: 'https://t.me/leash_bot?start=tok123', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    render(
      <TelegramPanel linked={false} linkedAt={null} onLink={onLink} onUnlink={noop} onPing={noop} onChanged={noop} />,
    );
    expect(screen.getByTestId('telegram-unlinked-pill')).toBeInTheDocument();
    await user.click(screen.getByTestId('telegram-link-btn'));
    const box = await screen.findByTestId('telegram-deep-link');
    const a = box.querySelector('a');
    expect(a).toHaveAttribute('href', 'https://t.me/leash_bot?start=tok123');
  });

  it('linked: shows unlink + test ping; unlink refreshes settings', async () => {
    const user = userEvent.setup();
    const onUnlink = vi.fn().mockResolvedValue(undefined);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const onPing = vi.fn().mockResolvedValue(undefined);
    render(
      <TelegramPanel linked linkedAt={new Date().toISOString()} onLink={vi.fn()} onUnlink={onUnlink} onPing={onPing} onChanged={onChanged} />,
    );
    expect(screen.getByTestId('telegram-linked-pill')).toBeInTheDocument();
    await user.click(screen.getByTestId('telegram-ping-btn'));
    expect(onPing).toHaveBeenCalled();
    await user.click(screen.getByTestId('telegram-unlink-btn'));
    expect(onUnlink).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('503 (bot unconfigured) shows the honest not-configured copy', async () => {
    const user = userEvent.setup();
    const onLink = vi.fn().mockRejectedValue(new ApiError(503, 'telegram is not configured on this deployment'));
    render(
      <TelegramPanel linked={false} linkedAt={null} onLink={onLink} onUnlink={noop} onPing={noop} onChanged={noop} />,
    );
    await user.click(screen.getByTestId('telegram-link-btn'));
    expect(await screen.findByTestId('telegram-error')).toHaveTextContent(
      'Telegram is not set up on this deployment yet',
    );
  });
});

describe('StreamKeySetup', () => {
  const DETERMINISTIC_SIG = '0x' + 'ab'.repeat(65);

  function renderSetup(onSubmit = vi.fn().mockResolvedValue(undefined)) {
    render(
      <StreamKeySetup
        keySet={false}
        ownerAddress="0x3333333333333333333333333333333333333333"
        signMessage={vi.fn().mockResolvedValue(DETERMINISTIC_SIG)}
        onSubmit={onSubmit}
      />,
    );
    return onSubmit;
  }

  it('gates submit on the forced backup: download → confirm → submit, in that order', async () => {
    const user = userEvent.setup();
    // jsdom has no createObjectURL — stub the download plumbing on the real URL class.
    const urls: string[] = [];
    const anyUrl = URL as unknown as Record<string, unknown>;
    const origCreate = anyUrl['createObjectURL'];
    const origRevoke = anyUrl['revokeObjectURL'];
    anyUrl['createObjectURL'] = (b: Blob) => {
      urls.push(String(b.size));
      return 'blob:mock';
    };
    anyUrl['revokeObjectURL'] = () => undefined;
    try {
      const onSubmit = renderSetup();
      await user.click(screen.getByTestId('stream-key-generate-btn'));
      await screen.findByTestId('stream-key-backup-step');

      // Before download: the confirm checkbox is locked, submit disabled.
      expect(screen.getByTestId('stream-key-confirm-checkbox')).toBeDisabled();
      expect(screen.getByTestId('stream-key-submit-btn')).toBeDisabled();

      await user.click(screen.getByTestId('stream-key-download-btn'));
      expect(urls.length).toBe(1);
      expect(screen.getByTestId('stream-key-confirm-checkbox')).toBeEnabled();
      expect(screen.getByTestId('stream-key-submit-btn')).toBeDisabled();

      await user.click(screen.getByTestId('stream-key-confirm-checkbox'));
      await user.click(screen.getByTestId('stream-key-submit-btn'));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      // Uncompressed secp256k1 pubkey, hex without 0x — the shape the backend accepts.
      const pubkey = onSubmit.mock.calls[0]?.[0] as string;
      expect(pubkey).toMatch(/^04[0-9a-f]{128}$/i);
      expect(await screen.findByTestId('stream-key-set-pill')).toHaveTextContent('set');
    } finally {
      anyUrl['createObjectURL'] = origCreate;
      anyUrl['revokeObjectURL'] = origRevoke;
    }
  });

  it('renders the set state (with the no-rotation note) when the key already exists', () => {
    render(
      <StreamKeySetup keySet ownerAddress={null} signMessage={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByTestId('stream-key-set-pill')).toBeInTheDocument();
    expect(screen.getByText(/rotating.*not available yet/i)).toBeInTheDocument();
  });
});
