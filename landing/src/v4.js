// v4 "Companion" — the living Loop-Link: draw, sway, taut, snap. SPEC: v4/SPEC.md
// Motion law: spring settle cubic-bezier(.2,.9,.3,1.2) 700ms on the taut beat ·
// loop draw 1600ms once · reduced-motion: static forged object + both outcome cards visible.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = navigator.connection?.saveData === true
const instant = reduced || saveData

const body = document.body
const btnBeat = document.getElementById('btn-beat')
const refused = document.getElementById('outcome-refused')
const revoked = document.getElementById('outcome-revoked')

let phase = 0 // 0 = alive, 1 = held taut (refused shown), 2 = snapped (revoked shown)

if (instant) {
  // static forged object + both outcome cards visible (SPEC reduced-motion)
  refused.dataset.shown = 'true'
  revoked.dataset.shown = 'true'
  btnBeat.disabled = false
} else {
  // draw the loop once (1600ms), then it lives
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
    // one tap: the tether pulls TAUT, spring settle, refusal card speaks
    body.classList.remove('is-alive')
    body.classList.add('is-taut')
    refused.dataset.shown = 'true'
    btnBeat.textContent = 'Now revoke'
    phase = 1
  } else if (phase === 1) {
    // second tap: clean snap. The link stays: the proof remains.
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

// primary CTA: scroll to the object and run the overspend beat, zero gate
document.getElementById('cta-watch').addEventListener('click', () => {
  document.getElementById('demo').scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' })
  if (phase === 0) setTimeout(beat, instant ? 0 : 500)
  btnBeat.focus({ preventScroll: true })
})
