// Text of a PDF, one string per page, extracted in Node with pdfjs-dist's legacy build and cached beside the
// file as `<name>.pdf.txt` keyed by the PDF's mtime and size. SPEC.md §10, §20.6. Pure helpers, no index
// state: server/doc-index.js and scripts/pdf-text.mjs (and the ask group's context builder) share this one extractor.
//
// Cache format (the first line is the key; `[page N]` blocks follow, one per page, empty pages included so the
// numbering stays aligned with the PDF; a failed extraction records `pages=0 error=…` so a broken file is not
// retried every boot — a changed mtime or size retries it):
//   [slate pdf-text v2 mtime=1757374560000 size=743825 pages=16 ocr=vision]
//   [page 1]
//   Chapter 1: Introduction
//   …
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { atomicWrite } from './fs.js'

export const CACHE_VERSION = 2   // v2 adds the `ocr=` field and the quality gate below
export const cachePath = absPdf => absPdf + '.txt'                       // "ECO208 Chapter 1.pdf.txt", beside the PDF
export const isCache = name => /\.pdf\.txt$/i.test(name)
const HEADER = /^\[slate pdf-text v(\d+) mtime=(\d+) size=(\d+) pages=(\d+)(?: ocr=([\w-]+))?(?: error=(.*))?\]$/
const PAGE = /^\[page (\d+)\]$/

// Where a page's document really is. `src` is relative to the page's folder and normally starts with the page's own
// `<Title>.assets/`; a raw src that does not exist is retried percent-decoded, and one whose `.assets` folder is gone is
// looked up in the page's current `.assets` folder — after `POST /api/rename` the folder moves with the page but the
// sidecar's `src` strings still name the old title. Returns the absolute path inside ROOT, or null.
export async function assetPath(root, pageDir, pageBase, src) {
  const inside = a => a.startsWith(root + '/') || a.startsWith(root + '\\')
  const rel = String(src || '')
  const cands = [rel, safeDecode(rel)]
  const m = /^[^/]+\.assets\/(.+)$/.exec(safeDecode(rel))
  if (m && pageBase) cands.push(`${pageBase}.assets/${m[1]}`)
  for (const c of cands) {
    if (!c) continue
    const abs = path.resolve(pageDir, c)
    if (inside(abs) && (await fs.stat(abs).catch(() => null))) return abs
  }
  return null
}
const safeDecode = s => { try { return decodeURIComponent(s) } catch { return s } }

let lib = null
// Loaded on first use, never at boot: the legacy build is what Node needs (verified 6.3.289 / Node 24: a 6-page
// deck in ~60 ms after the ~350 ms first import).
const pdfjs = () => (lib ||= import('pdfjs-dist/legacy/build/pdf.mjs'))

// NFC, runs of spaces/tabs/nbsp collapsed, lines trimmed, three or more blank lines collapsed to one.
export const normalize = s => String(s || '').normalize('NFC').replace(/[ \t ]+/g, ' ').split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()

export function serialize({ mtime, size, pages, error = null, ocr = null }) {
  const err = error ? ' error=' + String(error).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return `[slate pdf-text v${CACHE_VERSION} mtime=${mtime} size=${size} pages=${pages.length}${ocr ? ` ocr=${ocr}` : ''}${err}]\n` + pages.map((t, i) => `[page ${i + 1}]\n${t}\n`).join('\n')
}
// null when the text is not one of our caches (missing, foreign, hand-edited header).
export function parse(text) {
  const lines = String(text || '').split('\n')
  const h = HEADER.exec(lines[0] || '')
  if (!h) return null
  const pages = []
  let cur = null
  for (const l of lines.slice(1)) { const m = PAGE.exec(l); if (m) { cur = []; pages.push(cur) } else if (cur) cur.push(l) }
  return { version: +h[1], mtime: +h[2], size: +h[3], ocr: h[5] || null, error: h[6] || null, pages: pages.map(ls => ls.join('\n').trim()) }
}

// The words of every page, in reading order as pdf.js sees them. Yields to the event loop between pages so a
// request never waits for a whole deck; `timeoutMs` destroys the task if a pathological file drags on.
export async function extract(absPdf, { timeoutMs = 60000 } = {}) {
  const { getDocument } = await pdfjs()
  const data = new Uint8Array(await fs.readFile(absPdf))
  const task = getDocument({ data, disableFontFace: true, isEvalSupported: false, verbosity: 0 })
  const timer = setTimeout(() => task.destroy().catch(() => { }), timeoutMs)
  try {
    const doc = await task.promise, pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i), tc = await page.getTextContent()
      let s = ''
      for (const it of tc.items) { if (it.str) s += it.str; if (it.hasEOL) s += '\n' }
      pages.push(normalize(s))
      page.cleanup()
      await new Promise(r => setImmediate(r))
    }
    return pages
  } finally { clearTimeout(timer); await task.destroy().catch(() => { }) }
}

