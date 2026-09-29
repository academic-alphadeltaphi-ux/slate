#!/usr/bin/env node
// The routine (SPEC §21): what the launchd job runs at its hour, what the Check Quercus button runs, and what the last
// step of setup runs. Built for a Claude Pro plan: the fetch and every proposal are code; Claude — Sonnet, one course at
// a time, a turn cap and a dollar cap per session — only confirms, corrects and writes the tasks. The morning note is
// written here from what happened, so no session is spent on prose.
//
//   node scripts/run.mjs morning [--from launchd|button|setup|manual] [--scheduled] [--no-claude] [--courses KEY,KEY]
//                                [--model sonnet] [--max-turns 40] [--max-usd 1.50] [--root <notes root>] [--json]
//   node scripts/run.mjs review  [--from …] [--scheduled] [--no-claude] [--model …] [--json]
//   node scripts/run.mjs status  [--json]
//
// --scheduled asks Hub/_runs.json whether a run is due (the install's cadence) and exits 0 with "not due" when not.
// The last stdout line is always one JSON object: { ok, kind, reason, courses: [...], cost, note, waiting, … }.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { guardFlags } from './lib/argv.mjs'
import { notesRoot } from './lib/root.mjs'
import { WIN, childPath, findClaude, notify as osNotify, spawnable } from './lib/platform.mjs'

guardFlags(['--from', '--scheduled', '--no-claude', '--courses', '--model', '--max-turns', '--max-usd', '--root', '--json', '--quiet'],
  'node scripts/run.mjs morning|review|status [--from launchd|button|setup|manual] [--scheduled] [--no-claude] [--courses KEY,KEY] [--model sonnet] [--max-turns N] [--max-usd X] [--root <notes root>] [--json]')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = notesRoot(process.argv)
process.env.SLATE_ROOT = ROOT           // before anything imports server/fs.js, which fixes its ROOT at import time
const { THIS, editionOf } = await import('../src/edition.js')
const { COURSES, todayIso, localStamp, isClassDay, weekFor } = await import('./lib/terms.mjs')
const { readSettings, readBrain } = await import('./lib/brain.mjs')
const { readJson, writeAtomic } = await import('./lib/problems.mjs')
const { courseBriefs, linkGate } = await import('./lib/brief.mjs')
const { meetingId } = await import('../src/calendar.js')
const { hasDevTools } = await import('../server/devtools.js')

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const cmd = args.find(a => !a.startsWith('--') && !['--from', '--courses', '--model', '--max-turns', '--max-usd', '--root'].includes(args[args.indexOf(a) - 1]))
// SLATE_NO_CLAUDE=1 is the brother simulation's way of running the whole routine without spending a session.
const FROM = opt('--from', 'manual'), SCHEDULED = args.includes('--scheduled'), NO_CLAUDE = args.includes('--no-claude') || process.env.SLATE_NO_CLAUDE === '1', JSON_OUT = args.includes('--json')
const HUB = path.join(ROOT, 'Hub'), RUNS = path.join(HUB, '_runs.json'), LOCK = path.join(HUB, '_runs.lock')
const settings = await readSettings(ROOT)
const ED = editionOf(settings.edition || THIS.key)
const MODEL = opt('--model', settings.model || ED.model || 'sonnet')
// The dollar caps are Sonnet's, times the edition's price scale (a Max copy on Fable: five); a settings.maxUsd is absolute.
const SCALE = Number(settings.costScale) > 0 ? Number(settings.costScale) : ED.costScale || 1
const MAX_TURNS = Number(opt('--max-turns', settings.maxTurns || 40)), MAX_USD = Number(opt('--max-usd', settings.maxUsd || 1.5 * SCALE))
const CADENCE = Number(settings.cadenceDays) >= 1 ? Number(settings.cadenceDays) : ED.cadenceDays || 1
// Who decides (SPEC §21.8): 'cli' spawns claude -p per course below; 'app' means the session calling fetch/brief/finish decides.
const RUNNER = settings.runner || ED.runner || 'cli'
// A plan that has not got the edition's model: Sonnet decides instead, from now on, and the settings say why. Temp then
// rename: a plain write cut short by a kill left the file truncated, which reads as {} — the brain silently off.
const rememberModel = async (model, note) => { try { const sf = path.join(HUB, '_settings.json'); const s = JSON.parse(await fsp.readFile(sf, 'utf8')); await writeAtomic(sf, JSON.stringify({ ...s, model, modelNote: note }, null, 2) + '\n') } catch { } }
const ENV = { ...process.env, SLATE_ROOT: ROOT, PATH: childPath() }
// A Claude session started from inside another one refuses to nest unless these are gone (the simulation runs from one).
delete ENV.CLAUDECODE; delete ENV.CLAUDE_CODE_ENTRYPOINT; delete ENV.CLAUDE_CODE_SSE_PORT
// The CLI keeps its login under the real home folder; the brother simulation fakes HOME for everything else and names
// the real one here so the sessions it measures are logged in.
const CLAUDE_ENV = process.env.SLATE_CLAUDE_HOME ? { ...ENV, HOME: process.env.SLATE_CLAUDE_HOME } : { ...ENV }
// Without the developer tools, `git` is Apple's install dialog — and the CLI runs git by itself in every session. A git
// that is not git goes first on the session's PATH (bin/no-git), so the call fails quietly (SPEC §21.5).
if (!WIN && !hasDevTools()) CLAUDE_ENV.PATH = [path.join(REPO, 'bin', 'no-git'), CLAUDE_ENV.PATH || ''].join(path.delimiter)
const t0 = Date.now()
const say = s => { if (!args.includes('--quiet')) console.log(s) }
// On a Mac a pipe takes stdout asynchronously, so process.exit() straight after a write cuts it at 64 KiB — and a first
// run's brief, read by the Claude session through a pipe, is larger. The exit waits for the write to drain.
const emit = (s, code = 0) => { process.stdout.write(s + '\n', () => process.exit(code)) }
const finish = obj => emit(JSON.stringify(obj), obj.ok === false && obj.reason !== 'not-due' ? 1 : 0)

