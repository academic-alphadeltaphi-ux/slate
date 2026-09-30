#!/usr/bin/env node
// Build Slate.app: vite build → dist/, an icon from desktop/icon.svg, and a copy of Electron's
// bundle renamed and pointed at this repo. Installs to /Applications (or ~/Applications) — or onto the Desktop where the
// edition says so (SPEC §21: the brothers double-click it there).
//   node scripts/build-app.mjs [--no-build] [--dest /path]
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIN, REAL_WIN, LOCAL_APP, desktopDir, powershell } from './lib/platform.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
// The bundle is named for the edition (SPEC §20.41), so a brother's copy is "Slate ADPhi.app" beside any other.
const { THIS: ED } = await import('../src/edition.js')
const { hasDevTools } = await import('../server/devtools.js')
const APP_NAME = ED.app, BUNDLE_ID = ED.bundleId
// SLATE_APP_DEST: where the simulation puts the bundle instead of the real Applications folder.
const destDir = args.includes('--dest') ? args[args.indexOf('--dest') + 1] : process.env.SLATE_APP_DEST || (ED.appDir === 'Desktop' ? path.join(os.homedir(), 'Desktop') : isWritable('/Applications') ? '/Applications' : path.join(os.homedir(), 'Applications'))
const APP = path.join(destDir, `${APP_NAME}.app`)
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', cwd: REPO, ...opts })
function isWritable(p) { try { fs.accessSync(p, fs.constants.W_OK); return true } catch { return false } }

if (!args.includes('--no-build')) { const b = spawnSync(REAL_WIN ? 'npx.cmd' : 'npx', ['vite', 'build'], { stdio: 'inherit', cwd: REPO, shell: REAL_WIN }); if (b.status !== 0) process.exit(1) }
// The handwriting helper (SPEC §20.9): Slate.app runs the server from the repo, so it finds desktop/hwr/bin/hwr there;
// nothing is copied into the bundle. Non-fatal: without it the server uses the Python path if uv is installed.
// Without the developer tools the compiler is an install dialog (server/devtools.js): the helper is simply not built.
if (!WIN && hasDevTools()) { try { run('node', ['scripts/build-hwr.mjs']) } catch { console.warn('handwriting helper not built (see above); the app will use the Python path if uv is installed, else report recognition as unavailable') } }
else if (!WIN) console.log('no developer tools on this Mac: handwriting helper not built; the app uses the uv path when uv is installed')

