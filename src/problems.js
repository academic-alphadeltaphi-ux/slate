// The Problems block, as pure text rules (SPEC §20.2). Dependency-free and browser-safe, the src/grade.js
// pattern: the scripts (scripts/lib/problems.mjs), the server route and the client (ProblemsChip, the course
// screen, the plan) all read a `## Problems` container through these functions, so a row counts the same
// everywhere. Nothing here touches disk.
//
// A row is a GFM task with one nested task under it:
//   - [ ] Ch 1 #3 — [[2026-09-08 Plan for next week- Sep 15 + 17]]     the box is *attempted*
//     - [ ] reviewed                                                    the nested box is *reviewed*
//   - [ ] Fall-Ex1 · WebAssign · 17/20                                  a trailing n/m is a score
// The row's identity is its whole label, folded, minus a trailing score and minus ` · WebAssign` with whatever follows it
// (`ch 1 #3`, `problem set 1 · q3`, `Fall-Ex1 · WebAssign · 17/20` → `fall-ex1`): the itemised rows of a set are rows of
// their own beside the set's row. A solution is a separate container whose first line is `### Solution · <label>`; that
// marks the row *solved*.

export const HEADING = '## Problems'
export const REVIEWED = 'reviewed'
export const SOLUTION_RE = /^### Solution · (.+?)\s*$/

// fold + foldKey mirror server/format.js (which is not browser-safe): NFD, combining marks stripped, lowercased,
// whitespace collapsed, trailing punctuation dropped.
export const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
// The label without its trailing score, for display.
export const labelText = label => String(label || '').replace(/\s*·?\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*$/, '').trim()
// What names a row: the label minus its score and minus ` · WebAssign` and everything after it (a due day, a note — a set's
// identity is the set). `Problem Set 1 · Q3` keeps its ` · Q3`, so itemising a set adds one row per problem next to the set's.
export const identityText = label => labelText(label).replace(/\s*·\s*WebAssign\b.*$/i, '').trim()
export const keyOf = label => fold(identityText(label)).replace(/[.,;:!]+$/, '').trim()

