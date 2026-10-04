# RH2 — Full E2E test-campaign kickoff (plan-first, two-phase)

**Branch:** `hackathon-robinhood` @ pushed to origin (includes `8287d47` defect fixes + evidence refresh).
**Prior chats:** Gate-② APPROVED (independent review); ad-hoc frontend sweep ran 9/12 scenarios but
mixed API shortcuts into UI testing — Dami rejected that approach. This campaign restarts testing
PROPERLY. Building is COMPLETE (B1–B4 + D1–D5 all machine-verified; completeness audit 2026-10-04).

## Dami's directives (binding)
1. **Plan before testing.** First deliverable: a COMPLETE capability inventory of the app (every
   feature, every path — all 6 agent roles × create paths (conversational / 3 templates / manual) ×
   instruction categories). Second: per-capability test design — happy path + stress + adversarial/
   injection (deliberately try to break it; inject hostile prompts into agent instructions too).
2. **Two clean phases.** Phase A = backend: exercise every capability at the API layer
   (scripts/curl with Privy token or ops key). Phase B = frontend: Claude drives the real app via
   claude-in-chrome **as a regular user** — UI only, NEVER reach around to the API while
   user-simulating (today's mistake; do not repeat).
3. **Test the latest deployed build.** Branch is pushed. NOTE: the branch has NO deployment yet —
   prod (Vercel `leash-0g-web` + Render `leash-0g-backend`) builds from `main` only, and no
   preview appeared on push. Standing up a branch deployment (Render branch service + Vercel
   preview env with `NEXT_PUBLIC_API_URL` pointed at it) is **blocker #1**; fall back to the local
   stack only if cloud is impractical (local: `node backend/dist/index.js` :8080 after `pnpm build`,
   `NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev` in web/ :3000, relay
   `node contracts/rpc-relay.cjs` :8899).
4. **Wallet autonomy (testnet):** Dami pre-authorizes all testnet wallet approvals — do NOT wait for
   him. Limitation: MetaMask's OS popup has no tabId → unreachable; when one appears, ping him with
   ONE line ("approve the MetaMask popup") as a flagged exception. MetaMask is the demo wallet
   (Zerion uninstalled/disabled — its scanner called the domain malicious; also report domain as
   safe in Zerion/Blowfish before demo day).

## Blockers to clear BEFORE executing tests
- [ ] B-1 Branch deployment (backend + web preview) — else localhost + one MetaMask re-login.
- [ ] B-2 Hero/band-wall lane exists ONLY on branch backend (prod silently ignores `capability`).
- [ ] B-3 Wizard has no chain picker — RH-chain creates are API-only (known gap; decide: build it
      or document as demo constraint).
- [ ] B-4 Sig-UX stall: wizard shows "Creating…" with no "check your wallet" nudge; KEK signs TWICE.
- [ ] B-5 O-2 desync: backend agent status doesn't follow out-of-band on-chain rearm.
- [ ] B-6 N-2: digest ignores create/onboard/link events (confirm intent or fix).

## State carried forward (fixtures on prod backend, owner 0xc211…12A5)
- `rh e2e tester` b4278763… — RH-homed treasury agent, acct 0x06ae4C0b…da52C, FUNDED 0.0015 RH ETH,
  onboarded to Base Sepolia (same address verified on-chain). Paused, never started.
- `wizard mm test` — sentinel via wizard+MetaMask, acct 0x17DD1be2…5944 (0G home). Paused, unlinked.
- Link: rh e2e tester → treasury helper (supervised). 3 probe agents revoked (2 re-armed on-chain).
- Telegram LINKED + test ping ✓. Guardian funded on RH (0.001) — one-click revoke works on RH now.
- Full scenario log: `tasks/e2e-rh-test.md` (gitignored, local).

## Campaign shape (for the new chat)
1. Clear blockers (at minimum B-1/B-2 — the rest may become test findings).
2. Build the capability inventory (crawl code: web routes/components + backend routes/services;
   deliverable table: capability → paths → test cases H/S/A).
3. Dami approves the inventory + test plan (Gate).
4. Phase A backend campaign → findings log.
5. Phase B frontend-as-user campaign via claude-in-chrome (fresh user journey: login → create every
   agent type via every path → fund → run → links/handoffs → walls: over-cap, premium, stale,
   injection → telegram approvals → revoke/rearm → audit → cross-chain) → findings log.
6. Fix round per DELIB convention (build → distinct-model review → commit), then re-test deltas.

## Kickoff prompt for the new chat
> **RH2 E2E campaign kickoff** — read `docs/HACKATHON-RH2-E2E-CAMPAIGN-KICKOFF.md` on
> `hackathon-robinhood` and execute it: clear B-1/B-2, then produce the capability inventory +
> per-capability test designs for Dami's approval BEFORE any test execution. Building is complete;
> Gate-② approved. Wallet autonomy per the doc. Testing is frontend-as-a-regular-user via
> claude-in-chrome in Phase B — no API shortcuts while user-simulating.
