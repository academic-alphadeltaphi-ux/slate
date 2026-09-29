// Today's work — the packer (SPEC §22).
//
// A day's plan is the rows To do already builds (src/todo.js rowsFor), packed into the hours the day leaves free. This
// module is pure and bundled on both sides like the terms: the 07:00 run (scripts/dayplan.mjs) and a dial flipped in the
// app call the same `packDay` on the same inputs and get the same plan, so what the morning wrote and what a click
// redraws never disagree. Nothing here reads a file or a clock — the caller says which day it is, what time it is when
// re-packing, and what the student has pinned, skipped for the day or marked minor.
//
// Time is minutes past the day's midnight. The packer's window closes at 24:00 (1440) — "try nothing after midnight" —
// and only rungs 1 and 2 may run on past it, never beyond the hard end at 03:00 (1620); a block the student drags may go that
// late too. `hm()` prints 1530 as 01:30.
import { weekdayOf, addDays, daysTo } from './calendar.js'

export const DAY_VERSION = 1
const UNDATED = '9999-12-31'

// The standing preferences (Hub/_day-prefs.json). the student's answers of 2026-09-20 are the defaults; every number is his to edit.
export const DEFAULT_PREFS = {
  version: 1,
  // Minutes of work wanted on an ordinary day. A target, not a cap: rungs 1 and 2 stretch it, optional work fills it.
  budget: { Mon: 90, Tue: 240, Wed: 180, Thu: 240, Fri: 300, Sat: 240, Sun: 270 },
  // When the packer may place work. Weekdays from 09:00, weekends from 10:00; nothing after midnight on its own.
  window: { weekday: ['09:00', '24:00'], weekend: ['10:00', '24:00'] },
  hardEnd: '27:00',       // 03:00 the next day: the latest a block may end, dragged or spilled
  walk: 20,               // minutes to and from every class, kept free on both sides
  air: 10,                // minutes between two blocks
  // Meals: wanted at `start`, sliding up to `slide` minutes either way when a class or an event sits on them.
  meals: [{ name: 'Lunch', start: '12:30', minutes: 45, slide: 60 }, { name: 'Dinner', start: '20:00', minutes: 45, slide: 60 }],
  // Fixed engagements by weekday (or by `date`), with their own walk.
  fixed: [{ name: 'Frat meeting', day: 'Mon', start: '20:30', end: '23:30', walk: 20 }],
  // Calendar events that are time to work in, not time lost: a title holding one of these words, or an id listed here.
  // The day's own toggles (`workable` on packDay, `--workable` / `--busy` on the script) win over both.
  workable: { titles: ['Bus', 'Train'], ids: [] },
  // Course tiers, highest first: the ECO courses win, then FCS298. A course in no tier joins the last one.
  tiers: [['ECO 206Y1', 'ECO 208Y1', 'ECO 227Y1'], ['FCS 298H1']],
  tierNames: ['ECO', 'FCS'],
  // The standing dials; Claude's steer and the day's own override sit on top, in that order.
  dials: { focus: [], ignore: [], kinds: [], requiredOnly: false, catchup: 'normal', budget: null },
  catchupShare: { light: 0, normal: 0.25, heavy: 0.5 },   // of the target, reserved for catch-up work
  split: { over: 90, min: 45 },                            // split only what runs over 90 min, never into pieces under 45
  slack: 15,                                                // a block may run this far over the target rather than be left out
  gap: 15,                                                  // the shortest gap worth placing anything in
  testHorizon: 21,                                          // days: a test this close spreads the backlog it covers
  // Minutes by kind when Claude gave none (the brain's `minutes`), before calibration.
  minutes: { read: 45, watch: 60, problems: 90, review: 40, write: 120, quiz: 30, bring: 5, due: 60, participation: 45, prepare: 60, other: 45, mine: 30 },
  pushToCalendar: false,
}

// ---- time --------------------------------------------------------------------------------------------------------
export const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
export const hm = min => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }
export const span = (a, b) => `${hm(a)}–${hm(b)}`
const hmEnd = min => (min === 1440 ? '24:00' : hm(min))   // a window that closes at midnight says 24:00, not 00:00
const up5 = n => Math.ceil(n / 5) * 5
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

