import express from 'express'
import { execFile, spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './fs.js'
import { ROOT, HttpError } from './fs.js'
import * as search from './search.js'
import * as watch from './watch.js'
import * as git from './git.js'
import { CLAUDE_MD, CONTRACT_VERSION } from './claude-md.js'
import { EDITION, ED, enabled, BUDGET, CADENCE_DAYS, RUNNER } from './edition.js'
import { childPath, WIN } from '../scripts/lib/platform.mjs'
import { readMarks, applyMarks } from '../scripts/lib/marks.mjs'
import { readReview } from '../scripts/lib/review.mjs'

const PORT = Number(process.env.SLATE_PORT || 5174)
const app = express()
// Not on the two routes that stream a raw body: a dropped `.json` file arrived as `application/json`, the parser read it, and
// saveAsset piped an already-drained request into a 0-byte file with a 200 (review 2026-09-18).
const jsonBody = express.json({ limit: '50mb' })
app.use((req, res, next) => (req.path === '/api/asset' || req.path === '/api/dictate' ? next() : jsonBody(req, res, next)))
// Localhost is not a boundary against the browser (review of 2026-09-18, SPEC §20.58): a page on any site can POST here
// without a preflight when its body is plain text or absent, and /api/sync (a Claude session with Bash), /api/asset (a
// file into a notebook) and /api/dictate act on such a request. A state-changing request that names an Origin must name
// one of ours — this server, or a dev server on this machine. Scripts, curl and the tests send no Origin and pass.
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  const origin = req.headers.origin
  if (origin && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ error: 'cross-site request refused' })
  if (!origin && String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return res.status(403).json({ error: 'cross-site request refused' })
  next()
})

const wrap = fn => async (req, res, next) => { try { await fn(req, res, next) } catch (e) { next(e) } }
const q = (req, k) => (req.query[k] === undefined ? undefined : String(req.query[k]))

// ---- the one child-process environment (SPEC §20.1) --------------------------------------------
// Every script the server spawns — the sync, the transcriber, and each route module's children — runs with the
// notes root, the ~/.local/bin PATH prefix (claude, uv) and ELECTRON_RUN_AS_NODE=1, so `process.execPath` is
// Node even inside Slate.app. Only the export printer deletes that key (it wants a real Electron).
export const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const env = { ...process.env, SLATE_ROOT: ROOT, ELECTRON_RUN_AS_NODE: '1', PATH: childPath() }
// Connector tool names as the CLI spells them (verified 2026-09-09 by a one-turn `claude -p` probe). The cron prompt
// references them; the Sync button never needs them — email and calendar are cron-only steps (SPEC §20.11).
export const CONNECTOR_TOOLS = {
  calendar: ['mcp__claude_ai_Google_Calendar__list_calendars', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__update_event', 'mcp__claude_ai_Google_Calendar__delete_event'],
  gmail: ['mcp__claude_ai_Gmail__send_message'],
}
// The route context: every server/routes/<name>.js exports register(app, ctx) and defines nothing ctx provides.
const ctx = { store, ROOT, HttpError, wrap, q, git, watch, search, PORT, repo, env }
// Registered in this order, each module optional until its group lands it (a missing file is skipped once, with a line).
// Which edition this install is (SPEC §21): server/edition.js reads it once at boot from the notes root's settings.
// The kit the brothers install says "adphi", which leaves Ask unregistered — the route is never mounted, so the
// feature is not merely hidden on the screen.
const ALL_ROUTES = ['search', 'plan', 'problems', 'course', 'marks', 'review', 'week', 'library', 'calendar', 'ask', 'hwr', 'export', 'history', 'dictate', 'brain', 'day']
const ROUTES = ALL_ROUTES.filter(n => (n !== 'ask' || enabled('ask')) && (n !== 'day' || enabled('work')))
async function registerRoutes() {
  const loaded = new Set()
  for (const name of ROUTES) {
    let mod = null
    try { mod = await import(`./routes/${name}.js`) }
    // the loader names the file with the machine's separators (`routes\ask.js` on Windows), so they are made one first
    catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).replace(/\\/g, '/').includes(`routes/${name}.js`)) { console.log(`[routes] ${name}: not landed yet, skipped`); continue } throw e }
    if (typeof mod.register !== 'function') throw new Error(`server/routes/${name}.js must export register(app, ctx)`)
    mod.register(app, ctx); loaded.add(name)
  }
  return loaded
}

