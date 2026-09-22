
## 2026-09-21 — Surface judgment calls at decision time, not at exit
During the Phase-3 build I made several in-build judgment calls (supervised-TTL restart
option, boundary-touched limit_hit semantics, M-01 remediation choice) and only recorded
them for the exit protocol. Dami's correction: even when the kickoff says "proceed by
default", NON-pre-decided judgment calls should be surfaced to him in one compact line at
the moment they're made (decision + why + how to reverse), so he can veto in real time —
not discover them in the results doc. Pre-decided items (S1–S13, spec lines) stay
no-ask.

## Deployed-drill Privy token expiry (drill-7 & drill-8)
Long-running deployed drills fetch the Privy SIWE bearer ONCE at login and reuse it.
Privy tokens expire ~1h; a drill with link-loops + patient approval windows outlives that.
Symptom: `/api/*` starts 401ing → polls that swallow the 401 (`?? []`) spin forever, OR a
hard `link failed 401`. FIX (landed): `api()` re-runs `privyLogin()` once on any 401 and
retries. Rule: any headless client that outlives a short-lived token MUST refresh on 401,
never treat 401 as terminal.

## Digest richness expectation (Dami, this session)
The digest must get genuinely richer with real activity, not stay generic. Root cause found:
`renderText` DROPPED computed data — `modifies` (owner limit changes) and `digest.links`
(cross-agent handoffs, with names+direction) were never rendered. Rule: every field the
digest COMPUTES must reach the owner's briefing, or it shouldn't be computed. Verify richness
by rendering a synthetic busy-day digest, not just the quiet path.
