// The day on disk (SPEC §23, which replaces the model of §22.7–22.11): a day is the to-dos given an hour, each block a
// draft or confirmed. Claude drafts (`brain.mjs day set`, checked here, recorded with its reason and the way back);
// the student moves, drops, removes and confirms. Confirmed is his: nothing Claude does touches it. A row he takes off a day
// is `removed` there and Claude never proposes it again on that date. Nothing refills a hole by itself — no packer
// draft on the screen, no session started because a screen opened. The packer (src/dayplan.js) still does the
// arithmetic: what the day holds, the free time, and a proposal in Claude's brief he may keep or discard.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, localStamp, todayIso } from './terms.mjs'
import { readJson, writeAtomic } from './problems.mjs'
import { decide, reasonOf, brainEnabled, withLock } from './brain.mjs'
import { noteDay, readEstimates } from './work.mjs'
import { parsePage, newId } from '../../server/format.js'
import { rowsFor } from '../../src/todo.js'
import { parseMyTasks, MY_TASKS } from '../../src/mytasks.js'
import { expandMeetings, addDays, weekdayOf, shortIso } from '../../src/calendar.js'
import { packDay, busyFor, freeIntervals, candidateOf, windowFor, withDefaults, toMin, hm, span, DEFAULT_PREFS } from '../../src/dayplan.js'
import { wallsOf, snapStart, pushDown, overlaps } from '../../src/today.js'