// Speech — transcription and dictation — is parakeet-mlx on Apple Silicon: off where the edition says so (the Windows kit,
// SPEC §21.9), on a PC, and on an Intel Mac. The screens read it here at first paint and offer nothing they cannot do;
// the routes below refuse with the same words rather than reaching for a tool that is not there.
export const SPEECH = enabled('speech') && !WIN && (process.arch === 'arm64' || process.env.SLATE_SPEECH === '1')
export const SPEECH_NOTE = !enabled('speech') || WIN ? 'Transcription and dictation are Mac-only and are not part of this copy.' : 'Transcription and dictation need a Mac with an Apple chip.'
app.get('/api/health', (req, res) => res.json({ ok: true, root: ROOT, edition: EDITION, repo, budget: BUDGET, cadenceDays: CADENCE_DAYS, runner: RUNNER, crest: ED.crest || null, name: ED.name, speech: SPEECH, speechNote: SPEECH ? null : SPEECH_NOTE }))
app.get('/api/tree', wrap(async (req, res) => res.json(await store.tree())))
app.get('/api/pages', wrap(async (req, res) => res.json(await store.pages(q(req, 'dir')))))
app.get('/api/page', wrap(async (req, res) => res.json(await store.readPage(q(req, 'path')))))
app.put('/api/page', wrap(async (req, res) => {
  const { path: p, baseHash, blocks, frontmatter, frontmatterRaw } = req.body || {}
  res.json(await store.writePage(p, { blocks, frontmatter, frontmatterRaw }, baseHash))
}))
app.put('/api/layout', wrap(async (req, res) => {
  const { path: p, baseLayoutHash, layout } = req.body || {}
  res.json(await store.writeLayout(p, layout, baseLayoutHash))
}))
app.post('/api/notebook', wrap(async (req, res) => res.json(await store.createNotebook(req.body?.name))))
app.post('/api/section', wrap(async (req, res) => res.json(await store.createSection(req.body?.notebook, req.body?.name))))
app.post('/api/page', wrap(async (req, res) => {
  const { dir, parent, title } = req.body || {}
  const target = parent ? store.pageBase(store.safeRel(parent)) : dir
  res.json(await store.createPage(target, title))
}))
app.post('/api/rename', wrap(async (req, res) => res.json(await store.rename(req.body?.path, req.body?.name))))
app.post('/api/trash', wrap(async (req, res) => res.json(await store.trash(req.body?.path))))
app.post('/api/reorder', wrap(async (req, res) => res.json(await store.reorder(req.body?.dir, req.body?.order))))
app.post('/api/color', wrap(async (req, res) => res.json(await store.setColor(req.body?.dir, req.body?.color ?? null))))
app.get('/api/meta', wrap(async (req, res) => res.json(await store.readMeta(q(req, 'dir') || ''))))
app.post('/api/meta', wrap(async (req, res) => res.json(await store.setMeta(req.body?.dir ?? '', req.body?.patch))))
app.put('/api/frontmatter', wrap(async (req, res) => res.json(await store.patchFrontmatter(req.body?.path, req.body?.patch))))
app.post('/api/asset', wrap(async (req, res) => res.json(await store.saveAsset(q(req, 'page'), q(req, 'name'), req))))
app.post('/api/trash-asset', wrap(async (req, res) => res.json(await store.trashAsset(req.body?.page, req.body?.src))))
app.post('/api/reveal', wrap(async (req, res) => {
  if (!req.body?.path) throw new HttpError(400, 'path required')   // '' resolved to ROOT and revealed the whole notebook
  const p = store.absPathOf(req.body.path)
  try { await fs.access(p) } catch { throw new HttpError(404, 'no such file') }   // ENOENT leaked the absolute path in a 500
  store.openInShell(p, { reveal: true })   // Finder, or Explorer on a PC, where `open` did nothing (server/fs.js)
  res.json({ ok: true })
}))
// The last morning, for the Home screen's one line about it (SPEC §21.8: "keep them posted"): when, what came in, what
// was filed, what waits. From Hub/_runs.json, which scripts/run.mjs writes; a run still being decided is left out.
async function lastMorning() {
  try {
    const r = JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', '_runs.json'), 'utf8'))
    const m = [...(r.runs || [])].reverse().find(x => x.kind === 'morning' && x.endedAt && !x.phase)
    return m ? { at: m.endedAt, ok: m.ok !== false, fetched: m.fetched || null, totals: m.totals || null, waiting: m.waiting ?? null, reason: m.reason || null, note: m.note || null } : null
  } catch { return null }
}
// The academic hub, written by scripts/quercus-sync.mjs; the Home screen reads it, the button runs it.
// His own marks and target (Hub/_marks.json, SPEC §21.12) are applied on the way out, so a mark kept in the calculator
// moves the Home figure now, not at the next check.
app.get('/api/hub', wrap(async (req, res) => {
  try {
    const hub = JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', '_hub.json'), 'utf8')), marks = await readMarks(ROOT)
    hub.courses = (hub.courses || []).map(c => applyMarks(c, marks.courses[c.key]))
    // and the weeks he flagged for review (SPEC §21.13), which the test rows of src/todo.js read as `hub.review`
    res.json({ ...hub, review: (await readReview(ROOT)).courses, edition: EDITION, cadenceDays: CADENCE_DAYS, runner: RUNNER, lastRun: await lastMorning() })
  } catch { res.status(404).json({ error: 'Quercus has not been checked yet — press Check Quercus on Home', edition: EDITION, cadenceDays: CADENCE_DAYS }) }
}))
// Sync now = what the morning task does: a headless Claude session follows scripts/sync-prompt.md
// (the deterministic script, then the quercus skill's sweep, then a morning note). It takes a few
// minutes, so it runs in the background and the Home screen polls /api/sync/status.
let syncJob = null, loggedTools = false
// From the button the same prompt runs with the three connector steps skipped (sweep, calendar, email — SPEC §20.11) and a
// hundred turns; the 07:10 cron runs all twelve. SLATE_CAL_MAX_WRITES stays unset here: the calendar never runs from the button.
const BUTTON_NOTE = 'This run comes from the Sync button: skip steps 2, 9 and 11 of the prompt (sweep, calendar, email).'
// With Claude as the brain (SPEC §20.37) the button runs scripts/brain-prompt.md; the fetch has already run above.
const BRAIN_BUTTON_NOTE = 'This run comes from the Sync button, and the Quercus fetch has just run: in step 1 skip quercus-sync.mjs and run only textbook.mjs --json, pdf-text.mjs and transcribe.mjs; skip every step marked "cron only" (the sweep, the calendar, the email); start the run with --note "sync button".'
app.post('/api/sync', (req, res) => {
  if (syncJob?.running) return res.json({ started: false, running: true })
  syncJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, phase: 'script', output: '', summary: null, note: null }
  const finish = (ok, note) => { syncJob.running = false; syncJob.ok = ok; syncJob.note = note || syncJob.note; syncJob.finishedAt = new Date().toISOString() }
  // The light budget (SPEC §21): scripts/run.mjs fetches, proposes, and runs Sonnet one course at a time with a turn cap —
  // the same routine the launchd job runs at its hour. Its lines are the button's progress; its last line is the summary.
  if (BUDGET === 'light') {
    syncJob.phase = 'run'
    const child = spawn(process.execPath, [path.join(repo, 'scripts', 'run.mjs'), 'morning', '--from', 'button'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let last = ''
    child.stdout.on('data', d => { syncJob.output += d; const lines = String(d).trim().split('\n'); last = lines[lines.length - 1] || last })
    child.stderr.on('data', d => { syncJob.output += d })
    child.on('error', e => finish(false, `The check could not start: ${e.message}`))
    child.on('close', code => {
      try { syncJob.summary = JSON.parse(last) } catch { }
      const s = syncJob.summary
      if (code === 0 && s?.ok !== false) return finish(true, s?.note || null)
      finish(false, s?.note || syncJob.output.trim().split('\n').slice(-2).join(' '))
    })
    return res.json({ started: true })
  }
  // 1. The deterministic pass: always, fast, no Claude needed.
  execFile(process.execPath, [path.join(repo, 'scripts', 'quercus-sync.mjs'), '--json'], { env, cwd: repo, timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) { syncJob.output += stderr || err.message; return finish(false, 'The Quercus script failed: ' + (stderr || err.message).trim().split('\n').pop()) }
    try { syncJob.summary = JSON.parse(stdout.trim().split('\n').pop()) } catch { }
    // 2. The Claude pass. With Claude as the brain (SPEC §20.37) it is scripts/brain-prompt.md — every placement and task
    // decided, heavy on purpose, read by one pass — or, in team mode (SPEC §24), scripts/brain/coordinator.md, which hands
    // each course to an agent of its own and needs the Agent tool; else the flagging pass of scripts/sync-prompt.md.
    syncJob.phase = 'claude'
    let brainOn = false, model = null, team = false
    try { const s = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'Hub', '_settings.json'), 'utf8')); brainOn = !!s.brain; model = s.model || null; team = s.brainMode === 'team' } catch { }
    const prompt = fsSync.readFileSync(path.join(repo, 'scripts', brainOn ? (team ? 'brain/coordinator.md' : 'brain-prompt.md') : 'sync-prompt.md'), 'utf8')
    // The brain runs on the model the settings name, Opus unless they say otherwise (SPEC §22.7): `brain.mjs settings --model`.
    // At effort xhigh (SPEC §24.5): the first live team run went at the scheduled default, medium, and skimmed; the team's
    // own agents carry xhigh in .claude/agents/, and from the button the coordinator does too.
    const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', brainOn ? '400' : '100', ...(brainOn ? ['--model', model || 'opus', '--effort', 'xhigh'] : []), '--append-system-prompt', brainOn ? BRAIN_BUTTON_NOTE : BUTTON_NOTE, '--add-dir', ROOT, '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', ...(brainOn && team ? ['Agent'] : [])], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    // stream-json: one JSON per line. The assistant's words and the final result go to the output Home shows; the
    // system/init line names the tools the child can see, logged once so a missing connector is visible in the server log.
    let buf = ''
    const onLine = line => {
      let ev = null
      try { ev = JSON.parse(line) } catch { syncJob.output += line + '\n'; return }
      if (ev.type === 'system' && ev.subtype === 'init') { if (!loggedTools) { loggedTools = true; console.log('[sync] claude tools:', (ev.tools || []).map(t => (typeof t === 'string' ? t : t?.name)).join(' ')) } return }
      if (ev.type === 'assistant') { for (const c of ev.message?.content || []) if (c.type === 'text' && c.text) syncJob.output += c.text + '\n' }
      else if (ev.type === 'result') { if (ev.is_error && ev.result) syncJob.output += ev.result + '\n'; else if (ev.subtype && ev.subtype !== 'success') syncJob.output += `[${ev.subtype}]\n` }
    }
    child.stdout.on('data', d => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) onLine(l) })
    child.stderr.on('data', d => { syncJob.output += d })
    child.on('error', e => finish(false, `Quercus data synced, but Claude could not run: ${e.message}`))
    child.on('close', code => {
      if (buf.trim()) onLine(buf)
      if (code === 0) return finish(true)
      const out = syncJob.output
      finish(false, /OAuth|authenticate|expired/i.test(out) ? 'Quercus data synced. The Claude pass (sweep + morning note) needs a login: run `claude login` in a terminal once, then sync again.' : 'Quercus data synced, but the Claude pass failed: ' + out.trim().split('\n').slice(-2).join(' '))
    })
  })
  res.json({ started: true })
})
app.get('/api/sync/status', (req, res) => res.json(syncJob ? { ...syncJob, output: syncJob.output.slice(-4000) } : { running: false }))