// ---- helpers ------------------------------------------------------------------------------------------------------
const node = (script, a = [], { timeout = 600_000 } = {}) => new Promise(resolve => {
  execFile(process.execPath, [path.join(REPO, 'scripts', script), ...a], { cwd: REPO, env: ENV, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    let last = null; try { last = JSON.parse(String(stdout || '').trim().split('\n').pop()) } catch { }
    resolve({ ok: !err, code: err?.code ?? 0, killed: !!err?.killed, stdout: String(stdout || ''), stderr: String(stderr || ''), last })
  })
})
const runsRead = async () => (await readJson(RUNS, { runs: [] })) || { runs: [] }
const runsWrite = async r => writeAtomic(RUNS, JSON.stringify({ ...r, runs: r.runs.slice(-80) }, null, 2) + '\n')
// A run's record into Hub/_runs.json: read, replace, rewrite. `finish` holds no run lock (its fetch has exited), so the
// rewrite has a small lock of its own and never drops a record another run wrote a moment before (review 2026-09-29).
async function saveRun(rec) {
  const lock = path.join(HUB, '.tmp-runs.lock')
  await fsp.mkdir(HUB, { recursive: true })
  for (let i = 0; ; i++) {
    try { await fsp.writeFile(lock, String(process.pid), { flag: 'wx' }); break }
    catch (e) { if (e.code !== 'EEXIST') throw e; const st = await fsp.stat(lock).catch(() => null); if (!st || Date.now() - st.mtimeMs > 30_000 || i >= 100) await fsp.rm(lock, { force: true }); else await new Promise(r => setTimeout(r, 100)) }
  }
  try { const r = await runsRead(); r.runs = r.runs.filter(x => x.id !== rec.id); r.runs.push(rec); await runsWrite(r) }
  finally { await fsp.rm(lock, { force: true }).catch(() => { }) }
}
const lastOf = (r, kind) => [...r.runs].reverse().find(x => x.kind === kind && x.ok !== false) || null
// SLATE_CLAUDE_BIN names another command line tool (the scenarios' stand-in; server/routes/day.js honours it too).
const claudeBin = () => findClaude()   // SLATE_CLAUDE_BIN: set but missing means not installed (the scenarios)
const NO_CLI = 'Claude Code\'s command line tool is not installed on this computer (setup step "claude" installs it).'
const NO_LOGIN = `Claude Code is not logged in: open ${WIN ? 'PowerShell' : 'Terminal'}, type \`claude\`, press ${WIN ? 'Enter' : 'Return'}, choose "Claude account with subscription" and log in once.`
async function claudeStatus() {
  const bin = claudeBin(); if (!bin) return { installed: false, loggedIn: false, bin: null }
  const s = spawnable(bin, ['auth', 'status', '--json'])   // claude.cmd on a PC: node will not start a .cmd without a shell (platform.mjs)
  const r = await new Promise(resolve => execFile(s.file, s.args, { env: CLAUDE_ENV, timeout: 20_000, windowsHide: true, ...s.opts }, (e, so) => resolve({ e, so: String(so || '') })))
  let j = null; try { j = JSON.parse(r.so.trim()) } catch { }
  return { installed: true, loggedIn: !!j?.loggedIn, bin, method: j?.authMethod || null }
}
const notify = (text, title = ED.short || ED.name) => { if (FROM !== 'launchd' && FROM !== 'schtasks') return; osNotify(text, title) }
const nice = iso => new Date(iso).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })
const hours = ms => Math.round(ms / 36e5 * 10) / 10

// One short Claude session for one course: the light prompt plus the brief, Sonnet, capped. → what it did and what it cost.
// `ask`: another prompt in its place, with the same tools and caps (the link gate's, below).
async function claudeSession(brief, bin, model = MODEL, ask = null) {
  const prompt = ask ?? (await fsp.readFile(path.join(REPO, 'scripts', 'light-prompt.md'), 'utf8')) + '\n\n## The brief\n\n```json\n' + JSON.stringify(brief, null, 1) + '\n```\n'
  const sys = `Notes root: ${ROOT}. Repo: ${REPO} (the working directory). SLATE_ROOT is set, so no --root flag is needed. Today is ${brief.today}.`
  // The caps grow with the brief: a first run can put forty items in one course, and a session ends with a turn per
  // command. Forty turns and a dollar and a half are the floor; a big brief gets two turns and four cents an item more.
  const items = (brief.waiting || []).length + (brief.reviews || []).length
  const turns = Math.min(160, Math.max(MAX_TURNS, 12 + 2 * items)), usd = Math.min(4 * SCALE, Math.max(MAX_USD, (0.5 + 0.04 * items) * SCALE))
  const cliArgs = ['-p', '--model', model, '--max-turns', String(turns), '--max-budget-usd', String(usd), '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project', '--add-dir', ROOT,
    // the repo's quercus skill (.claude/skills, loaded by --setting-sources project) and the one command it reads Quercus with
    '--allowedTools', 'Bash(node scripts/brain.mjs:*)', 'Bash(node scripts/problems.mjs:*)', 'Bash(node scripts/quercus-sweep.mjs:*)', 'Bash(echo:*)', 'Read', 'Skill',
    '--disallowedTools', 'WebSearch', 'WebFetch', 'Write', 'Edit', 'Agent', 'NotebookEdit',
    '--append-system-prompt', sys]
  return new Promise(resolve => {
    const started = Date.now()
    const s = spawnable(bin, cliArgs), child = spawn(s.file, s.args, { cwd: REPO, env: CLAUDE_ENV, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...s.opts })
    let out = '', err = '', done = false
    const end = r => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, ms: Date.now() - started }) }
    const limitMs = Number(process.env.SLATE_SESSION_TIMEOUT_MS) || 15 * 60_000   // the scenarios shorten it to catch a hang in seconds
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { } end({ ok: false, reason: 'timeout', text: `the session ran past ${Math.round(limitMs / 60000)} minutes and was stopped` }) }, limitMs)
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', e => end({ ok: false, reason: 'spawn', text: e.message }))
    child.on('close', code => {
      let j = null; try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null') } catch { }
      const text = String(j?.result || out || err).trim()
      const m = /DONE placed=(\d+) ignored=(\d+) linked=(\d+) tasks=(\d+) questions=(\d+)/.exec(text)
      const counts = m ? { placed: +m[1], ignored: +m[2], linked: +m[3], tasks: +m[4], questions: +m[5] } : null
      const base = { cost: j?.total_cost_usd ?? null, turns: j?.num_turns ?? null, usage: j?.usage || null, subtype: j?.subtype || null, text: text.slice(-600) }
      // the plan has not got this model (the CLI: "There's an issue with the selected model … you may not have access to it"): Sonnet, once and from now on.
      // The retry has its own fifteen minutes: this session's clock stops here, else it ran out under a long Sonnet retry,
      // the course was reported timed out while the retry still wrote, and the next course began beside it (review 2026-09-29).
      if (j?.is_error && model !== 'sonnet' && /issue with the selected model|not have access to it|unrecognized_model|no such model|unknown model/i.test(text + ' ' + err)) { clearTimeout(timer); return claudeSession(brief, bin, 'sonnet', ask).then(r => end({ ...r, fellBackFrom: model })) }
      if (/log ?in|authenticate|OAuth|not logged|expired token|Invalid API key/i.test(text) && (j?.is_error || code !== 0)) return end({ ...base, ok: false, reason: 'login' })
      if (/usage limit|rate limit|out of usage|limit reached|limit will reset|resets at/i.test(text) && (j?.is_error || code !== 0)) return end({ ...base, ok: false, reason: 'limit' })
      if (j?.subtype && /max_turns|max_budget/.test(j.subtype)) return end({ ...base, ok: false, reason: j.subtype.includes('budget') ? 'budget' : 'turns', counts })
      if (code !== 0 || j?.is_error) return end({ ...base, ok: false, reason: 'error' })
      end({ ...base, ok: true, reason: null, counts: counts || { placed: 0, ignored: 0, linked: 0, tasks: 0, questions: 0 }, parsed: !!m })
    })
    child.stdin.on('error', () => { }); child.stdin.end(prompt)
  })
}

