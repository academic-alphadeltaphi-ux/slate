#!/usr/bin/env node
// The day agent from the command line (SPEC §23): the same Claude session the Draft button starts, for one day. The
// 07:00 run calls this for today and then for tomorrow, so both drafts come from an agent with a clean context of its
// own. With the brain off it lays the packer's draft instead and asks no one.
//
//   node scripts/day-agent.mjs --date 2026-09-29 --from now      today, from the current hour
//   node scripts/day-agent.mjs --date 2026-09-30                  a whole day ahead
//   --note "light day, ECO208 first"   the student's own line: saved as the day's request, read in the brief (and by his next Draft)
//   --steer "…"   one line for this run only — the morning run's correction to a draft — shown in the brief as `runSteer`,
//                 weighed below his note, never saved
//   --model opus|sonnet   (default: Hub/_settings.json → model, else opus)     --root <path>   another notes root
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { todayIso } from './lib/terms.mjs'
import { readJson } from './lib/problems.mjs'
import * as D from './lib/day.mjs'
import { startDayAgent, nowHM, steerLine } from './lib/day-agent.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = 'usage: node scripts/day-agent.mjs [--root p] [--date YYYY-MM-DD] [--from HH:MM|now] [--note "…"] [--steer "…"] [--model m]'
guardFlags(['--root', '--date', '--from', '--note', '--steer', '--model'], USAGE)
const args = process.argv.slice(2)
const val = f => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] ?? null) : null }
const ROOT = notesRoot(args)
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const date = val('--date') || todayIso()
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(USAGE); process.exit(2) }
const fromArg = val('--from'), from = fromArg === 'now' ? nowHM() : fromArg
if (from && !/^\d{1,2}:\d{2}$/.test(from)) { console.error('--from: HH:MM or now'); process.exit(2) }
if (val('--note') != null) await D.setRequest(ROOT, date, val('--note'))

const settings = (await readJson(path.join(ROOT, 'Hub', '_settings.json'), {})) || {}
if (!settings.brain) {
  // under the day's lock, as the brain's own draft is (serialDay): his confirm between the gather and the write survives
  const day = await D.serialDay(ROOT, async () => {
    const g = await D.gatherDay(ROOT, { date, now: from, createPrefs: true })
    const day = D.applyDraft(g, g.day, D.packerDraft(g, { from }), { by: 'packer' })
    await D.writeDay(ROOT, day, { g }); return day
  })
  const n = day.blocks.filter(b => b.by === 'claude').length
  console.log(`DONE blocks=${n} waiting=${day.draft.waiting.length} minutes=${day.blocks.filter(b => b.by === 'claude').reduce((s, b) => s + b.end - b.start, 0)} · the packer (Claude is not the brain)`)
  process.exit(0)
}
await D.readPrefs(ROOT, { create: true })
const model = val('--model') || settings.model || 'opus'
const steer = steerLine(val('--steer'))
console.log(`day agent: drafting ${date}${from ? ` from ${from}` : ''} on ${model}${steer ? ' with a steer for this run' : ''}…`)
const job = startDayAgent({ repo, root: ROOT, env: process.env, date, from, model, steer, maxUsd: Number(settings.replanMaxUsd) > 0 ? settings.replanMaxUsd : 4 })
await job.done
const tail = job.output.trim().split('\n').slice(-6).join('\n')
console.log(tail)
console.log(`day agent: ${job.ok ? 'ok' : 'FAILED'} ${date}${job.cost != null ? ` · $${Number(job.cost).toFixed(2)}` : ''}${job.turns != null ? ` · ${job.turns} turns` : ''}${job.note ? ` · ${job.note}` : ''}`)
process.exit(job.ok ? 0 : 1)
