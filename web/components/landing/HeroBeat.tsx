// File: web/components/landing/HeroBeat.tsx
// Client port of the static landing's final.js — the living Loop-Link beat.
// draw once -> alive (sway) -> taut (refused, coral) -> snap (revoked, jade) -> re-arm.
// Reduced-motion / saveData: static forged object; the button still cycles the states,
// it just does so without motion (this mirrors the reference's `if(reduceMo){ apply(0) }`).
// Scroll-reveal (IntersectionObserver) + count-up wired here. State classes toggle
// on the `.leash-landing` root <div>; styles are plain, scoped under that root class
// in app/landing.css (no CSS-module hashing, no collision with the console globals).
//
// STAGE G-1.3 — reconciled against the owner-locked build (web/design-reference/
// marketing.html:565-647). Six beats adopted: motes (M-1), spark (M-2), verdict pop (M-3),
// beat chrome (M-4), auto-attract (M-5), pointer parallax (M-6). The state table below is
// the reference's own declarative `states` array — class, label, verdict and verdict-class
// in one row — which replaced an imperative if/else chain that could drift per branch.
'use client';

import { useEffect, useRef, useState } from 'react';

/** The reference's state table (marketing.html:575-579). `label` is what the NEXT click does. */
const STATES = [
  { cls: 'is-alive', label: 'Try to overspend', verdict: '', vcls: '' },
  { cls: 'is-taut', label: 'Revoke the leash', verdict: 'Refused · cap held', vcls: 'refused' },
  { cls: 'is-snapped', label: 'Forge it again', verdict: 'Revoked · funds safe', vcls: 'revoked' },
] as const;