export function withDefaults(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {}
  const nested = k => ({ ...DEFAULT_PREFS[k], ...(p[k] && typeof p[k] === 'object' && !Array.isArray(p[k]) ? p[k] : {}) })
  return { ...DEFAULT_PREFS, ...p, budget: nested('budget'), window: nested('window'), dials: nested('dials'), catchupShare: nested('catchupShare'), split: nested('split'), minutes: nested('minutes'), workable: nested('workable'),
    meals: Array.isArray(p.meals) ? p.meals : DEFAULT_PREFS.meals, fixed: Array.isArray(p.fixed) ? p.fixed : DEFAULT_PREFS.fixed, tiers: Array.isArray(p.tiers) ? p.tiers : DEFAULT_PREFS.tiers, tierNames: Array.isArray(p.tierNames) ? p.tierNames : DEFAULT_PREFS.tierNames }
}
export const isWeekend = date => /^(Sat|Sun)$/.test(weekdayOf(date))
export function windowFor(date, prefs) {
  const p = withDefaults(prefs)
  const w = p.window[isWeekend(date) ? 'weekend' : 'weekday'] || p.window.weekday
  return { start: toMin(w[0]) ?? 540, end: toMin(w[1]) ?? 1440, hardEnd: toMin(p.hardEnd) ?? 1620 }
}
// Dials, layered: the standing ones, then Claude's steer for the day, then what the student set today. A list dial replaces the
// list wholesale; `budget` is minutes or null (the weekday's standing number).
export function mergeDials(...layers) {
  const out = { ...DEFAULT_PREFS.dials }
  for (const l of layers) { if (!l || typeof l !== 'object') continue; for (const k of Object.keys(out)) if (l[k] !== undefined && l[k] !== null) out[k] = Array.isArray(out[k]) ? [...l[k]] : l[k] }
  return out
}

// ---- what the day already holds ----------------------------------------------------------------------------------
// The classes, the calendar's events, the fixed engagements with their walks, the meals slid around them, and — when
// re-packing during the day — the past. Each interval keeps its kind so a screen can draw it: a class in its pigment, a
// walk hatched, an event in graphite, a meal and a fixed engagement dashed. An event that is *workable* — a bus, a
// train, or one the student toggled for the day (`workable`: { id: true|false }, or a list of ids) — is drawn and not busy.
export function busyFor({ date, meetings = [], events = [], prefs = DEFAULT_PREFS, now = null, kept = [], workable = null, skipped = [] } = {}) {
  const p = withDefaults(prefs), out = []
  const toggled = Array.isArray(workable) ? Object.fromEntries(workable.map(id => [id, true])) : (workable && typeof workable === 'object' ? workable : {})
  const isWorkable = ev => (ev.id != null && toggled[ev.id] !== undefined) ? !!toggled[ev.id]
    : (p.workable.ids || []).includes(ev.id) || (p.workable.titles || []).some(t => t && String(ev.title || '').toLowerCase().includes(String(t).toLowerCase()))
  for (const m of meetings || []) {
    if (m.date !== date || m.cancelled) continue
    const s = toMin(m.announced?.start || m.start), e = toMin(m.announced?.end || m.end)
    if (s == null || e == null || e <= s) continue
    // A class the student says he will not be at (attendance: false, ahead of it — a bus that lands after it) is drawn, and its
    // hours are his: workable, and no walk to it.
    const skip = !!m.id && (skipped || []).includes(m.id)
    out.push({ start: s, end: e, kind: 'class', title: `${m.course || m.courseKey} · ${m.kind}`, courseKey: m.courseKey, course: m.course || null, color: m.color || null, where: m.where || null, id: m.id || null, ...(skip ? { skipped: true, workable: true } : {}) })
    if (p.walk > 0 && !skip) out.push({ start: s - p.walk, end: s, kind: 'walk', title: `Walk to ${m.course || 'class'}`, courseKey: m.courseKey }, { start: e, end: e + p.walk, kind: 'walk', title: 'Walk back', courseKey: m.courseKey })
  }
  for (const ev of events || []) {
    if (ev.date !== date || ev.allDay || ev.slate) continue        // the sync's own event for a class is the class
    const s = toMin(ev.start), e = toMin(ev.end)
    if (s == null || e == null || e <= s) continue
    out.push({ start: s, end: e, kind: 'event', title: ev.title || 'Busy', id: ev.id || null, where: ev.location || null, workable: isWorkable(ev) })
  }
  const dow = weekdayOf(date)
  for (const f of p.fixed || []) {
    if ((f.day && f.day !== dow) || (f.date && f.date !== date)) continue
    const s = toMin(f.start), e = toMin(f.end)
    if (s == null || e == null || e <= s) continue
    out.push({ start: s, end: e, kind: 'fixed', title: f.name || 'Fixed' })
    const w = Number(f.walk) || 0
    if (w > 0) out.push({ start: s - w, end: s, kind: 'walk', title: `Walk to ${f.name || 'it'}` }, { start: e, end: e + w, kind: 'walk', title: 'Walk back' })
  }
  for (const k of kept || []) if (k && k.end > k.start) out.push({ start: k.start, end: k.end, kind: 'kept', title: k.title || 'Kept', rowId: k.rowId || null })
  for (const meal of p.meals || []) { const slot = slideMeal(meal, out); if (slot) out.push(slot) }
  if (now != null) out.push({ start: 0, end: now, kind: 'past', title: 'Gone' })
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}
// A meal wants its time; when a class, an event or the walk to one sits on it, it slides — later first, then earlier, five
// minutes at a time, up to its `slide` — and is dropped for the day when nothing fits (a Monday's dinner lands in the
// fifty minutes between the walk back from the tutorial and the walk to the frat).
function slideMeal(meal, busy) {
  const want = toMin(meal.start); if (want == null) return null
  const len = Number(meal.minutes) || 45, slide = Number.isFinite(meal.slide) ? meal.slide : 60
  const clash = (s, e) => busy.some(b => b.kind !== 'past' && !b.workable && b.start < e && s < b.end)
  const tries = [0]; for (let d = 5; d <= slide; d += 5) tries.push(d, -d)
  for (const d of tries) { const s = want + d; if (!clash(s, s + len)) return { start: s, end: s + len, kind: 'meal', title: meal.name || 'Meal' } }
  return null
}
// The gaps between `from` and `to` that nothing in `busy` covers, `gap` minutes or longer. A workable event covers nothing.
export function freeIntervals(busy, from, to, gap = DEFAULT_PREFS.gap) {
  const out = []; let cur = from
  for (const b of [...busy].filter(b => !b.workable).sort((a, b) => a.start - b.start)) {
    if (b.end <= cur) continue
    if (b.start >= to) break
    if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, to) })
    cur = Math.max(cur, b.end)
    if (cur >= to) break
  }
  if (cur < to) out.push({ start: cur, end: to })
  return out.filter(i => i.end - i.start >= gap)
}
const sumFree = (free, before = null) => free.reduce((n, i) => n + Math.max(0, Math.min(i.end, before ?? i.end) - i.start), 0)

