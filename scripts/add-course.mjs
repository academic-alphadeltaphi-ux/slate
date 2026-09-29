#!/usr/bin/env node
// Give a course in scripts/lib/terms.mjs its notebook (SPEC §20.33). The notebooks were shaped by one-off migrations
// (restructure-terms, restructure-weeks) that refuse a second run, so a course added in term had no way in. This writes
// the scaffold those left behind — the notebook's _slate.json, a General section, and for each term a page per week
// with its four subpages — and never touches a file that exists. The Quercus sync fills it from there.
//   node scripts/add-course.mjs --course "CLA 204H1" [--root /path] [--dry-run] [--json]
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { COURSES, weeks, localStamp, WEEK_PAGES } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'

guardFlags(['--course', '--root', '--dry-run', '--json'])
const args = process.argv.slice(2), opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json')
const ROOT = notesRoot(process.argv)
const KEY = opt('--course'), info = COURSES[KEY]
if (!info) { console.error(`not a course in scripts/lib/terms.mjs: ${KEY || '(no --course given)'} — add it to COURSES first`); process.exit(2) }

const written = []
const exists = p => fs.access(p).then(() => true, () => false)
const put = async (rel, text) => {
  const f = path.join(ROOT, rel)
  if (await exists(f)) return
  written.push(rel)
  if (DRY) return
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, text)
}
const json = v => JSON.stringify(v, null, 2) + '\n'
const page = (kind, body = '') => `---\ncreated: "${localStamp()}"\nkind: "${kind}"\n---\n${body}`

const wks = weeks(info.term), terms = [...new Set(wks.map(w => w.term))]
await put(`${KEY}/_slate.json`, json({ color: info.color, order: ['General', 'Announcements', ...terms], label: [info.code, info.name, info.meets].filter(Boolean).join(' · ') }))
await put(`${KEY}/General/_slate.json`, json({ order: [], label: 'Syllabus, tests and exams, office hours, links: everything administrative.' }))
for (const t of terms) {
  const inTerm = wks.filter(w => w.term === t)
  await put(`${KEY}/${t}/_slate.json`, json({ order: inTerm.map(w => w.label), label: `${t}: one page per week, each with Notes, Lectures, Recordings and Study sheets.` }))
  for (const w of inTerm) {
    await put(`${KEY}/${w.dir}.md`, page('notes', `# Week ${w.n} · ${w.span}\n`))
    await put(`${KEY}/${w.dir}/_slate.json`, json({ order: WEEK_PAGES.map(([title]) => title) }))
    for (const [title, kind] of WEEK_PAGES) await put(`${KEY}/${w.dir}/${title}.md`, page(kind))
  }
}
// The root order gains the notebook beside the other courses, ahead of the first entry that is not a course.
const rootMeta = path.join(ROOT, '_slate.json')
let meta = null
try { meta = JSON.parse(await fs.readFile(rootMeta, 'utf8')) } catch { }
if (Array.isArray(meta?.order) && !meta.order.includes(KEY)) {
  const at = meta.order.findIndex(x => !COURSES[x])
  meta.order.splice(at < 0 ? meta.order.length : at, 0, KEY)
  written.push('_slate.json')
  if (!DRY) await fs.writeFile(rootMeta, json(meta))
}
if (JSON_OUT) console.log(JSON.stringify({ course: KEY, weeks: wks.length, written: written.length, dry: DRY }))
else console.log(`${KEY}: ${wks.length} weeks · ${written.length} file(s) ${DRY ? 'would be written' : 'written'}${written.length ? '' : ' — the notebook was already there'}.`)
