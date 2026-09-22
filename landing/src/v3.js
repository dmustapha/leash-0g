// v3 "Terminal" — auto-typing session replay, skippable, loops once. SPEC: v3/SPEC.md
// Motion law: type-on 24ms/char accelerating + cursor blink 1s steps(1). Nothing else.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = navigator.connection?.saveData === true
const instant = reduced || saveData

const LINES = [
  ['', '$ leash watch treasury-bot'],
  ['t-dim', 'thinking… "beneficiary low, send 0.05"'],
  ['t-refuse', 'contract › OverPerTransferCap(0.05 > 0.002) REFUSED'],
  ['t-caution', 'owner › revoke()'],
  ['t-ok', '✔ session terminated'],
  ['', 'spent this window: 0.004/0.006 0G'],
]
const REVOKE_INDEX = 3
const MARK_HELD = '(o)━━━~━━━[ ]═[ ]'
const MARK_SNAPPED = '(o)━━╸ ╺━━[ ]═[ ]' // stroke-gap snap, ASCII-weight (SPEC)

const body = document.getElementById('term-body')
const mark = document.getElementById('ascii-mark')
const skipBtn = document.getElementById('term-skip')

const totalChars = LINES.reduce((n, [, t]) => n + t.length, 0)
let run = 0 // token to cancel an in-flight replay
let playedLoops = 0

function renderFull() {
  body.replaceChildren()
  for (const [tone, text] of LINES) {
    const span = document.createElement('span')
    if (tone) span.className = tone
    span.textContent = text + '\n'
    body.appendChild(span)
  }
  mark.textContent = MARK_SNAPPED
  appendCaret()
}

function appendCaret() {
  const caret = document.createElement('span')
  caret.className = 'term-caret'
  caret.setAttribute('aria-hidden', 'true')
  body.appendChild(caret)
}

// delay accelerates: 24ms/char at start easing to 8ms/char at the end (SPEC: accelerating)
const delayAt = (typed) => 24 - 16 * (typed / totalChars)

function play(loopsLeft) {
  if (instant) return renderFull()
  const token = ++run
  body.replaceChildren()
  mark.textContent = MARK_HELD
  appendCaret()
  let li = 0
  let typed = 0

  function typeLineFrom(ci) {
    if (token !== run) return
    if (li >= LINES.length) {
      playedLoops += 1
      if (loopsLeft > 0) setTimeout(() => token === run && play(loopsLeft - 1), 1600)
      return
    }
    const [tone, text] = LINES[li]
    let span = body.querySelector(`[data-line="${li}"]`)
    if (!span) {
      span = document.createElement('span')
      if (tone) span.className = tone
      span.dataset.line = li
      body.insertBefore(span, body.lastChild) // keep caret last
    }
    if (ci <= text.length) {
      span.textContent = text.slice(0, ci)
      typed += 1
      setTimeout(() => typeLineFrom(ci + 1), delayAt(typed))
    } else {
      span.textContent = text + '\n'
      if (li === REVOKE_INDEX) mark.textContent = MARK_SNAPPED // snap on revoke line (SPEC)
      li += 1
      typeLineFrom(0)
    }
  }
  typeLineFrom(0)
}

function skip() {
  run += 1
  renderFull()
}

skipBtn.addEventListener('click', skip)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') skip()
})
document.getElementById('term-replay').addEventListener('click', () => play(0))
document.getElementById('cta-watch').addEventListener('click', () => {
  document.getElementById('demo').scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' })
  play(0)
})

// autoplay: one pass plus one loop (SPEC: loops once)
play(1)