// ---- the candidates ----------------------------------------------------------------------------------------------
const LEVEL_RANK = { crucial: 0, important: 1, normal: 2, optional: 3 }
const UNSPLIT = new Set(['quiz', 'bring'])
export const kindOf = r => (r.type === 'hand-in' ? 'due' : r.type === 'mine' ? 'mine' : (r.task?.kind || 'other'))
const ratioOf = (calibration, courseKey, kind) => { const v = calibration?.[`${courseKey}|${kind}`] ?? calibration?.[kind]; const n = typeof v === 'number' ? v : v?.ratio; return Number.isFinite(n) && n > 0 ? n : 1 }
export const tierOf = (courseKey, prefs) => { const p = withDefaults(prefs); const i = p.tiers.findIndex(t => (t || []).includes(courseKey)); return i < 0 ? Math.max(0, p.tiers.length - 1) : i }

// How long a row takes: Claude's minutes when he gave them, else the kind's default, times what the work log has learned
// for that course and kind, rounded up to five minutes and never under ten.
export function minutesOf(r, prefs, calibration = {}) {
  const p = withDefaults(prefs), kind = kindOf(r)
  // the student's own number first (the task sheet's estimate), unscaled; then Claude's minutes, then the kind's default, both
  // times what the work log has learned.
  const own = r.estimate?.minutes ?? null
  if (Number.isFinite(own) && own > 0) return { minutes: Math.max(10, up5(own)), base: own, ratio: 1, claude: false, student: true }
  const said = r.task?.claude?.minutes ?? r.minutes ?? null
  const base = Number.isFinite(said) && said > 0 ? said : (p.minutes[kind] ?? p.minutes.other)
  const ratio = ratioOf(calibration, r.courseKey, kind)
  return { minutes: Math.max(10, up5(base * ratio)), base, ratio, claude: Number.isFinite(said) && said > 0, student: false }
}

