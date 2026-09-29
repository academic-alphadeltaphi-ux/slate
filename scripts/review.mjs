#!/usr/bin/env node
// The Sunday review (SPEC §20.5): read the week back and write Hub/Review/Sunday review · <date>.md.
//   node scripts/review.mjs [--root /path] [--date YYYY-MM-DD] [--since ISO] [--dry-run] [--json]
// Deterministic and connector-free: no Canvas, no Gmail, no Google Calendar. Reads the course notebooks, Hub/_hub.json,
// _sync-state.json, _study-queue.json, _problems.json, _plan.json, _calendar.json, the Desktop session folders, terms.mjs
// and syllabus.mjs. Writes the review page (two containers, no sidecar), Hub/Review/_slate.json, and adds Review to
// Hub/_slate.json — every write is `.tmp-<name>-<hex>` in the same folder then rename, so the watcher never sees a half
// file. The Plan paragraph is a placeholder the Claude pass (scripts/review-prompt.md) replaces; everything else here
// is computed and overwritten. A page the student wrote containers or ink on is left alone. Exit 0 even without a hub; exit 1
// only when the root is unreadable or a write fails. With --json the last stdout line is the summary.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { COURSES, WEEK_PAGES, weeks, weekFor, isoOf, localStamp, todayIso, inReadingWeek } from './lib/terms.mjs'
import { THIS as ED } from '../src/edition.js'
import { notesRoot } from './lib/root.mjs'
import { sessionsFor, sessionKey } from './lib/sessions.mjs'
import { readJson, writeAtomic } from './lib/problems.mjs'
import { standing, neededFor } from '../src/grade.js'
import { expandMeetings, testsFor, addDays, weekdayOf, daysTo, shortIso } from '../src/calendar.js'
import { parsePage, parseTasks, newId } from '../server/format.js'
import { guardFlags } from './lib/argv.mjs'
import { weekOf } from './lib/work.mjs'

guardFlags(['--date', '--dry-run', '--json', '--root', '--since'])

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 || i + 1 >= args.length ? d : args[i + 1] }
const DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json')
const ROOT = notesRoot(process.argv)
const HUB = path.join(ROOT, 'Hub'), DIR = path.join(HUB, 'Review')
const DATE = flag('--date', todayIso())                                  // the page's date and "today"
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error('--date must be YYYY-MM-DD'); process.exit(2) }
// The window ends now when the review is about today, else at 18:00 of the day it is about. `SLATE_NOW` pins the clock, so the
// suite tests the same run on any day — including 13 September, the Sunday its fixture is built around.
const NOW = process.env.SLATE_NOW ? new Date(process.env.SLATE_NOW) : DATE === todayIso() ? new Date() : new Date(`${DATE}T18:00:00`)
const TITLE = `Sunday review · ${DATE}`                                   // the file name; ⌘K finds "sunday", ReviewLink the date suffix
const REL = `Hub/Review/${TITLE}.md`
// The one line the Claude pass replaces. scripts/review-prompt.md quotes it byte for byte (scripts/test-review.mjs checks).
const PLACEHOLDER = '*Not written yet — the Sunday pass adds a short plan here.*'   // the editor's own italics: a saved page keeps it byte for byte
const isPlaceholder = s => s === PLACEHOLDER || s === PLACEHOLDER.replace(/^\*|\*$/g, '_')
const QUIET_DAYS = 14, WINDOW_MAX_DAYS = 14, MAX_ROWS = 10, TEST_SOON_DAYS = 21
const REVIEW_FILE = /^(?:Sunday review · )?(\d{4}-\d{2}-\d{2})\.md$/     // today's shape, and the bare-date shape of the first design
const SIDECAR_RE = /\.(srt|vtt|txt|json)$/i                               // transcript sidecars and the app's .pdf.txt caches
const AUDIO_RE = /\.(m4a|mp3|wav|aac|ogg|flac|aiff|caf|mp4|mov|webm)$/i
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const TZ = 'America/Toronto'
const log = (...a) => { if (!JSON_OUT) console.log(...a) }
const reserved = n => n.startsWith('.') || n.startsWith('_')