// ---- the lock and the cadence -----------------------------------------------------------------------------------------
// Created exclusively: read-then-write let two runs started together (two Claude apps firing the same scheduled task, the
// button during the 07:10 run) both see no holder and both go on (review 2026-09-29). A holder that is gone, or a lock older
// than two hours, no longer counts; a lock with no holder written in it yet is one being taken this instant.
async function takeLock() {
  await fsp.mkdir(HUB, { recursive: true })
  for (let i = 0; i < 3; i++) {
    try { await fsp.writeFile(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), kind: cmd }), { flag: 'wx' }); return true }
    catch (e) { if (e.code !== 'EEXIST') throw e }
    const held = await readJson(LOCK, null)
    if (held?.pid && Date.now() - new Date(held.at).getTime() < 2 * 3600_000) { try { process.kill(held.pid, 0); return false } catch (e) { if (e.code === 'EPERM') return false } }
    else if (!held) { const st = await fsp.stat(LOCK).catch(() => null); if (st && Date.now() - st.mtimeMs < 10_000) return false }
    await fsp.rm(LOCK, { force: true })
  }
  return false
}
// Only this run's own lock: `finish` and a refused run hold none, and removing another run's let a third one in.
const dropLock = async () => { if ((await readJson(LOCK, null))?.pid === process.pid) await fsp.rm(LOCK, { force: true }).catch(() => { }) }
// A fetch the app runner's session is still deciding (SPEC §21.8) owns the morning until `finish`. Its process has exited,
// so its lock no longer says so: the button's `morning` ran a second sync and `run start` underneath it and took the run
// (review 2026-09-29). Two hours, like the lock: a session that died without `finish` does not hold the next day.
async function deciding() {
  const r = await runsRead()
  return [...r.runs].reverse().find(x => x.kind === 'morning' && x.phase === 'deciding' && Date.now() - new Date(x.startedAt).getTime() < 2 * 3600_000) || null
}
const decidingNote = d => `A check fetched at ${String(d.startedAt).slice(11, 16)} is still being decided (node scripts/run.mjs finish closes it); try again once it has finished.`
async function due(kind) {
  const last = lastOf(await runsRead(), kind)
  if (!last) return { due: true, since: null }
  const age = Date.now() - new Date(last.endedAt || last.startedAt).getTime()
  const need = (kind === 'review' ? 6 * 24 : CADENCE * 24 - 5) * 3600_000     // five hours of slack: 07:30 two days later counts
  return { due: age >= need, since: hours(age), last }
}

// Why the fetch failed, in the note's words — the same for `morning` and `fetch`. The stall of lib/net.mjs ("no data for
// 60 s from …") is the network too, and a sync the four-minute timeout stopped was waiting on one: it used to end on "The
// Quercus fetch failed: <whatever line came last>" (review 2026-09-29). → { reason, note, done } (done: brain.mjs's note)
function fetchFailure(f) {
  const out = f.stderr + f.stdout
  if (f.last?.reason === 'busy') return { reason: 'busy', note: 'Another Quercus check was already running, so this one stopped without changing anything; what it fetches shows when it finishes.', done: 'another sync was running' }
  if (/could not be reached|no data for \d+ s\b/i.test(out)) return { reason: 'network', note: 'Quercus could not be reached — no wifi? Nothing was changed; the next run will try again.', done: 'Quercus unreachable' }
  if (/401|Expired access token|No Quercus access key/i.test(out)) return { reason: 'token', note: 'Quercus refused the access key. Make a new one at q.utoronto.ca → Account → Settings → + New Access Token (expiry blank) and store it with `node scripts/setup.mjs token <key>`.', done: 'token refused' }
  if (f.killed) return { reason: 'network', note: 'The Quercus fetch ran past four minutes and was stopped — a slow or half-up network? What it had fetched is kept; the next run carries on.', done: 'fetch timed out' }
  return { reason: 'fetch', note: `The Quercus fetch failed: ${(f.stderr || f.stdout).trim().split('\n').pop()}`, done: 'fetch failed' }
}