// One row weighed for the day, or null when it is not work (done, a test to sit, a rule's in-class sentence). A thing that
// happens *in the room* — a quiz attached to a class whose link is not a Quercus quiz, or anything Claude gave zero minutes
// — comes back as `{ inClass: true }`: it is not placed, it is written inside the class block on the day. `excluded` names
// the dial that put a row aside; crucial work ignores every dial but *Not today*.
const QUIZ_URL = /\/quizzes\/\d+/
export function candidateOf(r, { date, prefs, dials, notToday = [], minor = [], asked = [], calibration = {}, tests = [], tomorrowFree = [], window } = {}) {
  if (!r || r.done || r.inClass || r.type === 'sit' || r.type === 'in-class' || r.type === 'practice' || r.type === 'prep-set') return null
  const p = withDefaults(prefs), d = mergeDials(p.dials, dials), kind = kindOf(r)
  const link = String(r.task?.claude?.link || r.action?.url || '')
  if (r.task?.claude?.minutes === 0 || (kind === 'quiz' && r.type === 'prep' && !QUIZ_URL.test(link)))
    return { rowId: r.id, row: r, title: r.title, course: r.course || null, courseKey: r.courseKey || null, color: r.color || null, kind, level: r.priority?.level || 'normal', nature: r.nature ?? null, inClass: true, meetingId: r.meeting?.id || null, by: r.by || null, minutes: 0, excluded: null, action: r.action || null }
  const level = LEVEL_RANK[r.priority?.level] != null ? r.priority.level : 'normal'
  const crucial = level === 'crucial'
  const est = minutesOf(r, p, calibration)
  const by = r.by && r.by !== UNDATED ? r.by : null
  const days = by ? daysTo(by, date) : 9999
  const walk = p.walk || 0
  const startOf = m => toMin(m?.announced?.start || m?.start)
  const dueMin = r.type === 'prep' && r.meeting && startOf(r.meeting) != null ? startOf(r.meeting) - walk
    : (r.dueTime || r.task?.dueTime) ? toMin(r.dueTime || r.task?.dueTime) : null
  const weekN = r.meeting?.week?.n ?? r.week?.n ?? null
  const catchup = !!r.overdue
  const test = catchup && weekN != null ? (tests || []).find(t => t.courseKey === r.courseKey && t.date && (t.window?.weeks || []).includes(weekN) && daysTo(t.date, date) >= 0 && daysTo(t.date, date) <= p.testHorizon) || null : null
  const isMinor = minor.includes(r.id), isAsked = asked.includes(r.id)   // asked: the student moved it onto this day himself
  let excluded = null
  if (notToday.includes(r.id)) excluded = 'not today'
  else if (!crucial && !isAsked) {
    if (d.ignore.includes(r.courseKey) || d.ignore.includes(r.course)) excluded = 'ignored course'
    else if (d.focus.length && r.courseKey && !d.focus.includes(r.courseKey) && !d.focus.includes(r.course)) excluded = 'not in focus'
    else if (d.kinds.includes(kind)) excluded = 'ignored kind'
    else if (d.requiredOnly && (r.nature === 'optional' || level === 'optional')) excluded = 'required only'
  }
  // Cannot wait: due today, or due tomorrow and longer than the free time tomorrow holds before it is due.
  const mustToday = !catchup && (days === 0 || (days === 1 && est.minutes > sumFree(tomorrowFree, dueMin)))
  return {
    rowId: r.id, row: r, title: r.title, course: r.course || null, courseKey: r.courseKey || null, color: r.color || null,
    kind, level, nature: r.nature ?? null, tier: r.courseKey ? tierOf(r.courseKey, p) : Math.max(0, p.tiers.length - 1),
    minutes: est.minutes, estimate: est, splittable: r.task?.claude?.splittable === false ? false : !UNSPLIT.has(kind),
    // Due today: before the hour when there is one, else by the hard end — a thing wanted "today" with no hour may run
    // past midnight, never past 03:00.
    dueAt: { days, min: dueMin, deadline: days === 0 ? (dueMin ?? window?.hardEnd ?? 1620) : null },
    catchup, testDriven: test ? { key: `${test.courseKey}|${test.date}`, title: test.title, date: test.date, daysLeft: Math.max(1, daysTo(test.date, date)) } : null,
    minor: isMinor, asked: isAsked, weight: r.task?.claude?.weight ?? null, points: r.points ?? null, mustToday, excluded,
  }
}

