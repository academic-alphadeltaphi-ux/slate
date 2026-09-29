// Plan routes (SPEC §20.3). GET /api/plan serves Hub/_plan.json; with ?refresh=1 it runs `scripts/plan.mjs --dry-run
// --json --print` and answers with the plan the script printed: ticks and counts recomputed from disk, nothing written
// (SPEC §20.1: nothing is written by navigation — a Home or What's next mount never touches Hub/), `updatedAt` = when the
// file was last written by a pass or a rebuild (null before the first). Single-flight, so a Home and a What's next mount
// share one child. POST /api/plan/rebuild runs the script with --pages (the Refresh button, the explicit rebuild) — with
// the 07:10 pass and the 10:00 build the only writers of _plan.json, Next 7 days.md and the Plan pages besides a tick
// through PUT /api/page. Children run with ctx.env (SPEC §20.1), so they are Node inside Slate.app too.
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'

let inflight = null, rebuild = null

export function register(app, ctx) {
  const { ROOT, wrap, q, repo, env } = ctx
  const file = () => path.join(ROOT, 'Hub', '_plan.json')
  const run = (args, timeout) => new Promise(resolve => {
    execFile(process.execPath, [path.join(repo, 'scripts', 'plan.mjs'), '--json', ...args], { env, cwd: repo, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
  const lastLine = s => s.trim().split('\n').pop() || ''
  const refresh = () => (inflight ||= run(['--dry-run', '--print'], 30000).finally(() => { inflight = null }))
  const parsePlan = s => { try { const p = JSON.parse(lastLine(s)); return p && Array.isArray(p.days) && Array.isArray(p.meetings) ? p : null } catch { return null } }
  // → the plan object: with ?refresh=1 the one the script just computed (read-only); otherwise Hub/_plan.json. When the
  // refresh fails the last good file is served with `note`; 404 when there is no file to fall back on.
  app.get('/api/plan', wrap(async (req, res) => {
    let note = null
    if (q(req, 'refresh')) {
      const r = await refresh()
      if (r.err) note = 'The plan script failed: ' + (lastLine(r.stderr) || r.err.message)
      else { const plan = parsePlan(r.stdout); if (plan) return res.json(plan); note = 'The plan script printed nothing readable' }
    }
    try { const plan = JSON.parse(await fs.readFile(file(), 'utf8')); res.json(note ? { ...plan, note } : plan) }
    catch { res.status(404).json({ error: note || 'Your week has not been built yet — press Refresh on To do' }) }
  }))
  // Runs `plan.mjs --json --pages`; replies when it finishes with { ok, summary } (the script's last JSON line);
  // { started: false, running: true } while one is running; 500 { error } with the last stderr line when it fails.
  app.post('/api/plan/rebuild', wrap(async (req, res) => {
    if (rebuild) return res.json({ started: false, running: true, startedAt: rebuild.startedAt })
    rebuild = { startedAt: new Date().toISOString() }
    try {
      const r = await run(['--pages'], 90000)
      if (r.err) return res.status(500).json({ error: lastLine(r.stderr) || r.err.message || 'plan.mjs failed' })
      let summary = null
      try { summary = JSON.parse(lastLine(r.stdout)) } catch { }
      res.json({ ok: true, summary })
    } finally { rebuild = null }
  }))
  app.get('/api/plan/status', (req, res) => res.json({ running: !!rebuild || !!inflight, rebuilding: !!rebuild, startedAt: rebuild?.startedAt || null }))
}
