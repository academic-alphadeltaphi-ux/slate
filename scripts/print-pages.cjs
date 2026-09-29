// The standalone printer (SPEC §20.10), run as its own Electron process by server/routes/export.js when the
// server is plain Node (`node server/index.js`, npm run dev, the tests):
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/print-pages.cjs <manifest.json>
// The binary is invoked directly (the .bin shim needs `node` on PATH) with ELECTRON_RUN_AS_NODE removed from
// the environment, so this is a real Electron main process. The work itself lives in desktop/print.cjs, shared
// with Slate.app's in-process path; this file only reads the manifest, hides the Dock icon, and exits.
// CommonJS because Electron's main entry is.
const { app } = require('electron')
const fs = require('node:fs')
const { printPages } = require('../desktop/print.cjs')

const say = s => process.stdout.write(s + '\n')
const manifestPath = process.argv.slice(1).reverse().find(a => a.endsWith('.json'))
let manifest = null
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (e) { say('fail -1 cannot read the manifest: ' + (e && e.message)); process.exit(2) }

app.dock?.hide()                                   // no Dock icon, no focus stealing
app.on('window-all-closed', () => { })             // we exit ourselves once the last line is written
let job = null
const bail = () => { if (job) job.cancel(); setTimeout(() => app.exit(0), 300) }
process.on('SIGTERM', bail); process.on('SIGINT', bail)

app.whenReady().then(async () => {
  job = printPages(manifest, say)
  await job.done
  app.exit(0)
}).catch(e => { say('fail -1 ' + String((e && e.message) || e).replace(/\s+/g, ' ')); app.exit(1) })
