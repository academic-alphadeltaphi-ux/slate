// The term grid and the week screen (SPEC §20.13): two read-only routes that answer the question "what is in this
// term, and what is in this week" without the student expanding a tree and clicking six pages.
//
//   GET /api/term?key=<Notebook>&term=<Fall 2026>   every week of the term, one row each, the same row the course
//                                                   screen already builds (routes/course.js weekRow).
//   GET /api/week?path=<Notebook>/<Term>/<Week>     one week with its six buckets: the text of Notes, Problems and
//                                                   Plan, the child pages of Lectures, Recordings and Study sheets
//                                                   with their assets, and the week's classes from Hub/_plan.json.
//
// Nothing is written (SPEC §20.1). Weeks come from scripts/lib/terms.mjs when it knows the course, so the grid has a
// row for a week whose folder does not exist yet; for any other notebook the rows are the folders on disk. Registered
// from server/index.js: register(app, ctx).
//   ?now=YYYY-MM-DD freezes the clock, as on /api/course.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, weeks, weekFor, isoOf } from '../../scripts/lib/terms.mjs'
import { inReadingWeek, syllabusWeekN, expandMeetings } from '../../src/calendar.js'
import { summarize } from '../../scripts/lib/problems.mjs'
import { pairSets, attachRows } from '../../src/problems.js'
import { weekRow } from './course.js'
import { readReview } from '../../scripts/lib/review.mjs'
import { enabled } from '../edition.js'
import { WIN } from '../../scripts/lib/platform.mjs'

const BUCKETS = [
  { id: 'notes', title: 'Notes', icon: 'notes' },
  { id: 'lectures', title: 'Lectures', icon: 'board' },
  { id: 'recordings', title: 'Recordings', icon: 'headphones' },
  { id: 'sheets', title: 'Study sheets', icon: 'bookmark' },
  { id: 'problems', title: 'Problems', icon: 'pencil' },
  { id: 'plan', title: 'To do', icon: 'checklist' },
]
const DOC_RE = /\.(pdf)$/i
// The folders the brain files by name beside the six (SPEC §20.53) draw with an icon of their own; any other gets the file.
const EXTRA_ICON = { Readings: 'bookOpen', Textbook: 'book', Videos: 'eye', Assignments: 'checkSquare', Listening: 'headphones' }
const TRANSCRIPT_RE = /\.(transcript\.json|srt|vtt)$/i
// Speech as server/index.js decides it (not imported: a route that imports index.js deadlocks its top-level await).
// Where there is none — a PC, an Intel Mac — a recording is never "to transcribe", or its cell would sit half-done for ever.
const SPEECH = enabled('speech') && !WIN && (process.arch === 'arm64' || process.env.SLATE_SPEECH === '1')
// Same contract as /api/course: a clock override must look like a date, or it is a 400. Without this an
// unparseable value became the string "Invalid Date" and was compared against real ISO dates all the way down.
const NOW_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/
const nowOf = (s, HttpError) => {
  if (!s) return new Date()
  if (!NOW_RE.test(s)) throw new HttpError(400, 'now must be YYYY-MM-DD or YYYY-MM-DDTHH:MM')
  const d = new Date(s.length === 10 ? s + 'T12:00:00' : s + ':00')
  // '2026-02-30' parses fine and silently means 2 March; only a value that round-trips is the day asked for.
  if (Number.isNaN(d.getTime()) || d.toLocaleDateString('en-CA') !== s.slice(0, 10)) throw new HttpError(400, 'now is not a real date')
  return d
}

