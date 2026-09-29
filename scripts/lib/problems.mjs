// The disk and calendar half of Problems (SPEC §20.2): where rows come from per course, the WebAssign calendar and
// the page-typed scores for quercus-sync, page ownership and the append-only merge on disk, and the summary that
// becomes Hub/_problems.json and the GET /api/problems response. The text rules live in src/problems.js.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { COURSES, TERMS, WEEK_PAGES, weeks, weekFor, localStamp, short, todayIso } from './terms.mjs'
import { SYLLABUS } from './syllabus.mjs'
import { shortBookName } from './textbook.mjs'
import { parsePage, joinPage, newId } from '../../server/format.js'
import { expandMeetings, syllabusWeekN, addDays, daysTo } from '../../src/calendar.js'
import { HEADING, keyOf, mergeRows, findProblemsBlock, summarizeBlocks, extractProblemRefs, webassignLabel, rowKind, counts as countRows } from '../../src/problems.js'
import { findPlanBlock, planTasks, mentions, taskWords } from '../../src/plan.js'
import { REAL_WIN } from './platform.mjs'

export const sha1 = t => crypto.createHash('sha1').update(String(t)).digest('hex')
export const PROBLEMS_JSON = root => path.join(root, 'Hub', '_problems.json')
export const pageRel = (courseKey, week) => `${courseKey}/${week.dir}/Problems.md`
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
export const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
const readText = async p => { try { return await fs.readFile(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const listMd = async dir => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_') && !e.name.startsWith('.')).map(e => e.name.slice(0, -3))
const dayOf = iso => new Date(iso + 'T12:00:00')

// Atomic write like server/fs.js: `.tmp-<name>-<hex>` in the same folder, then rename. The watcher ignores the
// temp name and broadcasts the rename as an external change, which is what refreshes an open clean page. On Windows
// the rename is tried again for ~1.5 s when OneDrive or Defender holds the page open for a moment (EPERM, EBUSY, EACCES).
export async function writeAtomic(file, text) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${crypto.randomBytes(4).toString('hex')}`)
  await fs.writeFile(tmp, text)
  for (let i = 0; ; i++) {
    try { return await fs.rename(tmp, file) }
    catch (e) { if (!REAL_WIN || i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 50 * 2 ** i)) }
  }
}

// The textbook as the header names it: "Wackerly … (WMS) · WebAssign" → "WMS"; "Williamson, Macroeconomics, 7th Canadian ed." as is.
export function textbookShort(courseKey) {
  const t = String(COURSES[courseKey]?.textbook || '').split(' · ')[0].trim()
  const abbr = /\(([A-Z]{2,6})\)/.exec(t)
  return abbr ? abbr[1] : t
}

// ---- WebAssign calendar (feature 6) ---------------------------------------------------------------------------
export const webassignConfig = courseKey => SYLLABUS[courseKey]?.webassign || null
// Every syllabus week with a non-empty `problems` is a set: posts = Monday + postsDay, due = posts + dueDays at dueTime.
// → [{ set, n, week, weekDir, monday, posts, due, dueAt, topic, page, confirmed }]
export function webassignSets(courseKey) {
  const cfg = webassignConfig(courseKey), syl = SYLLABUS[courseKey]?.weeks, info = COURSES[courseKey]
  if (!cfg || !syl || !info) return []
  const wks = weeks(info.term), out = []
  for (const [n, wk] of Object.entries(syl)) {
    const set = String(wk.problems || '').trim(); if (!set) continue
    const w = wks[Number(n) - 1]; if (!w) continue
    const posts = addDays(w.monday, cfg.postsDay ?? 4), due = addDays(posts, cfg.dueDays ?? 7)
    const dueAt = localStamp(new Date(`${due}T${cfg.dueTime || '23:59'}:00`))
    out.push({ set, n: w.n, week: w.label, weekDir: w.dir, monday: w.monday, posts, due, dueAt, topic: wk.topic || null, page: pageRel(courseKey, w), confirmed: !!cfg.confirmed })
  }
  return out
}
// The state of every set's row on its Problems page: Map set → { attempted, reviewed, score, line, page } (missing page → no entry).
export async function webassignRows(courseKey, root) {
  const out = new Map()
  const reg = await readJson(PROBLEMS_JSON(root), {})
  for (const s of webassignSets(courseKey)) {
    const text = await readText(path.join(root, s.page)); if (text === null) continue
    const { rows } = summarizeBlocks(parsePage(text).blocks, reg.pages?.[s.page]?.blockId)
    const r = rows.find(x => x.key === keyOf(s.set)); if (!r) continue
    out.set(s.set, { attempted: r.attempted, reviewed: r.reviewed, score: r.score, line: r.line, page: s.page })
  }
  return out
}
// The ticked lines of every Plan page of a course, as their words before the arrow (SPEC §20.69): a set is done when any of
// them names it — the task may sit in the week the set is for, or in the week Claude put it.
export async function tickedPlanLines(courseKey, root) {
  const info = COURSES[courseKey]; if (!info) return []
  const out = []
  for (const w of weeks(info.term)) {
    const text = await readText(path.join(root, courseKey, w.dir, 'Plan.md')); if (text === null) continue
    const blocks = parsePage(text).blocks, i = findPlanBlock(blocks, null); if (i < 0) continue
    out.push(...planTasks(blocks[i].md).filter(t => t.done).map(t => taskWords(t.text)))
  }
  return out
}
// hub.deadlines rows for the sets that are live today: from the Monday of the set's week until its due date, gone the
// moment its row is ticked — on the Problems page, or a task naming the set on any Plan page. Quercus wins when it lists
// the same set (quercus-sync checks that before pushing these).
// Until `syllabus.webassign.confirmed`, the row carries the week and no time (`dueTime: null`, `confirmed: false`);
// `due` keeps a local end-of-day stamp so the rows sort and count days like the Quercus ones.
export async function webassignDeadlines(courseKey, root, today = todayIso()) {
  const info = COURSES[courseKey], cfg = webassignConfig(courseKey)
  if (!info || !cfg) return []
  const rows = await webassignRows(courseKey, root)
  const ticked = await tickedPlanLines(courseKey, root)
  const out = []
  for (const s of webassignSets(courseKey)) {
    if (!(s.monday <= today && today <= s.due)) continue
    const r = rows.get(s.set)
    if (r?.attempted || ticked.some(l => mentions(l, s.set))) continue
    out.push({
      course: info.code, courseKey, set: s.set, week: s.week, page: s.page,
      title: s.confirmed ? `WebAssign ${s.set}${s.topic ? ' · ' + s.topic : ''}` : `WebAssign ${s.set} · week of ${short(dayOf(s.monday))} · date unconfirmed`,
      due: s.dueAt, dueDate: s.due, dueTime: s.confirmed ? (cfg.dueTime || '23:59') : null, confirmed: s.confirmed, posts: s.posts,
      points: null, url: cfg.url || null, submitted: false, score: r?.score ? (100 * r.score.got) / r.score.of : null, gradedAt: null,
      daysLeft: daysTo(s.due, today), source: 'syllabus',
    })
  }
  return out
}
// The page-typed scores as the grade model wants them: avg = mean of 100·got/of over scored sets (null when none).
// banked = bonus × Σ pct / count (what is already earned, in grade points); onPace = bonus × avg (what src/grade.js projects).
export async function webassignScores(courseKey, root) {
  const info = COURSES[courseKey], cfg = webassignConfig(courseKey)
  if (!info || !cfg) return null
  const bonus = info.grading?.components?.find(c => c.key === 'webassign')?.bonus ?? 0.1
  const rows = await webassignRows(courseKey, root)
  const sets = webassignSets(courseKey).map(s => { const r = rows.get(s.set) || null; return { set: s.set, n: s.n, week: s.week, posts: s.posts, due: s.due, confirmed: s.confirmed, page: s.page, listed: !!r, attempted: !!r?.attempted, reviewed: !!r?.reviewed, score: r?.score || null } })
  const scored = sets.filter(s => s.score && s.score.of > 0)
  const pcts = scored.map(s => (100 * s.score.got) / s.score.of)
  const sum = pcts.reduce((a, b) => a + b, 0), count = sets.length
  const avg = pcts.length ? sum / pcts.length : null
  return { count, listed: sets.filter(s => s.listed).length, scored: scored.length, sum, avg, bonus, banked: count ? (bonus * sum) / count : 0, onPace: avg == null ? null : bonus * avg, url: cfg.url || null, confirmed: !!cfg.confirmed, sets }
}

// ---- sources (feature 4) ---------------------------------------------------------------------------------------
// The abbreviation or the full name, and nothing in between: `(mar)[a-z]*` also matched "Mark", and `(may)[a-z]*`
// matched "Maybe", so "Mark 3 of the questions" filed four problem rows onto the week of 3 March (SPEC §20.20).
const MONTH_WORDS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const MONTHS_RE = new RegExp(String.raw`\b(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(${MONTH_WORDS})\.?\s+(\d{1,2})\b`, 'i')
const DAYS_IN = { 1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 }
const MONTH_N = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
// The first "September 15" in a text as an ISO date, the year from the term calendar (Aug–Dec → fall, else winter).
export function dateIn(text) {
  const m = MONTHS_RE.exec(String(text || '')); if (!m) return null
  // 'may' and 'march' are also ordinary verbs: "you may 5 attempts" is not a date, "May 5" is. For those two the
  // capital is the only signal English gives, so require it.
  if (/^(may|mar(ch)?)$/i.test(m[1]) && m[1][0] !== m[1][0].toUpperCase()) return null
  const mo = MONTH_N[m[1].toLowerCase().slice(0, 4)] ?? MONTH_N[m[1].toLowerCase().slice(0, 3)], d = Number(m[2])
  if (!mo || d < 1 || d > DAYS_IN[mo]) return null   // 'Feb 31' is not a date; JS used to roll it to 3 March
  const y = mo >= 8 ? TERMS.FALL.start.slice(0, 4) : TERMS.WINTER.start.slice(0, 4)
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
const SET_FILE_RE = /problem\s*set|exercises?|tutorial|pset|homework|practice/i
const SET_LINK_RE = /problem\s*set|exercises?|practice|tutorial\s*(?:questions|problems)|pset/i
const stripExt = s => String(s || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim()
const bodyOf = parsed => parsed.blocks.map(b => b.md).join('\n\n')
const concernsWeek = (text, wks) => { const m = /Concerns \[\[(Week \d+ \([^)]*\))\]\]/.exec(text); return m ? wks.find(w => w.label === m[1]) || null : null }
const weekOfDate = (term, iso) => (iso ? weekFor(term, iso) : null)
// Where an announcement lands when nothing in it names a week: the week it was posted, or week 1 for the welcome posts sent before the first Monday.
const postedWeek = (term, wks, posted) => weekOfDate(term, posted) || (posted && wks.length && posted < wks[0].monday ? wks[0] : null)

function planFor(map, w) {
  if (!map.has(w.n)) map.set(w.n, { n: w.n, week: w, topic: null, sourceLabel: null, readLine: null, noteLine: null, rows: [], issues: [], kinds: new Set() })
  return map.get(w.n)
}
const addRow = (plan, row) => { const k = keyOf(row.label); if (!k || plan.rows.some(r => keyOf(r.label) === k)) return; plan.rows.push(row) }

// assignedFor(courseKey, root) → Map weekN → { n, week, topic, sourceLabel, readLine, noteLine, rows: [{ label, src, kind, source, due }], issues }
//   syllabus (ECO227): one `set` row per WebAssign set, the reading line from `chapters`; header-only weeks get a plan with no rows.
//   announcements (any course): every <Course>/Announcements/Announcements/*.md; refs from extractProblemRefs land in the week of the
//     date in their sentence or paragraph, else the announcement's first `Concerns [[Week …]]`, else the week it was posted; a file the
//     announcement carries whose name looks like a set is one `set` row.
//   topic pages (ECO206, any course): every synced Quercus page in a week folder (tags quercus + page): problem-set links → `set` rows,
//     problem phrases → `problem` rows; a synced file page under Lectures/ whose title looks like a set → `set` row.
export async function assignedFor(courseKey, root) {
  const info = COURSES[courseKey]; if (!info) return new Map()
  const wks = weeks(info.term), plans = new Map()
  // syllabus
  const syl = SYLLABUS[courseKey]?.weeks || {}
  const sets = new Map(webassignSets(courseKey).map(s => [s.n, s]))
  for (const [n, wk] of Object.entries(syl)) {
    if (wk.chapters === undefined) continue
    const w = wks[Number(n) - 1]; if (!w) continue
    const plan = planFor(plans, w)
    plan.topic = wk.topic || plan.topic; plan.sourceLabel = 'from the course outline'; plan.kinds.add('syllabus')
    plan.readLine = wk.chapters ? `- **Read** ${shortBookName(info.textbook, 'the textbook')} ${wk.chapters}` : null
    const s = sets.get(w.n)
    if (s) { addRow(plan, { label: webassignLabel(s.set), src: null, kind: 'set', source: { kind: 'syllabus', page: null, title: null }, due: s.due, set: s.set }); plan.noteLine = NOTE_LINE }
  }
  // announcements
  const annDir = path.join(root, courseKey, 'Announcements', 'Announcements')
  for (const title of (await listMd(annDir)).sort()) {
    const rel = `${courseKey}/Announcements/Announcements/${title}.md`
    const text = await readText(path.join(annDir, title + '.md')); if (text === null) continue
    const parsed = parsePage(text), lines = bodyOf(parsed).split('\n')
    const metaAt = lines.findIndex(l => /^_\d{4}-\d{2}-\d{2} · .*_$/.test(l.trim()))
    const body = lines.slice(metaAt >= 0 ? metaAt + 1 : 0).filter(l => !/^Concerns \[\[/.test(l.trim())).join('\n')
    const posted = String(parsed.frontmatter?.created || (/^(\d{4}-\d{2}-\d{2})/.exec(title)?.[1] || '')).slice(0, 10)
    const fallback = concernsWeek(text, wks) || postedWeek(info.term, wks, posted)
    const { refs, issues } = extractProblemRefs(body)
    for (const r of refs) {
      const date = dateIn(r.sentence) || dateIn(r.paragraph)
      const w = weekOfDate(info.term, date) || fallback; if (!w) continue
      const plan = planFor(plans, w)
      plan.kinds.add('announcement'); plan.sourceLabel ||= 'from announcements'
      addRow(plan, { label: r.label, src: `[[${title}]]`, kind: 'problem', source: { kind: 'announcement', page: rel, title }, due: date && weekOfDate(info.term, date) ? date : null })
    }
    for (const is of issues) {
      const w = weekOfDate(info.term, dateIn(is.sentence) || dateIn(is.paragraph)) || fallback
      const issue = { courseKey, course: info.code, page: rel, title, sentence: is.sentence, reason: is.reason, week: w?.label || null }
      if (w) planFor(plans, w).issues.push(issue); else plans.set(`issue:${rel}:${plans.size}`, { issues: [issue], rows: [], unplaced: true })
    }
    const sidecar = await readJson(path.join(annDir, title + '.blocks.json'), null)
    for (const el of sidecar?.elements || []) {
      const name = path.posix.basename(String(el.src || '')); if (!name || !SET_FILE_RE.test(name)) continue
      const w = fallback; if (!w) continue
      const plan = planFor(plans, w); plan.kinds.add('announcement'); plan.sourceLabel ||= 'from announcements'
      addRow(plan, { label: stripExt(name), src: `[[${title}]]`, kind: 'set', source: { kind: 'announcement', page: rel, title }, due: null })
    }
  }
  // topic pages and set-like file pages in the week folders
  for (const w of wks) {
    const dir = path.join(root, courseKey, w.dir)
    for (const title of await listMd(dir)) {
      if (title === 'Problems' || title === 'Plan') continue
      const text = await readText(path.join(dir, title + '.md')); if (text === null) continue
      const parsed = parsePage(text), tags = Array.isArray(parsed.frontmatter?.tags) ? parsed.frontmatter.tags.map(String) : []
      if (!tags.includes('quercus') || !tags.includes('page')) continue
      const rel = `${courseKey}/${w.dir}/${title}.md`, body = bodyOf(parsed)
      const found = []
      for (const m of body.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) if (SET_LINK_RE.test(m[1]) || SET_LINK_RE.test(decodeURIComponent(m[2].split('/').pop() || ''))) found.push({ label: stripExt(m[1]), src: `[[${title}]]`, kind: 'set', source: { kind: 'quercus-page', page: rel, title }, due: null })
      const { refs, issues } = extractProblemRefs(body)
      for (const r of refs) found.push({ label: r.label, src: `[[${title}]]`, kind: 'problem', source: { kind: 'quercus-page', page: rel, title }, due: null })
      if (!found.length && !issues.length) continue
      const plan = planFor(plans, w)
      plan.kinds.add('quercus-page'); if (!plan.kinds.has('syllabus')) { plan.topic = title; plan.sourceLabel = 'from the Quercus topic page' }
      for (const r of found) addRow(plan, r)
      for (const is of issues) plan.issues.push({ courseKey, course: info.code, page: rel, title, sentence: is.sentence, reason: is.reason, week: w.label })
    }
    const lecDir = path.join(dir, 'Lectures')
    for (const title of await listMd(lecDir)) {
      if (!SET_FILE_RE.test(title)) continue
      const text = await readText(path.join(lecDir, title + '.md')); if (text === null) continue
      const tags = Array.isArray(parsePage(text).frontmatter?.tags) ? parsePage(text).frontmatter.tags.map(String) : []
      if (!tags.includes('quercus')) continue
      const plan = planFor(plans, w); plan.kinds.add('quercus-page'); plan.sourceLabel ||= 'from the Quercus files'
      addRow(plan, { label: title, src: `[[${title}]]`, kind: 'set', source: { kind: 'quercus-page', page: `${courseKey}/${w.dir}/Lectures/${title}.md`, title }, due: null })
    }
  }
  for (const [k, plan] of plans) { if (plan.unplaced) continue; plan.topic ||= 'Tutorial problems'; plan.sourceLabel ||= 'from announcements'; delete plan.kinds }
  return plans
}

// ---- pages ------------------------------------------------------------------------------------------------------
// The header block: title, the meta line, the reading line, the score-syntax line (WebAssign weeks).
export const NOTE_LINE = '_Tick the set once attempted, its reviewed line after the tutorial; type the mark at the end of its row as · 17/20._'
export function buildHeader(courseKey, week, plan) {
  const parts = [`# ${plan.topic || 'Tutorial problems'}`, `_${week.label} · ${plan.sourceLabel || 'from announcements'} · ${textbookShort(courseKey)}_`]
  if (plan.readLine) parts.push(plan.readLine)
  if (plan.noteLine) parts.push(plan.noteLine)
  return parts.join('\n\n')
}
// Edit frontmatter keys line by line so every other byte of the header survives (server/fs.js patchFrontmatter, without the store).
export function patchFrontmatterRaw(raw, patch) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw || '')
  const lines = m && m[1].trim() ? m[1].split(/\r?\n/) : []
  const yaml = v => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(String(x))).join(', ')}]` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)))
  for (const [k, v] of Object.entries(patch || {})) {
    const idx = lines.findIndex(l => l.startsWith(k + ':'))
    if (idx >= 0) { let n = 1; while (idx + n < lines.length && /^\s/.test(lines[idx + n])) n++; lines.splice(idx, n) }
    const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
    if (!empty) lines.splice(idx >= 0 ? idx : lines.length, 0, `${k}: ${yaml(v)}`)
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n` : ''
}
// looksGenerated(md) → the block is a header this script or the pre-v0.7 seed wrote and nothing more: `# <title>`, a blank line,
// `_<week> · from the course outline[ · WMS]_` (or `from announcements`, `from the Quercus topic page`, `from the Quercus files`,
// `itemised by the morning pass`), then only blank lines, `- **Read** …`, the seed's `- **WebAssign** …` line, the note line or
// `_Nothing assigned this week._`. One line of anything else is the student's, and the whole block with it.
const META_LINE = /^_.+ · (?:from (?:the course outline|announcements|the Quercus topic page|the Quercus files)|itemised by the morning pass)(?: · .+)?_$/
const KNOWN_LINE = /^- \*\*(?:Read|WebAssign)\*\* \S/
export function looksGenerated(md) {
  const lines = String(md || '').replace(/\s+$/, '').split('\n')
  if (lines.length < 3 || !/^# \S/.test(lines[0]) || lines[1].trim() !== '' || !META_LINE.test(lines[2])) return false
  return lines.slice(3).every(l => l.trim() === '' || KNOWN_LINE.test(l) || l === NOTE_LINE || l === '_Nothing assigned this week._')
}
const freshId = blocks => { let id; do id = newId(); while (blocks.some(b => b.id === id)); return id }
// The week folder's _slate.json order gains 'Problems' once (the standard week pages first when the file is new).
async function ensureOrder(dir, name, dry) {
  const file = path.join(dir, '_slate.json')
  const meta = await readJson(file, null)
  if (Array.isArray(meta?.order) && meta.order.includes(name)) return false
  const order = Array.isArray(meta?.order) ? [...meta.order] : []
  if (!order.length) { const have = await listMd(dir); for (const [t] of WEEK_PAGES) if (have.includes(t)) order.push(t) }
  order.push(name)
  if (!dry) await writeAtomic(file, JSON.stringify({ ...(meta || {}), order }, null, 2) + '\n')
  return true
}

// applyToPage({ root, courseKey, week, plan, registry, dry, keepHeader }) → { page, created, headerRewritten, added, blockId, changed, skipped }
// Header (block 0) is the script's on a page it creates, while block 0 is blank, while its hash is the one recorded in
// registry.pages[page].headerHash, or — on a page the registry has never seen — while it looksGenerated (how the 24 pre-v0.7 seeded
// ECO227 pages were adopted, and how a rebuilt registry re-adopts the script's own headers). A recorded hash that no longer matches
// means the student edited the header: it is his from then on, whatever it looks like. Anchors play no part: a page the student started in the app
// is one anonymous container, and that container is his text. Exactly one anchored block starts with `## Problems` (found by id, then
// by heading, created at the end when rows exist) and is merged append-only. Frontmatter keeps its bytes except `kind: "problem-set"`
// and `problems` added to `tags`. A page is created only when there is at least one row.
export async function applyToPage({ root, courseKey, week, plan, registry, dry = false, keepHeader = false }) {
  const rel = pageRel(courseKey, week), file = path.join(root, rel)
  registry.pages ||= {}
  const reg = registry.pages[rel] || null
  const text = await readText(file), exists = text !== null
  const rows = plan.rows || []
  if (!exists && !rows.length) return { page: rel, created: false, headerRewritten: false, added: [], blockId: null, changed: false, skipped: true }
  const parsed = parsePage(text ?? '')
  const blocks = parsed.blocks.map(b => ({ id: b.id, md: b.md }))
  if (!blocks.length || blocks[0].id !== null) blocks.unshift({ id: null, md: '' })
  const known = !!reg && 'headerHash' in reg
  const owned = !exists || !blocks[0].md.trim() || (known ? !!reg.headerHash && reg.headerHash === sha1(blocks[0].md) : looksGenerated(blocks[0].md))
  const keep = keepHeader && exists   // --add never touches an existing header, but a page it creates gets one
  const header = keep ? blocks[0].md : buildHeader(courseKey, week, plan)
  let headerRewritten = false
  if (owned && !keep && blocks[0].md !== header) { blocks[0].md = header; headerRewritten = true }
  const tags = Array.isArray(parsed.frontmatter?.tags) ? parsed.frontmatter.tags.map(String) : []
  const fmRaw = exists
    ? patchFrontmatterRaw(parsed.frontmatterRaw, { ...(parsed.frontmatterRaw ? {} : { created: localStamp() }), kind: 'problem-set', tags: tags.includes('problems') ? tags : [...tags, 'problems'] })
    : `---\ncreated: "${localStamp()}"\nkind: "problem-set"\ntags: ["problems"]\n---\n`
  const fmChanged = fmRaw !== (parsed.frontmatterRaw ?? '')
  let i = findProblemsBlock(blocks, reg?.blockId), added = []
  if (rows.length) {
    if (i < 0) { blocks.push({ id: freshId(blocks), md: HEADING }); i = blocks.length - 1 }
    const m = mergeRows(blocks[i].md, rows)
    added = m.added; if (added.length) blocks[i].md = m.md
  }
  const blockId = i >= 0 ? blocks[i].id : null
  const next = joinPage({ frontmatterRaw: fmRaw, blocks })
  const changed = !exists || headerRewritten || fmChanged || added.length > 0
  if (changed && next !== text && !dry) { await writeAtomic(file, next); await ensureOrder(path.dirname(file), 'Problems', dry) }
  registry.pages[rel] = { ...(reg || {}), headerHash: owned ? sha1(blocks[0].md) : null, blockId }   // null the moment the student edits it: his from then on, as plan.mjs records it
  return { page: rel, created: !exists, headerRewritten, added, blockId, changed: changed && next !== text, skipped: false }
}
// The week a Problems page path belongs to: 'ECO 206Y1/Fall 2026/Week 1 (Sep 7)/Problems.md' → { courseKey, week }.
export function locatePage(rel) {
  const parts = String(rel || '').split('/')
  if (parts.length !== 4 || parts[3] !== 'Problems.md') return null
  const info = COURSES[parts[0]]; if (!info) return null
  const week = weeks(info.term).find(w => w.dir === `${parts[1]}/${parts[2]}`)
  return week ? { courseKey: parts[0], week } : null
}
// addRows(root, page, rows, { registry, dry }) → the same merge for the Claude pass (--add): creates the page with a minimal header
// when absent, never touches an existing header, and remembers the keys so the summary reports them as source `claude`.
export async function addRows(root, page, rows, { registry, dry = false } = {}) {
  const loc = locatePage(page); if (!loc) throw new Error(`not a week's Problems page: ${page}`)
  const reg = registry || await readJson(PROBLEMS_JSON(root), {})
  const wanted = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r.label === 'string' && r.label.trim()).map(r => ({ label: r.label.trim(), src: r.src ? String(r.src).trim() : null, kind: r.kind === 'set' ? 'set' : 'problem', source: { kind: 'claude', page: null, title: null }, due: null }))
  const plan = { topic: 'Problems', sourceLabel: 'itemised by the morning pass', readLine: null, noteLine: null, rows: wanted, issues: [] }
  const r = await applyToPage({ root, courseKey: loc.courseKey, week: loc.week, plan, registry: reg, dry, keepHeader: true })
  if (r.added.length) { const entry = reg.pages[page]; entry.claude = [...new Set([...(entry.claude || []), ...r.added.map(keyOf)])] }
  return { ...r, registry: reg }
}

