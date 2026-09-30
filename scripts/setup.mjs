#!/usr/bin/env node
// Setup is a program, not a prompt (SPEC §21). A brother's Claude runs `node scripts/setup.mjs status`, reads what to say
// and what to run next, and runs it; every step that touches the machine — npm, the keychain, the CLI installer, uv, the
// app bundle, launchd — is done here, by code that can be tested, and recorded in setup-state.json so a run that stops on
// a usage limit carries on from the first unfinished step. Claude's own work is the conversation: the token, the
// timetable, the syllabuses, the four confirmations, and one JSON file (courses.json) this script turns into the app's
// course file. `doctor` checks an install from the outside.
//
//   node scripts/setup.mjs status [--json]           what is done, what is next, what to say and what to run
//   node scripts/setup.mjs machine | deps | notes [--root <path>] | token <key> | courses fetch | courses write |
//                          claude | first-run | speech | app | schedule [--at HH:MM] [--review-at HH:MM] | finish | doctor
//   node scripts/setup.mjs adopt "<earlier Slate folder>" [--undo]   carry over a copy installed before the releases (§21.14)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { guardFlags } from './lib/argv.mjs'
import { THIS as ED } from '../src/edition.js'
import { check } from './lib/courses-schema.mjs'
import { renderTerms, renderSyllabus, REPO } from './lib/courses-render.mjs'
import { quercusAuth, storeToken, probeToken, DEFAULT_API } from './lib/quercus-auth.mjs'
import { hasDevTools } from '../server/devtools.js'
import { WIN, LOCAL_APP, desktopDir, documentsDir, findClaude as findClaudeBin, findUv, npmSpawn, spawnable, powershell, machineInfo, childPath, nodeOk, NODE_MIN, uvPythons } from './lib/platform.mjs'

guardFlags(['--root', '--at', '--review-at', '--json', '--force', '--finish', '--check', '--undo'], 'node scripts/setup.mjs status|machine|deps|notes|token|courses|claude|first-run|speech|app|schedule|finish|doctor|adopt [--root <path>] [--at HH:MM] [--json]')
const args = process.argv.slice(2), JSON_OUT = args.includes('--json'), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const words = args.filter((a, i) => !a.startsWith('--') && !['--root', '--at', '--review-at'].includes(args[i - 1]))
const [cmd, sub] = words
const STATE = path.join(REPO, 'setup-state.json'), PROGRESS = path.join(REPO, 'Setup progress.md'), CONFIG = path.join(REPO, 'slate.config.json')
const COURSES_JSON = path.join(REPO, 'courses.json')
const HOME = os.homedir(), LOCAL_BIN = path.join(HOME, '.local', 'bin')
// Where the app bundle is: the edition says (SPEC §21 — the brothers' copy sits on their Desktop and they double-click
// it there; the student's stays in Applications), and a simulation points SLATE_APP_DEST at a throwaway folder.
// scripts/build-app.mjs reads the same two, so the step and the doctor look where the build put it.
// On Windows the program lives in %LOCALAPPDATA%\Programs and what sits on the Desktop is a shortcut with the crest.
const APP_DIRS = process.env.SLATE_APP_DEST ? [process.env.SLATE_APP_DEST] : WIN ? [path.join(LOCAL_APP, 'Programs')] : ED.appDir === 'Desktop' ? [desktopDir()] : ['/Applications', path.join(HOME, 'Applications')]
const APP_WHERE = ED.appDir === 'Desktop' ? 'on the Desktop' : 'in Applications'
const appBundle = () => APP_DIRS.map(d => (WIN ? path.join(d, ED.app, `${ED.app}.exe`) : path.join(d, `${ED.app}.app`))).find(p => fs.existsSync(p)) || null
// The cadence and the hour in the edition's own words: "every day" at 07:00 for a Max copy, "every 2 days" at 07:30 for Pro.
const EVERY = ED.cadenceDays === 1 ? 'every day' : `every ${ED.cadenceDays} days`, AT = ED.morningAt || '07:30'
// Who decides in the morning (SPEC §21.8): 'app' — two scheduled tasks in the Claude app, created by their Claude during
// setup from what the schedule step prints, checked here by the file the app keeps for each; 'cli' — the command line tool.
const RUNNER = ED.runner || 'cli'
const TASK_IDS = [`slate-${ED.key}-morning`, `slate-${ED.key}-review`]
const taskFile = id => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'scheduled-tasks', id, 'SKILL.md')
// childPath(): joined with path.delimiter. A `:` join on Windows glued LOCAL_BIN to `C` of the first entry and lost it —
// on a brother's PC that entry was Node's own folder, and npm vanished (2026-09-24).
const ENV = { ...process.env, PATH: childPath() }
delete ENV.CLAUDECODE; delete ENV.CLAUDE_CODE_ENTRYPOINT
const CLAUDE_ENV = process.env.SLATE_CLAUDE_HOME ? { ...ENV, HOME: process.env.SLATE_CLAUDE_HOME } : ENV   // see scripts/run.mjs
const STEPS = RUNNER === 'app' ? ['machine', 'deps', 'notes', 'token', 'courses', 'first-run', 'speech', 'app', 'schedule', 'finish'] : ['machine', 'deps', 'notes', 'token', 'courses', 'claude', 'first-run', 'speech', 'app', 'schedule', 'finish']
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { startedAt: new Date().toISOString(), done: {}, notes: [] } } })()
const save = () => { fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n'); progressMd() }
const done = (step, info = {}) => { state.done[step] = { at: new Date().toISOString(), ...info }; save() }
const out = (text, json) => { if (text) console.log(text); if (JSON_OUT) console.log(JSON.stringify({ step: cmd === 'courses' ? `courses ${sub}` : cmd, ...json })) }
const fail = (text, json = {}) => { console.error(text); if (JSON_OUT) console.log(JSON.stringify({ step: cmd, ok: false, ...json })); process.exit(1) }
const sh = (bin, a, o = {}) => spawnSync(bin, a, { cwd: REPO, env: ENV, stdio: 'inherit', ...o })
// Through spawnable (platform.mjs): an npm-installed claude is %APPDATA%\npm\claude.cmd, which node will not start without a
// shell (EINVAL) — its `auth status` failed and the step said "not logged in" for ever.
const capture = (bin, a, o = {}) => { const s = spawnable(bin, a); try { return execFileSync(s.file, s.args, { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o, ...s.opts }).trim() } catch (e) { return null } }
const root = () => { try { const r = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).root; return r.startsWith('~') ? path.join(HOME, r.slice(1)) : r } catch { return null } }
// The notes and this folder — the app's own code — must be apart (review 2026-09-29). On a PC the guide put the kit in
// Documents and the notes defaulted to Documents\Slate: the same folder. The sidebar showed scripts/ and server/ as
// notebooks, a support snapshot zipped the notes, and an update that replaced this folder deleted them. The notes are
// "Slate notes" now, and a folder that is this one, sits in it or holds it is refused. Paths are compared through their
// nearest existing folder's real path, in lower case: both systems ignore case by default.
const real = p => { let a = path.resolve(p); const rest = []; while (!fs.existsSync(a) && path.dirname(a) !== a) { rest.unshift(path.basename(a)); a = path.dirname(a) } try { a = fs.realpathSync.native(a) } catch { } return path.join(a, ...rest).toLowerCase() }
const within = (outer, inner) => { const r = path.relative(real(outer), real(inner)); return r === '' || !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) }
const clash = p => (real(p) === real(REPO) ? 'is' : within(REPO, p) ? 'is inside' : within(p, REPO) ? 'holds' : null)
const notesDefault = () => (WIN ? path.join(documentsDir(), 'Slate notes') : path.join(HOME, 'Slate notes'))
// The folders macOS asks an app's permission for. An app that reads its code or its notes from one stops on its first
// open with that question (SPEC §21.8), so the words name it only where it will come.
const guarded = () => (WIN ? [] : [['Documents', 'Documents'], ['Desktop', 'the Desktop'], ['Downloads', 'Downloads']].filter(([d]) => [root(), REPO].some(p => p && within(path.join(HOME, d), p))).map(([, w]) => w))
const short = ED.short || ED.name

function progressMd() {
  const lines = [`# Setup progress — ${ED.name}`, '', `Started: ${state.startedAt.slice(0, 10)}`, state.machine ? state.machine.os === 'windows' ? `PC: Windows ${state.machine.windows} · ${state.machine.chip} · node ${state.machine.node}` : `Mac: ${state.machine.chip} · macOS ${state.machine.macos} · node ${state.machine.node || 'missing'}` : '', '']
  for (const s of STEPS) lines.push(`- [${state.done[s] ? 'x' : ' '}] ${s}${state.done[s]?.note ? ` — ${state.done[s].note}` : ''}`)
  if (state.notes.length) lines.push('', '## Notes', ...state.notes.map(n => `- ${n}`))
  fs.writeFileSync(PROGRESS, lines.filter(l => l !== null).join('\n') + '\n')
}