// ---- the ladder --------------------------------------------------------------------------------------------------
// Rung 1: what cannot wait. 2: crucial. Then important by tier, normal by tier, catch-up, optional. With two tiers that is
// rungs 1–8; every rung's label says what it is so a row can wear it.
export function rungsFor(prefs) {
  const p = withDefaults(prefs), T = Math.max(1, p.tiers.length)
  return { cannotWait: 1, crucial: 2, important: 3, normal: 3 + T, catchup: 3 + 2 * T, optional: 4 + 2 * T, tiers: T }
}
export function rungOf(c, prefs, dials) {
  const R = rungsFor(prefs), d = mergeDials(withDefaults(prefs).dials, dials)
  if (c.mustToday || c.asked) return R.cannotWait
  if (c.level === 'crucial') return R.crucial
  if (c.minor) return R.optional
  if (c.catchup) return d.catchup === 'heavy' ? R.important + c.tier : c.testDriven ? R.normal + c.tier : R.catchup
  if (c.level === 'important') return R.important + c.tier
  if (c.level === 'normal') return R.normal + c.tier
  return R.optional
}
export function rungLabel(rung, prefs) {
  const p = withDefaults(prefs), R = rungsFor(p), name = i => p.tierNames?.[i] || `tier ${i + 1}`
  if (rung === R.cannotWait) return 'cannot wait'
  if (rung === R.crucial) return 'crucial'
  if (rung >= R.important && rung < R.normal) return `important · ${name(rung - R.important)}`
  if (rung >= R.normal && rung < R.catchup) return `${name(rung - R.normal)}`
  if (rung === R.catchup) return 'catch-up'
  return 'optional'
}
const whyOf = c => c.asked ? 'you moved it here' : c.mustToday ? (c.dueAt.days === 0 ? 'due today' : 'no room tomorrow before it is due')
  : c.level === 'crucial' ? 'crucial'
  : c.minor ? 'catch-up you marked minor'
  : c.catchup ? (c.testDriven ? `catch-up · ${c.testDriven.title} in ${c.testDriven.daysLeft} day${c.testDriven.daysLeft === 1 ? '' : 's'}` : 'catch-up')
  : c.level === 'optional' ? 'optional, there was room' : c.level
const cmp = (a, b) => a.rung - b.rung || a.dueAt.days - b.dueAt.days || (a.dueAt.min ?? 9999) - (b.dueAt.min ?? 9999) || (b.weight ?? 0) - (a.weight ?? 0) || (b.points ?? 0) - (a.points ?? 0) || LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || String(a.title).localeCompare(String(b.title))

// ---- placing -----------------------------------------------------------------------------------------------------
// `free` is mutated: a placed block takes its minutes out and the air after it. Whole first; a splittable task that fits
// nowhere whole is cut into pieces of at least `split.min`, and what still finds no room is reported, not forced.
function carve(free, i, start, end, air, gap) {
  const at = free.indexOf(i); if (at < 0) return
  const parts = []
  if (start - i.start >= gap) parts.push({ start: i.start, end: start })
  if (i.end - (end + air) >= gap) parts.push({ start: end + air, end: i.end })
  free.splice(at, 1, ...parts)
}
function placeWhole(free, minutes, deadline, air, gap) {
  for (const i of free) {
    if (i.end - i.start < minutes) continue
    if (deadline != null && i.start + minutes > deadline) continue
    const start = i.start, end = start + minutes
    carve(free, i, start, end, air, gap)
    return { start, end }
  }
  return null
}
function placeSplit(free, minutes, deadline, air, split, gap) {
  const chunks = []; let left = minutes
  for (const i of [...free]) {
    if (left <= 0) break
    let len = i.end - i.start
    if (deadline != null) len = Math.min(len, deadline - i.start)
    if (len < split.min) continue
    let take = Math.min(left, Math.floor(len / 5) * 5)
    if (left - take > 0 && left - take < split.min) take = left - split.min
    if (take < split.min) continue
    const start = i.start, end = start + take
    carve(free, i, start, end, air, gap)
    chunks.push({ start, end }); left -= take
  }
  return chunks
}
// place(c, minutes) → the pieces placed (possibly none, possibly fewer minutes than asked).
function place(state, c, minutes, { allowLate = false } = {}) {
  const { free, late, air, split, gap } = state
  const deadline = c.dueAt.deadline
  // The deadline holds in the late window too: what is wanted before a 15:00 class never lands after midnight.
  const whole = placeWhole(free, minutes, deadline, air, gap)
  if (whole) return [{ ...whole, late: false }]
  if (allowLate) { const w = placeWhole(late, minutes, deadline, air, gap); if (w) return [{ ...w, late: true }] }
  if (!c.splittable || minutes <= split.over) return []
  const pieces = placeSplit(free, minutes, deadline, air, split, gap).map(x => ({ ...x, late: false }))
  const got = pieces.reduce((n, x) => n + (x.end - x.start), 0)
  if (allowLate && got < minutes) pieces.push(...placeSplit(late, minutes - got, deadline, air, split, gap).map(x => ({ ...x, late: true })))
  return pieces
}