// ---- transcription (SPEC 18.3, from anywhere §20.36) --------------------------------------------------------------
// One recording at a time — Parakeet has the M4 GPU to itself and runs at roughly 12x real time, so an hour of lecture is
// a few minutes — but any number can be asked for: a page joins the queue and is transcribed in its turn. It used to
// refuse a second request outright, so filing three recordings meant coming back three times. The page's player, Add
// files, the week's recordings and the Library all ask the same way (src/transcribe.js) and poll the same status: the
// page running, the pages waiting, and how the last run of each page ended.
let sttJob = null
const sttQueue = [], sttDone = new Map()
const sttNext = () => {
  if (sttJob?.running || !sttQueue.length) return
  const { page, engine } = sttQueue.shift()
  const job = sttJob = { running: true, page, startedAt: new Date().toISOString(), finishedAt: null, ok: null, output: '', note: null }
  const args = [path.join(repo, 'scripts', 'transcribe.mjs'), '--page', page]
  if (engine) args.push('--engine', engine)
  let child
  try { child = spawn(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
  catch (e) { Object.assign(job, { running: false, ok: false, note: e.message, finishedAt: new Date().toISOString() }); sttDone.set(page, { ok: false, note: e.message, finishedAt: job.finishedAt }); return sttNext() }
  let ended = false
  const end = (ok, note) => {
    if (ended) return; ended = true
    Object.assign(job, { running: false, ok, note, finishedAt: new Date().toISOString() })
    sttDone.delete(page); sttDone.set(page, { ok, note, finishedAt: job.finishedAt })
    if (sttDone.size > 50) sttDone.delete(sttDone.keys().next().value)
    sttNext()
  }
  child.stdout.on('data', d => { job.output += d })
  child.stderr.on('data', d => { job.output += d })
  child.on('error', e => end(false, e.message))
  child.on('close', code => {
    // "Nothing to transcribe." is a success: the recording already has its words.
    const ok = code === 0 && (/✓/.test(job.output) || /Nothing to transcribe/.test(job.output))
    end(ok, ok ? null : (/not found|ENOENT/i.test(job.output)
      ? 'The transcriber is not installed: run `uv tool install parakeet-mlx` once.'
      : job.output.trim().split('\n').slice(-2).join(' ') || `exited ${code}`))
  })
}
// → { started, queued, page, ahead }: `ahead` is how many recordings run before this one.
app.post('/api/transcribe', (req, res) => {
  if (!SPEECH) return res.status(409).json({ error: SPEECH_NOTE })
  let page = req.body?.page
  if (!page || typeof page !== 'string') return res.status(400).json({ error: 'page required' })
  try { page = store.safeRel(page); if (!page.endsWith('.md')) throw new Error('not a page') } catch { return res.status(400).json({ error: 'page must be a page path' }) }
  if (sttJob?.running && sttJob.page === page) return res.json({ started: true, queued: false, page, ahead: 0 })
  const waiting = sttQueue.findIndex(q => q.page === page)
  if (waiting >= 0) return res.json({ started: false, queued: true, page, ahead: waiting + (sttJob?.running ? 1 : 0) })
  sttQueue.push({ page, engine: req.body?.engine || null })
  const ahead = sttJob?.running ? sttQueue.length : 0
  sttNext()
  res.json({ started: ahead === 0, queued: ahead > 0, page, ahead })
})
app.get('/api/transcribe/status', (req, res) => res.json({
  ...(sttJob ? { ...sttJob, output: sttJob.output.slice(-2000) } : { running: false }),
  queue: sttQueue.map(q => q.page),
  done: Object.fromEntries(sttDone),
}))

// ---- study sheets: the queue and the student's confirmations (SPEC 18.2, 18.6) -------------------------
const queuePath = () => path.join(ROOT, 'Hub', '_study-queue.json')
const confirmPath = () => path.join(ROOT, 'Hub', '_study-confirm.json')
const readJsonFile = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
app.get('/api/study/queue', wrap(async (req, res) => res.json(await readJsonFile(queuePath(), { ready: [], blocked: [] }))))
app.post('/api/study/confirm', wrap(async (req, res) => {
  const { key, confirmed = true } = req.body || {}
  if (!key) return res.status(400).json({ error: 'key required' })
  const all = await readJsonFile(confirmPath(), {})
  if (confirmed) all[key] = { confirmedAt: new Date().toISOString(), by: 'app' }
  else delete all[key]
  // Atomic, like every other Hub file: the 07:00 run and the 10:00 build rewrite the queue while a click can land.
  await store.atomicWrite(confirmPath(), JSON.stringify(all, null, 2) + '\n')
  // keep the queue the Home screen is reading in step with the click
  const q = await readJsonFile(queuePath(), null)
  if (q?.ready) { for (const r of q.ready) if (r.key === key) r.confirmed = all[key]?.confirmedAt || null
    q.confirmed = q.ready.filter(r => r.confirmed).length
    await store.atomicWrite(queuePath(), JSON.stringify(q, null, 2) + '\n') }
  res.json({ ok: true, key, confirmed: all[key]?.confirmedAt || null })
}))
// ---- the route modules (SPEC §20.1): after the routes above, before /api/events, the static mounts and the error
// handler (ask streams its own response). /api/search and /api/titles live in routes/search.js once the search group
// lands it; until then the in-memory index answers them here.
const routesLoaded = await registerRoutes()
if (!routesLoaded.has('search')) {
  app.get('/api/search', (req, res) => res.json(search.search(q(req, 'q') || '', Number(q(req, 'limit')) || 50)))
  app.get('/api/titles', (req, res) => res.json(search.titles()))
}
app.get('/api/events', (req, res) => watch.subscribe(res))
app.post('/api/snapshot', wrap(async (req, res) => res.json(await git.snapshot())))

// The built client (`vite build` → dist/), so the desktop app and `node server/index.js` alone serve the app.
app.use(express.static(path.join(repo, 'dist')))
// Raw files (images, media, PDFs) straight from the notes root.
app.use('/files', express.static(ROOT, { dotfiles: 'deny', index: false, fallthrough: true, setHeaders: r => r.setHeader('Cache-Control', 'no-cache') }))

// Unknown /api/* is JSON, not Express's HTML page: a client calling res.json() on it got a parse error
// instead of the message (SPEC §20.20).
app.use('/api', (req, res) => res.status(404).json({ error: `no such route: ${req.method} ${req.path}` }))

const FS_STATUS = { ENOENT: 404, ENOTDIR: 404, EISDIR: 400, ENAMETOOLONG: 400, EEXIST: 409, EACCES: 403, EPERM: 403 }
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) })
  // body-parser already decided (400 on malformed JSON, 413 on an oversized body); it was being turned into a 500.
  const errno = typeof err?.code === 'string' ? err.code : null   // git failures carry a numeric code; those are not errnos
  const status = FS_STATUS[errno] || err?.status || err?.statusCode || 500
  if (status >= 500) console.error(err)
  // Never hand the client an absolute path: `ENOENT: … open '/Users/…/Notebooks/…'` is a filesystem map.
  const message = errno && FS_STATUS[errno] ? `${errno}: ${({ ENOENT: 'no such file', ENOTDIR: 'not a folder', EISDIR: 'that is a folder', ENAMETOOLONG: 'name too long', EEXIST: 'already exists', EACCES: 'permission denied', EPERM: 'permission denied' })[err.code] || 'filesystem error'}`
    : String(err?.message || 'server error').split(ROOT).join('<notes>')
  res.status(status).json({ error: message })
})

