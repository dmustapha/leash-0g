# LANDING DIRECTIONS — LEASH (0G) · Phase: post-diverge → converge + build
Authored by the win-audit hub 2026-09-21 from the ratified design law (G-block: chit + dreyth
evidence). Scope: the LANDING only — a decent, honest, in-system page now; the sophisticated
cockpit UI comes later and will DERIVE from this surface. Nothing here is throwaway.

## Where we are
`landing/a|b|c` exist but Dami has judged them SUBPAR — they were generated blind (no measured
references, no per-variation value specs). They are DISCARDED as candidates. Move them to
`landing/_archive-round1/` and keep them only as the distinctness/quality NEGATIVE reference.
Regenerate from scratch using the method below. Do not reuse their CSS.

## Step 0 — REGENERATE THE VARIATIONS (the method is mandatory, not advisory)
Produce 4 NEW single-file prototype landings (`landing/v1..v4/index.html`). The non-negotiables:

**0a. One signature object first.** Before any layout: generate/derive the thesis-encoding brand
object — the LEASH mark IS the argument: a tether that holds, goes taut, snaps on revoke.
Options: generate candidates via fal (image model) from a tight prompt, or author an SVG
(tether/carabiner/taut-line motif). Dami approves ONE object. Its colors/temperature/geometry
seed every variation's palette and motion personality (object = shared identity anchor).

**0b. One MEASURED reference per variation — this is the step that was skipped last time.**
Each variation anchors to a DIFFERENT live best-in-class site. Use Playwright to open the
reference and pull real computed styles (font-family/size/weight of h1+body, section padding,
container width, actual hex/oklch values, border treatments) into
`landing/vN/REFERENCE-MEASUREMENTS.json`. Suggested distinct anchors (archetype: security
instrument / agent console / dev-tool credibility):
  v1 → linear.app (density, restraint, dark instrument)
  v2 → stripe.com or mercury.com (light editorial-fintech authority)
  v3 → warp.dev or vercel.com (terminal-native, mono-forward)
  v4 → family.co or rainbow.me (warm, humane crypto — the "trust" temperature)
Rules: references feed LAYOUT/DIRECTION diversity only — never copy their brand look; one
reference per variation, no reuse; measurements are the values' SOURCE, hand-invented values
are banned.

**0c. One exact-value SPEC per variation, BEFORE its code.** `landing/vN/SPEC.md`, short:
palette (real values, derived from signature object + reference temperature), type pair with
sizes/weights (use design-taste ronin-techniques.md §9 pairing table; Inter and Space Grotesk
are BANNED as defaults), spacing scale, hero concept in one sentence, the ONE motion idea with
its exact config. Code follows spec; a value not in the spec doesn't ship.

**0d. Same product-fact contract for all four.** Same headline facts (bind → watch it reason →
step in before it spends → revoke in one move → hard on-chain limits + tamper-evident audit),
same real proof links. Variations differ in VOICE, never in claims.

**0e. Distinctness bar.** Four genuinely different worlds: different palettes (not one palette
in four brightnesses), different type pairs, different grids, different hero mechanics. The
failure mode to avoid is on disk: round-1 a/b/c and G2's twin-accent-swap. If two variations
could merge by swapping an accent color, regenerate one of them.

**0f. Screenshots** (desktop + 390px) per variation into `landing/proposals-screenshots/round2/`
+ update the picker page.

