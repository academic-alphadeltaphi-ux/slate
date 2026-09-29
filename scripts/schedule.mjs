#!/usr/bin/env node
// slate runs its own routine (SPEC §21): two launchd agents in ~/Library/LaunchAgents, one for the morning and one for
// the Sunday review. launchd fires a calendar job whenever the Mac is awake at the time and, unlike cron, runs a job it
// slept through once on waking — so a laptop shut at 07:30 catches up when it opens. The morning job runs every day and
// `scripts/run.mjs --scheduled` decides whether it is due (the edition's cadence); the review runs on Sunday evening.
// Nothing here needs the developer tools or the Claude desktop app: launchctl, node and the Claude CLI are enough.
//   node scripts/schedule.mjs install [--at HH:MM] [--review-at HH:MM] [--dry-run] [--json]
//   node scripts/schedule.mjs remove
//   node scripts/schedule.mjs status
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { guardFlags } from './lib/argv.mjs'
import { THIS as ED } from '../src/edition.js'
import { WIN, LOCAL_APP } from './lib/platform.mjs'

guardFlags(['--at', '--review-at', '--dry-run', '--json', '--root'], 'node scripts/schedule.mjs install|remove|status [--at HH:MM] [--review-at HH:MM] [--dry-run] [--json]')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const JSON_OUT = args.includes('--json'), DRY = args.includes('--dry-run')
const cmd = args.find(a => !a.startsWith('--') && !['--at', '--review-at', '--root'].includes(args[args.indexOf(a) - 1]))
const AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents')
const LOGS = path.join(os.homedir(), 'Library', 'Logs', ED.app.replace(/\s+/g, ''))
const PREFIX = `${ED.bundleId}`
const JOBS = {
  morning: { label: `${PREFIX}.morning`, args: ['scripts/run.mjs', 'morning', '--from', 'launchd', '--scheduled'], at: opt('--at', '07:30') },
  review: { label: `${PREFIX}.review`, args: ['scripts/run.mjs', 'review', '--from', 'launchd', '--scheduled'], at: opt('--review-at', '18:00'), weekday: 0 },
}
const hhmm = s => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); if (!m) { console.error(`not a time: ${s} (use HH:MM)`); process.exit(2) } return { hour: Number(m[1]), minute: Number(m[2]) } }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// The PATH launchd gives a job is nearly empty; node is named by its absolute path and the Claude CLI and uv live in
// ~/.local/bin, so the environment says so.
const PATH_LINE = `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`
function plist(job) {
  const t = hhmm(job.at)
  const cal = [`<key>Hour</key><integer>${t.hour}</integer>`, `<key>Minute</key><integer>${t.minute}</integer>`, ...(job.weekday !== undefined ? [`<key>Weekday</key><integer>${job.weekday}</integer>`] : [])]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${esc(job.label)}</string>
  <key>ProgramArguments</key><array>${[process.execPath, ...job.args.map(a => (a.startsWith('scripts/') ? path.join(REPO, a) : a))].map(a => `<string>${esc(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${esc(REPO)}</string>
  <key>StartCalendarInterval</key><dict>${cal.join('')}</dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(PATH_LINE)}</string><key>HOME</key><string>${esc(os.homedir())}</string><key>LANG</key><string>en_US.UTF-8</string></dict>
  <key>StandardOutPath</key><string>${esc(path.join(LOGS, job.label.split('.').pop() + '.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(LOGS, job.label.split('.').pop() + '.log'))}</string>
  <key>ProcessType</key><string>Background</string>
  <key>RunAtLoad</key><false/>
</dict></plist>
`
}
// SLATE_LAUNCHCTL=0: write and lint the plists but never load them (the brother simulation runs on a Mac that has its own jobs).
const launchctl = a => { if (process.env.SLATE_LAUNCHCTL === '0') return a[0] === 'print' ? null : ''; try { return execFileSync('launchctl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return null } }
const domain = () => `gui/${os.userInfo().uid}`
const loaded = label => launchctl(['print', `${domain()}/${label}`]) !== null

// ---- Windows (SPEC §21.7): two scheduled tasks instead of two agents ----------------------------------------------------------
// Task Scheduler runs the morning once a day (run.mjs --scheduled still decides whether it is due) and the review on
// Sundays. StartWhenAvailable is launchd's catch-up after sleep; the battery settings are off because a laptop at seven
// is on battery more often than not. wscript + bin/run-hidden.vbs keeps the console window off the screen and appends
// the output to a log. SLATE_LAUNCHCTL=0 writes and checks the XML without registering it (the scenarios).
if (WIN) {
  const APPDIR = path.join(LOCAL_APP, ED.app.replace(/\s+/g, ''))
  const TASKS = path.join(APPDIR, 'tasks'), WLOGS = path.join(APPDIR, 'Logs')
  const kindOf = job => job.label.split('.').pop()
  const taskName = job => `${ED.app} ${kindOf(job)}`
  const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const taskXml = job => {
    const t = hhmm(job.at), pad = n => String(n).padStart(2, '0')
    const start = `${new Date().toISOString().slice(0, 10)}T${pad(t.hour)}:${pad(t.minute)}:00`
    const sched = job.weekday !== undefined ? '<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Sunday/></DaysOfWeek></ScheduleByWeek>' : '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>'
    const argv = [path.join(REPO, 'bin', 'run-hidden.vbs'), path.join(WLOGS, kindOf(job) + '.log'), process.execPath, ...job.args.map(a => (a.startsWith('scripts/') ? path.join(REPO, a) : a))]
    const line = argv.map(a => (/[\s"\\]/.test(a) ? `"${a}"` : a)).join(' ')
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEsc(ED.name)}: ${job.weekday !== undefined ? 'the Sunday review' : 'the morning check of Quercus'}</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled>${sched}</CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>false</Hidden><ExecutionTimeLimit>PT3H</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${xmlEsc(line)}</Arguments><WorkingDirectory>${xmlEsc(REPO)}</WorkingDirectory></Exec></Actions>
</Task>
`
  }
  // a tag-balance check, because schtasks says little when an XML is wrong
  const lint = text => { const stack = []; for (const m of text.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g)) { if (m[3] === '/') continue; if (m[1] === '/') { if (stack.pop() !== m[2]) throw new Error(`task XML: unbalanced </${m[2]}>`) } else stack.push(m[2]) } if (stack.length) throw new Error(`task XML: unclosed <${stack.pop()}>`) }
  const schtasks = a => { if (process.env.SLATE_LAUNCHCTL === '0') return null; try { return execFileSync('schtasks', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return null } }
  const registered = job => schtasks(['/Query', '/TN', taskName(job)]) !== null
  if (cmd === 'install') {
    fs.mkdirSync(TASKS, { recursive: true }); fs.mkdirSync(WLOGS, { recursive: true })
    const done = []
    for (const job of Object.values(JOBS)) {
      const file = path.join(TASKS, kindOf(job) + '.xml'), text = taskXml(job)
      if (DRY) { console.log(`--- ${file}\n${text}`); continue }
      lint(text)
      fs.writeFileSync(file, Buffer.concat([Buffer.from('\ufeff', 'utf16le'), Buffer.from(text, 'utf16le')]))
      const r = schtasks(['/Create', '/TN', taskName(job), '/XML', file, '/F'])
      if (r === null && process.env.SLATE_LAUNCHCTL !== '0') { console.error(`schtasks could not register "${taskName(job)}"`); process.exit(1) }
      done.push({ label: job.label, task: taskName(job), at: job.at, weekday: job.weekday ?? null, file })
    }
    if (!DRY) {
      console.log(`scheduled: the morning at ${JOBS.morning.at} every day (runs when ${ED.cadenceDays === 1 ? 'due each day' : `${ED.cadenceDays} days have passed`}), the review on Sundays at ${JOBS.review.at}. Logs in ${WLOGS}.`)
      if (JSON_OUT) console.log(JSON.stringify({ ok: true, jobs: done, logs: WLOGS }))
    }
  } else if (cmd === 'remove') {
    for (const job of Object.values(JOBS)) { schtasks(['/Delete', '/TN', taskName(job), '/F']); fs.rmSync(path.join(TASKS, kindOf(job) + '.xml'), { force: true }) }
    console.log('removed both tasks'); if (JSON_OUT) console.log(JSON.stringify({ ok: true }))
  } else if (cmd === 'status') {
    const rows = Object.values(JOBS).map(job => ({ label: job.label, task: taskName(job), file: fs.existsSync(path.join(TASKS, kindOf(job) + '.xml')), loaded: registered(job) }))
    for (const r of rows) console.log(`${r.task}: ${r.loaded ? 'registered' : r.file ? 'written but not registered' : 'not installed'}`)
    if (JSON_OUT) console.log(JSON.stringify({ jobs: rows, logs: WLOGS }))
  } else { console.error('usage: node scripts/schedule.mjs install|remove|status [--at HH:MM] [--review-at HH:MM] [--dry-run] [--json]'); process.exit(2) }
  process.exit(0)
}

if (cmd === 'install') {
  fs.mkdirSync(AGENTS, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true })
  const done = []
  for (const job of Object.values(JOBS)) {
    const file = path.join(AGENTS, job.label + '.plist')
    const text = plist(job)
    if (DRY) { console.log(`--- ${file}\n${text}`); continue }
    if (loaded(job.label)) launchctl(['bootout', `${domain()}/${job.label}`])
    fs.writeFileSync(file, text)
    execFileSync('plutil', ['-lint', '-s', file])
    const r = launchctl(['bootstrap', domain(), file])
    if (r === null && !loaded(job.label) && process.env.SLATE_LAUNCHCTL !== '0') { console.error(`launchctl could not load ${job.label}`); process.exit(1) }
    done.push({ label: job.label, at: job.at, weekday: job.weekday ?? null, file })
  }
  if (!DRY) {
    console.log(`scheduled: the morning at ${JOBS.morning.at} every day (runs when ${ED.cadenceDays === 1 ? 'due each day' : `${ED.cadenceDays} days have passed`}), the review on Sundays at ${JOBS.review.at}. Logs in ${LOGS}.`)
    if (JSON_OUT) console.log(JSON.stringify({ ok: true, jobs: done, logs: LOGS }))
  }
} else if (cmd === 'remove') {
  for (const job of Object.values(JOBS)) {
    const file = path.join(AGENTS, job.label + '.plist')
    if (loaded(job.label)) launchctl(['bootout', `${domain()}/${job.label}`])
    fs.rmSync(file, { force: true })
  }
  console.log('removed both jobs'); if (JSON_OUT) console.log(JSON.stringify({ ok: true }))
} else if (cmd === 'status') {
  const rows = Object.values(JOBS).map(job => ({ label: job.label, file: fs.existsSync(path.join(AGENTS, job.label + '.plist')), loaded: loaded(job.label) }))
  for (const r of rows) console.log(`${r.label}: ${r.loaded ? 'loaded' : r.file ? 'written but not loaded' : 'not installed'}`)
  if (JSON_OUT) console.log(JSON.stringify({ jobs: rows, logs: LOGS }))
} else { console.error('usage: node scripts/schedule.mjs install|remove|status [--at HH:MM] [--review-at HH:MM] [--dry-run] [--json]'); process.exit(2) }
