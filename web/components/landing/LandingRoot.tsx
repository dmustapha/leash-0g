// File: web/components/landing/LandingRoot.tsx
// STAGE G-2.0 — the marketing page's behaviour, imported from the owner-locked build
// (`web/design-reference/marketing.html:546-825`). Replaces `HeroBeat.tsx`, which only
// carried the hero's six G-1.3 beats; this carries the whole page.
//
// Twelve behaviours, in the artifact's own order:
//   1  Loop-Link hero beat    (:567-620)   7  live rail stream + settled counter (:701-742)
//   2  nav scroll step        (:656-658)   8  device mini-console                (:744-780)
//   3  leash tauten + parallax(:660-683)   9  device tilt                        (:782-792)
//   4  IO reveals             (:685-688)  10  magnetic buttons                   (:794-800)
//   5  count-up               (:690-699)  11  bento mini-leash hover             (:802-818)
//   6  motes under saveData   (G-1.3)     12  closer sever on scroll             (:822-824)
//
// Three structural differences from the artifact, all forced by React and none visible:
//
//  (a) STATE CLASS. The artifact writes `hero.className = 'hero is-taut'`. React owns the
//      root element's className here, so the state rides on `.leash-landing` and the CSS
//      reads `.leash-landing.is-taut #hero` (see app/marketing.css). Identical cascade.
//
//  (b) NO useState. Every mutation is imperative on a ref. State would re-render the root
//      and risk React reconciling away the rail rows this file appends by hand. The
//      `children` prop is referentially stable, so React never walks that subtree.
//
//  (c) saveData. The artifact only checks `prefers-reduced-motion`. A metered connection
//      is motion-agnostic but has the same "don't burn the device" intent, so both fold
//      into one `instant` flag — the reduced-motion CSS still does the visual half.
//
// Every listener, observer, timer and rAF registered below is torn down in the cleanup.
'use client';

import { useEffect, useRef } from 'react';

/** marketing.html:578-582 — `label` is what the NEXT click does. */
const STATES = [
  { cls: 'is-alive', label: 'Try to overspend', verdict: '', vcls: '' },
  { cls: 'is-taut', label: 'Revoke the leash', verdict: 'Refused · cap held', vcls: 'refused' },
  { cls: 'is-snapped', label: 'Forge it again', verdict: 'Revoked · funds safe', vcls: 'revoked' },
] as const;

/** marketing.html:722-728 — [verdict, agent, payee, reason, amount, tx, settles]. */
const RAIL_POOL = [
  ['allow', 'research-agent', 'api.anthropic.com', 'settled', '$9.60', '0xa0f1…', 9.6],
  ['allow', 'ops-agent', 'api.supabase.com', 'settled', '$6.40', '0x33be…', 6.4],
  ['deny', 'ops-agent', '0x77…c2', 'OFF_ALLOWLIST', '$95.00', '—', 0],
  ['allow', 'research-agent', 'api.exa.ai', 'settled', '$3.10', '0x8d2e…', 3.1],
  ['deny', 'scraper-agent', 'api.new-host', 'OVER_DAILY_CAP', '$260.00', '—', 0],
] as const;

/** marketing.html:750-757 — the device reasons out loud, then the verdict lands. */
const DEVICE_FEED = [
  { v: 'allow', py: 'api.anthropic.com', am: '$9.60', n: 9.6, r: 'evaluating api.anthropic.com · $9.60 — within per-transfer cap' },
  { v: 'deny', py: '0x44…ab · off-list', am: '$120.00', n: 0, r: '0x44…ab not on the allowlist — refusing' },
  { v: 'allow', py: 'api.exa.ai', am: '$4.20', n: 4.2, r: 'api.exa.ai on allowlist · $4.20 under budget → signing the transfer' },
  { v: 'allow', py: 'api.render.com', am: '$31.00', n: 31, r: 'settling api.render.com · $31.00 — daily headroom OK' },
  { v: 'deny', py: 'api.new-host · over cap', am: '$260.00', n: 0, r: '$260.00 exceeds the per-transfer cap — refusing' },
  { v: 'allow', py: 'api.stripe.com', am: '$18.00', n: 18, r: 'api.stripe.com known payee · $18.00 — allow' },
] as const;

const SEED_VERDICTS = ['allow', 'deny', 'allow', 'deny', 'allow'] as const;

