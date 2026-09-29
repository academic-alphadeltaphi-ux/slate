// The printer core (SPEC §20.10): one hidden Electron window prints every page of a manifest through the
// app's own print view (`/?print=<page>&export=1`), waiting for the view's readiness flag, and reports one
// line per step through `onLine`. Two callers share it: scripts/print-pages.cjs (a standalone Electron
// process, spawned by the server under `node server/index.js`) and server/routes/export.js directly when the
// server already runs inside Slate.app's main process (Electron launching Electron is what we avoid there).
//
// Why Electron and not `chrome --headless --print-to-pdf` like render-sheet.mjs: verified 2026-09-09 that
// Chrome's --virtual-time-budget fast-forwards the main thread only; pdf.js renders in a worker, so the
// print fired on "Loading PDF…" every time. Here we wait on the page's own signal and `printToPDF` honours
// the print view's @page rule (Letter, half-inch margins).
//
// manifest = { timeoutMs?: 90000, pages: [{ path, title, url, file }] }
// lines:  `progress <i> <n> <path>` · `done <i> <bytes>` · `fail <i> <message>` · `exit` | `cancelled`
// printPages(manifest, onLine) → { done: Promise<void>, cancel(): void }
const electron = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// `require('electron')` is the API only in an Electron main process; under ELECTRON_RUN_AS_NODE (or plain
// node) it is the path string of the binary. The export route checks this before using the in-process path.
const available = !!(electron && typeof electron === 'object' && electron.BrowserWindow)

const PRELOAD = path.join(__dirname, '..', 'scripts', 'print-preload.cjs')
// The print view sets data-ready once every PDF page is drawn and every element measured; the preload turns
// window.print into a marker, so a stale client that still calls it counts as ready too; an error bar means
// the page could not load and the printer fails that page instead of waiting for the timeout.
const READY_JS = "document.documentElement.dataset.ready === '1' || document.documentElement.dataset.printCalled === '1' || (document.querySelector('.print-bar')?.textContent || '').startsWith('Could not load')"
const ERROR_JS = "(function(){ const t = document.querySelector('.print-bar')?.textContent || ''; return t.startsWith('Could not load') ? t : '' })()"

const sleep = ms => new Promise(r => setTimeout(r, ms))
const oneLine = e => String((e && e.message) || e || 'unknown error').replace(/\s+/g, ' ').trim()

async function waitReady(win, ms, stop) {
  const t0 = Date.now()
  for (;;) {
    if (stop()) throw new Error('cancelled')
    if (win.isDestroyed()) throw new Error('the printer window was closed')
    let r = false
    try { r = await win.webContents.executeJavaScript(READY_JS, true) } catch { r = false }   // mid-navigation: try again
    if (r === true) return
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for the page to render`)
    await sleep(150)
  }
}

function printPages(manifest, onLine) {
  if (!available) throw new Error('not running inside an Electron main process')
  const { BrowserWindow } = electron
  const pages = Array.isArray(manifest.pages) ? manifest.pages : []
  const timeoutMs = Number(manifest.timeoutMs) || 90000
  let cancelled = false, win = null
  const say = (...a) => { try { onLine(a.join(' ')) } catch { } }
  const stop = () => cancelled

  const done = (async () => {
    win = new BrowserWindow({
      show: false, width: 1300, height: 1000, paintWhenInitiallyHidden: true,
      webPreferences: { preload: PRELOAD, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: false },
    })
    let gone = null
    win.webContents.on('render-process-gone', (e, d) => { gone = new Error('the renderer crashed (' + (d && d.reason) + ')') })
    win.webContents.setAudioMuted(true)
    try {
      for (let i = 0; i < pages.length; i++) {
        if (cancelled) break
        const p = pages[i]
        say('progress', i, pages.length, p.path)
        gone = null
        try {
          await win.loadURL(p.url)
          await waitReady(win, timeoutMs, () => cancelled || !!gone)
          if (gone) throw gone
          const err = await win.webContents.executeJavaScript(ERROR_JS, true)
          if (err) throw new Error(err.replace(/^Could not load the page:\s*/, 'the print view could not load the page: '))
          const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
          if (!pdf || !pdf.length) throw new Error('printToPDF returned nothing')
          fs.writeFileSync(p.file, pdf)
          say('done', i, pdf.length)
        } catch (e) {
          if (cancelled) break
          say('fail', i, oneLine(gone || e))
        }
      }
    } finally {
      try { if (win && !win.isDestroyed()) win.destroy() } catch { }
      win = null
    }
    say(cancelled ? 'cancelled' : 'exit')
  })()

  return {
    done,
    cancel: () => { cancelled = true; try { if (win && !win.isDestroyed()) win.webContents.stop() } catch { } },
  }
}

module.exports = { printPages, available }
