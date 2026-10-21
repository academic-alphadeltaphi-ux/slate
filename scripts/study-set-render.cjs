// The study set's renderer (SPEC §21.16): one hidden Electron window that turns the set's HTML into what goes on a slate
// page, and a deck's pages into pictures Claude can read. Spawned by scripts/study-set.mjs as a real Electron main process
// (the binary invoked directly, ELECTRON_RUN_AS_NODE removed), the way scripts/print-pages.cjs is:
//   <electron> scripts/study-set-render.cjs <manifest.json>
// Why Electron: it is already in every copy, on a Mac and on a PC, and it is a whole Chromium — no Chrome, no Python, no
// Playwright to install. The study guides were printed by headless Chrome at a Mac path (scripts/render-sheet.mjs) and the
// glance sheets by Playwright; neither exists on a brother's PC.
//
// manifest = { jobs: [
//   { kind: 'report', html }                                   what the page looks like once MathJax is done (below)
//   { kind: 'pdf', html, out }                                 the page printed: Letter, or the page's own @page size
//   { kind: 'png', html, stem, dpi = 300 }                     every `.page` element as <stem>-<i>.png (glance sheets)
//   { kind: 'pdfpages', pdf, pages: [n…], dpi = 110, stem }    PDF pages (1-based) as <stem>-p<n>.png, ink and all
// ] }
// One JSON line per job on stdout: { i, ok: true, …result } or { i, ok: false, error }; then exit.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const say = o => process.stdout.write(JSON.stringify(o) + '\n')
const manifestPath = process.argv.slice(1).reverse().find(a => a.endsWith('.json'))
let manifest = null
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (e) { say({ i: -1, ok: false, error: 'cannot read the manifest: ' + (e && e.message) }); process.exit(2) }

app.disableHardwareAcceleration()          // the same pixels on every machine, and no GPU process for a hidden window
app.dock?.hide()
app.on('window-all-closed', () => { })     // we exit ourselves once the last job is written