// ---- what to say and run at each step: the script Claude follows -----------------------------------------------------
const SAY = {
  machine: { run: 'node scripts/setup.mjs machine', ask: null, then: (WIN ? 'If it says Git for Windows is not installed, say once: "Claude works without it; if it ever refuses to run a command, install Git for Windows from git-scm.com and reopen this folder." ' : 'If it says Intel, tell them in one sentence, now: "One thing before we start: your Mac has an Intel chip, and the two speech features — turning a lecture recording into text, and typing what you say out loud — only run on the newer Apple chips. Everything else works." ') + 'If it says Node is missing, ask them to install it: "Please download Node from nodejs.org — the big green button, the LTS version — open the file and click through the installer, then tell me when it is done." Then run the step again.' },
  deps: { run: 'node scripts/setup.mjs deps', ask: 'Say: "I\'m installing what the app needs — this takes a minute or two." Run it with a ten-minute timeout.', then: null },
  notes: { run: 'node scripts/setup.mjs notes            (or: node scripts/setup.mjs notes --root "<the folder they name>")', ask: 'Ask: "Where would you like your notes kept? The usual place is a folder called Slate notes ' + (WIN ? 'in your Documents' : 'in your home folder') + ' — say \'that\'s fine\' and I\'ll use it."', then: 'Never this Slate folder or a folder inside it — it is the app, and an update replaces it; the step refuses them.' },
  token: { run: 'node scripts/setup.mjs token <the key they pasted>', ask: 'Say: "Now I need a key from Quercus so I can fetch your courses. In your browser: 1. Go to q.utoronto.ca and log in. 2. Click Account in the far-left bar, then Settings. 3. Scroll down to Approved Integrations and click + New Access Token. 4. Purpose: type Slate. Leave the expiry date blank. 5. Click Generate Token, then copy the long string it shows you. Paste it here — it only ever gets stored on ' + (WIN ? 'this PC, encrypted by Windows' : 'your Mac, in the keychain') + '." Wait for it.', then: 'Never repeat the key back to them, never write it in any file, never put it in Setup progress.md. If the step says the key was refused, ask them to make another one.' },
  courses: { run: 'node scripts/setup.mjs courses fetch, then your own reading (below), then: node scripts/setup.mjs courses write', ask: 'After `courses fetch`, show them the list and ask: "I found these on your Quercus: … Is that everything you\'re taking this year? Anything there you\'ve dropped?" Then ask for their timetable: "Now I need your class times. Go to acorn.utoronto.ca, open your timetable, take a screenshot (' + (WIN ? 'Windows key + Shift + S, then drag over it' : '⌘ Shift 4, then drag over it') + '), and drop the image into this chat." Read the screenshot: for each course every meeting — day, start, end, room, and whether ACORN calls it LEC, TUT or PRA. Read it back and ask them to confirm, including which one is the lecture and which the tutorial. A course on Quercus that is not on the timetable is usually online: ask "<course> isn\'t on your timetable — is it online, with no class times?" (yes: `meetings: []` and a `meets` line such as "Online, asynchronous"). Then read every course\'s outline, wherever it lives: `node scripts/quercus-sweep.mjs --syllabus --course <id>` prints the Syllabus tab, the front page and any outline or grading page as text, the teachers, the announcements about tests, and names the outline files; `node scripts/quercus-sweep.mjs --course <id> --download setup-downloads/<code>` downloads the files, and you Read the outline PDF. Pull out every test with its date and weight, the grading scheme (with rules like best 3 of 4), the textbook, the professor (the teachers list names them, else an announcement\'s author), the week-by-week topics when the outline lists them (`syllabus.weeks`), and whether the tutorial works through the previous week\'s lecture (tutorialLag). Leave `calendar` out unless the outline gives other term dates. Tools outside Quercus (WebAssign, Crowdmark) need nothing in courses.json: the Links page keeps them. Where the outline is silent, leave the field out — a wrong weight is worse than a missing one. A course with no outline anywhere: say so in one line and ask "do you have the outline for <course>, a PDF or a photo?" — if not, leave its tests and grading out; they are added when the outline appears (the first run, or later). Tell them what you found per course and let them correct it. Then write courses.json in this folder in the shape of `node scripts/courses.mjs example` (Quercus ids from the fetch, meetings from the screenshot, the rest from the syllabuses) and run `node scripts/courses.mjs check courses.json` until it reports no problems.', then: 'After `courses write`, the notebooks exist. Nothing has been fetched yet; that is the first-run step.' },
  claude: { run: 'node scripts/setup.mjs claude', ask: 'Say: "Next I\'m setting up the part of Claude that runs by itself ' + EVERY + '."', then: 'If it says Claude is not logged in, tell them exactly this and wait: "One thing only you can do: ' + (WIN ? 'open PowerShell (press the Windows key, type PowerShell, press Enter), type claude and press Enter,' : 'open Terminal (press ⌘ Space, type Terminal, press Return), type claude and press Return,') + ' choose \'Claude account with subscription\', and log in in the browser window that opens. Come back here when it says you\'re logged in." Then run the step again.' },
  'first-run': RUNNER === 'app'
    ? { run: 'node scripts/setup.mjs first-run   → then you decide each course (below) → then: node scripts/setup.mjs first-run --finish', ask: 'Say: "Now I\'m fetching everything from your courses — a minute — and then filing it, course by course. This is the long part."', then: 'The first command fetches and lists the courses with something to decide. For each course, one at a time: run `node scripts/run.mjs brief <CODE>` (it prints the brief as JSON), read `scripts/light-prompt.md` once, and decide the brief exactly as it says with `node scripts/brain.mjs …` commands, several per Bash call — confirm or correct each proposal, read each review, write the tasks with links. Keep them posted between courses in one line each ("ECO206: 14 things filed, 3 tasks"). When every course is done, load the `slate-quercus` skill (Skill tool) and do its completeness pass — `node scripts/audit.mjs --json`, act on each flag as it says, audit again — so nothing Quercus holds is left out and every task has its link. If a brief brought an outline you did not have at the courses step (a "Syllabus on Quercus" page, an outline PDF, an announcement with test dates), add what it says to courses.json now — tests, grading, textbook, professor — and run `node scripts/courses.mjs check courses.json` and `node scripts/setup.mjs courses write`. Then run `node scripts/setup.mjs first-run --finish`. Then the fourth confirmation — show them, don\'t just report: run `node scripts/brain.mjs log --run last` and pick five placements, e.g. "Here\'s some of what I filed, so you can see how it thinks: · ECO206_W1_Slides.pdf → Week 1, under the lecture · Problem Set 1 → Week 2, under the tutorial. Does that look right?" Anything they correct: `node scripts/brain.mjs place "<page.md>" --to "<folder>" --reason "…"`. Then say plainly how much there is: "Your professors have posted N things so far and they are all filed. It looks sparse now because the term has just started — every morning the app fetches what is new and files it, so the weeks fill up as you go." If the usage limit stops you: nothing is lost, say so, and "continue setting up slate" later carries on where it stopped.' }
    : { run: 'node scripts/setup.mjs first-run', ask: 'Say: "Now I\'m fetching everything from your courses and filing it — a few minutes." Run it with a ten-minute timeout.', then: 'Then the fourth confirmation — show them, don\'t just report: run `node scripts/brain.mjs log --run last` and pick five placements, e.g. "Here\'s some of what I filed, so you can see how it thinks: · ECO206_W1_Slides.pdf → Week 1, under the lecture · Problem Set 1 → Week 2, under the tutorial. Does that look right?" Anything they correct: `node scripts/brain.mjs place "<page.md>" --to "<folder>" --reason "…"`. Then say plainly how much there is: "Your professors have posted N things so far and they are all filed. It looks sparse now because the term has just started — every morning the app fetches what is new and files it, so the weeks fill up as you go." If the step says Claude\'s usage limit was reached, say so plainly: nothing is lost, the rest is filed at the next run, and "continue setting up slate" later carries on.' },
  speech: { run: 'node scripts/setup.mjs speech', ask: WIN ? 'Say: "Installing a small video tool (ffmpeg). The speech features — recordings into text, dictation — are Mac-only and are skipped here." Run it with a ten-minute timeout.' : 'Apple Silicon only (the step skips itself on Intel). Say: "Installing the speech engine that turns recordings into text — it runs entirely on your Mac, nothing is sent anywhere." Run it with a ten-minute timeout.', then: null },
  app: { run: 'node scripts/setup.mjs app', ask: 'Say: "Building the app now — about a minute." Run it with a ten-minute timeout.', then: WIN ? `Then tell them: "${ED.app} is on your Desktop now, a shortcut with the crest. Double-click it and it opens on your courses." Have them open it and confirm they see their courses. It is put together on this PC, so Windows raises no warning about where it came from; should a blue "Windows protected your PC" box ever appear, the fix is once: More info, then Run anyway.` : `Then tell them: "${ED.app} is ${APP_WHERE} now. Double-click it and it opens on your courses — give it ten seconds the first time." Have them open it and confirm they see their courses. It is built on this Mac, so macOS raises no warning about where it came from. If nothing seems to happen: a macOS question may be waiting behind other windows — "${ED.app} would like to access files in a folder" — and the answer is Allow; it only comes up when the notes or this Slate folder are in Documents, on the Desktop or in Downloads. If they clicked Don't Allow, the app cannot reach their notes: System Settings → Privacy & Security → Files and Folders → ${ED.app}, allow the folder, open it again. Should macOS ever refuse the app itself ("Apple could not verify…"): System Settings → Privacy & Security → scroll down → Open Anyway, once.` },
  schedule: RUNNER === 'app'
    ? { run: `node scripts/setup.mjs schedule --at ${AT}   → create the two tasks it prints → node scripts/setup.mjs schedule --check`, ask: `Ask: "It will check Quercus ${EVERY} in the morning, at ${AT} unless you would rather another time — when are you usually at your ${WIN ? 'PC' : 'Mac'} with the Claude app open?" Use their time (24-hour, e.g. 08:00) in place of ${AT} if they give one.`, then: `First make sure this conversation's working folder is ${REPO} (your environment names it). A task belongs to the folder of the conversation that creates it: created from any other folder it would run there, without this folder's permissions, and stop at the first question with nobody to answer — so if it is not, move there first with the change_directory tool (they click Allow) and ask them to reply "continue setting up slate". The command prints two scheduled tasks as JSON. Create each with the create_scheduled_task tool, passing taskId, title, description, cronExpression and prompt exactly as printed. Then prove it, in three moves: list_scheduled_tasks must show both, enabled, the morning one with the printed cronExpression and a nextRunAt tomorrow; node scripts/setup.mjs schedule --check must pass; and run_scheduled_task on ${TASK_IDS[0]} once, then list_task_runs until that run has finished — it should stop at "not a check day" (the first run was just now). A run that failed or waited on a permission question is not a schedule: say what it showed. Then tell them: "It checks Quercus ${EVERY} at ${AT} through a scheduled task inside the Claude app — it runs when the app is open and your ${WIN ? 'PC' : 'Mac'} is awake, and if it missed a morning it catches up when you next open the app. You can see it under Routines in the sidebar." If they ask for it to run without the Claude app open: that is the optional background setup in CLAUDE.md (a login in ${WIN ? 'PowerShell' : 'Terminal'}), later.` }
    : { run: `node scripts/setup.mjs schedule --at ${AT}`, ask: `Ask: "It will check Quercus ${EVERY} in the morning, at ${AT} unless you would rather another time — when are you usually at your ${WIN ? 'PC' : 'Mac'}?" Use their time (24-hour, e.g. 08:00) in place of ${AT} if they give one.`, then: `Tell them: it checks Quercus by itself ${EVERY} at that time, only while the ${WIN ? 'PC' : 'Mac'} is awake; if the laptop was shut it catches up when it opens, and the Home screen says how many days behind it is with a Check Quercus button that does the same thing now.` },
  finish: { run: 'node scripts/setup.mjs finish', ask: null, then: 'Read them the summary it prints, in your own words.' },
}

