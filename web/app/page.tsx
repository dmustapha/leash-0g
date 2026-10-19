// File: web/app/page.tsx
// Home (route: /) — the LEASH marketing landing, ported from the static Vite build
// (landing/index.html + src/final.css/tokens.css/final.js). Renders with zero wallet
// gate: no owner-wallet/Privy hooks here, so `/` is reachable without authentication.
// The console fleet list moved to /app. Styles are scoped under `.leash-landing`
// (app/landing.css) so the console globals never collide. SiteNav hides itself on `/`
// (see components/SiteNav.tsx); this page renders the landing's own minimal header.
import type { Metadata } from 'next';
import Link from 'next/link';
import './landing.css';
import { LandingRoot } from '@/components/landing/HeroBeat';
import ThemeToggle from '@/components/landing/ThemeToggle';

export const metadata: Metadata = {
  title: 'LEASH · Let your AI agent spend real money. Keep the leash.',
  description:
    'Let your AI agent spend real money inside hard on-chain limits a hijacked agent cannot exceed. Watch it reason live, step in before it spends, revoke in one move. Live on 0G testnet.',
};

export default function LandingPage() {
  return (
    <LandingRoot>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="nav">
        <div className="container nav-row">
          <Link className="brand" href="/">
            LEASH
          </Link>
          {/* STAGE G-1.2 — the reference groups the theme control and the primary CTA
              in a `.nav-right` cluster (marketing.html:315-318); matched here. */}
          <div className="nav-right">
            <ThemeToggle />
            <Link className="pill pill-line pill-sm" href="/app">
              Open the cockpit
            </Link>
          </div>
        </div>
      </header>

      <div>
        {/* 1 · HERO */}
        <section className="hero container" aria-labelledby="hero-title">
          {/* G-1.3 M-1 · ambient motes (marketing.html:324, JS :638-647, tokens.css:442-444).
              The values are deterministic, so they render server-side instead of via innerHTML:
              the reference's own i*61%100 / 11+i%7 / i*0.9%12 table, rounded to kill float noise
              (i=3 would emit 2.7000000000000002s). Suppressed by the `reduce` block in CSS, and
              by `hidden` under saveData in HeroBeat — matching the reference's `if(reduceMo) return`. */}
          <div className="motes" id="motes" aria-hidden="true">
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

          <div className="object-stage" id="demo">
            <svg
              className="looplink"
              width="480"
              height="192"
              viewBox="0 0 120 48"
              aria-hidden="true"
              focusable="false"
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
              {/* G-1.3 M-2 · the snap spark at the tether's end (marketing.html:333, CSS :111/:115). */}
              <circle className="ll-spark" cx="77" cy="24" r="2.6" />
            </svg>
            {/* G-1.3 M-3 · verdict pop (marketing.html:335). aria-hidden by design — the
                announcement lives on the .ll-beat button's aria-live, exactly as the reference
                has it (:336), so one live region speaks, not two. */}
            <div className="ll-verdict mono" id="ll-verdict" aria-hidden="true" />
          </div>

          {/* G-1.3 M-4 · the beat is its own centered control directly under the object
              (marketing.html:336-338), not one pill in a row of three. The caption IS the button
              that plays the refusal; the dot and ▶ carry the state colour. */}
          <button className="ll-beat mono" id="btn-beat" type="button" aria-live="polite">
            <span className="ll-dot" aria-hidden="true" />
            <span className="ll-play" aria-hidden="true">
              ▶
            </span>
            <span id="ll-state">Try to overspend</span>
          </button>

          <h1 id="hero-title" className="reveal">
            Let your AI agent spend real&nbsp;money. Keep the&nbsp;leash.
          </h1>
          <p className="hero-sub reveal reveal-1">
            Your agent works inside limits a hijacked agent cannot exceed. Watch it reason live. Step in when it
            matters. Snap the leash when it doesn&apos;t.
          </p>

          <div className="hero-ctas reveal reveal-2">
            <a className="pill pill-primary" id="cta-watch" href="#demo">
              Watch a leash hold
            </a>
            <Link className="pill pill-line" href="/app">
              Open the cockpit
            </Link>
          </div>

          {/* G-1.3 R-1 · the two `.outcome-card`s are GONE from the hero: the locked build states
              the verdict in the `.ll-verdict` pill above the object, and its hero proportions
              depend on no cards sitting below the CTAs. The prose is NOT lost — it is relocated
              verbatim into the `#how` bento as two `.hcard`s (REFUSED / REVOKED, with the
              data-leash="taut"/"cut" mini-leashes that already depict those outcomes). That is a
              BINDING G-1.4 obligation, recorded in STAGE-G-1.3-HERO-RECONCILE-PLAN.md §5.

              `.sim-note` STAYS, as a stated deviation under scope §0(a): the reference is a
              static artifact, but this hero ships above a real product, and the note is what
              stops a visitor reading a scripted animation as live fleet data. The force is
              truthfulness, not taste. */}
          <p className="sim-note">Simulated. The real leash lives in the cockpit.</p>
        </section>

        {/* HUMANE NUMBERS */}
        <section className="numbers container" aria-labelledby="numbers-title" data-reveal>
          <p className="eyebrow" aria-hidden="true">
            The limits
          </p>
          <h2 id="numbers-title" className="visually-hidden">
            The limits, in plain numbers
          </h2>
          <div className="number-row">
            <div className="number">
              <span className="number-big mono" data-count="0.002">
                0.002
              </span>
              <span className="number-cap">0G per transfer, at most. The contract refuses anything bigger.</span>
            </div>
            <div className="number number-late">
              <span className="number-big mono" data-count="0.006">
                0.006
              </span>
              <span className="number-cap">0G per spending window. Then the account goes quiet.</span>
            </div>
            <div className="number">
              <span className="number-big mono" data-count="1">
                1
              </span>
              <span className="number-cap">move to revoke. Mid-thought, mid-transaction, any time.</span>
            </div>
          </div>
          <p className="numbers-note">These are the live limits on the leash account in the receipts below.</p>
        </section>

        {/* 2 · THE PROBLEM */}
        <section className="problem container" aria-labelledby="problem-title" data-reveal>
          <p className="eyebrow" aria-hidden="true">
            The problem
          </p>
          <h2 id="problem-title">This already went wrong for other people.</h2>
          <p>
            In January 2026, ungoverned trading agents at Step Finance moved 27 to 30 million dollars. A prompt
            injection drained roughly 150 to 200 thousand dollars from Grok and Bankr users after a guardrail was
            silently rewritten. The lesson is simple.
          </p>
          <p className="thesis">Instructions don&apos;t survive a clever prompt. Contracts do.</p>
          <p>
            So LEASH puts the boundary where prompts can&apos;t reach it: enforced by a contract on 0G Chain, not by a
            system prompt the agent can be talked out of.
          </p>
        </section>

        {/* 3 · HOW THE LEASH WORKS */}
        <section className="how container" aria-labelledby="how-title" data-reveal>
          <p className="eyebrow" aria-hidden="true">
            How it works
          </p>
          <h2 id="how-title">How the leash works</h2>
          <ol className="how-steps">
            <li className="how-step">
              <span className="how-num mono" aria-hidden="true">
                01
              </span>
              <h3>Bind</h3>
              <p>
                Create a leash account for your agent: a per-transfer cap, a spending window, an allowlist, and an
                expiry. The limits are enforced on 0G Chain.
              </p>
            </li>
            <li className="how-step">
              <span className="how-num mono" aria-hidden="true">
                02
              </span>
              <h3>Watch</h3>
              <p>
                See its reasoning live as it&apos;s served by 0G Compute, with attested inference where you choose the
                TEE providers.
              </p>
            </li>
            <li className="how-step">
              <span className="how-num mono" aria-hidden="true">
                03
              </span>
              <h3>Contain</h3>
              <p>
                A fully hijacked agent cannot exceed the caps. Over the limit, the contract refuses. Step in before it
                spends, or don&apos;t. The boundary holds either way.
              </p>
            </li>
            <li className="how-step">
              <span className="how-num mono" aria-hidden="true">
                04
              </span>
              <h3>Prove</h3>
              <p>
                Every decision is hash-chained, encrypted to you alone, and anchored on 0G Storage. Revoke in one move.
                The record stays.
              </p>
            </li>
          </ol>
        </section>

        {/* 4 · THE DAILY LOOP */}
        <section className="daily" aria-labelledby="daily-title" data-reveal>
          <div className="container daily-inner">
            <p className="eyebrow" aria-hidden="true">
              The daily loop
            </p>
            <h2 id="daily-title">Most days it&apos;s one small question.</h2>
            <p className="daily-lede">
              A rare boundary decision arrives with Approve and Deny inline. A daily digest tells you what was spent and
              what was refused. Nothing else asks for your attention.
            </p>
            <div className="daily-sample" aria-label="Sample boundary decision">
              <span className="daily-q">
                treasury-bot wants <span className="mono">0.05 0G</span> for an address you haven&apos;t approved.
              </span>
              <span className="daily-a">
                <span className="chip chip-ok">Approve</span>
                <span className="chip chip-no">Deny</span>
              </span>
            </div>
            <p className="daily-phone">The same card lands on your phone, through the LEASH Telegram bot.</p>
          </div>
        </section>

        {/* 5 · RECEIPTS */}
        <section className="receipts container" id="receipts" aria-labelledby="receipts-title" data-reveal>
          <p className="eyebrow" aria-hidden="true">
            Receipts
          </p>
          <h2 id="receipts-title">The receipts</h2>
          <ul className="receipt-list">
            <li>
              <span className="receipt-name">AgentRegistry</span>
              <a
                className="mono"
                href="https://chainscan-galileo.0g.ai/address/0xA74d573F43CFDA890713Bd348186ab80736642C3"
                target="_blank"
                rel="noopener noreferrer"
              >
                0xA74d…42C3
              </a>
              <a
                className="verify"
                href="https://repo.sourcify.dev/contracts/full_match/16602/0xA74d573F43CFDA890713Bd348186ab80736642C3/"
                target="_blank"
                rel="noopener noreferrer"
              >
                sourcify-verified
              </a>
            </li>
            <li>
              <span className="receipt-name">LeashAccountFactory</span>
              <a
                className="mono"
                href="https://chainscan-galileo.0g.ai/address/0x5100f7a9661F56842342C21aAAc15169A7fD3c52"
                target="_blank"
                rel="noopener noreferrer"
              >
                0x5100…3c52
              </a>
              <a
                className="verify"
                href="https://repo.sourcify.dev/contracts/full_match/16602/0x5100f7a9661F56842342C21aAAc15169A7fD3c52/"
                target="_blank"
                rel="noopener noreferrer"
              >
                sourcify-verified
              </a>
            </li>
            <li>
              <span className="receipt-name">A coordinated agent act</span>
              <a
                className="mono"
                href="https://chainscan-galileo.0g.ai/tx/0xf3e61c52be3442b850752252a9f4a881ffd53d198ee534468caa220bc965a34f"
                target="_blank"
                rel="noopener noreferrer"
              >
                0xf3e6…a34f
              </a>
              <span className="verify">confirmed transaction</span>
            </li>
          </ul>
          <p className="receipts-note">Live on 0G testnet. No mainnet funds are at stake yet.</p>
        </section>

        {/* 6 · CTA CLOSE */}
        <section className="closing container" aria-labelledby="closing-title" data-reveal>
          <h2 id="closing-title" className="closing-line">
            Your agent works. You keep the&nbsp;leash.
          </h2>
          <div className="closing-ctas">
            <a className="pill pill-primary" href="#demo">
              Watch a leash hold
            </a>
            <Link className="pill pill-line" href="/app">
              Open the cockpit
            </Link>
          </div>
        </section>
      </div>

      <footer className="footer">
        <div className="container footer-line">
          LEASH · reasoning served by 0G Compute · record on 0G Storage · limits enforced by a contract on 0G Chain
        </div>
      </footer>
    </LandingRoot>
  );
}
