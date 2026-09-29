// The timer, the work log and the attendance (SPEC §22): what the student actually did with his day, kept beside what Claude
// planned for it. Three files, all the student's own facts — never a decision:
//   Hub/_work-log.json    one session per thing worked on (the timer, or the "how long did it take?" answer on a tick),
//                          the calibration the sessions teach (how far each course's and kind's estimates run over), and
//                          the session running now, so a reload or a restart does not lose it
//   Hub/_attendance.json  one entry per class he answered "were you there?" for
//   Hub/_day-log.json     what each day's plan held, one line per date (written by day.mjs writeDay), so a week can be
//                          read back as planned against done
import fs from 'node:fs/promises'
import path from 'node:path'
import { localStamp, todayIso } from './terms.mjs'
import { readJson, writeAtomic } from './problems.mjs'
import { newId } from '../../server/format.js'
import { addDays, weekdayOf } from '../../src/calendar.js'

export const WORK_JSON = root => path.join(root, 'Hub', '_work-log.json')
export const ATT_JSON = root => path.join(root, 'Hub', '_attendance.json')
export const DAY_LOG = root => path.join(root, 'Hub', '_day-log.json')
const stamp = () => localStamp()
const ms = iso => new Date(iso).getTime()

export const emptyLog = () => ({ version: 1, sessions: [], calibration: {}, running: null })
export async function readLog(root) { const l = await readJson(WORK_JSON(root), null); return { ...emptyLog(), ...(l || {}), sessions: l?.sessions || [], calibration: l?.calibration || {}, running: l?.running || null } }
export async function writeLog(root, log) { log.sessions = log.sessions.slice(-2000); await fs.mkdir(path.dirname(WORK_JSON(root)), { recursive: true }); await writeAtomic(WORK_JSON(root), JSON.stringify(log, null, 2) + '\n') }

