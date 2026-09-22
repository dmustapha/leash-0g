// v1 "Instrument" — decision-card beats + count-up. SPEC: v1/SPEC.md
// Motion law: state morph cubic-bezier(.33,0,.2,1) 1000ms · count-up 1-(1-p)^3 1600ms ·
// reveal stagger 90ms. All gated behind prefers-reduced-motion + saveData.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = navigator.connection?.saveData === true
if (saveData) document.body.classList.add('save-data')
const instant = reduced || saveData

const card = document.getElementById('decision-card')
const state = document.getElementById('card-state')
const verdictText = document.getElementById('verdict-text')
const btnApprove = document.getElementById('btn-approve')
const btnDeny = document.getElementById('btn-deny')
const btnRevoke = document.getElementById('btn-revoke')
const btnReset = document.getElementById('card-reset')

function setState(cls, label, verdict) {
  card.classList.remove('is-approved', 'is-denied', 'is-taut', 'is-revoked')
  if (cls) card.classList.add(cls)
  state.textContent = label
  verdictText.textContent = verdict
}

btnApprove.addEventListener('click', () => {
  setState('is-approved', 'approved by owner', 'Sealed. 0.05 0G released under your signature.')
})

btnDeny.addEventListener('click', () => {
  setState('is-denied', 'denied by owner', 'Stand down. Nothing moved. The agent keeps thinking.')
})

btnRevoke.addEventListener('click', () => {
  // beat: pull taut, then snap (stroke-gap), then dim to closed
  const finish = () => {
    setState('is-revoked', 'account closed to agent', 'Revoked. The leash is snapped. The record remains.')
    btnApprove.disabled = btnDeny.disabled = btnRevoke.disabled = true
    btnReset.hidden = false
  }
  if (instant) return finish()
  setState('is-taut', 'revoking…', 'The leash pulls taut.')
  setTimeout(finish, 1000)
})

btnReset.addEventListener('click', () => {
  setState(null, 'awaiting decision', '')
  btnApprove.disabled = btnDeny.disabled = btnRevoke.disabled = false
  btnReset.hidden = true
  btnDeny.focus()
})

// Primary CTA: scroll to the instrument and fire the kill-shot (deny) beat
document.getElementById('cta-watch').addEventListener('click', () => {
  document.getElementById('demo').scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' })
  if (!card.classList.contains('is-revoked')) {
    setTimeout(() => btnDeny.click(), instant ? 0 : 450)
    btnDeny.focus({ preventScroll: true })
  }
})

// Count-up: 1-(1-p)^3 over 1600ms (SPEC), IntersectionObserver-armed
const ease = (p) => 1 - Math.pow(1 - p, 3)
function countUp(el) {
  const target = parseFloat(el.dataset.countup)
  const decimals = parseInt(el.dataset.decimals, 10)
  if (instant) return void (el.textContent = target.toFixed(decimals))
  const t0 = performance.now()
  function frame(t) {
    const p = Math.min((t - t0) / 1600, 1)
    el.textContent = (target * ease(p)).toFixed(decimals)
    if (p < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

const seen = new WeakSet()
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && !seen.has(e.target)) {
      seen.add(e.target)
      countUp(e.target)
      io.unobserve(e.target)
    }
  }
}, { threshold: 0.4 })
document.querySelectorAll('[data-countup]').forEach((el) => io.observe(el))
