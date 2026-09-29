// The one meeting / test / coverage model (SPEC §20.1). Pure and browser-safe, the src/grade.js pattern:
// the only place COURSES[].meetings is expanded, so a day is a class in every screen or none.
// Imported by scripts/plan.mjs, scripts/lib/calendar.mjs, server/routes/course.js, scripts/review.mjs and
// the client. No I/O, no Date.now() — every function takes its `today` or `now`.
import { COURSES, weeks, weekFor, isoOf, short, TERMS, NO_CLASS, inReadingWeek, inTerm } from '../scripts/lib/terms.mjs'
import { SYLLABUS } from '../scripts/lib/syllabus.mjs'

// A tutorial that works through the previous week's lecture (`tutorialLag: 1` on the course) is the one per-course
// rule the timetable cannot express. It used to live here, in a table keyed on the student's own course codes — which meant
// the app quietly held a piece of course knowledge that setup never wrote and nothing told a new install about. It is
// a field on the course now, in `scripts/lib/terms.mjs`: the one file a new install rewrites (SPEC §20.48).
export const HOLIDAY_NAMES = { '2026-09-07': 'Labour Day', '2026-10-12': 'Thanksgiving', '2027-03-26': 'Good Friday' }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dayOf = iso => new Date(iso + 'T12:00:00')

