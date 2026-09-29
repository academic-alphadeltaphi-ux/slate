// slate as a desktop app: one Electron window over the same Express server and the built client.
// The app is a launcher tied to the repo (REPO below is written by scripts/build-app.mjs), so the
// notes root, the server and the client are exactly what `npm run dev` uses, on its own port.
const { app, BrowserWindow, shell, nativeTheme, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const { pathToFileURL } = require('node:url')
const REPO = process.env.SLATE_REPO || path.join(__dirname, '..')
// scripts/build-app.mjs writes the edition's port here. Two editions on one Mac must not share it: the launcher used
// to wait for *any* server on 5177 and load it, so opening the second app showed the first one's notebook, its name
// and its features — a window onto someone else's slate (SPEC §20.47).
const BASE_PORT = Number(process.env.SLATE_PORT || 5177)
// Windows: the taskbar groups windows by this id, and the window wears the crest from the .ico beside this file
// (scripts/build-app.mjs writes both). On a Mac the bundle's Info.plist and .icns do the same job.
const APP_ID = process.env.SLATE_APP_ID || 'slate.notebook'
const ICON = fs.existsSync(path.join(__dirname, 'slate.ico')) ? path.join(__dirname, 'slate.ico') : undefined
const WIN = process.platform === 'win32'
let mainWin = null

const sleep = ms => new Promise(r => setTimeout(r, ms))
const free = port => new Promise(resolve => {
  const s = net.createServer()
  s.once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1')
})
// The first port from BASE_PORT that nothing else holds, so a second copy opens beside the first rather than onto it.
async function pickPort() {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) if (await free(p)) return p
  throw new Error(`no free port from ${BASE_PORT}`)
}
// And once it is up, check the server that answered is *ours* — same repo — not a stranger that grabbed the port in
// between. A wrong answer here is worse than no answer: it looks like the app works.
async function waitForServer(port, ms = 45000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) {
        const h = await r.json().catch(() => ({}))
        if (h.repo && path.resolve(h.repo) === path.resolve(REPO)) return   // ours; anything else, including a server too old to say, is not
        throw new Error(`port ${port} is serving ${h.repo}, not ${REPO}`)
      }
    } catch (e) { if (String(e.message).includes('is serving')) throw e }
    await sleep(150)
  }
  throw new Error('slate server did not start')
}
async function main() {
  const PORT = await pickPort()
  process.env.SLATE_PORT = String(PORT)
  process.chdir(REPO)
  // A file:// URL, never a bare path: on Windows the ESM loader refuses `C:\…` ("Received protocol 'c:'") — the first
  // thing a brother's Surface said (SPEC §21.9).
  const server = await import(pathToFileURL(path.join(REPO, 'server', 'index.js')).href)
  // The import resolves before the server has booted; `ready` is the boot itself. A boot that fails (a notes folder it
  // cannot read or write, a full disk) rejects it, and the window below says why — not a silent 45-second wait for a port
  // that will never answer. A boot still busy after 45 seconds is left to waitForServer, as before.
  if (server.ready) await Promise.race([server.ready, sleep(45000)])
  await waitForServer(PORT)
  const win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 900, minHeight: 600, show: false, icon: ICON,
    // A Mac keeps its traffic lights, inset over the page's own top bar. On Windows any titleBarStyle but the default drops
    // the frame and, with it, minimise, maximise and close (review 2026-09-29): a PC gets the ordinary frame, its menu bar
    // folded away until Alt.
    ...(WIN ? { autoHideMenuBar: true } : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151618' : '#e7e6e2',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  mainWin = win
  // The page draws the hidden title bar's chrome — a 42px gutter for the traffic lights, bars that drag the window — when
  // its user agent says Electron (src/main.jsx). Inside a Windows frame that is an empty strip and dead bars: without the
  // word, it lays itself out as it does in a browser.
  if (WIN) win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/\S+/, ''))
  win.once('ready-to-show', () => win.show())
  // Closing the window inside the editor's half-second save debounce lost the last edit (review of 2026-09-18): ask the
  // page to flush every pending save first, then close for real — two seconds at most, so a stuck save never traps the window.
  let flushed = false
  win.on('close', e => {
    if (flushed) return
    e.preventDefault()
    const go = () => { flushed = true; win.close() }
    Promise.race([win.webContents.executeJavaScript('window.__slateFlush ? window.__slateFlush() : true', true).catch(() => { }), sleep(2000)]).then(go, go)
  })
  win.loadURL(`http://127.0.0.1:${PORT}/`)
  // Links and "Open in a new tab" go to the default browser; the app stays one window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${PORT}`)) { e.preventDefault(); shell.openExternal(url) } })
}
if (WIN) app.setAppUserModelId(APP_ID)
// Windows: a second double-click on the shortcut started a second process, a second server on the next port and a second
// writer over the same notes. One lock; the second copy hands over and quits, and the first comes forward. Not on a Mac,
// where opening an app that is running only brings it forward, and two editions are two apps that must both open (SPEC §20.47).
const first = !WIN || app.requestSingleInstanceLock()
if (!first) app.quit()
app.on('second-instance', () => { if (!mainWin) return; if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus() })
// A double-click that seems to do nothing is the worst outcome (SPEC §21.8): say what went wrong, in a window, then leave.
// The app has no console: what went wrong is also written to setup-downloads/app.log in the Slate folder, where their
// Claude reads it (kit CLAUDE.md, "the app doesn't open") — a dialog closed unread is otherwise gone.
const logFailure = e => { try { const d = path.join(REPO, 'setup-downloads'); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, 'app.log'), `${new Date().toISOString()} ${app.getName()} could not start: ${e?.stack || e}\n`) } catch { } }
if (first) app.whenReady().then(main).catch(e => {
  console.error(e); logFailure(e)
  const advice = process.platform === 'win32'
    ? 'Open the Slate folder in Claude Code (the Code tab of the Claude app) and say what happened, with the line above.'
    : "If macOS asked whether the app may access a folder and the answer was Don't Allow: System Settings → Privacy & Security → Files and Folders → allow it, then open the app again. Otherwise open the Slate folder in Claude Code and say what happened."
  try { dialog.showErrorBox(`${app.getName()} could not start`, `${e.message}\n\n${advice}`) } catch { }
  app.quit()
})
app.on('window-all-closed', () => app.quit())
