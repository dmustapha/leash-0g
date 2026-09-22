// Headless verification of the FINAL landing (task spec):
// 1. scrollWidth === 390 at mobile (no horizontal overflow)
// 2. hero beat works via click AND keyboard
// 3. #demo in viewport at 1440 and 390
// 4. screenshots after animations settle → final-screenshots/
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, server: { port: 4179 } })
await server.listen()
const url = 'http://localhost:4179/'

const browser = await chromium.launch()
const failures = []
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures.push(label)
}

// ---------- 1440 desktop ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2200) // loop draw settles (1600ms + margin)

  const demoIn = await page.evaluate(() => {
    const r = document.getElementById('demo').getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight
  })
  ok(demoIn, '#demo in viewport at 1440')

  // beat via CLICK
  await page.click('#btn-beat')
  await page.waitForTimeout(800)
  ok(await page.getAttribute('#outcome-refused', 'data-shown') === 'true', 'click tap 1 → refused card shown')
  ok(await page.evaluate(() => document.body.classList.contains('is-taut')), 'click tap 1 → tether taut')
  await page.click('#btn-beat')
  await page.waitForTimeout(800)
  ok(await page.getAttribute('#outcome-revoked', 'data-shown') === 'true', 'click tap 2 → revoked card shown')
  ok(await page.evaluate(() => document.body.classList.contains('is-snapped')), 'click tap 2 → snapped')
  await page.click('#btn-beat') // re-arm
  await page.waitForTimeout(400)

  // beat via KEYBOARD (focus + Enter)
  await page.focus('#btn-beat')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  ok(await page.getAttribute('#outcome-refused', 'data-shown') === 'true', 'keyboard Enter → refused card shown')
  await page.keyboard.press('Space')
  await page.waitForTimeout(800)
  ok(await page.getAttribute('#outcome-revoked', 'data-shown') === 'true', 'keyboard Space → revoked card shown')
  await page.keyboard.press('Enter') // re-arm for the settled screenshot
  await page.waitForTimeout(2000)

  await page.screenshot({ path: join(root, 'final-screenshots/final-desktop.png'), fullPage: true })
  await page.close()
}

// ---------- 390 mobile ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2200)

  const sw = await page.evaluate(() => document.documentElement.scrollWidth)
  ok(sw === 390, `scrollWidth 390 at mobile (got ${sw})`)

  const demoIn = await page.evaluate(() => {
    const r = document.getElementById('demo').getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight
  })
  ok(demoIn, '#demo in viewport at 390')

  await page.click('#btn-beat')
  await page.waitForTimeout(800)
  ok(await page.getAttribute('#outcome-refused', 'data-shown') === 'true', 'mobile click → refused card shown')
  await page.click('#btn-beat')
  await page.click('#btn-beat') // re-arm
  await page.waitForTimeout(2000)

  await page.screenshot({ path: join(root, 'final-screenshots/final-mobile.png'), fullPage: true })
  await page.close()
}

await browser.close()
await server.close()

if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall final checks PASS')
