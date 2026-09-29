// The document index: what is inside a page — the text of its PDFs, the transcript of its recording, the `text`
// of its ink once handwriting is recognised — plus the container offsets of the page's own text, so a hit in
// the .md index lands on its block. Built in the background after boot (index.js calls start() after listen),
// kept fresh by the watcher (onEvent), rebuildable at any time (rebuild). Never the truth: delete every
// `<name>.pdf.txt` and POST /api/search/reindex, and it all comes back. SPEC.md §10, §20.6.
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './fs.js'
import { fold, parsePage } from './format.js'
import { textFor, isCache, assetPath, cachePath } from './pdf-text.js'

const MEDIA_RE = /\.(m4a|mp3|wav|aac|ogg|flac|mp4|mov|webm)$/i
const SKIP = new Set(['.trash', '.git', 'node_modules'])
const pages = new Map()      // relMd → { items, blocks, at }
const timers = new Map()     // relMd → debounce timer (400 ms: a transcribe run drops six files in a row)
const wanted = new Map()     // relMd → true when the queued scan must re-read the documents, false for the .md only
const estimate = new Map()   // relMd → PDFs the boot walk counted in the sidecar; dropped once the page is scanned
const ownCache = new Map()   // absolute `.pdf.txt` path → expiry: caches this process wrote, so the watcher's echo does not rescan
let queue = [], running = false, updatedAt = null, generation = 0
const errors = []            // last 50 { path, error }; status() shows 10
const DEBUG = !!process.env.SLATE_DEBUG_DOCS   // SLATE_DEBUG_DOCS=1 logs every event and scan (used by scripts/test-search.mjs debugging)

// The hwr group's contract lives here and only here: `text` on the ink element, or `lines[].text` joined.
export const inkText = el => (typeof el?.text === 'string' ? el.text : Array.isArray(el?.lines) ? el.lines.map(l => l?.text || '').join('\n') : '')
// A ±60-character window around a hit, whitespace collapsed, `…` on the cut sides (the .md index's shape).
export const snippetAt = (text, at, len) => {
  const a = Math.max(0, at - 60), b = Math.min(text.length, at + len + 60)
  return { text: (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : ''), at }
}
// '<base>.blocks.json' → '<base>.md'; '<dir>/<X>.assets/…' → '<dir>/<X>.md'; '<dir>/<X>.assets' → '<dir>/<X>.md'; else null
export function mdOf(rel) {
  if (rel.endsWith('.md')) return rel
  if (rel.endsWith('.blocks.json')) return rel.replace(/\.blocks\.json$/, '.md')
  const m = /^(.*?)([^/]+)\.assets(?:\/.+)?$/.exec(rel)
  return m ? `${m[1]}${m[2]}.md` : null
}
const isPdfEl = (el, src) => el.type === 'pdf' || (el.type === 'file' && /\.pdf$/i.test(src))
const pushError = (p, e) => { errors.push({ path: p, error: e?.message || String(e), at: new Date().toISOString() }); if (errors.length > 50) errors.shift() }