## Step 1 — SELECTION (Dami only)
Show Dami the picker + 8 screenshots + each SPEC.md. Dami picks ONE (or names a cross: "v2's
layout, v4's warmth" — record exactly). Never auto-select, never blend all four "to be safe."
Record pick + why in `landing/SELECTION.md`.

## Step 2 — FORMALIZE THE IDENTITY (values-in-code, before any more building)
1. Extract the locked palette + winner's type/spacing/radius into **one token truth file**
   (`landing/src/tokens.css` `:root` block) — every color, face, weight, size step, space step,
   radius, easing, duration gets a custom property. No raw hex/px in component CSS after this.
2. Commit the **teeth** in the same PR (~90 lines, vitest or a node script wired into
   `pnpm verify` at the workspace root):
   - token-discipline: no raw hex/rgba/font-family literals outside tokens.css (one audited
     allowlist entry max);
   - computed contrast ≥ 4.5:1 on every used text/background pair;
   - forbidden-defaults ban-list: Inter*, Space Grotesk (unless SELECTION.md records the
     conscious keep), #3B82F6, 8px-radius-everywhere, glassmorphism blur stacks, confetti.
   Documented values drift (proven twice in our best builders); enforced values hold.

## Step 3 — THE EXACT-VALUE SPEC (short, then build to it)
Write `landing/DESIGN_SPEC.md` for the winner BEFORE polishing it: real values, no adjectives.
Minimum contents (use these as defaults where the proposal hasn't already decided):
- Type scale: clamp() fluid — display `clamp(2.6rem, 6vw, 4.4rem)` / section heads
  `clamp(1.4rem, 2.4vw, 2rem)` / body 16-17px, line-height 1.6; data/numbers ALWAYS
  `font-variant-numeric: tabular-nums` in the mono face.
- Weight law: thin/regular body (300-400) vs heavy display (700+) — contrast of weight, not
  size alone.
- Spacing: one scale (4/8/12/16/24/40/64/96), section rhythm ≥ 96px desktop.
- Hairlines, not boxes: 1px dividers at ~8-12% ink; no grey card backgrounds to "group" things.
- Motion (diegetic only — motion that MEANS something, from our banked presets):
  count-up easing `1-(1-p)^3` over ~1600ms for any live number; state morphs
  `cubic-bezier(.33,0,.2,1)` ~1000ms; entrance staggers 90ms; ALL gated behind
  `prefers-reduced-motion` and `saveData`. Zero scroll-jacking. C's zero-scroll-animation
  stance is a valid choice — record it in the spec if C wins.

## Step 4 — CONTENT LAWS (what the page must say and show)
1. **Money-shot above the fold.** The single most convincing 10 seconds of LEASH is a spend
   getting REFUSED and revoke killing the agent mid-thought. Whichever proposal wins, the hero
   carries a working (or honestly-labeled simulated) deny/approve/revoke moment — A's decision
   card already is this; B/C get an equivalent beat. Never bury the kill-shot below the fold.
2. **Proof-in-surface.** Every claim carries its receipt: contract addresses link to the 0G
   testnet explorer (sourcify-verified pages), audit-trail claims link/show a real hash. If a
   number is live, it's real; if it can't be live, show an honest state ("testnet · last
   verified <date>") — NEVER an invented stat, user count, or testimonial. Zero fabricated
   telemetry (our anti-fabrication law).
3. **Honesty placement.** "Testnet only, no mainnet funds" appears ONCE, as demonstrated rigor
   near the receipts (quiet, factual) — not as hedge-copy in the hero. Lead with what it DOES;
   the security model reads as strength ("a fully hijacked agent cannot exceed caps"), not
   apology. No "coming soon" sections — unbuilt things simply don't exist on this page.
4. **Entry funnel.** Primary CTA goes to the WOW path with zero gate — "Watch a leash hold"
   (demo/cockpit view or 60s capture), not a login wall. Privy sign-in is the secondary CTA.
5. **One-liner = the compressed thesis.** Keep A's title voice: "Let your AI agent spend real
   money. Keep the leash." — that sentence is the bar; whatever ships must be that repeatable.
6. **Copy voice:** plain, confident, human. No em-dash-riddled AI cadence, no feature-list
   bullets of uniform length, no "revolutionary/seamless/robust."

## Step 5 — FLOOR (non-negotiable, cheap)
- a11y: keep the skip-link; keyboard-reachable interactive hero; visible focus states from the
  token file; semantic landmarks; alt text on receipts/diagrams.
- Perf: LCP < 2.5s on throttled 4G, zero layout shift (reserve media boxes), fonts
  `font-display: swap` + preload the two faces actually used, no JS framework needed for a
  landing — ship static + a few hundred lines of vanilla JS for the hero beat.
- Mobile: the hero beat must WORK at 390px (judges/cohort open links on phones); test both
  screenshots widths again after build.

## Step 6 — DERIVATION SEAM (why this isn't throwaway)
When the sophisticated cockpit UI comes, it derives FROM this landing via a short derivation
spec ("the landing's look, tuned for a live console") reading the SAME tokens.css — the chit
flow. So: any value you're tempted to hardcode today goes into tokens.css instead; the landing
is the project's reference surface from now on.

## Step 7 — USE THE PIPELINE'S DESIGN SKILLS (these ones, with these directives)
The design stack is mid-overhaul; use the proven parts, supervised, exactly as follows:
1. **design-taste corpus as REFERENCE READING (not as a gate):** read
   `~/.claude/skills/design-taste/ronin-techniques.md` — use §9's domain→typography pairing
   table to drive the Step-1 font re-derivation (domain: fintech/security-instrument), and the
   one-hue/opacity-derivative law + copy-ready CSS recipes wherever the winner's CSS needs
   filling. Read `forbidden-patterns.md` once before polish. Ignore any "executable/HARD-FAIL"
   claims in those files — the real teeth are YOUR Step-2 committed tests.
2. **ui-revamp as the POLISH + AUDIT pass (the proven component):** after the winner is built to
   spec, run the ui-revamp workflow on it — audit → plan → (Dami approves the plan) → implement
   → validate. Run its linter directly:
   `node ~/.claude/skills/ui-revamp/scripts/audit.js landing/<winner>/index.html`
   Directives that override its defaults: treat MAJORS as real findings, not just CRITICALs
   (its exit code only trips on criticals — read the full report); NO self-pardoning — a
   finding is either fixed or Dami explicitly waives it in writing in SELECTION.md (never a
   "false positive" note in a state file); intentional hero motion goes in a declared-exemption
   comment citing DESIGN_SPEC.md, not silently ignored.
3. **Do NOT invoke:** frontend-design / design / design-forge modes (fictional or mid-rebuild;
   the diverge they'd own is already done here), and no conductor needed — this is a supervised
   standalone build; Dami is the checkpoint.

## Done means
SELECTION.md + tokens.css + DESIGN_SPEC.md + design tests green in `pnpm verify` + the built
landing passing them + screenshots (desktop + 390px) updated in proposals-screenshots/ or
landing/final-screenshots/. Report back with the screenshots and the test output, not prose.