// Cached text, or extract + write. `write:false` for a dry run. Never throws on a bad PDF: returns `error` and
// (when writing) records it in the cache header so the file is not retried on every boot. `force` ignores a
// valid cache. Result: { pages: string[], cached: bool, error: string|null, mtime, size }.
// ---- the quality gate ---------------------------------------------------------------------------
// A PDF can carry a text layer that is present, non-empty, and complete nonsense. FCS298's assigned chapter is
// one: a clean scan whose every page claims a single Helvetica/WinAnsi font and decodes to line noise. pdfjs
// extracts it without complaint, so the cache, the search index and the brain all read garbage and nothing says
// so. `wordish` is the share of non-space characters that sit inside a run of two or more letters — near zero
// for symbol soup, high for prose. Measured over FCS298's 15 sidecars on 2026-09-18: the broken chapter scores
// 0.487, the next-worst *good* file 0.838, the rest 0.846-0.954. 0.65 sits in that empty band.
export const WORDISH_MIN = 0.65
export function wordish(text) {
  const t = String(text || '')
  const dense = t.replace(/\s/g, '').length
  if (dense < 200) return 1                       // too little text to judge; a cover page is not a failure
  let inWords = 0
  for (const m of t.matchAll(/[A-Za-z]{2,}/g)) inWords += m[0].length
  return inWords / dense
}

const run = promisify(execFile)
// fileURLToPath, not URL.pathname: this repo lives under "Claude OS" and pathname keeps the %20.
const OCR_PY = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ocr-pdf.py')
const OCR_VENV = () => process.env.SLATE_OCR_PYTHON || path.join(os.homedir(), '.local/share/slate/venv/bin/python')

// macOS Vision OCR of every page, used only when the embedded layer fails the gate. ~1s/page, so this is never
// on a request path — see the `ocr` option on textFor. → string[] | null (null when the toolchain is absent).
export async function ocrExtract(absPdf, { timeoutMs = 600000 } = {}) {
  try {
    const { stdout } = await run(OCR_VENV(), [OCR_PY(), absPdf], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    const out = JSON.parse(stdout)
    if (out.error || !Array.isArray(out.pages)) return null
    return out.pages.map(p => normalize(p.text || ''))
  } catch { return null }        // no venv, no Vision, a timeout: the embedded text stands and the header says why
}

export async function textFor(absPdf, { write = true, force = false, ocr = false } = {}) {
  const st = await fs.stat(absPdf), mtime = Math.round(st.mtimeMs), size = st.size
  if (!force) {
    const c = parse(await fs.readFile(cachePath(absPdf), 'utf8').catch(() => ''))
    if (c && c.version === CACHE_VERSION && c.mtime === mtime && c.size === size) {
      // A cache written by a reader that did not want OCR (the app's doc-index, the ask context builder — both
      // take the default ocr:false) is still a valid v2 cache, so without this the batch pass sees a cache hit
      // and the gate never runs: the app silently clobbers an OCR'd sidecar and nothing but --force brings it
      // back. A hit only counts if it already carries OCR, or its text passes the gate, or we are not asking.
      const q = wordish(c.pages.join('\n'))
      if (!ocr || c.ocr || c.error || q >= WORDISH_MIN) return { pages: c.pages, cached: true, error: c.error, mtime, size, ocr: c.ocr, quality: q }
    }
  }
  let pages = [], error = null, ocrEngine = null
  try { pages = await extract(absPdf) } catch (e) { error = e?.message || String(e) }
  // The gate. Off by default: textFor runs on request paths (doc-index, the ask context builder) where a
  // ten-second OCR would be felt, so only the batch pass (scripts/pdf-text.mjs) asks for it.
  if (ocr && !error) {
    const score = wordish(pages.join('\n'))
    if (score < WORDISH_MIN) {
      const got = await ocrExtract(absPdf)
      const better = got && wordish(got.join('\n'))
      if (got && better > score) { pages = got; ocrEngine = 'vision' }
      else if (!got) error = `text layer unreadable (wordish ${score.toFixed(2)}) and OCR unavailable — run bin/install-ocr.sh`
      else error = `text layer unreadable (wordish ${score.toFixed(2)}); OCR did no better (${better.toFixed(2)})`
    }
  }
  if (write) await atomicWrite(cachePath(absPdf), serialize({ mtime, size, pages, error, ocr: ocrEngine }))
  return { pages, cached: false, error, mtime, size, ocr: ocrEngine, quality: wordish(pages.join('\n')) }
}
// Measured 2026-09-09 (M-series, Node 24.14, pdfjs 6.3.289): 16-page deck 66 ms, 24-page study sheet 144 ms,
// 6-page syllabus 30 ms; worst event-loop stall 22 ms. If a real stall is ever observed, move extract() into a
// worker_threads worker — this is the only file that changes.