// ---- formatting (own helpers, so the page reads the same on every Node/ICU) ---------------------------------------------
const fmtDay = iso => `${weekdayOf(iso)}, ${shortIso(iso)}`                                     // 'Tue, Sep 15'
const fmtDate = d => fmtDay(isoOf(d))
const fmtStamp = d => { const h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0'); return `${fmtDate(d)}, ${h % 12 || 12}:${m} ${h < 12 ? 'a.m.' : 'p.m.'}` }
const longDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_LONG[m - 1]} ${y}` }
const inDays = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n} days ago` : `in ${n} days`)
const count = (k, s, p = s + 's') => `${k} ${k === 1 ? s : p}`
const torontoDate = iso => { const d = new Date(iso); if (Number.isNaN(d.getTime())) return null; return /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? String(iso) : new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) }
const torontoTime = iso => { const d = new Date(iso); if (Number.isNaN(d.getTime()) || /^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return null; return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d) }
const asDate = v => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d }
// Wikilinks. An announcement title is unique and matches by title; anything else carries its full path from the root with a
// short alias (`[[ECO 208Y1/Fall 2026/Week 2 (Sep 14)/Problems|Problems]]`) because Hub is not the page's notebook and
// "Session 1 (2026-09-08)" names both a deck and a sheet (App.openTitle: exact path first, then suffix, same notebook preferred).
const wl = (rel, alias) => { const t = String(rel).replace(/\.md$/, ''); const a = alias || t.split('/').pop(); return a === t ? `[[${t}]]` : `[[${t}|${a}]]` }
const bold = s => `**${s}**`

// ---- root -------------------------------------------------------------------------------------------------------------
try { await fs.access(ROOT) } catch { console.error(`cannot read ${ROOT}`); process.exit(1) }
const hub = await readJson(path.join(HUB, '_hub.json'), null)
const sync = await readJson(path.join(HUB, '_sync-state.json'), null)
const queue = await readJson(path.join(HUB, '_study-queue.json'), { ready: [], blocked: [] })
const problemsReg = await readJson(path.join(HUB, '_problems.json'), null)
const plan = await readJson(path.join(HUB, '_plan.json'), null)
const calendar = await readJson(path.join(HUB, '_calendar.json'), null)
const WEEKS = weeks('Y'), thisWeek = weekFor('Y', DATE)

// ---- the window: from the previous review's `until`, else the sync run of the day before (SPEC §20.5, critique) --------
async function previousUntil() {
  const names = (await fs.readdir(DIR).catch(() => [])).map(f => ({ f, d: REVIEW_FILE.exec(f)?.[1] })).filter(x => x.d && x.d < DATE).sort((a, b) => a.d.localeCompare(b.d))
  for (const x of names.reverse()) {
    const fm = parsePage(await fs.readFile(path.join(DIR, x.f), 'utf8').catch(() => '')).frontmatter || {}
    if (fm.until && asDate(fm.until)) return String(fm.until)
  }
  return null
}
function firstWindow() {
  // The first review has nothing to tile from. The restructure stamps every page and file with the same day, so a whole
  // week from Monday 00:00 would list the entire notebook as "landed"; the sync's run of the day before is the honest start.
  const lr = asDate(sync?.lastRun)
  if (lr) { if (isoOf(lr) >= DATE) lr.setDate(lr.getDate() - 1); if (NOW - lr <= WINDOW_MAX_DAYS * 864e5 && lr < NOW) return { since: localStamp(lr), from: 'the sync run of the day before' } }
  const mon = thisWeek ? new Date(`${thisWeek.monday}T00:00:00`) : new Date(NOW.getTime() - 7 * 864e5)
  return { since: localStamp(mon), from: thisWeek ? 'Monday' : 'seven days back' }
}
const prevUntil = await previousUntil()
let sinceFrom = 'the previous review'
let since = flag('--since', null)
if (since) { if (!asDate(since)) { console.error('--since must be an ISO stamp'); process.exit(2) } sinceFrom = '--since' }
else if (prevUntil && NOW - new Date(prevUntil) < WINDOW_MAX_DAYS * 864e5 && new Date(prevUntil) < NOW) since = prevUntil
else { const w = firstWindow(); since = w.since; sinceFrom = w.from }
const until = localStamp(NOW)
const sinceDate = new Date(since), untilDate = new Date(until)
const inWindow = v => { const d = asDate(v); return !!d && d >= sinceDate && d <= untilDate }

// ---- next week ---------------------------------------------------------------------------------------------------------
const nextMon = addDays(DATE, ((8 - new Date(`${DATE}T12:00:00`).getDay()) % 7) || 7)
const nextSun = addDays(nextMon, 6)
const nextWeek = WEEKS.find(w => w.monday === nextMon) || null
const nextLabel = nextWeek ? `${nextWeek.label.replace(/ \(.*/, '')} (${nextWeek.span})` : inReadingWeek(nextMon) ? 'Reading week — no classes' : 'Between terms — no classes'
// Meetings from _plan.json when it covers next week (announced rooms, cancellations, the Plan tasks); the timetable otherwise.
const planCovers = !!plan && plan.from <= nextMon && plan.to >= nextSun && Array.isArray(plan.meetings)
const meetingsNext = planCovers
  ? plan.meetings.filter(m => m.date >= nextMon && m.date <= nextSun)
  : expandMeetings(nextMon, nextSun).map(m => ({ ...m, announced: null, before: [], problems: null, sources: [], tasks: null }))