// Returns at once; the walk and the scans run behind it. Pages with documents are queued first so their hits
// arrive before the plain notes are re-read (those cost microseconds each).
export function start() {
  const t0 = Date.now(), gen = ++generation
  const docs = [], plain = []
  const walk = async relDir => {
    const ents = await fs.readdir(path.join(ROOT, relDir), { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      if (SKIP.has(e.name) || e.name.startsWith('.') || e.name.startsWith('_')) continue
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) { if (!e.name.endsWith('.assets')) await walk(rel); continue }
      if (rel.split('/').length < 3) continue                                // pages live at notebook/section/page.md or deeper
      if (e.name.endsWith('.blocks.json')) {
        const md = mdOf(rel), text = await fs.readFile(path.join(ROOT, rel), 'utf8').catch(() => '')
        estimate.set(md, (text.match(/\.pdf"/gi) || []).length)             // a cheap count for the status line, not a parse
        docs.push(md)
      } else if (e.name.endsWith('.md')) plain.push(rel)
    }
  }
  walk('').then(() => {
    if (gen !== generation) return                                            // a rebuild started meanwhile
    const seen = new Set(docs)
    for (const rel of docs) enqueue(rel, 0, true)
    for (const rel of plain) if (!seen.has(rel)) enqueue(rel, 0, true)
    console.log(`[docs] ${docs.length} pages with documents, ${plain.length} pages queued in ${Date.now() - t0} ms`)
  }).catch(e => console.error('[docs]', e.message))
}
// `full`: re-read the sidecar and the documents; false re-reads only the .md (container offsets) when the page is known.
export function enqueue(relMd, debounce = 400, full = true) {
  if (!relMd) return
  if (full || !wanted.has(relMd)) wanted.set(relMd, full || wanted.get(relMd) === true)
  clearTimeout(timers.get(relMd))
  timers.set(relMd, setTimeout(() => { timers.delete(relMd); if (!queue.includes(relMd)) queue.push(relMd); pump() }, debounce))
}
async function pump() {
  if (running) return
  running = true
  try {
    while (queue.length) {
      const rel = queue.shift(), full = wanted.get(rel) !== false
      wanted.delete(rel)
      const t0 = Date.now()
      try { await scanPage(rel, { full }) } catch (e) { pushError(rel, e) }
      if (DEBUG) console.log(`[docs] scanned ${rel} full=${full} in ${Date.now() - t0} ms`)
      estimate.delete(rel)
      await new Promise(r => setImmediate(r))                                // let requests through between pages
    }
  } finally { running = false; updatedAt = new Date().toISOString() }
}

// Container offsets in the page's plain body (blocks joined by a blank line — exactly what server/search.js
// indexes), so a hit at offset i belongs to the last block whose `at` ≤ i. The anonymous first block has id null.
const offsetsOf = md => { let at = 0; return parsePage(md).blocks.map(b => { const r = { id: b.id, at }; at += b.md.length + 2; return r }) }

export async function scanPage(relMd, { full = true } = {}) {
  const absMd = path.join(ROOT, relMd), base = absMd.replace(/\.md$/, ''), pageDir = path.dirname(absMd), pageBase = path.basename(base)
  const md = await fs.readFile(absMd, 'utf8').catch(() => null)
  const prev = pages.get(relMd)
  if (!full && prev) {                                                        // the .md changed: only the offsets move
    if (md === null && !prev.items.length) { pages.delete(relMd); return }
    pages.set(relMd, { ...prev, blocks: md === null ? [] : offsetsOf(md), at: Date.now() })
    return
  }
  let layout = null
  try { layout = JSON.parse(await fs.readFile(base + '.blocks.json', 'utf8')) } catch { }
  if (md === null && !layout) { pages.delete(relMd); return }
  const items = []
  for (const el of layout?.elements || []) {
    if (!el?.id) continue
    const src = String(el.src || ''), name = decodeURIComponent(src.split('/').pop() || '')
    if (isPdfEl(el, src)) {
      const abs = await assetPath(ROOT, pageDir, pageBase, src)              // decoded, and re-homed after a rename
      if (!abs) continue
      const r = await textFor(abs)                                            // cache hit, or one extraction in this turn of the queue
      if (!r.cached) ownCache.set(cachePath(abs), Date.now() + 8000)
      if (r.error) pushError(relMd + ' → ' + src, r.error)
      items.push({ kind: 'pdf', el: el.id, src, name, error: r.error, pages: r.pages.map(t => { const text = t.replace(/\n/g, ' '); return { text, folded: fold(text) } }) })
    } else if (el.type === 'media' || MEDIA_RE.test(src)) {
      // The transcript sits beside the recording: <X>.assets/<X>.transcript.json (what MediaEl reads), .txt as the fallback.
      const media = await assetPath(ROOT, pageDir, pageBase, src)
      if (!media) continue
      const dir = path.dirname(media)
      if (!dir.endsWith('.assets')) continue
      // <X>.transcript.json is named after the recording, which is the only name that works when a page shows two of them.
      // Transcripts written before that rule carry the page's name: the src's folder title, else the folder's current title
      // (a renamed page), else the one *.transcript.json the folder holds.
      const titles = [...new Set([path.basename(media).replace(/\.[^.]+$/, ''), decodeURIComponent(src.split('/')[0] || '').replace(/\.assets$/, ''), path.basename(dir).replace(/\.assets$/, '')].filter(Boolean))]
      const names = (await fs.readdir(dir).catch(() => [])).filter(n => /\.transcript\.json$/.test(n))
      if (names.length === 1) titles.push(names[0].replace(/\.transcript\.json$/, ''))
      let paragraphs = null
      for (const X of titles) {
        try { paragraphs = JSON.parse(await fs.readFile(path.join(dir, X + '.transcript.json'), 'utf8')).paragraphs } catch { }
        if (Array.isArray(paragraphs)) break
        const txt = await fs.readFile(path.join(dir, X + '.txt'), 'utf8').catch(() => null)
        if (txt) { paragraphs = [...txt.matchAll(/^\[(\d\d):(\d\d):(\d\d)\] (.*)$/gm)].map(m => ({ start: +m[1] * 3600 + +m[2] * 60 + +m[3], text: m[4] })); if (paragraphs.length) break }
      }
      if (paragraphs?.length) items.push({ kind: 'transcript', el: el.id, src, name, paragraphs: paragraphs.map(p => { const text = String(p?.text || ''); return { start: +p?.start || 0, text, folded: fold(text) } }) })
    } else if (el.type === 'ink') {
      const text = inkText(el).trim()
      if (text) items.push({ kind: 'ink', el: el.id, text, folded: fold(text) })
    }
  }
  pages.set(relMd, { items, blocks: md === null ? [] : offsetsOf(md), at: Date.now() })
}
export function remove(relMd) { pages.delete(relMd) }
export function removeDir(relDir) { for (const k of [...pages.keys()]) if (k === relDir || k.startsWith(relDir + '/')) pages.delete(k) }

// Called by watch.js for every event, own writes included (the index must stay right even when clients are not told).
export function onEvent(type, rel, kind) {
  if (DEBUG) console.log('[docs] event', type, kind, rel)
  if (isCache(rel)) {                                                         // our own cache write coming back: not news
    const now = Date.now()
    for (const [k, exp] of ownCache) if (exp <= now) ownCache.delete(k)
    if (ownCache.has(path.join(ROOT, rel))) return
  }
  if (type === 'unlinkDir') { removeDir(rel); if (rel.endsWith('.assets')) enqueue(mdOf(rel)); return }
  if (type === 'addDir') return
  if (kind === 'md') return type === 'unlink' ? enqueue(rel, 100, true) : enqueue(rel, 100, false)   // offsets only; a full scan when the page is new
  if (kind === 'layout') return type === 'unlink' ? enqueue(mdOf(rel), 100, true) : enqueue(mdOf(rel))
  if (kind === 'asset' && (isCache(rel) || /\.(pdf|transcript\.json|txt)$/i.test(rel) || MEDIA_RE.test(rel))) enqueue(mdOf(rel))
  // A cache written by scripts/pdf-text.mjs (or by hand) rescans its owner: a stat and a read, the cache is valid, nothing
  // is written again, so the loop ends there.
}

// Hits for one page. `want(kind)` says which kinds the caller asked for. Sources are counted past the snippet caps
// (text ≤ 3 comes from search.js; here pdf ≤ 3 per PDF on distinct pages, transcript ≤ 3 in time order, ink 1 per element).
export function hits(relMd, needle, want = () => true) {
  const out = { count: 0, snippets: [], sources: { pdf: 0, transcript: 0, ink: 0 } }
  const e = pages.get(relMd)
  if (!e || !needle) return out
  for (const it of e.items) {
    if (!want(it.kind)) continue
    if (it.kind === 'pdf') {
      let snips = 0
      it.pages.forEach((p, i) => {
        let j = -1, c = 0
        while ((j = p.folded.indexOf(needle, j + 1)) !== -1 && c < 200) {
          if (!c && snips < 3) { out.snippets.push({ kind: 'pdf', el: it.el, name: it.name, page: i + 1, ...snippetAt(p.text, j, needle.length) }); snips++ }
          c++
        }
        out.sources.pdf += c
      })
    } else if (it.kind === 'transcript') {
      let snips = 0
      for (const p of it.paragraphs) {
        const j = p.folded.indexOf(needle)
        if (j === -1) continue
        out.sources.transcript++
        if (snips < 3) { out.snippets.push({ kind: 'transcript', el: it.el, name: it.name, t: p.start, ...snippetAt(p.text, j, needle.length) }); snips++ }
      }
    } else if (it.kind === 'ink') {
      const j = it.folded.indexOf(needle)
      if (j !== -1) { out.sources.ink++; out.snippets.push({ kind: 'ink', el: it.el, ...snippetAt(it.text, j, needle.length) }) }
    }
  }
  out.count = out.sources.pdf + out.sources.transcript + out.sources.ink
  return out
}
// The container a .md-index hit at offset `i` belongs to: its anchor id, or null for the anonymous first block
// (the client maps null to FIRST). Also null when the page is not indexed yet.
export function blockAt(relMd, i) {
  const e = pages.get(relMd)
  if (!e) return null
  let b = null
  for (const x of e.blocks) { if (x.at <= i) b = x; else break }
  return b?.id ?? null
}
export const paths = () => pages.keys()
export const has = relMd => pages.has(relMd)

export function status() {
  let pdfs = 0, transcripts = 0, ink = 0, emptyPdfs = 0, withDocs = 0
  for (const e of pages.values()) {
    if (e.items.length) withDocs++
    for (const it of e.items) { if (it.kind === 'pdf') { pdfs++; if (!it.pages.some(p => p.text)) emptyPdfs++ } else if (it.kind === 'transcript') transcripts++; else ink++ }
  }
  const queued = new Set([...queue, ...timers.keys()])
  let pendingPdfs = 0
  for (const rel of queued) pendingPdfs += estimate.get(rel) || 0
  return { pages: pages.size, withDocs, pdfs, transcripts, ink, emptyPdfs, pending: queued.size, pendingPdfs, running, indexing: running || queued.size > 0, updatedAt, errors: errors.slice(-10) }
}
// Clears and rebuilds in the background; the .md index (server/search.js) is untouched.
export function rebuild() {
  pages.clear(); queue = []; wanted.clear(); estimate.clear()
  for (const t of timers.values()) clearTimeout(t)
  timers.clear(); errors.length = 0
  start()
}
// Invariants: one PDF extracted at a time (the queue is serial and textFor yields between pages); a page is
// rescanned whole (cheap: cache hits are a stat + a read); an .md change moves only the offsets.