// ---- the link gate (SPEC §21.11) ------------------------------------------------------------------------------------------
// Every to-do opens something. The brothers' came out with no button: the prompt asked for `link` and a session left it
// out. So a task this run wrote or changed that opens nothing — no link, the course's own Quercus page, a page that is not
// there — holds the morning open: `finish` refuses and prints, per task, the command that gives it the likeliest link, and
// the CLI road hands the same list to one more short session for that course (linkGate: scripts/lib/brief.mjs).
// how this run is closed: setup's first run through setup (which marks the step done), every other one with finish itself
const CLOSE = FROM === 'setup' ? 'node scripts/setup.mjs first-run --finish' : `node scripts/run.mjs finish --from ${FROM}`
const gateList = list => list.map(u => `  ${u.id} · ${u.course} · ${u.what} — ${u.problem}\n    ${u.command}`).join('\n')
const gateWords = list => `${list.length} open task(s) have no link that opens anything. A task is linked whenever its thing exists to open — the Quercus URL, else the slate page it concerns — so look hard; one with nothing online (a paper textbook, something in class, the student's own work) says so in its words instead (scripts/light-prompt.md). For each task below, run the command it gives — or the same with a better link — then run finish again:\n${gateList(list)}`
const gatePrompt = (code, list) => `You are finishing one short session of slate's morning check for ${code} (SPEC §21.11). A task is linked whenever its thing exists to open: the Quercus URL of the thing (an assignment, quiz, forum, page or file), else the slate page it concerns — "Every task has a link" in scripts/light-prompt.md says which for which. Look hard before giving up; a task with nothing online (a paper textbook, something in class, the student's own work) says so in its words instead. These open tasks have no link that opens anything:\n\n${gateList(list)}\n\nRun each command (several in one Bash call, joined with &&), or the same command with a better link when you know the thing's own: a URL, or a page path from the notes root that exists. A command that is refused says what is wrong: fix that and run it again. Run nothing else. Then reply with exactly one line: DONE placed=0 ignored=0 linked=0 tasks=0 questions=0`