// ---- dates ----------------------------------------------------------------------------------
export const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
export const addDays = (iso, n) => { const d = dayOf(iso); d.setDate(d.getDate() + n); return isoOf(d) }
export const weekdayOf = iso => DOW[dayOf(iso).getDay()]
export const daysTo = (iso, today) => Math.round((dayOf(iso) - dayOf(today)) / 864e5)
export const relDay = (iso, today) => { const n = daysTo(iso, today); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n} days ago` : `in ${n} days` }
// Client date formatting goes through this, never `short(string)`.
export const shortIso = iso => short(dayOf(iso))
export const meetingId = (courseKey, date, kind) => `${courseKey}|${date}|${kind}`
// The syllabus week a meeting belongs to (tutorials may lag the lecture week).
export const lagOf = (courseKey, courses = COURSES) => courses[courseKey]?.tutorialLag || 0
export const syllabusWeekN = (courseKey, kind, weekN, courses = COURSES) => (kind === 'Tutorial' ? weekN - lagOf(courseKey, courses) : weekN)
const codeOf = (courseKey, c) => c?.code || courseKey.replace(/\s+/g, '').slice(0, 6)

// ---- meetings -------------------------------------------------------------------------------
// Every COURSES[k].meetings row on every date in [from, to] (inclusive ISO dates), cancelled on NO_CLASS days,
// in reading weeks, between terms, before a course's published start, or when the outline says so.
// → [{ id, courseKey, course, color, date, day, start, end, where, kind, week:{n,label,dir}|null,
//      topic:{ text, source, page:null }|null, cancelled:string|null }] sorted by date then start.
// A window wider than this is a caller's mistake, not a request: 'to' = 9999-12-31 walks 2.9 million days, and
// because the walk is synchronous it blocks the event loop and takes the whole server down with it. Two years is
// longer than any screen asks for; beyond it the window is clamped rather than obeyed (SPEC §20.20).
export const MAX_SPAN_DAYS = 800
export function expandMeetings(from, to, { courses = COURSES, syllabus = SYLLABUS } = {}) {
  const out = []
  if (!ISO_RE.test(String(from))) return out
  const last = !ISO_RE.test(String(to)) || daysTo(to, from) > MAX_SPAN_DAYS ? addDays(from, MAX_SPAN_DAYS) : to
  for (let date = from; date <= last; date = addDays(date, 1)) {
    const day = weekdayOf(date)
    for (const [courseKey, c] of Object.entries(courses)) {
      for (const m of c.meetings || []) {
        if (m.day !== day) continue
        const w = inTerm(date) ? weekFor(c.term, date) : null
        const week = w ? { n: w.n, label: w.label, dir: w.dir } : null
        const syl = syllabus[courseKey]?.weeks || null
        const sw = week ? syllabusWeekN(courseKey, m.kind, week.n, courses) : null
        const entry = syl && sw != null ? syl[sw] || null : null
        let cancelled = null
        if (NO_CLASS.includes(date)) cancelled = HOLIDAY_NAMES[date] || 'no classes'
        else if (inReadingWeek(date)) cancelled = 'reading week'
        else if (!week) cancelled = 'between terms'
        else if (syl && sw < Math.min(...Object.keys(syl).map(Number))) {
          const first = weeks(c.term).find(x => x.n === Math.min(...Object.keys(syl).map(Number)) + (m.kind === 'Tutorial' ? lagOf(courseKey, courses) : 0))
          cancelled = `course starts ${first ? short(dayOf(first.monday)) : 'later'} (outline)`
        }
        else if (entry && /^no class/i.test(entry.topic || '')) cancelled = `${entry.topic} (outline)`
        else if (entry && m.kind === 'Tutorial' && /^no tutorial/i.test(entry.tutorial || '')) cancelled = `${entry.tutorial} (outline)`
        const topicText = entry && !/^no class/i.test(entry.topic || '') ? entry.topic : null
        const topic = topicText ? { text: topicText, source: /front page/i.test(syllabus[courseKey]?.source || '') ? 'front page' : 'course outline', page: null } : null
        out.push({ id: meetingId(courseKey, date, m.kind), courseKey, course: codeOf(courseKey, c), color: c.color || null, date, day, start: m.start, end: m.end, where: m.where || '', kind: m.kind, week, topic, cancelled })
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.courseKey.localeCompare(b.courseKey))
}
// The first non-cancelled meeting of a course whose end is at or after `now` (a Date or a local 'YYYY-MM-DDTHH:MM' string).
export function nextMeeting(meetings, courseKey, now) {
  const stamp = typeof now === 'string' ? now.slice(0, 16) : `${isoOf(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return meetings.find(m => (!courseKey || m.courseKey === courseKey) && !m.cancelled && `${m.date}T${m.end}` >= stamp) || null
}

// ---- tests and coverage -----------------------------------------------------------------------
const gradingItems = (courseKey, component) => {
  const comps = COURSES[courseKey]?.grading?.components || []
  return comps.filter(c => !component || c.key === component).flatMap(c => (c.items || []).filter(i => i.date).map(i => ({ ...i, component: c.key })))
}
// The next dated grading item on or after `today` — the tests component by default (`component: null` for any
// dated item), falling back to COURSES[k].tests. → { key, title, date, coverage, assumed, component, courseKey } | null
export function nextTest(courseKey, today, { component = 'tests' } = {}) {
  const items = gradingItems(courseKey, component).filter(i => i.date >= today).sort((a, b) => a.date.localeCompare(b.date))
  if (items.length) { const i = items[0]; return { key: i.key, title: i.label, date: i.date, coverage: i.coverage, assumed: !!i.assumed, component: i.component, courseKey } }
  const t = (COURSES[courseKey]?.tests || []).filter(([d]) => d >= today).sort((a, b) => a[0].localeCompare(b[0]))[0]
  return t ? { key: `test-${t[0]}`, title: t[1].split(' · ')[0], date: t[0], coverage: undefined, assumed: true, component: 'tests', courseKey } : null
}
// The window a test covers. `item.coverage` matching `Weeks a–b` → those term weeks (source 'syllabus'); another
// coverage string ('Chapters 1–3.4') keeps the label with default weeks; none → the week after the previous dated
// item of the same component (else week 1) through the week containing the test (source 'default').
// → { label, weeks:[n], from, to, source:'syllabus'|'default', assumed }
export function coverageWindow(courseKey, item, today) {
  const c = COURSES[courseKey]; if (!c || !item?.date) return null
  const all = weeks(c.term), testWeek = weekFor(c.term, item.date)
  const m = item.coverage && /weeks?\s*(\d+)\s*[–-]\s*(\d+)/i.exec(item.coverage)
  let from = 1, to = testWeek?.n ?? all.length, source = 'default'
  if (m) { from = Number(m[1]); to = Number(m[2]); source = 'syllabus' }
  else {
    const prev = gradingItems(courseKey, item.component || 'tests').filter(i => i.date < item.date).sort((a, b) => a.date.localeCompare(b.date)).pop()
    const pw = prev && weekFor(c.term, prev.date)
    if (pw) from = pw.n + 1
    if (item.coverage) source = 'syllabus'
  }
  const win = all.filter(w => w.n >= from && w.n <= to).map(w => w.n)
  return { label: item.coverage || `Weeks ${from}–${to}`, weeks: win, from, to, source, assumed: !!item.assumed || !m }   // assumed: the weeks are a default, not a published window
}
// This course's future tests: the syllabus (grading items, else COURSES[k].tests) united with hub.tests (Quercus rows carry a url),
// one per date, soonest first, each with inDays, weekN and its coverage window.
export function testsFor(courseKey, hub, today) {
  const c = COURSES[courseKey]; if (!c) return []
  const rows = new Map()
  const put = r => { const cur = rows.get(r.date); rows.set(r.date, cur ? { ...cur, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && v !== '')), title: cur.title, note: cur.note } : r) }
  const items = gradingItems(courseKey, 'tests')
  for (const [date, title] of c.tests || []) { const item = items.find(i => i.date === date); put({ courseKey, course: codeOf(courseKey, c), color: c.color || null, key: item?.key || `test-${date}`, title: item?.label || title.split(' · ')[0], date, note: 'syllabus', url: null, coverage: item?.coverage, assumed: !!item?.assumed }) }
  for (const i of items) if (!rows.has(i.date)) put({ courseKey, course: codeOf(courseKey, c), color: c.color || null, key: i.key, title: i.label, date: i.date, note: 'syllabus', url: null, coverage: i.coverage, assumed: !!i.assumed })
  for (const t of hub?.tests || []) if (t.courseKey === courseKey && t.date) put({ courseKey, course: t.course || codeOf(courseKey, c), color: c.color || null, key: `quercus-${t.date}`, title: t.title, date: t.date, note: t.note || 'from Quercus', url: t.url || null })
  return [...rows.values()].filter(r => r.date >= today).sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({ ...r, inDays: daysTo(r.date, today), weekN: weekFor(c.term, r.date)?.n ?? null, window: coverageWindow(courseKey, { date: r.date, coverage: r.coverage, assumed: r.assumed, component: 'tests' }, today) }))
}
export { TERMS, NO_CLASS, inReadingWeek, inTerm }