const REPO = path.join(__dirname, '..')
const PDFJS = path.join(REPO, 'node_modules', 'pdfjs-dist', 'build')
const WASM = path.join(REPO, 'node_modules', 'pdfjs-dist', 'wasm') + path.sep
const sleep = ms => new Promise(r => setTimeout(r, ms))
const oneLine = e => String((e && e.message) || e || 'unknown error').replace(/\s+/g, ' ').trim()
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out after ${Math.round(ms / 1000)} s`)), ms))])

function newWindow() {
  const win = new BrowserWindow({
    show: false, width: 816, height: 1056, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: false, webSecurity: false },
  })
  win.webContents.setAudioMuted(true)
  return win
}

// Loaded, MathJax typeset (when the page uses it), fonts in, two frames painted. A MathJax that never loaded (no network)
// leaves `\(` in the text: the report counts it, so a sheet printed offline is caught rather than shipped with raw TeX.
const SETTLE = `(async () => {
  const mj = window.MathJax
  if (mj && mj.startup && mj.startup.promise) await mj.startup.promise
  if (document.fonts && document.fonts.ready) await document.fonts.ready
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  return !!(mj && mj.startup)
})()`

// What the page says about itself. For a glance sheet (US Letter `.page` divs): per sheet, any card whose content
// overflows it, any equation or figure wider than its card, raw TeX left over, and where the footer sits. For a guide: raw
// TeX, MathJax errors, display equations wider than the text column, and TeX inside SVG <text> (which prints blank).
const REPORT = `(() => {
  const raw = s => (s.match(/\\\\\\(|\\\\\\[/g) || []).length
  const sheets = [...document.querySelectorAll('.page')].map((pg, i) => {
    const pb = pg.getBoundingClientRect()
    const body = pg.querySelector('.body'), foot = pg.querySelector('.foot')
    const kids = body ? [...body.children] : []
    const last = kids.length ? Math.max(...kids.map(c => c.getBoundingClientRect().bottom)) : pb.top
    const title = c => (c.querySelector('h2') ? c.querySelector('h2').textContent.trim().slice(0, 50) : '?')
    const over = [...pg.querySelectorAll('.card')].filter(c => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map(title)
    const wide = [...pg.querySelectorAll('mjx-container,svg.fig')].filter(e => {
      const r = e.getBoundingClientRect(), card = e.closest('.card') && e.closest('.card').getBoundingClientRect()
      return card && (r.right > card.right + 0.5 || r.left < card.left - 0.5)
    }).map(e => title(e.closest('.card')))
    return { sheet: i + 1, bodyBottom: Math.round(last - pb.top), footTop: foot ? Math.round(foot.getBoundingClientRect().top - pb.top) : null, footBottom: foot ? Math.round(foot.getBoundingClientRect().bottom - pb.top) : null, height: Math.round(pb.height), overflowCards: over, wideMath: wide, rawTex: raw(pg.innerText) }
  })
  const col = document.body.getBoundingClientRect()
  const wideDisplay = [...document.querySelectorAll('mjx-container[display="true"]')].filter(e => {
    const box = (e.parentElement || document.body).getBoundingClientRect(), s = e.querySelector('svg'), r = (s || e).getBoundingClientRect()
    return r.width > Math.min(box.width, col.width) + 1
  }).map(e => (e.closest('[id]') ? '#' + e.closest('[id]').id : '') + ' ' + (e.getAttribute('aria-label') || '').slice(0, 60))
  const svgTex = [...document.querySelectorAll('svg text')].filter(t => /\\\\\\(|\\\\\\[/.test(t.textContent)).map(t => t.textContent.slice(0, 50))
  return { title: document.title, rawTex: raw(document.body.innerText), mathErrors: document.querySelectorAll('mjx-merror').length, wideDisplay, svgTex, sheets }
})()`

async function open(win, html) {
  const errors = []
  const onMsg = e => { if (e.level === 'error' || e.level >= 3) errors.push(String(e.message).slice(0, 200)) }
  win.webContents.on('console-message', onMsg)
  await withTimeout(win.loadURL(pathToFileURL(path.resolve(html)).href), 60000, 'loading the page')
  const typeset = await withTimeout(win.webContents.executeJavaScript(SETTLE, true), 120000, 'waiting for MathJax')
  win.webContents.removeListener('console-message', onMsg)
  return { errors, typeset }
}

async function report(win, job) {
  const { errors, typeset } = await open(win, job.html)
  const r = await win.webContents.executeJavaScript(REPORT, true)
  return { ...r, typeset, consoleErrors: errors }
}

async function pdf(win, job) {
  const { errors, typeset } = await open(win, job.html)
  const r = await win.webContents.executeJavaScript(REPORT, true)
  // preferCSSPageSize: a glance sheet's @page (8.5×11 in, no margin) wins; a guide has none and prints on Letter with
  // the default margins, solutions open (its own print stylesheet expands them)
  const buf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'Letter' })
  fs.mkdirSync(path.dirname(job.out), { recursive: true })
  fs.writeFileSync(job.out, buf)
  return { out: job.out, bytes: buf.length, ...r, typeset, consoleErrors: errors }
}

// Each sheet at print resolution through the DevTools protocol: a clip at scale dpi/96 is drawn at that resolution
// (not a 96-dpi capture blown up), and captureBeyondViewport reaches the sheets below the first.
async function png(win, job) {
  const { errors, typeset } = await open(win, job.html)
  const r = await win.webContents.executeJavaScript(REPORT, true)
  const rects = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.page')].map(p => { const b = p.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height } })`, true)
  if (!rects.length) throw new Error('the page has no .page sheets to capture')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const files = []
  try {
    const scale = (Number(job.dpi) || 300) / 96
    for (let i = 0; i < rects.length; i++) {
      const c = rects[i]
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale } })
      const file = `${job.stem}-${i + 1}.png`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      files.push(file)
    }
  } finally { try { dbg.detach() } catch { } }
  return { files, ...r, typeset, consoleErrors: errors }
}

// A PDF's pages as pictures, through pdf.js in this window: annotations (the professor's ink, highlights) are drawn
// from their appearance streams, which a text cache never has.
async function pdfpages(win, job) {
  const page = path.join(os.tmpdir(), `slate-pdfpages-${process.pid}.html`)
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body><script type="module">
import * as pdfjs from ${JSON.stringify(pathToFileURL(path.join(PDFJS, 'pdf.mjs')).href)}
pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(pathToFileURL(path.join(PDFJS, 'pdf.worker.mjs')).href)}
window.renderPages = async (url, pages, scale) => {
  const task = pdfjs.getDocument({ url, wasmUrl: ${JSON.stringify(pathToFileURL(WASM).href)} }), doc = await task.promise
  const out = []
  for (const n of pages) {
    if (n < 1 || n > doc.numPages) { out.push({ n, error: 'no such page (the PDF has ' + doc.numPages + ')' }); continue }
    const p = await doc.getPage(n), vp = p.getViewport({ scale })
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height)
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height)
    await p.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
    out.push({ n, data: c.toDataURL('image/png').split(',')[1] })
    p.cleanup()
  }
  const total = doc.numPages
  await task.destroy()
  return { total, out }
}
window.ready = true
</script>`)
  try {
    await withTimeout(win.loadURL(pathToFileURL(page).href), 30000, 'loading pdf.js')
    for (let t = 0; !(await win.webContents.executeJavaScript('window.ready === true', true)); t++) { if (t > 200) throw new Error('pdf.js did not load'); await sleep(50) }
    const scale = (Number(job.dpi) || 110) / 72
    const res = await withTimeout(win.webContents.executeJavaScript(`window.renderPages(${JSON.stringify(pathToFileURL(path.resolve(job.pdf)).href)}, ${JSON.stringify(job.pages)}, ${scale})`, true), 300000, 'rendering the pages')
    const files = [], skipped = []
    for (const o of res.out) {
      if (o.error) { skipped.push(`p${o.n}: ${o.error}`); continue }
      const file = `${job.stem}-p${o.n}.png`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(o.data, 'base64'))
      files.push(file)
    }
    return { total: res.total, files, skipped }
  } finally { fs.rmSync(page, { force: true }) }
}

const RUN = { report, pdf, png, pdfpages }
app.whenReady().then(async () => {
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : []
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i], fn = RUN[job.kind]
    const win = newWindow()
    try {
      if (!fn) throw new Error(`no such job kind: ${job.kind}`)
      say({ i, ok: true, kind: job.kind, ...(await fn(win, job)) })
    } catch (e) {
      say({ i, ok: false, kind: job.kind, error: oneLine(e) })
    } finally { try { win.destroy() } catch { } }
  }
  setTimeout(() => app.exit(0), 100)
})