const ROW = /^- \[( |x|X)\] (.+?)(?: — (.+))?$/
const NESTED = /^\s+[-*] \[( |x|X)\] (.+?)\s*$/
// The score sits at the end of the line, after a space or a `·`: ` · 17/20`, ` 8.5/10`.
const SCORE = /(?:^|[\s·])(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/
const isIndented = l => /^\s/.test(l)

export const scoreOf = text => { const m = SCORE.exec(String(text || '')); return m ? { got: Number(m[1]), of: Number(m[2]) } : null }

// parseProblemsBlock(md) → { intro: string[], rows: [{ key, label, src, line, raw, attempted, reviewed, score, extra: string[] }], tail: string[] }
// `line` is the 0-based line of the row inside `md`. Every line is kept somewhere — intro, a row's own line, its
// `extra` (the nested reviewed task, a stray note, blank lines up to the next row) or the tail — so
// [...intro, ...rows.flatMap(r => [r.raw, ...r.extra]), ...tail].join('\n') === md, byte for byte.
export function parseProblemsBlock(md) {
  const lines = String(md || '').split('\n')
  const intro = [], rows = [], tail = []
  let i = 0
  while (i < lines.length && !ROW.test(lines[i])) intro.push(lines[i++])
  while (i < lines.length) {
    const m = ROW.exec(lines[i])
    if (!m) break
    const row = { key: keyOf(m[2]), label: m[2], src: m[3] ?? null, line: i, raw: lines[i], attempted: m[1] !== ' ', reviewed: false, score: scoreOf(lines[i]), extra: [] }
    rows.push(row)
    // Continuation: every line up to the next row. After the last row only the indented run (blank lines allowed
    // inside it, trailing blanks excluded) belongs to the row; the rest is the tail.
    let j = i + 1
    while (j < lines.length && !ROW.test(lines[j])) j++
    let end = j
    if (j >= lines.length) {
      end = i + 1
      while (end < lines.length && (isIndented(lines[end]) || lines[end].trim() === '')) end++
      while (end > i + 1 && lines[end - 1].trim() === '') end--
    }
    for (let k = i + 1; k < end; k++) { const n = NESTED.exec(lines[k]); if (n && fold(n[2]) === REVIEWED) row.reviewed = n[1] !== ' '; row.extra.push(lines[k]) }
    i = end
    if (j >= lines.length) break
  }
  while (i < lines.length) tail.push(lines[i++])
  return { intro, rows, tail }
}

// renderRow({ label, src }) → the two lines of a fresh row.
export function renderRow(r) {
  const label = String(r.label || '').trim()
  return `- [ ] ${label}${r.src ? ' — ' + String(r.src).trim() : ''}\n  - [ ] ${REVIEWED}`
}

// mergeRows(md, wanted) → { md, added: [labels] }. Append-only: a wanted row whose key is absent is added after
// the last existing row (after the whole block when there is no list yet); every existing line is reproduced
// byte for byte. Idempotent: mergeRows(mergeRows(md, w).md, w).added.length === 0.
export function mergeRows(md, wanted) {
  const p = parseProblemsBlock(md)
  const have = new Set(p.rows.map(r => r.key))
  const fresh = []
  for (const w of wanted || []) {
    const k = keyOf(w?.label)
    if (!k || have.has(k)) continue
    have.add(k); fresh.push(w)
  }
  if (!fresh.length) return { md: String(md || ''), added: [] }
  const rendered = fresh.map(renderRow).join('\n')
  let out
  if (!p.rows.length) {
    const head = String(md || '').replace(/\s+$/, '')
    out = head ? `${head}\n\n${rendered}` : `${HEADING}\n\n${rendered}`
  } else {
    const body = [...p.intro, ...p.rows.flatMap(r => [r.raw, ...r.extra])]
    out = [...body, ...rendered.split('\n'), ...p.tail].join('\n')
  }
  return { md: out, added: fresh.map(w => String(w.label).trim()) }
}

const firstLine = md => (String(md || '').split('\n').find(l => l.trim() !== '') || '').trimEnd()
// findProblemsBlock(blocks, blockId) → the index of the block with that id, else the first whose first line is
// `## Problems`, else -1.
export function findProblemsBlock(blocks, blockId) {
  const list = Array.isArray(blocks) ? blocks : []
  if (blockId) { const i = list.findIndex(b => b?.id === blockId); if (i >= 0) return i }
  return list.findIndex(b => firstLine(b?.md) === HEADING)
}
// solvedKeys(blocks) → Set of keyOf(label) for every block whose first line is `### Solution · <label>`.
export function solvedKeys(blocks) {
  const out = new Set()
  for (const b of Array.isArray(blocks) ? blocks : []) { const m = SOLUTION_RE.exec(firstLine(b?.md)); if (m) out.add(keyOf(m[1])) }
  return out
}
// The heading a solution container must start with for `label`'s row to count as solved: the row's whole identity
// (`### Solution · Problem Set 1 · Q3`; a WebAssign row's is its set, `### Solution · Fall-Ex1`).
export const solutionHeading = label => `### Solution · ${identityText(label)}`

// counts(rows, solved) → { assigned, attempted, reviewed, solved }
export function counts(rows, solved = new Set()) {
  const list = Array.isArray(rows) ? rows : []
  return { assigned: list.length, attempted: list.filter(r => r.attempted).length, reviewed: list.filter(r => r.reviewed).length, solved: list.filter(r => solved.has(r.key)).length }
}
// Everything the chip and the course screen want from a page's blocks in one call.
export function summarizeBlocks(blocks, blockId) {
  const i = findProblemsBlock(blocks, blockId)
  const rows = i < 0 ? [] : parseProblemsBlock(blocks[i].md).rows
  const solved = solvedKeys(blocks)
  return { blockIndex: i, blockId: i < 0 ? null : blocks[i].id || null, rows: rows.map(r => ({ ...r, solved: solved.has(r.key) })), solved, counts: counts(rows, solved) }
}
// A set is one row (`Fall-Ex1 · WebAssign`, `Problem Set 1 — [[…]]`) until it is itemised (`Problem Set 1 · Q3`).
const SET_RE = /\bwebassign\b|\b(?:problem|exercise|practice|homework|question)\s*sets?\b|\bpset\b|\bassignment\b|\b(?:fall|winter)-ex\d+\b/i
export function rowKind(label) {
  const parts = String(label || '').split(' · ')
  if (/webassign/i.test(label)) return 'set'
  return parts.length === 1 && SET_RE.test(parts[0]) ? 'set' : 'problem'
}
// withRowState(md, key, { attempted?, reviewed? }) → the block with that row's box and its nested `reviewed` box set (a
// missing `reviewed` line is added under the row when it is set), or null when the row is gone. The screens tick rows
// one click at a time with this (SPEC §20.32); `toggleMdTask` cannot, because every row's nested line is the same text.
export function withRowState(md, key, state = {}) {
  const lines = String(md || '').split('\n')
  const r = parseProblemsBlock(md).rows.find(x => x.key === key)
  if (!r) return null
  const box = (l, on) => l.replace(/^(\s*[-*] \[)[ xX](\])/, `$1${on ? 'x' : ' '}$2`)
  if (state.attempted != null) lines[r.line] = box(lines[r.line], state.attempted)
  if (state.reviewed != null) {
    const i = r.extra.findIndex(l => { const n = NESTED.exec(l); return n && fold(n[2]) === REVIEWED })
    if (i >= 0) lines[r.line + 1 + i] = box(lines[r.line + 1 + i], state.reviewed)
    else if (state.reviewed) lines.splice(r.line + 1, 0, `  - [x] ${REVIEWED}`)
  }
  return lines.join('\n')
}

// ---- sets: the questions, their solutions, and the guide beside them (SPEC §20.32) --------------------------------
// Quercus posts one problem set as two files — `ECO206_Problem_Set_1_Questions.pdf` and `…_Questions_and_Solutions.pdf`
// — and every screen listed them as two unrelated documents, so the one thing you work through read as a pile of
// near-identical names. A set is the questions and the solutions *together*: one card, one row in the library, with the
// solutions one button away. Matching is by name, because the name is all two uploads share: the course prefix and the
// role words (`questions`, `and solutions`, `answers`, `answer key`) are stripped and what remains is the set.
const COURSE_PREFIX = /^[a-z]{3}\s?\d{3}[a-z]?\d?\s+/i                       // 'ECO206 ', 'ECO 206 ', 'ECO206Y1 '
export const SOLUTIONS_RE = /\b(?:solutions?|answers?|answer key|marking scheme)\b/i
// A method for the problems rather than problems: filed with them, drawn as a guide, never counted as a set.
export const GUIDE_RE = /\b(?:problem[- ]solving (?:steps|guide|approach|process|strategies)|how to (?:solve|approach|attempt))\b/i
const plainName = t => String(t || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '').trim()
export const docRole = title => (GUIDE_RE.test(plainName(title)) ? 'guide' : SOLUTIONS_RE.test(plainName(title)) ? 'solutions' : 'questions')
// 'ECO206_Problem_Set_1_Questions_and_Solutions' → 'Problem Set 1'; 'ECO206_Tutorial_1_Questions' → 'Tutorial 1'.
export function setName(title) {
  const s = plainName(title).replace(COURSE_PREFIX, '')
    .replace(/\s*[-–—:]?\s*\(?\b(?:questions?\s*(?:and|&|\+)\s*)?(?:solutions?|answers?|answer key|marking scheme)\)?\s*$/i, '')
    .replace(/\s*[-–—:]?\s*\(?\bquestions?\)?\s*$/i, '')
    .trim()
  return s || plainName(title)
}
export const setKey = title => fold(setName(title))
// What the card says under the name.
export const setSays = s => (s.role === 'guide' ? 'how to work through the problems' : s.questions && s.solutions ? 'questions + solutions' : s.solutions ? 'solutions only' : 'questions only')
// pairSets(docs) → [{ key, name, role: 'set'|'guide', questions, solutions, guide, extra, main, label }], sets in the order
// their first document came, guides after them. `docs` are anything with a `title` (pages, library rows, week items).
export function pairSets(docs) {
  const groups = new Map()
  for (const d of Array.isArray(docs) ? docs : []) {
    const role = docRole(d?.title)
    const key = role === 'guide' ? 'guide:' + fold(plainName(d.title)) : setKey(d.title)
    if (!groups.has(key)) groups.set(key, { key, name: role === 'guide' ? plainName(d.title).replace(COURSE_PREFIX, '') : setName(d.title), role: role === 'guide' ? 'guide' : 'set', questions: null, solutions: null, guide: null, extra: [] })
    const g = groups.get(key)
    if (role === 'guide') { if (!g.guide) g.guide = d; else g.extra.push(d) }
    else if (!g[role]) g[role] = d
    else g.extra.push(d)
  }
  const all = [...groups.values()].map(g => ({ ...g, main: g.questions || g.solutions || g.guide, label: g.role === 'set' && g.solutions ? `${g.name} (${g.questions ? 'questions + solutions' : 'solutions'})` : g.name }))
  return [...all.filter(g => g.role === 'set'), ...all.filter(g => g.role === 'guide')]
}
// attachRows(sets, rows) → { sets: [...each with rows: [{ ...row, part }]], loose: [rows no set claims] }. A row belongs to a set
// when its wikilink names one of the set's documents (`[[ECO206_Problem_Set_1_Questions]]`), or when the head of its label
// is the set's name (`Problem Set 1 · Q3`). `part` is the rest of the label (`Q3`), or `All` for the set's own row.
export function attachRows(sets, rows) {
  const out = (sets || []).map(s => ({ ...s, rows: [] }))
  const byDoc = new Map(), byName = new Map()
  for (const s of out) {
    if (s.role === 'guide') continue
    byName.set(s.key, s)
    for (const d of [s.questions, s.solutions, ...(s.extra || [])].filter(Boolean)) byDoc.set(fold(d.title), s)
  }
  const loose = []
  for (const r of rows || []) {
    const label = labelText(r.label), parts = label.split(' · ')
    const doc = r.source?.title ? String(r.source.title).split('/').pop() : null
    const s = (doc && byDoc.get(fold(doc))) || byName.get(setKey(parts[0]))
    if (!s) { loose.push(r); continue }
    s.rows.push({ ...r, part: parts.length > 1 ? parts.slice(1).join(' · ') : 'All' })
  }
  return { sets: out, loose }
}

// withScore(line, got, of) → the row line with ` · got/of` at its end (an earlier score replaced). Pure: the course
// screen writes the result through PUT /api/page with the base hash.
export function withScore(line, got, of) {
  const base = String(line || '').replace(/\s*·?\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*$/, '').replace(/\s+$/, '')
  return got == null || of == null ? base : `${base} · ${got}/${of}`
}

// ---- rows from prose (SPEC §20.3) ---------------------------------------------------------------------------
// extractProblemRefs(text) → { refs: [{ label, chapter, n, sentence, paragraph }], issues: [{ sentence, paragraph, reason }] }
// Paragraphs are split on blank lines, sentences on . ! ? (not after Ch. / Ex. / No. / p.). Only sentences that talk
// about problems are scanned:
//   CH       "Ch 1 #3, 4 and Ch 2 #2, 8" → Ch 1 #3, Ch 1 #4, Ch 2 #2, Ch 2 #8 ('and Ch' ends a list: C is not a digit)
//   RANGE    "questions 1–4 of chapter 3" → Ch 3 #1 … Ch 3 #4 (a–b expanded when b − a ≤ 15)
//   SECTION  "exercises 2.1, 2.3" → Ex 2.1, Ex 2.3
//   BARE     "problems 3 and 5" → Problem 3, Problem 5 (only when the sentence has no CH match)
// A lead-in that promises problems ("Problems for discussion are …", "tutorial problems:") with nothing tokenisable
// becomes an issue for the plan, never a dropped sentence. Dates are left to the caller (terms.mjs).
const SCAN = /problem|question|exercise|tutorial|discussion|practice|homework/i
const LEAD_IN = /\b(?:problems?|questions?|exercises?)\s*(?:for|to|are|will be|:)|\b(?:tutorial|practice|discussion)\s+(?:problems?|questions?)\b|\bproblems?\s+(?:for\s+)?discussion\b/i
const ITEM = '\\d+[a-z]?(?:\\s*[–\\-]\\s*\\d+[a-z]?)?'
const LIST = `(?:${ITEM})(?:\\s*(?:,|and|&)\\s*#?\\s*(?:${ITEM}))*`
const CH = new RegExp(`\\bch(?:apter)?\\.?\\s*(\\d+)\\s*(?:#|problems?|questions?|exercises?|q\\.?)?\\s*#?\\s*(${LIST})`, 'gi')
const SECTION = /\bexercises?\s+((?:\d+\.\d+)(?:\s*(?:,|and|&)\s*\d+\.\d+)*)/gi
const BARE = new RegExp(`\\b(?:problems?|questions?|exercises?)\\s+#?\\s*(${LIST})(?:\\s+(?:of|from|in)\\s+ch(?:apter)?\\.?\\s*(\\d+))?`, 'gi')
const SENTENCE_SPLIT = /(?<=[.!?])(?<!\b(?:ch|chap|ex|no|q|p|pp|sec|vs|fig|eq)\.)\s+/i

function expandList(list) {
  const out = []
  for (const part of String(list).split(/\s*(?:,|and|&)\s*/i)) {
    const item = part.replace(/^#\s*/, '').trim()
    if (!item) continue
    const r = /^(\d+)([a-z]?)\s*[–-]\s*(\d+)([a-z]?)$/i.exec(item)
    if (r) {
      const a = Number(r[1]), b = Number(r[3])
      if (b >= a && b - a <= 15) { for (let k = a; k <= b; k++) out.push(String(k)) }
      else out.push(item)
      continue
    }
    out.push(item)
  }
  return out
}
export function extractProblemRefs(text) {
  const refs = [], issues = [], seen = new Set()
  const push = r => { const k = keyOf(r.label); if (seen.has(k)) return; seen.add(k); refs.push(r) }
  for (const paragraph of String(text || '').split(/\n\s*\n|\n(?=\s*[-*] )/)) {
    for (const raw of paragraph.split(SENTENCE_SPLIT)) {
      const sentence = raw.replace(/\s+/g, ' ').trim()
      if (!sentence || !SCAN.test(sentence)) continue
      let found = 0, ch = 0
      for (const m of sentence.matchAll(CH)) { for (const n of expandList(m[2])) { push({ label: `Ch ${m[1]} #${n}`, chapter: Number(m[1]), n, sentence, paragraph: paragraph.trim() }); found++; ch++ } }
      for (const m of sentence.matchAll(SECTION)) { for (const s of m[1].split(/\s*(?:,|and|&)\s*/i)) if (s.trim()) { push({ label: `Ex ${s.trim()}`, chapter: Number(s.split('.')[0]), n: s.trim(), sentence, paragraph: paragraph.trim() }); found++ } }
      if (!ch) {
        const rest = sentence.replace(SECTION, ' ')   // "exercises 2.1" is a section, not problem 2
        for (const m of rest.matchAll(BARE)) {
          for (const n of expandList(m[1])) { push(m[2] ? { label: `Ch ${m[2]} #${n}`, chapter: Number(m[2]), n, sentence, paragraph: paragraph.trim() } : { label: `Problem ${n}`, chapter: null, n, sentence, paragraph: paragraph.trim() }); found++ }
        }
      }
      if (!found && LEAD_IN.test(sentence)) issues.push({ sentence, paragraph: paragraph.trim(), reason: 'no problem numbers found' })
    }
  }
  return { refs, issues }
}

// webassignLabel(set) → `Fall-Ex1 · WebAssign`. Row labels never carry a date (SPEC §20.12: the cadence is
// unconfirmed); the due date lives in Hub/_problems.json and hub.deadlines.
export const webassignLabel = set => `${String(set).trim()} · WebAssign`
