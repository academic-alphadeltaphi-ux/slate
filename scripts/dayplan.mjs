#!/usr/bin/env node
// Today's work from the command line (SPEC §23): the day as it stands, and the packer's arithmetic laid as a draft when
// asked. It decides nothing when Claude is the brain — the day agent drafts (scripts/day-agent.mjs), the student confirms on
// the screen. Hub/_day-prefs.json is created with the defaults the first time.
//
//   node scripts/dayplan.mjs [--date 2026-09-30]      the day: each block, draft or confirmed, with what the day holds
//   node scripts/dayplan.mjs --draft [--now 14:00]     the packer's draft in place of Claude's own (brain off, a test)
//   --workable <eventId> · --busy <eventId>   an event he can, or cannot, work through
//   --json   the day as JSON on the last line      --dry   write nothing      --root <path>   another notes root
import { todayIso } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { toMin } from '../src/dayplan.js'
import { THIS as ED } from '../src/edition.js'
import * as D from './lib/day.mjs'

const USAGE = 'usage: node scripts/dayplan.mjs [--root p] [--date YYYY-MM-DD] [--draft] [--now HH:MM] [--workable EVENTID]... [--busy EVENTID]... [--json] [--dry]'
guardFlags(['--root', '--date', '--draft', '--now', '--workable', '--busy', '--json', '--dry'], USAGE)
const args = process.argv.slice(2)
const has = f => args.includes(f)
const val = f => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] ?? null) : null }
const vals = f => args.flatMap((a, i) => (a === f && args[i + 1] != null ? [args[i + 1]] : []))
const JSON_OUT = has('--json'), DRY = has('--dry')
const fail = msg => { console.error(msg); console.error('nothing was written.'); process.exit(2) }
const log = s => { if (!JSON_OUT) console.log(s) }

// An edition without Today's work has no screen for this; a day nobody can see is a file nobody reads.
if (ED.work === false) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, skipped: 'this edition has no Today\'s work', edition: ED.key }))
  else console.log(`${ED.name} has no Today's work — nothing to do.`)
  process.exit(0)
}
const ROOT = notesRoot(process.argv)
const date = val('--date') || todayIso()
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date: YYYY-MM-DD')
const now = val('--now')
if (now != null && toMin(now) == null) fail('--now: HH:MM')

// the gather and the write under the day's lock (serialDay): an act of his between the two would otherwise be written over
const { g, day, changed } = await D.serialDay(ROOT, async () => {
  const g = await D.gatherDay(ROOT, { date, now, createPrefs: !DRY })
  let day = g.day, changed = false
  for (const id of vals('--workable')) { day = D.setWorkable(g, day, { id, on: true }).day; changed = true }
  for (const id of vals('--busy')) { day = D.setWorkable(g, day, { id, on: false }).day; changed = true }
  if (has('--draft')) { day = D.applyDraft({ ...g, day }, day, D.packerDraft({ ...g, day }, { from: now }), { by: 'packer' }); changed = true }
  if (changed && !DRY) day = await D.writeDay(ROOT, day, { g })
  return { g, day, changed }
})
const v = D.viewDay(g, day)
log(`${date} · ${D.statusLine(v)}${v.draft?.steer ? ` · ${v.draft.steer}` : ''}`)
for (const l of D.dayLines(v)) log(`  ${l}`)
log(`${changed && !DRY ? 'Hub/_day.json written' : 'nothing written'}${DRY ? ' (dry run)' : ''}${g.prefsCreated ? ' · Hub/_day-prefs.json created with the defaults' : ''}${g.brainOn ? ' · Claude drafts the day: node scripts/day-agent.mjs' : ''}.`)
if (JSON_OUT) console.log(JSON.stringify(v))