function statusReport() {
  progressMd()   // the checklist on disk follows the state, even after a step was undone by hand
  const next = STEPS.find(s => !state.done[s]) || null
  const lines = [`Setup for ${ED.name} — ${Object.keys(state.done).filter(s => STEPS.includes(s)).length} of ${STEPS.length} steps done.`]
  // Setup belongs in a conversation opened on this folder: only there does CLAUDE.md load, do this folder's permissions
  // apply, and do the scheduled tasks it creates run here. The one-message install ends in another folder; say so first.
  if (STEPS.some(s => !state.done[s])) lines.push(`This conversation must be one opened on ${REPO} (Claude Code's working folder). If yours is any other folder, move there yourself: the Claude app's change_directory tool with ${REPO} (they click Allow; the move happens when your turn ends), then ask them to reply "set me up". Only without that tool, tell them click by click how to open the folder in Claude Code.`)
  // An earlier copy set up on this computer (SPEC §21.14): offered before the first step that would choose notes.
  const found = !state.adopted && !state.done.notes ? earlierCopies() : []
  for (const e of found) lines.push(`Before any step: an earlier copy of ${short} is set up on this ${WIN ? 'PC' : 'Mac'}, in ${e.folder} (its notes: ${e.notes}). Ask them: "You already have Slate in ${e.folder}. Shall I carry it over into this new copy? Your notes, courses and Quercus key stay as they are, nothing is fetched again, and the old copy's morning check is switched off so the two never run at once." If yes — the earlier ${ED.app} closed first — run: node scripts/setup.mjs adopt "${e.folder}", tell them what it carried over, and run status again. If they would rather start over, go on with the steps below.`)
  lines.push('Done: ' + (STEPS.filter(s => state.done[s]).map(s => `${s}${state.done[s].note ? ` (${state.done[s].note})` : ''}`).join(', ') || 'nothing yet'))
  if (!next) lines.push('Everything is done. If something looks wrong, `node scripts/setup.mjs doctor` checks the install.')
  else {
    const s = SAY[next]
    lines.push(`Next: ${next}`)
    if (s.ask) lines.push(`  What to say and do: ${s.ask}`)
    lines.push(`  Run: ${s.run}`)
    if (s.then) lines.push(`  Then: ${s.then}`)
    lines.push('  When the step is done, run `node scripts/setup.mjs status` again.')
  }
  out(lines.join('\n'), { done: Object.keys(state.done), next, steps: STEPS, earlier: found.map(e => ({ folder: e.folder, notes: e.notes })) })
}