const timeOf = m => (m.announced?.start ? `${m.announced.start}–${m.announced.end || m.end}` : m.start ? `${m.start}–${m.end}` : 'time tbc')
const whereOf = m => m.announced?.where || m.where || ''

// ---- one course: walk, place, classify ---------------------------------------------------------------------------------
async function walk(dir, out = [], rel = []) {
  const ents = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
  for (const e of ents) {
    if (reserved(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.endsWith('.assets')) {
        const page = [...rel, e.name.slice(0, -'.assets'.length) + '.md']
        for (const a of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) if (a.isFile() && !reserved(a.name)) out.push({ kind: 'asset', abs: path.join(p, a.name), name: a.name, page, st: await fs.stat(path.join(p, a.name)) })
      } else await walk(p, out, [...rel, e.name])
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const text = await fs.readFile(p, 'utf8'), st = await fs.stat(p), { frontmatter, blocks } = parsePage(text)
      out.push({ kind: 'md', abs: p, parts: [...rel, e.name], st, fm: frontmatter || {}, text, blocks, md: blocks.map(b => b.md).join('\n'), hasAnchor: text.includes('<!-- slate:block ') })
    }
  }
  return out
}
// Where a file sits in the course tree: its term week (or null), the sub-section, the title.
function place(term, parts) {
  const week = weeks(term).find(w => parts[0] === w.term && (parts[1] === w.label || parts[1] === `${w.label}.md`)) || null
  const title = parts.at(-1).replace(/\.md$/, '')
  const sub = week ? (parts.length > 2 ? parts[2].replace(/\.md$/, '') : null) : parts[0]
  return { week, title, sub, depth: parts.length, rel: parts.join('/'), isWeekPage: !!week && parts.length === 2, isAnn: parts[0] === 'Announcements' && parts[1] === 'Announcements' && parts.length === 3 }
}
const where = p => (p.week ? (p.depth >= 4 ? `${p.week.label} · ${p.sub}` : p.week.label) : p.sub)
const SCAFFOLD = new Set([...WEEK_PAGES.map(([n]) => n), 'Announcements', 'Links', 'Home'])
// Scaffold pages never count as new; a week's Problems/Plan page is a script's and is counted through its JSON instead.
const isScaffold = p => SCAFFOLD.has(p.title) || /^Week \d+ \(.+\)$/.test(p.title) || (!!p.week && p.depth === 3 && ['Problems', 'Plan'].includes(p.title))
const bodyText = it => it.md.split('\n').filter(l => l.trim() && !/^#\s/.test(l) && !/^(_[^_]|\*[^*]).*(_|\*)$/.test(l.trim())).join('\n').trim()
const tagsOf = it => (Array.isArray(it.fm.tags) ? it.fm.tags.map(String) : [])

function landed(course, info, items) {
  const L = { announcements: [], files: [], recordings: [], transcripts: [], sheets: [], pagesNew: [], pagesEdited: 0, graded: [] }
  let last = null
  const bump = v => { const d = asDate(v); if (d && (!last || d > last)) last = d }
  for (const it of items) {
    if (it.kind === 'asset') {
      const p = place(info.term, it.page), base = it.name
      if (base === `${p.title}.transcript.json`) { if (inWindow(it.st.mtime)) L.transcripts.push({ title: p.title, rel: p.rel, minutes: null, abs: it.abs }); continue }
      if (SIDECAR_RE.test(base) || /\.pdf\.txt$/i.test(base)) continue
      if (p.sub === 'Study sheets') continue                       // the sheet's own printout, reported as the sheet
      bump(it.st.mtime)
      if (!inWindow(it.st.mtime)) continue
      const row = { name: base, title: p.title, rel: p.rel, where: where(p) }
      if (AUDIO_RE.test(base)) L.recordings.push(row); else L.files.push(row)
      continue
    }
    const p = place(info.term, it.parts), created = asDate(it.fm.created)
    if (p.isAnn) {
      bump(created)
      if (inWindow(created)) L.announcements.push({ title: p.title, at: created, weeks: [...new Set([...it.text.matchAll(/\[\[(Week \d+ \([^)]+\))\]\]/g)].map(m => m[1]))] })
      continue
    }
    if (tagsOf(it).includes('quercus')) bump(created)
    if (p.week && p.sub === 'Study sheets' && p.depth === 4) { if (inWindow(created)) L.sheets.push({ title: p.title, rel: p.rel, week: p.week.label }); continue }
    if (inWindow(created)) { if (!isScaffold(p) && bodyText(it)) L.pagesNew.push({ title: p.title, rel: p.rel, where: where(p) }) }
    else if (created && created < sinceDate && inWindow(it.st.mtime) && it.hasAnchor) L.pagesEdited++   // "the student wrote on it", the pipeline's own rule
  }
  L.quietDays = last ? Math.floor((NOW - last) / 864e5) : null
  L.lastLanded = last
  return L
}
const queueLabel = new Map([
  ...(queue.ready || []).map(r => [r.key, r.confirmed ? 'ready · confirmed, builds at 10:00' : 'ready · awaiting your confirmation on Home']),
  ...(queue.blocked || []).map(b => [b.key, `blocked: ${b.blocked}`])])
