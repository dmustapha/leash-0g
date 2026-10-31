# AQ-FND ⑥ M-3 — wire the self-funding gas ladder into autonomous behavior (Dami: build full slice)

GAP: planGas (ratified ladder) + rung-5 ask-owner surface are NOT wired into the agent act path
(only planDestGas for rails uses it). Downstream of C4 (native-only goals). The agent can't
autonomously walk the ladder or surface "I need gas" to the owner.

## Target behavior
Agent with a TOKEN-denominated goal, zero native, holding a token →
  decide an act → snapshot gas → planGas picks a rung →
    rung 4 (bootstrap-7702): self-fund + act (repaid in token), narrated →
    rung 5 (ask-owner): raise ONE capability request → cockpit decision card ("I need native"), no silent stall.

## Steps (research → design → build → verify)
- [ ] MAP: treasury-graph decide→act flow; where the native assumption lives; the capability-request
      raise at treasury-graph:985 (reuse for ask-owner-gas); session-chain act execution.
- [ ] DESIGN: token-goal extension (TreasuryGoal + token field or new goal kind) — minimal.
- [ ] BUILD: goal-schema accepts a token goal.
- [ ] BUILD: act path snapshots gas + calls planGas; rung 4 executes bootstrap; rung 5 raises capability request.
- [ ] BUILD: ask-owner capability request surfaces in cockpit (reuse decision card rail).
- [ ] VERIFY LIVE: token goal + zero native → agent walks ladder → rung 4 self-funds (AQB), narrated;
      then force no-path → rung 5 ask-user card appears. Independently re-read on-chain + DB.

## Guardrails (Dami rulings)
- D-4: LEASH NEVER sponsors; every rung is self-funding or ask-owner. Rung 4 repaid in token through wall.
- D-1: no default cap on unknown tokens; hold free, spend-novel = one ask.
- Reuse existing escalation/capability-request rail (treasury-graph:985), don't invent a new one.
- Additive, v6; don't regress native-goal behavior.
