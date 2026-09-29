#!/usr/bin/env node
// Courses as data (SPEC §21). A brother's Claude never writes JavaScript: it writes Hub/_courses.json, this script says
// in plain words what is wrong with it, and then renders the two files the app reads — scripts/lib/terms.mjs and
// scripts/lib/syllabus.mjs — from the template in scripts/lib/terms.template.mjs. A hand-written terms.mjs (the student's own,
// which carries no "rendered by" line) is never overwritten without --force.
//   node scripts/courses.mjs check [<file>]           problems, one per line; exit 1 when there are any
//   node scripts/courses.mjs write [<file>] [--force]  render terms.mjs and syllabus.mjs; exit 1 on a problem
//   node scripts/courses.mjs status                    rendered from what, when — or hand-written
//   node scripts/courses.mjs example                   the example file, to copy the shape of
//   node scripts/courses.mjs template-check            the template's helpers must match the live terms.mjs (kit builder)
// <file> defaults to <notes root>/Hub/_courses.json. --json makes the last line a JSON summary.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { check } from './lib/courses-schema.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'

guardFlags(['--root', '--force', '--json'], 'node scripts/courses.mjs check|write|status|example|template-check [<file>] [--root <notes root>] [--force] [--json]')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TERMS = path.join(REPO, 'scripts', 'lib', 'terms.mjs'), SYLLABUS = path.join(REPO, 'scripts', 'lib', 'syllabus.mjs')
// the example lives under kit/ in the development repo and at the root of a shipped kit
const EXAMPLE = [path.join(REPO, 'kit', 'courses.example.json'), path.join(REPO, 'courses.example.json')].find(p => fs.existsSync(p)) || path.join(REPO, 'courses.example.json')
const args = process.argv.slice(2), JSON_OUT = args.includes('--json'), FORCE = args.includes('--force')
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root')
const cmd = positional[0], fileArg = positional[1]
const ROOT = notesRoot(process.argv)
const FILE = fileArg ? path.resolve(fileArg) : path.join(ROOT, 'Hub', '_courses.json')
const out = v => { if (JSON_OUT) console.log(JSON.stringify(v)) }

import { renderTerms, renderSyllabus, renderedFrom as rendered, MARK, TEMPLATE } from './lib/courses-render.mjs'

// ---- commands ---------------------------------------------------------------------------------------------------
if (cmd === 'example') { process.stdout.write(fs.readFileSync(EXAMPLE, 'utf8')); process.exit(0) }
if (cmd === 'status') {
  const t = rendered(TERMS), s = rendered(SYLLABUS)
  console.log(t ? `terms.mjs: rendered from ${t}` : 'terms.mjs: hand-written (not rendered)')
  console.log(s ? `syllabus.mjs: rendered from ${s}` : 'syllabus.mjs: hand-written (not rendered)')
  out({ terms: t, syllabus: s, file: FILE, exists: fs.existsSync(FILE) })
  process.exit(0)
}
if (cmd === 'template-check') {
  // The helpers in the template must be the live file's helpers: the kit ships the rendered file, so a fix made to
  // terms.mjs by hand that never reached the template would be silently absent from every brother's copy.
  const tail = t => t.slice(t.indexOf('// The subpages every week folder is scaffolded with'))
  const live = tail(fs.readFileSync(TERMS, 'utf8')), tpl = tail(fs.readFileSync(TEMPLATE, 'utf8'))
  if (live === tpl) { console.log('template-check: the helpers match'); out({ ok: true }); process.exit(0) }
  const a = live.split('\n'), b = tpl.split('\n')
  const i = a.findIndex((l, k) => l !== b[k])
  console.error(`template-check: scripts/lib/terms.template.mjs differs from scripts/lib/terms.mjs at helper line ${i + 1}:\n  live:     ${a[i]}\n  template: ${b[i]}`)
  out({ ok: false, line: i + 1 }); process.exit(1)
}
if (cmd !== 'check' && cmd !== 'write') { console.error('usage: node scripts/courses.mjs check|write|status|example|template-check [<file>] [--force] [--json]'); process.exit(2) }
let doc = null
try { doc = JSON.parse(fs.readFileSync(FILE, 'utf8')) }
catch (e) {
  const why = e.code === 'ENOENT' ? `there is no ${FILE} yet — copy the shape of courses.example.json (node scripts/courses.mjs example prints it)` : `${FILE} is not valid JSON: ${e.message}`
  console.error(why); out({ ok: false, problems: [why] }); process.exit(1)
}
const problems = check(doc)
if (problems.length) {
  console.error(`${problems.length} problem${problems.length > 1 ? 's' : ''} in ${FILE}:`)
  for (const p of problems) console.error('  · ' + p)
  out({ ok: false, problems }); process.exit(1)
}
const n = Object.keys(doc.courses).length
if (cmd === 'check') { console.log(`${FILE}: ${n} course${n === 1 ? '' : 's'}, no problems`); out({ ok: true, courses: Object.keys(doc.courses) }); process.exit(0) }
for (const f of [TERMS, SYLLABUS]) if (fs.existsSync(f) && !rendered(f) && !FORCE) {
  console.error(`${path.relative(REPO, f)} is hand-written (no "rendered by" line); refusing to overwrite it. Pass --force if you mean it.`)
  out({ ok: false, problems: ['hand-written terms.mjs'] }); process.exit(1)
}
const source = path.relative(REPO, FILE).startsWith('..') ? FILE : path.relative(REPO, FILE)
fs.writeFileSync(TERMS, renderTerms(doc, source))
fs.writeFileSync(SYLLABUS, renderSyllabus(doc, source))
// Prove the result loads before anyone else trusts it.
try { const m = await import(pathToFileURL(TERMS).href + '?t=' + Date.now()); if (Object.keys(m.COURSES).length !== n) throw new Error('rendered file lost a course'); await import(pathToFileURL(SYLLABUS).href + '?t=' + Date.now()) }
catch (e) { console.error('the rendered file does not load: ' + e.message); out({ ok: false, problems: [e.message] }); process.exit(1) }
console.log(`wrote scripts/lib/terms.mjs and scripts/lib/syllabus.mjs: ${n} course${n === 1 ? '' : 's'} (${Object.keys(doc.courses).join(', ')})`)
out({ ok: true, courses: Object.keys(doc.courses) })
