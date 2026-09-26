import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, '../public/x-cover.svg'), 'utf8');
const out = join(here, '../public/x-cover.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2 });
await page.setContent(
  `<!doctype html><html><head><style>*{margin:0;padding:0}html,body{width:1500px;height:500px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`,
  { waitUntil: 'networkidle' }
);
await page.locator('svg').screenshot({ path: out });
await browser.close();
console.log('wrote', out);