// ---- the timer -----------------------------------------------------------------------------------------------------
// A running session is segments of work: pause closes one, resume opens the next. Minutes are the segments' sum.
export const activeMinutes = (s, now = Date.now()) => Math.round((s?.segments || []).reduce((n, g) => n + Math.max(0, (g.to ? ms(g.to) : now) - ms(g.from)), 0) / 60000)
// What a session is measured against (learn): `base`, the row's minutes before any calibration (null: nothing to measure
// against), or `student`, his own number. Neither given (an older session, a direct caller): its planned minutes, as before.
const measured = (base, student) => (student ? { student: true } : base !== undefined ? { base: Number.isFinite(base) && base > 0 ? base : null } : {})
export async function startWork(root, { rowId, title, courseKey = null, course = null, kind = null, planned = null, blockId = null, tick = null, base = undefined, student = false }) {
  if (!rowId || !title) throw new Error('start: rowId and title')
  const log = await readLog(root)
  if (log.running && log.running.rowId !== rowId) throw new Error(`already working on "${log.running.title}" — stop it first`)
  if (log.running) return log.running
  log.running = { id: 'w-' + newId(), rowId, title, courseKey, course, kind, planned: Number.isFinite(planned) ? planned : null, ...measured(base, student), blockId, tick: tick && typeof tick === 'object' ? tick : null, startedAt: stamp(), paused: false, segments: [{ from: stamp(), to: null }] }
  await writeLog(root, log)
  return log.running
}
export async function pauseWork(root) {
  const log = await readLog(root)
  if (!log.running) throw new Error('nothing is running')
  const seg = log.running.segments[log.running.segments.length - 1]
  if (seg && !seg.to) seg.to = stamp()
  log.running.paused = true
  await writeLog(root, log)
  return log.running
}
export async function resumeWork(root) {
  const log = await readLog(root)
  if (!log.running) throw new Error('nothing is running')
  if (log.running.paused) { log.running.segments.push({ from: stamp(), to: null }); log.running.paused = false }
  await writeLog(root, log)
  return log.running
}
// stop → the session written, with what it taught the calibration; `done` says whether the thing is finished (the
// caller ticks the task — this file never touches a page).
export async function stopWork(root, { done = true, minutes = null } = {}) {
  const log = await readLog(root)
  if (!log.running) throw new Error('nothing is running')
  const r = log.running
  const seg = r.segments[r.segments.length - 1]
  if (seg && !seg.to) seg.to = stamp()
  const actual = Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : activeMinutes(r)
  const session = { id: r.id, rowId: r.rowId, title: r.title, courseKey: r.courseKey, course: r.course, kind: r.kind, blockId: r.blockId, date: String(r.startedAt).slice(0, 10), start: r.startedAt, end: stamp(), minutes: actual, planned: r.planned, ...measured(r.base, r.student), done: !!done, source: 'timer' }
  log.sessions.push(session); log.running = null
  learn(log, session)
  await writeLog(root, log)
  return session
}
export async function dropWork(root) { const log = await readLog(root); const r = log.running; log.running = null; await writeLog(root, log); return r }
// Ticked without the timer: the app asks how long it took, with the estimate preselected, and a skip.
export async function askedWork(root, { rowId, title, courseKey = null, course = null, kind = null, planned = null, minutes, date = null, done = true, base = undefined, student = false }) {
  if (!rowId || !title) throw new Error('asked: rowId and title')
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('asked: minutes')
  const log = await readLog(root)
  const session = { id: 'w-' + newId(), rowId, title, courseKey, course, kind, blockId: null, date: date || todayIso(), start: null, end: stamp(), minutes: Math.round(minutes), planned: Number.isFinite(planned) ? planned : null, ...measured(base, student), done: !!done, source: 'asked' }
  log.sessions.push(session)
  learn(log, session)
  await writeLog(root, log)
  return session
}
// ---- what the sessions teach -----------------------------------------------------------------------------------------
// A ratio of actual to estimated, per course and kind and per kind alone, as an exponential average (a third of the way
// toward each new session) so a bad guess in week one does not weigh forever. Only a finished session with an estimate
// teaches. The estimate is the one the ratio multiplies (src/dayplan.js minutesOf): `base`, before any calibration.
// Against the planned minutes — base times the old ratio — it settled on the square root of the true ratio (a task that
// takes twice as long converged on 1.41×). A session on his own number teaches nothing: the ratio never scales it.
const CLAMP = r => Math.min(4, Math.max(0.25, r))
export function learn(log, s) {
  const est = s.student ? null : s.base !== undefined ? s.base : s.planned
  if (!s.done || !Number.isFinite(est) || est <= 0 || !Number.isFinite(s.minutes) || s.minutes <= 0) return
  const ratio = CLAMP(s.minutes / est)
  for (const key of [s.courseKey && s.kind ? `${s.courseKey}|${s.kind}` : null, s.kind || null].filter(Boolean)) {
    const c = log.calibration[key] || { ratio: 1, n: 0 }
    const a = c.n === 0 ? 1 : 1 / 3
    log.calibration[key] = { ratio: Math.round((c.ratio * (1 - a) + ratio * a) * 100) / 100, n: c.n + 1, at: stamp() }
  }
}

