# STAGE G — UI IDENTITY ADOPTION (design-system import) · kickoff handoff

**Give this doc to the active LEASH build chat.** It defines the phase that adopts the
finished Stage-3 design build as the app's canonical UI identity.

## Action for the leash build chat (do this first)
1. **Register a new `Stage G — UI Identity Adoption` in `~/0g-fleet/docs/08-ROADMAP.md`**, sequenced as
   the **immediate successor to Stage F** (after `08 §91`), and add the matching decision note to
   `~/0g-fleet/docs/07-OPEN-DECISIONS.md` (drift-guard convention). It is **committed, not optional**.
2. The canonical, code-resident artifacts already live in the app repo at **`web/design-reference/`**
   (`tokens.css`, `marketing.html`, `console.html`, this doc). Treat those as source of truth.
3. Scope Stage G in its own chat when reached, per the Import plan below. **This is an IMPORT of a
   finished build — not a redesign.** (See the guard section next.)

## ⚠️ Read this first — this is an IMPORT, not a redesign
The design build is **already complete and locked** — marketing page + full 9-view console, the
signature, the motion, the typography, the theme. Every visual, layout, and interaction decision is
**done**. This phase does **not** re-design, re-theme, re-decide layout, or re-litigate any of it.
Its entire job is:
1. **Import** the finished build into the app and make it the **canonical UI identity / shell**.
2. **Wire live data behind the already-built visuals** (the visuals do not change — only their data
   source moves from the mock seeds to `lib/api.ts` + the SSE hooks).
3. **Build every future addition on top, following this theme** (Stage F tool-use/binding panels and
   everything after reuse these tokens + components + patterns — no new visual language is invented).

The design build below is therefore both the **spec and the reference implementation.** Treat any
deviation from it as a regression unless a live-data constraint forces it (and then, minimally).

## Position in the roadmap
- Sequenced as the **immediate next phase after Stage F** (`~/0g-fleet/docs/08-ROADMAP.md` §90–91).
- It is **committed, not optional polish.** From this phase onward, **every frontend addition is
  built on this design system** — Stage F's tool-use/binding panels, and everything after, use these
  tokens + components. We **scrap the current UI shell** and rebuild the surface on this identity.
- Why after F and not before: F is still adding new surface (tool-use governance, binding, signing).
  Porting the shell once, after F's surface is known, avoids re-skinning twice. (If a cohort/demo pull
  makes an earlier partial adoption worthwhile, the marketing page can ship first — it has no app deps.)

## What "the identity" is
This is not a re-theme. The app's `web/app/globals.css` + `landing.css` already declare the **Signal
Grid** palette (near-black `#0a0a0b`, electric-lime `#c6f24d`, jade `#4fd08a`, coral `#ff5d6c`) and
**Clash Display / Manrope / JetBrains Mono**. The design build extends that into a full system:

- **Signature:** the leash line as a living object — the **interactive Loop-Link hero beat**
  (draw → alive → *try to overspend* → taut/refused (coral) → *revoke* → snap/safe (jade) → re-arm),
  and the **catenary tension meter** (sag = headroom, taut = near-cap, dashed-cut = revoked) reused
  everywhere a limit is shown.
- **Two profiles, one system:**
  - *Marketing* = atmosphere-rich (grain, drifting lime glow-planes, twinkle, motes, brand corner-bloom
    + vignette, pointer-parallax, scroll choreography).
  - *Console* = **product-app restraint** — data is the show; motion limited to one live pulse,
    flash-on-new, skeleton load, and the catenary tautening on real data.
- **Typography discipline:** prose in **Manrope**, data (money, addresses, tx, model ids, selectors,
  verdicts) in **bold JetBrains Mono**. Never a mono wall.
- **Verdict system:** `.chip chip-allow / chip-deny / chip-pend` — color *and* shape encode meaning.
- **Light + dark, one identity:** a persisted theme toggle (sun/moon, `localStorage 'leash-theme'`,
  `data-theme="light"` on `:root`, with an anti-FOUC head script). Light is NOT an invert — the
  alpha-over-role ladders auto-adapt when `--ink` flips, and the accent/verdicts DEEPEN for white
  (`--accent-ink` for accent-as-text; marketing atmosphere switches to `multiply`). Both are in the
  build; carry the toggle + the `:root[data-theme="light"]` token block as-is.
- **Craft baseline:** branded dead states, ⌘K command palette, `:focus-visible` rings, full
  `prefers-reduced-motion` two-sided contract, tabular-nums on every figure.

## Source of truth (canonical artifacts to import)
**ONLY these three files are authoritative for the identity.** They are the finished lime build.
`~/pipeline-audit/skill-audit/win-audit/REFERENCE-TEARDOWN/STAGE-3-SPIKE/render/`
- `tokens.css` — the design tokens (superset of the app's current globals: adds atmosphere, motion
  primitives, glass, catenary signature, alpha-over-role ladders). **Fold into `web/app/globals.css`
  `@theme`.**
- `marketing.html` — the landing (interactive Loop-Link hero + all sections).
- `console.html` — the full console: **9 views** mapping the real app surface.
- `DESIGN-EXPORT-TO-APP.md` — this handoff.

