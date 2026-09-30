// Topics he flagged for review (SPEC §21.13): the server's writer of Hub/_review.json (scripts/lib/review.mjs).
//   PUT /api/review { course, n, week, topic, note }            a topic of the week flagged, with a line of note; the same
//                                                              words (or `id`) change the one already there
//   PUT /api/review { course, n, week, id, topic, note }        that topic changed
//   PUT /api/review { course, n, remove: true, id? }            that topic taken off; without `id`, every topic of the week
//   → { week } the week's flags as they now stand ({ week, topics }), or null
// The course must be one this install keeps (terms.mjs or the hub); `n` is the week's number in its term, as the week route
// gives it. The morning's sync never writes the file.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES } from '../../scripts/lib/terms.mjs'
import { REVIEW_JSON, readReview, withReview } from '../../scripts/lib/review.mjs'

export function register(app, ctx) {
  const { ROOT, wrap, HttpError, store } = ctx
  app.put('/api/review', wrap(async (req, res) => {
    const { course, n, week, id, topic, note, remove } = req.body || {}
    if (typeof course !== 'string' || !course) throw new HttpError(400, 'course required')
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, 'n must be the week\'s number')
    if (id !== undefined && typeof id !== 'string') throw new HttpError(400, 'id must be a flag\'s id')
    let known = !!COURSES[course]
    if (!known) { try { known = (JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', '_hub.json'), 'utf8')).courses || []).some(c => c.key === course) } catch { } }
    if (!known) throw new HttpError(404, 'not a course')
    const file = REVIEW_JSON(ROOT)
    const out = await store.withFileLock(file, async () => {
      let r
      try { r = withReview(await readReview(ROOT), course, n, week, remove ? { remove: true, ...(id ? { id } : {}) } : { id, topic, note }) }
      catch (e) { throw new HttpError(409, e.message) }
      await store.atomicWrite(file, JSON.stringify(r.doc, null, 2) + '\n')
      return r.week
    })
    res.json({ week: out })
  }))
}
