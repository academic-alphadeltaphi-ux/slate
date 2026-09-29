// What differs between a Mac and a Windows PC, in one place (SPEC §21.7, 2026-09-23).
//
// slate was a Mac program: launchd, the keychain, an .app bundle, Apple's developer-tools guard. a brother's copy runs on
// Windows, so every script asks here instead of assuming. Two truths are kept apart on purpose:
//   WIN       the platform the install *is* for — which folders, which credential store, which scheduler, which words.
//             The scenario harness sets SLATE_SIM_PLATFORM=win32 on a Mac to walk the Windows road without a PC.
//   REAL_WIN  the platform this process actually runs on — only for the mechanics of spawning (npm is a .cmd file on
//             Windows and needs a shell; a .sh stand-in on a Mac does not).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync, spawnSync } from 'node:child_process'

export const PLATFORM = process.env.SLATE_SIM_PLATFORM || process.platform
export const WIN = PLATFORM === 'win32'
export const REAL_WIN = process.platform === 'win32'
export const HOME = os.homedir()
// The Claude CLI's and uv's own folder, on both systems (claude.ai/install.ps1 puts claude.exe in %USERPROFILE%\.local\bin).
export const LOCAL_BIN = path.join(HOME, '.local', 'bin')
// Per-user application data: ~/Library/Application Support on a Mac, %LOCALAPPDATA% on Windows.
export const LOCAL_APP = WIN ? (process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')) : path.join(HOME, 'Library', 'Application Support')
export const ROAMING_APP = WIN ? (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')) : LOCAL_APP
export const exe = name => (WIN ? `${name}.exe` : name)

// Windows may keep the Desktop and Documents inside OneDrive ("Known Folder Move"); ask the shell where they are rather
// than guessing ~/Desktop. SLATE_DESKTOP_DIR / SLATE_DOCUMENTS_DIR override for a simulation.
const known = new Map()
export function knownFolder(name) {
  const plain = name === 'MyDocuments' ? 'Documents' : 'Desktop'
  const override = process.env[name === 'MyDocuments' ? 'SLATE_DOCUMENTS_DIR' : 'SLATE_DESKTOP_DIR']
  if (override) return override
  if (!WIN) return path.join(HOME, plain)
  if (known.has(name)) return known.get(name)
  let p = null
  try { p = powershell(`[Environment]::GetFolderPath('${name}')`).trim() || null } catch { p = null }
  if (!p || !path.isAbsolute(p)) p = path.join(HOME, plain)
  known.set(name, p)
  return p
}
export const desktopDir = () => knownFolder('Desktop')
export const documentsDir = () => knownFolder('MyDocuments')

export const claudeCandidates = () => (WIN
  ? [path.join(LOCAL_BIN, 'claude.exe'), path.join(ROAMING_APP, 'npm', 'claude.cmd'), path.join(LOCAL_APP, 'Programs', 'claude', 'claude.exe')]
  : [path.join(LOCAL_BIN, 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'])
export const uvCandidates = () => (WIN
  ? [path.join(LOCAL_BIN, 'uv.exe'), path.join(HOME, '.cargo', 'bin', 'uv.exe')]
  : [path.join(LOCAL_BIN, 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv'])
// SLATE_CLAUDE_BIN names another command line tool (the scenarios' stand-in); set but missing means "not installed".
export const findClaude = () => (process.env.SLATE_CLAUDE_BIN ? (fs.existsSync(process.env.SLATE_CLAUDE_BIN) ? process.env.SLATE_CLAUDE_BIN : null) : claudeCandidates().find(p => fs.existsSync(p)) || null)
export const findUv = () => uvCandidates().find(p => fs.existsSync(p)) || null
// uv's own Pythons on Windows (%APPDATA%\uv\python\cpython-3.x.y-windows-…\python.exe), newest first. On a brother's PC uv's
// check of the minor-version link (cpython-3.14 → cpython-3.14.7) failed with "Missing expected target directory", and
// every command that let uv pick its Python failed with it; naming the interpreter by full path went round it (2026-09-24).
export function uvPythons() {
  const dir = process.env.UV_PYTHON_INSTALL_DIR || (WIN ? path.join(ROAMING_APP, 'uv', 'python') : path.join(HOME, '.local', 'share', 'uv', 'python'))
  let names = []; try { names = fs.readdirSync(dir).filter(n => /^cpython-\d+\.\d+\.\d+-/.test(n)) } catch { return [] }
  const ver = n => n.split('-')[1].split('.').map(Number)
  names.sort((a, b) => { const x = ver(a), y = ver(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] })
  return names.map(n => path.join(dir, n, WIN ? 'python.exe' : path.join('bin', 'python3'))).filter(p => fs.existsSync(p))
}

// A file or folder name the platform will accept, from a title someone else wrote (a professor's file name, an
// announcement, a page). A Mac refuses `/` and `:` (Finder's `/`); Windows also refuses `* ? " < > |`, control characters,
// a trailing dot or space, and the device names CON, PRN, AUX, NUL, COM1–9, LPT1–9 — and a long path, hence 80 not 120.
// There was one copy of this per script and only quercus-sync's knew about Windows: a `?` in a PSY210 file name crashed
// the sweep on a brother's PC (2026-09-24), and audit.mjs, cleaning names its own way, could not find the pages sync had
// written. One function now, and the names it gave before are the names it gives now: nothing on disk is renamed.
export function safeName(s, max = WIN ? 80 : 120) {
  let t = String(s ?? '').replace(/[\/\\:]/g, '-')
  if (WIN) t = t.replace(/[*?"<>|]/g, '-')
  t = t.replace(/\s+/g, ' ')
  if (WIN) t = t.replace(/[\x00-\x1f]/g, '-')
  t = t.trim().slice(0, max)
  if (WIN) { t = t.replace(/[. ]+$/, ''); if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(t)) t = '_' + t }
  return t
}
// What Windows refuses in a name a person typed (a page title): the check, not the repair.
export const badNameChars = s => (WIN ? /[<>:"/\\|?*\x00-\x1f]|[. ]$/ : /[\/\\:\x00-\x1f]/).test(String(s))
// Electron 44 declares node >= 22.12 (its installer and @electron/get need it); setup's floor follows it.
export const NODE_MIN = [22, 12]
export const nodeOk = (v = process.versions.node) => { const [a, b] = v.split('.').map(Number); return a > NODE_MIN[0] || (a === NODE_MIN[0] && b >= NODE_MIN[1]) }

// The PATH a child gets: the CLI's and uv's folder first, then Homebrew's two prefixes on a Mac, then whatever we had.
export const childPath = () => [LOCAL_BIN, ...(WIN ? [] : ['/usr/local/bin', '/opt/homebrew/bin']), process.env.PATH || ''].join(path.delimiter)

// npm and npx are .cmd files on Windows, and node refuses to spawn a .cmd without a shell (since 20.12). Arguments here
// are simple words, so the shell's own quoting never comes into it.
export const npmSpawn = (bin, args, opts = {}) => (REAL_WIN ? spawnSync(`${bin}.cmd`, args, { shell: true, ...opts }) : spawnSync(bin, args, opts))

// spawnable(bin, args) → { file, args, opts }: how to start any program with any arguments —
//   const s = spawnable(bin, args); spawn(s.file, s.args, { ...yourOpts, ...s.opts })
// A Claude CLI installed with npm is %APPDATA%\npm\claude.cmd, and node refuses to spawn a .cmd or .bat without a shell
// (EINVAL, since 20.12) — so its `auth status` failed and setup said "installed but NOT logged in" for ever. A shell is
// no answer for the sessions: cmd.exe cannot carry a newline in an argument (a prompt has hundreds), stops at 8191
// characters, and re-reads `( ) " %` in `Bash(node scripts/brain.mjs:*)` and a JSON --mcp-config. What npm's shim runs
// is plain: `"%dp0%\node_modules\…\cli.js" %*` with node (or an .exe) — so read the shim and start that, no shell, the
// arguments passed exactly. Only a batch file that is not npm's goes through cmd.exe, each part quoted and its
// metacharacters escaped the way cross-spawn does it (twice: a shim's %* is parsed a second time); newlines cannot
// cross that road. Anything else — claude.exe, uv.exe, a Mac — is started as it is.
export function spawnable(bin, args = []) {
  if (!REAL_WIN || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, opts: {} }
  const dir = path.dirname(bin)
  let target = null; try { target = [...fs.readFileSync(bin, 'utf8').matchAll(/"%~?dp0%?\\([^"%]+)"/g)].map(m => path.join(dir, m[1])).filter(p => !/\\node\.exe$/i.test(p)).pop() || null } catch { }
  if (target && /\.[cm]?js$/i.test(target) && fs.existsSync(target)) {
    // the shim's own node.exe when it has one, else the node running this — unless that is Electron, where `node` from PATH is
    const node = fs.existsSync(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : process.versions.electron ? 'node' : process.execPath
    return { file: node, args: [target, ...args], opts: {} }
  }
  if (target && /\.exe$/i.test(target) && fs.existsSync(target)) return { file: target, args, opts: {} }
  const meta = /([()\][%!^"`<>&|;, *?])/g
  const arg = a => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(meta, '^$1').replace(meta, '^$1')
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[bin.replace(meta, '^$1'), ...args.map(arg)].join(' ')}"`], opts: { windowsVerbatimArguments: true } }
}

// Windows PowerShell (5.1, on every Windows 10/11) for the few things node cannot do itself: DPAPI, a shortcut, a
// toast, the known folders. Values go in through the environment, never on the command line. Two things every call
// needs (review 2026-09-29): windowsHide, or the Electron app — which has no console — flashes a console window each
// time it reads the key; and UTF-8 out. PowerShell 5.1 writes a pipe in the console's code page (850, 1252…), which
// node read as UTF-8, so a user or OneDrive folder with an accent (Documents of "Hélène") came back garbled — a wrong
// notes folder, a shortcut Save() that threw. Its own new console (windowsHide gives it one) is the only one it changes.
const PS_UTF8 = 'try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }; '
export const powershell = (script, opts = {}) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8 + script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts })

// What this computer is, in the words setup prints.
export function machineInfo() {
  const node = process.versions.node
  if (WIN) {
    const [maj, , build] = (process.env.SLATE_SIM_WINDOWS || os.release()).split('.').map(Number)   // SLATE_SIM_WINDOWS: the scenarios' pretend version
    return { os: 'windows', version: process.env.SLATE_SIM_WINDOWS || os.release(), build: build || 0, tooOld: !(maj >= 10 && (build || 0) >= 17763), chip: (process.env.SLATE_SIM_ARCH || os.arch()) === 'arm64' ? 'ARM' : 'x64', node, gitBash: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].some(p => fs.existsSync(p)) }
  }
  return { os: 'macos', node }
}

// A notification from the scheduled run: osascript on a Mac, a toast through PowerShell on Windows. Never fatal.
// Windows drops, without a word, a toast whose notifier id no Start-menu shortcut registers — and the title was passed as
// that id. Windows PowerShell's own id is registered on every Windows 10/11 (its Start-menu shortcut carries it; the
// BurntToast module uses it too), so the toast says "Windows PowerShell" under the title and is shown.
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
export function notify(text, title) {
  try {
    if (WIN) execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode($env:SLATE_TITLE)) > $null; $x.Item(1).AppendChild($t.CreateTextNode($env:SLATE_TEXT)) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:SLATE_AUMID).Show([Windows.UI.Notifications.ToastNotification]::new($t))"], { env: { ...process.env, SLATE_TITLE: String(title), SLATE_TEXT: String(text), SLATE_AUMID: PS_AUMID }, windowsHide: true }, () => { })
    else execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], () => { })
  } catch { }
}