export function LandingRoot({ children }: { children: React.ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [stateClass, setStateClass] = useState<string>('');
  const phaseRef = useRef(0); // 0 alive, 1 taut, 2 snapped

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const saveData = conn?.saveData === true;
    const instant = reduced || saveData;

    const btnBeat = root.querySelector<HTMLButtonElement>('#btn-beat');
    const llState = root.querySelector<HTMLElement>('#ll-state');
    const llVerdict = root.querySelector<HTMLElement>('#ll-verdict');
    const ctaWatch = root.querySelector<HTMLAnchorElement>('#cta-watch');
    const demo = root.querySelector<HTMLElement>('#demo');
    const hero = root.querySelector<HTMLElement>('.hero');
    const svg = root.querySelector<SVGElement>('.looplink');
    const motes = root.querySelector<HTMLElement>('#motes');

    let drawTimer: number | undefined;
    let attract: number | undefined;
    // was an untracked setTimeout in onWatch — it outlived unmount. Tracked now.
    let beatTimer: number | undefined;
    let raf: number | undefined;
    let verdictRaf: number | undefined;
    let engaged = false;

    // The reference never renders motes under reduced motion (`if(reduceMo) return`). Here they
    // are server-rendered, so the CSS `reduce` block covers that case — but NOT saveData, which
    // is motion-agnostic. `hidden` closes that gap without inventing a new data attribute.
    if (motes && instant) motes.hidden = true;

    // ---- M-3 · verdict pop. Set content first, then flip `.show` on the next frame so the
    // opacity/transform transition actually has two states to run between.
    const showVerdict = (text: string, cls: string) => {
      if (!llVerdict) return;
      llVerdict.className = `ll-verdict mono${cls ? ` ${cls}` : ''}`;
      llVerdict.textContent = text;
      if (verdictRaf) cancelAnimationFrame(verdictRaf);
      verdictRaf = requestAnimationFrame(() => llVerdict.classList.toggle('show', !!text));
    };

    const apply = (p: number) => {
      const s = STATES[p]!;
      setStateClass(s.cls);
      if (llState) llState.textContent = s.label;
      showVerdict(s.verdict, s.vcls);
      phaseRef.current = p;
    };

    // ---- Loop-Link draw -> alive -> M-5 auto-attract ----
    if (instant) {
      apply(0);
    } else {
      setStateClass('will-draw');
      raf = requestAnimationFrame(() => {
        setStateClass('will-draw is-drawing');
        // 1650ms: the draw keyframes finish at 1.0 x --dur-draw (1600ms), so this hands over
        // just after the last link closes. Reference uses the same number (marketing.html:597).
        drawTimer = window.setTimeout(() => {
          apply(0);
          // M-5 · play the refusal story ONCE, unprompted, so a visitor sees the object is
          // alive. The locked build demonstrates; the un-reconciled live build only awaited a
          // click. Every step re-checks `engaged` so a click mid-chain wins immediately.
          attract = window.setTimeout(() => {
            if (engaged) return;
            apply(1);
            attract = window.setTimeout(() => {
              if (engaged) return;
              apply(2);
              attract = window.setTimeout(() => {
                if (engaged) return;
                apply(0);
              }, 2600);
            }, 2100);
          }, 2400);
        }, 1650);
      });
    }

    // ---- count-up on numbers carrying data-count ----
    const countRafs: number[] = [];
    if (!instant) {
      root.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
        const rawTarget = el.dataset.count ?? '0';
        const target = parseFloat(rawTarget);
        if (!Number.isFinite(target)) return;
        const decimals = rawTarget.includes('.') ? (rawTarget.split('.')[1]?.length ?? 0) : 0;
        const start = performance.now();
        const dur = 900;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          el.textContent = (target * eased).toFixed(decimals);
          if (t < 1) countRafs.push(requestAnimationFrame(tick));
          else el.textContent = target.toFixed(decimals);
        };
        countRafs.push(requestAnimationFrame(tick));
      });
    }

    // ---- scroll reveal (IntersectionObserver adds the in-view state) ----
    let io: IntersectionObserver | null = null;
    const revealTargets = root.querySelectorAll<HTMLElement>('[data-reveal]');
    if (instant) {
      revealTargets.forEach((el) => (el.dataset.inview = 'true'));
    } else if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              (e.target as HTMLElement).dataset.inview = 'true';
              io?.unobserve(e.target);
            }
          });
        },
        { threshold: 0.15 },
      );
      revealTargets.forEach((el) => io!.observe(el));
    } else {
      revealTargets.forEach((el) => (el.dataset.inview = 'true'));
    }

    // ---- the beat. Any deliberate interaction is engagement: it kills auto-attract for good,
    // so the sequence never fights the visitor for control of the object.
    const beat = () => {
      engaged = true;
      if (attract) clearTimeout(attract);
      apply((phaseRef.current + 1) % STATES.length);
    };

    const onWatch = (e: Event) => {
      e.preventDefault();
      engaged = true;
      if (attract) clearTimeout(attract);
      demo?.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
      if (phaseRef.current === 0) beatTimer = window.setTimeout(beat, instant ? 0 : 500);
      btnBeat?.focus({ preventScroll: true });
    };

    btnBeat?.addEventListener('click', beat);
    ctaWatch?.addEventListener('click', onWatch);

    // ---- M-6 · pointer parallax: the forged object leans toward the cursor. The locals carry
    // CSS `0deg` fallbacks, so under reduced motion — where this listener is never attached —
    // the object simply renders flat.
    const onPointerMove = (e: PointerEvent) => {
      if (!hero || !svg) return;
      const r = hero.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      svg.style.setProperty('--ry', `${(nx * 12).toFixed(2)}deg`);
      svg.style.setProperty('--rx', `${(-ny * 9).toFixed(2)}deg`);
    };
    const onPointerLeave = () => {
      svg?.style.setProperty('--ry', '0deg');
      svg?.style.setProperty('--rx', '0deg');
    };
    if (hero && svg && !instant) {
      hero.addEventListener('pointermove', onPointerMove);
      hero.addEventListener('pointerleave', onPointerLeave);
    }

    return () => {
      btnBeat?.removeEventListener('click', beat);
      ctaWatch?.removeEventListener('click', onWatch);
      hero?.removeEventListener('pointermove', onPointerMove);
      hero?.removeEventListener('pointerleave', onPointerLeave);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (verdictRaf) cancelAnimationFrame(verdictRaf);
      countRafs.forEach(cancelAnimationFrame);
      if (drawTimer) clearTimeout(drawTimer);
      if (attract) clearTimeout(attract);
      if (beatTimer) clearTimeout(beatTimer);
    };
  }, []);

  return (
    <div ref={rootRef} className={`leash-landing ${stateClass}`.trim()}>
      {children}
    </div>
  );
}