export function register(app, ctx) {
  const { store, ROOT, wrap, q, HttpError } = ctx
  const hubJson = async (name, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', name), 'utf8')) } catch { return d } }

  app.get('/api/term', wrap(async (req, res) => {
    const key = q(req, 'key'), term = q(req, 'term')
    if (!key || !term) throw new HttpError(400, 'key and term required')
    store.safeRel(`${key}/${term}`)
    if (!(await store.tree()).some(n => n.path === key)) throw new HttpError(404, 'not a notebook')   // was inventing weeks for anything
    const now = nowOf(q(req, 'now') || '', HttpError)
    res.json(await termView({ store, ROOT, hubJson }, key, term, now))
  }))

  app.get('/api/week', wrap(async (req, res) => {
    const rel = q(req, 'path')
    if (!rel) throw new HttpError(400, 'path required')
    store.safeRel(rel)
    const parts = rel.replace(/\.md$/, '').split('/')
    if (parts.length !== 3) throw new HttpError(400, 'path must be <Notebook>/<Term>/<Week>')
    const now = nowOf(q(req, 'now') || '', HttpError)
    res.json(await weekView({ store, ROOT, hubJson, HttpError }, parts[0], parts[1], parts[2], now))
  }))
}

// ---- the term grid ---------------------------------------------------------------------------------------------------
// The weeks of one term as rows. terms.mjs is the authority when it knows the course (so an empty future week still has
// a row); otherwise the rows are whatever folders the section holds, in the section's own order.
async function termList(store, key, term) {
  const known = weeks(COURSES[key]?.term || 'Y').filter(w => w.term === term)
  if (known.length) return known
  const kids = await store.pages(`${key}/${term}`)
  return kids.map((p, i) => ({ n: i + 1, label: p.title, monday: null, span: '', term, dir: `${term}/${p.title}` }))
}
async function courseOf(hubJson, key) {
  const hub = await hubJson('_hub.json', null)
  const c = (hub?.courses || []).find(x => x.key === key)
  if (c) return { key, code: c.code, name: c.name, color: c.color || null, meets: c.meets || '', url: c.url || null }
  const k = COURSES[key]
  return { key, code: k?.code || key, name: k?.name || key, color: k?.color || null, meets: '', url: null }
}
async function termView({ store, ROOT, hubJson }, key, term, now) {
  const today = isoOf(now)
  const list = await termList(store, key, term)
  const termCode = COURSES[key]?.term || 'Y'
  const cur = weekFor(termCode, today)
  const [problemsAll, plan] = await Promise.all([
    summarize(ROOT, { today }).catch(e => { console.error('[term] problems summary failed:', e.message); return null }),
    hubJson('_plan.json', null),
  ])
  const probCourse = problemsAll?.courses?.[key] || null
  // The Plan column counts what the plan already counted (Hub/_plan.json, one entry per meeting), never a re-parse.
  const tasks = new Map()
  for (const m of plan?.meetings || []) {
    if (m.courseKey !== key || !m.planPage || !m.tasks) continue
    const t = tasks.get(m.planPage) || { done: 0, total: 0 }
    tasks.set(m.planPage, { done: t.done + m.tasks.done, total: t.total + m.tasks.total })
  }
  const rows = await Promise.all(list.map(async w => {
    const r = await weekRow(store, ROOT, key, w, today, cur?.n ?? null, probCourse)
    return { ...r, readingWeek: w.monday ? inReadingWeek(w.monday) : false, columns: columnsOf(r, tasks.get(r.plan?.path) || null) }
  }))
  const terms = [...new Set(weeks(termCode).map(w => w.term))]
  return { key, term, terms, today, course: await courseOf(hubJson, key), current: cur ? { n: cur.n, label: cur.label, term: cur.term } : null, weeks: rows }
}
// One cell per bucket, already reduced to what the grid prints: a state and a line. The client never re-derives these.
function columnsOf(r, planTasks) {
  const cell = (id, has, state, line, path, count = null) => ({ id, has, state, line, path: path || null, count })
  const lect = r.lectures?.items || [], recs = r.recordings?.items || [], sh = r.sheets?.items || []
  const untr = recs.filter(x => !x.transcribed).length, waiting = SPEECH ? untr : 0
  const c = r.problems?.counts || null, pdocs = r.problems?.items || []
  // Exercises when the page lists any, otherwise the documents filed in the folder — never "nothing listed" over
  // three problem sets sitting right there (SPEC §20.24).
  const prob = c?.assigned
    ? { state: c.attempted >= c.assigned ? 'done' : c.attempted ? 'partial' : 'todo', line: `${c.attempted}/${c.assigned}${r.problems?.topic ? ` · ${r.problems.topic}` : ''}`, count: c.assigned }
    : pdocs.length ? { state: 'done', line: `${pdocs.length} file${pdocs.length === 1 ? '' : 's'}`, count: pdocs.length }
    : { state: 'empty', line: r.problems ? 'nothing listed' : '—', count: 0 }
  return [
    cell('notes', !!r.notes, r.notes?.written ? 'done' : 'empty', r.notes?.written ? 'written' : 'empty', r.notes?.path),
    cell('lectures', !!r.lectures, lect.length ? 'done' : 'empty', lect.length ? `${lect.length} file${lect.length === 1 ? '' : 's'}` : '—', r.lectures?.path, lect.length),
    cell('recordings', !!r.recordings, recs.length ? (waiting ? 'partial' : 'done') : 'empty', recs.length ? `${recs.length}${waiting ? ` · ${waiting} to transcribe` : untr ? '' : ' · transcribed'}` : '—', r.recordings?.path, recs.length),
    cell('sheets', !!r.sheets, sh.length ? 'done' : r.elapsed && (lect.length || recs.length) ? 'partial' : 'empty', sh.length ? sh.map(s => s.title.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')).join(', ') : r.elapsed && (lect.length || recs.length) ? 'material, no sheet' : '—', r.sheets?.path, sh.length),
    cell('problems', !!r.problems, prob.state, prob.line, r.problems?.path, prob.count),
    cell('plan', !!r.plan, !r.plan ? 'empty' : !planTasks?.total ? 'done' : planTasks.done >= planTasks.total ? 'done' : planTasks.done ? 'partial' : 'todo',
      !r.plan ? '—' : planTasks?.total ? `${planTasks.done}/${planTasks.total} prepared` : 'written', r.plan?.path, planTasks?.total || 0),
  ]
}

// ---- one week --------------------------------------------------------------------------------------------------------
const mdOf = async (store, p) => { const pg = await store.readPage(p); return { md: pg.blocks.map(b => b.md).join('\n\n').trim(), exists: pg.exists, assets: pg.assets } }
async function itemOf(store, p) {
  const pg = await store.readPage(p.path)
  const els = pg.layout?.elements || []
  return {
    title: p.title, path: p.path, kind: p.kind, for: p.for || null, modified: p.modified,
    date: /\((\d{4}-\d{2}-\d{2})\)/.exec(p.title)?.[1] || null,
    pdfs: els.filter(e => e.type === 'pdf' || (e.type === 'file' && DOC_RE.test(String(e.src || '')))).length,
    // The canvas stores a recording as type 'media' (Canvas.jsx, Add files): counting only audio/video drew every recording
    // in a week as an "empty page", with no Transcribe button to offer (SPEC §20.36).
    media: els.filter(e => e.type === 'media' || e.type === 'audio' || e.type === 'video').length,
    images: els.filter(e => e.type === 'image').length,
    transcribed: pg.assets.some(a => TRANSCRIPT_RE.test(a)),
    words: pg.blocks.map(b => b.md).join(' ').trim().split(/\s+/).filter(Boolean).length,
  }
}
async function itemsOf(store, container) {
  if (!container) return []
  const kids = (await store.pages(container.replace(/\.md$/, ''))).filter(p => !p.virtual)
  return Promise.all(kids.map(p => itemOf(store, p)))
}
// ---- what this week's classes actually work through (SPEC §20.50) ----------------------------------------------------
// A tutorial that lags its lecture (`tutorialLag` on the course) meets in one week and works through the week before's
// material. The week page is built from one folder, so on that page the tutorial's own questions were simply missing:
// Week 2 showed a tutorial on "Constrained Optimization" and not one of the pages that phrase refers to, while the
// to-do for it jumped back to Week 1. The files do not move — Week 1's lecture is where they came from — but the week
// that *holds the class* says what the class covers, and every row opens the real page.
async function coversOf({ store, problemsAll }, key, term, list, w, meetings) {
  if (w.n == null || !w.monday) return []
  const out = []
  const seen = new Set()
  // The timetable, not `Hub/_plan.json`: the plan holds the *near* future, so a week that has already happened has no
  // meetings left in it and the shelf would quietly disappear from every past week — the same material missing from
  // the same page, for a different reason. src/calendar.js is the one place a meeting is expanded (SPEC §20.1); the
  // plan is still read on top of it, for the announced topic and for a cancellation.
  const said = new Map((meetings || []).map(m => [m.kind, m]))
  const timetable = expandMeetings(w.monday, isoAdd(w.monday, 6)).filter(m => m.courseKey === key)
  for (const tm of timetable) {
    const m = { ...tm, ...(said.get(tm.kind) || {}) }
    if (m.cancelled) continue
    const src = syllabusWeekN(key, m.kind, w.n)
    if (src == null || src === w.n) continue
    const from = list.find(x => x.n === src)
    const id = `${m.kind}|${src}`
    if (!from || seen.has(id)) continue
    seen.add(id)
    const want = String(m.kind).toLowerCase()
    const dir = `${key}/${term}/${from.label}`
    const mine = x => String(x.for || '').toLowerCase() === want         // `both` belongs to its own week, not pulled forward
    const probItems = (await itemsOf(store, `${dir}/Problems.md`)).filter(mine)
    const rows = problemsAll?.courses?.[key]?.weeks?.find(x => x.n === src)?.rows || []
    const { sets } = attachRows(pairSets(probItems), rows)
    // Anything else filed for this class in that week, and the page the class's topic names — that one is usually
    // `for: both` (it is the lecture's too), so it is found by the topic rather than by the tag.
    const kept = new Set(BUCKETS.map(b => (b.id === 'plan' ? 'Plan' : b.id === 'sheets' ? 'Study sheets' : b.id[0].toUpperCase() + b.id.slice(1))))
    const loosePages = (await store.pages(dir)).filter(p => !kept.has(p.title) && !p.virtual && !(p.children || []).length)
    const looseItems = await Promise.all(loosePages.map(p => itemOf(store, p)))
    const fold = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const topicText = fold(m.topic?.text)
    const items = looseItems.filter(x => mine(x) || (topicText && fold(x.title) === topicText))
    if (!sets.length && !items.length) continue
    out.push({ key: want, kind: m.kind, date: m.date, day: m.day, topic: m.topic?.text || null,
      from: { n: from.n, label: from.label, dir: `${key}/${from.dir}` }, sets, items })
  }
  return out
}

async function weekView({ store, ROOT, hubJson, HttpError }, key, term, label, now) {
  const today = isoOf(now), dir = `${key}/${term}/${label}`
  const list = await termList(store, key, term)
  const i = list.findIndex(w => w.label === label)
  const w = list[i] || { n: null, label, monday: null, span: '', term, dir: `${term}/${label}` }
  const termCode = COURSES[key]?.term || 'Y'
  const cur = weekFor(termCode, today)
  const problemsAll = await summarize(ROOT, { today }).catch(() => null)
  const row = await weekRow(store, ROOT, key, w, today, cur?.n ?? null, problemsAll?.courses?.[key] || null)
  if (!row.exists && !list[i]) throw new HttpError(404, 'no such week')

  // A bucket is a page *and* a folder. Read both for every one of them.
  const page = await mdOf(store, `${dir}.md`)
  const probRows = problemsAll?.courses?.[key]?.weeks?.find(x => x.n === w.n)?.rows || []
  const sections = await Promise.all(BUCKETS.map(async b => {
    const at = row[b.id]?.path || `${dir}/${b.id === 'plan' ? 'Plan' : b.id === 'sheets' ? 'Study sheets' : b.id[0].toUpperCase() + b.id.slice(1)}.md`
    const [text, items] = await Promise.all([mdOf(store, at), itemsOf(store, at)])
    return {
      id: b.id, title: b.title, icon: b.icon, path: at, has: !!row[b.id] || items.length > 0,
      md: text?.md || '', items,
      counts: b.id === 'problems' ? row.problems?.counts || null : null,
      topic: b.id === 'problems' ? row.problems?.topic || null : null,
      // The documents as sets — questions and solutions together, guides beside them — with each row of the page's
      // `## Problems` list on the set it belongs to, and the rows no document claims as `loose` (SPEC §20.32).
      ...(b.id === 'problems' ? { exists: !!text?.exists, ...attachRows(pairSets(items), probRows) } : {}),
    }
  }))
  // The six buckets are what the sync writes; they are not the only kinds of thing a week may hold. Any *other*
  // folder in the week is a category of its own — made by adding files under a new name — and gets a section beside
  // them (SPEC §20.30). Loose pages that are not folders stay in "Also in this week".
  const kept = new Set(BUCKETS.map(b => (b.id === 'plan' ? 'Plan' : b.id === 'sheets' ? 'Study sheets' : b.id[0].toUpperCase() + b.id.slice(1))))
  const rest = (await store.pages(dir)).filter(p => !kept.has(p.title))
  const extra = await Promise.all(rest.filter(p => (p.children || []).length).map(async p => ({
    id: 'x:' + p.title, title: p.title, icon: EXTRA_ICON[p.title] || 'file', path: p.path, has: true, custom: true,
    md: p.virtual ? '' : (await mdOf(store, p.path))?.md || '', items: await itemsOf(store, p.path), counts: null, topic: null,
  })))
  const others = await Promise.all(rest.filter(p => !p.virtual && !(p.children || []).length).map(p => itemOf(store, p)))

  // The week's classes: the plan's word when it exists (announced rooms, cancellations, the topic), never re-derived.
  const plan_ = await hubJson('_plan.json', null)
  const from = w.monday, to = w.monday ? isoAdd(w.monday, 6) : null
  const raw = !plan_ || !from ? [] : (plan_.meetings || []).filter(m => m.courseKey === key && m.date >= from && m.date <= to)
  const meetings = raw.map(m => ({ id: m.id, date: m.date, day: m.day, kind: m.kind, start: m.announced?.start || m.start, end: m.announced?.end || m.end, where: m.announced?.where || m.where || '', cancelled: m.cancelled || null, topic: m.topic || null, planPage: m.planPage || null, tasks: m.tasks || null }))

  // What there is to do is deliberately *not* here (SPEC §20.39). It lives on Home, on To do and on the course screen,
  // built once by src/todo.js; a fourth copy of it on the screen the student opens in order to read the week was noise.
  const course = await courseOf(hubJson, key)
  return {
    key, term, today, course,
    week: { n: w.n, label: w.label, span: w.span, monday: w.monday, term, dir, page: `${dir}.md`, topic: row.topic || null, current: !!cur && cur.n === w.n, elapsed: !!w.monday && w.monday <= today, readingWeek: w.monday ? inReadingWeek(w.monday) : false },
    intro: page?.md || '',
    // his flag on this week, if he set one (SPEC §21.13): { week, note, at } | null
    review: w.n ? (await readReview(ROOT)).courses[key]?.[w.n] || null : null,
    // Every week of the term, so the screen can carry its own way to any other one (SPEC §20.24) — the same list the
    // grid is built from, already in memory, rather than a second request.
    weeks: list.map(x => ({ n: x.n, label: x.label, span: x.span, dir: `${key}/${x.dir}`, current: !!cur && cur.n === x.n, elapsed: !!x.monday && x.monday <= today })),
    // The kinds of class this course has at all, from the timetable — the week screen splits its material by them, and a week
    // that has already happened has no meetings left in the plan to read them from (SPEC §20.38).
    classes: [...new Set((COURSES[key]?.meetings || []).map(m => m.kind).filter(Boolean))],
    sections: [...sections, ...extra], others, meetings,
    covers: await coversOf({ store, problemsAll }, key, term, list, w, meetings),
    prev: i > 0 ? `${key}/${list[i - 1].dir}` : null,
    next: i >= 0 && i < list.length - 1 ? `${key}/${list[i + 1].dir}` : null,
  }
}
const isoAdd = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA') }
