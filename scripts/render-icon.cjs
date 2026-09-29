// SVG → a transparent 1024 PNG, run under Electron (`npx electron scripts/render-icon.cjs <in.svg> <out.png>`).
// The build used `qlmanage -t`, which is Quick Look's *thumbnail* generator: it composites onto white and adds a
// frame, which is where the white border around the app icon came from. A transparent BrowserWindow has neither.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const [svg, out] = process.argv.slice(2).filter(a => !a.startsWith('-'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  const doc = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>${fs.readFileSync(svg, 'utf8')}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc))
  await new Promise(r => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(out, img.toPNG())
  app.exit(0)
})
