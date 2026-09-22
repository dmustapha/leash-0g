# LANDING DESIGN_SPEC — winner: v4 "Companion" concept × the LIVE APP identity
Per SELECTION.md (Dami, 2026-09-22): one body with the app. Every value below exists as a
token in src/tokens.css — a value not here/there does not ship.

## World
The app's world (leash-0g-web.vercel.app home): near-black #0a0a0b, ink #f4f4ef, electric-lime
#c6f24d signal, jade/coral verdicts, Clash Display headlines, mono eyebrows. The landing is
that world at marketing pace, carrying v4's humane voice and living-object hero.

## Type
- Display: Clash Display 600 (thesis line 700) at var(--text-display), tracking -0.01em, lh 1.04.
- Body: Manrope 400 17px/1.6, measure 62ch.
- Data/numbers/addresses: JetBrains Mono 400/500, font-variant-numeric: tabular-nums, ALWAYS.
- Eyebrows: mono 0.72rem, uppercase, tracking .16em, ink-faint (the app's .eyebrow pattern).

## Layout
- Container 1072px centered; section rhythm var(--space-section) (96–120px).
- Hairlines (rgba ink 8%), not boxes; the ONE carded element = the hero decision moment
  (radius-lg, shadow-card). CTAs: pill (radius-full); primary = lime bg / base text
  (the app's "Create your agent" button, verbatim feel); secondary = 1px line, ink text.
- Structural surprises kept from v4: oversized humane numbers (real demo-account limits, mono,
  staggered asymmetric — never a 3-equal grid); a full-width "daily loop" band.

## Hero (money-shot, above the fold at 1440 AND 390)
The Loop-Link object in LIME (--color-accent stroke, --color-accent-soft glow), large, alive:
loop draws once (--dur-draw), tether sways subtly. Headline (Clash 700):
"Let your AI agent spend real money. Keep the leash." Sub (Manrope): the app home's own
sentence rhythm. Interactive beat, keyboard-reachable, aria-live, "simulated" noted quietly:
- Tap 1 "Try to overspend" → tether pulls TAUT (--ease-spring --dur-spring), card speaks:
  "Refused. Over the per-transfer cap — the contract held. You didn't have to be awake."
  (deny-coral edge accent)
- Tap 2 "Revoke" → clean snap (stroke-gap), links remain: "Revoked in one move. The record
  stays — hash-chained, yours alone." (jade edge accent)
- Reduced-motion/saveData: forged object static, both outcome cards visible.

## Sections (order, each in v4's voice, app's skin)
1 Hero (beat above) · 2 The problem (Step Finance / Grok-Bankr, "Instructions don't survive a
clever prompt. Contracts do.") · 3 How the leash works (Bind/Watch/Contain/Prove — numbered,
it IS a sequence) · 4 The daily loop band (decision card + digest line + "the same card lands
on your phone" with the Telegram bot) · 5 Receipts (real contracts + tx links, chainscan +
sourcify, "Live on 0G testnet" once, quiet) · 6 CTA close ("Watch a leash hold" → #demo /
"Open the cockpit" → app).

## Motion budget (all tokens; gated reduced-motion + saveData; no scroll-jacking)
Loop draw 1600ms once · spring taut 700ms · morph 1000ms · reveal stagger 90ms (hero + first
section only) · button tap 150ms. Nothing else moves.

## Honesty + copy laws (binding)
"reasoning served by 0G Compute / record on 0G Storage / limits enforced on 0G Chain"; never
"agents run on 0G"; attestation only as TEE-provider choice; no invented numbers; no em-dash
cadence in copy; no "revolutionary/seamless/robust".