// ---- summary ----------------------------------------------------------------------------------------------------
const tutorialFor = (courseKey, w, meetings) => meetings.find(m => m.courseKey === courseKey && m.kind === 'Tutorial' && !m.cancelled && m.week && syllabusWeekN(courseKey, 'Tutorial', m.week.n) === w.n)?.date || null
const topicOf = blocks => { const m = /^#\s+(.+?)\s*$/m.exec(blocks[0]?.id === null ? blocks[0].md : ''); return m ? m[1] : null }
const wikiTitle = src => { const m = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(String(src || '').trim()); return m ? m[1].trim() : null }

// One page, read now: { page, courseKey, week, n, topic, rows, solved, counts, blockId, hash } or null when the file is missing.
export async function readProblemsPage(root, rel, reg) {
  const text = await readText(path.join(root, rel)); if (text === null) return null
  const parsed = parsePage(text)
  const s = summarizeBlocks(parsed.blocks, reg?.pages?.[rel]?.blockId)
  return { page: rel, topic: topicOf(parsed.blocks), rows: s.rows, solved: s.solved, counts: s.counts, blockId: s.blockId, hash: sha1(text) }
}
// Where a row came from, recovered from its source suffix: a wikilink into Announcements/ → announcement; into the week folder (or its
// Lectures/) → quercus-page; a WebAssign row → syllabus; a key the Claude pass added → claude; anything else is the student's own row.
function sourceOf(row, ctx) {
  const key = row.key, title = wikiTitle(row.src)
  if (ctx.claude.has(key)) return { kind: 'claude', page: title && ctx.weekPages.has(title) ? `${ctx.courseKey}/${ctx.week.dir}/${title}.md` : null, title }
  if (/\bwebassign\b/i.test(row.label)) return { kind: 'syllabus', page: null, title: null }
  if (title && ctx.announcements.has(title)) return { kind: 'announcement', page: `${ctx.courseKey}/Announcements/Announcements/${title}.md`, title }
  if (title && ctx.weekPages.has(title)) return { kind: 'quercus-page', page: `${ctx.courseKey}/${ctx.week.dir}/${title}.md`, title }
  if (title && ctx.lecturePages.has(title)) return { kind: 'quercus-page', page: `${ctx.courseKey}/${ctx.week.dir}/Lectures/${title}.md`, title }
  return { kind: 'own', page: null, title }
}
const weekRow = (r, ctx) => {
  const source = sourceOf(r, ctx), kind = rowKind(r.label)
  const set = kind === 'set' && source.kind === 'syllabus' ? ctx.sets.get(r.key) || null : null
  return { key: r.key, label: r.label, line: r.line, attempted: r.attempted, reviewed: r.reviewed, solved: r.solved, kind, source, due: set ? set.due : ctx.tutorial, score: r.score }
}
async function courseContext(root, courseKey) {
  const announcements = new Set(await listMd(path.join(root, courseKey, 'Announcements', 'Announcements')))
  const sets = new Map(webassignSets(courseKey).map(s => [keyOf(s.set), s]))
  return { announcements, sets }
}
// summarize(root, { today, registry }) → the Hub/_problems.json object (SPEC §20.2 dataModel), reading every <Course>/<Term>/<Week>/Problems.md now.
export async function summarize(root, { today = todayIso(), registry = null } = {}) {
  const reg = registry || await readJson(PROBLEMS_JSON(root), {})
  const out = { updatedAt: localStamp(), pages: reg.pages || {}, issues: reg.issues || [], courses: {}, upcoming: [] }
  for (const [courseKey, info] of Object.entries(COURSES)) {
    const wks = weeks(info.term); if (!wks.length) continue
    const meetings = expandMeetings(wks[0].monday, addDays(wks[wks.length - 1].monday, 13))
    const cc = await courseContext(root, courseKey)
    const course = { code: info.code, name: info.name, color: info.color, weeks: [], totals: { assigned: 0, attempted: 0, reviewed: 0, solved: 0 }, webassign: null }
    for (const w of wks) {
      const rel = pageRel(courseKey, w)
      const pg = await readProblemsPage(root, rel, reg); if (!pg) continue
      const dir = path.join(root, courseKey, w.dir)
      const ctx = { courseKey, week: w, tutorial: tutorialFor(courseKey, w, meetings), claude: new Set(reg.pages?.[rel]?.claude || []), weekPages: new Set(await listMd(dir)), lecturePages: new Set(await listMd(path.join(dir, 'Lectures'))), ...cc }
      const rows = pg.rows.map(r => weekRow(r, ctx))
      const c = countRows(pg.rows, pg.solved)
      course.weeks.push({ n: w.n, week: w.label, weekDir: w.dir, page: rel, topic: pg.topic, tutorial: ctx.tutorial, counts: c, rows })
      for (const k of Object.keys(course.totals)) course.totals[k] += c[k]
    }
    if (info.grading?.components?.some(c => c.key === 'webassign')) course.webassign = await webassignScores(courseKey, root)
    out.courses[courseKey] = course
    const cur = weekFor(info.term, today), nxt = cur ? wks.find(x => x.n === cur.n + 1) : null
    for (const w of [cur, nxt].filter(Boolean)) {
      const wk = course.weeks.find(x => x.n === w.n); if (!wk) continue
      out.upcoming.push({ courseKey, course: info.code, color: info.color, page: wk.page, week: wk.week, n: wk.n, counts: wk.counts, tutorial: wk.tutorial, set: course.webassign?.sets.find(s => s.n === wk.n) || null })
    }
  }
  return out
}
// The ?page= view for the chip and the course screen: one page's rows, counts and (ECO227) its set and the running bonus.
export async function pageSummary(root, rel, { today = todayIso() } = {}) {
  const loc = locatePage(rel)
  const reg = await readJson(PROBLEMS_JSON(root), {})
  const pg = await readProblemsPage(root, rel, reg); if (!pg) return null
  if (!loc) return { page: rel, courseKey: null, course: null, week: null, n: null, topic: pg.topic, tutorial: null, counts: pg.counts, rows: pg.rows.map(r => ({ ...r, kind: rowKind(r.label), source: { kind: 'own', page: null, title: wikiTitle(r.src) }, due: null })), webassign: null, blockId: pg.blockId, hash: pg.hash }
  const { courseKey, week: w } = loc, info = COURSES[courseKey]
  const meetings = expandMeetings(w.monday, addDays(w.monday, 13))
  const dir = path.join(root, courseKey, w.dir)
  const ctx = { courseKey, week: w, tutorial: tutorialFor(courseKey, w, meetings), claude: new Set(reg.pages?.[rel]?.claude || []), weekPages: new Set(await listMd(dir)), lecturePages: new Set(await listMd(path.join(dir, 'Lectures'))), ...(await courseContext(root, courseKey)) }
  const wa = info.grading?.components?.some(c => c.key === 'webassign') ? await webassignScores(courseKey, root) : null
  return { page: rel, courseKey, course: info.code, color: info.color, week: w.label, n: w.n, topic: pg.topic, tutorial: ctx.tutorial, counts: pg.counts, rows: pg.rows.map(r => weekRow(r, ctx)), blockId: pg.blockId, hash: pg.hash,
    webassign: wa ? { ...wa, set: wa.sets.find(s => s.n === w.n) || null } : null, today }
}
