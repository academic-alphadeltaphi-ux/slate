#!/usr/bin/env node
// Make `<name>.pdf.txt` beside every PDF a page references (SPEC.md §20.6) — the words of each deck, one
// `[page N]` block per page under a header naming the PDF's mtime and size — so the app's search and the 10:00
// build can read slides without opening the PDF. Idempotent: a cached PDF costs a stat and a read. Runs in the
// 07:10 pass (scripts/sync-prompt.md step 5) and from a terminal. Connector-free.
//
//   node scripts/pdf-text.mjs [--root <dir>] [--page <rel .md>] [--force] [--dry-run] [--json]
//
// Exit 0 even with failures: a bad PDF is recorded in its cache header, not a reason to stop the morning pass.
import fs from 'node:fs/promises'
import path from 'node:path'
import { guardFlags } from './lib/argv.mjs'

guardFlags(['--dry-run', '--force', '--help', '--json', '--no-ocr', '--page', '--root'])

const args = process.argv.slice(2)
const flag = k => args.includes(k)
const val = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
if (flag('--help') || flag('-h')) { console.log('node scripts/pdf-text.mjs [--root <dir>] [--page <rel .md>] [--force] [--no-ocr] [--dry-run] [--json]'); process.exit(0) }
if (val('--root')) process.env.SLATE_ROOT = path.resolve(val('--root'))     // before server/fs.js fixes ROOT at import
const { ROOT } = await import('../server/fs.js')
const { textFor, cachePath, assetPath } = await import('../server/pdf-text.js')

const json = flag('--json'), dry = flag('--dry-run'), force = flag('--force'), only = val('--page')
const useOcr = !flag('--no-ocr')   // a PDF whose text layer is nonsense is re-read with Vision OCR (server/pdf-text.js)
const log = (...a) => { if (!json) console.log(...a) }
const SKIP = new Set(['.trash', '.git', 'node_modules'])

// Same walk as server/doc-index.js start(): names starting with . or _ skipped, *.assets dirs skipped, sidecars at depth ≥ 3.
const sidecars = []
async function walk(relDir) {
  const ents = await fs.readdir(path.join(ROOT, relDir), { withFileTypes: true }).catch(() => [])
  for (const e of ents) {
    if (SKIP.has(e.name) || e.name.startsWith('.') || e.name.startsWith('_')) continue
    const rel = relDir ? `${relDir}/${e.name}` : e.name
    if (e.isDirectory()) { if (!e.name.endsWith('.assets')) await walk(rel) }
    else if (e.name.endsWith('.blocks.json') && rel.split('/').length >= 3) sidecars.push(rel)
  }
}
await walk('')
sidecars.sort()

const sum = { extracted: 0, cached: 0, failed: 0, ocr: 0, pages: 0, pdfs: 0 }
const seen = new Set()
for (const rel of sidecars) {
  const md = rel.replace(/\.blocks\.json$/, '.md')
  if (only && md !== only) continue
  let layout
  try { layout = JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8')) } catch { continue }
  for (const el of layout.elements || []) {
    const src = String(el?.src || '')
    if (!(el?.type === 'pdf' || (el?.type === 'file' && /\.pdf$/i.test(src)))) continue
    const pageDir = path.dirname(path.join(ROOT, rel)), pageBase = path.basename(rel, '.blocks.json')
    const abs = await assetPath(ROOT, pageDir, pageBase, src)                // decoded, and re-homed after a rename (server/pdf-text.js)
    if (!abs) continue
    if (seen.has(abs)) continue                                               // one PDF referenced twice is one cache
    seen.add(abs); sum.pdfs++
    const relPdf = path.relative(ROOT, abs)
    if (force && !dry) await fs.rm(cachePath(abs), { force: true })
    const t0 = Date.now()
    const r = await textFor(abs, { write: !dry, force: force && dry, ocr: useOcr })
    if (r.error) { sum.failed++; log(`  ✗ ${relPdf} — ${r.error}`) }
    else if (r.cached) { sum.cached++; log(`  · ${relPdf} — cached`) }
    else { sum.extracted++; sum.pages += r.pages.length; if (r.ocr) sum.ocr++; log(`  ${r.ocr ? '⎘' : '✓'} ${relPdf} — ${r.pages.length} pages, ${r.pages.reduce((a, p) => a + p.length, 0)} chars in ${Date.now() - t0} ms${r.ocr ? ` · text layer unusable, re-read by ${r.ocr} OCR` : ''}${dry ? ' (dry run, not written)' : ''}`) }
  }
}
if (json) console.log(JSON.stringify(sum))
else console.log(`Extracted ${sum.extracted}, cached ${sum.cached}, failed ${sum.failed}${sum.ocr ? `, OCR'd ${sum.ocr}` : ''}.${dry ? ' Dry run: nothing written.' : ''}`)
