// LEASH final landing — the living Loop-Link beat (DESIGN_SPEC.md §Hero).
// draw once → alive (sway) → taut (refused, coral) → snap (revoked, jade) → re-arm.
// Reduced-motion / saveData: static forged object, both outcome cards visible.
// Buttons are real <button>/<a>: click AND keyboard reachable; outcomes are aria-live.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = navigator.connection?.saveData === true
const instant = reduced || saveData

const body = document.body
const btnBeat = document.getElementById('btn-beat')
const refused = document.getElementById('outcome-refused')
const revoked = document.getElementById('outcome-revoked')

let phase = 0 // 0 = alive, 1 = held taut (refused shown), 2 = snapped (revoked shown)

if (instant) {
  // static per spec: forged object, both outcome cards visible
  refused.dataset.shown = 'true'
  revoked.dataset.shown = 'true'
} else {
  // draw the loop once (--dur-draw), then it lives
  body.classList.add('will-draw')
  requestAnimationFrame(() => {
    body.classList.add('is-drawing')
    setTimeout(() => {
      body.classList.remove('will-draw', 'is-drawing')
      body.classList.add('is-alive')
    }, 1700)
  })
}

function beat() {
  if (phase === 0) {
    // tap 1: the tether pulls TAUT, spring settle, the refusal card speaks (deny edge)
    body.classList.remove('is-alive')
    body.classList.add('is-taut')
    refused.dataset.shown = 'true'
    btnBeat.textContent = 'Revoke'
    phase = 1
  } else if (phase === 1) {
    // tap 2: clean snap. The links stay: the record remains (jade edge).
    body.classList.remove('is-taut')
    body.classList.add('is-snapped')
    revoked.dataset.shown = 'true'
    btnBeat.textContent = 'Forge it again'
    phase = 2
  } else {
    // re-arm
    body.classList.remove('is-snapped')
    if (!instant) {
      refused.dataset.shown = 'false'
      revoked.dataset.shown = 'false'
      body.classList.add('is-alive')
    }
    btnBeat.textContent = 'Try to overspend'
    phase = 0
  }
}

btnBeat.addEventListener('click', beat)

// primary CTA (#demo anchor works without JS); enhanced: run the overspend beat, zero gate
document.getElementById('cta-watch').addEventListener('click', (e) => {
  e.preventDefault()
  document.getElementById('demo').scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' })
  if (phase === 0) setTimeout(beat, instant ? 0 : 500)
  btnBeat.focus({ preventScroll: true })
})
