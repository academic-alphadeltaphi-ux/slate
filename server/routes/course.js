// The course screen's one route (SPEC §20.4): GET /api/course?key=<notebook name> assembles a read-only view on
// request from files that already exist — Hub/_hub.json, _plan.json (next class, tests, coverage counts), _problems.json
// through scripts/lib/problems.mjs summarize() (the live counts, the same numbers the chip shows), _study-queue.json,
// _sync-state.json and the notebook tree through server/fs.js. Nothing is written; the answer is memoised two seconds
// per key so a burst of watcher-driven reloads costs one walk. The calendar is src/calendar.js (the one meeting model):
// a day is a class here exactly when it is one on What's next. Registered from server/index.js: register(app, ctx).
//   ?now=YYYY-MM-DDTHH:MM freezes the clock (tests, a look at a future week); the memo is keyed by it too.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, weeks, weekFor, isoOf } from '../../scripts/lib/terms.mjs'
import { SYLLABUS } from '../../scripts/lib/syllabus.mjs'
import { expandMeetings, nextMeeting, testsFor, addDays, daysTo, inReadingWeek, inTerm } from '../../src/calendar.js'
import { summarize } from '../../scripts/lib/problems.mjs'
import { THIS as ED } from '../../src/edition.js'

export const MEMO_MS = 2000
const memo = new Map()   // `${key}|${now}` → { at, sig, promise }
// The memo is also dropped the moment anything it read changes: an external change reaches it through the watcher's
// broadcasts (a tap on the SSE bus — subscribe() with a client that only listens), an app write through fs.js's
// recentWrites (the PUT /api/page behind the score field, a tick in the editor), so a reload inside the two seconds
// never shows the answer from before the write.
const tap = { on: false }
const invalidate = p => { if (!p) return; if (p.startsWith('Hub/')) { memo.clear(); return } const nb = p.split('/')[0]; for (const k of memo.keys()) if (k.split('|')[0] === nb) memo.delete(k) }
function tapBroadcasts(watch) {
  if (tap.on || typeof watch?.subscribe !== 'function') return
  tap.on = true
  watch.subscribe({ writeHead() { }, on() { }, write(chunk) { for (const line of String(chunk).split('\n')) { if (!line.startsWith('data: ')) continue; try { invalidate(JSON.parse(line.slice(6)).path) } catch { } } } })
}
const writeSig = (store, key) => { const dirs = [store.abs(key) + path.sep, store.abs('Hub') + path.sep]; return [...(store.recentWrites || new Map())].filter(([f]) => dirs.some(d => f.startsWith(d))).map(([f, set]) => `${f}:${set.size}`).join('|') }
const LINK_RE = /^- \[(.+?)\]\((https?:[^)\s]+)\)(?: · (.+))?\s*$/gm
const DOC_RE = /\.(pdf)$/i
const TRANSCRIPT_RE = /\.(transcript\.json|srt|vtt)$/i
const realDate = s => {
  const d = new Date(s.length === 10 ? s + 'T12:00:00' : s + ':00')
  // '2026-02-30' parses fine and means 2 March; only a value that round-trips is the day that was asked for.
  return Number.isNaN(d.getTime()) || d.toLocaleDateString('en-CA') !== s.slice(0, 10) ? null : d
}
const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export function register(app, ctx) {
  const { store, ROOT, wrap, q, HttpError, watch } = ctx
  const hubJson = async (name, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', name), 'utf8')) } catch { return d } }
  tapBroadcasts(watch)

  app.get('/api/course', wrap(async (req, res) => {
    const key = q(req, 'key')
    if (!key) throw new HttpError(400, 'key required')
    store.safeRel(key)
    const nowParam = q(req, 'now') || ''
    if (nowParam && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(nowParam)) throw new HttpError(400, 'now must be YYYY-MM-DD or YYYY-MM-DDTHH:MM')
    // The shape is not enough: '2026-13-45' matches the regex, and an Invalid Date becomes the string
    // "NaN-NaN-NaN", which addDays cannot advance past — expandMeetings then loops for ever (SPEC §20.20).
    if (nowParam && !realDate(nowParam)) throw new HttpError(400, 'now is not a real date')
    const mk = `${key}|${nowParam}`, sig = writeSig(store, key)
    const hit = memo.get(mk)
    if (hit && Date.now() - hit.at < MEMO_MS && hit.sig === sig) return res.json(await hit.promise)
    const now = nowParam ? new Date(nowParam.length === 10 ? nowParam + 'T12:00:00' : nowParam + ':00') : new Date()
    const promise = build({ store, ROOT, HttpError, hubJson }, key, now)
    memo.set(mk, { at: Date.now(), sig, promise })
    promise.catch(() => memo.delete(mk))
    res.json(await promise)
  }))
}

// ---- the view -------------------------------------------------------------------------------------------------------
async function build({ store, ROOT, HttpError, hubJson }, key, now) {
  const hub = await hubJson('_hub.json', null)
  if (!hub) throw new HttpError(404, 'Quercus has not been checked yet — press Check Quercus on Home')
  const course = (hub.courses || []).find(c => c.key === key)
  if (!course) throw new HttpError(404, 'not a course')
  const today = isoOf(now), nowStamp = `${today}T${hm(now)}`
  const [state, queue, plan, problemsAll] = await Promise.all([
    hubJson('_sync-state.json', {}), hubJson('_study-queue.json', { ready: [], blocked: [] }), hubJson('_plan.json', null),
    summarize(ROOT, { today }).catch(e => { console.error('[course] problems summary failed:', e.message); return null }),
  ])
  const term = course.term || COURSES[key]?.term || 'Y'
  const all = weeks(term), cur = weekFor(term, today)
  const probCourse = problemsAll?.courses?.[key] || null
  const tests = testsWithCoverage(key, course, hub, plan, today)
  const next = tests[0] || null
  const upto = Math.max(cur?.n || 0, next?.weekN || 0, next?.window?.to || 0, 1)
  const rows = await Promise.all(all.filter(w => w.n <= upto).map(w => weekRow(store, ROOT, key, w, today, cur?.n ?? null, probCourse)))
  // sheets so far, newest first, with the index's stamp when it has one
  const byPage = Object.fromEntries(Object.values(state.sheets || {}).filter(s => s?.page).map(s => [s.page, s]))
  const sheets = rows.flatMap(r => (r.sheets?.items || []).map(s => ({ ...s, week: r.label, weekN: r.n, at: byPage[s.path]?.at || null, html: byPage[s.path]?.html || null })))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.title.localeCompare(a.title))
  return {
    key, today, now: nowStamp, builtAt: new Date().toISOString(), updatedAt: hub.updatedAt || null,
    plan: plan ? { updatedAt: plan.updatedAt || null, today: plan.today || null } : null,
    // the header's facts (SPEC §20.15); `textbookSection` when the notebook holds the book itself (SPEC §20.67), so the
    // fact is a way in rather than a line of text
    course: { ...course, textbook: COURSES[key]?.textbook || course.textbook || null, textbookSection: (await store.pages(`${key}/Textbook`).catch(() => [])).some(p => !p.virtual) ? `${key}/Textbook` : null },
    // topic: the outline's name for the week — the heading of an online course's week, which has no class to name it (SPEC §20.35)
    week: cur ? { ...cur, page: `${key}/${cur.dir}.md`, readingWeek: inReadingWeek(today), topic: SYLLABUS[key]?.weeks?.[cur.n]?.topic || null } : null,
    terms: [...new Set(all.map(w => w.term))],   // the term grid's entry points (SPEC §20.13)
    nextClass: nextClass(key, course, plan, now, today, nowStamp),
    thisWeek: cur ? rows.find(r => r.n === cur.n) || null : null,
    weeks: rows,
    tests,
    deadlines: (hub.deadlines || []).filter(d => d.courseKey === key).map(d => ({ ...d, daysLeft: d.dueDate ? daysTo(d.dueDate, today) : d.daysLeft })),
    readiness: next ? readiness(next, rows) : null,
    sheets,
    queue: { ready: (queue.ready || []).filter(r => r.courseKey === key), blocked: (queue.blocked || []).filter(r => r.courseKey === key) },
    problems: problemsView(probCourse, cur?.n ?? null, rows),
    announcements: await announcements(store, key, hub),
    links: await links(store, key),
    general: (await store.pages(`${key}/General`)).filter(p => !p.virtual && p.title !== 'Links').map(p => ({ title: p.title, path: p.path, kind: p.kind })),
  }
}

