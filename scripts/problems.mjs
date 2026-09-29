#!/usr/bin/env node
// Problems pages and Hub/_problems.json (SPEC §20.2). Deterministic, connector-free; the 07:10 pass (step 6 of
// scripts/sync-prompt.md), the Sync button's Claude phase, POST /api/problems/refresh and the Claude pass's --add all
// run this file.
//   node scripts/problems.mjs [--root p] [--course "ECO 208Y1"] [--today YYYY-MM-DD] [--dry-run] [--json]
//       generate or merge every week's Problems page (append-only, never touching a tick), then write Hub/_problems.json
//   node scripts/problems.mjs --summary [--json]
//       only rescan the pages and rewrite Hub/_problems.json
//   echo '[{"label":"Problem Set 1 · Q3","src":"[[1- Constrained Optimization]]"}]' | node scripts/problems.mjs --add "<rel Problems.md>"
//       append rows through the same merge — the only way a Claude pass adds rows — then rewrite the summary
// Exit 0 on a clean run; a thrown error prints and exits 1 (the Claude pass reports the last lines).
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { COURSES, todayIso } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { assignedFor, applyToPage, addRows, summarize, PROBLEMS_JSON, writeAtomic, readJson } from './lib/problems.mjs'
import { guardFlags } from './lib/argv.mjs'
import { acquireLock } from './lib/brain.mjs'

guardFlags(['--add', '--course', '--dry-run', '--json', '--root', '--summary', '--today'])

const args = process.argv.slice(2)
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json'), SUMMARY = args.includes('--summary')
const ADD = opt('--add'), ONLY = opt('--course'), TODAY = opt('--today') || todayIso()
const ROOT = notesRoot(process.argv)
const log = (...a) => { if (!JSON_OUT) console.log(...a) }

// Read, merge, rewrite: one writer at a time, or two course agents adding rows at once each rewrite Hub/_problems.json from
// the registry they read before the other wrote (SPEC §24). The brain's lock, since they are the same writers.
const release = DRY ? null : await acquireLock(ROOT)
const registry = await readJson(PROBLEMS_JSON(ROOT), {})
registry.pages ||= {}
const BRAIN = !!(await readJson(path.join(ROOT, 'Hub', '_settings.json'), {}))?.brain
let pagesTouched = 0, created = 0, merged = 0, rowsAdded = 0

if (ADD) {
  const stdin = await new Promise((res, rej) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => (s += d)); process.stdin.on('end', () => res(s)); process.stdin.on('error', rej) })
  let rows
  try { rows = JSON.parse(stdin || '[]') } catch (e) { throw new Error(`--add expects a JSON array of { label, src?, kind? } on stdin: ${e.message}`) }
  if (!Array.isArray(rows)) throw new Error('--add expects a JSON array')
  const r = await addRows(ROOT, ADD, rows, { registry, dry: DRY })
  rowsAdded += r.added.length; if (r.created) created++; else if (r.added.length) merged++
  if (r.changed) pagesTouched++
  log(`${ADD} — ${r.added.length} row(s) added${r.created ? ' (page created)' : ''}${DRY ? ' (dry run)' : ''}`)
} else if (!SUMMARY && BRAIN) {
  // Claude is the brain (SPEC §20.37): no row is read out of an announcement or the outline; Claude adds them with --add.
  registry.issues = []
  log('Claude is the brain (Hub/_settings.json): no rows generated here — they are added with --add.')
} else if (!SUMMARY) {
  const issues = []
  for (const [courseKey, info] of Object.entries(COURSES)) {
    if (ONLY && courseKey !== ONLY && info.code !== ONLY) continue
    const plans = await assignedFor(courseKey, ROOT)
    for (const [k, plan] of plans) {
      issues.push(...(plan.issues || []))
      if (plan.unplaced) continue
      const r = await applyToPage({ root: ROOT, courseKey, week: plan.week, plan, registry, dry: DRY })
      if (r.skipped) continue
      if (r.created) created++; else if (r.added.length) merged++
      rowsAdded += r.added.length; if (r.changed) pagesTouched++
      log(`  ${courseKey} ${plan.week.label}: ${r.created ? 'created' : r.added.length ? 'merged' : r.headerRewritten ? 'header' : 'unchanged'}${r.added.length ? ' +' + r.added.join(', ') : ''}`)
    }
  }
  registry.issues = issues
  for (const is of issues) log(`  issue ${is.course} ${is.title}: ${is.sentence}`)
}

const summary = await summarize(ROOT, { today: TODAY, registry })
if (!DRY) await writeAtomic(PROBLEMS_JSON(ROOT), JSON.stringify(summary, null, 2) + '\n')
await release?.()

// The last line: what the Claude pass and the refresh route read.
const unattemptedThisWeek = {}
for (const u of summary.upcoming) { const open = u.counts.assigned - u.counts.attempted; if (open > 0) unattemptedThisWeek[u.course] = (unattemptedThisWeek[u.course] || 0) + open }
const webassignDue = Object.values(summary.courses).flatMap(c => (c.webassign?.sets || []).filter(s => !s.attempted && s.posts <= TODAY && TODAY <= s.due).map(s => ({ set: s.set, due: s.due, confirmed: s.confirmed })))
const out = { pages: Object.keys(summary.pages).length, touched: pagesTouched, created, merged, rowsAdded, issues: summary.issues.length, unattemptedThisWeek, webassignDue, dry: DRY }
if (JSON_OUT) console.log(JSON.stringify(out))
else console.log(`Problems: ${out.pages} page(s) known, ${pagesTouched} written, ${rowsAdded} row(s) added${summary.issues.length ? `, ${summary.issues.length} issue(s)` : ''}${DRY ? ' (dry run, nothing written)' : ''}.`)
