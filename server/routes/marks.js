// Marks he entered himself, and his target (SPEC §21.12): the one writer of Hub/_marks.json (scripts/lib/marks.mjs).
//   PUT /api/marks { course, marks?, target? }
//     marks: the course's typed marks, whole — what the calculator's Keep sends; {} forgets them all (back to Quercus only)
//     target: a percent, or null to clear it; left out, it stays as it was
//   → { course } the hub course as the screens read it, standing recomputed, so the calculator shows it without a reload.
// Only the course's own components and items are kept (cleanMarks); a course the hub does not know is refused. The
// morning's sync reads the file and never writes it.
import fs from 'node:fs/promises'
import path from 'node:path'
import { MARKS_JSON, NOTE, readMarks, cleanMarks, targetOf, applyMarks } from '../../scripts/lib/marks.mjs'

export function register(app, ctx) {
  const { ROOT, wrap, HttpError, store } = ctx
  app.put('/api/marks', wrap(async (req, res) => {
    const key = req.body?.course
    if (typeof key !== 'string' || !key) throw new HttpError(400, 'course required')
    let hub = null
    try { hub = JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', '_hub.json'), 'utf8')) } catch { }
    const c = (hub?.courses || []).find(x => x.key === key)
    if (!c) throw new HttpError(404, 'not a course — Quercus has not been checked for it yet')
    if (!c.grading) throw new HttpError(409, 'this course has no marking scheme on file, so there is nothing to enter a mark against')
    const file = MARKS_JSON(ROOT)
    const entry = await store.withFileLock(file, async () => {
      const doc = await readMarks(ROOT)
      const cur = doc.courses[key] || {}
      const next = { ...cur }
      if (req.body.marks !== undefined) next.marks = cleanMarks(c.grading, req.body.marks)
      if (req.body.target !== undefined) next.target = targetOf(req.body.target)
      if (next.target == null) delete next.target
      if (next.marks && !Object.keys(next.marks).length) delete next.marks
      next.updatedAt = new Date().toISOString()
      if (next.marks || next.target != null) doc.courses[key] = next; else delete doc.courses[key]
      await store.atomicWrite(file, JSON.stringify({ _note: NOTE, version: 1, courses: doc.courses }, null, 2) + '\n')
      return doc.courses[key] || null
    })
    res.json({ course: applyMarks(c, entry) })
  }))
}