// ---- morning ---------------------------------------------------------------------------------------------------------
async function morning() {
  if (SCHEDULED) { const d = await due('morning'); if (!d.due) { say(`not due: the last morning ran ${d.since} h ago, the cadence is ${CADENCE} day(s)`); return finish({ ok: true, kind: 'morning', reason: 'not-due', since: d.since, ran: false }) } }
  if (!(await takeLock())) return finish({ ok: false, kind: 'morning', reason: 'running', note: 'A run is already in progress.' })
  { const d = await deciding(); if (d) { await dropLock(); return finish({ ok: false, kind: 'morning', reason: 'running', note: decidingNote(d) }) } }
  const rec = { id: 'run-' + Date.now().toString(36), kind: 'morning', from: FROM, startedAt: localStamp(), model: MODEL, courses: [], cost: 0, fetched: null, steps: {} }
  const record = async (patch = {}) => { Object.assign(rec, patch, { endedAt: localStamp() }); await saveRun(rec) }
  try {
    await node('brain.mjs', ['run', 'start', '--note', `morning (${FROM}, light)`])
    // 1. the fetch (code, no Claude)
    say('Fetching Quercus…')
    const f = await node('quercus-sync.mjs', ['--json'], { timeout: 240_000 })
    rec.fetched = f.last || null
    if (!f.ok) {
      const { reason, note, done } = fetchFailure(f)
      await node('brain.mjs', ['run', 'done', '--note', done])
      await record({ ok: false, reason, note })
      notify(note); await dropLock()
      return finish({ ok: false, kind: 'morning', reason, note })
    }
    say(`Fetched: ${f.last ? `${f.last.newFiles ?? 0} file(s), ${f.last.newAnnouncements ?? 0} announcement(s), ${f.last.newPages ?? 0} page(s), ${f.last.waiting ?? 0} waiting` : 'done'}`)
    // 2. the words to read: the week's textbook pages where a notebook holds its book, PDF text always; transcripts only
    // where the transcriber is installed
    rec.steps.textbook = (await node('textbook.mjs', ['--json'], { timeout: 600_000 })).ok
    rec.steps.pdfText = (await node('pdf-text.mjs', ['--json'], { timeout: 600_000 })).ok
    if (!WIN && fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'parakeet-mlx'))) { say('Transcribing recordings…'); rec.steps.transcribe = (await node('transcribe.mjs', [], { timeout: 45 * 60_000 })).ok }
    // 3. the briefs, and one short session per course
    const only = opt('--courses') ? new Set(opt('--courses').split(',').map(s => s.trim())) : null
    const briefs = (await courseBriefs(ROOT)).filter(b => !only || only.has(b.course.key) || only.has(b.course.code))
    say(`${briefs.length} course(s) with something to decide: ${briefs.map(b => `${b.course.code} (${b.waiting.length} waiting, ${b.reviews.length} to read)`).join(', ') || 'none'}`)
    let stopped = null
    if (briefs.length && !NO_CLAUDE && RUNNER !== 'app') {
      const cs = await claudeStatus()
      if (!cs.installed) stopped = { reason: 'no-cli', note: NO_CLI }
      else if (!cs.loggedIn) stopped = { reason: 'login', note: NO_LOGIN }
      let activeModel = MODEL   // Sonnet for the rest of this run once the plan has refused the edition's model
      for (const b of briefs) {
        if (stopped) { rec.courses.push({ key: b.course.key, code: b.course.code, waiting: b.waiting.length, reviews: b.reviews.length, skipped: stopped.reason }); continue }
        say(`${b.course.code}: asking Claude (${activeModel}, ${b.waiting.length + b.reviews.length} item(s), up to ${Math.min(160, Math.max(MAX_TURNS, 12 + 2 * (b.waiting.length + b.reviews.length)))} turns)…`)
        const r = await claudeSession(b, cs.bin, activeModel)
        if (r.fellBackFrom && !rec.modelFallback) { rec.modelFallback = r.fellBackFrom; activeModel = 'sonnet'; say(`  ${r.fellBackFrom} is not available on this plan: Sonnet decided instead, and will from now on`); await rememberModel('sonnet', `${r.fellBackFrom} is not available on this plan (${localStamp()})`) }
        rec.courses.push({ key: b.course.key, code: b.course.code, waiting: b.waiting.length, reviews: b.reviews.length, ok: r.ok, reason: r.reason, model: r.fellBackFrom ? 'sonnet' : activeModel, counts: r.counts || null, cost: r.cost, turns: r.turns, ms: r.ms, usage: r.usage ? { in: r.usage.input_tokens, cacheWrite: r.usage.cache_creation_input_tokens, cacheRead: r.usage.cache_read_input_tokens, out: r.usage.output_tokens } : null, tail: r.ok ? null : r.text })
        rec.cost += r.cost || 0
        say(`  ${r.ok ? 'done' : r.reason}: ${r.counts ? `placed ${r.counts.placed}, ignored ${r.counts.ignored}, linked ${r.counts.linked}, tasks ${r.counts.tasks}, questions ${r.counts.questions}` : ''}${r.cost != null ? ` · $${r.cost.toFixed(2)}` : ''} · ${r.turns ?? '?'} turns · ${Math.round(r.ms / 1000)} s`)
        if (r.reason === 'login' || r.reason === 'limit') stopped = { reason: r.reason, note: r.reason === 'login' ? NO_LOGIN : 'Claude\'s usage limit was reached; the rest waits for the next run (or press Check Quercus once it resets).' }
      }
      // the link gate, as `finish` holds it on the app runner: one short session more per course that left a task opening nothing
      const open = await linkGate(ROOT, await readBrain(ROOT), rec.startedAt)
      for (const code of [...new Set(open.map(u => u.course))]) {
        if (stopped) break
        const list = open.filter(u => u.course === code), c = rec.courses.find(x => x.code === code)
        say(`${code}: ${list.length} task(s) with no link that opens — asking Claude to give each one…`)
        const r = await claudeSession({ today: todayIso(), waiting: [], reviews: [] }, cs.bin, activeModel, gatePrompt(code, list))
        rec.cost += r.cost || 0
        if (c) c.gate = { tasks: list.length, ok: r.ok, reason: r.reason, cost: r.cost, turns: r.turns }
        if (r.reason === 'login' || r.reason === 'limit') stopped = { reason: r.reason, note: r.reason === 'login' ? NO_LOGIN : 'Claude\'s usage limit was reached; the rest waits for the next run (or press Check Quercus once it resets).' }
      }
    } else if (briefs.length) { stopped = RUNNER === 'app' && !NO_CLAUDE ? { reason: 'waiting', note: `${briefs.length} course(s) have things waiting; the next scheduled check files them — or ask Claude to file what is waiting.` } : { reason: 'no-claude', note: 'Claude was not asked (--no-claude); everything is still waiting.' } }
    // what the gate's second sessions could not fix is named in the record, the note and the result — never passed over
    const unlinked = briefs.length ? await linkGate(ROOT, await readBrain(ROOT), rec.startedAt) : []
    if (unlinked.length) rec.unlinked = unlinked.map(u => ({ id: u.id, course: u.course, what: u.what, problem: u.problem }))
    // 4. write it through, and see what is still waiting — and what the pass ticked because it is already done (SPEC §20.69)
    const planRun = await node('plan.mjs', ['--json', '--pages'])
    rec.steps.plan = planRun.ok; rec.ticked = planRun.last?.autoTicked || []
    if (Object.values(COURSES).some(c => c.mirror)) rec.steps.mirror = (await node('mirror-course.mjs', ['--json'])).ok
    // handwriting is read by the Mac's own recogniser, as in `finish`: on Windows the step could only fail, every morning
    if (!WIN && ED.hwr !== false && fs.existsSync(path.join(REPO, 'scripts', 'hwr.mjs'))) rec.steps.hwr = (await node('hwr.mjs', ['--json'], { timeout: 300_000 })).ok
    const inbox = await node('brain.mjs', ['inbox', '--json'])
    const waiting = (inbox.last?.items || []).length
    const totals = rec.courses.reduce((a, c) => { for (const k of Object.keys(a)) a[k] += c.counts?.[k] || 0; return a }, { placed: 0, ignored: 0, linked: 0, tasks: 0, questions: 0 })
    const failedSteps = Object.entries(rec.steps).filter(([, ok]) => ok === false).map(([k]) => k)   // named, never folded into ok:true (review 2026-09-18)
    await node('brain.mjs', ['run', 'done', '--note', `${totals.placed} placed, ${totals.linked} linked, ${totals.tasks} tasks · ${waiting} waiting${unlinked.length ? ` · ${unlinked.length} without a link` : ''}${stopped ? ` · stopped: ${stopped.reason}` : ''}${failedSteps.length ? ` · failed: ${failedSteps.join(', ')}` : ''}`])
    // 5. the morning note, from what happened
    const note = await morningNote({ fetched: rec.fetched, totals, waiting, briefs, stopped, cost: rec.cost, ticked: rec.ticked, unlinked })
    await record({ ok: !stopped || ['no-claude', 'waiting'].includes(stopped.reason), reason: stopped?.reason || null, note: stopped?.note || null, waiting, totals, ms: Date.now() - t0 })
    const line = (stopped ? stopped.note : `${totals.placed} filed, ${totals.tasks} task(s) written, ${waiting} waiting${rec.cost ? ` · $${rec.cost.toFixed(2)}` : ''}`) + (unlinked.length ? ` · ${unlinked.length} without a link` : '') + (failedSteps.length ? ` · ${failedSteps.join(', ')} failed` : '')
    notify(line); await dropLock()
    return finish({ ok: !stopped || ['no-claude', 'waiting'].includes(stopped.reason), kind: 'morning', reason: stopped?.reason || null, note: stopped?.note || line, ran: true, modelFallback: rec.modelFallback || null, fetched: rec.fetched, courses: rec.courses, totals, waiting, unlinked: rec.unlinked || [], failed: failedSteps, cost: +rec.cost.toFixed(4), model: MODEL, ms: Date.now() - t0, morningNote: note })
  } catch (e) {
    await node('brain.mjs', ['run', 'done', '--note', 'failed: ' + e.message]).catch(() => { })
    await record({ ok: false, reason: 'error', note: e.message }).catch(() => { })
    await dropLock()
    return finish({ ok: false, kind: 'morning', reason: 'error', note: e.message })
  }
}