// ---- Windows (SPEC §21.7): Electron's win32 folder, the exe renamed, our launcher and icon inside, a shortcut on the Desktop
if (WIN) {
  const dist = process.env.SLATE_ELECTRON_DIST || path.join(REPO, 'node_modules', 'electron', 'dist')
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) { console.error('electron for Windows is not installed: run node scripts/setup.mjs deps'); process.exit(1) }
  const dir = args.includes('--dest') ? path.join(args[args.indexOf('--dest') + 1], APP_NAME) : path.join(process.env.SLATE_APP_DEST || path.join(LOCAL_APP, 'Programs'), APP_NAME)
  // Windows keeps a running program's files locked, and CLAUDE.md sends them here after every course change and update —
  // often with the app open. Deleting in place then failed halfway (EBUSY/EPERM: "the bundle could not be made") and left
  // a broken copy behind the shortcut. So the old folder is moved aside first: a move that fails means the app is open and
  // nothing has been touched yet; a move that works frees the name, and the old copy is deleted after, or next time.
  const aside = `${dir}.old`, locked = e => ['EBUSY', 'EPERM', 'EACCES'].includes(e?.code)
  try { fs.rmSync(aside, { recursive: true, force: true }); if (fs.existsSync(dir)) fs.renameSync(dir, aside) }
  catch (e) { if (!locked(e)) throw e; console.error(`${APP_NAME} is open, and Windows keeps a running program's files locked. Close its window (and wait a few seconds), then run this step again.`); process.exit(1) }
  try { fs.rmSync(aside, { recursive: true, force: true }) } catch { }
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(dist, dir, { recursive: true })
  const exePath = path.join(dir, `${APP_NAME}.exe`)
  fs.renameSync(path.join(dir, 'electron.exe'), exePath)
  const res = path.join(dir, 'resources')
  fs.rmSync(path.join(res, 'default_app.asar'), { force: true })
  fs.mkdirSync(path.join(res, 'app'), { recursive: true })
  let main = fs.readFileSync(path.join(REPO, 'desktop', 'main.cjs'), 'utf8')
  main = main.replace("const REPO = process.env.SLATE_REPO || path.join(__dirname, '..')", `const REPO = process.env.SLATE_REPO || ${JSON.stringify(REPO)}`)
    .replace("const BASE_PORT = Number(process.env.SLATE_PORT || 5177)", `const BASE_PORT = Number(process.env.SLATE_PORT || ${ED.port || 5177})`)
    .replace("const APP_ID = process.env.SLATE_APP_ID || 'slate.notebook'", `const APP_ID = process.env.SLATE_APP_ID || ${JSON.stringify(BUNDLE_ID)}`)
  fs.writeFileSync(path.join(res, 'app', 'main.cjs'), main)
  fs.writeFileSync(path.join(res, 'app', 'package.json'), JSON.stringify({ name: APP_NAME, productName: APP_NAME, version: '0.4.0', main: 'main.cjs' }, null, 2))
  fs.writeFileSync(path.join(res, 'app', 'repo.json'), JSON.stringify({ repo: REPO }))
  const ico = path.join(REPO, 'public', 'brand', 'adphi-crest.ico'), icoDest = path.join(res, 'app', 'slate.ico')
  if (ED.crest && fs.existsSync(ico)) fs.copyFileSync(ico, icoDest)
  // the shortcut on the Desktop, with the crest: what they double-click
  const lnk = path.join(desktopDir(), `${APP_NAME}.lnk`)
  powershell("$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($env:SLATE_LNK); $s.TargetPath = $env:SLATE_EXE; $s.WorkingDirectory = $env:SLATE_DIR; if ($env:SLATE_ICO) { $s.IconLocation = $env:SLATE_ICO + ',0' }; $s.Description = $env:SLATE_DESC; $s.Save()", { env: { ...process.env, SLATE_LNK: lnk, SLATE_EXE: exePath, SLATE_DIR: dir, SLATE_ICO: fs.existsSync(icoDest) ? icoDest : '', SLATE_DESC: ED.name } })
  console.log(`\nBuilt ${exePath}\nShortcut on the Desktop: ${lnk}`)
  process.exit(0)
}

// Icon: SVG → 1024 PNG → iconset → icns. Rendered by Electron with a transparent window (scripts/render-icon.cjs);
// `qlmanage -t` used to do this, but it is Quick Look's thumbnail generator — it composites onto white and frames
// the result, which is where the white border around the icon came from.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-icon-'))
const png1024 = path.join(tmp, 'icon.png')
// An edition with a crest gets its own icon: the template in desktop/icon-adphi.svg with the crest embedded (SPEC §21).
let iconSvg = path.join(REPO, 'desktop', 'icon.svg')
if (ED.crest) {
  const crest = fs.readFileSync(path.join(REPO, 'public', ED.crest)).toString('base64')
  iconSvg = path.join(tmp, 'icon-edition.svg')
  // every {{CREST}}, not the first: the template's comment named it before the <image>, the crest went into the comment, and
  // every copy's icon was a broken-image placeholder (found 2026-09-29, rendering the icon to look at it)
  fs.writeFileSync(iconSvg, fs.readFileSync(path.join(REPO, 'desktop', 'icon-adphi.svg'), 'utf8').split('{{CREST}}').join(crest))
}
run(path.join(REPO, 'node_modules', '.bin', 'electron'), [path.join(REPO, 'scripts', 'render-icon.cjs'), iconSvg, png1024], { stdio: 'ignore' })
if (!fs.existsSync(png1024)) throw new Error('icon render produced nothing — is electron installed?')
const iconset = path.join(tmp, 'slate.iconset'); fs.mkdirSync(iconset)
for (const [name, size] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]])
  run('sips', ['-z', String(size), String(size), png1024, '--out', path.join(iconset, name + '.png')], { stdio: 'ignore' })
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(tmp, 'slate.icns')])