// The documents filed inside a bucket, in the section's own order. A child that is itself only a folder is skipped:
// it is scaffolding, not something to open.
const docs = parent => (parent?.children || []).filter(c => !c.virtual).map(c => ({ title: c.title, path: c.path, kind: c.kind, modified: c.modified, date: /\((\d{4}-\d{2}-\d{2})\)/.exec(c.title)?.[1] || null }))
// One week of the notebook: what each of its subpages holds. Missing folders → empty rows, never errors.
// Exported: routes/week.js builds the term's week cards and the week screen from the same row, so a week reads the
// same in every screen (SPEC §20.13).
export async function weekRow(store, ROOT, key, w, today, curN, probCourse) {
  const dir = `${key}/${w.dir}`, kids = await store.pages(dir)   // [] when the folder does not exist
  const find = t => kids.find(p => p.title === t) || null
  const notes = find('Notes'), lectures = find('Lectures'), recs = find('Recordings'), sheets = find('Study sheets'), prob = find('Problems'), plan = find('Plan')
  const written = notes && !notes.virtual ? (await store.readPage(notes.path)).blocks.some(b => b.md.trim()) : false
  const recordings = await Promise.all((recs?.children || []).map(async r => { const pg = await store.readPage(r.path); return { title: r.title, path: r.path, transcribed: pg.assets.some(a => TRANSCRIPT_RE.test(a)) } }))
  const sheetItems = await Promise.all((sheets?.children || []).map(async s => {
    const pg = await store.readPage(s.path)
    return { title: s.title, path: s.path, modified: s.modified, date: /\((\d{4}-\d{2}-\d{2})\)/.exec(s.title)?.[1] || null, hasPdf: (pg.layout?.elements || []).some(e => e.type === 'pdf' || (e.type === 'file' && DOC_RE.test(String(e.src || '')))) }
  }))
  const pageExists = kids.length > 0 || await fs.access(path.join(ROOT, `${dir}.md`)).then(() => true, () => false)
  // problems: the counts come from the one summary (src/problems.js through scripts/lib/problems.mjs), never from a regex here.
  // A bucket is a page *and* a folder (SPEC §20.23): `refile.mjs` moved ECO206's three problem sets into `Problems/`
  // without writing a `Problems.md`, so the page is *virtual* — this used to drop the whole bucket, and the course
  // screen said "no problems page" and counted zero while the week screen listed all three (SPEC §20.24).
  const probItems = docs(prob)
  let problems = null
  if (prob && (!prob.virtual || probItems.length)) {
    const entry = probCourse?.weeks?.find(x => x.n === w.n) || null
    problems = { path: prob.path, virtual: !!prob.virtual, topic: entry?.topic || null, counts: entry?.counts || null, tutorial: entry?.tutorial || null, modified: prob.modified, items: probItems }
  }
  const row = {
    n: w.n, label: w.label, monday: w.monday, span: w.span, term: w.term, dir, page: `${dir}.md`, elapsed: w.monday <= today, current: w.n === curN, exists: pageExists,
    // the outline's name for the week — for an online course the module it is, which nothing else in slate says (SPEC §20.52)
    topic: SYLLABUS[key]?.weeks?.[w.n]?.topic || null,
    // How many notes this week holds, not whether it holds any: the sheet if it has words, plus any note pages
    // filed beside it (SPEC §20.31).
    notes: notes ? { path: notes.path, written, count: (written ? 1 : 0) + docs(notes).length, items: docs(notes) } : null,
    lectures: lectures ? { path: lectures.path, items: docs(lectures) } : null,
    recordings: recs ? { path: recs.path, items: recordings } : null,
    sheets: sheets ? { path: sheets.path, items: sheetItems } : null,
    problems,
    plan: plan && !plan.virtual ? { path: plan.path } : null,
  }
  // What makes a week *done* depends on the edition, and getting this wrong is not cosmetic: the course page's whole
  // read of the term is this one field. "Done" meant "has a study sheet", so in an edition that builds no sheets no
  // week could ever reach it — every past week with material sat on 'partial' for ever and the term always looked
  // like the student was behind. Without sheets the honest signal is the one they produce themselves: the week has
  // material and they have written on it (SPEC §20.48).
  const worked = ED.sheets ? row.sheets?.items.length : row.notes?.count
  row.state = !row.elapsed ? 'future' : worked ? 'done' : (row.lectures?.items.length || row.recordings?.items.length) ? 'partial' : 'empty'
  return row
}