### ⛔ Do NOT use these older docs for the identity — they are STALE (pre-lime, pre-elevation)
The following describe the **amber** Stage-3 build (`accent #f2c14e / oklch(.805 .150 78)`) and predate
this session's lime recolor, interactive Loop-Link hero, and console expansion. Using their token/color
values would regress the identity to amber. They are useful ONLY as background rationale for *why* a
motion/craft choice was made — never for palette, tokens, or current layout:
- `~/pipeline-audit/skill-audit/win-audit/REFERENCE-TEARDOWN/STAGE-3-SPIKE/DESIGN.md`, `~/pipeline-audit/skill-audit/win-audit/REFERENCE-TEARDOWN/STAGE-3-SPIKE/tokens.json`, `~/pipeline-audit/skill-audit/win-audit/REFERENCE-TEARDOWN/STAGE-3-SPIKE/motion.json`, `~/pipeline-audit/skill-audit/win-audit/REFERENCE-TEARDOWN/STAGE-3-SPIKE/SPIKE-SCORECARD.md` (amber-era).
- If a value in these conflicts with `tokens.css` / `marketing.html` / `console.html`, **the render
  artifacts win, always.**

### Roadmap docs that define where this phase sits
- `~/0g-fleet/docs/08-ROADMAP.md` §90–91 — Stage E (multichain) and **Stage F** (full-agentic:
  external binding + multi-protocol gateway + governed tool-use/MCP + EIP-712/ERC-1271 signing).
- `~/0g-fleet/docs/07-OPEN-DECISIONS.md` **S28 (SD-E3…E6)** — the authoritative Stage F scope/boundary
  and its "immediately after E, committed" sequencing. This phase (UI adoption) is the successor to F.

## View → route mapping (console.html → the Next.js app)
The console was built from a live capability inventory of `web/`, so each view maps to a real route:

| Console view | App route / component | Notes |
|---|---|---|
| **Fleet** | `/app` (`app/app/page.tsx`) | summary strip + agent cards w/ catenary meters. Card → cockpit. |
| **Cockpit** | `/agents/[id]` (`components/cockpit/*`) | **per-agent** (correct — one agent per cockpit, like today). The build **already includes an agent-switcher** (header pill row, status dot per agent, updates `?agent=`) — adopt as-built. Panels map 1:1 to existing cockpit panels: StatusBar, AgentControls, StreamFeed (live reasoning), CapabilityDecisionCard (JIT), PolicyPanel (limits + timelock), Allowlist, GuardianPanel, RulesEditor, CapabilityEnvelope, DirectBox/StatusChat, ChainView, RevokeButton. |
| **Inbox** | `/inbox` | alert cards + inline approve/deny + auto-deny countdown + unread badge. |
| **Jobs** | `/jobs`, `/jobs/[id]` | ACP lifecycle stepper + PoA record + settlement approve/deny. |
| **Links** | `/links`, `/links/[id]` | agent pairs, mode auto/supervised, delegation timeline, revoke pair. |
| **Digest** | `/digest` | daily digest preview + mark caught up. |
| **Audit** | `/agents/[id]/audit` | hash-chained trace batches, merkleRoot, 0G Storage tx, chain-ok/broken, decrypt. |
| **Verdicts** | (fleet-wide rail) | cross-agent allow/deny stream + sparkline. |
| **Policies** | (fleet-wide) | per-agent caps + allowlist, owner-only. |
| *(also in app, not yet mocked)* | `/create`, `/jobs/specs`, `/settings/alerts` | build on the same shell/tokens. |

## Import plan (adopt the finished build — do not rebuild the design)
The mechanical work is moving the finished HTML/CSS/JS into the app's React/App-Router structure and
attaching live data. **Match the reference build pixel-for-pixel and behavior-for-behavior**; the only
thing that changes is where the data comes from.
1. **Tokens:** adopt `tokens.css` as the single source of truth — merge into `globals.css @theme`
   (the app already declares most Signal Grid vars; add the atmosphere/motion/glass/catenary primitives
   verbatim). Do not alter values.
2. **App shell:** replace the current `SiteNav` + page chrome with the build's grouped sidebar
   (MONITOR / OPERATE / STREAM / TRUST) + glass topbar + ⌘K palette, exactly as built.
3. **Views:** each of the 9 console views is already designed and implemented in `console.html`.
   Lift each into a React component **preserving its markup/classes/motion**, and swap its **mock seed
   for real data** via `lib/api.ts` + the SSE hooks (`lib/sse.ts`, `use-owner-stream.ts`). The catenary
   meter, chip system, stream row, stepper, PoA block, tension bar are shared components taken as-is.
4. **Marketing:** lift the landing into `app/page.tsx` as-built. **Reconcile the hero with the existing
   `HeroBeat.tsx`** — the build's interactive beat is the same alive→taut→snap machine; keep one
   controller. Marketing has no app-data deps, so it can land first.
5. **Carry the non-negotiables that are already in the build:** a11y (roles/aria/focus-visible),
   reduced-motion two-sided contract, tabular-nums, quarantined-untrusted-text rendering, once-only
   secret reveals. They exist in the reference — keep them.

## Explicitly out of scope for this phase
- No new capabilities. This phase changes the **surface**, not the engine. New capability work
  (Stage F tool-use panels etc.) is authored *in* this system but tracked under its own stage.

## Open decisions to confirm at the scope chat
1. Marketing-first partial adoption vs. full shell import in one slice.
2. Whether `Verdicts` + `Policies` remain fleet-wide top-level views or fold into Fleet/Cockpit.
3. Cockpit agent-switcher is built as a header pill row — confirm that placement vs. a persistent
   fleet rail once real fleet sizes are known (already implemented; this is a keep/adjust check).
