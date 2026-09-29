// Problems routes (SPEC §20.2): GET /api/problems computes Hub/_problems.json's object live from disk (~50 small
// pages today, tens of milliseconds) so the chip, the course screen and the plan never show yesterday's ticks;
// ?page=<rel> narrows it to one page's rows and counts. POST /api/problems/refresh runs scripts/problems.mjs
// in the background exactly like /api/transcribe does — one at a time, with ctx.env (SPEC §20.1), so it is Node
// inside Slate.app too. Registered from server/index.js with register(app, ctx).
import path from 'node:path'
import { execFile } from 'node:child_process'
import { summarize, pageSummary } from '../../scripts/lib/problems.mjs'

let running = null

export function register(app, ctx) {
  const { ROOT, wrap, q, repo, env, HttpError } = ctx
  // → the _problems.json object (updatedAt, pages, issues, courses[key].weeks[].counts/rows, upcoming), or with ?page=
  //   { page, courseKey, course, week, n, topic, tutorial, counts, rows, blockId, hash, webassign: { …scores, set } | null }
  //   404 when the page does not exist.
  app.get('/api/problems', wrap(async (req, res) => {
    const page = q(req, 'page')
    if (page) {
      const rel = ctx.store.safeRel(page)
      const s = await pageSummary(ROOT, rel)
      if (!s) throw new HttpError(404, `no such page: ${rel}`)
      return res.json(s)
    }
    res.json(await summarize(ROOT))
  }))
  // Runs `node scripts/problems.mjs --json` against ROOT; replies when it finishes (a few seconds) with { ok, summary }
  // — `summary` is the script's last JSON line. { started: false, running: true } while one is already running;
  // 500 { error } with the last stderr line when the script fails.
  app.post('/api/problems/refresh', wrap(async (req, res) => {
    if (running) return res.json({ started: false, running: true, startedAt: running.startedAt })
    running = { startedAt: new Date().toISOString() }
    try {
      const r = await new Promise(resolve => {
        execFile(process.execPath, [path.join(repo, 'scripts', 'problems.mjs'), '--json'], { env, cwd: repo, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
      })
      if (r.err) { const last = (r.stderr || r.err.message).trim().split('\n').pop(); return res.status(500).json({ error: last || 'problems.mjs failed' }) }
      let summary = null
      try { summary = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { }
      res.json({ ok: true, summary })
    } finally { running = null }
  }))
  app.get('/api/problems/status', (req, res) => res.json({ running: !!running, startedAt: running?.startedAt || null }))
}