async function unreviewedSessions(course, info, items) {
  const U = []
  // Every line this builds is about a study sheet. In an edition that has none, the queue is always empty, so every
  // session would be listed as "not in the queue yet" and every week as "nothing was flagged for a sheet" — a whole
  // section of a brother's review about a feature they do not have (SPEC §20.48).
  if (!ED.sheets) return U
  const sessions = (await sessionsFor(course, info.term, ROOT)).filter(s => s.date <= DATE)
  for (const s of sessions) if (!sync?.sheets?.[sessionKey(course, s)]) U.push(`Session ${s.n} (${s.date}) — ${queueLabel.get(sessionKey(course, s)) || 'not in the queue yet: run the morning sync'}`)
  for (const w of weeks(info.term).filter(w => w.monday <= DATE)) {
    if (sessions.some(s => s.week?.n === w.n)) continue
    const material = items.filter(it => it.kind === 'md' && (p => p.week?.n === w.n && p.depth === 4 && ['Lectures', 'Recordings'].includes(p.sub))(place(info.term, it.parts)))
    if (material.length) U.push(`${w.label} — ${count(material.length, 'file page')} but no Desktop session folder, so nothing was flagged for a sheet`)
  }
  return U
}
// Every page under a week folder holding depth-0 task items, with its tick count — whatever the page is called. A
// Problems page the problems registry knows is counted from Hub/_problems.json instead (attempted, not `reviewed`).
function taskPages(course, info, items, keep) {
  const out = []
  for (const it of items) {
    if (it.kind !== 'md') continue
    const p = place(info.term, it.parts); if (!p.week || !keep(p.week)) continue
    const rel = `${course}/${p.rel}`
    if (p.depth === 3 && p.title === 'Problems' && problemsReg?.pages?.[rel]) continue
    const tasks = parseTasks(it.md); if (!tasks.length) continue
    const known = (plan?.pages || []).find(x => x.path === rel && x.exists)
    out.push({ title: p.title, rel, week: p.week, done: known ? known.tasks.done : tasks.filter(t => t.done).length, total: known ? known.tasks.total : tasks.length })
  }
  return out
}
function problemsWeeks(course, info, keep) {
  const c = problemsReg?.courses?.[course]; if (!c) return []
  return (c.weeks || []).map(w => ({ ...w, wk: weeks(info.term).find(x => x.n === w.n) || null })).filter(w => w.wk && keep(w.wk) && w.counts?.assigned > 0)
}
const problemsLine = (course, w) => {
  const open = (w.rows || []).filter(r => !r.attempted).map(r => r.label)
  const set = problemsReg?.courses?.[course]?.webassign?.sets?.find(s => s.n === w.n)
  const extra = set ? ` · posts ${fmtDay(set.posts)}, due ${fmtDay(set.due)}${set.confirmed === false ? ' (date unconfirmed)' : ''}` : ''
  return `${wl(w.page, 'Problems')} (${w.week}) — ${w.counts.attempted} of ${w.counts.assigned} attempted${w.counts.reviewed ? `, ${w.counts.reviewed} reviewed` : ''}${open.length ? ` · ${open.slice(0, 6).join(' · ')}${open.length > 6 ? ' · …' : ''}` : ''}${extra}`
}
// `[[X]]` inside a Plan task copied from _plan.json points inside the course notebook; from the Hub it needs the full path.
function linkResolver(course, items) {
  const pages = items.filter(it => it.kind === 'md').map(it => it.parts.join('/').replace(/\.md$/, ''))
  return text => String(text).replace(/\[\[([^\]|]+)\]\]/g, (m, x) => {
    const want = x.trim(), hit = pages.find(r => r === want || r.endsWith('/' + want)) || pages.find(r => r.split('/').pop() === want)
    return hit ? wl(`${course}/${hit}`, want.split('/').pop()) : m
  })
}
function prep(course, info, items) {
  if (!nextWeek) return []
  const P = [], resolve = linkResolver(course, items)
  // Each thing to prepare is its own line with its own box, so the review is a list you can work through rather than a
  // paragraph about work (SPEC §20.38). The box starts where the Plan page has it.
  for (const m of meetingsNext.filter(m => m.courseKey === course && !m.cancelled)) {
    const tasks = (m.before || []).filter(t => !t.stale || t.done)
    const topic = m.topic?.text ? ` — ${m.topic.text}` : ''
    if (topic) P.push({ t: `${bold(`${m.day} ${m.kind}`)}${topic}` })
    for (const t of tasks) P.push({ t: `${m.day} ${m.kind} · ${resolve(t.text)}`, task: true, done: !!t.done })
  }
  for (const w of problemsWeeks(course, info, w => w.n === nextWeek.n)) P.push({ t: problemsLine(course, w) })
  for (const t of taskPages(course, info, items, w => w.n === nextWeek.n)) P.push({ t: `${wl(t.rel, t.title)} — ${t.done} of ${t.total} ticked` })
  const weekPage = items.find(it => it.kind === 'md' && it.parts.length === 2 && it.parts[0] === nextWeek.term && it.parts[1] === `${nextWeek.label}.md`)
  const links = new Set([...(weekPage ? [...weekPage.md.matchAll(/^- \[\[([^\]|]+)\]\]/gm)].map(m => m[1]) : []), ...meetingsNext.filter(m => m.courseKey === course).flatMap(m => m.sources || []).map(s => path.posix.basename(s, '.md'))])
  if (links.size) P.push({ t: `From announcements: ${[...links].map(l => `[[${l}]]`).join(', ')}` })
  return P.length ? P : [{ t: 'Nothing to prepare on disk yet' }]
}

