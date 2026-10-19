// File: web/app/page.tsx
// Home (route: /) — STAGE G-2.0, the marketing REPLACEMENT.
//
// This is an IMPORT of the owner-locked design build, not a redesign. The markup below
// is `web/design-reference/marketing.html:274-544` transcribed to JSX; the styles are
// `app/marketing.css` (tokens.css:171-500 + marketing.html's own <style>, scoped under
// `.leash-landing`); the behaviour is `components/landing/LandingRoot.tsx` (the same
// file's <script> block, :546-825). The previous G-1.3 landing — `landing.css` plus
// `HeroBeat.tsx` — is retired by this slice.
//
// Three things in here are NOT the artifact, each forced and each stated at its site:
//   1. `problem` (re-dressed per ruling D2) — the one live-only section kept, because it
//      is the only place the page says WHY the product exists. Re-dressed in the
//      artifact's own `.sec-head` + body idiom rather than its old bespoke CSS.
//   2. R-1's two `.hcard`s in `#how` (REFUSED / REVOKED) — the binding debt opened when
//      G-1.3 removed the hero's two `.outcome-card`s. The prose is relocated, not lost.
//   3. `.sim-note` — the artifact is a static demo; this page ships above a real product,
//      so the scripted stream has to say it is scripted. Truthfulness, not taste.
//
// Deterministic generated content (twinkle field, motes, marquee, rail seed) is rendered
// HERE rather than injected by the controller's innerHTML. Same output, but it survives
// with JS disabled and gives the a11y run real nodes to score.
import type { Metadata } from 'next';
import Link from 'next/link';
import './marketing.css';
import { LandingRoot } from '@/components/landing/LandingRoot';
import ThemeToggle from '@/components/ThemeToggle';

export const metadata: Metadata = {
  title: 'LEASH · Let your AI agent spend real money. Keep the leash.',
  description:
    'Give an AI agent its own wallet, then bound it: a per-transfer cap it cannot raise, an allowlist it cannot widen, and one on-chain write that cuts it off everywhere.',
};

/** marketing.html:623-636 — the twinkle field. Pure arithmetic, so it renders server-side. */
const TWINKLE_W = 1600;
const TWINKLE_H = 900;
const TWINKLE_COLS = 34;
const TWINKLE_ROWS = 20;
const twinkleDots = (() => {
  const dots: { x: string; y: string; r: number; d: string }[] = [];
  for (let r = 0; r < TWINKLE_ROWS; r++) {
    for (let c = 0; c < TWINKLE_COLS; c++) {
      if ((r * TWINKLE_COLS + c) % 2 !== 0) continue;
      const jx = ((c * 13 + r * 7) % 9) - 4;
      const jy = ((c * 5 + r * 11) % 9) - 4;
      dots.push({
        x: ((c / (TWINKLE_COLS - 1)) * TWINKLE_W + jx * 6).toFixed(0),
        y: ((r / (TWINKLE_ROWS - 1)) * TWINKLE_H + jy * 6).toFixed(0),
        r: (c + r) % 3 === 0 ? 1.6 : 1.0,
        d: ((((c * 7 + r * 13) % 34) / 10)).toFixed(2),
      });
    }
  }
  return dots;
})();

// marketing.html:651 lists the artifact's *intended* stack (ENS · x402 · Base ·
// Coinbase AgentKit · USDC). The shipped product runs on 0G + Privy, so under owner
// ruling (G-2.0) the marquee is RECONCILED to what actually enforces the leash rather
// than ported verbatim — a stated copy deviation, because a marquee is a factual claim,
// not decoration. Same count (7) and rhythm as the artifact.
const MARQUEE = [
  '0G Chain enforcement',
  '0G Compute inference',
  '0G Storage records',
  'Privy embedded wallets',
  'Per-transfer caps',
  'Owner allowlist',
  'One-write revoke',
];