// ---- the week, planned against done ----------------------------------------------------------------------------------
export async function readDayLog(root) { const l = await readJson(DAY_LOG(root), null); return { version: 1, days: {}, ...(l || {}), days: l?.days || {} } }
export async function noteDay(root, day) {
  const l = await readDayLog(root)
  // What the day counts as planned (SPEC §23): the blocks he confirmed; before he has confirmed any, the draft.
  const blocks = (day.blocks || []).filter(b => !b.done)
  const conf = blocks.filter(b => b.state === 'confirmed')
  const counted = conf.length ? conf : blocks
  const planned = {}
  for (const b of counted) { const k = b.courseKey || '—'; planned[k] = (planned[k] || 0) + (b.minutes || (b.end - b.start) || 0) }
  l.days[day.date] = { date: day.date, by: conf.length ? 'student' : day.draft?.by || day.by || null, decision: day.draft?.decision || day.decision || null, at: day.updatedAt || day.builtAt || stamp(), target: day.numbers?.target ?? null, planned, blocks: counted.length, confirmed: conf.length, rows: [...new Set((day.blocks || []).map(b => b.rowId).filter(Boolean))] }
  const keys = Object.keys(l.days).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete l.days[k]
  await fs.mkdir(path.dirname(DAY_LOG(root)), { recursive: true })
  await writeAtomic(DAY_LOG(root), JSON.stringify(l, null, 2) + '\n')
}
// weekOf(root, date) → the Monday-to-Sunday week holding `date`: per day, minutes planned and done per course; per kind,
// how the estimates ran; which days were finished (every planned row has a finished session).
export async function weekOf(root, date = todayIso()) {
  const [log, dl] = await Promise.all([readLog(root), readDayLog(root)])
  const dow = weekdayOf(date), back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[dow] ?? 0
  const monday = addDays(date, -back)
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
  const out = days.map(d => {
    const plan = dl.days[d] || null
    const done = {}
    for (const s of log.sessions) if (s.date === d && s.minutes > 0) { const k = s.courseKey || '—'; done[k] = (done[k] || 0) + s.minutes }
    const finishedRows = new Set(log.sessions.filter(s => s.date === d && s.done).map(s => s.rowId))
    const finished = !!plan && plan.rows.length > 0 && plan.rows.every(r => finishedRows.has(r))
    return { date: d, weekday: weekdayOf(d), planned: plan?.planned || {}, plannedTotal: Object.values(plan?.planned || {}).reduce((a, b) => a + b, 0), target: plan?.target ?? null, done, doneTotal: Object.values(done).reduce((a, b) => a + b, 0), finished, by: plan?.by || null }
  })
  const kinds = {}
  for (const [k, v] of Object.entries(log.calibration)) if (!k.includes('|')) kinds[k] = v
  const courses = [...new Set(out.flatMap(d => [...Object.keys(d.planned), ...Object.keys(d.done)]))].filter(k => k !== '—')
  return { monday, sunday: days[6], days: out, courses, kinds, courseRatios: Object.fromEntries(Object.entries(log.calibration).filter(([k]) => k.includes('|'))) }
}

// ---- attendance --------------------------------------------------------------------------------------------------------
export async function readAttendance(root) { const a = await readJson(ATT_JSON(root), null); return { version: 1, classes: {}, ...(a || {}), classes: a?.classes || {} } }
export async function setAttendance(root, { meetingId, attended, courseKey = null, date = null, kind = null, note = null }) {
  if (!meetingId) throw new Error('attendance: meetingId')
  const a = await readAttendance(root)
  if (attended === null || attended === undefined) delete a.classes[meetingId]
  else a.classes[meetingId] = { attended: !!attended, courseKey, date: date || String(meetingId).split('|')[1] || null, kind: kind || String(meetingId).split('|')[2] || null, note: note || null, at: stamp() }
  await fs.mkdir(path.dirname(ATT_JSON(root)), { recursive: true })
  await writeAtomic(ATT_JSON(root), JSON.stringify(a, null, 2) + '\n')
  return a.classes[meetingId] || null
}

// ---- the student's own estimates -----------------------------------------------------------------------------------------------
// How long *he* says a thing takes (SPEC §22.10): set on any task sheet, kept by row id, and the day, the draft and a drag
// all take it over Claude's minutes and the kind's default. His number is not scaled by the calibration — it is his.
export const EST_JSON = root => path.join(root, 'Hub', '_estimates.json')
export async function readEstimates(root) { const e = await readJson(EST_JSON(root), null); return { version: 1, rows: {}, ...(e || {}), rows: e?.rows || {} } }
export async function setEstimate(root, { rowId, minutes, title = null }) {
  if (!rowId) throw new Error('estimate: rowId')
  const e = await readEstimates(root)
  if (minutes === null || minutes === undefined) delete e.rows[rowId]
  else {
    const m = Number(minutes)
    if (!Number.isFinite(m) || m < 5 || m > 600) throw new Error('minutes: 5 to 600')
    e.rows[rowId] = { minutes: Math.round(m / 5) * 5, title: title || null, at: stamp() }
  }
  await fs.mkdir(path.dirname(EST_JSON(root)), { recursive: true })
  await writeAtomic(EST_JSON(root), JSON.stringify(e, null, 2) + '\n')
  return e.rows[rowId] || null
}