// ---- standing, from grade.js (never from _hub.json.standing: JSON lost its Infinity) --------------------------------------
function standingLine(key, info) {
  if (!hub) return 'no hub yet — run the morning sync'
  const scores = (hub.courses || []).find(c => c.key === key)?.scores || {}
  if (!info.grading) return 'no grading scheme on file'
  const st = standing(info.grading, scores)
  if (st.best?.grade == null) return 'nothing graded yet'
  const need = neededFor(info.grading, scores, 80)
  return `${st.best.grade.toFixed(1)}% (${st.letter}) with ${st.best.weightKnown}% of the course written · ${st.best.name}` + (need == null ? '' : need === Infinity ? ' · A- no longer reachable' : need <= 0 ? ' · A- is locked in' : ` · need ${need.toFixed(0)} on the rest for A-`)
}
const testsByCourse = Object.fromEntries(Object.keys(COURSES).map(k => [k, testsFor(k, hub, DATE)]))
const testLine = t => `${bold(t.course)} ${t.title} — ${fmtDay(t.date)} · ${inDays(t.inDays)}${t.window?.label ? ` · ${t.window.label}${t.window.assumed ? ' (assumed)' : ''}` : ''}`

// ---- assemble ------------------------------------------------------------------------------------------------------------
const summary = { date: DATE, path: REL, title: TITLE, since, until, sinceFrom, week: thisWeek?.label || null, nextWeek: nextWeek ? nextWeek.label : nextLabel.split(' — ')[0].toLowerCase(), nextWeekSource: nextWeek ? (planCovers ? 'plan' : 'timetable') : null, courses: {}, quiet: [], plan: 'placeholder', kept: false, email: { send: false, reasons: [] }, dry: DRY }
const nextSection = [], perCourse = []
let anyLanded = 0, anyUnreviewed = 0
for (const [course, info] of Object.entries(COURSES)) {
  const items = await walk(path.join(ROOT, course))
  const L = landed(course, info, items)
  for (const t of L.transcripts) t.minutes = (await readJson(t.abs, {})).minutes ?? null
  for (const g of (hub?.grades?.recent || []).filter(g => g.courseKey === course && inWindow(g.gradedAt))) L.graded.push(g)
  const U = await unreviewedSessions(course, info, items)
  const past = w => w.monday <= DATE
  const T = taskPages(course, info, items, past).filter(t => t.done < t.total)
  const PW = problemsWeeks(course, info, past).filter(w => w.counts.attempted < w.counts.assigned)
  if (nextWeek) {
    const mine = meetingsNext.filter(m => m.courseKey === course)
    const head = mine.length ? mine.map(m => (m.cancelled ? `~~${fmtDay(m.date)} ${m.kind}~~ (${m.cancelled})` : `${fmtDay(m.date)} ${timeOf(m)} ${m.kind}${whereOf(m) ? ` · ${whereOf(m)}` : ''}`)).join(' · ') : 'no classes'
    nextSection.push(`${bold(info.code)} · ${head}`, '', ...prep(course, info, items).map(x => (x.task ? `- [${x.done ? 'x' : ' '}] ${x.t}` : `- ${x.t}`)), '')
  }
  const counts = [count(L.announcements.length, 'announcement'), count(L.files.length, 'file'), count(L.recordings.length, 'recording'), count(L.transcripts.length, 'transcript'), count(L.sheets.length, 'study sheet'), count(L.graded.length, 'mark'), count(L.pagesNew.length, 'new page'), count(L.pagesEdited, 'page edited', 'pages edited')].filter(s => !s.startsWith('0 '))
  const cap = (rows, what) => (rows.length > MAX_ROWS ? [...rows.slice(0, MAX_ROWS), `- … and ${count(rows.length - MAX_ROWS, what)}`] : rows)
  const rows = [
    ...cap(L.announcements.map(a => `- announcement [[${a.title}]] · ${fmtDate(a.at)}${a.weeks.length ? ` · concerns ${a.weeks.join(', ')}` : ''}`), 'announcement'),
    ...cap(L.files.map(f => `- file ${f.name} → ${wl(`${course}/${f.rel}`, f.title)} · ${f.where}`), 'file'),
    ...cap(L.recordings.map(r => `- recording ${wl(`${course}/${r.rel}`, r.title)} · ${r.where}`), 'recording'),
    ...cap(L.transcripts.map(t => `- transcribed ${wl(`${course}/${t.rel}`, t.title)}${t.minutes ? ` · ${t.minutes} min` : ''}`), 'transcript'),
    ...cap(L.sheets.map(s => `- study sheet ${wl(`${course}/${s.rel}`, s.title)} · ${s.week}`), 'study sheet'),
    ...cap(L.graded.map(g => `- graded ${g.item} — ${g.score}/${g.possible}`), 'mark'),
    ...cap(L.pagesNew.map(p => `- new page ${wl(`${course}/${p.rel}`, p.title)} · ${p.where}`), 'new page')]
  const quiet = L.quietDays != null && L.quietDays >= QUIET_DAYS
  if (quiet) { summary.quiet.push(info.code); rows.push(`- Nothing has arrived for ${info.code} since ${fmtDate(L.lastLanded)} (${L.quietDays} days): is the sync missing something, or has nothing been posted?`) }
  const un = [...U.map(u => `- ${u}`), ...PW.map(w => `- ${problemsLine(course, w)}`), ...T.map(t => `- ${wl(t.rel, t.title)} (${t.week.label}) — ${t.done} of ${t.total} ticked`)]
  perCourse.push([`## ${info.code} · ${info.name}`, '', `${bold('Landed this week')} — ${counts.join(' · ') || 'nothing'}`, '', ...(rows.length ? rows : ['- Nothing new.']), '', bold('Unreviewed'), '', ...(un.length ? un : ['- Nothing outstanding.'])].join('\n'))
  const landedN = L.announcements.length + L.files.length + L.recordings.length + L.transcripts.length + L.sheets.length + L.graded.length + L.pagesNew.length
  anyLanded += landedN; anyUnreviewed += un.length
  summary.courses[info.code] = {
    landed: { announcements: L.announcements.length, files: L.files.length, recordings: L.recordings.length, transcripts: L.transcripts.length, sheets: L.sheets.length, pagesNew: L.pagesNew.length, pagesEdited: L.pagesEdited, graded: L.graded.length },
    unreviewed: un.length, openTasks: T.reduce((s, t) => s + t.total - t.done, 0) + PW.reduce((s, w) => s + w.counts.assigned - w.counts.attempted, 0), quietDays: L.quietDays,
  }
}
// Planned against done (SPEC §22): what each day's plan held, what the timer and the "how long?" answers recorded, how
// the estimates ran per kind, which days were finished. Read from Hub/_day-log.json and Hub/_work-log.json.
const workWeek = ED.work === false ? null : await weekOf(ROOT, DATE).catch(() => null)
const h = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`)
function workSection(w) {
  const days = w.days.filter(d => d.plannedTotal || d.doneTotal)
  if (!days.length) return '- No day was planned or worked this week.'
  const byCourse = {}
  for (const d of w.days) { for (const [k, v] of Object.entries(d.planned)) { byCourse[k] ||= { planned: 0, done: 0 }; byCourse[k].planned += v } for (const [k, v] of Object.entries(d.done)) { byCourse[k] ||= { planned: 0, done: 0 }; byCourse[k].done += v } }
  const P = Object.values(byCourse).reduce((n, c) => n + c.planned, 0), Dn = Object.values(byCourse).reduce((n, c) => n + c.done, 0)
  const lines = [`- ${bold('Planned')} ${h(P)} · ${bold('done')} ${h(Dn)}${P ? ` (${Math.round((100 * Dn) / P)}%)` : ''} · ${count(w.days.filter(d => d.finished).length, 'day')} finished of ${count(days.length, 'day')} planned`]
  for (const [k, c] of Object.entries(byCourse).sort((a, b) => b[1].planned - a[1].planned)) lines.push(`- ${bold(COURSES[k]?.code || k)} — planned ${h(c.planned)}, done ${h(c.done)}${c.planned ? ` (${Math.round((100 * c.done) / c.planned)}%)` : ''}`)
  for (const d of days) lines.push(`- ${fmtDay(d.date)}: planned ${h(d.plannedTotal)}${d.target ? ` of a ${h(d.target)} target` : ''}, done ${h(d.doneTotal)}${d.finished ? ' · finished' : ''}${d.by === 'claude' ? '' : d.by ? ` · ${d.by}` : ' · not decided'}`)
  const kinds = Object.entries(w.kinds || {}).filter(([, v]) => v?.n).sort((a, b) => b[1].n - a[1].n)
  if (kinds.length) lines.push(`- ${bold('Estimates')}: ${kinds.map(([k, v]) => `${k} runs ${v.ratio}× (${count(v.n, 'session')})`).join(' · ')}`)
  return lines.join('\n')
}
const testsNext = Object.values(testsByCourse).flat().filter(t => t.date >= nextMon && t.date <= nextSun).sort((a, b) => a.date.localeCompare(b.date))
const dueNext = (hub?.deadlines || []).map(d => ({ ...d, dueDate: d.dueDate || torontoDate(d.due) })).filter(d => !d.submitted && d.dueDate && d.dueDate >= nextMon && d.dueDate <= nextSun).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
const calNext = (calendar?.events || []).filter(e => e && !e.slate).map(e => ({ ...e, date: torontoDate(e.start), time: e.allDay ? null : torontoTime(e.start), endTime: e.allDay ? null : torontoTime(e.end) })).filter(e => e.date && e.date >= nextMon && e.date <= nextSun).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')))
const issues = (plan?.issues || []).length
const calStale = !!asDate(calendar?.updatedAt) && NOW - new Date(calendar.updatedAt) > 864e5   // the prompt then reads the connector instead
const nextTests = Object.values(testsByCourse).flat().sort((a, b) => a.date.localeCompare(b.date) || a.course.localeCompare(b.course)).slice(0, 6)
const md = [
  `# Sunday review · ${longDate(DATE)}`,
  `*${thisWeek ? `${thisWeek.label.replace(/ \(.*/, '')} (${thisWeek.span})` : 'Between terms'} · since ${fmtStamp(sinceDate)} · computed ${fmtStamp(NOW)} from the notebooks, the Hub and the Desktop session folders. Only the Plan is written by Claude.*`,
  '## Plan',
  'PLAN_GOES_HERE',
  `<!-- slate:block ANCHOR_GOES_HERE -->\n## Next week · ${nextLabel}`,
  ...(nextWeek ? [nextSection.join('\n').replace(/\n+$/, '')] : []),
  `Tests next week: ${testsNext.map(t => `${bold(t.course)} ${t.title} (${fmtDay(t.date)})`).join(' · ') || 'none'}. Due next week: ${dueNext.map(d => `${bold(d.course)} ${d.title} (${fmtDay(d.dueDate)}${d.confirmed !== false && (d.dueTime || torontoTime(d.due)) ? ` ${d.dueTime || torontoTime(d.due)}` : ''})`).join(' · ') || 'none'}.`,
  ...(calNext.length ? [`Your calendar${calStale ? ` (readback of ${fmtStamp(new Date(calendar.updatedAt))})` : ''}: ${calNext.map(e => `${fmtDay(e.date)}${e.time ? ` ${e.time}${e.endTime ? `–${e.endTime}` : ''}` : ' all day'} ${e.title}${e.location ? ` · ${e.location}` : ''}`).join(' · ')}.`] : []),
  '## Standing',
  Object.entries(COURSES).map(([key, info]) => { const t = testsByCourse[key][0]; return `- ${bold(info.code)} — ${standingLine(key, info)}${t ? ` · next: ${t.title}, ${fmtDay(t.date)} (${inDays(t.inDays)})` : ''}` }).join('\n'),
  ...(ED.work !== false && workWeek ? ['## Work this week', workSection(workWeek)] : []),
  '## Next tests',
  [...(hub ? [] : ['*No hub yet — dates from the syllabus only; run the morning sync.*']), ...(nextTests.length ? nextTests.map(t => `- ${testLine(t)}`) : ['- No test dates known yet.'])].join('\n'),
  ...perCourse,
].join('\n\n')