// This course's future tests, one per date, soonest first: src/calendar.js testsFor (syllabus ∪ Quercus, with the coverage
// window) when terms.mjs knows the course, else the hub's rows. The syllabus detail after the title ('tutorial slot Tue
// 3:10–5 pm') rides along as `detail`; the coverage COUNTS are the plan's word (plan.tests[]) — never re-derived here
// (SPEC §20.4). The plan holds a course's next test and, where it keeps quizzes apart (FCS298), its next quiz too: each
// test takes the coverage of its own date, or a quiz before the midterm left the midterm with none.
function testsWithCoverage(key, course, hub, plan, today) {
  const term = course.term || COURSES[key]?.term || 'Y'
  let list
  if (COURSES[key]) list = testsFor(key, hub, today)
  else {
    const seen = new Set()
    list = (hub.tests || []).filter(t => t.courseKey === key && t.date && t.date >= today).sort((a, b) => a.date.localeCompare(b.date)).filter(t => !seen.has(t.date) && seen.add(t.date))
      .map(t => ({ courseKey: key, course: course.code, color: course.color || null, key: `quercus-${t.date}`, title: t.title, date: t.date, note: t.note || 'from Quercus', url: t.url || null, inDays: daysTo(t.date, today), weekN: weekFor(term, t.date)?.n ?? null, window: null }))
  }
  const details = new Map((COURSES[key]?.tests || []).map(([d, t]) => [d, t.split(' · ').slice(1).join(' · ')]))
  const planTests = (plan?.tests || []).filter(t => t.courseKey === key)
  const trim = (title, detail) => {
    if (!detail) return null
    const said = new Set(String(title).toLowerCase().split(' · ').map(x => x.trim()))
    const rest = detail.split(' · ').filter(x => !said.has(x.trim().toLowerCase()))
    return rest.join(' · ') || null
  }
  return list.map(t => ({ ...t, detail: trim(t.title, details.get(t.date)), coverage: planTests.find(p => p.date === t.date)?.coverage || null }))
}

