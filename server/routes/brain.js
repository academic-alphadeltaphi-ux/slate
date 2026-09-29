// GET /api/brain (SPEC §20.37): what Claude is doing with slate, for the Home screen — whether it is the brain, what waits in
// the inbox for it, the questions it asked the student, and what it decided in its last run, each with its reason. Read-only:
// nothing is written by navigation (SPEC §20.1); scripts/brain.mjs is the only writer of these files.
import fs from 'node:fs/promises'
import path from 'node:path'

const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

export function register(app, { ROOT, wrap }) {
  app.get('/api/brain', wrap(async (req, res) => {
    const hub = path.join(ROOT, 'Hub')
    const settings = await readJson(path.join(hub, '_settings.json'), {})
    const brain = await readJson(path.join(hub, '_brain.json'), null)
    const inbox = await readJson(path.join(hub, '_inbox.json'), null)
    const waiting = Object.values(inbox?.items || {}).filter(i => i && (i.status || 'waiting') === 'waiting')
      .map(({ id, kind, courseKey, title, page, module, posted }) => ({ id, kind, courseKey, title, page, module: module || null, posted: posted || null }))
    const runs = brain?.runs || []
    const last = [...runs].reverse().find(r => r.endedAt) || runs[runs.length - 1] || null
    const decisions = last ? (brain.decisions || []).filter(d => d.run === last.id && !d.undone).map(({ id, at, type, summary, reason }) => ({ id, at, type, summary, reason })) : []
    const questions = Object.values(brain?.questions || {}).filter(q => q && !q.answered).map(({ id, at, courseKey, text, page }) => ({ id, at, courseKey, text, page }))
    res.json({
      enabled: !!settings?.brain, running: !!brain?.current, waiting, questions, decisions,
      tasks: Object.values(brain?.tasks || {}).filter(t => t && !t.withdrawn).length,
      lastRun: last ? { id: last.id, startedAt: last.startedAt, endedAt: last.endedAt, note: last.note || null } : null,
    })
  }))
}