async function boot() {
  await store.ensureRoot()
  // The contract file is owned by the app: rewrite it when the app's version is newer, leave
  // hand-written files (no marker) alone.
  const claudeMd = path.join(ROOT, 'CLAUDE.md')
  let existing = null
  try { existing = await fs.readFile(claudeMd, 'utf8') } catch { }
  const m = existing && /<!-- slate:contract v(\d+)/.exec(existing)
  const v1Header = existing?.startsWith('# Notebooks — how to read and write these notes')   // v1 had no marker
  const version = m ? Number(m[1]) : v1Header ? 1 : null                                       // null = not ours
  if (existing === null || (version !== null && version < CONTRACT_VERSION)) { await fs.writeFile(claudeMd, CLAUDE_MD); console.log('[boot] wrote', claudeMd) }
  await git.ensureRepo()
  git.schedule(5)
  const n = await search.build()
  watch.start()
  app.listen(PORT, '127.0.0.1', () => console.log(`[slate] api on http://127.0.0.1:${PORT}  root=${ROOT}  indexed=${n}`))
  // The document index (SPEC §20.6) builds in the background, serially, never before the port opens.
  const docIndex = await import('./doc-index.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e })
  if (docIndex?.start) docIndex.start()
}
// Inside Slate.app, desktop/main.cjs imports this file from Electron's main process, and its import resolved before boot
// failed — so exiting here killed the app before main.cjs could show why (a Documents folder Windows' Controlled Folder
// Access refuses, a full disk): a double-click that did nothing. There the failure is main.cjs's to show (`await ready`);
// under plain Node, as before, it is printed and the process exits.
export const ready = boot()
ready.catch(e => { console.error(e); if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) process.exit(1) })
