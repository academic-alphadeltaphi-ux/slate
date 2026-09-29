// Print an HTML document to PDF with headless Chrome (SPEC §18.4, §20.67) — the same road scripts/render-sheet.mjs
// takes for a study sheet, made a function: slate renders PDFs, not HTML, so anything authored as HTML becomes a
// printout before it reaches a page.
//
// The document is served over loopback rather than opened as file:// (Chrome will not load a page's siblings
// reliably from disk), on a port the OS picks, so two printers never race and the test range 5195–5199 is left alone.
// `dirs` maps a URL prefix to a folder on disk — `{ _images: '/…/Textbook/_images' }` — so the HTML can say
// `<img src="_images/fig.png">` without a copy of every figure beside it.
//
//   await printHtml({ html, out: '/abs/file.pdf', dirs: { _images: '/abs/images' } })
//
// SLATE_FAKE_PRINT=1 writes a one-page placeholder PDF instead of running Chrome: the test suite's way of
// exercising everything around the print without a browser.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ...(process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'] : []),
  ...(process.platform === 'linux' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : [])]
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
export async function findChrome() {
  if (process.env.SLATE_CHROME && await exists(process.env.SLATE_CHROME)) return process.env.SLATE_CHROME
  for (const p of CHROME) if (await exists(p)) return p
  return null
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

// A placeholder PDF: one blank Letter page, valid enough for pdf.js and for a size on a card.
const FAKE_PDF = () => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>']
  let out = '%PDF-1.4\n', offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

export async function printHtml({ html, out, dirs = {}, timeoutMs = 180_000 }) {
  await fs.mkdir(path.dirname(out), { recursive: true })
  if (process.env.SLATE_FAKE_PRINT === '1') { await fs.writeFile(out, FAKE_PDF()); return { fake: true } }
  const chrome = await findChrome()
  if (!chrome) throw new Error('No Chrome, Chromium or Edge found — cannot print to PDF (set SLATE_CHROME to the browser binary).')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-print-'))
  await fs.writeFile(path.join(tmp, 'index.html'), html)
  const roots = { '': tmp, ...Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k.replace(/^\/|\/$/g, ''), v])) }
  const server = http.createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
      const [head, ...rest] = url.split('/')
      const base = roots[head] != null && rest.length ? roots[head] : roots['']
      const rel = roots[head] != null && rest.length ? rest.join('/') : url
      const file = path.resolve(base, rel || 'index.html')
      if (!file.startsWith(path.resolve(base))) { res.writeHead(403); return res.end() }
      const data = await fs.readFile(file)
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(data)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res) })
  const port = server.address().port
  try {
    const pdf = path.join(tmp, 'out.pdf')
    await new Promise((res, rej) => {
      const p = spawn(chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--hide-scrollbars', '--run-all-compositor-stages-before-draw',
        `--print-to-pdf=${pdf}`, '--virtual-time-budget=30000', `http://127.0.0.1:${port}/index.html`], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      const timer = setTimeout(() => { p.kill('SIGKILL'); rej(new Error(`Chrome took longer than ${timeoutMs / 1000}s`)) }, timeoutMs)
      p.stderr.on('data', d => { err += d })
      p.on('error', e => { clearTimeout(timer); rej(e) })
      p.on('close', c => { clearTimeout(timer); c === 0 ? res() : rej(new Error(err.trim().split('\n').slice(-2).join(' ') || `Chrome exited ${c}`)) })
    })
    if (!(await exists(pdf))) throw new Error('Chrome produced no PDF')
    await fs.copyFile(pdf, out)
    return { fake: false, port }
  } finally {
    server.close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
