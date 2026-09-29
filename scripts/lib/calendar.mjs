// The Google Calendar sync's pure core (SPEC §20.8): the desired set of events, their tags and hashes, the diff
// against what the Claude pass listed, the commit that records what landed, the readback validator and the
// Hub/Today/Calendar.md renderer. No I/O, no Date.now(): every function takes its `today` or `now`, so
// scripts/calendar-events.mjs --selftest can freeze the clock. Meetings come from src/calendar.js (the one
// place COURSES[].meetings is expanded); term facts from terms.mjs. Node plans, Claude applies.
import { createHash } from 'node:crypto'
import { ACADEMIC } from '../../src/palette.js'
import * as terms from './terms.mjs'
import { COURSES, weekFor } from './terms.mjs'
import { expandMeetings, addDays, weekdayOf } from '../../src/calendar.js'

export const TZ = 'America/Toronto'
export const YEAR_END = '2027-04-30'            // tests and deadlines are pushed through the end of the academic year
export const DEFAULT_HORIZON = 35               // meetings this many days ahead
export const DEFAULT_MAX_WRITES = 60            // per run; the diff converges over mornings
// SPEC §20.8: the primary calendar, until terms.mjs names a dedicated one (`export const CALENDAR_NAME = 'slate'`).
export const CALENDAR_NAME = terms.CALENDAR_NAME || 'primary'
export const REMINDERS = {
  test: [{ method: 'popup', minutes: 1440 }, { method: 'popup', minutes: 60 }],
  due: [{ method: 'popup', minutes: 1440 }, { method: 'popup', minutes: 120 }],
}
// Google event colours 1–11 (Calendar API `colors.event`), by id, name, hex.
export const GOOGLE_COLORS = [['1', 'Lavender', '#7986cb'], ['2', 'Sage', '#33b679'], ['3', 'Grape', '#8e24aa'], ['4', 'Flamingo', '#e67c73'], ['5', 'Banana', '#f6bf26'], ['6', 'Tangerine', '#f4511e'], ['7', 'Peacock', '#039be5'], ['8', 'Graphite', '#616161'], ['9', 'Blueberry', '#3f51b5'], ['10', 'Basil', '#0b8043'], ['11', 'Tomato', '#d50000']].map(([id, name, hex]) => ({ id, name, hex }))
const rgb = hex => { const h = String(hex || '').replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return Number.isNaN(n) || h.length < 3 ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
// The Google colour nearest a course colour: ECO206 → Blueberry, ECO208 → Basil, ECO227 → Tangerine. Google's palette is
// saturated and a course's colour is a pigment (SPEC §20.60) — navy, forest, bronze — which by RGB distance all land on
// Graphite. So a pigment is matched by the swatch it stands for (src/palette.js, the same table the client remaps with),
// and only then by RGB distance, which is what any other hex still gets.
const SWATCH = Object.fromEntries(Object.entries(ACADEMIC).map(([swatch, pigment]) => [pigment, swatch]))
export function nearestGoogleColor(hex) {
  const c = rgb(SWATCH[String(hex || '').toLowerCase()] || hex); if (!c) return null
  let best = null, bd = Infinity
  for (const g of GOOGLE_COLORS) { const d = rgb(g.hex).reduce((s, v, i) => s + (v - c[i]) ** 2, 0); if (d < bd) { bd = d; best = g } }
  return { id: best.id, name: best.name }
}

// ---- Toronto time ------------------------------------------------------------------------------
// Everything is stamped with the offset Toronto has at that instant (-04:00 until 2026-11-01, -05:00 after),
// through Intl, so the files are right whatever zone the Mac is in.
const PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' })
const pad = n => String(n).padStart(2, '0')
export function torontoParts(d) {
  const p = Object.fromEntries(PARTS.formatToParts(d).map(x => [x.type, x.value]))
  let off = p.timeZoneName === 'GMT' || p.timeZoneName === 'UTC' ? '+00:00' : p.timeZoneName.replace(/^(GMT|UTC)/, '')
  if (/^[+-]\d$/.test(off)) off = off[0] + '0' + off[1]
  if (/^[+-]\d{2}$/.test(off)) off += ':00'
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, offset: off }
}
const offsetMs = off => { const m = /^([+-])(\d{2}):(\d{2})$/.exec(off); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0 }
// An instant as a Toronto ISO stamp: '2026-11-05T13:00:00-05:00'.
export const stampOf = d => { const p = torontoParts(d); return `${p.date}T${p.time}${p.offset}` }
export const torontoToday = (d = new Date()) => torontoParts(d).date
// The stamp of a wall-clock time on a date, Toronto offset for that moment (DST-correct).
export function stampFor(dateIso, hhmm) {
  const [y, m, d] = dateIso.split('-').map(Number), [hh, mi] = hhmm.split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, hh, mi, 0)
  let t = wall
  for (let i = 0; i < 2; i++) t = wall - offsetMs(torontoParts(new Date(t)).offset)
  return `${dateIso}T${pad(hh)}:${pad(mi)}:00${torontoParts(new Date(t)).offset}`
}
// The Toronto date an event starts on: date-only stays; an instant with Z or an offset is converted; a bare local time keeps its date.
export function dateOfStart(s) {
  const v = String(s || '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? v.slice(0, 10) : torontoParts(d).date }
  return v.slice(0, 10)
}
const hhmmOf = s => { const v = String(s || ''); if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return null; if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : torontoParts(d).time.slice(0, 5) } const m = /T(\d{2}:\d{2})/.exec(v); return m ? m[1] : null }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const shortDay = iso => { const [y, m, d] = iso.split('-').map(Number); return `${weekdayOf(iso)} ${MONTHS[m - 1]} ${d}` }