// ---- the app runner (SPEC §21.8): the morning in three commands, decided by the session that calls them --------------------
// A Pro brother has no command line tool: a scheduled task in the Claude app is the brain. `fetch` does what the morning
// does up to the briefs and leaves the run open; the session decides each course from `brief <CODE>` with brain.mjs;
// `finish` writes the plan and the note and closes the run. `morning` on this runner (the button) fetches and leaves
// everything waiting for the next check.
async function fetchPhase() {
  if (SCHEDULED) { const d = await due('morning'); if (!d.due) { say(`not due: the last morning ran ${d.since} h ago, the cadence is ${CADENCE} day(s)`); return finish({ ok: true, kind: 'fetch', reason: 'not-due', since: d.since, ran: false }) } }
  if (!(await takeLock())) return finish({ ok: false, kind: 'fetch', reason: 'running', note: 'A run is already in progress.' })
  { const d = await deciding(); if (d) { await dropLock(); return finish({ ok: false, kind: 'fetch', reason: 'running', note: decidingNote(d) }) } }
  const rec = { id: 'run-' + Date.now().toString(36), kind: 'morning', phase: 'deciding', from: FROM, startedAt: localStamp(), model: 'app', courses: [], cost: 0, fetched: null, steps: {} }
  const record = async (patch = {}) => { Object.assign(rec, patch); await saveRun(rec) }
  try {
    await node('brain.mjs', ['run', 'start', '--note', `morning (${FROM}, app)`])
    say('Fetching Quercus…')
    const f = await node('quercus-sync.mjs', ['--json'], { timeout: 240_000 })
    rec.fetched = f.last || null
    if (!f.ok) {
      const { reason, note, done } = fetchFailure(f)
      await node('brain.mjs', ['run', 'done', '--note', done])
      delete rec.phase; await record({ ok: false, reason, note, endedAt: localStamp() })
      notify(note); await dropLock()
      return finish({ ok: false, kind: 'fetch', reason, note })
    }
    say(`Fetched: ${f.last ? `${f.last.newFiles ?? 0} file(s), ${f.last.newAnnouncements ?? 0} announcement(s), ${f.last.newPages ?? 0} page(s)` : 'done'}`)
    rec.steps.textbook = (await node('textbook.mjs', ['--json'], { timeout: 600_000 })).ok
    rec.steps.pdfText = (await node('pdf-text.mjs', ['--json'], { timeout: 600_000 })).ok
    if (!WIN && fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'parakeet-mlx'))) { say('Transcribing recordings…'); rec.steps.transcribe = (await node('transcribe.mjs', [], { timeout: 45 * 60_000 })).ok }
    const briefs = await courseBriefs(ROOT)
    rec.courses = briefs.map(b => ({ key: b.course.key, code: b.course.code, waiting: b.waiting.length, reviews: b.reviews.length, why: b.why || null }))
    await record({})
    say(`${briefs.length} course(s) with something to decide: ${rec.courses.map(c => `${c.code} (${c.waiting} waiting, ${c.reviews} to read)`).join(', ') || 'none'}`)
    say(`Next: for each, node scripts/run.mjs brief <CODE>, decide it by scripts/light-prompt.md with node scripts/brain.mjs …, then ${CLOSE}`)
    await dropLock()   // the open record holds the morning from here (deciding, above), not this exiting process
    return finish({ ok: true, kind: 'fetch', ran: true, run: rec.id, fetched: rec.fetched, courses: rec.courses, note: `${briefs.length} course(s) to decide` })
  } catch (e) {
    await node('brain.mjs', ['run', 'done', '--note', 'failed: ' + e.message]).catch(() => { })
    delete rec.phase; await record({ ok: false, reason: 'error', note: e.message, endedAt: localStamp() }).catch(() => { })
    await dropLock()
    return finish({ ok: false, kind: 'fetch', reason: 'error', note: e.message })
  }
}
async function briefCmd() {
  const code = args[args.indexOf('brief') + 1]
  if (!code || code.startsWith('--')) return finish({ ok: false, kind: 'brief', reason: 'usage', note: 'node scripts/run.mjs brief <CODE>' })
  const b = (await courseBriefs(ROOT)).find(x => x.course.code === code || x.course.key === code)
  if (!b) { say(`${code}: nothing to decide`); return finish({ ok: true, kind: 'brief', course: { code }, waiting: [], reviews: [], needs: { classes: [], deadlines: [] }, note: 'nothing to decide' }) }
  return emit(JSON.stringify(b))
}
async function finishPhase() {
  const runs = await runsRead()
  const rec = [...runs.runs].reverse().find(x => x.kind === 'morning' && x.phase === 'deciding') || null
  if (!rec) return finish({ ok: false, kind: 'finish', reason: 'no-run', note: 'No fetch to finish: run node scripts/run.mjs fetch first.' })
  const record = async (patch = {}) => { Object.assign(rec, patch, { endedAt: localStamp() }); await saveRun(rec) }
  try {
    // what was decided since the fetch: the brain's own records, by time
    const brain = await readBrain(ROOT), since = rec.startedAt
    // the link gate: nothing is written and the run stays open (phase: deciding) until every task it wrote opens something
    const unlinked = await linkGate(ROOT, brain, since)
    if (unlinked.length) {
      const note = `${gateWords(unlinked)}\nThen: ${CLOSE}`
      say(note)
      return finish({ ok: false, kind: 'finish', reason: 'links', note, unlinked })
    }
    const dec = (brain.decisions || []).filter(d => d && d.at >= since && !d.undone)
    const totals = { placed: dec.filter(d => d.type === 'place').length, ignored: dec.filter(d => d.type === 'ignore').length, linked: dec.filter(d => d.type === 'link').length, tasks: Object.values(brain.tasks || {}).filter(t => t && !t.withdrawn && t.at >= since).length, questions: Object.values(brain.questions || {}).filter(q => q && q.at >= since).length }
    rec.steps = rec.steps || {}
    const planRun = await node('plan.mjs', ['--json', '--pages'])
    rec.steps.plan = planRun.ok; rec.ticked = planRun.last?.autoTicked || []
    if (Object.values(COURSES).some(c => c.mirror)) rec.steps.mirror = (await node('mirror-course.mjs', ['--json'])).ok
    if (!WIN && ED.hwr !== false && fs.existsSync(path.join(REPO, 'scripts', 'hwr.mjs'))) rec.steps.hwr = (await node('hwr.mjs', ['--json'], { timeout: 300_000 })).ok
    const inbox = await node('brain.mjs', ['inbox', '--json'])
    const waiting = (inbox.last?.items || []).length
    const failedSteps = Object.entries(rec.steps).filter(([, ok]) => ok === false).map(([k]) => k)
    await node('brain.mjs', ['run', 'done', '--note', `${totals.placed} placed, ${totals.linked} linked, ${totals.tasks} tasks · ${waiting} waiting${failedSteps.length ? ` · failed: ${failedSteps.join(', ')}` : ''}`])
    const note = await morningNote({ fetched: rec.fetched, totals, waiting, briefs: await courseBriefs(ROOT), stopped: null, cost: 0, ticked: rec.ticked })
    delete rec.phase
    await record({ ok: true, reason: null, note: null, waiting, totals, ms: Date.now() - new Date(rec.startedAt).getTime() })
    const line = `${totals.placed} filed, ${totals.tasks} task(s) written, ${waiting} waiting` + (failedSteps.length ? ` · ${failedSteps.join(', ')} failed` : '')
    notify(line); await dropLock()
    return finish({ ok: true, kind: 'morning', ran: true, fetched: rec.fetched, courses: rec.courses, totals, waiting, ms: rec.ms, note: line, morningNote: note })
  } catch (e) {
    await node('brain.mjs', ['run', 'done', '--note', 'failed: ' + e.message]).catch(() => { })
    delete rec.phase; await record({ ok: false, reason: 'error', note: e.message }).catch(() => { })
    await dropLock()
    return finish({ ok: false, kind: 'finish', reason: 'error', note: e.message })
  }
}