// Bundle: Electron.app → Slate.app, our launcher as the app, our name and icon in Info.plist.
const electronApp = path.join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app')
if (!fs.existsSync(electronApp)) { console.error('electron is not installed: npm install --save-dev electron'); process.exit(1) }
fs.mkdirSync(destDir, { recursive: true })   // a --dest that does not exist yet is not an error, it is a new folder
fs.rmSync(APP, { recursive: true, force: true })
run('cp', ['-R', electronApp, APP])
const res = path.join(APP, 'Contents', 'Resources')
fs.rmSync(path.join(res, 'default_app.asar'), { force: true })
fs.mkdirSync(path.join(res, 'app'), { recursive: true })
fs.copyFileSync(path.join(REPO, 'desktop', 'main.cjs'), path.join(res, 'app', 'main.cjs'))
fs.writeFileSync(path.join(res, 'app', 'package.json'), JSON.stringify({ name: APP_NAME, productName: APP_NAME, version: '0.4.0', main: 'main.cjs' }, null, 2))
fs.writeFileSync(path.join(res, 'app', 'repo.json'), JSON.stringify({ repo: REPO }))
fs.copyFileSync(path.join(tmp, 'slate.icns'), path.join(res, 'slate.icns'))
fs.rmSync(path.join(res, 'electron.icns'), { force: true })
const plist = path.join(APP, 'Contents', 'Info.plist')
for (const [k, v] of [['CFBundleName', APP_NAME], ['CFBundleDisplayName', APP_NAME], ['CFBundleIdentifier', BUNDLE_ID], ['CFBundleIconFile', 'slate.icns'], ['CFBundleExecutable', APP_NAME], ['CFBundleShortVersionString', '0.4.0'], ['CFBundleVersion', '0.4.0'], ['NSHumanReadableCopyright', ED.copyright]])
  run('plutil', ['-replace', k, '-string', v, plist])
fs.renameSync(path.join(APP, 'Contents', 'MacOS', 'Electron'), path.join(APP, 'Contents', 'MacOS', APP_NAME))
// The launcher must know where the repo is; the bundle sits outside it.
let main = fs.readFileSync(path.join(res, 'app', 'main.cjs'), 'utf8')
main = main.replace("const REPO = process.env.SLATE_REPO || path.join(__dirname, '..')", `const REPO = process.env.SLATE_REPO || ${JSON.stringify(REPO)}`)
// The edition's own port, so two editions installed on one Mac each open their own slate (SPEC §20.47).
main = main.replace("const BASE_PORT = Number(process.env.SLATE_PORT || 5177)", `const BASE_PORT = Number(process.env.SLATE_PORT || ${ED.port || 5177})`)
fs.writeFileSync(path.join(res, 'app', 'main.cjs'), main)
// A modified bundle needs a fresh (ad-hoc) signature or macOS refuses to open it.
run('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'ignore' })
run('touch', [APP])
// A real install of an edition that lives on the Desktop: an earlier build of the same app in an Applications folder
// would be a second copy, pointing at an older kit. Not in a simulation (SLATE_APP_DEST) and not for an explicit --dest.
if (ED.appDir === 'Desktop' && !args.includes('--dest') && !process.env.SLATE_APP_DEST)
  for (const old of ['/Applications', path.join(os.homedir(), 'Applications')].map(d => path.join(d, `${APP_NAME}.app`)))
    if (fs.existsSync(old)) { fs.rmSync(old, { recursive: true, force: true }); console.log(`removed the earlier ${old}`) }
console.log(`\nBuilt ${APP}\nDouble-click it${WIN ? '' : `, or: open -a "${APP}"`}`)   // the form the kit's permissions allow
