#!/usr/bin/env node
// Round 2: capture v1..v4 at 1440px and 390px from the built static export.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'proposals-screenshots', 'round2')
mkdirSync(OUT, { recursive: true })

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const server = createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(req.url.split('?')[0]))
  if (p.endsWith('/')) p = join(p, 'index.html')
  if (!existsSync(p)) p = join(DIST, 'index.html')
  res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream')
  res.end(readFileSync(p))
})
await new Promise((ok) => server.listen(4517, ok))

const browser = await chromium.launch()
// v2 statement print ≈ (sum chars × 14ms) + staggers ≈ 3.5s; v3 replay plays twice ≈ 2×(~2.6s)+1.6s gap
const SETTLE = { v1: 1200, v2: 5000, v3: 9000, v4: 2200 }
const pages = ['v1', 'v2', 'v3', 'v4']

for (const page of pages) {
  for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })
    const tab = await ctx.newPage()
    await tab.goto(`http://localhost:4517/${page}/`, { waitUntil: 'networkidle' })
    // wait past print/type animations so shots show content, not blank frames
    await tab.waitForTimeout(SETTLE[page])
    // pre-scroll so IntersectionObserver-armed elements (count-ups, underline) are drawn;
    // dwell on each step long enough for IO to deliver an intersecting entry
    await tab.evaluate(async () => {
      for (let y = 0; y <= document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 120))
      }
      window.scrollTo(0, 0)
    })
    await tab.waitForTimeout(page === 'v1' ? 1800 : 600)
    await tab.screenshot({ path: join(OUT, `${page}-${label}.png`), fullPage: true })
    await ctx.close()
    console.log(`captured round2/${page}-${label}.png`)
  }
}

await browser.close()
server.close()
console.log('done')
