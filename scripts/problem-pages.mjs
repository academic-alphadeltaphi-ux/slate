#!/usr/bin/env node
// A page per problem (SPEC §20.73): the question cut out of its PDF, room to work, the solution folded until asked for.
// Deterministic and connector-free; the morning run's course agents (scripts/brain/course.md step 7), the coordinator's
// write-through and the single brain (brain-prompt.md step 7) run it after the rows are added.
//   node scripts/problem-pages.mjs [--root p] [--course ECO208] [--week N] [--force] [--dry-run] [--json]
//       make or refresh the page of every itemised row in the courses with `problemPages` (scripts/lib/terms.mjs);
//       the last line says what still needs Claude: `pending` (no solution yet), `waiting` (the book's chapter is not in
//       slate), `errors` (the question could not be cut — crop it by hand)
//   node scripts/problem-pages.mjs status [--course ECO208] [--json]
//       every page, its solution (official | claude | pending | waiting), its question picture and the text read off it
//   node scripts/problem-pages.mjs solve "<Course/…/Problems/<set>/<name>.md>" [--figure fig.svg …] < solution.md
//       write Claude's worked solution (markdown, $…$ and $$…$$ math, \$ for a dollar sign, headings from ### down) into
//       the page's folded solution; a figure is referenced in the markdown by its bare file name, ![Budget line](fig.svg)
//   node scripts/problem-pages.mjs crop "<page.md>" --part "<file.pdf>@<page>:<x0>,<y0>,<x1>,<y1>" [--part …] [--solution]
//       cut the question (or with --solution the course's solution) by hand, in PDF points; never recut after
// Exit 0 on a clean run; a thrown error prints and exits 1.
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { build, solve, crop, status, pythonReady } from './lib/problem-pages.mjs'

guardFlags(['--course', '--dry-run', '--figure', '--force', '--json', '--part', '--root', '--solution', '--week'])
const args = process.argv.slice(2)
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const all = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []))
const JSON_OUT = args.includes('--json')
const ROOT = notesRoot(process.argv)
const positional = args.filter((a, i) => !a.startsWith('--') && !['--root', '--course', '--week', '--part', '--figure'].includes(args[i - 1]))
const cmd = ['status', 'solve', 'crop'].includes(positional[0]) ? positional[0] : 'build'
const print = (obj, line) => console.log(JSON_OUT ? JSON.stringify(obj) : line)

if (!pythonReady() && (cmd === 'build' || cmd === 'crop')) throw new Error('the OCR venv is missing (bin/install-ocr.sh): problem-crop.py needs its PyMuPDF and Vision')

if (cmd === 'build') {
  const r = await build(ROOT, { course: opt('--course') || null, week: opt('--week') ?? null, force: args.includes('--force'), dry: args.includes('--dry-run'), log: JSON_OUT ? () => { } : l => console.log(l) })
  print(r, `Problem pages: ${r.pages} known, ${r.created} created, ${r.updated} updated · ${r.pending.length} waiting for Claude's solution · ${r.waiting.length} waiting for the book${r.errors.length ? ` · ${r.errors.length} could not be cut: ${r.errors.map(e => e.page.split('/').pop()).join(', ')}` : ''}${args.includes('--dry-run') ? ' (dry run)' : ''}.`)
} else if (cmd === 'status') {
  const rows = await status(ROOT, { course: opt('--course') || null })
  if (JSON_OUT) console.log(JSON.stringify(rows))
  else for (const r of rows) console.log(`${r.solution.padEnd(8)} ${r.page}${r.manual ? ' (cut by hand)' : ''}`)
} else if (cmd === 'solve') {
  const rel = positional[1]
  if (!rel) throw new Error('solve needs the page: problem-pages.mjs solve "<Course/…/Problems/<set>/<name>.md>" < solution.md')
  const md = await new Promise((res, rej) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => (s += d)); process.stdin.on('end', () => res(s)); process.stdin.on('error', rej) })
  const r = await solve(ROOT, rel, md, { figures: all('--figure') })
  print(r, r.written ? `${rel}: Claude's solution written (folded until he opens it).` : `${rel}: not written — ${r.why}.`)
} else {
  const rel = positional[1], parts = all('--part')
  if (!rel || !parts.length) throw new Error('crop needs the page and at least one --part "<file.pdf>@<page>:<x0>,<y0>,<x1>,<y1>"')
  const r = await crop(ROOT, rel, parts, { solution: args.includes('--solution') })
  print(r, `${rel}: ${args.includes('--solution') ? 'solution' : 'question'} cut by hand${r.written === false ? ` — ${r.why}` : ''}.`)
}