/** marketing.html:703-709 — the rail's opening five rows. */
const RAIL_SEED = [
  ['allow', 'supabase-agent', 'api.stripe.com', 'settled', '$18.00', '0x51a2…'],
  ['deny', 'scraper-agent', '0x9c…f1', 'OFF_ALLOWLIST', '$240.00', '—'],
  ['allow', 'research-agent', 'api.exa.ai', 'settled', '$4.20', '0xb2c0…'],
  ['deny', 'ops-agent', 'api.render.com', 'OVER_DAILY_CAP', '$620.00', '—'],
  ['allow', 'research-agent', 'api.openai.com', 'settled', '$12.80', '0x7c9d…'],
] as const;

function MarqueeRun() {
  return (
    <span>
      {MARQUEE.map((t, i) => (
        <span key={t} style={{ display: 'contents' }}>
          {i > 0 && <span className="sep" />}
          <b>{t}</b>
        </span>
      ))}
      <span className="sep" />
    </span>
  );
}

export default function LandingPage() {
  return (
    <LandingRoot>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      {/* --- atmosphere (marketing.html:275-286) --- */}
      <div className="grain" aria-hidden="true" />
      <div className="brand-bloom" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />
      <div className="bg-grid" aria-hidden="true" />
      <div className="glow-field" aria-hidden="true">
        <div className="glow-plane plane-amber" />
        <div className="glow-plane plane-ember" />
        <div className="glow-plane plane-cool" />
      </div>
      <svg
        className="twinkle"
        id="twinkle"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid slice"
        viewBox={`0 0 ${TWINKLE_W} ${TWINKLE_H}`}
      >
        {twinkleDots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} style={{ '--d': `${d.d}s` } as React.CSSProperties} />
        ))}
      </svg>
      <div className="scroll-progress" aria-hidden="true" />

      {/* --- shared SVG defs (marketing.html:289-301) --- */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="leashGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0" />
            <stop offset="45%" stopColor="var(--accent-hi)" />
            <stop offset="55%" stopColor="var(--accent-hi)" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          <filter id="leashGlow" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>

      <nav id="nav" aria-label="Primary">
        <div className="wrap">
          <div className="brand">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
              <circle cx="8" cy="13" r="5" fill="none" stroke="var(--accent)" strokeWidth="2" />
              <path d="M13 13 H24" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
              <path d="M24 9 v8" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
            </svg>
            LEASH
          </div>
          <div className="navlinks">
            <a href="#how">How it holds</a>
            <a href="#demo">The console</a>
            <a href="#proof">Live rail</a>
            <a href="#docs">Proof</a>
          </div>
          <div className="nav-right">
            <ThemeToggle />
            {/* the artifact points at `console.html`; the live route is /app */}
            <Link href="/app" className="btn btn-primary press magnetic">
              <span className="shine" />
              Open console
            </Link>
          </div>
        </div>
      </nav>

      <div className="wrap">
        <header className="hero" id="hero">
          <div className="motes" id="motes" aria-hidden="true">
            {/* marketing.html:639-647 — deterministic, so server-rendered. The CSS `reduce`
                block hides them; the controller also hides them under saveData. */}
            {Array.from({ length: 16 }, (_, i) => (
              <span
                key={i}
                className="mote"
                style={
                  {
                    left: `${(i * 61) % 100}%`,
                    '--mdur': `${11 + (i % 7)}s`,
                    '--d': `${((i * 0.9) % 12).toFixed(1)}s`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
          <div className="object-stage">
            <svg
              className="looplink"
              viewBox="0 0 120 48"
              width="440"
              height="176"
              focusable="false"
              aria-hidden="true"
            >
              <g className="ll-sway">
                <circle className="ll-loop" cx="17" cy="24" r="11" fill="none" />
                <path className="ll-tether" d="M28 24 C 42 24, 46 14, 57 19 S 70 29, 77 24" fill="none" />
              </g>
              <rect
                className="ll-link ll-link1"
                x="80"
                y="17"
                width="20"
                height="14"
                rx="7"
                fill="none"
                transform="rotate(-14 90 24)"
              />
              <rect
                className="ll-link ll-link2"
                x="96"
                y="17"
                width="20"
                height="14"
                rx="7"
                fill="none"
                transform="rotate(14 106 24)"
              />
              <circle className="ll-spark" cx="77" cy="24" r="2.6" />
            </svg>
            <div className="ll-verdict mono" id="llVerdict" aria-hidden="true" />
          </div>
          <button className="ll-beat mono" id="llBeat" type="button" aria-live="polite">
            <span className="ll-dot" aria-hidden="true" />
            <span className="ll-play" aria-hidden="true">
              ▶
            </span>
            <span id="llState">Try to overspend</span>
          </button>
          <span className="hero-eyebrow eyebrow">
            <span className="dot ping-ring" aria-hidden="true" />
            Agent spend-control · 0G + Privy
          </span>
          <h1 className="h-display">
            <span className="line reveal-swipe">
              Keep your <span className="recess">agents</span>
            </span>{' '}
            <span className="line reveal-swipe" style={{ animationDelay: '.12s' }}>
              on a <span className="amber glow-word">leash</span>.
            </span>
          </h1>
          <p className="sub reveal-up">
            Give an AI agent its own wallet, then bound it: a per-transfer cap it cannot raise, an allowlist it cannot
            widen, and one on-chain write that cuts it off everywhere.
          </p>
          <div className="cta reveal-up">
            <Link href="/app" className="btn btn-primary press magnetic">
              <span className="shine" />
              Open the console
            </Link>
            <a href="#how" className="btn btn-ghost press magnetic">
              Read the thesis →
            </a>
          </div>
          {/* ADDITION, stated: the object and the streams below are scripted. Saying so is
              what keeps a demo from reading as live fleet data. */}
          <p className="sim-note">Simulated. The real leash lives in the console.</p>
        </header>
      </div>

      {/* --- SIGNATURE: the living leash (marketing.html:355-373) --- */}
      <div className="leash-band">
        <svg
          className="band leash-svg leash-draw"
          viewBox="0 0 1200 160"
          preserveAspectRatio="none"
          role="img"
          aria-label="A leash tethering an agent to a payee; signals stream along it and the sag shows budget headroom."
        >
          <g className="leash-sway">
            <circle className="leash-clasp" cx="52" cy="80" r="11" />
            <path className="leash-clasp" d="M150 62 v36 M164 62 v36" strokeWidth="1.5" />
            <path className="leash-path" id="heroPath" d="M63 80 Q 630 128 1148 80" filter="url(#leashGlow)" />
            <path className="leash-shimmer shimmer-run" id="heroShimmer" d="M63 80 Q 630 128 1148 80" />
            <path className="leash-clasp" d="M1148 80 a9 9 0 1 0 -0.1 0" strokeWidth="2" />
            <circle className="signal-pulse run pk" cx="0" cy="0" />
            <circle className="signal-pulse run d1 pk" cx="0" cy="0" />
            <circle className="signal-pulse run d2 pk" cx="0" cy="0" />
            <circle className="signal-pulse deny run d3 pkd" cx="0" cy="0" />
            <text className="gate-pop mono" x="157" y="46" textAnchor="middle" fill="var(--deny)" fontSize="10">
              DENY
            </text>
          </g>
        </svg>
        <div className="leash-label">
          {/* reconciled: the artifact invents an ENS name (research.org.leash.eth), but the
              product has no ENS naming — agents are identified by address + role
              (web/lib/types.ts). Cap re-denominated to the real guarantee (0.01 0G). */}
          <span>
            agent · <b>0xA91f…3e</b> · research-agent
          </span>
          <span id="leashSlack">
            slack <b>62%</b> · cap <b>0.01 0G</b> / transfer
          </span>
        </div>
      </div>

      <div className="wrap">
        <div className="marquee" aria-hidden="true">
          <div className="marquee-track" id="marquee">
            <MarqueeRun />
            <MarqueeRun />
          </div>
        </div>
      </div>

      <div className="wrap">
        {/* --- THE PROBLEM — the one live-only section kept (ruling D2), re-dressed in the
            artifact's own section idiom. It is why the product exists; the artifact has no
            equivalent, so dropping it would lose the argument, not just the styling. --- */}
        <section id="problem" aria-labelledby="problem-title">
          <div className="sec-head">
            <span className="eyebrow">The problem</span>
            <h2 className="h1" id="problem-title">
              This already went wrong for other people.
            </h2>
          </div>
          <div className="problem-body reveal-up">
            <p>
              In January 2026, ungoverned trading agents at Step Finance moved 27 to 30 million dollars. A prompt
              injection drained roughly 150 to 200 thousand dollars from Grok and Bankr users after a guardrail was
              silently rewritten. The lesson is simple.
            </p>
            <p className="thesis">Instructions don&apos;t survive a clever prompt. Contracts do.</p>
            <p>
              So LEASH puts the boundary where prompts can&apos;t reach it: enforced on-chain, not by a system prompt
              the agent can be talked out of.
            </p>
          </div>
        </section>

        {/* --- PRODUCT DEMONSTRATES ITSELF (marketing.html:380-431) --- */}
        <section id="demo" aria-labelledby="demo-title">
          <div className="demo">
            <div className="copy">
              <span className="eyebrow reveal-up">The console, live</span>
              <h2 className="h1 reveal-up" id="demo-title">
                You watch every move it makes.
              </h2>
              <p className="reveal-up">
                This isn&apos;t a screenshot. It&apos;s the real console chrome, breathing — a fleet card whose tether
                tautens as spend nears the cap, and a verdict stream adjudicating each transfer in real time. The same
                approval card reaches you on your phone, through the LEASH Telegram bot.
              </p>
              <ul>
                <li className="reveal-up">
                  <span className="mk" aria-hidden="true" />
                  <span>
                    <b>The tension meter</b> is the budget — slack when there&apos;s room, taut near the cap.
                  </span>
                </li>
                <li className="reveal-up">
                  <span className="mk" aria-hidden="true" />
                  <span>
                    <b>Every verdict</b> flashes in once, jade for allow, garnet for deny — then rests.
                  </span>
                </li>
                <li className="reveal-up">
                  <span className="mk" aria-hidden="true" />
                  <span>
                    <b>One cut</b> revokes it on-chain, everywhere a rail resolves the record.
                  </span>
                </li>
              </ul>
              {/* The device below is a scripted demo with illustrative figures. #demo is
                  reachable directly via the nav, where the hero's sim-note isn't in view,
                  so the label has to live here too (Gate-② finding). */}
              <p className="sim-note">Simulated console. The real one, with your fleet, lives behind sign-in.</p>
            </div>
            <div className="device-wrap">
              <div className="device device-reveal tilt glass-grain" id="device">
                <div className="screen">
                  <div className="mc-top">
                    <span className="t">Fleet</span>
                    <span className="mc-live">
                      <span className="live-dot" aria-hidden="true" />
                      LIVE · rail settling
                    </span>
                  </div>
                  <div className="mc-body">
                    <div className="mc-rail" aria-hidden="true">
                      <span className="ic on">
                        <svg viewBox="0 0 16 16">
                          <circle cx="5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M8 8h6" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </span>
                      <span className="ic">
                        <svg viewBox="0 0 16 16">
                          <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M2 7h12" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </span>
                      <span className="ic">
                        <svg viewBox="0 0 16 16">
                          <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </span>
                      <span className="ic">
                        <svg viewBox="0 0 16 16">
                          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </span>
                    </div>
                    <div className="mc-main">
                      <div className="mc-card">
                        <div className="r1">
                          <div>
                            <div className="nm">research-agent</div>
                            <div className="ad">0xA91f…3e</div>
                          </div>
                          <span className="chip chip-allow">Active</span>
                        </div>
                        <div className="mc-meter">
                          <svg
                            className="leash-svg"
                            id="mcMeter"
                            viewBox="0 0 300 40"
                            preserveAspectRatio="none"
                            role="img"
                            aria-label="live tension meter"
                          >
                            <circle className="leash-clasp" cx="8" cy="20" r="4" />
                            <path className="leash-path" id="mcPath" d="M12 20 Q 156 30 294 20" />
                            <path className="leash-clasp" d="M294 20 a4 4 0 1 0 -0.1 0" strokeWidth="1.6" />
                          </svg>
                          <div className="cap">
                            <span>
                              slack <b id="mcSlack">62%</b>
                            </span>
                            <span>
                              <b id="mcSpent">$188</b> / $500 today
                            </span>
                          </div>
                        </div>
                        <div className="mc-think" id="mcThink">
                          <span className="tk" aria-hidden="true">
                            ◦
                          </span>
                          <span id="mcThinkT">reasoning over the rail…</span>
                        </div>
                        <div className="mc-stream" id="mcStream">
                          <div className="mc-row">
                            <span className="chip chip-allow">Allow</span>
                            <span className="py">api.exa.ai</span>
                            <span className="am">$4.20</span>
                          </div>
                          <div className="mc-row">
                            <span className="chip chip-deny">Deny</span>
                            <span className="py">0x9c…f1 · off-list</span>
                            <span className="am">$240.00</span>
                          </div>
                          <div className="mc-row">
                            <span className="chip chip-allow">Allow</span>
                            <span className="py">api.openai.com</span>
                            <span className="am">$12.80</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* --- HOW IT HOLDS — asymmetric bento (marketing.html:434-489) --- */}
        <section id="how" aria-labelledby="how-title">
          <div className="sec-head">
            <span className="eyebrow">How the leash holds</span>
            <h2 className="h1" id="how-title">
              Three bounds it cannot loosen. One cut you can make.
            </h2>
            <p className="lede">
              The policy lives in a contract on 0G Chain. The contract checks it before every settle. The agent signs —
              it never sets.
            </p>
          </div>
          <div className="bento">
            <div className="hcard wide reveal-up lift" data-rung="1" tabIndex={0}>
              <span className="idx" aria-hidden="true">
                01
              </span>
              <span className="step">CAP</span>
              <h3>A ceiling it can&apos;t raise</h3>
              <p>
                Per-transfer, daily and weekly caps are fields in the policy contract on 0G Chain. The contract reads
                them, compares, and settles only within them.
              </p>
              <div className="code">
                MAX_PER_TRANSFER = <b>0.01 0G</b> · MAX_WINDOW = <b>0.05 0G</b>
              </div>
              <div className="mini leash-hover" data-leash="slack">
                <svg className="leash-svg" viewBox="0 0 480 46" preserveAspectRatio="none" aria-hidden="true">
                  <circle className="leash-clasp" cx="10" cy="23" r="5" />
                  <path className="leash-path hp" d="M16 23 Q 248 38 474 23" />
                  <path className="leash-clasp" d="M474 23 a5 5 0 1 0 -0.1 0" strokeWidth="1.8" />
                </svg>
              </div>
            </div>
            <div className="hcard tall reveal-up lift" data-rung="2" tabIndex={0}>
              <span className="idx" aria-hidden="true">
                02
              </span>
              <span className="step">ALLOWLIST</span>
              <h3>A reach it can&apos;t widen</h3>
              <p>Funds only move to payees the owner added. The agent has no path to extend its own allowlist.</p>
              <div className="mini leash-hover" data-leash="taut">
                <svg className="leash-svg taut" viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden="true">
                  <circle className="leash-clasp" cx="10" cy="23" r="5" />
                  <path className="leash-path hp" d="M16 23 Q 114 28 214 23" />
                  <path className="leash-clasp" d="M214 23 a5 5 0 1 0 -0.1 0" strokeWidth="1.8" />
                </svg>
              </div>
            </div>
            <div className="hcard third reveal-up lift" data-rung="3" tabIndex={0}>
              <span className="idx" aria-hidden="true">
                03
              </span>
              <span className="step">REVOKE</span>
              <h3>One write that cuts it off</h3>
              <p>
                Revoke is a single on-chain write. Every rail resolving that record stops honoring the agent — at once.
              </p>
              <div className="mini leash-hover" data-leash="cut">
                <svg className="leash-svg cut" viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden="true">
                  <circle className="leash-clasp" cx="10" cy="23" r="5" />
                  <path className="leash-path" d="M16 23 L 100 23" />
                  <path className="leash-path" d="M118 23 L 214 23" />
                  <path d="M104 14 l7 18 M115 14 l-7 18" stroke="var(--deny)" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
            </div>
            <div className="hcard half reveal-up lift" data-rung="2" tabIndex={0}>
              <span className="step">HONEST BOUNDARY</span>
              <h3>What the leash actually is</h3>
              <p>
                <b style={{ color: 'var(--ink)' }}>Control, not custody.</b> Caps are a soft budget the rail enforces on
                settle; the allowlist defaults so the agent can&apos;t widen its own reach; revoke is on-chain-resolved.
                It is not a trustless vault — it&apos;s a leash you hold and can cut.
              </p>
            </div>

            {/* R-1, BINDING DEBT (opened by G-1.3, closed here). The hero's two
                `.outcome-card`s were removed because the locked build states the verdict in
                `.ll-verdict` and its hero proportions depend on nothing sitting below the
                CTAs. Their prose moves here, where the mini-leashes already depict exactly
                these two outcomes. Span 3 each, so they fill one bento row cleanly without
                disturbing the artifact's own asymmetry above. */}
            <div className="hcard half reveal-up lift" data-rung="3" tabIndex={0}>
              <span className="step verdict-deny">REFUSED</span>
              <h3>Refused. Over the per-transfer cap.</h3>
              <p>The contract held. You didn&apos;t have to be awake.</p>
              <div className="mini leash-hover" data-leash="taut">
                <svg className="leash-svg taut" viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden="true">
                  <circle className="leash-clasp" cx="10" cy="23" r="5" />
                  <path className="leash-path hp" d="M16 23 Q 114 28 214 23" />
                  <path className="leash-clasp" d="M214 23 a5 5 0 1 0 -0.1 0" strokeWidth="1.8" />
                </svg>
              </div>
            </div>
            <div className="hcard half reveal-up lift" data-rung="4" tabIndex={0}>
              <span className="step verdict-allow">REVOKED</span>
              <h3>Revoked in one move.</h3>
              <p>The record stays: hash-chained, yours alone.</p>
              <div className="mini leash-hover" data-leash="cut">
                <svg className="leash-svg cut" viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden="true">
                  <circle className="leash-clasp" cx="10" cy="23" r="5" />
                  <path className="leash-path" d="M16 23 L 100 23" />
                  <path className="leash-path" d="M118 23 L 214 23" />
                  <path d="M104 14 l7 18 M115 14 l-7 18" stroke="var(--deny)" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
            </div>
          </div>
        </section>

        {/* --- LIVE RAIL (marketing.html:492-506) --- */}
        <section id="proof" aria-labelledby="proof-title">
          <div className="sec-head center">
            <span className="eyebrow">Live rail</span>
            <h2 className="h1" id="proof-title">
              Every move, adjudicated.
            </h2>
            <p className="lede">
              Allow or deny, with the reason and the on-chain receipt. This is what the rail writes as your fleet
              spends.
            </p>
          </div>
          <div className="rail-top reveal-up">
            <span className="section-title">Verdict stream · live</span>
            <span className="settled">
              settled today <b id="settled">$1,284</b>
            </span>
          </div>
          <div className="rail-panel reveal-up">
            <div className="rail-head" aria-hidden="true">
              <span>Verdict</span>
              <span>Agent → payee</span>
              <span>Reason</span>
              <span style={{ textAlign: 'right' }}>Amount</span>
              <span>Tx</span>
            </div>
            <div id="railRows">
              {RAIL_SEED.map(([v, agent, payee, reason, amt, tx], i) => (
                <div className="vrow" key={i}>
                  <span className={`chip ${v === 'allow' ? 'chip-allow' : 'chip-deny'}`}>
                    {v === 'allow' ? 'Allow' : 'Deny'}
                  </span>
                  <span className="who">
                    {agent} → <small>{payee}</small>
                  </span>
                  <span className="reason faint">{reason}</span>
                  <span className="amt">{amt}</span>
                  <span className="tx">{tx}</span>
                </div>
              ))}
            </div>
          </div>
          {/* The rail above is a simulated stream — real verdicts are owner-scoped
              (backend/src/api/owner-routes.ts). But the contracts that enforce it are real
              and Sourcify-verified on 0G Galileo (docs/DEPLOYMENTS.md). Ruling (G-2.0): wire
              that real proof into #proof rather than leave the section's truth-claim empty. */}
          <p className="proof-note">
            <span className="faint">Stream simulated. The contracts enforcing it are real, on 0G Galileo testnet:</span>
            <a
              className="proof-link"
              href="https://repo.sourcify.dev/contracts/full_match/16602/0xA74d573F43CFDA890713Bd348186ab80736642C3/"
              target="_blank"
              rel="noopener noreferrer"
            >
              AgentRegistry ↗
            </a>
            <a
              className="proof-link"
              href="https://repo.sourcify.dev/contracts/full_match/16602/0xcD7818673238E2703585CF96658FeBf1a10f8105/"
              target="_blank"
              rel="noopener noreferrer"
            >
              LeashAccountFactory ↗
            </a>
            <a
              className="proof-link"
              href="https://chainscan-galileo.0g.ai/tx/0x3d5539482ae573ab11e64977635ee3a568d8e5815308ccb37430e5fd5d402b96"
              target="_blank"
              rel="noopener noreferrer"
            >
              a live revoke ↗
            </a>
            <span className="faint">— both Sourcify-verified.</span>
          </p>
        </section>

        {/* --- METRICS (marketing.html:509-517) --- */}
        <section id="docs" aria-labelledby="docs-title">
          <div className="sec-head">
            <span className="eyebrow">By the numbers</span>
            <h2 className="h1" id="docs-title">
              The whole guarantee, in three figures.
            </h2>
          </div>
          <div className="metrics">
            <div className="metric reveal-up lift">
              {/* re-denominated to the real guarantee (web/components/create/templates.ts):
                  0.01 0G per transfer. data-suf carries the unit so count-up still runs. */}
              <span className="stat" data-count="0.01" data-suf=" 0G">
                0.01 0G
              </span>
              <span className="lbl">hard per-transfer cap the agent cannot raise</span>
            </div>
            <div className="metric reveal-up lift">
              <span className="stat" data-count="1">
                1
              </span>
              <span className="lbl">on-chain write to revoke, everywhere</span>
            </div>
            <div className="metric reveal-up lift">
              <span className="stat" data-count="0">
                0
              </span>
              <span className="lbl">ways an agent widens its own reach</span>
            </div>
          </div>
        </section>
      </div>

      {/* --- CLOSING BEAT (marketing.html:521-540) --- */}
      <div className="closer sever-recoil" id="closer">
        <svg className="sever leash-svg" viewBox="0 0 760 130" preserveAspectRatio="none" aria-hidden="true">
          <circle className="leash-clasp" cx="14" cy="65" r="9" />
          <path className="leash-clasp" d="M754 65 a9 9 0 1 0 -0.1 0" strokeWidth="2" />
          <path className="leash-path whole" d="M23 65 Q 380 101 745 65" filter="url(#leashGlow)" />
          <g className="halves">
            <path
              className="leash-path recoil-l"
              style={{ stroke: 'var(--deny)', strokeDasharray: '3 5' }}
              d="M23 65 Q 250 89 372 71"
            />
            <path
              className="leash-path recoil-r"
              style={{ stroke: 'var(--deny)', strokeDasharray: '3 5' }}
              d="M388 71 Q 520 89 745 65"
            />
            <g className="sever-spark" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
              <path d="M372 50 l8 30 M388 50 l-8 30" stroke="var(--deny)" strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="380" cy="65" r="3.5" fill="var(--deny)" />
            </g>
          </g>
        </svg>
        <h2 className="h-display" style={{ fontSize: 'var(--t-h1)' }}>
          When you&apos;re done, you <span className="amber glow-word">cut it</span>.
        </h2>
        <div className="cta" style={{ justifyContent: 'center' }}>
          <Link href="/app" className="btn btn-primary press magnetic">
            <span className="shine" />
            Open the console
          </Link>
          <a href="#how" className="btn btn-ghost press magnetic">
            Read the thesis →
          </a>
        </div>
      </div>

      <footer>
        <div className="wrap">
          <span>LEASH · keep your agents on a leash</span>
          <span className="mono">0G Chain · 0G Compute · 0G Storage · Privy</span>
        </div>
      </footer>
    </LandingRoot>
  );
}
