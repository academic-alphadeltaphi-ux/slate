// Weeks he flagged for review (SPEC §21.13): the one writer of Hub/_review.json (scripts/lib/review.mjs).
//   PUT /api/review { course, n, week, note?, flag }
//     flag true: the week is flagged, with `note` (one line, at most 120 characters; empty is fine); flag false: unflagged
//   → { flag } the week's flag as it now stands, or null
// The course must be one this install keeps (terms.mjs or the hub); `n` is the week's number in its term, as the week
// route gives it. The morning's sync never writes the file.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES } from '../../scripts/lib/terms.mjs'
import { REVIEW_JSON, readReview, withFlag } from '../../scripts/lib/review.mjs'

export function register(app, ctx) {
  const { ROOT, wrap, HttpError, store } = ctx
  app.put('/api/review', wrap(async (req, res) => {
    const { course, n, week, flag } = req.body || {}
    if (typeof course !== 'string' || !course) throw new HttpError(400, 'course required')
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, 'n must be the week\'s number')
    if (typeof flag !== 'boolean') throw new HttpError(400, 'flag must be true or false')
    let known = !!COURSES[course]
    if (!known) { try { known = (JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', '_hub.json'), 'utf8')).courses || []).some(c => c.key === course) } catch { } }
    if (!known) throw new HttpError(404, 'not a course')
    const file = REVIEW_JSON(ROOT)
    const out = await store.withFileLock(file, async () => {
      const doc = withFlag(await readReview(ROOT), course, n, flag ? { week, note: req.body.note } : null)
      await store.atomicWrite(file, JSON.stringify(doc, null, 2) + '\n')
      return doc.courses[course]?.[n] || null
    })
    res.json({ flag: out })
  }))
}
