// Proposal A — the working decision card. Local state only, one orchestrated moment.
const approve = document.getElementById('btn-approve')
const deny = document.getElementById('btn-deny')
const reset = document.getElementById('btn-reset')
const trace = document.querySelector('.trace')
const countdown = document.getElementById('dc-countdown')

let seconds = 600
let timer = setInterval(tick, 1000)

function tick() {
  seconds = Math.max(0, seconds - 1)
  const m = String(Math.floor(seconds / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  countdown.textContent = `${m}:${s}`
  if (seconds === 0) clearInterval(timer)
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function append(kind, text) {
  const line = document.createElement('p')
  line.className = `trace-line trace-${kind}`
  const time = document.createElement('span')
  time.className = 't-time'
  time.textContent = stamp()
  line.append(time, text)
  trace.appendChild(line)
}

function settle() {
  approve.disabled = true
  deny.disabled = true
  clearInterval(timer)
  reset.hidden = false
}

approve.addEventListener('click', () => {
  append('allow', 'approved by owner · sent 0.002 0G · tx sealed')
  settle()
})

deny.addEventListener('click', () => {
  append('deny', 'denied by owner · stood down, recorded')
  settle()
})

reset.addEventListener('click', () => {
  trace.querySelectorAll('.trace-allow, .trace-deny').forEach((el) => el.remove())
  approve.disabled = false
  deny.disabled = false
  reset.hidden = true
  seconds = 600
  countdown.textContent = '10:00'
  clearInterval(timer)
  timer = setInterval(tick, 1000)
  approve.focus()
})
