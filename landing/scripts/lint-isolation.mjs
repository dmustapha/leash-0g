#!/usr/bin/env node
// Isolation gate: fail if any source file in landing/ imports from outside landing/
// (e.g. ../web, ../backend, or any path that escapes the workspace root).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', 'proposals-screenshots', '.git'])
const EXTS = new Set(['.js', '.mjs', '.ts', '.css', '.html'])

const IMPORT_RE = [
  /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g, // js/ts imports
  /@import\s+(?:url\()?['"]?([^'")]+)['"]?\)?/g, // css imports
  /\b(?:src|href)=["']([^"']+)["']/g, // html refs
]

const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (EXTS.has(extname(p))) files.push(p)
  }
})(ROOT)

const violations = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const re of IMPORT_RE) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue // bare specifiers = node_modules, fine
      const target = resolve(dirname(file), spec.split(/[?#]/)[0])
      if (!target.startsWith(ROOT + '/') && target !== ROOT) {
        violations.push(`${file}: "${spec}" resolves outside landing/`)
      }
    }
  }
  // belt-and-braces: any literal reference to sibling workspaces
  if (/\.\.\/(web|backend|contracts)\//.test(text)) {
    violations.push(`${file}: literal ../web|backend|contracts reference`)
  }
}

if (violations.length) {
  console.error('ISOLATION LINT FAILED:')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log(`isolation lint OK (${files.length} files checked, 0 escapes)`)