// ---- tags and hashes ---------------------------------------------------------------------------
// The last line of every description slate writes: slate:<code>:<date>:<kind>[:<id>]#<hash>.
export const TAG_RE = /^slate:([A-Z]{3}\d{3}):(\d{4}-\d{2}-\d{2}):(lecture|tutorial|test|due)(?::([^#\s]+))?#([0-9a-f]{8})$/
export const TAG_ONLY_RE = /^slate:([A-Z]{3}\d{3}):(\d{4}-\d{2}-\d{2}):(lecture|tutorial|test|due)(?::([^#\s]+))?$/
export const tagOf = (code, date, kind, id) => `slate:${code}:${date}:${kind}${id ? ':' + id : ''}`
export function parseTag(tag) { const m = TAG_ONLY_RE.exec(String(tag || '').trim()); return m ? { tag: m[0], code: m[1], date: m[2], kind: m[3], id: m[4] || null } : null }
export function parseTagLine(line) {
  const m = TAG_RE.exec(String(line || '').trim())
  return m ? { tag: m[0].slice(0, m[0].lastIndexOf('#')), hash: m[5], code: m[1], date: m[2], kind: m[3], id: m[4] || null } : null
}
export const tagLineOf = description => String(description || '').trimEnd().split('\n').pop()
// A description without its tag line (and the blank line before it).
export function bodyOf(description) {
  const lines = String(description || '').trimEnd().split('\n')
  if (parseTagLine(lines[lines.length - 1])) { lines.pop(); while (lines.length && lines[lines.length - 1] === '') lines.pop() }
  return lines.join('\n')
}
// First 8 hex of sha1 over every field slate sets; the body is the description without its tag line.
export function hashEvent(e) {
  const body = e.body != null ? e.body : bodyOf(e.description)
  return createHash('sha1').update([e.summary, e.start, e.end, String(!!e.allDay), e.location || '', e.color?.id || '', JSON.stringify(e.reminders ?? null), body].join('\n')).digest('hex').slice(0, 8)
}
const finish = (row, lines) => { const body = lines.filter(Boolean).join('\n'); const hash = hashEvent({ ...row, body }); return { ...row, hash, description: `${body}\n\n${row.tag}#${hash}` } }
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item'
const codeOf = (courseKey, c) => c?.code || String(courseKey).replace(/\s+/g, '').slice(0, 6)
const weekLine = (courseKey, c, date) => { const w = c?.term ? weekFor(c.term, date) : null; return w ? `${w.label} · slate: ${courseKey}/${w.dir}.md` : null }

// ---- the desired set ---------------------------------------------------------------------------
// This course's future tests, one per date: the syllabus (grading items, else COURSES[k].tests) united with
// hub.tests (Quercus rows carry a url). The syllabus row names it; the Quercus row contributes the url.
function testsOf(courseKey, c, hub, today, yearEnd) {
  const rows = new Map()
  const items = (c.grading?.components || []).filter(x => x.key === 'tests').flatMap(x => x.items || []).filter(i => i.date)
  for (const [date, title] of c.tests || []) { const it = items.find(i => i.date === date); rows.set(date, { date, title: (it?.label || title).split(' · ')[0], coverage: it?.coverage || null, assumed: !!it?.assumed, url: null, source: 'syllabus' }) }
  for (const it of items) if (!rows.has(it.date)) rows.set(it.date, { date: it.date, title: it.label.split(' · ')[0], coverage: it.coverage || null, assumed: !!it.assumed, url: null, source: 'syllabus' })
  for (const t of hub?.tests || []) {
    if (t.courseKey !== courseKey || !t.date) continue
    const cur = rows.get(t.date)
    if (cur) { if (t.url && !cur.url) cur.url = t.url }
    else rows.set(t.date, { date: t.date, title: String(t.title || 'Test').split(' · ')[0], coverage: null, assumed: false, url: t.url || null, source: 'quercus' })
  }
  return [...rows.values()].filter(r => r.date >= today && r.date <= yearEnd).sort((a, b) => a.date.localeCompare(b.date))
}
// The timetable slot a course has on a date (its first meeting that weekday), or null.
const slotOn = (c, date) => (c.meetings || []).filter(m => m.day === weekdayOf(date)).sort((a, b) => a.start.localeCompare(b.start))[0] || null

// → { desired: [row], counts, warnings }. Rows are sorted by start, then tag. Tests, deadlines and tutorials by
// default; lectures when `lectures` (SLATE_CAL_LECTURES=1). A test takes its day's slot and that meeting is dropped;
// a test on a day with no meeting is all-day; a deadline is the last half hour before it is due. Deadline rows
// without a time (unconfirmed WebAssign sets, SPEC §20.2) are skipped until confirmed.
export function desiredEvents({ courses = COURSES, hub = null, today, horizon = DEFAULT_HORIZON, yearEnd = YEAR_END, lectures = false, syllabus } = {}) {
  if (!today) throw new Error('desiredEvents: today is required')
  const warnings = [], counts = { meetings: 0, tutorials: 0, lectures: 0, tests: 0, deadlines: 0, skippedDeadlines: 0 }
  if (!hub) warnings.push('no Hub/_hub.json: deadlines skipped')
  const rows = [], taken = new Set()
  // Tests first: they own their day's slot.
  for (const [courseKey, c] of Object.entries(courses)) {
    const code = codeOf(courseKey, c), color = nearestGoogleColor(c.color)
    for (const t of testsOf(courseKey, c, hub, today, yearEnd)) {
      const slot = slotOn(c, t.date)
      if (slot) taken.add(`${courseKey}|${t.date}|${slot.kind}`)
      const base = { tag: tagOf(code, t.date, 'test'), kind: 'test', course: code, courseKey, date: t.date, allDay: !slot,
        start: slot ? stampFor(t.date, slot.start) : t.date, end: slot ? stampFor(t.date, slot.end) : addDays(t.date, 1),
        summary: `${code} · ${t.title}`, location: slot?.where || '', color, reminders: REMINDERS.test }
      rows.push(finish(base, [`${code} · ${c.name || courseKey} · ${t.title}`, t.coverage ? `Covers: ${t.coverage}${t.assumed ? ' (assumed)' : ''}` : null,
        [c.professor, slot?.where].filter(Boolean).join(' · ') || null, weekLine(courseKey, c, t.date), `Quercus: ${t.url || c.url || ''}`.trim()]))
      counts.tests++
    }
  }
  // Meetings on every class day in the horizon, through the one expansion (src/calendar.js).
  const kinds = new Set(lectures ? ['Tutorial', 'Lecture'] : ['Tutorial'])
  for (const m of expandMeetings(today, addDays(today, horizon), syllabus ? { courses, syllabus } : { courses })) {
    if (m.cancelled || !kinds.has(m.kind) || taken.has(`${m.courseKey}|${m.date}|${m.kind}`)) continue
    const c = courses[m.courseKey], code = codeOf(m.courseKey, c), kind = m.kind.toLowerCase()
    const base = { tag: tagOf(code, m.date, kind), kind, course: code, courseKey: m.courseKey, date: m.date, allDay: false,
      start: stampFor(m.date, m.start), end: stampFor(m.date, m.end), summary: `${code} · ${m.kind}`, location: m.where || '', color: nearestGoogleColor(c?.color), reminders: null }
    rows.push(finish(base, [`${code} · ${c?.name || m.courseKey} · ${m.kind}`, [c?.professor, m.where].filter(Boolean).join(' · ') || null,
      m.topic?.text ? `Topic: ${m.topic.text} (${m.topic.source})` : null, m.week ? `${m.week.label} · slate: ${m.courseKey}/${m.week.dir}.md` : null, c?.url ? `Quercus: ${c.url}` : null]))
    counts[kind === 'lecture' ? 'lectures' : 'tutorials']++; counts.meetings++
  }
  // Deadlines: unsubmitted Quercus (and confirmed WebAssign) rows with a real due time. problems.mjs stamps an
  // unconfirmed WebAssign row's `due` at 23:59 of its assumed day while marking it `confirmed: false, dueTime: null`;
  // the stamp alone is not a time, so those rows are skipped until confirmed (SPEC §20.2: the calendar leaves them alone).
  const noTime = []
  for (const d of hub?.deadlines || []) {
    if (d.submitted) continue
    const due = String(d.due || '')
    const unconfirmed = d.confirmed === false || (d.source === 'syllabus' && d.dueTime == null)
    if (unconfirmed || !/T\d{2}:\d{2}/.test(due) || Number.isNaN(Date.parse(due))) { noTime.push(d.title || '?'); counts.skippedDeadlines++; continue }
    const endD = new Date(due), end = stampOf(endD), date = torontoParts(endD).date
    if (date < today || date > yearEnd) continue
    const c = courses[d.courseKey] || null, code = c ? codeOf(d.courseKey, c) : String(d.course || 'XXX000').replace(/\s+/g, '').slice(0, 6)
    const idm = /\/assignments\/(\d+)/.exec(String(d.url || '')), id = idm ? idm[1] : slug(d.title)
    const base = { tag: tagOf(code, date, 'due', id), kind: 'due', course: code, courseKey: d.courseKey || null, date, allDay: false,
      start: stampOf(new Date(endD.getTime() - 30 * 60000)), end, summary: `${code} · ${d.title} · due`, location: '', color: nearestGoogleColor(c?.color), reminders: REMINDERS.due }
    rows.push(finish(base, [`${code} · ${c?.name || d.course || ''} · assignment`.replace(' ·  ·', ' ·'), `Due ${torontoParts(endD).time.slice(0, 5)}${d.points ? ` · ${d.points} pts` : ''} · ${d.source === 'syllabus' ? 'syllabus' : 'Quercus'}`,
      weekLine(d.courseKey, c, date), d.url ? `Link: ${d.url}` : null]))
    counts.deadlines++
  }
  if (noTime.length) warnings.push(`${noTime.length} deadline${noTime.length > 1 ? 's' : ''} without a due time skipped (unconfirmed): ${noTime.slice(0, 5).join(', ')}`)
  rows.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.tag.localeCompare(b.tag))
  return { desired: rows, counts, warnings }
}

// ---- the diff ----------------------------------------------------------------------------------
// The remote row's summary must name the tag's course code; a delete additionally needs the start date to
// match the tag's date (SPEC §20.8: delete only when tag, summary and start agree). A mismatch is `foreign`.
const summaryMatches = (row, p) => String(row.summary || '').includes(p.code)
const matchesTag = (row, p) => summaryMatches(row, p) && dateOfStart(row.start) === p.date
const byStart = (a, b) => String(a.start || '').localeCompare(String(b.start || '')) || String(a.tag).localeCompare(String(b.tag))
// remote = [{ id, summary, start, tagLine }] as the Claude pass listed them; state = Hub/_calendar-state.json.
// → { create, update, delete, unchanged, skipped, foreign, capped }.
//   remote tag present, same hash → unchanged; other hash → update; absent and unknown to state → create; absent but
//   state knows it → the student deleted it: skipped 'gone'; remote tag not desired → delete; two remote rows with one tag →
//   keep the first, delete the rest as 'duplicate'; no tag line → foreign; rows dated outside [from, to] are ignored
//   as skipped 'past' / 'outside window' (never deleted). Cap: deletes first, then creates and updates by start.
export function diff({ desired, remote, state, maxWrites = DEFAULT_MAX_WRITES, from = null, to = null }) {
  const tags = state?.tags || {}, want = new Map((desired || []).map(r => [r.tag, r]))
  const create = [], update = [], del = [], skipped = [], foreign = [], unchanged = [], seen = new Map()
  for (const r of remote || []) {
    if (!r || !r.id) continue
    const p = parseTagLine(r.tagLine)
    if (!p) { foreign.push({ eventId: r.id, summary: r.summary || '', start: r.start || null, reason: 'no tag' }); continue }
    if (from && p.date < from) { skipped.push({ tag: p.tag, eventId: r.id, reason: 'past' }); continue }
    if (to && p.date > to) { skipped.push({ tag: p.tag, eventId: r.id, reason: 'outside window' }); continue }
    if (seen.has(p.tag)) {
      if (matchesTag(r, p)) del.push({ eventId: r.id, tag: p.tag, summary: r.summary || '', start: r.start || null, reason: 'duplicate' })
      else foreign.push({ eventId: r.id, tag: p.tag, summary: r.summary || '', start: r.start || null, reason: 'duplicate whose summary or start does not match its tag' })
      continue
    }
    seen.set(p.tag, { row: r, p })
  }
  for (const [tag, { row, p }] of seen) {
    const d = want.get(tag)
    if (!d) {
      if (matchesTag(row, p)) del.push({ eventId: row.id, tag, summary: row.summary || '', start: row.start || null, reason: 'not desired' })
      else foreign.push({ eventId: row.id, tag, summary: row.summary || '', start: row.start || null, reason: 'summary or start does not match its tag' })
      continue
    }
    if (p.hash === d.hash) { unchanged.push({ tag, hash: d.hash, eventId: row.id }); continue }
    if (summaryMatches(row, p)) update.push({ eventId: row.id, ...d })
    else foreign.push({ eventId: row.id, tag, summary: row.summary || '', start: row.start || null, reason: 'summary does not match its tag' })
  }
  for (const d of desired || []) {
    if (seen.has(d.tag)) continue
    if (tags[d.tag]) skipped.push({ tag: d.tag, reason: 'gone' })
    else create.push(d)
  }
  create.sort(byStart); update.sort(byStart); del.sort(byStart)
  let budget = Math.max(0, Number(maxWrites) || 0), capped = false
  const take = list => { const keep = list.slice(0, budget); budget -= keep.length; for (const r of list.slice(keep.length)) { capped = true; skipped.push({ tag: r.tag, reason: 'capped' }) } return keep }
  const delK = take(del), createK = take(create), updateK = take(update)
  return { create: createK, update: updateK, delete: delK, unchanged, skipped, foreign, capped }
}

// ---- the state --------------------------------------------------------------------------------
// The next state after a batch landed: `ops` names the batches applied (a run commits after each: delete, create,
// update), `failed` the tags whose call failed. Records every create/update, drops deleted tags, marks 'gone',
// re-learns unchanged remote tags, prunes tags dated more than 7 days ago, and writes `sync`. Counts and failures
// from earlier batches of the same run (same diff.at) are kept.
export function commit({ state, diff: d, failed = [], ops = ['delete', 'create', 'update'], today, at }) {
  const runId = d.runId ?? d.at ?? null   // one run = one --diff; its batches share the id (a stamp alone is not unique enough)
  const prev = runId && state?.sync?.runId === runId ? state.sync : null
  const s = { version: 1, calendarId: d.calendarId || state?.calendarId || null, tags: { ...(state?.tags || {}) }, sync: null }
  const failedSet = new Set([...failed, ...(prev?.failed || []).map(f => f.tag)]), fails = [...(prev?.failed || [])].filter(f => !ops.includes(f.op))
  const counts = { created: prev?.created || 0, updated: prev?.updated || 0, deleted: prev?.deleted || 0 }
  if (ops.includes('delete')) { let n = 0; for (const r of d.delete || []) { if (failedSet.has(r.tag)) { fails.push({ tag: r.tag, op: 'delete', error: 'call failed' }); continue } if (r.reason !== 'duplicate') delete s.tags[r.tag]; n++ } counts.deleted = n }
  if (ops.includes('create')) { let n = 0; for (const r of d.create || []) { if (failedSet.has(r.tag)) { fails.push({ tag: r.tag, op: 'create', error: 'call failed' }); continue } s.tags[r.tag] = { hash: r.hash, at }; n++ } counts.created = n }
  if (ops.includes('update')) { let n = 0; for (const r of d.update || []) { if (failedSet.has(r.tag)) { fails.push({ tag: r.tag, op: 'update', error: 'call failed' }); continue } s.tags[r.tag] = { hash: r.hash, at }; n++ } counts.updated = n }
  for (const u of d.unchanged || []) s.tags[u.tag] = { hash: u.hash, at: s.tags[u.tag]?.at || at }
  for (const k of d.skipped || []) if (k.reason === 'gone' && s.tags[k.tag]) s.tags[k.tag] = { ...s.tags[k.tag], gone: true }
  const cutoff = addDays(today, -7)
  for (const tag of Object.keys(s.tags)) { const p = parseTag(tag); if (!p || p.date < cutoff) delete s.tags[tag] }
  const uniq = [...new Map(fails.map(f => [f.tag + '|' + f.op, f])).values()]
  s.sync = { at, runId, diffAt: d.at || null, ok: uniq.length === 0, ...counts, skipped: (d.skipped || []).filter(k => k.reason === 'gone' || k.reason === 'capped').length, capped: !!d.capped,
    failed: uniq, note: null, ops: [...new Set([...(prev?.ops || []), ...ops])] }
  return s
}
export function failState(state, reason, at) {
  return { version: 1, calendarId: state?.calendarId || null, tags: { ...(state?.tags || {}) }, sync: { at, runId: null, diffAt: null, ok: false, created: 0, updated: 0, deleted: 0, skipped: 0, capped: false, failed: [], note: String(reason || 'failed'), ops: [] } }
}
export const trackedCount = state => Object.values(state?.tags || {}).filter(t => t && !t.gone).length

// ---- the readback ------------------------------------------------------------------------------
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const isStamp = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s || '')) && !Number.isNaN(Date.parse(s))
// Problems with Hub/_calendar.json as the Claude pass wrote it; [] when it is well-formed.
export function validateCalendar(cal) {
  const out = []
  if (!cal || typeof cal !== 'object' || Array.isArray(cal)) return ['not a JSON object']
  if (cal.version !== 1) out.push('version must be 1')
  if (!isStamp(cal.updatedAt)) out.push('updatedAt must be an ISO time')
  if (!isDate(cal.from) || !isDate(cal.to)) out.push('from and to must be YYYY-MM-DD')
  if (!Array.isArray(cal.calendars) || !cal.calendars.length) out.push('calendars must be a non-empty array')
  const names = new Set()
  for (const [i, c] of (Array.isArray(cal.calendars) ? cal.calendars : []).entries()) {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name) out.push(`calendars[${i}] needs id and name`)
    else names.add(c.name)
    if (c && typeof c.slate !== 'boolean') out.push(`calendars[${i}] (${c?.name || '?'}) needs slate: true|false`)
  }
  if (!Array.isArray(cal.events)) { out.push('events must be an array'); return out }
  for (const [i, e] of cal.events.entries()) {
    const who = `events[${i}]${e?.id ? ` (${e.id})` : ''}`
    if (!e || typeof e !== 'object') { out.push(`${who}: not an object`); continue }
    if (typeof e.id !== 'string' || !e.id) out.push(`${who}: id missing`)
    if (typeof e.title !== 'string') out.push(`${who}: title must be a string`)
    if (typeof e.calendar !== 'string' || !names.has(e.calendar)) out.push(`${who}: calendar "${e.calendar}" is not one of the listed calendar names`)
    if (typeof e.allDay !== 'boolean') out.push(`${who}: allDay must be true or false`)
    if (e.allDay) { if (!isDate(e.start) || !isDate(e.end)) out.push(`${who}: all-day start and end must be YYYY-MM-DD`) }
    else if (!isStamp(e.start) || !isStamp(e.end)) out.push(`${who}: start and end must be ISO times`)
    if (e.location != null && typeof e.location !== 'string') out.push(`${who}: location must be a string`)
    if (e.slate !== null && e.slate !== undefined) {
      const p = e.slate && typeof e.slate === 'object' ? parseTag(e.slate.tag) : null
      if (!p) out.push(`${who}: slate.tag is not a slate tag (slate must be null for other events)`)
      else if (e.slate.course !== p.code || e.slate.kind !== p.kind) out.push(`${who}: slate.course/kind must be the tag's 2nd and 4th segments (${p.code}, ${p.kind})`)
    }
  }
  return out
}
export const syncLine = (sync, tracked) => {
  if (!sync) return 'Not synced yet.'
  const when = sync.at ? `${shortDay(dateOfStart(sync.at))} ${hhmmOf(sync.at) || ''}`.trim() : ''
  if (!sync.ok) return `Last sync failed${when ? ' ' + when : ''}: ${sync.note || (sync.failed || []).map(f => `${f.op} ${f.tag}`).join(', ') || 'unknown error'}.`
  const bits = [`Synced ${when}`]
  if (sync.created) bits.push(`${sync.created} added`); if (sync.updated) bits.push(`${sync.updated} updated`); if (sync.deleted) bits.push(`${sync.deleted} removed`)
  if (sync.skipped) bits.push(`${sync.skipped} skipped`); if (sync.capped) bits.push('more tomorrow')
  bits.push(`${tracked} tracked on Google Calendar`)
  return bits.join(' · ') + '.'
}
// Hub/Today/Calendar.md from the readback and the state: a Day | Time | What | Where | Calendar table.
export function renderCalendarPage(cal, state, now = new Date()) {
  const events = [...(cal.events || [])].sort((a, b) => dateOfStart(a.start).localeCompare(dateOfStart(b.start)) || (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1))
  const rows = [], mine = events.filter(e => !e.slate).length
  let lastDay = null
  for (const e of events) {
    const day = dateOfStart(e.start), time = e.allDay ? 'all day' : `${hhmmOf(e.start) || ''}–${hhmmOf(e.end) || ''}`
    rows.push(`| ${day === lastDay ? '' : shortDay(day)} | ${time} | ${String(e.title || '').replace(/\|/g, '/')} | ${String(e.location || '').replace(/\|/g, '/')} | ${e.slate ? e.slate.course : e.calendar} |`)
    lastDay = day
  }
  const at = cal.updatedAt ? `${shortDay(dateOfStart(cal.updatedAt))} ${hhmmOf(cal.updatedAt) || ''}`.trim() : shortDay(torontoToday(now))
  return `---
kind: "summary"
---
# Calendar · next 7 days

_From Google Calendar at ${at}, ${cal.from} to ${cal.to}. slate's own events show their course code in the Calendar column; everything else is yours. Rewritten every morning. Read, do not edit._

| Day | Time | What | Where | Calendar |
|---|---|---|---|---|
${rows.length ? rows.join('\n') : '| — | | Nothing in the next 7 days | | |'}

${mine} of ${events.length} event${events.length === 1 ? '' : 's'} ${mine === 1 ? 'is' : 'are'} yours.

## Sync

${syncLine(state?.sync || null, trackedCount(state))}
`
}

// ---- selftest ----------------------------------------------------------------------------------
// Fixtures for --selftest: the diff rules and the desired set on a frozen day. Each returns null or a message.
export function selftest() {
  const today = '2026-09-10', results = []
  const check = (name, fn) => { let r; try { r = fn() } catch (e) { r = `threw ${e.message}` } results.push({ name, ok: r == null, detail: r || '' }) }
  const hub = { tests: [{ course: 'ECO208', courseKey: 'ECO 208Y1', title: 'Term Test 1', date: '2026-10-15', note: 'from Quercus', url: 'https://q.utoronto.ca/courses/100002/assignments/1' }],
    deadlines: [{ course: 'ECO208', courseKey: 'ECO 208Y1', title: 'Assignment 1', due: '2026-12-12T04:59:59Z', points: 10, url: 'https://q.utoronto.ca/courses/100002/assignments/99', source: 'quercus', submitted: false },
      // The two WebAssign shapes problems.mjs emits: unconfirmed (a 23:59 stamp, but dueTime null and confirmed false) and confirmed.
      { course: 'ECO227', courseKey: 'ECO 227Y1', set: 'Fall-Ex1', title: 'WebAssign Fall-Ex1 · week of Sep 14 · date unconfirmed', due: '2026-09-25T23:59:00-04:00', dueDate: '2026-09-25', dueTime: null, confirmed: false, url: 'https://www.webassign.net/', source: 'syllabus', submitted: false },
      { course: 'ECO227', courseKey: 'ECO 227Y1', set: 'Fall-Ex2', title: 'WebAssign Fall-Ex2', due: '2026-10-02T23:59:00-04:00', dueDate: '2026-10-02', dueTime: '23:59', confirmed: true, url: 'https://www.webassign.net/', source: 'syllabus', submitted: false },
      { course: 'ECO208', courseKey: 'ECO 208Y1', title: 'Old', due: '2026-09-01T03:59:00Z', url: 'https://q.utoronto.ca/courses/100002/assignments/5', source: 'quercus', submitted: false }] }
  const plan = desiredEvents({ hub, today })
  const d = plan.desired
  check('tags unique', () => new Set(d.map(r => r.tag)).size === d.length ? null : 'duplicate tags')
  check('description ends with tag#hash', () => d.every(r => r.description.endsWith(`${r.tag}#${r.hash}`) && parseTagLine(tagLineOf(r.description))?.hash === r.hash) ? null : 'bad tag line')
  check('hash is stable', () => d.every(r => hashEvent(r) === r.hash) ? null : 'hash of a finished row differs')
  check('no lecture by default', () => d.some(r => r.kind === 'lecture') ? 'a lecture slipped in' : null)
  check('lectures behind the switch', () => desiredEvents({ hub, today, lectures: true }).desired.some(r => r.kind === 'lecture') ? null : 'no lecture with lectures:true')
  check('no meeting on Thanksgiving or a weekend', () => d.some(r => r.kind !== 'due' && r.kind !== 'test' && (r.date === '2026-10-12' || ['Sat', 'Sun'].includes(weekdayOf(r.date)))) ? 'meeting on a closed day' : null)
  // Term Test 1 was set for Thu Oct 15, 1–3 pm in SS 2118 (announcement of 2026-09-25): the Thursday lecture's slot, so the
  // Tuesday tutorial that week stays.
  check('ECO208 Term Test 1 takes the lecture slot', () => { const t = d.find(r => r.tag === 'slate:ECO208:2026-10-15:test'); return t && t.summary === 'ECO208 · Term Test 1' && t.start === '2026-10-15T13:00:00-04:00' && t.end === '2026-10-15T15:00:00-04:00' && !t.allDay && t.location === 'SS 2118' && d.some(r => r.tag === 'slate:ECO208:2026-10-13:tutorial') ? null : JSON.stringify(t) })
  check('Quercus url reaches the test description', () => d.find(r => r.tag === 'slate:ECO208:2026-10-15:test')?.description.includes('assignments/1') ? null : 'url missing')
  check('ECO227 Test 2 is all-day (no meeting on a Tuesday)', () => { const t = d.find(r => r.tag === 'slate:ECO227:2026-12-08:test'); return t && t.allDay && t.start === '2026-12-08' && t.end === '2026-12-09' ? null : JSON.stringify(t) })
  // One per course per date from the syllabus (COURSES[k].tests and dated grading items), so a course added in term counts too.
  const syllabusTests = Object.values(COURSES).reduce((n, c) => n + new Set([...(c.tests || []).map(([date]) => date), ...(c.grading?.components || []).filter(x => x.key === 'tests').flatMap(x => x.items || []).map(i => i.date)]
    .filter(date => date && date >= today && date <= YEAR_END)).size, 0)
  check(`${syllabusTests} tests through April`, () => plan.counts.tests === syllabusTests ? null : `tests: ${plan.counts.tests}, syllabus: ${syllabusTests}`)
  check('DST offsets', () => d.find(r => r.tag === 'slate:ECO208:2026-12-01:test')?.start.endsWith('-05:00') && d.find(r => r.tag === 'slate:ECO208:2026-10-15:test')?.start.endsWith('-04:00') ? null : 'offset wrong')
  check('colours', () => { const c = k => d.find(r => r.course === k)?.color?.name; return c('ECO206') === 'Blueberry' && c('ECO208') === 'Basil' && c('ECO227') === 'Tangerine' ? null : [c('ECO206'), c('ECO208'), c('ECO227')].join(',') })
  check('deadline: 30 minutes ending at due, Toronto, id from the url', () => { const r = d.find(x => x.tag === 'slate:ECO208:2026-12-11:due:99'); return r && r.start === '2026-12-11T23:29:59-05:00' && r.end === '2026-12-11T23:59:59-05:00' && r.summary === 'ECO208 · Assignment 1 · due' && r.reminders?.[1].minutes === 120 ? null : JSON.stringify(r) })
  check('unconfirmed WebAssign row (stamped, dueTime null) and a past deadline are skipped', () => plan.counts.deadlines === 2 && plan.counts.skippedDeadlines === 1 && plan.warnings.some(w => /without a due time/.test(w) && /Fall-Ex1/.test(w)) && !d.some(r => r.kind === 'due' && r.date === '2026-09-25') ? null : JSON.stringify({ counts: plan.counts, warnings: plan.warnings, due: d.filter(r => r.kind === 'due').map(r => r.tag) }))
  check('confirmed WebAssign row is a deadline with a slug id', () => { const r = d.find(x => x.tag === 'slate:ECO227:2026-10-02:due:webassign-fall-ex2'); return r && r.start === '2026-10-02T23:29:00-04:00' && r.end === '2026-10-02T23:59:00-04:00' && r.summary === 'ECO227 · WebAssign Fall-Ex2 · due' && r.description.includes('· syllabus') && r.color?.name === 'Tangerine' ? null : JSON.stringify(r) })
  check('a grading item dated outside COURSES[k].tests still becomes a test', () => {
    const courses = { 'ZZZ 999Y1': { code: 'ZZZ999', name: 'Fixture', term: 'Y', color: '#616161', meetings: [], tests: [], grading: { components: [{ key: 'tests', items: [{ key: 't1', label: 'Test 1 · in class', date: '2026-11-02', coverage: 'Weeks 1–8' }] }] } } }
    const p = desiredEvents({ courses, hub: null, today }), t = p.desired.find(r => r.tag === 'slate:ZZZ999:2026-11-02:test')
    return p.counts.tests === 1 && t && t.allDay && t.summary === 'ZZZ999 · Test 1' && t.description.includes('Covers: Weeks 1–8') ? null : JSON.stringify({ counts: p.counts, t })
  })
  check('no hub → warning, no deadlines', () => { const p = desiredEvents({ hub: null, today }); return p.counts.deadlines === 0 && p.warnings.some(w => /_hub\.json/.test(w)) ? null : JSON.stringify(p.warnings) })
  check('sorted by start', () => d.every((r, i) => i === 0 || String(d[i - 1].start) <= String(r.start)) ? null : 'unsorted')
  check('stampFor', () => stampFor('2026-11-05', '13:00') === '2026-11-05T13:00:00-05:00' && stampFor('2026-10-15', '13:00') === '2026-10-15T13:00:00-04:00' ? null : stampFor('2026-11-05', '13:00'))
  // diff fixtures
  const a = d[0], b = d[1], c3 = d[2], line = r => `${r.tag}#${r.hash}`
  const remote = [
    { id: 'e1', summary: a.summary, start: a.start, tagLine: line(a) },                                   // same hash → unchanged
    { id: 'e2', summary: b.summary, start: b.start, tagLine: `${b.tag}#00000000` },                       // other hash → update
    { id: 'e3', summary: 'ECO208 · Tutorial', start: '2026-09-01T15:00:00-04:00', tagLine: 'slate:ECO208:2026-09-01:tutorial#deadbeef' },   // before window → ignored
    { id: 'e4', summary: 'Dentist', start: '2026-09-12T14:00:00-04:00', tagLine: null },                  // foreign
    { id: 'e5', summary: 'ECO227 · Tutorial', start: '2026-09-22T15:00:00-04:00', tagLine: 'slate:ECO227:2026-09-22:tutorial#12345678' },   // not desired, matches → delete
    { id: 'e6', summary: a.summary, start: a.start, tagLine: line(a) },                                   // duplicate → delete
    { id: 'e7', summary: 'Lunch with Marie', start: '2026-09-23T12:00:00-04:00', tagLine: 'slate:ECO208:2026-09-23:tutorial#abcdef01' },   // tagged but summary/start mismatch → foreign
  ]
  const state = { version: 1, tags: { [c3.tag]: { hash: c3.hash, at: '2026-09-09T07:10:00-04:00' } } }
  const r1 = diff({ desired: d, remote, state, maxWrites: 999, from: today, to: YEAR_END })
  check('diff: unchanged / update / delete / duplicate / foreign / gone / past', () => {
    const okU = r1.unchanged.length === 1 && r1.unchanged[0].eventId === 'e1'
    const okUp = r1.update.length === 1 && r1.update[0].eventId === 'e2' && r1.update[0].tag === b.tag
    const okD = r1.delete.length === 2 && r1.delete.some(x => x.eventId === 'e5' && x.reason === 'not desired') && r1.delete.some(x => x.eventId === 'e6' && x.reason === 'duplicate')
    const okF = r1.foreign.length === 2 && r1.foreign.some(x => x.eventId === 'e4' && x.reason === 'no tag') && r1.foreign.some(x => x.eventId === 'e7')
    const okG = r1.skipped.some(x => x.tag === c3.tag && x.reason === 'gone') && !r1.create.some(x => x.tag === c3.tag)
    const okP = r1.skipped.some(x => x.eventId === 'e3' && x.reason === 'past') && !r1.delete.some(x => x.eventId === 'e3')
    const okC = r1.create.length === d.length - 3
    return okU && okUp && okD && okF && okG && okP && okC ? null : JSON.stringify({ okU, okUp, okD, okF, okG, okP, okC, create: r1.create.length, want: d.length - 3 })
  })
  check('diff: cap of 3 → deletes first, then earliest starts, capped', () => {
    const r = diff({ desired: d, remote, state, maxWrites: 3, from: today, to: YEAR_END })
    const firstCreate = r1.create[0]
    return r.capped && r.delete.length === 2 && r.create.length === 1 && r.create[0].tag === firstCreate.tag && r.update.length === 0 && r.skipped.some(x => x.reason === 'capped' && x.tag === b.tag) ? null : JSON.stringify({ capped: r.capped, del: r.delete.length, create: r.create.length, update: r.update.length })
  })
  check('commit: records, drops, marks gone, keeps failures, retries a failed create', () => {
    const failedTag = r1.create[0].tag
    const s1 = commit({ state, diff: { ...r1, at: 'T1', calendarId: 'cal' }, failed: [failedTag], today, at: '2026-09-10T07:12:00-04:00' })
    const okRec = !s1.tags[failedTag] && s1.tags[r1.create[1].tag]?.hash === r1.create[1].hash && s1.tags[b.tag]?.hash === b.hash && s1.tags[a.tag]?.hash === a.hash
    const okGone = s1.tags[c3.tag]?.gone === true && !s1.tags['slate:ECO227:2026-09-22:tutorial']
    const okSync = s1.sync.ok === false && s1.sync.failed.some(f => f.tag === failedTag && f.op === 'create') && s1.sync.created === r1.create.length - 1 && s1.sync.deleted === 2 && s1.sync.updated === 1
    const r2 = diff({ desired: d, remote: [...remote, { id: 'e8', summary: r1.create[1].summary, start: r1.create[1].start, tagLine: line(r1.create[1]) }], state: s1, maxWrites: 999, from: today, to: YEAR_END })
    const okRetry = r2.create.some(x => x.tag === failedTag) && !r2.create.some(x => x.tag === r1.create[2]?.tag) && r2.skipped.some(x => x.tag === r1.create[2]?.tag && x.reason === 'gone')
    return okRec && okGone && okSync && okRetry ? null : JSON.stringify({ okRec, okGone, okSync, okRetry })
  })
  check('commit: batches of one run accumulate; a new run resets', () => {
    const dd = { ...r1, at: 'T2', calendarId: 'cal' }
    const s1 = commit({ state, diff: dd, ops: ['delete'], today, at: 'a' })
    const s2 = commit({ state: s1, diff: dd, ops: ['create'], failed: [r1.create[0].tag], today, at: 'b' })
    const s3 = commit({ state: s2, diff: dd, today, at: 'c' })
    const s4 = commit({ state: s3, diff: { ...dd, at: 'T3', create: [], update: [], delete: [] }, today, at: 'd' })
    return s1.sync.deleted === 2 && s1.sync.created === 0 && s2.sync.deleted === 2 && s2.sync.created === r1.create.length - 1 && s3.sync.updated === 1 && s3.sync.ok === false && s3.sync.failed.length === 1 && s4.sync.ok === true && s4.sync.created === 0 ? null : JSON.stringify([s1.sync, s2.sync, s3.sync, s4.sync])
  })
  check('commit: prunes tags older than 7 days', () => { const s = commit({ state: { tags: { 'slate:ECO208:2026-09-01:tutorial': { hash: 'x', at: 'y' } } }, diff: { at: 'T', create: [], update: [], delete: [], unchanged: [], skipped: [] }, today, at: 'z' }); return Object.keys(s.tags).length === 0 ? null : 'not pruned' })
  check('failState', () => { const s = failState(state, 'no calendar named slate', 'now'); return s.sync.ok === false && s.sync.note === 'no calendar named slate' && Object.keys(s.tags).length === 1 ? null : JSON.stringify(s.sync) })
  const cal = { version: 1, updatedAt: '2026-09-10T07:12:03-04:00', timeZone: TZ, from: '2026-09-10', to: '2026-09-17',
    calendars: [{ id: 'primary', name: 'the student', slate: true }, { id: 'x@group.calendar.google.com', name: 'Family', slate: false }],
    events: [{ id: 'g1', calendar: 'the student', title: 'ECO208 · Tutorial', start: '2026-09-15T15:00:00-04:00', end: '2026-09-15T17:00:00-04:00', allDay: false, location: 'KP 108', slate: { tag: 'slate:ECO208:2026-09-15:tutorial', course: 'ECO208', kind: 'tutorial' } },
      { id: 'g2', calendar: 'Family', title: 'Birthday dinner', start: '2026-09-12', end: '2026-09-13', allDay: true, location: '', slate: null },
      { id: 'g3', calendar: 'the student', title: 'Dentist', start: '2026-09-11T14:00:00-04:00', end: '2026-09-11T14:30:00-04:00', allDay: false, location: 'Bloor St', slate: null }] }
  check('validateCalendar accepts a good file', () => { const p = validateCalendar(cal); return p.length ? p.join('; ') : null })
  check('validateCalendar names the bad event', () => { const p = validateCalendar({ ...cal, events: [{ ...cal.events[2], start: 'tomorrow' }] }); return p.some(x => x.includes('(g3)')) ? null : p.join('; ') })
  check('renderCalendarPage', () => { const md = renderCalendarPage(cal, { tags: { a: { hash: 'h', at: 't' } }, sync: { at: '2026-09-10T07:12:00-04:00', ok: true, created: 3, updated: 0, deleted: 1, skipped: 0, capped: false, failed: [] } }, new Date('2026-09-10T12:00:00Z'))
    return md.includes('| Day | Time | What | Where | Calendar |') && md.includes('| all day | Birthday dinner |') && md.includes('| ECO208 · Tutorial | KP 108 | ECO208 |') && md.includes('14:00–14:30') && md.includes('Synced Thu Sep 10 07:12 · 3 added · 1 removed · 1 tracked') && md.startsWith('---\nkind: "summary"\n---\n# Calendar · next 7 days') ? null : md })
  return { ok: results.every(r => r.ok), results }
}

// Date helpers the CLI needs, from the one calendar model.
export { addDays, weekdayOf }
