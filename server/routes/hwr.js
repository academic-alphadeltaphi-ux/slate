// Handwriting routes (SPEC §20.9): POST /api/hwr and GET /api/hwr/status. Registered from server/index.js
// with register(app, ctx); every child the engine spawns runs with ctx.env (SPEC §20.1).
import * as hwr from '../hwr.js'

export function register(app, ctx) {
  hwr.configure({ env: ctx.env, repo: ctx.repo })
  // Recognise one, some or every ink element of a page. Seconds, so synchronous; the reply carries the new
  // layoutHash the open page adopts (the write is the server's own, the watcher does not echo it).
  //   { page, elementId? | elementIds?, force? } → { ok, page, layoutHash, engine, results: [ { id, text, textAt,
  //   inkHash, lines, ms } | { id, skipped: 'unchanged'|'empty'|'changed' } ] }
  //   400 page required / not an ink element · 404 no such page / element · 503 { error, note } · 500 helper error
  app.post('/api/hwr', ctx.wrap(async (req, res) => {
    const { page, elementId, elementIds, force } = req.body || {}
    if (!page || typeof page !== 'string') return res.status(400).json({ error: 'page required' })
    if (elementIds !== undefined && !(Array.isArray(elementIds) && elementIds.every(x => typeof x === 'string'))) return res.status(400).json({ error: 'elementIds must be a string array' })
    res.json(await hwr.recognizePage(page, { elementId: typeof elementId === 'string' ? elementId : undefined, elementIds, force: !!force }))
  }))
  // Which runner the server would use: { available: true|false|null, runner, engine, note, building }.
  // ?probe=1 resolves it now — which may build the helper on first use, up to a few minutes.
  app.get('/api/hwr/status', ctx.wrap(async (req, res) => {
    if (ctx.q(req, 'probe')) await hwr.ensureRunner({ force: true })
    res.json(hwr.status())
  }))
}
