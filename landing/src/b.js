// Proposal B — the scroll-progressed leash line + section reveals.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- section reveals -------------------------------------------------------
const reveals = document.querySelectorAll('.reveal')
if (reduced || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('is-in'))
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in')
          io.unobserve(e.target)
        }
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  )
  reveals.forEach((el) => io.observe(el))
}

// ---- the leash -------------------------------------------------------------
const wrap = document.querySelector('.leashed')
const rail = document.querySelector('.rail')
const svg = document.getElementById('leash-svg')
const main = document.getElementById('leash-main')
const chain = document.getElementById('leash-chain')
const clipMark = document.getElementById('leash-clip-mark')

const SVG_NS = 'http://www.w3.org/2000/svg'
const clipPathEl = document.createElementNS(SVG_NS, 'clipPath')
clipPathEl.id = 'chain-clip'
const clipRect = document.createElementNS(SVG_NS, 'rect')
clipPathEl.appendChild(clipRect)
svg.prepend(clipPathEl)
chain.setAttribute('clip-path', 'url(#chain-clip)')

let snapY = 0
let mainLen = 0
let railH = 0
let maxTip = 0 // once drawn, the leash stays drawn

const topOf = (id) => document.getElementById(id).offsetTop
const midOf = (id) => {
  const el = document.getElementById(id)
  return el.offsetTop + el.offsetHeight / 2
}

function buildPath() {
  railH = wrap.offsetHeight
  const w = rail.offsetWidth
  const cx = w / 2
  const amp = Math.min(w * 0.34, 44)
  svg.setAttribute('viewBox', `0 0 ${w} ${railH}`)

  // slack: weave through problem / bind / watch
  const waypoints = [midOf('sec-problem'), midOf('sec-bind'), midOf('sec-watch')]
  let d = `M ${cx} 0`
  let prevY = 0
  let side = 1
  for (const y of waypoints) {
    const half = (y - prevY) / 2
    d += ` C ${cx + amp * side} ${prevY + half * 0.6}, ${cx + amp * side} ${y - half * 0.6}, ${cx} ${y}`
    prevY = y
    side *= -1
  }
  // pulled taut: straight through contain to the snap point at revoke
  snapY = midOf('sec-revoke') - 30
  d += ` L ${cx} ${topOf('sec-contain')} L ${cx} ${snapY}`
  main.setAttribute('d', d)

  // the clip (carabiner snapped open) at revoke
  clipMark.setAttribute('transform', `translate(${cx}, ${snapY + 16})`)

  // hash-chain dotted line continues through proof to the end
  chain.setAttribute('d', `M ${cx} ${snapY + 34} L ${cx} ${railH}`)

  mainLen = main.getTotalLength()
  main.style.strokeDasharray = String(mainLen)
  clipRect.setAttribute('x', '0')
  clipRect.setAttribute('y', String(snapY))
  clipRect.setAttribute('width', String(w))
  progress()
}

function progress() {
  if (reduced) {
    main.style.strokeDashoffset = '0'
    clipMark.setAttribute('opacity', '1')
    clipRect.setAttribute('height', String(railH - snapY))
    return
  }
  const railTop = wrap.getBoundingClientRect().top + window.scrollY
  maxTip = Math.max(maxTip, window.scrollY + window.innerHeight * 0.78 - railTop)
  const tip = maxTip
  const p = Math.min(1, Math.max(0, tip / snapY))
  main.style.strokeDashoffset = String(mainLen * (1 - p))
  clipMark.setAttribute('opacity', p >= 1 ? '1' : '0')
  const chainP = Math.min(1, Math.max(0, (tip - snapY) / (railH - snapY)))
  clipRect.setAttribute('height', String((railH - snapY) * chainP))
}

let raf = 0
function onScroll() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(progress)
}

let resizeT = 0
function onResize() {
  clearTimeout(resizeT)
  resizeT = setTimeout(buildPath, 120)
}

buildPath()
if (!reduced) {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onResize)
}
if (document.fonts?.ready) document.fonts.ready.then(buildPath)
window.addEventListener('load', buildPath)
