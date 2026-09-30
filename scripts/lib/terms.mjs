// Rendered by scripts/courses.mjs from nothing yet (setup writes Hub/_courses.json) on 2026-09-30T06:38:43.991Z — edit the JSON and run `node scripts/courses.mjs write`, never this file.
// Rendered by scripts/courses.mjs from Hub/_courses.json — do not edit by hand; edit the JSON and run
// `node scripts/courses.mjs write`. The calendar, the courses and every helper below are what the app files things by:
// the term weeks (Week 1 is the week of the first Monday; reading weeks are skipped in the numbering), the courses with
// their Quercus ids, meeting times, tests and grading, and the date helpers every script shares (SPEC §21).
import { THIS } from '../../src/edition.js'

export const COURSES = {}

const FALL = { name: "Fall 2026", start: "2026-09-07", end: "2026-12-07", reading: ["2026-10-26"] }
const WINTER = { name: "Winter 2027", start: "2027-01-04", end: "2027-04-05", reading: ["2027-02-15"] }
export const NO_CLASS = ["2026-09-07", "2026-10-12", "2027-03-26"]
// The one calendar-facts export set (SPEC §20.1): the plan, the Google calendar, the course screen and the
// Sunday review all read these, so a day is a class in every screen or none.
export const TERMS = { FALL, WINTER }
export const READING = [...FALL.reading, ...WINTER.reading]   // the Monday of each reading week
// The subpages every week folder is scaffolded with. An edition that does not build study sheets never makes the
// folder either, so the file tree does not carry an empty one for ever (SPEC §20.41); a week that already has one
// keeps it — `sheets` stays a bucket the server recognises.
export const WEEK_PAGES = [['Notes', 'notes'], ['Lectures', 'lecture'], ['Recordings', 'notes'], ...(THIS.sheets ? [['Study sheets', 'summary']] : [])]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = iso => new Date(iso + 'T12:00:00')
export const short = d => `${MONTHS[d.getMonth()]} ${d.getDate()}`
export const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function weeks(term) {
  const out = []
  for (const t of term === 'Y' ? [FALL, WINTER] : term === 'S' ? [WINTER] : [FALL]) {
    for (let d = day(t.start); d <= day(t.end); d.setDate(d.getDate() + 7)) {
      const iso = isoOf(d)
      if (t.reading.includes(iso)) continue
      const n = out.length + 1, label = `Week ${n} (${short(d)})`, sun = new Date(d); sun.setDate(sun.getDate() + 6)
      out.push({ n, monday: iso, label, term: t.name, dir: `${t.name}/${label}`, span: `${short(d)} – ${short(sun)}` })
    }
  }
  return out
}
// The week a date belongs to (the last week whose Monday is on or before it), or null outside the term.
export function weekFor(term, dateLike) {
  const iso = typeof dateLike === 'string' ? dateLike.slice(0, 10) : isoOf(dateLike)
  let hit = null
  for (const w of weeks(term)) { if (w.monday <= iso) hit = w; else break }
  if (!hit) return null
  const end = day(hit.monday); end.setDate(end.getDate() + 13)   // a reading week still belongs to the week before it
  return iso <= isoOf(end) ? hit : null
}
// SLATE_TODAY pins the date for a suite whose fixtures live in one week (scripts/test-dayplan.mjs); unset, it is the clock.
export const todayIso = () => (/^\d{4}-\d{2}-\d{2}$/.test(process.env.SLATE_TODAY || "") ? process.env.SLATE_TODAY : isoOf(new Date()))
const addDaysIso = (iso, n) => { const d = day(iso); d.setDate(d.getDate() + n); return isoOf(d) }
const weekdayOf = iso => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day(iso).getDay()]
// Inside a reading week: the Monday through the Sunday after it.
export const inReadingWeek = iso => READING.some(m => m <= iso && iso <= addDaysIso(m, 6))
// Inside a term: from its first Monday to the Sunday of its last week (the break between terms is not).
export const inTerm = iso => [FALL, WINTER].some(t => t.start <= iso && iso <= addDaysIso(t.end, 6))
// A weekday inside a term that is neither a reading-week day nor a closure. Says nothing about which course meets.
export const isClassDay = iso => inTerm(iso) && !inReadingWeek(iso) && !NO_CLASS.includes(iso) && !['Sat', 'Sun'].includes(weekdayOf(iso))
// An ISO stamp in local time with the real offset, the way the app writes `created`.
export function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', pad = n => String(Math.abs(n)).padStart(2, '0')
  return `${isoOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}
