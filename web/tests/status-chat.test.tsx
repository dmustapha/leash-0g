// File: web/tests/status-chat.test.tsx
// Phase-5.5 (spec §9): the cockpit question box. Renders the agent's answer as PLAIN TEXT (never
// dangerouslySetInnerHTML, never a markdown renderer) and labels it unverified.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusChat } from '@/components/cockpit/StatusChat';

describe('StatusChat', () => {
  it('ask renders the answer as plain text with an unverified label', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn().mockResolvedValue({ answer: 'I paid 0.02 0G to the beneficiary.', asOfSeq: 7 });
    render(<StatusChat onAsk={onAsk} />);
    await user.type(screen.getByTestId('status-chat-q'), 'what have you paid?');
    await user.click(screen.getByTestId('status-chat-ask'));
    expect(onAsk).toHaveBeenCalledWith('what have you paid?');
    expect(await screen.findByTestId('status-chat-answer')).toHaveTextContent('I paid 0.02 0G to the beneficiary.');
    expect(screen.getByTestId('status-chat-unverified')).toHaveTextContent(/unverified/i);
  });

  it('renders an answer containing HTML as literal text (quarantine)', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn().mockResolvedValue({ answer: '<img src=x onerror=alert(1)>', asOfSeq: 1 });
    render(<StatusChat onAsk={onAsk} />);
    await user.type(screen.getByTestId('status-chat-q'), 'status?');
    await user.click(screen.getByTestId('status-chat-ask'));
    const answer = await screen.findByTestId('status-chat-answer');
    // The tag is textContent, not a live DOM node.
    expect(answer).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(answer.querySelector('img')).toBeNull();
  });

  it('SOURCE never contains dangerouslySetInnerHTML (quarantine)', () => {
    const src = readFileSync(resolve(process.cwd(), 'components/cockpit/StatusChat.tsx'), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});
