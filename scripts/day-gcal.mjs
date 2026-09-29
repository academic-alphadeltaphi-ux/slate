#!/usr/bin/env node
// The day to Google Calendar (SPEC §23): the confirmed blocks of one day, as events on the primary calendar, each tagged
// on the last line of its description `slate:day:<date>:<block id>#<hash>`, so sending again updates what changed,
// deletes what he took off, and never touches an event that is not one of these. Connector-free: node decides, the
// calendar agent (scripts/day-gcal-prompt.md) makes the calls, the way scripts/calendar-events.mjs works for the classes.
//
//   node scripts/day-gcal.mjs --plan --date D           what should be on the calendar for D, as JSON
//   echo '[{"id":"…","tagLine":"slate:day:…"}]' | node scripts/day-gcal.mjs --diff --date D   → { create, update, delete }
//   node scripts/day-gcal.mjs --done --date D --created N --updated N --deleted N [--failed "why"]
//   node scripts/day-gcal.mjs --fail "why" --date D
import crypto from 'node:crypto'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { todayIso, localStamp } from './lib/terms.mjs'
import { addDays } from '../src/calendar.js'
import * as D from './lib/day.mjs'

const USAGE = 'usage: node scripts/day-gcal.mjs (--plan | --diff | --done | --fail "why") --date YYYY-MM-DD [--created N --updated N --deleted N] [--failed "why"] [--root p]'
guardFlags(['--root', '--date', '--plan', '--diff', '--done', '--fail', '--created', '--updated', '--deleted', '--failed'], USAGE)
const args = process.argv.slice(2)
const has = f => args.includes(f)
const val = f => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] ?? null) : null }
const ROOT = notesRoot(args)
const date = val('--date') || todayIso()
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(USAGE); process.exit(2) }
const TZ = 'America/Toronto'

// The Toronto offset on a date (EDT −04:00, EST −05:00), and a block's minutes as an ISO time with it; 25:30 is the next day.
const offsetOn = d => { const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(d + 'T12:00:00Z')).find(p => p.type === 'timeZoneName')?.value || 'GMT-04:00'; const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(s); return m ? `${m[1]}:${m[2] || '00'}` : '-04:00' }
const iso = min => { const d = addDays(date, Math.floor(min / 1440)), m = ((min % 1440) + 1440) % 1440; return `${d}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00${offsetOn(d)}` }
const hash = o => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 8)

async function desired() {
  const g = await D.gatherDay(ROOT, { date })
  const v = D.viewDay(g)
  return v.blocks.filter(b => b.state === 'confirmed').map(b => {
    const ev = { summary: b.course ? `${b.course} · ${b.title}` : b.title, start: iso(b.start), end: iso(b.end) }
    const tag = `slate:day:${date}:${b.id}`
    return { tag, ...ev, description: `Planned in Slate.${b.why ? `\n${b.why}` : ''}\n\n${tag}#${hash(ev)}`, hash: hash(ev) }
  })
}
const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s }

if (has('--plan')) {
  const events = await desired()
  console.log(JSON.stringify({ calendarId: 'primary', timeZone: TZ, date, window: { from: `${date}T00:00:00${offsetOn(date)}`, to: `${addDays(date, 1)}T04:00:00${offsetOn(addDays(date, 1))}` }, events: events.map(({ hash: _, ...e }) => e) }, null, 2))
} else if (has('--diff')) {
  let remote
  try { remote = JSON.parse(await readStdin()) } catch { console.error('--diff reads a JSON array on stdin: [{ "id": "<event id>", "tagLine": "<last line of its description>" }]'); process.exit(2) }
  if (!Array.isArray(remote)) { console.error('--diff: an array'); process.exit(2) }
  const want = await desired()
  const mine = remote.filter(r => r && r.id && String(r.tagLine || '').startsWith(`slate:day:${date}:`))
  // Every event under a tag, not the last one seen: a send that failed half way (created, never recorded) left a second
  // event with the same tag, and a map of one per tag hid it for good (review 2026-09-29). One is kept — the one already
  // right, else the first — and the rest are deleted.
  const byTag = new Map()
  for (const r of mine) { const t = String(r.tagLine).split('#')[0]; if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(r) }
  const create = [], update = [], del = []
  for (const w of want) {
    const rs = byTag.get(w.tag) || []
    const r = rs.find(x => String(x.tagLine).split('#')[1] === w.hash) || rs[0]
    if (!r) create.push({ summary: w.summary, startTime: w.start, endTime: w.end, description: w.description })
    else if (String(r.tagLine).split('#')[1] !== w.hash) update.push({ eventId: r.id, summary: w.summary, startTime: w.start, endTime: w.end, description: w.description })
    for (const x of rs) if (x !== r) del.push({ eventId: x.id })
  }
  for (const [tag, rs] of byTag) if (!want.some(w => w.tag === tag)) for (const r of rs) del.push({ eventId: r.id })
  console.log(JSON.stringify({ calendarId: 'primary', timeZone: TZ, create, update, delete: del, untouched: remote.length - mine.length }, null, 2))
} else if (has('--done') || has('--fail')) {
  const n = f => Number(val(f)) || 0
  const failed = has('--fail') ? val('--fail') : val('--failed')
  const sent = { at: localStamp(), created: n('--created'), updated: n('--updated'), deleted: n('--deleted'), ...(failed ? { failed: String(failed).slice(0, 200) } : {}) }
  // read and written under the day's lock, so a confirm of his that lands meanwhile is not written over (serialDay)
  await D.serialDay(ROOT, async () => { const g = await D.gatherDay(ROOT, { date }); await D.writeDay(ROOT, { ...g.day, sent }, { g }) })
  console.log(JSON.stringify({ ok: !failed, sent }))
} else { console.error(USAGE); process.exit(2) }