// The note the Home screen shows: at most twelve lines, from what happened and what is coming.
async function morningNote({ fetched, totals, waiting, briefs, stopped, cost, ticked = [], unlinked = [] }) {
  const today = todayIso(), brain = await readBrain(ROOT), hub = await readJson(path.join(HUB, '_hub.json'), null)
  const lines = [`# Morning note — ${nice(today + 'T12:00:00')}`]
  const f = fetched || {}
  const fresh = ['newFiles', 'newAnnouncements', 'newPages'].map(k => Number(f[k] || 0))
  lines.push(fresh.some(Boolean) ? `New from Quercus: ${fresh[0]} file(s), ${fresh[1]} announcement(s), ${fresh[2]} page(s). Claude placed ${totals.placed}, linked ${totals.linked}, wrote ${totals.tasks} task(s); ${waiting} still waiting.` : `Nothing new on Quercus since the last check${waiting ? `; ${waiting} thing(s) still waiting to be filed` : ''}.`)
  if (stopped) lines.push(`Stopped: ${stopped.note}`)
  if (unlinked.length) lines.push(`Without a link: ${unlinked.length} to-do(s) Claude wrote — ${unlinked.slice(0, 2).map(u => `${u.course} ${u.what}`).join(' · ')}${unlinked.length > 2 ? ' …' : ''}.`)
  const todays = []
  // a class Claude cancelled (brain.mjs class, keyed by the meeting's id) is said to be cancelled, not listed as on
  // a class day of this course's own term: a Winter course has no class in the October note (weekFor is null outside it)
  for (const [key, c] of Object.entries(COURSES)) if (isClassDay(today) && weekFor(c.term, today)) for (const m of c.meetings || []) if (m.day === ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(today + 'T12:00:00').getDay()]) todays.push(brain.classes?.[meetingId(key, today, m.kind)]?.cancel ? `${c.code} ${m.kind.toLowerCase()} cancelled` : `${c.code} ${m.kind.toLowerCase()} ${m.start}–${m.end}${m.where ? ` (${m.where})` : ''}`)
  lines.push(todays.length ? `Today: ${todays.join(' · ')}.` : 'Today: no classes.')
  if (ticked.length) lines.push(`Ticked for you: ${ticked.slice(0, 3).map(t => `${t.course} ${t.task} (${t.why})`).join(' · ')}${ticked.length > 3 ? ` and ${ticked.length - 3} more` : ''}.`)
  const week = new Date(today + 'T12:00:00'); week.setDate(week.getDate() + 7); const until = week.toISOString().slice(0, 10)
  const soon = Object.values(brain.tasks || {}).filter(t => t && !t.withdrawn && !t.done && (t.due || t.attach?.class?.date) && (t.due || t.attach.class.date) >= today && (t.due || t.attach.class.date) <= until && ['crucial', 'important'].includes(t.level))
    .sort((a, b) => (a.due || a.attach.class.date).localeCompare(b.due || b.attach.class.date)).slice(0, 4)
  for (const t of soon) lines.push(`${t.level === 'crucial' ? '!!' : '!'} ${COURSES[t.courseKey]?.code || t.courseKey}: ${t.what} — ${(t.due || t.attach.class.date).slice(5)}`)
  const nextTests = Object.keys(COURSES).map(k => (hub?.tests || []).filter(t => t.courseKey === k && t.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0]).filter(Boolean).slice(0, 3)
  if (nextTests.length) lines.push(`Next tests: ${nextTests.map(t => `${COURSES[t.courseKey].code} ${t.title.split('·')[0].trim()} in ${Math.round((new Date(t.date) - new Date(today)) / 86400000)} days`).join(' · ')}.`)
  const qs = Object.values(brain.questions || {}).filter(q => q && !q.answered).slice(0, 2)
  for (const q of qs) lines.push(`Question: ${q.text}`)
  lines.push(`Decided: ${totals.placed} placed, ${totals.ignored} ignored, ${totals.linked} linked, ${totals.tasks} tasks, ${totals.questions} questions${cost ? ` · Claude ${MODEL}, $${cost.toFixed(2)}` : ''}.`)
  const text = `---\ncreated: "${localStamp()}"\nkind: "summary"\n---\n${lines.slice(0, 12).join('\n')}\n`
  await fsp.mkdir(path.join(HUB, 'Today'), { recursive: true })
  await writeAtomic(path.join(HUB, 'Today', 'Morning note.md'), text)
  return lines.slice(1).join('\n')
}

