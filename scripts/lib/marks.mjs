// Marks he entered himself, and his own target (SPEC §21.12). One file in the notes, Hub/_marks.json, written only by the
// server (PUT /api/marks, the calculator's Keep) or by hand, and read by the morning's sync and by every route that serves
// a course's standing. The sync never writes it, so a typed mark survives every check; an update never touches it, since
// the notes live apart from the code.
//
//   { "version": 1, "courses": { "<course key>": { "marks": { <scores shape> }, "target": 78, "updatedAt": "…" } } }
//
// `marks` has the shape of `scores` in src/grade.js: { [component]: { [item]: 0..100 } } for itemised components,
// { [component]: { all: [..] } } or { avg } for `many` ones. Quercus wins wherever it has a mark (src/grade.js withMine).
import fs from 'node:fs/promises'
import path from 'node:path'
import { withMine, courseStanding, manyOf, markOf } from '../../src/grade.js'

export const MARKS_JSON = root => path.join(root, 'Hub', '_marks.json')
export const NOTE = 'Marks entered by hand in the calculator (Work out your mark), for what never reaches Quercus; Quercus wins wherever it has a mark. Same shape as the grade model\'s scores. SPEC §21.12.'

export async function readMarks(root) {
  try { const j = JSON.parse(await fs.readFile(MARKS_JSON(root), 'utf8')); return j && typeof j.courses === 'object' && j.courses ? j : { version: 1, courses: {} } }
  catch { return { version: 1, courses: {} } }
}

// A target is a whole or half percent a course can be finished at; anything else is no target.
export const targetOf = v => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 10) / 10 : null }

// Only what the course's grading knows, as numbers in range: a component key it has, an item key that component lists, at
// most 60 marks in a list. Anything else is left out rather than refused, so a stale screen cannot fail a save.
export function cleanMarks(grading, marks) {
  const out = {}
  for (const comp of grading?.components || []) {
    const m = marks?.[comp.key]; if (!m || typeof m !== 'object') continue
    if (comp.many) { const v = manyOf({ all: Array.isArray(m.all) ? m.all.slice(0, 60) : undefined, avg: m.avg }); if (v) out[comp.key] = v.all ? { all: v.all } : { avg: v.avg }; continue }
    const items = {}
    for (const it of comp.items || []) { const v = markOf(m[it.key]); if (v != null) items[it.key] = v }
    if (Object.keys(items).length) out[comp.key] = items
  }
  return out
}

// A hub course as the screens read it: Quercus's marks kept apart (`quercusScores`), his filled in (`scores`), which cells
// are his (`fromMe`), the ones Quercus has since marked (`overridden`), his target, and the standing over all of it.
// Idempotent: it always starts again from `quercusScores` (a hub written before §21.12 has only `scores`, which then are).
export function applyMarks(c, entry) {
  if (!c?.grading) return c
  const base = c.quercusScores ?? c.scores ?? {}
  const myMarks = cleanMarks(c.grading, entry?.marks)
  const { scores, from, overridden } = withMine(c.grading, base, myMarks)
  const target = targetOf(entry?.target)
  return { ...c, quercusScores: base, scores, myMarks, fromMe: from, overridden, target, standing: courseStanding(c.grading, scores, target) }
}
