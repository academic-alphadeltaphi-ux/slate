#!/usr/bin/env node
// Batch handwriting recognition (SPEC §20.9): Apple Vision over every ink element whose text is missing or out
// of date, written onto the element beside its strokes. Run by the morning pass (scripts/sync-prompt.md step 4),
// by the Sync button's Claude pass, and from the terminal. Deterministic, connector-free.
//   node scripts/hwr.mjs [--root /path] [--page "<rel or abs .md>"] [--course "ECO 208Y1"] [--force]
//                        [--settle 600] [--dry-run] [--json] [--check]
// A sidecar modified in the last --settle seconds (default ten minutes) is left alone unless --page names it, so a
// page being inked right now is never rewritten under the student. `--check` prints the runner the server would use and
// exits 0 (available) or 3. `--json` prints one summary line last:
//   { updatedAt, runner, pages, elements, lines, unchanged, empty, changed, skippedSettling, errors: [string] }
// and `{ ok: false, note }` with exit 3 when no runner is available.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { guardFlags } from './lib/argv.mjs'
import { notesRoot } from './lib/root.mjs'

guardFlags(['--check', '--course', '--dry-run', '--force', '--json', '--page', '--root', '--settle'])

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }
const ROOT = notesRoot(process.argv)
process.env.SLATE_ROOT = ROOT   // server/fs.js reads it at import time, so it is set before the dynamic imports
const hwr = await import('../server/hwr.js')
const { isoNow } = await import('../server/format.js')
const { inkHashOf } = await import('../src/inkhash.js')

const JSON_OUT = args.includes('--json'), DRY = args.includes('--dry-run'), FORCE = args.includes('--force')
const SETTLE = Math.max(0, Number(flag('--settle', 600)) || 0) * 1000
const ONLY_PAGE = flag('--page', null), COURSE = flag('--course', null)
const log = (...a) => { if (!JSON_OUT) console.log(...a) }

if (args.includes('--check')) {
  const s = await hwr.ensureRunner({ force: true })
  console.log(JSON.stringify(hwr.status()))
  process.exit(s.runner ? 0 : 3)
}

// --page accepts the page's path relative to the root or its absolute path (the same rule as transcribe.mjs).
const matches = relMd => !ONLY_PAGE || relMd === ONLY_PAGE || path.join(ROOT, relMd) === ONLY_PAGE || path.resolve(ONLY_PAGE) === path.join(ROOT, relMd)
const inCourse = relMd => !COURSE || relMd.startsWith(COURSE.replace(/\/+$/, '') + '/')

// Every sidecar under the root that holds an ink element. Names starting with . or _ and *.assets are skipped.
const sidecars = []
const walk = async dir => {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.endsWith('.assets')) await walk(p); continue }
    if (e.isFile() && e.name.endsWith('.blocks.json')) sidecars.push(p)
  }
}
await walk(ROOT)
sidecars.sort((a, b) => a.localeCompare(b))

const summary = { updatedAt: isoNow(), runner: null, pages: 0, elements: 0, lines: 0, unchanged: 0, empty: 0, changed: 0, skippedSettling: 0, errors: [] }
const pages = []   // rel .md paths with at least one stale ink element
for (const abs of sidecars) {
  const relMd = path.relative(ROOT, abs).split(path.sep).join('/').replace(/\.blocks\.json$/, '.md')
  if (!matches(relMd) || !inCourse(relMd)) continue
  let text
  try { text = await fs.readFile(abs, 'utf8') } catch (e) { summary.errors.push(`${relMd}: ${e.message}`); continue }
  if (!/"type":\s*"ink"/.test(text)) continue
  let layout
  try { layout = JSON.parse(text) } catch { summary.errors.push(`${relMd}: sidecar is not valid JSON`); log(`  ✗ ${relMd} — sidecar is not valid JSON`); continue }
  const inks = (layout?.elements || []).filter(e => e && e.type === 'ink' && Array.isArray(e.strokes) && e.strokes.length)
  if (!inks.length) continue
  const stale = inks.some(e => FORCE || e.inkHash !== inkHashOf(e))
  if (!stale) { summary.unchanged++; continue }
  if (!ONLY_PAGE && SETTLE) {
    const age = Date.now() - (await fs.stat(abs)).mtimeMs
    if (age < SETTLE) { summary.skippedSettling++; log(`  · ${relMd} — touched ${Math.max(0, Math.round(age / 60000))} min ago, left alone`); continue }
  }
  pages.push(relMd)
}

if (pages.length && !DRY) {
  const s = await hwr.ensureRunner()
  if (!s.runner) {
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, note: s.note }))
    else console.error('Handwriting recognition is not available: ' + s.note)
    process.exit(3)
  }
}
for (const rel of pages) {
  if (DRY) { log(`  would recognise ${rel}`); continue }
  try {
    const r = await hwr.recognizePage(rel, { force: FORCE })
    const done = r.results.filter(x => !x.skipped)
    const lines = done.reduce((n, x) => n + (x.lines?.length || 0), 0), ms = done.reduce((n, x) => n + (x.ms || 0), 0)
    if (done.length) summary.pages++
    summary.elements += done.length
    summary.lines += lines
    summary.empty += done.filter(x => x.text === '').length
    summary.changed += r.results.filter(x => x.skipped === 'changed').length
    log(`  ✓ ${rel} — ${done.length} element(s), ${lines} line(s), ${ms} ms`)
  } catch (e) {
    if (e.status === 503) {
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, note: e.extra?.note || hwr.NOTE }))
      else console.error('Handwriting recognition is not available: ' + (e.extra?.note || hwr.NOTE))
      process.exit(3)
    }
    summary.errors.push(`${rel}: ${e.message}`)
    log(`  ✗ ${rel} — ${e.message}`)
  }
}
summary.runner = hwr.status().runner
if (JSON_OUT) console.log(JSON.stringify(summary))
else if (DRY) console.log(`Would recognise ${pages.length} page(s) (${summary.unchanged} already up to date, ${summary.skippedSettling} left to settle).`)
else console.log(`Recognised ${summary.elements} element(s) on ${summary.pages} page(s) (${summary.unchanged} page(s) already up to date, ${summary.skippedSettling} left to settle${summary.errors.length ? `, ${summary.errors.length} error(s)` : ''}).`)
process.exit(summary.errors.length && !summary.pages ? 1 : 0)