// ---- review ----------------------------------------------------------------------------------------------------------
async function review() {
  if (SCHEDULED) { const d = await due('review'); if (!d.due) { say(`not due: the last review ran ${d.since} h ago`); return finish({ ok: true, kind: 'review', reason: 'not-due', since: d.since, ran: false }) } }
  if (!(await takeLock())) return finish({ ok: false, kind: 'review', reason: 'running', note: 'A run is already in progress.' })
  const rec = { id: 'run-' + Date.now().toString(36), kind: 'review', from: FROM, startedAt: localStamp(), model: MODEL, cost: 0 }
  const record = async (patch = {}) => { Object.assign(rec, patch, { endedAt: localStamp() }); await saveRun(rec) }
  try {
    await node('plan.mjs', ['--json'])
    const rv = await node('review.mjs', ['--json'])
    if (!rv.ok || !rv.last?.path) { await record({ ok: false, reason: 'review', note: (rv.stderr || rv.stdout).trim().split('\n').pop() }); await dropLock(); return finish({ ok: false, kind: 'review', reason: 'review', note: 'The review page could not be written.' }) }
    const page = rv.last.path
    let plan = null, stopped = null
    if (!NO_CLAUDE && rv.last.plan === 'placeholder') {
      const cs = await claudeStatus()
      if (!cs.installed) stopped = { reason: 'no-cli', note: NO_CLI }
      else if (!cs.loggedIn) stopped = { reason: 'login', note: NO_LOGIN }
      else {
        const prompt = `Read the page ${path.join(ROOT, page)} in full. Under "## Plan" it holds exactly one line: "*Not written yet — the Sunday pass adds a short plan here.*". Replace that line, and only that line, with one paragraph of three to six sentences (at most 120 words), in English, no bullets, no headings, no wikilinks, using the Edit tool: which unreviewed item to clear first and on which day; what to do before each meeting next week, in day order, from the page's Next week section; the one number that matters from Standing or Next tests. Use only what is on the page. Do not invent dates, problems, chapters or marks. Do not touch the frontmatter, the "<!-- slate:block … -->" line or any other section. Then reply with the paragraph only.`
        const r = await new Promise(resolve => {
          const s = spawnable(cs.bin, ['-p', prompt, '--model', MODEL, '--max-turns', '8', '--max-budget-usd', String(0.6 * SCALE), '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project', '--add-dir', ROOT, '--allowedTools', 'Read', 'Edit', '--disallowedTools', 'Bash', 'Write', 'WebSearch', 'WebFetch', 'Agent', 'Skill']), child = spawn(s.file, s.args, { cwd: REPO, env: CLAUDE_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...s.opts })
          let out = ''; child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
          const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { } }, 6 * 60_000)
          child.on('close', code => { clearTimeout(timer); let j = null; try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop()) } catch { }; resolve({ ok: code === 0 && !j?.is_error, text: String(j?.result || out).trim(), cost: j?.total_cost_usd ?? 0, turns: j?.num_turns ?? null }) })
        })
        rec.cost = r.cost || 0; rec.turns = r.turns
        if (r.ok) plan = r.text.slice(0, 900)
        else stopped = { reason: /usage limit|rate limit|limit reached/i.test(r.text) ? 'limit' : 'error', note: 'The plan paragraph could not be written this week; the review page is there without it.' }
      }
    }
    await record({ ok: !stopped, reason: stopped?.reason || null, note: stopped?.note || null, page, plan: plan ? 'written' : rv.last.plan })
    notify(stopped ? stopped.note : `Your week, read back: ${path.basename(page, '.md')}`); await dropLock()
    // `plan` is what the record says — written, or review.mjs's own 'placeholder' / 'kept' — so the app runner's session,
    // which runs this with --no-claude, knows whether the paragraph is still its to write (it read null); the words go in `paragraph`
    return finish({ ok: !stopped, kind: 'review', reason: stopped?.reason || null, note: stopped?.note || null, page, plan: plan ? 'written' : rv.last.plan, paragraph: plan, cost: +rec.cost.toFixed(4), model: MODEL, ran: true })
  } catch (e) { await record({ ok: false, reason: 'error', note: e.message }).catch(() => { }); await dropLock(); return finish({ ok: false, kind: 'review', reason: 'error', note: e.message }) }
}

// ---- status ----------------------------------------------------------------------------------------------------------
async function status() {
  const r = await runsRead(), m = lastOf(r, 'morning'), v = lastOf(r, 'review'), cs = await claudeStatus(), dm = await due('morning')
  const out = { edition: ED.key, budget: settings.budget || ED.budget, model: MODEL, runner: RUNNER, cadenceDays: CADENCE, claude: cs, lastMorning: m ? { at: m.endedAt, from: m.from, cost: m.cost, waiting: m.waiting, reason: m.reason } : null, lastReview: v ? { at: v.endedAt, page: v.page } : null, morningDue: dm.due, runs: r.runs.length }
  say(`${ED.name} · ${out.budget} budget · ${MODEL} · ${CADENCE === 1 ? 'every day' : `every ${CADENCE} days`}\nClaude CLI: ${cs.installed ? (cs.loggedIn ? 'installed and logged in' : 'installed, not logged in') : 'not installed'}\nLast morning: ${m ? `${m.endedAt} (${m.from}, $${(m.cost || 0).toFixed(2)}, ${m.waiting ?? '?'} waiting${m.reason ? ', ' + m.reason : ''})` : 'never'} · ${dm.due ? 'due now' : `next in ${Math.max(0, Math.round((CADENCE * 24 - 5) - (dm.since || 0)))} h`}\nLast review: ${v ? `${v.endedAt} → ${v.page}` : 'never'}`)
  console.log(JSON.stringify(out))
}

if (cmd === 'morning') await morning()
else if (cmd === 'fetch') await fetchPhase()
else if (cmd === 'brief') await briefCmd()
else if (cmd === 'finish') await finishPhase()
else if (cmd === 'review') await review()
else if (cmd === 'status') await status()
else { console.error('usage: node scripts/run.mjs morning|review|status [--from …] [--scheduled] [--no-claude] [--courses …] [--model …] [--json]'); process.exit(2) }