// ---- keep what the student or Claude already wrote on today's page ------------------------------------------------------------
const pagePath = path.join(DIR, `${TITLE}.md`)
const oldText = await fs.readFile(pagePath, 'utf8').catch(() => ''), old = parsePage(oldText)
const inked = ((await readJson(path.join(DIR, `${TITLE}.blocks.json`), { elements: [] })).elements || []).some(e => e?.type === 'ink')
if (oldText && (old.blocks.length > 2 || inked)) {
  summary.kept = true
  const oldPlan = /## Plan\n+([\s\S]*?)\s*$/.exec(old.blocks[0]?.md || '')?.[1]?.trim()
  if (oldPlan && !isPlaceholder(oldPlan)) summary.plan = 'kept'
  log(`left alone: ${REL} has your own containers or ink`)
} else {
  const oldPlan = /## Plan\n+([\s\S]*?)\s*$/.exec(old.blocks[0]?.md || '')?.[1]?.trim()
  const planText = oldPlan && !isPlaceholder(oldPlan) ? oldPlan : PLACEHOLDER
  if (planText !== PLACEHOLDER) summary.plan = 'kept'
  const anchor = old.blocks[1]?.id || newId()
  const created = old.frontmatter?.created ? String(old.frontmatter.created) : until
  const fm = `---\ncreated: "${created}"\nkind: "summary"\ntags: ["review"]\n${thisWeek ? `week: "${thisWeek.label}"\n` : ''}since: "${since}"\nuntil: "${until}"\n---\n`
  // A box you ticked on this page stays ticked when the page is computed again: the Plan page's state seeds it, yours wins.
  const ticked = new Set([...oldText.matchAll(/^- \[x\] (.+)$/gim)].map(m => m[1].trim()))
  const text = (fm + md.replace('PLAN_GOES_HERE', planText).replace('ANCHOR_GOES_HERE', anchor) + '\n')
    .replace(/^- \[ \] (.+)$/gm, (line, t) => (ticked.has(t.trim()) ? `- [x] ${t}` : line))
  if (!DRY) { try { await writeAtomic(pagePath, text) } catch (e) { console.error(`cannot write ${REL}: ${e.message}`); process.exit(1) } }
}
// ---- the email rule (the morning's, SPEC §20.5): send when anything landed, is unreviewed, is unplaced, a test is near ----
const soon = Object.values(testsByCourse).flat().filter(t => t.inDays <= TEST_SOON_DAYS).length
if (anyLanded) summary.email.reasons.push(`${count(anyLanded, 'item')} landed`)
if (anyUnreviewed) summary.email.reasons.push(`${count(anyUnreviewed, 'item')} unreviewed`)
if (issues) summary.email.reasons.push(`${count(issues, 'sentence')} not placed`)
if (soon) summary.email.reasons.push(`${count(soon, 'test')} within ${TEST_SOON_DAYS} days`)
if (summary.quiet.length) summary.email.reasons.push(`quiet: ${summary.quiet.join(', ')}`)
summary.email.send = summary.email.reasons.length > 0
// ---- order files ------------------------------------------------------------------------------------------------------------
const reviews = (await fs.readdir(DIR).catch(() => [])).map(f => ({ f, d: REVIEW_FILE.exec(f)?.[1] })).filter(x => x.d)
if (!DRY && !reviews.some(x => x.f === `${TITLE}.md`)) reviews.push({ f: `${TITLE}.md`, d: DATE })   // a fresh folder, written a moment ago
const order = reviews.sort((a, b) => b.d.localeCompare(a.d) || a.f.localeCompare(b.f)).map(x => x.f.slice(0, -3))
const reviewMeta = { order, label: "One page per Sunday review, newest first. Written by scripts/review.mjs at 18:00 on Sundays; only the Plan paragraph is Claude's, the rest is computed and overwritten." }
const hubMeta = await readJson(path.join(HUB, '_slate.json'), { order: ['Today'] })
try {
  if (!DRY && reviews.length) await writeAtomic(path.join(DIR, '_slate.json'), JSON.stringify(reviewMeta, null, 2) + '\n')
  if (!DRY && !(hubMeta.order || []).includes('Review')) { hubMeta.order = [...(hubMeta.order || []), 'Review']; await writeAtomic(path.join(HUB, '_slate.json'), JSON.stringify(hubMeta, null, 2) + '\n') }
} catch (e) { console.error(`cannot write the order files: ${e.message}`); process.exit(1) }
log(`${summary.kept ? 'kept' : DRY ? 'would write' : 'wrote'} ${REL} · window ${since} → ${until} (from ${sinceFrom})${DRY ? ' (dry run, nothing written)' : ''}`)
log(`email: ${summary.email.send ? `send — ${summary.email.reasons.join(', ')}` : 'quiet week, page and reply only'}`)
if (JSON_OUT) console.log(JSON.stringify(summary))
