// Search routes (SPEC.md §10, §20.6): /api/search merges the .md index (server/search.js, page text) with the
// document index (server/doc-index.js: PDF text, transcripts, recognised ink) into one row per page, every
// snippet stamped with its kind and its target; /api/search/status and /api/search/reindex watch and rebuild
// the document index; /api/titles moved here unchanged. Express 5 matches '/api/search' exactly, so
// '/api/search/status' is its own route; index.js registers this module before the static mounts.
import path from 'node:path'
import * as search from '../search.js'
import * as docIndex from '../doc-index.js'
import { fold } from '../format.js'

export const KINDS = ['text', 'pdf', 'transcript', 'ink']
export const kindsOf = s => {
  if (!s) return null
  const set = new Set(String(s).split(',').map(x => x.trim()).filter(k => KINDS.includes(k)))
  return set.size ? set : null
}
const rowFor = rel => { const parts = rel.split('/'); return { path: rel, title: path.posix.basename(rel, '.md'), notebook: parts[0] || '', section: parts[1] || '', count: 0, inTitle: false, sources: { text: 0, pdf: 0, transcript: 0, ink: 0 }, snippets: [] } }

// → [{ path, title, notebook, section, count, inTitle, sources: { text, pdf, transcript, ink }, snippets: [
//      { kind:'text', text, at, block } | { kind:'pdf', text, at, el, name, page } | { kind:'transcript', text, at, el, name, t } | { kind:'ink', text, at, el } ] }]
// `count` = hits across every wanted source; `snippets` ≤ 8 per row, text (≤ 3) → pdf → transcript → ink;
// `inTitle` only when text is wanted. Sort: inTitle desc, count desc, title asc.
export function query(q, limit = 50, kinds = null) {
  const needle = fold(q).trim()
  if (!needle) return []
  const want = k => !kinds || kinds.has(k)
  const rows = new Map()
  if (want('text')) {
    for (const r of search.search(q, Infinity)) {
      rows.set(r.path, { path: r.path, title: r.title, notebook: r.notebook, section: r.section, count: r.count, inTitle: !!r.inTitle, sources: { text: r.count, pdf: 0, transcript: 0, ink: 0 },
        snippets: r.snippets.map(s => ({ kind: 'text', text: s.text, at: s.at, block: docIndex.blockAt(r.path, s.at) })) })
    }
  }
  for (const rel of docIndex.paths()) {
    const h = docIndex.hits(rel, needle, want)
    if (!h.count) continue
    let r = rows.get(rel)
    if (!r) { r = rowFor(rel); rows.set(rel, r) }
    r.count += h.count
    Object.assign(r.sources, h.sources)
    r.snippets = [...r.snippets, ...h.snippets].slice(0, 8)
  }
  const out = [...rows.values()]
  out.sort((a, b) => (b.inTitle - a.inTitle) || (b.count - a.count) || a.title.localeCompare(b.title))
  return out.slice(0, limit)
}

export function register(app, { q }) {
  app.get('/api/search', (req, res) => res.json(query(q(req, 'q') || '', Number(q(req, 'limit')) || 50, kindsOf(q(req, 'kinds')))))
  app.get('/api/search/status', (req, res) => res.json(docIndex.status()))
  app.post('/api/search/reindex', (req, res) => { docIndex.rebuild(); res.json({ started: true }) })
  app.get('/api/titles', (req, res) => res.json(search.titles()))
}
