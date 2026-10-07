# Prompt log

### Prompt 1
> RH2 Fix-round 1 — read docs/RH2-FIXROUND-1-KICKOFF.md on hackathon-robinhood and execute it: F-4 (decision-parse flakiness) and F-5 (agents born paused). DELIB LAW #9 review, commit + push.
**Action:** Rewrote parseDecision (balanced-brace candidates, last valid wins, 64KB tail cap), added one in-cycle re-ask, requeue-on-parse-miss (coordinator.markRequeued accepted→pending); autoStart flag + spend-incapable auto-start at create, FE fund-success start hook + loud Start CTA. Tests added; Sonnet review AGREE; committed + pushed.
