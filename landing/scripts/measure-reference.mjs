// Step 0b (LANDING-DIRECTIONS): pull REAL computed styles from a live
// best-in-class reference into vN/REFERENCE-MEASUREMENTS.json — measurements
// are the values' SOURCE; hand-invented values are banned.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const [, , url, outDir] = process.argv;
if (!url || !outDir) {
  console.error('usage: node scripts/measure-reference.mjs <url> <vN-dir>');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => page.waitForTimeout(5000));
await page.waitForTimeout(2500);

const data = await page.evaluate(() => {
  const pick = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      fontFamily: c.fontFamily,
      fontSize: c.fontSize,
      fontWeight: c.fontWeight,
      lineHeight: c.lineHeight,
      letterSpacing: c.letterSpacing,
      color: c.color,
      textTransform: c.textTransform,
    };
  };
  const vis = (sel) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null && e.textContent.trim().length > 2) ?? null;
  const body = document.body;
  const bc = getComputedStyle(body);
  const main = vis('main') ?? body;
  const section = vis('main section, section');
  const sc = section ? getComputedStyle(section) : null;
  const container = [...document.querySelectorAll('main div, main section, div')]
    .filter((e) => e.offsetParent !== null && e.clientWidth > 500 && e.clientWidth < 1400)
    .sort((a, b) => b.clientHeight - a.clientHeight)[0];
  const btn = vis('a[class*="btn" i], button, a[href*="signup" i], a[href*="download" i]');
  const bcS = btn ? getComputedStyle(btn) : null;
  return {
    page: { title: document.title, bg: bc.backgroundColor, bodyFont: pick(body) },
    h1: pick(vis('h1')),
    h2: pick(vis('h2')),
    paragraph: pick(vis('main p, p')),
    smallLabel: pick(vis('main span, main label, header a')),
    sectionPadding: sc ? { paddingTop: sc.paddingTop, paddingBottom: sc.paddingBottom } : null,
    containerWidth: container ? container.clientWidth : null,
    button: bcS && btn ? {
      bg: bcS.backgroundColor, color: bcS.color, radius: bcS.borderRadius,
      padding: bcS.padding, fontSize: bcS.fontSize, fontWeight: bcS.fontWeight, border: bcS.border,
    } : null,
    borders: (() => {
      const el = [...document.querySelectorAll('main *')].find((e) => {
        const s = getComputedStyle(e);
        return e.offsetParent !== null && s.borderTopWidth === '1px' && s.borderTopStyle === 'solid';
      });
      return el ? getComputedStyle(el).borderTopColor : null;
    })(),
  };
});

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/REFERENCE-MEASUREMENTS.json`, JSON.stringify({ reference: url, measuredAt: new Date().toISOString(), viewport: '1440x900', ...data }, null, 2));
console.log(`${outDir}: measured ${url}`);
await browser.close();