// ---- the plan ----------------------------------------------------------------------------------------------------
// packDay(input) → { date, window, dials, numbers, blocks, unplaced, excluded, ladder, busy, free }.
//   rows        the open rows (rowsFor with past 'open'), any course
//   meetings    plan meetings (today's and tomorrow's are read; the rest ignored); events: the calendar readback's rows
//   now         HH:MM or minutes: re-pack from here — the morning stays as it was, only the future is placed
//   kept        blocks kept where they are: pinned by a drag, running on the timer, done. { rowId, start, end, title }
//   notToday    row ids skipped for the day; minor: row ids of backlog marked minor
//   calibration { 'ECO 227Y1|problems': ratio } from the work log; doneMinutes: what the log holds for the day
//   only        [rowIds] in order → the quiet re-pack: keep this set, slide it from now, no rungs, no cap
//   workable    { eventId: true|false } — the day's own toggles on the calendar's events (a bus is work time)
export function packDay({ date, now = null, rows = [], meetings = [], events = [], prefs = DEFAULT_PREFS, dials = null, steer = null, kept = [], notToday = [], minor = [], asked = [], skipped = [], calibration = {}, tests = [], doneMinutes = 0, only = null, workable = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('packDay: date is YYYY-MM-DD')
  const p = withDefaults(prefs), d = mergeDials(p.dials, steer?.dials, dials), window = windowFor(date, p)
  const nowMin = now == null ? null : typeof now === 'number' ? now : toMin(now)
  const from = nowMin == null ? window.start : Math.max(window.start, up5(nowMin))
  const busy = busyFor({ date, meetings, events, prefs: p, now: nowMin, kept, workable, skipped })
  const free = freeIntervals(busy, from, window.end, p.gap), late = freeIntervals(busy, Math.max(from, window.end), window.hardEnd, p.gap)
  // A block kept where it is takes its air with it, like every placed block does.
  for (const k of kept || []) for (const list of [free, late]) for (const i of [...list]) {
    if (i.start === k.end) i.start += p.air
    if (i.end === k.start) i.end -= p.air
    if (i.end - i.start < p.gap) list.splice(list.indexOf(i), 1)
  }
  const freeAtStart = sumFree(free)
  const tomorrow = addDays(date, 1)
  const tomorrowFree = freeIntervals(busyFor({ date: tomorrow, meetings, events, prefs: p, workable, skipped }), windowFor(tomorrow, p).start, windowFor(tomorrow, p).end, p.gap)
  const keptIds = new Set((kept || []).map(k => k.rowId).filter(Boolean))
  const state = { free, late, air: p.air, split: p.split, gap: p.gap }
  const blocks = [], unplaced = [], excluded = []
  const dow = weekdayOf(date)
  const standing = p.budget[dow] ?? 240
  const target = Number.isFinite(d.budget) && d.budget > 0 ? d.budget : standing
  let planned = 0

  const weighed = rows.map(r => candidateOf(r, { date, prefs: p, dials: d, notToday, minor, asked, calibration, tests, tomorrowFree, window })).filter(Boolean).filter(c => !keptIds.has(c.rowId))
  // What happens in the room goes inside its class block for the day; on a day its class does not meet it is nothing.
  let inClass = 0
  for (const c of weighed.filter(c => c.inClass)) {
    const cls = busy.find(b => b.kind === 'class' && (c.meetingId ? b.id === c.meetingId : b.courseKey === c.courseKey && c.by === date))
    if (!cls) continue
    ;(cls.inside ||= []).push({ rowId: c.rowId, title: c.title, kind: c.kind, level: c.level, nature: c.nature, action: c.action }); inClass++
  }
  const all = weighed.filter(c => !c.inClass)
  for (const c of all) c.rung = only ? 0 : rungOf(c, p, d)
  const add = (c, pieces, total) => {
    const of = pieces.length > 1 || total > pieces.reduce((n, x) => n + (x.end - x.start), 0) ? pieces.length : null
    pieces.forEach((x, i) => { planned += x.end - x.start; blocks.push({ id: `${c.rowId}#${blocks.length + 1}`, rowId: c.rowId, title: c.title, course: c.course, courseKey: c.courseKey, color: c.color, kind: c.kind, level: c.level, nature: c.nature, rung: c.rung, rungLabel: only ? 'kept' : rungLabel(c.rung, p), why: whyOf(c), minutes: x.end - x.start, of: total, start: x.start, end: x.end, at: span(x.start, x.end), late: x.late, part: of ? { n: i + 1, of } : null, pinned: false, done: false, action: c.row.action || null, reason: c.row.reason || null, estimate: c.estimate }) })
  }
  const miss = (c, why, got = 0) => unplaced.push({ rowId: c.rowId, title: c.title, course: c.course, courseKey: c.courseKey, color: c.color, kind: c.kind, level: c.level, rung: c.rung, rungLabel: rungLabel(c.rung, p), minutes: c.minutes, placed: got, why })

  if (only) {
    const byId = new Map(all.map(c => [c.rowId, c]))
    for (const id of only) {
      const c = byId.get(id); if (!c) continue
      const pieces = place(state, c, c.minutes, { allowLate: true })
      const got = pieces.reduce((n, x) => n + (x.end - x.start), 0)
      if (pieces.length) add(c, pieces, c.minutes)
      if (got < c.minutes) miss(c, 'ran out of day', got)
    }
  } else {
    const R = rungsFor(p)
    const live = []
    for (const c of all) { if (c.excluded) excluded.push({ rowId: c.rowId, title: c.title, course: c.course, courseKey: c.courseKey, color: c.color, level: c.level, minutes: c.minutes, why: c.excluded }); else live.push(c) }
    live.sort(cmp)
    // A test in view spreads the backlog it covers over the days left: a quota per test per day.
    const quota = new Map(), used = new Map()
    for (const c of live) if (c.testDriven && c.rung < R.catchup) quota.set(c.testDriven.key, (quota.get(c.testDriven.key) || 0) + c.minutes)
    for (const [k, total] of quota) { const days = live.find(c => c.testDriven?.key === k).testDriven.daysLeft; quota.set(k, up5(total / days)) }
    const share = p.catchupShare[d.catchup] ?? p.catchupShare.normal
    const demand = live.filter(c => c.rung === R.catchup).reduce((n, c) => n + c.minutes, 0)
    const reserve = Math.min(Math.round(share * target), demand)
    const pending = new Set(live)
    const pass = (test, cap, { allowLate = false, quotas = false } = {}) => {
      for (const c of [...pending]) {
        if (!test(c)) continue
        let want = c.minutes
        const room = cap - planned
        // Over the room by more than the slack: a long splittable task is cut to what is left, anything else waits for a
        // later pass (the reserve released, or optional's turn) and reports 'budget' at the end.
        if (want > room + p.slack) { if (c.splittable && want > p.split.over && room >= p.split.min) want = Math.floor(room / 5) * 5; else continue }
        if (quotas && c.testDriven && quota.has(c.testDriven.key)) {
          const left = quota.get(c.testDriven.key) - (used.get(c.testDriven.key) || 0)
          if (left < Math.min(want, p.split.min)) { pending.delete(c); miss(c, 'spread before the test'); continue }
          if (want > left) { if (c.splittable) want = Math.floor(left / 5) * 5; else { pending.delete(c); miss(c, 'spread before the test'); continue } }
        }
        const pieces = place(state, c, want, { allowLate })
        const got = pieces.reduce((n, x) => n + (x.end - x.start), 0)
        if (!pieces.length) { pending.delete(c); miss(c, 'no room'); continue }
        add(c, pieces, c.minutes)
        if (c.testDriven) used.set(c.testDriven.key, (used.get(c.testDriven.key) || 0) + got)
        pending.delete(c)
        if (got < c.minutes) miss(c, want < c.minutes ? (quotas && c.testDriven && got >= want ? 'spread before the test' : 'budget') : 'no room for the rest', got)
      }
    }
    pass(c => c.rung <= R.crucial, Infinity, { allowLate: true })                                   // A: what cannot wait, and crucial — stretch, spill past midnight if it must
    pass(c => c.rung >= R.important && c.rung < R.catchup, target - reserve, { quotas: true })      // B: important and normal, fresh and test-driven, up to the target less the reserve
    pass(c => c.rung === R.catchup, target)                                                        // C: catch-up, into its reserve and whatever is left
    pass(c => c.rung >= R.important && c.rung < R.catchup, target, { quotas: true })               // D: the reserve released
    pass(c => c.rung === R.optional, target)                                                       // E: optional fills the day to its target
    for (const c of pending) miss(c, planned >= target ? 'budget' : 'no room')
  }

  blocks.sort((a, b) => a.start - b.start)
  const keptBlocks = (kept || []).filter(k => k && k.end > k.start).map((k, i) => ({ id: k.id || `kept#${i + 1}`, rowId: k.rowId || null, title: k.title || 'Kept', course: k.course || null, courseKey: k.courseKey || null, color: k.color || null, kind: k.kind || null, level: k.level || null, nature: k.nature ?? null, rung: null, rungLabel: k.done ? 'done' : 'pinned', why: k.done ? 'done' : 'where you put it', minutes: k.end - k.start, of: k.of ?? null, start: k.start, end: k.end, at: span(k.start, k.end), late: k.end > window.end, part: k.part || null, pinned: !k.done, done: !!k.done, action: k.action || null, reason: null, estimate: null }))
  const out = [...keptBlocks, ...blocks].sort((a, b) => a.start - b.start)
  const classes = busy.filter(b => b.kind === 'class').reduce((n, b) => n + (b.end - b.start), 0)
  const ladder = only ? [] : Object.entries(rungsFor(p)).filter(([k]) => k !== 'tiers').flatMap(([k, base]) => (k === 'important' || k === 'normal' ? Array.from({ length: rungsFor(p).tiers }, (_, i) => base + i) : [base])).map(rung => ({ rung, label: rungLabel(rung, p), placed: blocks.filter(b => b.rung === rung).length, minutes: blocks.filter(b => b.rung === rung).reduce((n, b) => n + b.minutes, 0), waiting: unplaced.filter(u => u.rung === rung).length }))
  const plannedAll = out.reduce((n, b) => n + (b.done ? 0 : b.minutes), 0)
  return {
    version: DAY_VERSION, date, weekday: dow, now: nowMin == null ? null : hm(nowMin),
    window: { start: hm(window.start), end: hmEnd(window.end), hardEnd: hmEnd(window.hardEnd), startMin: window.start, endMin: window.end, hardEndMin: window.hardEnd },
    dials: d, steer: steer ? { text: steer.text || null, reason: steer.reason || null, dials: steer.dials || null } : null,
    numbers: { standing, target, planned: plannedAll, stretched: Math.max(0, plannedAll - target), done: doneMinutes || 0, free: freeAtStart, classes, blocks: out.filter(b => !b.done).length, unplaced: unplaced.length, excluded: excluded.length, inClass },
    blocks: out, unplaced, excluded, ladder, busy: busy.filter(b => b.kind !== 'past'), free: state.free.map(i => ({ start: i.start, end: i.end, at: span(i.start, i.end) })),
  }
}

// The day as lines, for the morning note, the email, the page and the CLI: the classes with what happens in them, the
// events, the fixed engagements and the work blocks, in the order of the day. Meals and walks are not lines.
export function renderDay(day, { limit = null } = {}) {
  const items = []
  for (const b of day.busy || []) {
    if (b.kind === 'class') items.push({ start: b.start, line: `${span(b.start, b.end)} · ${b.title}${b.where ? ` · ${b.where}` : ''}${b.skipped ? ' · not going' : ''}${b.inside?.length ? ` · during it: ${b.inside.map(x => x.title).join('; ')}` : ''}` })
    else if (b.kind === 'event' || b.kind === 'fixed') items.push({ start: b.start, line: `${span(b.start, b.end)} · ${b.title}${b.workable ? ' · workable' : ''}` })
  }
  for (const b of day.blocks || []) items.push({ start: b.start, line: `${b.at} · ${b.course || '—'} · ${b.title}${b.part ? ` (${b.part.n} of ${b.part.of})` : ''} · ${b.minutes} min · ${b.done ? 'done' : b.pinned ? 'pinned' : b.why}` })
  items.sort((a, b) => a.start - b.start)
  const lines = items.slice(0, limit || undefined).map(x => x.line)
  if (limit && items.length > limit) lines.push(`… and ${items.length - limit} more`)
  return lines
}