export function LandingRoot({ children }: { children: React.ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const instant = reduced || conn?.saveData === true;

    // --- teardown registry. Everything pushes here; nothing is cleaned up ad hoc. ---
    const offs: (() => void)[] = [];
    const on = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K | string,
      fn: EventListenerOrEventListenerObject,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      offs.push(() => target.removeEventListener(type, fn, opts));
    };
    // Timers and frames self-deregister when they fire. The page runs two forever-
    // intervals (rail 3.6s, device 2.8s), each spawning a timeout per tick — a plain
    // push-only registry would grow a closure per tick for as long as the tab is open.
    const timeouts = new Set<number>();
    const rafs = new Set<number>();
    offs.push(() => {
      timeouts.forEach(clearTimeout);
      rafs.forEach(cancelAnimationFrame);
    });
    const timer = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        fn();
      }, ms);
      timeouts.add(id);
      return id;
    };
    const interval = (fn: () => void, ms: number) => {
      const id = window.setInterval(fn, ms);
      offs.push(() => clearInterval(id));
      return id;
    };
    const frame = (fn: FrameRequestCallback) => {
      const id = requestAnimationFrame((t) => {
        rafs.delete(id);
        fn(t);
      });
      rafs.add(id);
      return id;
    };
    const observe = (io: IntersectionObserver) => {
      offs.push(() => io.disconnect());
      return io;
    };

    const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel);
    const $$ = <T extends Element>(sel: string) => Array.from(root.querySelectorAll<T>(sel));

    /* ---- 1 · Loop-Link hero beat (marketing.html:567-620) ---- */
    const hero = $<HTMLElement>('#hero');
    const beatBtn = $<HTMLButtonElement>('#llBeat');
    const llState = $<HTMLElement>('#llState');
    const llVerdict = $<HTMLElement>('#llVerdict');

    // (a) the artifact's `set()`, relocated onto the root.
    const setState = (c: string) => {
      root.className = `leash-landing${c ? ` ${c}` : ''}`;
    };
    let verdictRaf: number | undefined;
    const showVerdict = (txt: string, cls: string) => {
      if (!llVerdict) return;
      llVerdict.className = `ll-verdict mono${cls ? ` ${cls}` : ''}`;
      llVerdict.textContent = txt;
      if (verdictRaf) cancelAnimationFrame(verdictRaf);
      verdictRaf = frame(() => llVerdict.classList.toggle('show', !!txt));
    };
    let phase = 0;
    let attract: number | undefined;
    let engaged = false;
    const apply = (p: number) => {
      const s = STATES[p]!;
      setState(s.cls);
      if (llState) llState.textContent = s.label;
      showVerdict(s.verdict, s.vcls);
      phase = p;
    };

    if (instant) {
      apply(0);
    } else {
      setState('will-draw');
      frame(() => {
        setState('will-draw is-drawing');
        // 1650ms hands over just after the 1600ms draw keyframes close the last link.
        timer(() => {
          apply(0);
          // auto-attract plays the refusal story once, unprompted, then yields: every
          // step re-checks `engaged` so a click mid-chain wins immediately.
          attract = timer(() => {
            if (engaged) return;
            apply(1);
            attract = timer(() => {
              if (engaged) return;
              apply(2);
              attract = timer(() => {
                if (engaged) return;
                apply(0);
              }, 2600);
            }, 2100);
          }, 2400);
        }, 1650);
      });
    }
    if (beatBtn) {
      on(beatBtn, 'click', () => {
        engaged = true;
        if (attract) clearTimeout(attract);
        apply((phase + 1) % STATES.length);
      });
    }

    // pointer parallax — the forged object leans toward the cursor.
    const looplink = $<SVGElement>('.looplink');
    if (hero && looplink && !instant) {
      on(hero, 'pointermove', ((e: PointerEvent) => {
        const r = hero.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width - 0.5;
        const ny = (e.clientY - r.top) / r.height - 0.5;
        looplink.style.setProperty('--ry', `${(nx * 12).toFixed(2)}deg`);
        looplink.style.setProperty('--rx', `${(-ny * 9).toFixed(2)}deg`);
      }) as EventListener);
      on(hero, 'pointerleave', () => {
        looplink.style.setProperty('--ry', '0deg');
        looplink.style.setProperty('--rx', '0deg');
      });
    }

    /* ---- 6 · motes. The artifact never renders them under reduced motion; here they are
       server-rendered and the CSS `reduce` block hides them — but that block is blind to
       saveData, so close that half here. ---- */
    const motes = $<HTMLElement>('#motes');
    if (motes && instant) motes.hidden = true;

    /* ---- 2 · nav scroll step (marketing.html:656-658) ---- */
    const nav = $<HTMLElement>('#nav');
    if (nav) {
      const onNavScroll = () => nav.classList.toggle('scrolled', window.scrollY > 40);
      on(window, 'scroll', onNavScroll, { passive: true });
      onNavScroll();
    }

    /* ---- 3 · scroll-linked leash tauten + glow-plane parallax (marketing.html:660-683) ---- */
    const heroPath = $<SVGPathElement>('#heroPath');
    const heroShimmer = $<SVGPathElement>('#heroShimmer');
    const slackEl = $<HTMLElement>('#leashSlack');
    const pulses = $$<SVGElement>('.leash-band .signal-pulse');
    const setPulsePaths = (d: string) => {
      pulses.forEach((p) => {
        p.style.setProperty('offset-path', `path('${d}')`);
        p.style.setProperty('-webkit-offset-path', `path('${d}')`);
      });
    };
    const setLeash = (sag: number) => {
      const d = `M63 80 Q 630 ${sag.toFixed(1)} 1148 80`;
      heroPath?.setAttribute('d', d);
      heroShimmer?.setAttribute('d', d);
      const slack = Math.max(0, Math.min(1, (sag - 80) / 48));
      if (slackEl) {
        // textContent + a rebuilt <b>, not innerHTML: same output, no HTML parse per frame.
        // Cap re-denominated to the real guarantee (0.01 0G) to match page.tsx.
        slackEl.textContent = '';
        const b1 = document.createElement('b');
        b1.textContent = `${Math.round(slack * 100)}%`;
        const b2 = document.createElement('b');
        b2.textContent = '0.01 0G';
        slackEl.append('slack ', b1, ' · cap ', b2, ' / transfer');
      }
    };
    if (heroPath) {
      setLeash(128);
      // the pulses ride a FIXED catenary: re-parsing offset-path per frame is the one
      // thing in this page that actually costs, and the drift is imperceptible.
      setPulsePaths('M63 80 Q 630 128 1148 80');
    }
    const planes = $$<HTMLElement>('.glow-plane');
    let ticking = false;
    on(
      window,
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        frame(() => {
          const y = window.scrollY;
          const t = Math.max(0, Math.min(1, y / 700));
          if (!instant) {
            if (heroPath) setLeash(128 - t * 22); // 128 slack -> 106 tauter, still visibly saggy
            planes.forEach((p, i) => {
              p.style.translate = `0 ${(y * (0.04 + i * 0.03)).toFixed(0)}px`;
            });
          }
          ticking = false;
        });
      },
      { passive: true },
    );

    /* ---- 4 · IO reveals (marketing.html:685-688) ---- */
    const revealUp = $$<HTMLElement>('.reveal-up');
    const deviceReveal = $$<HTMLElement>('.device-reveal');
    if (instant || !('IntersectionObserver' in window)) {
      [...revealUp, ...deviceReveal].forEach((el) => el.classList.add('in'));
    } else {
      const rio = observe(
        new IntersectionObserver(
          (es) =>
            es.forEach((e) => {
              if (!e.isIntersecting) return;
              e.target.classList.add('in');
              rio.unobserve(e.target);
            }),
          { threshold: 0.14, rootMargin: '0px 0px -8% 0px' },
        ),
      );
      revealUp.forEach((el, i) => {
        el.style.animationDelay = `${(i % 3) * 90}ms`;
        rio.observe(el);
      });
      deviceReveal.forEach((el) => rio.observe(el));
    }

    /* ---- 5 · count-up (marketing.html:690-699) ---- */
    // marketing.html:690-699, extended to be decimal- and suffix-aware so a fractional
    // guarantee (0.01 0G) animates cleanly. `data-suf` carries a trailing unit the
    // artifact's `data-pre` (prefix only) couldn't express; integers keep the artifact's
    // exact `toLocaleString()` behaviour (e.g. 1,284).
    const countUp = (el: HTMLElement) => {
      const raw = el.dataset.count ?? '0';
      const target = Number(raw);
      const pre = el.dataset.pre ?? '';
      const suf = el.dataset.suf ?? '';
      if (!Number.isFinite(target)) return;
      const decimals = raw.includes('.') ? (raw.split('.')[1]?.length ?? 0) : 0;
      const render = (n: number) => pre + (decimals > 0 ? n.toFixed(decimals) : Math.round(n).toLocaleString()) + suf;
      if (instant) {
        el.textContent = render(target);
        return;
      }
      const dur = 1200;
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = render(target * e);
        if (p < 1) frame(tick);
      };
      frame(tick);
    };
    const stats = $$<HTMLElement>('.stat[data-count]');
    if (instant || !('IntersectionObserver' in window)) {
      stats.forEach(countUp);
    } else {
      const nio = observe(
        new IntersectionObserver(
          (es) =>
            es.forEach((e) => {
              if (!e.isIntersecting) return;
              countUp(e.target as HTMLElement);
              nio.unobserve(e.target);
            }),
          { threshold: 0.6 },
        ),
      );
      stats.forEach((el) => nio.observe(el));
    }

    /* ---- 7 · live rail stream (marketing.html:701-742). The five seed rows are server-
       rendered in page.tsx; this only prepends and trims. ---- */
    const railRows = $<HTMLElement>('#railRows');
    const settledEl = $<HTMLElement>('#settled');
    const proof = $<HTMLElement>('#proof');
    if (railRows && !instant) {
      if (proof && 'IntersectionObserver' in window) {
        const rowIo = observe(
          new IntersectionObserver(
            (es) =>
              es.forEach((e) => {
                if (!e.isIntersecting) return;
                Array.from(railRows.children).forEach((r, i) =>
                  timer(() => r.classList.add(SEED_VERDICTS[i] === 'deny' ? 'flash-deny' : 'flash-allow'), i * 120),
                );
                rowIo.disconnect();
              }),
            { threshold: 0.3 },
          ),
        );
        rowIo.observe(proof);
      }

      let settled = 1284;
      // STATED DEVIATION (forced, mirrors app/marketing.css): the artifact renders the tx
      // cell as `<a href="#">`. This landing is unauthenticated and the backend is
      // owner-scoped (lib/api.ts takes a TokenGetter), so there is no public feed to
      // resolve those hashes against — a dead anchor announcing itself as a receipt is
      // both a false claim and a control that goes nowhere. The cell ships as a span.
      const railRow = (d: (typeof RAIL_POOL)[number]) => {
        const row = document.createElement('div');
        row.className = 'vrow';
        const cell = (cls: string, text: string) => {
          const s = document.createElement('span');
          s.className = cls;
          s.textContent = text;
          return s;
        };
        const allow = d[0] === 'allow';
        const who = document.createElement('span');
        who.className = 'who';
        const small = document.createElement('small');
        small.textContent = d[2];
        who.append(`${d[1]} → `, small);
        row.append(
          cell(`chip ${allow ? 'chip-allow' : 'chip-deny'}`, allow ? 'Allow' : 'Deny'),
          who,
          cell('reason faint', d[3]),
          cell('amt', d[4]),
          cell('tx', d[5]),
        );
        return row;
      };

      let poolIdx = 0;
      interval(() => {
        // the artifact picks at random; a deterministic walk reads the same and keeps the
        // stream from repeating a row twice in a row.
        const d = RAIL_POOL[poolIdx++ % RAIL_POOL.length]!;
        const row = railRow(d);
        railRows.insertBefore(row, railRows.firstChild);
        row.classList.add(d[0] === 'allow' ? 'flash-allow' : 'flash-deny');
        while (railRows.children.length > 6) railRows.removeChild(railRows.lastChild!);
        if (d[0] === 'allow' && settledEl) {
          settled += Math.round(d[6]);
          settledEl.textContent = `$${settled.toLocaleString()}`;
        }
      }, 3600);
    }

    /* ---- 8 · device mini-console (marketing.html:744-780) ---- */
    const mcPath = $<SVGPathElement>('#mcPath');
    const mcMeter = $<SVGElement>('#mcMeter');
    const mcSlack = $<HTMLElement>('#mcSlack');
    const mcSpent = $<HTMLElement>('#mcSpent');
    const mcStream = $<HTMLElement>('#mcStream');
    const mcThink = $<HTMLElement>('#mcThink');
    const mcThinkT = $<HTMLElement>('#mcThinkT');
    if (!instant && mcPath && mcStream && mcThink && mcThinkT) {
      const cap = 500;
      let spent = 188;
      let i = 0;
      const tick = () => {
        const d = DEVICE_FEED[i++ % DEVICE_FEED.length]!;
        // 1) reason out loud. The artifact's <b> emphasis is dropped: the string is data,
        //    and textContent is the one form that cannot become an injection site.
        mcThinkT.textContent = d.r;
        mcThink.classList.remove('think-pulse');
        void mcThink.offsetWidth; // reflow, so the animation restarts
        mcThink.classList.add('think-pulse');
        // 2) ~820ms later the verdict lands in the stream
        timer(() => {
          const row = document.createElement('div');
          row.className = `mc-row ${d.v === 'allow' ? 'flash-allow' : 'flash-deny'}`;
          const cell = (cls: string, text: string) => {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            return s;
          };
          row.append(
            cell(`chip ${d.v === 'allow' ? 'chip-allow' : 'chip-deny'}`, d.v === 'allow' ? 'Allow' : 'Deny'),
            cell('py', d.py),
            cell('am', d.am),
          );
          mcStream.insertBefore(row, mcStream.firstChild);
          while (mcStream.children.length > 3) mcStream.removeChild(mcStream.lastChild!);
          if (d.v === 'allow') spent = Math.min(cap - 8, spent + d.n);
          const slack = Math.max(0, (cap - spent) / cap);
          mcPath.setAttribute('d', `M12 20 Q 156 ${(20 + slack * 10).toFixed(1)} 294 20`);
          if (mcSlack) mcSlack.textContent = `${Math.round(slack * 100)}%`;
          if (mcSpent) mcSpent.textContent = `$${Math.round(spent)}`;
          mcMeter?.classList.toggle('taut', slack < 0.18);
        }, 820);
      };
      tick();
      interval(tick, 2800);
    }

    /* ---- 9 · device tilt (marketing.html:782-792) ---- */
    const device = $<HTMLElement>('#device');
    const deviceWrap = device?.parentElement;
    if (!instant && device && deviceWrap) {
      on(deviceWrap, 'pointermove', ((e: PointerEvent) => {
        const b = deviceWrap.getBoundingClientRect();
        const rx = ((e.clientY - b.top) / b.height - 0.5) * -6;
        const ry = ((e.clientX - b.left) / b.width - 0.5) * 8;
        device.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      }) as EventListener);
      on(deviceWrap, 'pointerleave', () => {
        device.style.transform = 'rotateX(0) rotateY(0)';
      });
    }

    /* ---- 10 · magnetic buttons (marketing.html:794-800) ---- */
    if (!instant) {
      $$<HTMLElement>('.magnetic').forEach((btn) => {
        on(btn, 'pointermove', ((e: PointerEvent) => {
          const b = btn.getBoundingClientRect();
          const mx = (e.clientX - b.left - b.width / 2) * 0.25;
          const my = (e.clientY - b.top - b.height / 2) * 0.35;
          btn.style.transform = `translate(${mx.toFixed(1)}px,${my.toFixed(1)}px)`;
        }) as EventListener);
        on(btn, 'pointerleave', () => {
          btn.style.transform = 'translate(0,0)';
        });
      });
    }

    /* ---- 11 · bento mini-leash reacts on hover (marketing.html:802-818) ---- */
    $$<HTMLElement>('.leash-hover').forEach((box) => {
      const svg = box.querySelector<SVGElement>('.leash-svg');
      const hp = box.querySelector<SVGPathElement>('.hp');
      const kind = box.dataset.leash;
      const card = box.closest<HTMLElement>('.hcard');
      const orig = hp?.getAttribute('d') ?? null;
      if (!card || !svg) return;
      on(card, 'pointerenter', () => {
        if (instant) return;
        if (kind === 'slack' && hp && orig) {
          svg.classList.add('taut');
          hp.setAttribute('d', orig.replace(/Q\s*248\s*38/, 'Q 248 27'));
        } else if (kind === 'taut' && hp && orig) {
          hp.setAttribute('d', orig.replace(/Q\s*114\s*28/, 'Q 114 24'));
        } else if (kind === 'cut') {
          svg.style.filter = 'drop-shadow(0 0 6px var(--deny))';
        }
      });
      on(card, 'pointerleave', () => {
        if (kind === 'slack' && hp && orig) {
          svg.classList.remove('taut');
          hp.setAttribute('d', orig);
        } else if (kind === 'taut' && hp && orig) {
          hp.setAttribute('d', orig);
        } else if (kind === 'cut') {
          svg.style.filter = '';
        }
      });
    });

    /* ---- 12 · closing beat: sever on scroll (marketing.html:822-824) ---- */
    const closer = $<HTMLElement>('#closer');
    if (closer && 'IntersectionObserver' in window) {
      const cio = observe(
        new IntersectionObserver(
          (es) =>
            es.forEach((e) => {
              if (!e.isIntersecting) return;
              timer(() => e.target.classList.add('cut'), 350);
              cio.unobserve(e.target);
            }),
          { threshold: 0.5 },
        ),
      );
      cio.observe(closer);
    }

    return () => {
      offs.forEach((off) => off());
    };
  }, []);

  return (
    <div ref={rootRef} className="leash-landing">
      {children}
    </div>
  );
}
