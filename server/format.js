// Page text format: optional YAML frontmatter, then text blocks separated by anchor comments.
// See SPEC.md §4. The frontmatter header is preserved byte for byte unless explicitly replaced.
import matter from 'gray-matter'
import crypto from 'node:crypto'

const ANCHOR_LINE = /^<!-- slate:block ([a-z0-9]{6}) -->[ \t]*$/
const FM_HEADER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

export const ID_RE = /^[a-z0-9]{6}$/
export function newId() {
  let s = ''
  while (s.length < 6) s += Math.floor(Math.random() * 36).toString(36)
  return s
}
export const hashText = t => crypto.createHash('sha1').update(t).digest('hex')

const trimBlock = s => s.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')

export function parsePage(text = '') {
  let frontmatterRaw = null, frontmatter = {}, body = text
  const m = FM_HEADER.exec(text)
  if (m) {
    frontmatterRaw = m[0]
    body = text.slice(m[0].length)
    // With no options gray-matter caches every result under the whole input string, for ever — one copy of every version
    // of every page this long-running server ever parsed (review of 2026-09-18). Any options object turns the cache off.
    try { frontmatter = matter(text, {}).data || {} } catch { frontmatter = {} }
  }
  const blocks = []
  let cur = { id: null, lines: [] }
  for (const line of body.split(/\r?\n/)) {
    const a = ANCHOR_LINE.exec(line)
    if (a) { blocks.push(cur); cur = { id: a[1], lines: [] }; continue }
    cur.lines.push(line)
  }
  blocks.push(cur)
  const out = blocks.map(b => ({ id: b.id, md: trimBlock(b.lines.join('\n')) }))
  if (out.length > 1 && out[0].id === null && out[0].md === '') out.shift()
  return { frontmatter, frontmatterRaw, blocks: out }
}

export function joinPage({ frontmatter = {}, frontmatterRaw = null, blocks = [] }) {
  const parts = blocks.map((b, i) => {
    const md = (b.md || '').replace(/\s+$/, '')
    if (b.id) return `<!-- slate:block ${b.id} -->\n${md}`
    if (i !== 0) throw new Error('only the first block may be anonymous')
    return md
  })
  let body = parts.join('\n\n').replace(/\s+$/, '')
  body = body ? body + '\n' : ''
  if (frontmatterRaw) return frontmatterRaw + body
  const keys = Object.keys(frontmatter || {})
  if (!keys.length) return body
  return matter.stringify(body, frontmatter)
}

// Text a search index or grep should see: no header, no anchors.
export function plainText(text = '') {
  return parsePage(text).blocks.map(b => b.md).join('\n\n')
}

// ---- one text-parsing rule set (SPEC §20.1): search, problems, plan, review and course count the same thing ----
// fold: NFD, combining marks stripped, lowercased, so `economie` matches `économie`.
export const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
// foldKey: fold + whitespace collapsed + trailing punctuation dropped — the stable identity of a task or a problem row.
export const foldKey = s => fold(s).replace(/\s+/g, ' ').replace(/[.,;:!]+$/, '').trim()
// Depth-0 GFM task items only: a nested `  - [ ] reviewed` is never a task here (problems' parseProblemsBlock reports reviewed separately).
export const TASK_RE = /^[-*] \[( |x|X)\] (.*)$/gm
// → [{ done, text, line }], `line` = 0-based line number in `md`.
export const parseTasks = md => { const s = String(md || ''); return [...s.matchAll(TASK_RE)].map(m => ({ done: m[1] !== ' ', text: m[2], line: s.slice(0, m.index).split('\n').length - 1 })) }

// Local time with offset, e.g. 2026-09-08T16:02:11-04:00
export const isoNow = (d = new Date()) => {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-'
  const pad = n => String(Math.abs(n)).padStart(2, '0')
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}