// The strip under the next test: one cell per week of its window, plus the honest per-week numbers. `counts` is the plan's
// coverage (sheets / problems / tasks) when the plan wrote one; the strip states are this route's only own derivation.
function readiness(test, rows) {
  const from = test.window?.from ?? 1, to = test.window?.to ?? (test.weekN ?? rows.length)
  const inWin = test.window?.weeks?.length ? new Set(test.window.weeks) : null
  const win = rows.filter(r => (inWin ? inWin.has(r.n) : r.n >= from && r.n <= to)), elapsed = win.filter(r => r.elapsed)
  const material = r => (r.lectures?.items.length || 0) + (r.recordings?.items.length || 0) > 0
  return {
    test: { key: test.key, title: test.title, detail: test.detail, date: test.date, inDays: test.inDays, weekN: test.weekN, note: test.note, url: test.url || null, assumed: !!test.assumed },
    from, to, window: test.window || null, counts: test.coverage || null,
    weeks: win.map(r => ({ n: r.n, label: r.label, page: r.page, state: r.state, elapsed: r.elapsed, current: r.current, sheets: r.sheets?.items.length || 0, lectures: r.lectures?.items.length || 0, recordings: r.recordings?.items.length || 0, untranscribed: r.recordings?.items.filter(x => !x.transcribed).length || 0, problems: r.problems?.counts || null })),
    summary: {
      elapsed: elapsed.length, withMaterial: elapsed.filter(material).length, sheeted: elapsed.filter(r => r.sheets?.items.length).length,
      unsheeted: elapsed.filter(r => material(r) && !r.sheets?.items.length).length,
      untranscribed: elapsed.reduce((n, r) => n + (r.recordings?.items.filter(x => !x.transcribed).length || 0), 0),
      problemsOpen: win.filter(r => r.problems?.counts && r.problems.counts.attempted < r.problems.counts.assigned).length,
    },
  }
}

// Next meeting: the plan's word when Hub/_plan.json exists (announced room and time, cancellations, the topic, the Plan page),
// else the timetable expanded by src/calendar.js — never a date on a closure, in a reading week or between terms. `now`
// = the class is in progress. `why` says why nothing is scheduled today (reading week, between terms) for the card's line.
function nextClass(key, course, plan, now, today, nowStamp) {
  const shape = (m, source) => {
    const start = m.announced?.start || m.start, end = m.announced?.end || m.end, where = m.announced?.where || m.where || ''
    return { id: m.id, date: m.date, day: m.day, start, end, where, kind: m.kind, week: m.week || null, topic: m.topic || null, announced: m.announced || null, changed: !!(m.announced && ((m.announced.start && m.announced.start !== m.start) || (m.announced.end && m.announced.end !== m.end) || (m.announced.where && m.announced.where !== m.where))),
      inDays: daysTo(m.date, today), now: m.date === today && `${m.date}T${start}` <= nowStamp, source, planPage: m.planPage || null, tasks: m.tasks || null, toPrepare: Array.isArray(m.before) ? m.before.length : 0 }
  }
  const why = inReadingWeek(today) ? 'reading week' : !inTerm(today) ? 'between terms' : null
  if (plan?.meetings?.length) { const m = nextMeeting(plan.meetings, key, nowStamp); if (m) return { ...shape(m, 'plan'), why } }
  const info = COURSES[key] || { code: course.code, color: course.color, term: course.term || 'Y', meetings: course.meetings || [] }
  const list = expandMeetings(today, addDays(today, 70), { courses: { [key]: { ...info, meetings: info.meetings || course.meetings || [] } }, syllabus: SYLLABUS })
  const m = nextMeeting(list, key, nowStamp)
  return m ? { ...shape(m, 'timetable'), why } : { why }
}

