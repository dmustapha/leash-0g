// v2 "Statement" — self-printing statement + one underline draw. SPEC: v2/SPEC.md
// Motion law: ONLY the statement print (typewriter, 90ms line stagger) and the
// "Prove" underline draw. Reduced-motion shows the full statement.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const saveData = navigator.connection?.saveData === true
const instant = reduced || saveData

const lines = [...document.querySelectorAll('#statement-lines li')]
let printing = false

function showAll() {
  lines.forEach((li) => (li.textContent = li.dataset.line))
}

function typeLine(li, done) {
  const text = li.dataset.line
  let i = 0
  const tick = () => {
    i += 1
    li.textContent = text.slice(0, i)
    if (i < text.length) setTimeout(tick, 14)
    else done()
  }
  tick()
}

function printStatement() {
  if (printing) return
  if (instant) return showAll()
  printing = true
  lines.forEach((li) => (li.textContent = ''))
  let idx = 0
  const next = () => {
    if (idx >= lines.length) return void (printing = false)
    const li = lines[idx]
    idx += 1
    // 90ms stagger between line starts finishing and next beginning (SPEC stagger)
    typeLine(li, () => setTimeout(next, 90))
  }
  next()
}

// first print on load
printStatement()

document.getElementById('print-again').addEventListener('click', printStatement)

// Primary CTAs: scroll to the statement and print it again (zero gate)
for (const id of ['cta-watch', 'cta-watch-2']) {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('demo').scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' })
    printStatement()
  })
}

// The ONE scroll motion: underline draws when "Prove" enters
const underline = document.getElementById('prove-underline')
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      underline.classList.add('is-drawn')
      io.disconnect()
    }
  }
}, { threshold: 0.6 })
io.observe(underline)