export const DAY_JSON = root => path.join(root, 'Hub', '_day.json')
export const ATT_JSON = root => path.join(root, 'Hub', '_attendance.json')
export const PREFS_JSON = root => path.join(root, 'Hub', '_day-prefs.json')
export const LOG_JSON = root => path.join(root, 'Hub', '_work-log.json')
export const WORK_MD = root => path.join(root, 'Hub', 'Today', "Today's work.md")
export const TODAY_SLATE = root => path.join(root, 'Hub', 'Today', '_slate.json')
export const FILE_VERSION = 3
const ISO = /^\d{4}-\d{2}-\d{2}$/
// A draft's `why` over its limit is cut at a word, not refused: a refusal throws the whole draft away, and the day agent
// spent 40 turns and $4.76 on 2026-09-29 resending drafts over a few characters (SPEC §24.5).
const clipLine = (v, name, min, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); if (s.length <= max) return oneLine(s, name, min, max); const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' '); return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—-]+$/, '') + '…' }
// Row ids carry the words of their line, apostrophes included; the agent is told to write ’ in its JSON (the shell's
// quote), so an id is matched with its quotes folded: "Wednesday's" and "Wednesday’s" are the same row. It dropped the
// ECO208 Ch 5 slides from two drafts on 2026-09-29 for want of this.
const quoteFold = v => String(v ?? '').replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'").replace(/[\u201C\u201D]/g, '"')
const oneLine = (v, name, min, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); if (s.length < min) throw new Error(`${name}: at least ${min} characters`); if (s.length > max) throw new Error(`${name}: at most ${max} characters`); return s }
// Minutes as a clock that does not wrap: 25:30 is half past one the next morning. The brief speaks this way so Claude
// can say a late block back the same way; the page and the screen print 01:30.
export const clock = min => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`
const sumOf = list => list.reduce((n, i) => n + (i.end - i.start), 0)
const byStart = (a, b) => a.start - b.start || a.end - b.end
const kindOfRow = r => (r.type === 'hand-in' ? 'due' : r.type === 'mine' ? 'mine' : (r.task?.kind || 'other'))

// ---- the preferences ----------------------------------------------------------------------------------------------
const PREFS_NOTE = "Today's work — the standing preferences (SPEC §22, §23). Minutes are minutes; times are HH:MM, and 27:00 is 03:00 the next day. Edit and save; the next draft reads it."
export async function readPrefs(root, { create = false } = {}) {
  let prefs = await readJson(PREFS_JSON(root), null), created = false
  if (!prefs) {
    prefs = { _note: PREFS_NOTE, ...DEFAULT_PREFS }
    if (create) { await fs.mkdir(path.dirname(PREFS_JSON(root)), { recursive: true }); await writeAtomic(PREFS_JSON(root), JSON.stringify(prefs, null, 2) + '\n'); created = true }
  }
  return { prefs: withDefaults(prefs), created }
}
// A meal's standing length, from the screen: the foot of Lunch dragged is how long lunch is from now on, every day — the
// hour it sits at is the day's, its length a habit.
export async function setMealMinutes(root, name, minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m < 15 || m > 240 || m % 5) throw new Error('a meal is 15 to 240 minutes, in fives')
  const raw = (await readJson(PREFS_JSON(root), null)) || { _note: PREFS_NOTE, ...DEFAULT_PREFS }
  const meals = (Array.isArray(raw.meals) ? raw.meals : DEFAULT_PREFS.meals).map(x => ({ ...x }))
  const meal = meals.find(x => x.name === name); if (!meal) throw new Error(`no meal called ${name}`)
  meal.minutes = m
  await fs.mkdir(path.dirname(PREFS_JSON(root)), { recursive: true })
  await writeAtomic(PREFS_JSON(root), JSON.stringify({ ...raw, meals }, null, 2) + '\n')
  return meal
}

// ---- the file -----------------------------------------------------------------------------------------------------
// Hub/_day.json is { version: 3, days: { "<date>": day } }. A day keeps only what was decided and done to it:
//   blocks     [{ id, rowId, title, course, courseKey, color, kind, start, end, by: 'claude'|'student', state: 'draft'|'confirmed', why, confirmedAt }]
//   removed    [rowId] — rows the student took off this day; Claude never proposes them again here
//   meals      { Lunch: '13:10' } — a meal he dragged, for the day
//   workable   { eventId: true|false } — an event he can or cannot work through
//   draft      { by, at, decision, reason, steer, note, from, picks: [rowId], waiting: [{ rowId, why }] } — Claude's last draft
//   request    { note, at } — what he asked for when he pressed Draft, read by the brief
//   confirmedAt, sent: { at, created, updated, deleted }, updatedAt
// What the day holds (classes, walks, events, meals) is never stored: it is read again from the plan and the calendar.
export const emptyDay = date => ({ date, blocks: [], removed: [], meals: {}, workable: {}, draft: null, request: null, confirmedAt: null, sent: null, updatedAt: null })
const BLOCK_KEYS = ['id', 'rowId', 'title', 'course', 'courseKey', 'color', 'kind', 'start', 'end', 'by', 'state', 'why', 'confirmedAt', 'done']
const cleanBlock = b => Object.fromEntries(BLOCK_KEYS.filter(k => b[k] !== undefined && b[k] !== null && b[k] !== false).map(k => [k, b[k]]))
function normalize(d, date) {
  if (!d || typeof d !== 'object') return emptyDay(date)
  if (d.version === FILE_VERSION || (Array.isArray(d.blocks) && d.blocks.every(b => b.state))) {
    return { ...emptyDay(date), ...d, date, blocks: (d.blocks || []).filter(b => b && b.rowId && b.end > b.start).map(b => ({ ...b, by: b.by === 'claude' && b.state === 'draft' ? 'claude' : 'student', state: b.state === 'confirmed' ? 'confirmed' : 'draft' })).sort(byStart),
      removed: [...new Set(d.removed || [])], meals: d.meals && typeof d.meals === 'object' ? { ...d.meals } : {}, workable: d.workable && typeof d.workable === 'object' ? { ...d.workable } : {} }
  }
  // The second shape (§22.9–22.11): Claude's decided blocks and the student's pins were the day at once. Nothing there was
  // confirmed in the new sense, so every block comes over as a draft — Claude's his, a pin the student's — and a finished
  // block as confirmed; *not today* becomes removed.
  const blocks = (d.blocks || []).filter(b => b && b.rowId && b.end > b.start).map(b => ({ id: String(b.id || 'b-' + newId()).replace(/#/g, '-'), rowId: b.rowId, title: b.title || null, course: b.course || null, courseKey: b.courseKey || null, color: b.color || null, kind: b.kind || null, start: b.start, end: b.end,
    by: b.done || b.pinned ? 'student' : 'claude', state: b.done ? 'confirmed' : 'draft', why: b.pinned ? null : b.why || null, ...(b.done ? { done: true } : {}) }))
  return { ...emptyDay(date), blocks: blocks.sort(byStart), removed: [...new Set(d.notToday || [])], meals: d.meals && typeof d.meals === 'object' ? { ...d.meals } : {}, workable: d.workable && typeof d.workable === 'object' ? { ...d.workable } : {},
    draft: d.by === 'claude' ? { by: 'claude', at: d.decidedAt || d.builtAt || null, decision: d.decision || null, reason: d.decided?.reason || null, steer: d.steer?.text || null, note: null, from: d.decided?.from || null, picks: [], waiting: (d.decided?.waiting || []).filter(w => w?.rowId && w.why && w.why !== 'not weighed').map(w => ({ rowId: w.rowId, why: w.why })) } : null,
    updatedAt: d.alexAt || d.builtAt || null }
}
export async function readDays(root) {
  const f = await readJson(DAY_JSON(root), null)
  const raw = f && f.days && typeof f.days === 'object' ? f.days : f && f.date ? { [f.date]: f } : {}
  return { version: FILE_VERSION, days: Object.fromEntries(Object.entries(raw).filter(([d]) => ISO.test(d)).map(([d, x]) => [d, normalize(x, d)])) }
}
const stored = day => ({ date: day.date, blocks: (day.blocks || []).map(cleanBlock), removed: day.removed || [], meals: day.meals || {}, workable: day.workable || {}, draft: day.draft || null, request: day.request || null, confirmedAt: day.confirmedAt || null, sent: day.sent || null, updatedAt: day.updatedAt || null })

// The calendar readback's timed events, cut to one day: one running past midnight ends at 24:00 + its hour, one begun
// the day before starts at 00:00. All-day rows are not events.
function eventsFor(cal, d) {
  const out = []
  for (const ev of cal?.events || []) {
    if (!ev.start || !ev.end || ev.allDay) continue
    const sd = String(ev.start).slice(0, 10), ed = String(ev.end).slice(0, 10)
    if (sd > d || ed < d) continue
    const start = sd === d ? String(ev.start).slice(11, 16) : '00:00'
    const days = Math.round((new Date(ed + 'T12:00:00') - new Date(d + 'T12:00:00')) / 864e5)
    const endMin = Math.min(2880, days * 1440 + (toMin(String(ev.end).slice(11, 16)) ?? 0))
    if ((toMin(start) ?? 0) >= endMin) continue
    out.push({ id: ev.id || null, date: d, start, end: clock(endMin), allDay: false, title: ev.title || 'Busy', location: ev.location || null, slate: !!ev.slate })
  }
  return out
}

// gatherDay(root, { date, now }) → everything a day is made of, read once: the plan's rows for the date, the classes
// of the day and the next, the calendar's events, the preferences, the work log, and the day as it stands. `now`
// (HH:MM) is the hour a draft for today starts from.
export async function gatherDay(root, { date = todayIso(), now = null, createPrefs = false } = {}) {
  if (!ISO.test(String(date || ''))) throw new Error('date: YYYY-MM-DD')
  const nowMin = now == null ? null : toMin(now)
  if (now != null && nowMin == null) throw new Error('now: HH:MM')
  const { prefs, created } = await readPrefs(root, { create: createPrefs })
  const HUB = path.join(root, 'Hub')
  const [plan, hub, cal, brain, worklog, att, file, est] = await Promise.all([...['_plan.json', '_hub.json', '_calendar.json', '_brain.json', '_work-log.json', '_attendance.json'].map(f => readJson(path.join(HUB, f), null)), readDays(root), readEstimates(root)])
  const codes = (hub?.courses || []).map(c => c.code)
  const mine = parseMyTasks(await fs.readFile(path.join(root, MY_TASKS), 'utf8').catch(() => ''), codes.length ? codes : Object.values(COURSES).map(c => c.code))
  const tomorrow = addDays(date, 1)
  const covered = d => !!plan?.meetings?.length && (plan.since || plan.from || '9999') <= d && d <= (plan.to || '0000')
  const meetingsOn = d => (covered(d) ? plan.meetings.filter(m => m.date === d) : expandMeetings(d, d))
  const meetings = [...meetingsOn(date), ...meetingsOn(tomorrow)]
  const events = [...eventsFor(cal, date), ...eventsFor(cal, tomorrow)]
  // `past: 'all'`: a finished to-do of a class gone by stays a row (done), so a block knows it is done rather than orphaned.
  const rows = rowsFor({ plan, hub, tests: plan?.tests || [], today: date, now: now || null, testHorizon: 14, mine, courses: hub?.courses || [], past: 'all' })
  for (const r of rows) if (est.rows[r.id]) r.estimate = est.rows[r.id]     // his own minutes, over Claude's and the default
  const day = file.days[date] ? { ...file.days[date], blocks: file.days[date].blocks.map(b => ({ ...b })) } : emptyDay(date)
  // A class he says he will not be at (the attendance file, ahead of the class): its hours are his.
  const skipped = Object.entries(att?.classes || {}).filter(([, a]) => a && a.attended === false).map(([id]) => id).filter(id => meetings.some(m => m.id === id))
  const calibration = worklog?.calibration || {}
  const doneMinutes = (worklog?.sessions || []).filter(s => (s.date || String(s.start || '').slice(0, 10)) === date).reduce((n, s) => n + (Number(s.minutes) || 0), 0)
  return { root, date, now: now || null, nowMin, prefs, prefsCreated: created, plan, hub, cal, brain, worklog, file, day, rows, meetings, events, mine, skipped, estimates: est.rows, calibration, doneMinutes, tests: plan?.tests || [], brainOn: await brainEnabled(root) }
}

// The preferences for the day: a meal the student dragged sits where he put it and does not slide.
export const prefsOf = (g, day = g.day) => (day.meals && Object.keys(day.meals).length ? { ...g.prefs, meals: (g.prefs.meals || []).map(m => (day.meals[m.name] ? { ...m, start: day.meals[m.name], slide: 0 } : m)) } : g.prefs)
export const busyOf = (g, day = g.day) => busyFor({ date: g.date, meetings: g.meetings, events: g.events, prefs: prefsOf(g, day), workable: day.workable, skipped: g.skipped })
const rowDone = (g, rowId) => !!g.rows.find(r => r.id === rowId)?.done
// Every row weighed for the day — its minutes, its deadline, whether it happens in the room, whether the student took it off.
export function weigh(g, day = g.day) {
  const p = g.prefs, window = windowFor(g.date, p)
  const tomorrow = addDays(g.date, 1), tw = windowFor(tomorrow, p)
  const tomorrowFree = freeIntervals(busyFor({ date: tomorrow, meetings: g.meetings, events: g.events, prefs: p, skipped: g.skipped }), tw.start, tw.end, p.gap)
  const candidates = new Map()
  for (const r of g.rows) {
    const c = candidateOf(r, { date: g.date, prefs: p, dials: null, notToday: day.removed || [], calibration: g.calibration, tests: g.tests, tomorrowFree, window })
    if (c) candidates.set(c.rowId, c)
  }
  return { candidates, window, tomorrowFree }
}
// What happens in the room goes inside its class block for the day; on a day its class does not meet it is nothing.
function attachInRoom(busy, candidates, date) {
  for (const c of candidates.values()) {
    if (!c.inClass) continue
    const cls = busy.find(b => b.kind === 'class' && (c.meetingId ? b.id === c.meetingId : b.courseKey === c.courseKey && c.by === date))
    if (cls) (cls.inside ||= []).push({ rowId: c.rowId, title: c.title, kind: c.kind, level: c.level, nature: c.nature, action: c.action })
  }
}
// A block carries its row's name, course and pigment, so it still reads once the row is ticked and gone from the list.
function dressed(g, b) {
  const r = g.rows.find(x => x.id === b.rowId) || null
  return { ...b, title: r?.title ?? b.title ?? b.rowId, course: r?.course ?? b.course ?? null, courseKey: r?.courseKey ?? b.courseKey ?? null, color: r?.color ?? b.color ?? null, kind: r ? kindOfRow(r) : b.kind ?? null }
}

// ---- the day as the screen reads it ----------------------------------------------------------------------------------
// viewDay(g) → the day with what it holds: the blocks with their row's state (done), the classes with what happens in
// them, the walks, the events and meals, the window — and the lane it is drawn on.
export function viewDay(g, day = g.day) {
  const { candidates, window } = weigh(g, day)
  const busy = busyOf(g, day).map(b => ({ ...b }))
  attachInRoom(busy, candidates, g.date)
  const blocks = day.blocks.map(b => ({ ...dressed(g, b), done: !!b.done || rowDone(g, b.rowId) })).sort(byStart)
  return { ...stored(day), blocks, busy, window: { start: hm(window.start), end: window.end === 1440 ? '24:00' : hm(window.end), hardEnd: hm(window.hardEnd), startMin: window.start, endMin: window.end, hardEndMin: window.hardEnd } }
}

// ---- the student's acts ------------------------------------------------------------------------------------------------------
// Each takes the day as it stands and returns { day, notice }: the day to write, and one line when something moved that
// he did not move himself. What he puts down lands where he put it, or on the nearest free side of a class or a meal;
// what it lands on is pushed later (src/today.js pushDown), and every block that changes is a draft again until he
// confirms it — his answer of 2026-09-29: "all draft until Confirm".
const hardEndOf = g => windowFor(g.date, g.prefs).hardEnd
const parse = (v, name) => { const m = typeof v === 'number' ? v : toMin(v); if (m == null) throw new Error(`${name}: HH:MM`); return m }
const touched = day => ({ ...day, updatedAt: localStamp() })
function settle(g, day, anchor, { moved: mine = [] } = {}) {
  const walls = wallsOf(busyOf(g, day))
  const { blocks, moved, off } = pushDown(day.blocks.map(b => ({ ...b, done: !!b.done || rowDone(g, b.rowId) })), anchor, walls, { hardEnd: hardEndOf(g) })
  const changed = new Set([...moved, ...mine])
  // `done` was read from the row for the push; what is stored stays what the block said.
  const next = blocks.map(b => { const x = { ...b }; const was = day.blocks.find(o => o.id === b.id); if (was?.done) x.done = true; else delete x.done; return changed.has(b.id) ? { ...x, state: 'draft', confirmedAt: null } : x })
  const offRows = day.blocks.filter(b => off.includes(b.id))
  const notice = [moved.length ? `${moved.length === 1 ? 'One block' : `${moved.length} blocks`} pushed later to make room` : null, offRows.length ? `${offRows.map(b => `“${dressed(g, b).title}”`).join(', ')} pushed past 03:00 — back in the list` : null].filter(Boolean).join('; ') || null
  return { day: touched({ ...day, blocks: next }), notice }
}
function landing(g, day, { id = null, start, len }) {
  const walls = [...wallsOf(busyOf(g, day)), ...day.blocks.filter(b => b.id !== id && (b.done || rowDone(g, b.rowId))).map(b => ({ start: b.start, end: b.end }))]
  const lo = 0, hi = hardEndOf(g)
  if (len < 5) throw new Error('a block is at least five minutes')
  if (len > hi) throw new Error('longer than the day')
  return snapStart(Math.max(lo, Math.min(start, hi - len)), len, walls, lo, hi)
}

// A to-do dropped on an hour: a draft of his at the length he dropped it. A row already on the day moves instead.
export function placeRow(g, day, { rowId, start, end }) {
  const r = g.rows.find(x => x.id === rowId); if (!r) throw new Error(`no to-do ${rowId} on ${g.date}`)
  if (r.done) throw new Error(`“${r.title}” is done already`)
  const c = weigh(g, day).candidates.get(rowId)
  if (c?.inClass) throw new Error(`“${r.title}” happens in the room — it is on the class already`)
  const s0 = parse(start, 'start'), e0 = parse(end, 'end')
  const on = day.blocks.find(b => b.rowId === rowId && !b.done)
  if (on) return moveBlock(g, { ...day, removed: (day.removed || []).filter(x => x !== rowId) }, { id: on.id, start: s0, end: s0 + (e0 - s0) })
  const s = landing(g, day, { start: s0, len: e0 - s0 })
  const blk = dressed(g, { id: 'b-' + newId(), rowId, start: s, end: s + (e0 - s0), by: 'student', state: 'draft', why: null })
  return settle(g, { ...day, removed: (day.removed || []).filter(x => x !== rowId), blocks: [...day.blocks, blk] }, blk, { moved: [blk.id] })
}
// A block dragged to another hour, or its foot to another length: his now, and a draft again.
export function moveBlock(g, day, { id, start, end }) {
  const b = day.blocks.find(x => x.id === id); if (!b) throw new Error(`no block ${id} on ${g.date}`)
  if (b.done || rowDone(g, b.rowId)) throw new Error('that one is done — it stays where it happened')
  const s0 = parse(start, 'start'), e0 = parse(end, 'end')
  let s = s0, e = e0
  if (s0 === b.start && e0 !== b.end) {
    // The foot: it stops at the next wall.
    const wall = [...wallsOf(busyOf(g, day)), ...day.blocks.filter(x => x.id !== id && (x.done || rowDone(g, x.rowId)))].filter(w => w.start >= s + 5 && w.start < e).sort(byStart)[0]
    if (wall) e = wall.start
    if (e - s < 5) throw new Error('a block is at least five minutes')
    if (e > hardEndOf(g)) throw new Error('nothing after 03:00')
  } else { s = landing(g, day, { id, start: s0, len: e0 - s0 }); e = s + (e0 - s0) }
  const nb = { ...b, start: s, end: e, by: 'student', state: 'draft', confirmedAt: null }
  return settle(g, { ...day, blocks: day.blocks.map(x => (x.id === id ? nb : x)) }, nb, { moved: [id] })
}
// Off the day: the block goes, the row is back in the list with no hour, and Claude never proposes it again on this
// date (his answer: "back to the list, unscheduled"). A finished block can be cleared from the lane too.
export function removeBlock(g, day, { id }) {
  const b = day.blocks.find(x => x.id === id); if (!b) throw new Error(`no block ${id} on ${g.date}`)
  const blocks = day.blocks.filter(x => x.id !== id)
  const still = blocks.some(x => x.rowId === b.rowId)
  const done = b.done || rowDone(g, b.rowId)
  return { day: touched({ ...day, blocks, removed: done || still ? day.removed : [...new Set([...(day.removed || []), b.rowId])] }), notice: null }
}
// Confirmed: solid, his. `ids` null confirms every draft on the day.
export function confirmBlocks(g, day, { ids = null } = {}) {
  const at = localStamp(), want = ids ? new Set(ids) : null
  let n = 0
  const blocks = day.blocks.map(b => { if (b.state !== 'draft' || (want && !want.has(b.id))) return b; n++; return { ...b, state: 'confirmed', by: 'student', confirmedAt: at } })
  if (!n) throw new Error('nothing to confirm')
  return { day: touched({ ...day, blocks, confirmedAt: at }), notice: null, confirmed: n }
}
// A meal dragged to another hour stays there for the day (`start: null` puts it back); what it lands on is pushed later.
// Never onto a class, a walk or an event he cannot work through.
export function moveMeal(g, day, { name, start }) {
  const meal = (g.prefs.meals || []).find(m => m.name === name); if (!meal) throw new Error(`no meal called ${name}`)
  const meals = { ...(day.meals || {}) }
  if (start === null) delete meals[name]
  else if (start !== undefined) {
    const s = parse(start, 'start'), len = Number(meal.minutes) || 45
    const hard = wallsOf(busyFor({ date: g.date, meetings: g.meetings, events: g.events, prefs: { ...g.prefs, meals: [] }, workable: day.workable, skipped: g.skipped }))
    const hit = hard.find(x => x.start < s + len && s < x.end); if (hit) throw new Error(`${name} would sit on ${hit.title} ${span(hit.start, hit.end)}`)
    meals[name] = clock(s)
  }
  const next = { ...day, meals }
  const slot = busyOf(g, next).find(b => b.kind === 'meal' && b.title === name)
  if (!slot) return { day: touched(next), notice: `${name} does not fit anywhere today` }
  return settle(g, next, { id: `meal:${name}`, start: slot.start, end: slot.end })
}
// An event he can work through (the bus) or cannot after all; blocks on one he cannot are pushed off it.
export function setWorkable(g, day, { id, on }) {
  const workable = { ...(day.workable || {}) }
  if (on === null || on === undefined) delete workable[id]; else workable[id] = !!on
  const next = { ...day, workable }
  const ev = busyOf(g, next).find(b => b.kind === 'event' && b.id === id)
  if (!ev || ev.workable) return { day: touched(next), notice: null }
  return settle(g, next, { id: `event:${id}`, start: ev.start, end: ev.end })
}

// ---- Claude's draft -------------------------------------------------------------------------------------------------
// briefDay(g, { from }) → everything Claude needs to draft the day and nothing he has to go and read: the hours the day
// holds and leaves, what the student has already put on it (it stays), what he took off (never propose it here), his note, every
// row with its minutes and deadline, and the packer's arithmetic.
export function briefDay(g, { from = g.now, runSteer = null } = {}) {
  const day = g.day
  const { candidates, window, tomorrowFree } = weigh(g, day)
  const p = g.prefs, busy = busyOf(g, day)
  attachInRoom(busy, candidates, g.date)
  const fromMin = from == null ? null : toMin(from)
  const stays = day.blocks.filter(b => b.by === 'student' || b.state === 'confirmed' || b.done).map(b => ({ ...dressed(g, b), done: !!b.done || rowDone(g, b.rowId) }))
  const mine = day.blocks.filter(b => b.by === 'claude').map(b => dressed(g, b))
  const taken = [...busy, ...stays.map(b => ({ start: b.start, end: b.end, kind: 'block' }))]
  const start = fromMin != null ? Math.max(window.start, fromMin) : window.start
  const free = freeIntervals(taken, start, window.end, p.gap), late = freeIntervals(taken, Math.max(start, window.end), window.hardEnd, p.gap)
  const packed = packDay({ date: g.date, now: fromMin, rows: g.rows, meetings: g.meetings, events: g.events, prefs: prefsOf(g, day), kept: stays.map(b => ({ rowId: b.rowId, start: b.start, end: b.end, title: b.title })), notToday: day.removed || [], skipped: g.skipped, calibration: g.calibration, tests: g.tests, doneMinutes: g.doneMinutes, workable: day.workable })
  const at = i => `${clock(i.start)}–${clock(i.end)}`
  const dow = weekdayOf(g.date)
  const onDay = new Map(stays.map(b => [b.rowId, at(b)]))
  const horizon = t => t.date && (new Date(t.date + 'T12:00:00') - new Date(g.date + 'T12:00:00')) / 864e5
  return {
    date: g.date, weekday: dow, from: fromMin != null ? clock(fromMin) : null, window: { start: clock(window.start), end: clock(window.end), hardEnd: clock(window.hardEnd) },
    budget: { standing: p.budget[dow] ?? 240 },
    note: day.request?.note || null,
    runSteer: String(runSteer || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,     // this run only; below his note
    prefs: { walk: p.walk, gap: p.gap, split: p.split, meals: prefsOf(g, day).meals, fixed: (p.fixed || []).filter(f => (!f.day || f.day === dow) && (!f.date || f.date === g.date)), tiers: p.tiers, tierNames: p.tierNames, testHorizon: p.testHorizon },
    student: {
      stays: stays.map(b => ({ row: b.rowId, title: b.title, at: at(b), state: b.done ? 'done' : b.state })),
      removed: (day.removed || []).map(id => ({ row: id, title: g.rows.find(r => r.id === id)?.title || null })),
      workable: day.workable, notGoing: busy.filter(b => b.skipped).map(b => b.title),
    },
    yourDraft: mine.map(b => ({ row: b.rowId, title: b.title, at: at(b), why: b.why })),
    busy: busy.map(b => ({ kind: b.kind, title: b.title, at: at(b), where: b.where || null, workable: !!b.workable, notGoing: b.skipped ? true : undefined, inside: b.inside?.map(x => x.title) || undefined, id: b.id || undefined })),
    free: free.map(i => ({ at: at(i), minutes: i.end - i.start })), late: late.map(i => ({ at: at(i), minutes: i.end - i.start })), freeMinutes: sumOf(free),
    tomorrow: { free: tomorrowFree.map(i => ({ at: at(i), minutes: i.end - i.start })), freeMinutes: sumOf(tomorrowFree) },
    rows: [...candidates.values()].map(c => ({
      id: c.rowId, course: c.course, title: c.title, kind: c.kind, level: c.level, nature: c.nature, by: c.row.by || null, when: c.row.when || null,
      daysLeft: c.dueAt?.days ?? null, wantedBefore: c.dueAt?.days === 0 && c.dueAt?.min != null ? clock(c.dueAt.min) : null, overdue: !!c.catchup, inRoom: !!c.inClass,
      minutes: c.inClass ? 0 : c.minutes, estimate: c.inClass || !c.estimate ? null : { student: c.estimate.student ? c.estimate.base : null, claude: c.estimate.claude ? c.estimate.base : null, default: c.estimate.student || c.estimate.claude ? null : c.estimate.base, ratio: c.estimate.ratio },
      test: c.testDriven ? { title: c.testDriven.title, date: c.testDriven.date, daysLeft: c.testDriven.daysLeft } : null, splittable: c.inClass ? false : !!c.splittable,
      removed: c.excluded === 'not today' || undefined, onDay: onDay.get(c.rowId) || undefined, reason: c.row.reason || null, link: c.row.action?.url || c.row.action?.path || null,
    })),
    tests: (g.tests || []).filter(t => horizon(t) != null && horizon(t) >= 0 && horizon(t) <= p.testHorizon).map(t => ({ course: t.course, title: t.title, date: t.date, daysLeft: Math.round(horizon(t)) })),
    log: { doneToday: g.doneMinutes, calibration: g.calibration },
    packer: { planned: packed.numbers.planned, blocks: packed.blocks.filter(b => !b.pinned && !b.done).map(b => ({ row: b.rowId, start: clock(b.start), end: clock(b.end), title: b.title, why: b.why })), waiting: packed.unplaced.map(u => ({ row: u.rowId, title: u.title, why: u.why })) },
  }
}

// checkDraft(g, input, { from, lenient }) → { reason, steer, from, blocks, waiting, picks }, or throws with the one thing
// wrong. input: { reason, steer?, blocks: [{ row, start, end, why }], waiting?: [{ row, why }], picks?: [row] } — times
// HH:MM, 25:30 for half past one the next morning. A block is a row of the day, never one that happens in the room,
// never one the student took off, never one he has already put on the day; inside the window, before the hard end and its own
// deadline, after `from`; on nothing the day holds and on none of his blocks. `lenient` (the packer's own draft) drops
// a block that fails instead of refusing the whole.
export function checkDraft(g, input, { from = null, lenient = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('day set expects a JSON object: { reason, steer?, blocks: [{ row, start, end, why }], waiting: [{ row, why }], picks: [row] }')
  const reason = reasonOf(input.reason)
  const steer = input.steer == null || String(input.steer).trim() === '' ? null : oneLine(input.steer, 'steer', 3, 200)
  const day = g.day
  const { candidates: byId, window } = weigh(g, day)
  const folded = new Map([...byId].map(([id, c]) => [quoteFold(id), c]))
  const candidates = { get: id => byId.get(id) ?? folded.get(quoteFold(id)) }
  const fromMin = from == null ? null : toMin(from)
  if (from != null && fromMin == null) throw new Error('from: HH:MM')
  const walls = busyOf(g, day).filter(b => !b.workable && ['class', 'walk', 'event', 'fixed', 'meal'].includes(b.kind))
  const stays = day.blocks.filter(b => b.by === 'student' || b.state === 'confirmed' || b.done).map(b => dressed(g, b))
  const blocks = [], seen = new Set()
  for (const [i, b] of (Array.isArray(input.blocks) ? input.blocks : []).entries()) {
    try {
      if (!b || typeof b !== 'object') throw new Error('a block is { row, start, end, why }')
      const c = candidates.get(b.row)
      if (!c) throw new Error(`no row ${JSON.stringify(b.row ?? null)} on this day — the ids are in day brief → rows`)
      if (c.inClass) throw new Error(`"${c.title}" happens in the room: it is on the class block already, not a block of its own`)
      if (c.excluded === 'not today') throw new Error(`"${c.title}": the student took it off this day — never propose it here`)
      const own = stays.find(x => x.rowId === c.rowId); if (own) throw new Error(`"${c.title}" is on the day already at ${span(own.start, own.end)}, where the student has it`)
      const start = toMin(b.start), end = toMin(b.end)
      if (start == null || end == null) throw new Error('start and end: HH:MM (25:30 for half past one the next morning)')
      if (end <= start) throw new Error('end must come after start')
      if (end - start < 10) throw new Error('a block is at least ten minutes')
      if (start < window.start) throw new Error(`before the window opens at ${hm(window.start)}`)
      if (end > window.hardEnd) throw new Error(`past the hard end at ${hm(window.hardEnd)} — nothing after 03:00`)
      if (fromMin != null && start < fromMin) throw new Error(`before ${from}: draft only from then on`)
      const why = clipLine(b.why, 'why', 3, 160)
      const blk = { start, end }
      const hit = walls.find(x => overlaps(x, blk)); if (hit) throw new Error(`overlaps ${hit.title} ${span(hit.start, hit.end)}${hit.kind === 'meal' ? ' — a meal' : hit.kind === 'walk' ? ' — the walk' : ''}`)
      const his = stays.find(x => overlaps(x, blk)); if (his) throw new Error(`overlaps ${his.title} ${span(his.start, his.end)}, which the student has on the day`)
      const mine = blocks.find(x => overlaps(x, blk)); if (mine) throw new Error(`overlaps your own block ${span(mine.start, mine.end)}`)
      if (c.dueAt.days === 0 && c.dueAt.min != null && end > c.dueAt.min) throw new Error(`"${c.title}" is wanted before ${hm(c.dueAt.min)}${c.row.type === 'prep' ? ' — the walk to its class' : ''}`)
      blocks.push({ rowId: c.rowId, start, end, why }); seen.add(c.rowId)
    } catch (e) { if (lenient) continue; throw new Error(`block ${i + 1}: ${e.message}`) }
  }
  const waiting = []
  for (const [i, w] of (Array.isArray(input.waiting) ? input.waiting : []).entries()) {
    const c = candidates.get(w?.row)
    if (!c) { if (lenient) continue; throw new Error(`waiting ${i + 1}: no row ${JSON.stringify(w?.row ?? null)} on this day`) }
    if (seen.has(c.rowId) || waiting.some(x => x.rowId === c.rowId)) continue
    waiting.push({ rowId: c.rowId, why: clipLine(w.why, `waiting ${i + 1}: why`, 3, 160) })
  }
  const picks = []
  for (const [i, id] of (Array.isArray(input.picks) ? input.picks : []).entries()) {
    const c = candidates.get(id)
    if (!c) { if (lenient) continue; throw new Error(`picks ${i + 1}: no row ${JSON.stringify(id ?? null)} on this day`) }
    if (c.inClass || picks.includes(c.rowId)) continue
    picks.push(c.rowId)
  }
  if (picks.length > 40) throw new Error('picks: at most 40 — the rows that matter for this day, not all of them')
  return { reason, steer, from: fromMin != null ? clock(fromMin) : null, blocks: blocks.sort(byStart), waiting, picks }
}
// The draft laid on the day: Claude's own drafts go, his new ones come in; what the student put down, confirmed or not, stays.
export function applyDraft(g, day, checked, { by = 'claude', decision = null } = {}) {
  const keep = day.blocks.filter(b => b.by !== 'claude')
  const fresh = checked.blocks.map(b => dressed(g, { id: 'b-' + newId(), rowId: b.rowId, start: b.start, end: b.end, by: 'claude', state: 'draft', why: b.why }))
  const picks = checked.picks.length ? checked.picks : [...new Set([...fresh.map(b => b.rowId), ...checked.waiting.map(w => w.rowId)])]
  return { ...day, blocks: [...keep, ...fresh].sort(byStart), draft: { by, at: localStamp(), decision, reason: checked.reason, steer: checked.steer, note: day.request?.note || null, from: checked.from, picks, waiting: checked.waiting }, request: null, updatedAt: localStamp() }
}
// The packer's arithmetic as a draft — the brain off, or a test: the same checks, a failing block dropped.
export function packerDraft(g, { from = g.now } = {}) {
  const b = briefDay(g, { from })
  return checkDraft(g, { reason: 'The packer drafted this day from the hours and the levels', steer: null, blocks: b.packer.blocks.map(x => ({ row: x.row, start: x.start, end: x.end, why: x.why || 'there was room' })), waiting: b.packer.waiting.map(x => ({ row: x.row, why: x.why || 'no room' })) }, { from, lenient: true })
}
// proposeDay(root, brain, input, { date, from }) → { day, decision }: Claude's draft checked, recorded (the day as it was is
// the way back), and written through. Its caller (`brain.mjs day set`) holds the brain's lock, so the day is gathered
// after any act of the student's that got there first, and none lands between the gather and the write (serialDay).
export async function proposeDay(root, brain, input, { date = todayIso(), from = null } = {}) {
  const g = await gatherDay(root, { date, now: from })
  const checked = checkDraft(g, input, { from })
  const before = { day: g.file.days[date] ? stored(g.file.days[date]) : null, page: await fs.readFile(WORK_MD(root), 'utf8').catch(() => null) }
  const d = decide(brain, { type: 'day', summary: `${date}${from ? ` from ${from}` : ''}: draft of ${checked.blocks.length} block(s), ${checked.waiting.length} waiting${checked.steer ? ` · ${checked.steer}` : ''}`, reason: checked.reason, undo: { date, before } })
  const day = applyDraft(g, g.day, checked, { by: 'claude', decision: d.id })
  await writeDay(root, day, { g })
  return { day, decision: d, g }
}

// ---- the files ------------------------------------------------------------------------------------------------------
const h = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`)
// dayLines(view) → the day in the order it runs: classes with what happens in them, events, and every block with its
// state — the page, the morning note and `day show` all read these.
export function dayLines(v) {
  const items = []
  for (const b of v.busy || []) {
    if (b.kind === 'class') items.push({ start: b.start, line: `${span(b.start, b.end)} · ${b.title}${b.where ? ` · ${b.where}` : ''}${b.skipped ? ' · not going' : ''}${b.inside?.length ? ` · during it: ${b.inside.map(x => x.title).join('; ')}` : ''}` })
    else if (b.kind === 'event' || b.kind === 'fixed') items.push({ start: b.start, line: `${span(b.start, b.end)} · ${b.title}${b.workable ? ' · workable' : ''}` })
  }
  for (const b of v.blocks || []) items.push({ start: b.start, line: `${span(b.start, b.end)} · ${b.course || '—'} · ${b.title} · ${b.end - b.start} min · ${b.done ? 'done' : b.state === 'confirmed' ? 'confirmed' : b.by === 'claude' ? 'draft (Claude)' : 'draft (yours)'}` })
  return items.sort((a, b) => a.start - b.start).map(x => x.line)
}
export function statusLine(v) {
  const drafts = (v.blocks || []).filter(b => b.state === 'draft' && !b.done).length, conf = (v.blocks || []).filter(b => b.state === 'confirmed').length
  if (!v.blocks?.length) return v.draft ? `Claude drafted nothing to place${v.draft.at ? ` at ${String(v.draft.at).slice(11, 16)}` : ''}` : 'Nothing planned yet'
  if (!drafts) return `Confirmed${v.confirmedAt ? ` at ${String(v.confirmedAt).slice(11, 16)}` : ''} · ${conf} block${conf === 1 ? '' : 's'}`
  return `Draft — ${drafts} block${drafts === 1 ? '' : 's'} to confirm in Slate${conf ? ` · ${conf} confirmed` : ''}`
}
export function renderWorkPage(v, { today = todayIso(), head = '## ' } = {}) {
  const rel = v.date === today ? 'today' : v.date === addDays(today, 1) ? 'tomorrow' : v.date < today ? 'past' : null
  const planned = (v.blocks || []).filter(b => !b.done).reduce((n, b) => n + b.end - b.start, 0)
  const lines = [`${head}${weekdayOf(v.date)} ${shortIso(v.date)}${rel ? ` — ${rel}` : ''}`, '', `_${statusLine(v)}${planned ? ` · ${h(planned)} of work` : ''}._${v.draft?.steer ? `\n\n> ${v.draft.steer}` : ''}`, '']
  const day = dayLines(v)
  lines.push(...(day.length ? day.map(l => `- ${l}`) : ['- Nothing on this day.']))
  return lines.join('\n') + '\n'
}
// The page holds every day that stands from yesterday on; each is read again with what it holds.
export async function renderWorkPages(root, file, { today = todayIso(), g = null } = {}) {
  const dates = Object.keys(file.days || {}).filter(d => d >= addDays(today, -1)).sort()
  const parts = []
  for (const d of dates) {
    const gd = g && g.date === d ? g : await gatherDay(root, { date: d }).catch(() => null)
    parts.push(renderWorkPage(gd ? viewDay(gd, file.days[d]) : { ...file.days[d], busy: [] }, { today }))
  }
  return `# Today's work\n\n_Read, do not edit — the app is where you move and confirm things._\n\n${parts.length ? parts.join('\n') : '_No day stands yet._\n'}`
}
// writeDay(root, day, { g }) → the file (this day replaced, days older than yesterday struck), the page, and the day log.
export async function writeDay(root, day, { g = null, today = todayIso() } = {}) {
  await fs.mkdir(path.dirname(WORK_MD(root)), { recursive: true })
  const file = await readDays(root)
  file.days[day.date] = normalize(stored(day), day.date)
  for (const d of Object.keys(file.days)) if (d < addDays(today, -1)) delete file.days[d]
  const out = { version: FILE_VERSION, days: Object.fromEntries(Object.entries(file.days).sort(([a], [b]) => a.localeCompare(b)).map(([d, x]) => [d, stored(x)])) }
  await writeAtomic(DAY_JSON(root), JSON.stringify(out, null, 2) + '\n')
  const oldMd = await fs.readFile(WORK_MD(root), 'utf8').catch(() => null)
  const fm = oldMd ? (parsePage(oldMd).frontmatterRaw || '---\nkind: "summary"\n---\n') : '---\nkind: "summary"\n---\n'
  const md = fm + await renderWorkPages(root, file, { today, g: g && g.date === day.date ? { ...g, day: file.days[day.date] } : null })
  if (md !== oldMd) await writeAtomic(WORK_MD(root), md)
  const sl = await readJson(TODAY_SLATE(root), null)
  if (sl && Array.isArray(sl.order) && !sl.order.includes("Today's work")) { const i = sl.order.indexOf('Next 7 days'); sl.order.splice(i >= 0 ? i + 1 : sl.order.length, 0, "Today's work"); await writeAtomic(TODAY_SLATE(root), JSON.stringify(sl, null, 2) + '\n') }
  await noteDay(root, g ? viewDay({ ...g, day: file.days[day.date] }, file.days[day.date]) : file.days[day.date]).catch(() => { })
  return file.days[day.date]
}

// What the student asked for when he pressed Draft: one line the brief hands Claude ("light day, ECO208 first") — his steer now
// that the Weigh menu is gone. Cleared when the draft lands.
export async function setRequest(root, date, note) {
  return serialDay(root, async () => {
    const g = await gatherDay(root, { date, createPrefs: true })
    const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    return writeDay(root, { ...g.day, request: text ? { note: text, at: localStamp() } : null }, { g })
  })
}

// One writer of the day at a time (SPEC §23: what the student did is never lost to a Claude write). Every writer gathers the
// whole date and writes the whole date back, so two that overlap keep only the later one's copy: two quick drags on the
// screen, or a drag while the agent's draft lands. `fn` does its gather and its write inside: here in turn (a queue, so
// the screen's acts land in the order he made them) and under the brain's lock across processes — the lock `brain.mjs
// day set` already holds around proposeDay, which gathers inside it, so each side reads what the other wrote. Never
// call it from inside that lock (the lock is not re-entrant): proposeDay does not.
const queues = new Map()
export function serialDay(root, fn) {
  const run = (queues.get(root) || Promise.resolve()).then(() => withLock(root, fn))
  queues.set(root, run.catch(() => { }))
  return run
}
