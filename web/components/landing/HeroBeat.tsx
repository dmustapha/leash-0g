// File: web/components/landing/HeroBeat.tsx
// Client port of the static landing's final.js — the living Loop-Link beat.
// draw once -> alive (sway) -> taut (refused, coral) -> snap (revoked, jade) -> re-arm.
// Reduced-motion / saveData: static forged object, both outcome cards visible.
// Scroll-reveal (IntersectionObserver) + count-up wired here. State classes toggle
// on the `.leash-landing` root <div>; styles are plain, scoped under that root class
// in app/landing.css (no CSS-module hashing, no collision with the console globals).
'use client';

import { useEffect, useRef, useState } from 'react';

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

    const refused = root.querySelector<HTMLElement>('#outcome-refused');
    const revoked = root.querySelector<HTMLElement>('#outcome-revoked');
    const btnBeat = root.querySelector<HTMLButtonElement>('#btn-beat');
    const ctaWatch = root.querySelector<HTMLAnchorElement>('#cta-watch');
    const demo = root.querySelector<HTMLElement>('#demo');

    let drawTimer: number | undefined;
    let raf: number | undefined;

    // ---- Loop-Link draw -> alive ----
    if (instant) {
      if (refused) refused.dataset.shown = 'true';
      if (revoked) revoked.dataset.shown = 'true';
    } else {
      setStateClass('will-draw');
      raf = requestAnimationFrame(() => {
        setStateClass('will-draw is-drawing');
        drawTimer = window.setTimeout(() => setStateClass('is-alive'), 1700);
      });
    }

    // ---- count-up on numbers carrying data-count ----
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
          if (t < 1) requestAnimationFrame(tick);
          else el.textContent = target.toFixed(decimals);
        };
        requestAnimationFrame(tick);
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

    // ---- the beat ----
    const beat = () => {
      const phase = phaseRef.current;
      if (phase === 0) {
        setStateClass('is-taut');
        if (refused) refused.dataset.shown = 'true';
        if (btnBeat) btnBeat.textContent = 'Revoke';
        phaseRef.current = 1;
      } else if (phase === 1) {
        setStateClass('is-snapped');
        if (revoked) revoked.dataset.shown = 'true';
        if (btnBeat) btnBeat.textContent = 'Forge it again';
        phaseRef.current = 2;
      } else {
        if (!instant) {
          if (refused) refused.dataset.shown = 'false';
          if (revoked) revoked.dataset.shown = 'false';
          setStateClass('is-alive');
        } else {
          setStateClass('');
        }
        if (btnBeat) btnBeat.textContent = 'Try to overspend';
        phaseRef.current = 0;
      }
    };

    const onWatch = (e: Event) => {
      e.preventDefault();
      demo?.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
      if (phaseRef.current === 0) window.setTimeout(beat, instant ? 0 : 500);
      btnBeat?.focus({ preventScroll: true });
    };

    btnBeat?.addEventListener('click', beat);
    ctaWatch?.addEventListener('click', onWatch);

    return () => {
      btnBeat?.removeEventListener('click', beat);
      ctaWatch?.removeEventListener('click', onWatch);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (drawTimer) clearTimeout(drawTimer);
    };
  }, []);

  return (
    <div ref={rootRef} className={`leash-landing ${stateClass}`.trim()}>
      {children}
    </div>
  );
}