// ---- the steps ------------------------------------------------------------------------------------------------------
function machine() {
  const node = process.versions.node
  if (WIN) {
    const m = machineInfo()
    state.machine = { os: 'windows', chip: m.chip, windows: m.version, node, gitBash: m.gitBash, devtools: false }
    if (m.tooOld) fail(`Windows ${m.version} is too old: this needs Windows 10 (version 1809) or newer. Ask them to run Windows Update, then run this step again.`)
    if (!nodeOk(node)) fail(`Node ${node} is too old (${NODE_MIN.join('.')} or newer is needed — the app's Electron requires it): ask them to install the LTS version from nodejs.org, then run this step again.`)
    done('machine', { note: `Windows ${m.version} (${m.chip}), node ${node}${m.gitBash ? '' : ', no Git for Windows'}` })
    return out(`Windows PC (${m.chip}), Windows ${m.version}, node ${node}. The speech features (transcription, dictation) are Mac-only and will be skipped.${m.gitBash ? '' : ' Git for Windows is not installed: Claude Code works without it but runs commands through PowerShell instead of its usual shell; if anything refuses to run, install Git for Windows from git-scm.com and reopen this folder.'}`, { ok: true, os: 'windows', chip: m.chip, windows: m.version, node })
  }
  // SLATE_SIM_ARCH: the scenarios pretend to be an Intel Mac; nothing else sets it.
  const chip = (process.env.SLATE_SIM_ARCH || os.arch()) === 'arm64' ? 'Apple Silicon' : 'Intel', macos = capture('sw_vers', ['-productVersion']) || '?'
  state.machine = { os: 'macos', chip, macos, node, devtools: hasDevTools() }
  if (Number(macos.split('.')[0]) < 13) fail(`macOS ${macos} is too old: this needs macOS 13 or newer. Ask them to update in System Settings → General → Software Update, then run this step again.`)
  if (!nodeOk(node)) fail(`Node ${node} is too old (${NODE_MIN.join('.')} or newer is needed — the app's Electron requires it): ask them to install the LTS version from nodejs.org, then run this step again.`)
  done('machine', { note: `${chip}, macOS ${macos}, node ${node}` })
  out(`${chip} Mac, macOS ${macos}, node ${node}${chip === 'Intel' ? ' — the speech features (transcription, dictation) need Apple Silicon and will be skipped' : ''}. Developer tools ${state.machine.devtools ? 'present' : 'absent (fine: nothing here needs them)'}.`, { ok: true, chip, macos, node })
}
function deps() {
  if (fs.existsSync(path.join(REPO, 'node_modules', 'electron', 'dist')) && fs.existsSync(path.join(REPO, 'node_modules', 'vite'))) { done('deps', { note: 'already installed' }); return out('The app\'s dependencies are already installed.', { ok: true }) }
  const r = npmSpawn('npm', ['install', '--no-fund', '--no-audit'], { cwd: REPO, env: ENV, stdio: 'inherit' })
  if (r.status !== 0) fail('npm install failed (see above). Usually the network: check the wifi and run this step again.')
  const e = electronDist(); if (!e.ok) fail(e.message)
  done('deps'); out('Installed.', { ok: true })
}
// Electron 44 has no postinstall: npm leaves node_modules/electron without its binary, and fetches it only when something
// first require()s the package — which build-app.mjs never does (it copies dist/). So a fresh install had no dist/ and the
// app step failed; on a brother's PC his Claude ran install.js by hand (2026-09-24). Run it here, and say so if it cannot.
function electronDist() {
  const dir = path.join(REPO, 'node_modules', 'electron'), dist = path.join(dir, 'dist')
  if (fs.existsSync(dist) && fs.readdirSync(dist).length) return { ok: true }
  if (!fs.existsSync(path.join(dir, 'install.js'))) return { ok: false, message: 'node_modules/electron is missing: run node scripts/setup.mjs deps again.' }
  console.log('Downloading Electron (about 100 MB, once)…')
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { cwd: REPO, env: ENV, stdio: 'inherit', timeout: 600_000 })
  if (r.status === 0 && fs.existsSync(dist) && fs.readdirSync(dist).length) return { ok: true }
  return { ok: false, message: 'Electron could not be downloaded (see above). Usually the network: check the wifi and run node scripts/setup.mjs deps again.' }
}
function notes() {
  // A Mac: the home folder itself, which macOS never asks permission for — a first double-click that opens with no question
  // (SPEC §21.8). Windows: Documents, which may live in OneDrive, so the shell says where. Both "Slate notes", beside or
  // apart from the Slate folder the guide puts in the home folder, never it.
  const want = opt('--root', notesDefault())
  const abs = want.startsWith('~') ? path.join(HOME, want.slice(1)) : path.resolve(want)
  const c = clash(abs)
  if (c) fail(`${abs} ${c} this Slate folder (${REPO}), which is the app itself: notes kept there would show the app's code as notebooks, go into every support report, and be deleted when an update replaces this folder. Ask them for a folder outside it${clash(notesDefault()) ? '' : ` — the usual one is ${notesDefault()}`} — and run: node scripts/setup.mjs notes --root "<that folder>"`)
  fs.mkdirSync(path.join(abs, 'Hub', 'Today'), { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify({ root: !WIN && abs.startsWith(HOME) ? '~' + abs.slice(HOME.length) : abs }, null, 2) + '\n')
  const sf = path.join(abs, 'Hub', '_settings.json')
  const prev = (() => { try { return JSON.parse(fs.readFileSync(sf, 'utf8')) } catch { return {} } })()
  fs.writeFileSync(sf, JSON.stringify({ ...prev, brain: true, edition: ED.key, budget: ED.budget, cadenceDays: ED.cadenceDays, model: ED.model || 'sonnet', runner: RUNNER }, null, 2) + '\n')
  done('notes', { note: abs.replace(HOME, '~') })
  out(`Notes will live in ${abs}. ${ED.short} is set as the edition, with Claude as the brain on the light budget.`, { ok: true, root: abs })
}
async function token() {
  let key = sub || ''
  if (!key && !process.stdin.isTTY) key = fs.readFileSync(0, 'utf8').trim()
  key = key.trim()
  if (!key || key.length < 20) fail('No key given. Run: node scripts/setup.mjs token <the key they pasted>')
  const p = await probeToken(key, process.env.CANVAS_API_URL || DEFAULT_API)   // CANVAS_API_URL: the scenarios' mock Quercus
  if (!p.ok) fail(p.status === 401 ? 'Quercus refused that key (401). It was probably copied incompletely — ask them to make a new token and paste it again.' : p.status === 0 ? 'Quercus could not be reached. Check the wifi and run the step again.' : `Quercus answered ${p.status}. Ask them to make a new token and try again.`)
  storeToken(key)
  const back = quercusAuth()
  if (!back || back.token !== key) fail(`The key could not be stored ${WIN ? 'on this PC' : 'in the keychain'}. Run the step again; if it fails twice, note it in Setup progress.md and carry on: the fetch will ask for the key later.`)
  done('token', { note: `stored ${WIN ? 'encrypted on this PC' : 'in the keychain'} for ${p.name || 'the account'}` })
  out(`The key works — Quercus knows this account as ${p.name || p.id}. It is stored ${WIN ? "encrypted on this PC (Windows' own protection)" : "in the Mac's keychain"} and nowhere else.`, { ok: true, name: p.name })
}
async function coursesFetch() {
  const auth = quercusAuth(); if (!auth) fail('No Quercus key is stored yet: do the token step first.')
  // every page of the listing, following Canvas's Link header: one page was read before, and a listing longer than
  // it silently lost courses (SPEC §21.5)
  const all = []
  let url = `${auth.api}/courses?enrollment_state=active&per_page=100&include[]=term`
  for (let i = 0; url && i < 20; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + auth.token } }).catch(() => null)
    if (!r?.ok) fail(`Quercus could not be read (${r ? r.status : 'no network'}).`)
    const page = await r.json(); if (!Array.isArray(page)) break
    all.push(...page)
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || ''); url = m ? m[1] : null
  }
  // Quercus spells a code "ECO208Y1 Y LEC0101", "CLA204H1 F LEC0201" or " ECO206Y1Y LEC5101/5201" — the term letter may
  // touch the suffix — and lists last year's courses as active too, so the term's name says which year a course is.
  const now = new Date(), ay = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1
  const list = all.filter(c => c.course_code && /\b[A-Z]{3}\d{3}[HY]\d/.test(c.course_code)).map(c => {
    const m = /\b([A-Z]{3})(\d{3})([HY]\d)\s*([FSY])?\b/.exec(c.course_code), tn = c.term?.name || ''
    const term = m[4] || (m[3].startsWith('Y') ? 'Y' : /winter/i.test(tn) ? 'S' : /fall/i.test(tn) ? 'F' : null)
    const year = Number((/\b(20\d\d)\b/.exec(tn) || [])[1]) || null
    const past = year !== null && (year < ay || (year === ay && /winter/i.test(tn) && !/fall/i.test(tn)))
    return { id: c.id, key: `${m[1]} ${m[2]}${m[3]}`, code: `${m[1]}${m[2]}`, name: String(c.name || '').replace(/^.*?:\s*/, ''), term, quercus: c.course_code.trim(), url: `https://q.utoronto.ca/courses/${c.id}`, termName: tn || null, past }
  })
  const current = list.filter(c => !c.past), old = list.filter(c => c.past)
  state.coursesFound = current; save()
  if (!current.length) return out(['No course is listed on this Quercus account for this year' + (old.length ? ` (only earlier years: ${old.map(c => c.key).join(', ')})` : '') + '.', 'Ask them whether they are enrolled this term and whether the key came from the right account (q.utoronto.ca, the same login they use for their courses). A course a professor has not published yet does not show; try again in a day. Setup cannot go on without at least one course.'].join('\n'), { ok: true, courses: [], past: old })
  out(['This year on Quercus:', ...current.map(c => `  ${c.key.padEnd(10)} id ${c.id}  ${c.name}  (${c.term || '?'}${c.termName ? ', ' + c.termName : ''})`),
    ...(old.length ? ['Earlier years, still listed (leave them out):', ...old.map(c => `  ${c.key.padEnd(10)} id ${c.id}  ${c.name}  (${c.termName})`)] : []),
    '', 'Show them this list and ask whether it is everything they are taking this year. Then the timetable screenshot, then the syllabuses, then write courses.json (see `node scripts/setup.mjs status`).'].join('\n'), { ok: true, courses: current, past: old })
}
function coursesWrite() {
  const src = fs.existsSync(COURSES_JSON) ? COURSES_JSON : null
  const nr = root(); if (!nr) fail('The notes folder is not set yet: do the notes step first.')
  if (!src) fail('There is no courses.json in this folder yet. Write it in the shape of `node scripts/courses.mjs example` and run this step again.')
  let doc = null; try { doc = JSON.parse(fs.readFileSync(src, 'utf8')) } catch (e) { fail(`courses.json is not valid JSON: ${e.message}`) }
  const problems = check(doc)
  if (problems.length) fail(`${problems.length} problem(s) in courses.json — fix them and run this step again:\n  · ` + problems.join('\n  · '))
  const found = new Set((state.coursesFound || []).map(c => c.id))
  const unknown = Object.entries(doc.courses).filter(([k, c]) => found.size && !found.has(c.id)).map(([k, c]) => `${k} (id ${c.id})`)
  if (unknown.length && !args.includes('--force')) fail(`These courses carry an id that "courses fetch" did not see on this account: ${unknown.join(', ')}. Check the ids, or pass --force if they are right.`)
  fs.mkdirSync(path.join(nr, 'Hub'), { recursive: true })
  fs.copyFileSync(src, path.join(nr, 'Hub', '_courses.json'))
  fs.writeFileSync(path.join(REPO, 'scripts', 'lib', 'terms.mjs'), renderTerms(doc, 'Hub/_courses.json'))
  fs.writeFileSync(path.join(REPO, 'scripts', 'lib', 'syllabus.mjs'), renderSyllabus(doc, 'Hub/_courses.json'))
  const load = capture(process.execPath, ['-e', "import('./scripts/lib/terms.mjs').then(m => console.log('loaded ' + Object.keys(m.COURSES).length))"])
  if (!/^loaded \d+$/.test(load || '')) fail('The rendered course file does not load — this is a bug in the renderer, not in courses.json. Note it in Setup progress.md.')
  for (const key of Object.keys(doc.courses)) { const r = sh(process.execPath, [path.join(REPO, 'scripts', 'add-course.mjs'), '--course', key, '--json'], { stdio: ['ignore', 'pipe', 'inherit'] }); if (r.status !== 0) fail(`The notebook for ${key} could not be made.`) }
  done('courses', { note: Object.keys(doc.courses).join(', ') })
  out(`Course file written and notebooks made for ${Object.keys(doc.courses).join(', ')}.`, { ok: true, courses: Object.keys(doc.courses) })
}
const findClaude = findClaudeBin   // SLATE_CLAUDE_BIN set but missing means not installed (the scenarios)
function claudeStep() {
  let bin = findClaude()
  if (!bin) {
    console.log('Installing Claude Code\'s command line tool…')
    const r = WIN ? (() => { try { powershell('irm https://claude.ai/install.ps1 | iex', { stdio: 'inherit' }); return { status: 0 } } catch { return { status: 1 } } })() : sh('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
    bin = findClaude()
    if (r.status !== 0 || !bin) fail('The installer did not finish (see above). Check the wifi and run this step again.')
  }
  const st = (() => { try { return JSON.parse(capture(bin, ['auth', 'status', '--json'], { env: CLAUDE_ENV }) || 'null') } catch { return null } })()
  if (!st?.loggedIn) { state.notes.push('Claude CLI installed, login pending'); save(); return out('Claude Code\'s command line tool is installed but NOT logged in. They have to do this once, ' + (WIN ? 'in PowerShell (the Windows key, type PowerShell, Enter): type `claude`, press Enter' : 'in Terminal: type `claude`, press Return') + ', choose "Claude account with subscription", log in in the browser. Then run this step again.', { ok: false, installed: true, loggedIn: false }) }
  done('claude', { note: `logged in (${st.authMethod || 'claude.ai'})` })
  out('Claude Code\'s command line tool is installed and logged in.', { ok: true, installed: true, loggedIn: true })
}
function firstRun() {
  if (!state.done.courses) fail('The courses step has to be done first.')
  if (RUNNER === 'app') {
    // In two halves, with their Claude deciding in between (SPEC §21.8): fetch → (brief + brain.mjs per course) → --finish.
    const runJson = a => { const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'run.mjs'), ...a], { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }); const lines = String(r.stdout || '').trim().split('\n'); let j = null; try { j = JSON.parse(lines[lines.length - 1]) } catch { } console.log(lines.slice(0, -1).join('\n')); return j }
    if (args.includes('--finish')) {
      const j = runJson(['finish', '--from', 'setup'])
      if (!j) fail('The finish did not report back (see above).')
      if (j.reason === 'no-run') fail(j.note)
      if (j.ok === false) fail(j.note || 'The finish failed (see above).')
      const f = state.firstRun?.fetched || j.fetched || {}
      done('first-run', { note: `${j.totals?.placed ?? 0} filed, ${j.waiting ?? 0} waiting` })
      return out(`Filed: ${j.totals?.placed ?? 0} placed, ${j.totals?.tasks ?? 0} task(s) written, ${j.waiting ?? 0} still waiting. From Quercus this time: ${f.newFiles ?? 0} file(s), ${f.newAnnouncements ?? 0} announcement(s), ${f.newPages ?? 0} page(s).`, { ok: true, ...j })
    }
    const j = runJson(['fetch', '--from', 'setup'])
    if (!j) fail('The fetch did not report back (see above).')
    if (j.reason === 'token' || j.reason === 'network') fail(j.note)
    if (j.ok === false) fail(j.note || 'The fetch failed (see above).')
    const f = j.fetched || {}
    state.firstRun = { startedAt: new Date().toISOString(), fetched: f }; save()
    const list = (j.courses || []).map(c => `${c.code} (${c.waiting} waiting, ${c.reviews} to read)`).join(', ')
    return out(`Fetched ${f.newFiles ?? 0} file(s), ${f.newAnnouncements ?? 0} announcement(s), ${f.newPages ?? 0} page(s). ${(j.courses || []).length} course(s) to decide: ${list || 'none'}. Now decide each course: node scripts/run.mjs brief <CODE> prints its brief; follow scripts/light-prompt.md with node scripts/brain.mjs commands (several per call); when every course is done, run node scripts/setup.mjs first-run --finish.`, { ok: true, phase: 'deciding', ...j })
  }
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'run.mjs'), 'morning', '--from', 'setup'], { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
  const lines = String(r.stdout || '').trim().split('\n'); let j = null; try { j = JSON.parse(lines.pop()) } catch { }
  console.log(lines.join('\n'))
  if (!j) fail('The first run did not report back (see above).')
  if (j.reason === 'token') fail(j.note)
  const partial = j.reason === 'limit' || j.reason === 'login' || j.reason === 'no-cli'
  done('first-run', { note: partial ? `stopped: ${j.reason} — ${j.waiting} waiting` : `${j.totals?.placed ?? 0} filed, ${j.waiting ?? 0} waiting, $${(j.cost || 0).toFixed(2)}` })
  out(partial ? `Fetched everything; filing stopped early: ${j.note}` : `Fetched and filed: ${j.totals?.placed ?? 0} placed, ${j.totals?.tasks ?? 0} tasks written, ${j.waiting ?? 0} waiting. Claude (${j.model}) cost $${(j.cost || 0).toFixed(2)}.`, { ok: true, ...j })
}
function speech() {
  // uv and ffmpeg on every Mac (the OCR and video installers in bin/ need uv where the developer tools are absent);
  // the speech engine itself only on Apple Silicon.
  const intel = state.machine?.chip === 'Intel'
  let uv = findUv()
  if (!uv) {
    if (WIN) { try { powershell('irm https://astral.sh/uv/install.ps1 | iex', { stdio: 'inherit' }) } catch { } }
    else sh('bash', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'])
    uv = findUv()
    if (!uv) fail('uv could not be installed (see above). Check the wifi and run this step again.')
  }
  for (const tool of (intel || WIN) ? ['static-ffmpeg'] : ['parakeet-mlx', 'static-ffmpeg']) {
    let r = spawnSync(uv, ['tool', 'install', '--quiet', tool], { cwd: REPO, env: ENV, encoding: 'utf8' }); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '')
    // uv's managed-Python link check can fail on Windows ("Missing expected target directory"): name the interpreter
    // by its full path, installing one first if uv has none (platform.mjs uvPythons).
    if (r.status !== 0 && /missing expected target directory|no interpreter found|failed to (find|inspect) .*python/i.test(r.stderr || '')) {
      if (!uvPythons().length) sh(uv, ['python', 'install'])
      for (const py of uvPythons()) { console.log(`retrying ${tool} with ${py}`); r = sh(uv, ['tool', 'install', '--quiet', '--python', py, tool]); if (r.status === 0) break }
    }
    if (r.status !== 0) fail(`${tool} could not be installed (see above). Run this step again.`)
  }
  // static-ffmpeg's wheel carries no ffmpeg: its commands download the binaries the first time one of them runs, and
  // installing runs none — so on a fresh machine the video remux and the transcriber found nothing. Run one, once, here,
  // where a wait is expected (scripts/lib/mymedia.mjs finds the result).
  const paths = path.join(LOCAL_BIN, WIN ? 'static_ffmpeg_paths.exe' : 'static_ffmpeg_paths')
  if (fs.existsSync(paths) && sh(paths, [], { timeout: 600000, windowsHide: true }).status !== 0) fail('ffmpeg could not be downloaded (see above). Check the wifi and run this step again.')
  if (WIN) { done('speech', { note: 'skipped: Windows (uv and ffmpeg installed)' }); return out('Skipped the speech engine: transcription and dictation are Mac-only. uv and ffmpeg are installed for the rest.', { ok: true, skipped: true }) }
  if (intel) { done('speech', { note: 'skipped: Intel (uv and ffmpeg installed)' }); return out('Skipped the speech engine: transcription and dictation need Apple Silicon. uv and ffmpeg are installed for the rest.', { ok: true, skipped: true }) }
  // an install that said yes and left nothing behind is not an engine: look for it, and say so plainly — the rest works without it
  if (!fs.existsSync(path.join(LOCAL_BIN, 'parakeet-mlx'))) {
    // where uv says its tools go: a uv set up to use another folder installs there, and slate looks in ~/.local/bin
    const bin = (spawnSync(uv, ['tool', 'dir', '--bin'], { env: ENV, encoding: 'utf8' }).stdout || '').trim() || 'unknown'
    done('speech', { note: `the speech engine did not install (uv's tools: ${bin}): transcription and dictation are off`, missing: true })
    return out(`The speech engine did not install, so recording a lecture into text and dictation stay off; everything else works. uv reports its tools in ${bin}, and parakeet-mlx is not in ~/.local/bin. \`node scripts/setup.mjs speech\` tries again; if it fails the same way, \`node scripts/support-report.mjs --issue "speech did not install"\` makes a report for whoever gave them Slate.`, { ok: true, speech: false, uvBin: bin })
  }
  done('speech', { note: 'parakeet-mlx and ffmpeg installed' })
  out('Transcription and dictation are installed. The first transcription downloads the speech model (a few hundred megabytes) and takes a minute longer.', { ok: true })
}
function app() {
  if (!root()) fail('The notes step has to be done first.')
  if (!process.env.SLATE_ELECTRON_DIST) { const e = electronDist(); if (!e.ok) fail(e.message) }   // an install whose deps step predates the fix
  const b = npmSpawn('npx', ['vite', 'build'], { cwd: REPO, env: ENV, stdio: 'inherit' }); if (b.status !== 0) fail('The app could not be built (see above).')
  const r = sh(process.execPath, [path.join(REPO, 'scripts', 'build-app.mjs'), '--no-build']); if (r.status !== 0) fail('The app bundle could not be made (see above).')
  const dest = appBundle()
  if (!dest) fail(`The app was built but is not ${APP_WHERE} (looked in ${APP_DIRS.join(', ')}).`)
  done('app', { note: dest })
  out(WIN ? `${ED.app} is on the Desktop: a shortcut with the crest, and the program itself in ${path.dirname(dest)}. Double-click the shortcut to open it.` : `${ED.app} is ${APP_WHERE}: ${dest}. Double-click it to open it.`, { ok: true, app: dest })
}
function schedule() {
  if (RUNNER === 'app') {
    // Two scheduled tasks in the Claude app (SPEC §21.8). Setup cannot create them — the app keeps the schedule, the
    // folder and the model itself — so this prints exactly what their Claude passes to create_scheduled_task, and
    // --check reads the file the app writes for each task to say whether it is there.
    const at = opt('--at', state.schedule?.at || AT), t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at); if (!t) fail(`Not a time: ${at} (use HH:MM, e.g. 07:30).`)   // --check remembers the hour the print step was given
    const tasks = [
      { taskId: TASK_IDS[0], title: `${ED.app} — the morning check`, description: `${EVERY[0].toUpperCase() + EVERY.slice(1)} at ${at}: fetch Quercus and file what is new (${ED.name})`, cronExpression: `${Number(t[2])} ${Number(t[1])} * * *`, prompt: `Read and follow, step by step, the instructions in ${path.join(REPO, 'scripts', 'task-morning-prompt.md')}. Work in ${REPO}.` },
      { taskId: TASK_IDS[1], title: `${ED.app} — the Sunday review`, description: `Sundays at 18:00: the week's look-back and a short plan (${ED.name})`, cronExpression: '0 18 * * 0', prompt: `Read and follow, step by step, the instructions in ${path.join(REPO, 'scripts', 'task-review-prompt.md')}. Work in ${REPO}.` },
    ]
    if (args.includes('--check')) {
      const missing = tasks.filter(x => !fs.existsSync(taskFile(x.taskId)))
      if (missing.length) fail(`Not created yet: ${missing.map(m => m.taskId).join(', ')}. Create them with the create_scheduled_task tool exactly as \`node scripts/setup.mjs schedule --at ${at}\` prints, then run this check again.`)
      // a task file that names another folder is an older copy's: it would fetch into that copy, and this one would wait for ever
      const elsewhere = tasks.filter(x => !fs.readFileSync(taskFile(x.taskId), 'utf8').includes(REPO))
      if (elsewhere.length) fail(`${elsewhere.map(m => m.taskId).join(', ')} point at another folder (an older copy). Delete them (the delete_scheduled_task tool, or Routines in the sidebar) and create them again from this conversation as \`node scripts/setup.mjs schedule --at ${at}\` prints — update_scheduled_task changes the prompt but keeps the old folder — then run this check again.`)
      state.schedule = { ...(state.schedule || {}), at }
      done('schedule', { note: `${EVERY} at ${at} as a scheduled task in the Claude app; review Sundays 18:00` })
      return out(`Scheduled in the Claude app: ${EVERY} at ${at}, and a review on Sundays at 18:00. They run while the app is open; a missed morning catches up when the app next opens.`, { ok: true, tasks: tasks.map(x => x.taskId) })
    }
    state.schedule = { at }; save()
    const lines = [`Create these two scheduled tasks with the create_scheduled_task tool — working folder ${REPO} — passing each field exactly:`]
    for (const x of tasks) lines.push(JSON.stringify(x, null, 2))
    lines.push('Then run: node scripts/setup.mjs schedule --check')
    return out(lines.join('\n'), { ok: true, tasks, check: 'node scripts/setup.mjs schedule --check' })
  }
  const r = sh(process.execPath, [path.join(REPO, 'scripts', 'schedule.mjs'), 'install', '--at', opt('--at', AT), '--review-at', opt('--review-at', '18:00')])
  if (r.status !== 0) fail('The schedule could not be installed (see above).')
  done('schedule', { note: `${EVERY} at ${opt('--at', AT)}, review Sundays ${opt('--review-at', '18:00')}` })
  out(`Scheduled: ${EVERY} at ${opt('--at', AT)}, and a review on Sundays at ${opt('--review-at', '18:00')}.`, { ok: true })
}
function finish() {
  const missing = STEPS.filter(s => s !== 'finish' && !state.done[s])
  done('finish', { note: missing.length ? `with ${missing.join(', ')} not done` : 'complete' })
  out([`${ED.name} is set up${missing.length ? ` (still to do: ${missing.join(', ')})` : ''}. Tell them:`,
    `- Their notes live in ${root() || 'the folder they chose'}: ordinary files they can open, back up or move.`,
    WIN ? `- ${ED.app} is on the Desktop, a shortcut with the crest: double-click it. They can pin it to the taskbar.` : `- ${ED.app} is ${APP_WHERE}: double-click it.${guarded().length ? ` The first time, macOS asks whether it may access files in ${guarded().join(' and ')}: Allow.` : ''} They can drag it to the Dock; it works from either.`,
    RUNNER === 'app' ? `- It checks Quercus by itself ${EVERY} at ${state.schedule?.at || AT} through a scheduled task in the Claude app, while the app is open (a missed morning catches up when the app next opens). The Check Quercus button on Home fetches now; the next check files what it fetched.` : `- It checks Quercus by itself ${EVERY} while the ${WIN ? 'PC' : 'Mac'} is awake, and the Check Quercus button on Home does it now.`,
    ...(WIN || state.machine?.chip === 'Intel' ? [] : state.done.speech?.missing ? ['- Transcription and dictation are off: the speech engine did not install (`node scripts/setup.mjs speech` tries again).'] : ['- They can record a lecture into a page and it becomes text; hold the dictate button and talk instead of typing.']),
    '- If anything looks wrong — a file in the wrong week, a class it misread — open this folder in Claude Code and say so.',
    `- To update the app later: close it, open this folder in Claude Code and say "update Slate" — node scripts/update.mjs swaps in the newest release here and keeps the notes, courses and settings.`].join('\n'), { ok: true, missing })
}
// ---- an earlier copy, carried over (SPEC §21.14) -----------------------------------------------------------------------
// A copy installed before the releases (a zip by hand) has no update.mjs, may run its morning on the command line tool, and
// may keep its notes in its own folder: the old guide put the kit in Documents and the notes defaulted to Documents/Slate.
// The new copy is installed beside it, and `adopt` takes over what is not bound to a folder — the notes, the course file,
// the Quercus key, the first run — switches the earlier morning check off, and when the notes are the earlier folder
// itself, moves that folder's code out so only the notes are left there. Nothing of the notes moves. What is bound to a
// folder (deps, speech, app, schedule, finish) stays for the steps, which are quick. --undo puts the earlier copy back.
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const expand = p => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p)
function earlier(dir) {
  if (!dir) return null
  const folder = path.resolve(expand(String(dir)))
  try { if (!fs.statSync(folder).isDirectory()) return null } catch { return null }
  const kit = readJson(path.join(folder, 'kit.json')), cfg = readJson(path.join(folder, 'slate.config.json'))
  if (!kit?.edition && !cfg?.root) return null
  let notes = cfg?.root ? path.resolve(expand(cfg.root)) : null
  // a folder renamed after setup ("Slate (old)"): its config names a path that is gone, or is now the new copy — no Hub
  // there either way — and the notes were this folder itself
  if ((!notes || !fs.existsSync(path.join(notes, 'Hub'))) && fs.existsSync(path.join(folder, 'Hub'))) notes = folder
  return { folder, kit, notes: notes && fs.existsSync(path.join(notes, 'Hub')) ? notes : null, state: readJson(path.join(folder, 'setup-state.json')) }
}
// Where an earlier copy says it lives — its morning check (a Claude-app task, a launchd agent, a Task Scheduler task) —
// and where the guides put it. Only copies that were set up (a notes folder with a Hub) count.
const TASK_IDS_ALL = [...new Set(['adphi', 'adphi-max', ED.key].flatMap(k => [`slate-${k}-morning`, `slate-${k}-review`]))]
function earlierCopies() {
  const seen = new Set([real(REPO)]), found = []
  const add = p => { const e = earlier(p); if (!e?.notes || seen.has(real(e.folder))) return; seen.add(real(e.folder)); found.push(e) }
  const unxml = s => s && s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  for (const id of TASK_IDS_ALL) { try { add(/Work in (.+?)\.\s*$/m.exec(fs.readFileSync(taskFile(id), 'utf8'))?.[1]) } catch { } }
  if (WIN) { try { const b = fs.readFileSync(path.join(LOCAL_APP, ED.app.replace(/\s+/g, ''), 'tasks', 'morning.xml')); add(unxml(/<WorkingDirectory>([^<]+)</.exec(b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8'))?.[1])) } catch { } }
  else { try { add(unxml(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)</.exec(fs.readFileSync(path.join(HOME, 'Library', 'LaunchAgents', `${ED.bundleId}.morning.plist`), 'utf8'))?.[1])) } catch { } }
  for (const p of [path.join(documentsDir(), 'Slate'), path.join(HOME, 'Documents', 'Slate'), path.join(HOME, 'Slate'), path.join(HOME, 'Slate (old)'), path.join(desktopDir(), 'Slate'), path.join(HOME, 'Desktop', 'Slate')]) add(p)
  return found
}
// What an installed copy's folder holds besides notes: the files it shipped with (its kit.json names them, and this
// copy's names the same tree) and what setup made there. The notes' own contract file is theirs, never the kit's.
function codeNames(e) {
  const names = new Set(['kit.json', 'courses.json', 'slate.config.json', 'setup-state.json', 'Setup progress.md', 'setup-downloads', 'node_modules', 'dist', '.claude', '.gitignore', 'Read me first.html'])
  for (const k of [e.kit, readJson(path.join(REPO, 'kit.json'))]) for (const rel of Object.keys(k?.files || {})) names.add(rel.split('/')[0])
  return names
}
// A rename where it can (instant, even for node_modules); a copy and a removal across disks.
function moveEntry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try { fs.renameSync(from, to) } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true }); fs.rmSync(from, { recursive: true, force: true }) }
}
async function appOpenOn(e) {
  for (let p = ED.port || 5178, n = 0; n < 20; p++, n++) {
    try { const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) }); if (!r.ok) continue; const h = await r.json(); if ((h.repo && real(h.repo) === real(e.folder)) || (h.root && real(h.root) === real(e.notes))) return true } catch { }
  }
  return false
}
function checkRunningIn(notes) {
  try { const l = readJson(path.join(notes, 'Hub', '_runs.lock')); if (!l?.pid) return false; process.kill(l.pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}
async function adopt() {
  if (args.includes('--undo')) return adoptUndo()
  const e = earlier(sub)
  if (!e) { const f = earlierCopies(); fail(`${sub ? `${sub} is not a Slate folder that was set up (no kit.json or slate.config.json in it).` : 'Name the earlier Slate folder.'} ${f.length ? `Found: ${f.map(x => `"${x.folder}"`).join(', ')}.` : 'Ask them where it is — the folder they opened in Claude Code to set it up.'} Then: node scripts/setup.mjs adopt "<that folder>"`, { reason: 'not-slate' }) }
  if (clash(e.folder)) fail(`${e.folder} ${clash(e.folder)} this folder: the earlier copy is a different folder, beside this one.`, { reason: 'same' })
  if (state.adopted) fail(`This copy already carried over ${state.adopted.from}. To carry over another: node scripts/setup.mjs adopt --undo first.`, { reason: 'adopted' })
  if (!e.notes) fail(`The copy in ${e.folder} never got as far as a notes folder, so there is nothing to carry over: set this one up from the start (node scripts/setup.mjs status).`, { reason: 'no-notes' })
  if (clash(e.notes)) fail(`The earlier notes (${e.notes}) ${clash(e.notes)} this folder, which is the app itself. Make a support report.`, { reason: 'notes-here' })
  if (state.done.notes && root() && real(root()) !== real(e.notes) && !args.includes('--force')) fail(`This copy already has its own notes, in ${root()}. Carrying over would point it at ${e.notes} instead. Ask them; if that is what they want: node scripts/setup.mjs adopt "${e.folder}" --force`, { reason: 'own-notes' })
  if (await appOpenOn(e)) fail(`The earlier ${ED.app} is open. Ask them to close it (${WIN ? 'right-click the crest in the taskbar → Close window' : 'the crest in the Dock → Quit'}), then run this again.`, { reason: 'app-open' })
  if (checkRunningIn(e.notes)) fail('A Quercus check is running in the earlier copy right now. Try again when it has finished (a few minutes).', { reason: 'check-running' })

  // 1. Notes and code apart: when the notes are the earlier folder itself (or hold it, or sit in it), its code moves out
  // into this copy's setup-downloads, and the notes stay exactly where they are. First, so a move that fails leaves the
  // earlier copy exactly as it was.
  let moved = null
  if (real(e.notes) === real(e.folder) || within(e.folder, e.notes) || within(e.notes, e.folder)) {
    const code = codeNames(e), to = path.join(REPO, 'setup-downloads', `earlier-copy-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`), names = []
    try {
      for (const name of fs.readdirSync(e.folder)) {
        const from = path.join(e.folder, name)
        if (!code.has(name) || within(from, e.notes)) continue
        if (name === 'CLAUDE.md' && /<!-- slate:contract v\d+/.test(fs.readFileSync(from, 'utf8'))) continue
        moveEntry(from, path.join(to, name)); names.push(name)
      }
    } catch (err) {
      for (const name of names) { try { moveEntry(path.join(to, name), path.join(e.folder, name)) } catch { } }
      fail(`The earlier copy's code could not be moved out of ${e.folder} (${err.code || err.message}) — usually a file still open in it. Everything was put back. Ask them to close the earlier ${ED.app} and any window showing that folder, then run this again.`, { reason: 'move' })
    }
    moved = { from: e.folder, to, names }
  }
  // 2. The earlier morning check off, so the two never write into the same notes: its launchd agents or Task Scheduler
  // tasks carry the labels this edition uses, and a Claude-app task can only be deleted by the app — it is named.
  const rm = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'schedule.mjs'), 'remove', '--json'], { cwd: REPO, env: ENV, encoding: 'utf8', windowsHide: true })
  const appTasks = TASK_IDS_ALL.filter(id => { try { return !fs.readFileSync(taskFile(id), 'utf8').includes(REPO) } catch { return false } })
  // 3. This copy points at the notes. Their settings keep the cadence they were set up with (as an update does, SPEC §21.11);
  // the edition, the model and the runner are this copy's.
  fs.writeFileSync(CONFIG, JSON.stringify({ root: !WIN && e.notes.startsWith(HOME) ? '~' + e.notes.slice(HOME.length) : e.notes }, null, 2) + '\n')
  const sf = path.join(e.notes, 'Hub', '_settings.json'), before = readJson(sf)
  fs.writeFileSync(sf, JSON.stringify({ ...(before || {}), brain: true, edition: ED.key, budget: ED.budget, cadenceDays: before?.cadenceDays || ED.cadenceDays, model: ED.model || 'sonnet', runner: RUNNER }, null, 2) + '\n')
  const at = new Date().toISOString(), carried = note => ({ at, note, carried: true })
  state.done.notes = carried(`${e.notes.replace(HOME, '~')} (carried over)`)
  // 4. The key: every copy keeps it in the same place (the keychain item, or the DPAPI file under %LOCALAPPDATA%\Slate).
  const auth = quercusAuth(), probe = auth ? await probeToken(auth.token, auth.api) : null
  if (auth && (probe?.ok || probe?.status === 0)) state.done.token = carried(probe?.ok ? `carried over, for ${probe.name || 'the account'}` : 'carried over (not checked: offline)')
  // 5. The first run: the notes' own record of a finished check, or the earlier setup's.
  const ran = (readJson(path.join(e.notes, 'Hub', '_runs.json'))?.runs || []).some(r => r.endedAt) || !!e.state?.done?.['first-run']
  if (ran) state.done['first-run'] = carried('carried over: nothing is fetched twice')
  if (RUNNER !== 'app' && e.state?.done?.claude) state.done.claude = carried('carried over')
  state.adopted = { from: e.folder, at, notes: e.notes, moved, settingsBefore: before, edition: e.kit?.edition || null, os: e.kit?.os || null, builtAt: e.kit?.builtAt || null, tag: e.kit?.tag || null }
  state.notes.push(`${at.slice(0, 10)}: carried over from ${e.folder}`)
  save()
  // 6. The course file: the earlier courses.json (else the copy the notes keep), rendered by this copy's code.
  const src = [path.join(moved ? moved.to : e.folder, 'courses.json'), path.join(e.notes, 'Hub', '_courses.json')].find(p => fs.existsSync(p))
  let courses = null
  if (src) {
    fs.copyFileSync(src, COURSES_JSON)
    const w = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'setup.mjs'), 'courses', 'write'], { cwd: REPO, env: ENV, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 })
    Object.assign(state, readJson(STATE) || {})   // the child wrote the courses step
    if (w.status === 0 && state.done.courses) { state.done.courses.carried = true; save(); courses = 'ok' }
    else courses = String(w.stderr || w.stdout || '').trim().split('\n').slice(-6).join('\n')
  }
  const next = STEPS.find(s => !state.done[s]) || null
  out([`Carried over from ${e.folder}:`,
    `- the notes stay where they are: ${e.notes}${moved ? ` — they shared that folder with the earlier copy's code, which is now in ${path.relative(REPO, moved.to)} (${moved.names.length} item(s)), so only the notes are left there` : ''};`,
    `- the Quercus key: ${state.done.token ? 'found, it works' : auth ? `found but Quercus refused it (${probe?.status}) — the token step asks for a new one` : 'not found on this computer — the token step asks for it (two minutes)'};`,
    `- the course file: ${courses === 'ok' ? 'rendered from their courses.json' : src ? `courses.json is copied here but did not render:\n${courses}\n  Fix courses.json (\`node scripts/courses.mjs check courses.json\`), then \`node scripts/setup.mjs courses write\`` : 'no courses.json in the earlier copy — the courses step writes one'};`,
    `- the first run: ${ran ? 'done already — nothing is fetched twice' : 'not done in the earlier copy — the first-run step does it'};`,
    `- the earlier morning check: ${rm.status === 0 ? `switched off (its ${WIN ? 'Task Scheduler tasks' : 'launchd agents'}, if it had any)` : `could not be switched off: ${String(rm.stderr || rm.stdout).trim().split('\n').pop()}`}${appTasks.length ? `; its task(s) in the Claude app — ${appTasks.join(', ')} — still point at the earlier folder: delete them now with the delete_scheduled_task tool (or Routines in the sidebar); the schedule step makes this copy's own` : ''}.`,
    `Next: node scripts/setup.mjs status — ${next ? `it goes on from ${next}` : 'everything is done'}. Their earlier ${ED.app} no longer opens; the app step builds this one in its place. Once it opens on their courses, the earlier folder ${moved ? `(${e.folder}) is their notes: it stays` : `(${e.folder}) can be deleted — never before, and never the notes (${e.notes})`}.`,
  ].join('\n'), { ok: true, from: e.folder, notes: e.notes, moved: moved ? { to: moved.to, count: moved.names.length } : null, token: !!state.done.token, courses, firstRun: ran, retired: rm.status === 0, appTasks, next })
}
function adoptUndo() {
  const a = state.adopted
  if (!a) fail('Nothing was carried over into this copy, so there is nothing to undo.', { reason: 'nothing' })
  const back = [], left = []
  for (const name of a.moved?.names || []) {
    const from = path.join(a.moved.to, name), to = path.join(a.moved.from, name)
    if (!fs.existsSync(from) || fs.existsSync(to)) { left.push(name); continue }
    moveEntry(from, to); back.push(name)
  }
  if (a.settingsBefore) fs.writeFileSync(path.join(a.notes, 'Hub', '_settings.json'), JSON.stringify(a.settingsBefore, null, 2) + '\n')
  for (const s of Object.keys(state.done)) if (state.done[s]?.carried) delete state.done[s]
  fs.rmSync(CONFIG, { force: true })
  state.notes.push(`${new Date().toISOString().slice(0, 10)}: the carry-over from ${a.from} undone`)
  delete state.adopted; save()
  out(`The earlier copy in ${a.from} has ${a.moved ? `its code back (${back.length} item(s)${left.length ? `; left in ${a.moved.to}: ${left.join(', ')}` : ''})` : 'everything it had'}, and its notes their earlier settings. Its morning check stays off and its app may be this copy's: in ${a.from}, \`node scripts/setup.mjs app\` and \`node scripts/setup.mjs schedule\` put them back.`, { ok: true, back: back.length, left })
}
// The app's server, started the way the app starts it, on a free port of its own; ok once /api/health answers for this folder.
async function serverBoots() {
  const port = 5390 + Math.floor(Math.random() * 90)
  const srv = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], { cwd: REPO, env: { ...ENV, SLATE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let log = ''; srv.stdout.on('data', d => { log += d }); srv.stderr.on('data', d => { log += d })
  let exited = null; srv.on('exit', c => { exited = c })
  try {
    for (let i = 0; i < 120 && exited === null; i++) {
      await new Promise(r => setTimeout(r, 250))
      const h = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => (r.ok ? r.json() : null), () => null)
      if (h?.repo && path.resolve(h.repo) === path.resolve(REPO)) return { ok: true, note: 'the server starts and answers' }
    }
    const last = log.trim().split('\n').filter(Boolean).slice(-2).join(' · ').slice(0, 220)
    return { ok: false, note: exited !== null ? `the server stopped (exit ${exited}): ${last}` : `no answer in 30 s: ${last}` }
  } finally { try { srv.kill() } catch { } }
}
async function doctor() {
  const rows = []
  const add = (what, ok, note = '') => rows.push({ what, ok, note })
  add('node', nodeOk(), `${process.versions.node}${nodeOk() ? '' : ` — ${NODE_MIN.join('.')} or newer needed`}`)
  add('dependencies', fs.existsSync(path.join(REPO, 'node_modules', 'vite')) && fs.existsSync(path.join(REPO, 'node_modules', 'electron', 'dist')), fs.existsSync(path.join(REPO, 'node_modules', 'electron', 'dist')) ? '' : 'electron not downloaded: node scripts/setup.mjs deps')
  const nr = root(); add('notes folder', !!nr && fs.existsSync(nr) && !clash(nr), !nr ? 'slate.config.json missing' : clash(nr) ? `${nr} ${clash(nr)} the app's own folder — an update would delete the notes: make a support report` : nr)
  const auth = quercusAuth(); let probe = null; if (auth) probe = await probeToken(auth.token, auth.api)
  add('quercus key', !!probe?.ok, auth ? (probe?.ok ? `${auth.from}: ${probe.name}` : `${auth.from}: refused (${probe?.status})`) : 'none stored')
  const load = capture(process.execPath, ['-e', "import('./scripts/lib/terms.mjs').then(m => console.log(Object.keys(m.COURSES).length))"])
  add('course file', load !== null && Number(load) > 0, load === null ? 'does not load' : `${load} course(s)`)
  if (RUNNER === 'app') { const t = TASK_IDS.map(id => [id, fs.existsSync(taskFile(id))]); add('scheduled tasks', t.every(([, ok]) => ok), t.map(([id, ok]) => `${id}: ${ok ? 'created' : 'missing'}`).join(', ')) }
  else {
    const bin = findClaude(); const st = bin ? (() => { try { return JSON.parse(capture(bin, ['auth', 'status', '--json'], { env: CLAUDE_ENV }) || 'null') } catch { return null } })() : null
    add('claude cli', !!st?.loggedIn, bin ? (st?.loggedIn ? 'logged in' : 'not logged in') : 'not installed')
  }
  add('app', !!appBundle(), appBundle() || `${ED.app}${WIN ? '.exe' : '.app'} is not ${WIN ? 'installed' : APP_WHERE}`)
  // A double-click that does nothing is almost always the server failing to start (a notes folder it may not write, a
  // dependency missing, code an update left half-built): start it here, as the app would, and ask it who it is.
  add('client built', fs.existsSync(path.join(REPO, 'dist', 'index.html')), fs.existsSync(path.join(REPO, 'dist', 'index.html')) ? '' : 'dist/ is missing: node scripts/setup.mjs app')
  const boot = await serverBoots(); add('app starts', boot.ok, boot.note)
  if (RUNNER !== 'app') {
    const sched = capture(process.execPath, [path.join(REPO, 'scripts', 'schedule.mjs'), 'status', '--json']); let sj = null; try { sj = JSON.parse(sched.trim().split('\n').pop()) } catch { }
    add('schedule', !!sj?.jobs?.every(j => j.loaded), sj ? sj.jobs.map(j => `${j.label.split('.').pop()}: ${j.loaded ? 'loaded' : 'not loaded'}`).join(', ') : 'unknown')
  }
  add('speech', WIN ? true : fs.existsSync(path.join(LOCAL_BIN, 'parakeet-mlx')), WIN ? 'Mac-only, not expected here' : state.machine?.chip === 'Intel' ? 'not on Intel' : fs.existsSync(path.join(LOCAL_BIN, 'parakeet-mlx')) ? '' : 'parakeet-mlx is not in ~/.local/bin: node scripts/setup.mjs speech installs it')
  console.log(rows.map(r => `${r.ok ? 'ok  ' : 'FAIL'} ${r.what.padEnd(14)} ${r.note}`).join('\n'))
  if (JSON_OUT) console.log(JSON.stringify({ step: 'doctor', rows }))
}

if (cmd === 'status' || !cmd) statusReport()
else if (cmd === 'machine') machine()
else if (cmd === 'deps') deps()
else if (cmd === 'notes') notes()
else if (cmd === 'token') await token()
else if (cmd === 'courses' && sub === 'fetch') await coursesFetch()
else if (cmd === 'courses' && sub === 'write') coursesWrite()
else if (cmd === 'claude') claudeStep()
else if (cmd === 'first-run') firstRun()
else if (cmd === 'speech') speech()
else if (cmd === 'app') app()
else if (cmd === 'schedule') schedule()
else if (cmd === 'finish') finish()
else if (cmd === 'doctor') await doctor()
else if (cmd === 'adopt') await adopt()
else { console.error('usage: node scripts/setup.mjs status|machine|deps|notes|token|courses fetch|courses write|claude|first-run|speech|app|schedule|finish|doctor|adopt "<earlier folder>" [--undo]'); process.exit(2) }