// The Problems card: one row per week's Problems page from the one summary — this week and next first (next week on top),
// then earlier weeks newest first, then the outline's future pages in order. Rows carry what the score field needs.
// The summary only knows *exercises* — the `## Problems` list on a `Problems.md`. The documents filed in `Problems/`
// (a problem set, its solutions, a tutorial sheet) are the week rows' word, and a week that has only those still gets
// a row here: it is the thing the student actually has to open (SPEC §20.24).
function problemsView(probCourse, curN, rows = []) {
  const slim = r => ({ key: r.key, label: r.label, line: r.line, attempted: r.attempted, reviewed: r.reviewed, solved: r.solved, kind: r.kind, source: r.source, due: r.due, score: r.score })
  const at = curN == null ? {} : { current: false, upcoming: false }
  const flags = n => (curN == null ? {} : { current: n === curN, upcoming: n > curN })
  const wk = new Map()
  for (const w of probCourse?.weeks || [])
    wk.set(w.n, { n: w.n, week: w.week, weekDir: w.weekDir, page: w.page, topic: w.topic, tutorial: w.tutorial, counts: w.counts, rows: (w.rows || []).map(slim), items: [], ...at, ...flags(w.n) })
  for (const r of rows) {
    const items = r.problems?.items || []
    if (!items.length) continue
    const have = wk.get(r.n)
    if (have) { have.items = items; continue }
    wk.set(r.n, { n: r.n, week: r.label, weekDir: r.dir, page: r.problems.path, topic: null, tutorial: null, counts: null, rows: [], items, ...at, ...flags(r.n) })
  }
  if (!wk.size) return { weeks: [], totals: probCourse?.totals || null, webassign: probCourse?.webassign || null }
  const cut = curN == null ? Infinity : curN + 1
  const all = [...wk.values()]
  const near = all.filter(w => w.n <= cut).sort((a, b) => b.n - a.n), far = all.filter(w => w.n > cut).sort((a, b) => a.n - b.n)
  return { weeks: [...near, ...far], totals: probCourse?.totals || null, webassign: probCourse?.webassign || null }
}

async function announcements(store, key, hub) {
  const index = `${key}/Announcements/Announcements.md`
  const fresh = new Set((hub.news || []).filter(n => n.courseKey === key).map(n => n.page))
  const pages = (await store.pages(`${key}/Announcements/Announcements`)).filter(p => !p.virtual).sort((a, b) => b.title.localeCompare(a.title)).slice(0, 5)
  const items = await Promise.all(pages.map(async p => {
    const md = (await store.readPage(p.path)).blocks.map(b => b.md).join('\n')
    const meta = /^_(\d{4}-\d{2}-\d{2}) · (.*?)_$/m.exec(md), concerns = /^Concerns (.+?)\.?$/m.exec(md), h1 = /^#\s+(.+?)\s*$/m.exec(md)
    const body = md.replace(/^#.*$/m, '').replace(/^_.*_$/gm, '').replace(/^Concerns .*$/m, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
    // the page's own heading keeps the characters a file name cannot ('Plan for next week: Sep 15 + 17')
    return { title: h1?.[1] || p.title.replace(/^\d{4}-\d{2}-\d{2} /, ''), path: p.path, date: meta?.[1] || (/^(\d{4}-\d{2}-\d{2})/.exec(p.title)?.[1] || null), author: meta?.[2] || '', weeks: concerns ? [...concerns[1].matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1]) : [], snippet: body.slice(0, 140), isNew: fresh.has(p.path) }
  }))
  return { index, items }
}

// Exported for /api/week: a task that names a tool ("do the WebAssign set") resolves against the same list there.
export async function links(store, key) {
  const page = `${key}/General/Links.md`
  const pg = await store.readPage(page)
  if (!pg.exists) return { page: null, items: [] }
  return { page, items: [...pg.blocks.map(b => b.md).join('\n').matchAll(LINK_RE)].map(m => ({ label: m[1], url: m[2], module: m[3] || '' })) }
}
