// Step-2 TEETH (docs/LANDING-DIRECTIONS.md): enforced identity values.
// Scope: the FINAL landing surface (index.html + src/final.css + src/tokens.css).
// Documented values drift; these fail the build instead.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);

const tokens = read('src/tokens.css');
const finalCss = read('src/final.css');
const finalHtml = read('index.html');
const failures = [];

if (!tokens) failures.push('src/tokens.css missing (the token truth file)');

// ---- 1. token discipline: no raw identity literals outside tokens.css ----
if (finalCss) {
  const ALLOWLIST = ['rgba(0, 0, 0,']; // audited: pure-black scrims for image legibility only
  const stripped = finalCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rawColors = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g)]
    .map((m) => m[0])
    .filter((v) => !ALLOWLIST.some((a) => v.startsWith(a)));
  if (rawColors.length > 0) {
    failures.push(`token-discipline: raw color literals in final.css: ${[...new Set(rawColors)].slice(0, 6).join(' · ')}`);
  }
  // lookahead swallows the whitespace so the greedy \s* can't backtrack past it
  // (the old form false-positived on compliant `font-family: var(--x)`)
  const rawFonts = [...stripped.matchAll(/font-family\s*:(?!\s*var\()/g)];
  if (rawFonts.length > 0) failures.push(`token-discipline: ${rawFonts.length} font-family literal(s) in final.css (use var(--font-*))`);
}

// ---- 2. computed contrast >= 4.5:1 on the declared used pairs ----
function lum(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
if (tokens) {
  const tok = (name) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1];
  const PAIRS = [
    ['--color-ink', '--color-base', 'body text'],
    ['--color-ink-dim', '--color-base', 'dim text'],
    ['--color-ink-faint', '--color-surface-1', 'faint text on card'],
    ['--color-accent', '--color-base', 'accent text/lines'],
    ['--color-base', '--color-accent', 'primary CTA label'],
    ['--color-deny', '--color-base', 'refusal text'],
    ['--color-allow', '--color-base', 'jade text'],
    ['--color-ink', '--color-surface-1', 'card text'],
  ];
  for (const [fg, bg, label] of PAIRS) {
    const f = tok(fg); const g = tok(bg);
    if (!f || !g) { failures.push(`contrast: token ${!f ? fg : bg} not found`); continue; }
    const c = contrast(f, g);
    if (c < 4.5) failures.push(`contrast: ${label} (${fg} on ${bg}) = ${c.toFixed(2)}:1 < 4.5:1`);
  }
}

// ---- 3. forbidden-defaults ban list ----
const selection = read('SELECTION.md') ?? '';
const all = [finalCss, finalHtml, tokens].filter(Boolean).join('\n');
const BANNED = [
  [/(?<![A-Za-z])Inter(?![A-Za-z])/i, 'Inter'],
  [/Space Grotesk/i, 'Space Grotesk'],
  [/#3B82F6/i, 'default Tailwind blue #3B82F6'],
];
for (const [re, name] of BANNED) {
  if (re.test(all) && !selection.includes(`conscious keep: ${name}`)) {
    failures.push(`forbidden-default: ${name} present without a conscious-keep entry in SELECTION.md`);
  }
}
const blurCount = (all.match(/backdrop-filter\s*:\s*blur/g) ?? []).length;
if (blurCount > 1) failures.push(`forbidden-default: glassmorphism blur stack (${blurCount} backdrop blurs)`);
if (/confetti/i.test(all)) failures.push('forbidden-default: confetti');
if (finalCss) {
  const radii = new Set([...finalCss.matchAll(/border-radius\s*:\s*([^;]+);/g)].map((m) => m[1].trim()));
  if (radii.size === 1 && radii.has('8px')) failures.push('forbidden-default: 8px-radius-everywhere');
}

// ---- verdict ----
if (failures.length > 0) {
  console.error('DESIGN TESTS FAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`design tests OK (${finalCss ? 'final surface' : 'tokens-only (final.css not built yet)'})`);
