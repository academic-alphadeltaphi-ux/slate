// The day agent (SPEC §23): one Claude session on scripts/day-prompt.md that drafts one day, with a clean context of its
// own. The Draft button in the app and the 07:00 run start the very same session — the student's answer of 2026-09-29: "the 7am
// run, but with a sub-agent, and a draft button" that is "the same agent as the button" — so a draft reads the same
// whichever started it. It may run brain.mjs and nothing that writes a file; no connectors.
//
// And its sibling, the calendar agent: "Send to Google Calendar" is a short session with the Google Calendar connector
// and scripts/day-gcal.mjs, because the app itself cannot reach Google (only a Claude session with the connector can).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { childPath } from './platform.mjs'

const pad = n => String(n).padStart(2, '0')
export const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const CAL = ['list_events', 'create_event', 'update_event', 'delete_event'].map(t => `mcp__claude_ai_Google_Calendar__${t}`)

// The claude binary: SLATE_CLAUDE_BIN (a test's fake), else the one on the PATH the app builds (~/.local/bin first).
export function claudeBin() {
  if (process.env.SLATE_CLAUDE_BIN) return process.env.SLATE_CLAUDE_BIN
  for (const p of [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(p)) return p
  return 'claude'
}

// The job both callers watch: running, ok, the text Claude said, cost and turns; `done` resolves when it ends.
function run({ repo, root, env, args, okWhen, label, extraEnv = {} }) {
  const bin = claudeBin()
  const e = { ...(env || process.env), SLATE_ROOT: root, PATH: childPath() }
  delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; delete e.CLAUDE_CODE_SSE_PORT     // a session started from inside another
  delete e.SLATE_DAY_STEER                                                               // never inherited: a steer is one run's
  Object.assign(e, extraEnv)
  const job = { running: true, ok: null, startedAt: new Date().toISOString(), finishedAt: null, cost: null, turns: null, output: '', note: null, label }
  let resolve; job.done = new Promise(r => { resolve = r })
  let child
  try { child = bin.endsWith('.mjs') ? spawn(process.execPath, [bin, ...args], { cwd: repo, env: e, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(bin, args, { cwd: repo, env: e, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (err) { Object.assign(job, { running: false, ok: false, note: err.message, finishedAt: new Date().toISOString() }); resolve(job); return job }
  let buf = ''
  const onLine = line => {
    let ev = null
    try { ev = JSON.parse(line) } catch { job.output += line + '\n'; return }
    if (ev.type === 'assistant') { for (const c of ev.message?.content || []) if (c.type === 'text' && c.text) job.output += c.text + '\n' }
    else if (ev.type === 'result') { job.cost = ev.total_cost_usd ?? job.cost; job.turns = ev.num_turns ?? job.turns; if (typeof ev.result === 'string' && ev.result && !job.output.includes(ev.result)) job.output += ev.result + '\n' }
  }
  child.stdout.on('data', d => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) onLine(l) })
  child.stderr.on('data', d => { job.output += String(d) })
  const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { } }, 15 * 60 * 1000)
  const end = (code, err) => {
    if (!job.running) return
    clearTimeout(timer)
    if (buf.trim()) onLine(buf)
    job.running = false; job.finishedAt = new Date().toISOString()
    job.ok = !err && code === 0 && okWhen.test(job.output)
    job.note = err ? err.message : code !== 0 ? `Claude ended with exit ${code}` : job.ok ? null : `Claude ended without the ${label === 'send' ? 'SENT' : 'DONE'} line`
    resolve(job)
  }
  child.on('error', err => end(null, err))
  child.on('close', code => end(code))
  return job
}
export const summaryOf = j => (j ? { running: j.running, ok: j.ok, startedAt: j.startedAt, finishedAt: j.finishedAt, date: j.date, from: j.from || null, model: j.model, cost: j.cost, turns: j.turns, output: String(j.output || '').slice(-4000), note: j.note } : { running: false, ok: null })

// startDayAgent({ repo, root, env, date, from, model, maxUsd, steer }) → the job. `from` (HH:MM) for today: draft from
// then on. `steer` is one line for this run only — the 07:00 run's coordinator correcting a draft its critic found wrong
// ("WebAssign 2 is due today and was not placed"). It reaches the brief as `runSteer` through the session's environment
// (SLATE_DAY_STEER, read by `brain.mjs day brief`) and is written nowhere: not the day's request, not the student's note.
export const steerLine = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 300)
export function startDayAgent({ repo, root, env, date, from = null, model = 'opus', maxUsd = 4, steer = null }) {
  const runSteer = steerLine(steer)
  const prompt = fs.readFileSync(path.join(repo, 'scripts', 'day-prompt.md'), 'utf8')
  const note = `You are the day agent, started at ${nowHM()} for ${date}. Draft that one day and nothing else: run \`node scripts/brain.mjs day brief --date ${date}${from ? ` --from ${from}` : ''} --json\`, weigh it as the prompt says, and send the draft with \`node scripts/brain.mjs day set --date ${date}${from ? ` --from ${from}` : ''}\`. Then reply with the DONE line.${runSteer ? ' This run carries a correction from the morning run: the brief shows it as `runSteer`.' : ''}`
  const args = ['-p', prompt, '--model', model, '--max-turns', '40', '--max-budget-usd', String(maxUsd), '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--add-dir', root, '--allowedTools', 'Bash(node scripts/brain.mjs:*)', 'Bash(echo:*)', 'Read',
    '--disallowedTools', 'WebSearch', 'WebFetch', 'Write', 'Edit', 'Agent', 'Skill', 'NotebookEdit', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--append-system-prompt', note]
  return Object.assign(run({ repo, root, env, args, okWhen: /DONE blocks=/, label: 'draft', extraEnv: runSteer ? { SLATE_DAY_STEER: runSteer } : {} }), { date, from, model, steer: runSteer || null })
}

// startSendAgent({ repo, root, env, date, model }) → the job: the day's confirmed blocks to Google Calendar. The
// connector has to load, so this session is not given an empty MCP config; it may use the four calendar tools and
// scripts/day-gcal.mjs, nothing else.
export function startSendAgent({ repo, root, env, date, model = 'sonnet', maxUsd = 1 }) {
  const prompt = fs.readFileSync(path.join(repo, 'scripts', 'day-gcal-prompt.md'), 'utf8')
  const note = `Send ${date}: the date for every command is --date ${date}. Then reply with the SENT line.`
  const args = ['-p', prompt, '--model', model, '--max-turns', '30', '--max-budget-usd', String(maxUsd), '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--add-dir', root, '--allowedTools', 'Bash(node scripts/day-gcal.mjs:*)', 'Bash(echo:*)', ...CAL,
    '--disallowedTools', 'WebSearch', 'WebFetch', 'Write', 'Edit', 'Agent', 'Skill', 'NotebookEdit', 'Read', '--append-system-prompt', note]
  return Object.assign(run({ repo, root, env, args, okWhen: /SENT created=/, label: 'send' }), { date, model })
}
