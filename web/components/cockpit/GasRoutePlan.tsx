// File: web/components/cockpit/GasRoutePlan.tsx
// AQ-FND M-3 inc-2: what the agent holds on each network it is on, and how it would pay for gas.
// A network that could not be read is shown as "couldn't read" — never as zero. Plain language on
// the surface; the machine reasons and grant names sit behind a Disclosure.
'use client';

import type { GasSurveyChain, GasSurveyRoute, GasSurveyView } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

function holdings(chain: GasSurveyChain, planNeedsGas: boolean): string {
  if (chain.status === 'unknown') return "couldn't read this network";
  // On the network the plan is FOR, a non-zero balance that the plan still calls insufficient is "low",
  // not "has gas" (S-4: "has gas" beside "no way to pay for gas itself" read as a contradiction).
  const gas =
    chain.sessionNativeWei !== '0'
      ? planNeedsGas ? 'gas is running low' : 'has gas'
      : chain.accountNativeWei !== '0' ? 'gas sits in the account' : 'no gas';
  const n = chain.spendableTokens.length;
  const tokens = n === 0 ? 'no spendable tokens' : n === 1 ? '1 spendable token' : `${n} spendable tokens`;
  return `${gas} · ${tokens}`;
}

function planSentence(route: GasSurveyRoute, homeName: string): string {
  switch (route.mode) {
    case 'has-native':
      return `The agent has gas on ${homeName} and can act now.`;
    case 'account-native':
      return `The agent will top up its own key from its account on ${homeName}.`;
    case 'swap-to-gas':
      return `The agent could swap some of its tokens for gas on ${homeName}. That needs your approval first.`;
    case 'bridge-then-swap':
      return `The agent could bring tokens over from another network and swap them for gas on ${homeName}. That needs your approval first.`;
    case 'ask-owner':
      return `The agent has no way to pay for gas itself on ${homeName}. If it needs gas it will ask you, once.`;
  }
}

export function GasRoutePlan({ survey }: { survey: GasSurveyView | null }) {
  if (!survey) return null;
  const nameOf = (chainId: number) => survey.chains.find((c) => c.chainId === chainId)?.name ?? `network ${chainId}`;
  const homeName = nameOf(survey.homeChainId);
  const grants = [...new Set(survey.route.legs.flatMap((l) => l.requiresGrants))];
  // The planner's lines carry raw wei figures and chain ids; show names, not numbers.
  const missing = (survey.route.ask?.missing ?? []).map((m) =>
    m.replace(/\s*\(>= \d+ wei[^)]*\)/g, '').replace(/chain (\d+)/g, (_x, id: string) => nameOf(Number(id))),
  );
  return (
    <section aria-label="Gas route" className="card" data-testid="gas-route-plan" style={{ padding: '1rem 1.1rem', display: 'grid', gap: '0.6rem' }}>
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Where the agent gets gas</h2>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        {survey.chains.map((c) => (
          <div key={c.chainId} data-testid={`gas-chain-${c.chainId}`} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.86rem' }}>
            <strong>{c.name}</strong>
            <span style={{ color: c.status === 'unknown' ? 'var(--color-deny)' : 'var(--color-ink-dim)' }}>{holdings(c, c.chainId === survey.homeChainId && survey.route.mode !== 'has-native')}</span>
          </div>
        ))}
      </div>
      <p data-testid="gas-route-sentence" style={{ margin: 0, fontSize: '0.88rem' }}>{planSentence(survey.route, homeName)}</p>
      {grants.length > 0 || missing.length > 0 ? (
        <Disclosure label="What would unblock it?">
          {grants.length > 0 ? <p style={{ margin: '0 0 0.4rem' }}>Needs your approval: {grants.join(', ')}.</p> : null}
          {missing.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </Disclosure>
      ) : null}
    </section>
  );
}
