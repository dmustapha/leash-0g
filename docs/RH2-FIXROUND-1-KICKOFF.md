# RH2 Fix-round 1 — F-4 decision-parse + F-5 born-paused (demo-blocking)

Branch `hackathon-robinhood`. DELIB LAW #9: build here → independent distinct-model review
(DISAGREE→fix→AGREE) → commit → push (rh2 Render service autodeploys). NO mainline merge.
Campaign context: docs/RH2-E2E-CAMPAIGN-STRUCTURE.md · findings: tasks/e2e-rh-findings.md.
Deadline tonight EOD — keep the diff minimal and surgical.

## F-4 (HIGH): decision parse fails ~2/3 cycles on 0gm-1.0-35b-a3b
Evidence: "stood down: model output was not a valid decision" 2 of 3 cycles (A2); an APPROVED
delegation was terminally failed by one parse miss (delegation 3a115944, receiver stood down).
Code:
- `backend/src/runtime/prompt.ts:255` `parseDecision` — greedy slice `indexOf('{')..lastIndexOf('}')`,
  one shot; reasoning output with multiple brace blobs/prose breaks it.
- `backend/src/runtime/prompt.ts` `completionContent` — falls back to `reasoning_content`
  (brace soup) when content is starved.
- `backend/src/runtime/treasury-graph.ts:929` — parse miss → stand_down; on an inbound
  delegation this marks it FAILED (owner approval burned, no retry).
Fix direction (design freedom within this):
1. Robust extraction: scan balanced `{…}` candidates (prefer LAST valid against decisionSchema)
   instead of one greedy slice.
2. In-cycle retry: ONE immediate re-ask on parse failure before standing down.
3. Never terminally fail an ACCEPTED delegation on a parse miss — leave it accepted for the
   next cycle until its TTL expires (TTL remains the backstop).
Tests: unit parseDecision against real reasoning-model outputs (brace-in-prose, multi-blob,
reasoning_content fallback); gtest-style runtime test for delegation-survives-parse-miss.

## F-5 (UX, Dami directive): agents must not be born paused
Today POST /api/agents inserts status 'paused'; the wizard done-screen doesn't shout "start".
Dami: "agents shouldn't automatically be paused." Tradeoff to respect: auto-starting an
UNFUNDED spend-capable agent burns LLM cycles + error traces every 30s.
Direction (implement unless review finds better):
- Spend-incapable roles (sentinel/provider/evaluator): auto-start immediately after create.
- Spend-capable (treasury/executor/requester): auto-start as soon as funding lands (FE fund
  panel success → start), AND make the done-screen Start CTA primary/loud for the skip-fund path.
- Keep an explicit opt-out (`autoStart:false`) for API users.
Touch: `backend/src/api/owner-routes.ts` create handler (+optional autoStart flag),
`web/app/create/page.tsx` done screen / FundPanel success hook.

## Acceptance (re-verified by the campaign chat after deploy)
- A2 re-run: treasury action within ONE 30s cycle in ≥4/5 trials.
- Approved delegation consumed despite a forced parse miss (survives to next cycle).
- New agent via wizard: visibly running without hunting for a start button (per role rule).
- No regression: `pnpm --filter backend test` green; typecheck green.

Report back: commit hash + what the distinct-model reviewer disputed and how it resolved.
