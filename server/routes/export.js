// Export a section or a notebook to one PDF binder (SPEC §20.10). The route collects the pages in list order
// (subpages after their parent, sections in tree order), prints each through the print view in a hidden
// Electron window, merges the parts with pypdf (`uv run scripts/merge-pdf.py`) and lands the binder in
// `<Notebook>/_exports/` — reserved by its `_` prefix, ignored by snapshots, never re-imported. One printed part is
// the binder as it stands: no merge, so a page's Save as PDF needs neither uv nor the merger, which the kits leave out.
//
//   POST /api/export { path, skipEmpty = true, dryRun = false }
//        dryRun → { target, kind, name, pages: [{ path, title, depth, empty, virtual }], total, printable }
//        else   → { started: true } | { started: false, running: true }
//   GET  /api/export/status  → the job, or { running: false } before the first run
//   POST /api/export/cancel  → { cancelled: true } | { running: false }
//   POST /api/export/open { rel } → opens the binder in the default PDF app → { ok: true }
//
// The printer: inside Slate.app (the server runs in Electron's main process) a hidden window in this process
// (desktop/print.cjs); under plain Node a spawned Electron running scripts/print-pages.cjs with
// ELECTRON_RUN_AS_NODE removed from the child env — the only child that wants a real Electron. Both print the
// built client: `dist/` (what Slate.app serves), or SLATE_DIST (another build, e.g. the tests), or the origin
// in SLATE_CLIENT_URL (a Vite dev server proxying /api and /files). One job at a time, lost on restart.
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import express from 'express'
import { safeName as platformSafeName } from '../../scripts/lib/platform.mjs'

const PRINTABLE = new Set(['image', 'file', 'media', 'pdf'])
// A page is empty when it does not exist (virtual) or when every block is blank, no element is a document
// and no ink element carries a stroke. The same rule feeds the dry run's counts and the job's skip list.
export const isEmptyPage = p => !p.exists || (p.blocks.every(b => !String(b.md || '').trim()) && !(p.layout?.elements || []).some(e => PRINTABLE.has(e.type) || (e.type === 'ink' && e.strokes?.length)))
const safeName = s => platformSafeName(s)
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const exists = p => fss.existsSync(p)
// The pages of one PDF, for the dialog's "N pages" when nothing was merged, by the pdf.js the server reads PDFs with.
const pageCount = async file => {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({ data: new Uint8Array(await fs.readFile(file)), isEvalSupported: false, verbosity: 0 })
    try { return (await task.promise).numPages } finally { await task.destroy().catch(() => { }) }
  } catch { return null }
}

export function register(app, ctx) {
  const { store, ROOT, HttpError, wrap, repo, PORT, env } = ctx
  const MERGE = path.join(repo, 'scripts', 'merge-pdf.py')
  const ELECTRON = [path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), path.join(repo, 'node_modules/.bin/electron')].find(exists) || null
  const DIST = process.env.SLATE_DIST ? path.resolve(process.env.SLATE_DIST) : null
  // An alternative client build (tests, a dev build elsewhere): mounted here, before index.js's dist/ mount, so
  // the printer sees it at the server's own origin. Never used when SLATE_DIST is unset.
  if (DIST && exists(path.join(DIST, 'index.html'))) app.use(express.static(DIST))
  const clientOrigin = () => process.env.SLATE_CLIENT_URL || ((DIST && exists(path.join(DIST, 'index.html'))) || exists(path.join(repo, 'dist', 'index.html')) ? `http://127.0.0.1:${PORT}` : null)

  // ---- the plan: which pages, in which order, at which depth --------------------------------------------
  const collectSection = async (sec, depth0 = 0) => {
    const out = []
    const walk = (list, depth) => { for (const p of list) { out.push({ path: p.path, title: p.title, depth, virtual: !!p.virtual }); walk(p.children || [], depth + 1) } }
    walk(await store.pages(sec), depth0)
    return out
  }
  async function plan(target) {
    const rel = store.safeRel(target)
    if (!rel) throw new HttpError(400, 'export a notebook or a section')
    const segs = rel.split('/')
    if (segs.length === 1) {
      const nb = (await store.tree()).find(n => n.path === rel)
      if (!nb) throw new HttpError(404, 'no such notebook')
      const parts = []
      for (const s of nb.sections) { parts.push({ header: true, title: s.name, depth: 0, path: s.path }); parts.push(...await collectSection(s.path, 1)) }
      return { kind: 'notebook', notebook: rel, name: `${nb.name} · ${today()}`, parts }
    }
    // One page, on its own (SPEC §20.28). "Save as PDF" used to mean the browser's print dialog, which is not a
    // save at all — it is a printer with a Save button hidden in it. A page goes through the same Electron printer
    // the binders use and lands as a file in `_exports/`, with Open and Reveal beside it.
    if (rel.endsWith('.md')) {
      const pg = await store.readPage(rel)
      if (!pg.exists) throw new HttpError(404, 'no such page')
      return { kind: 'page', notebook: segs[0], name: `${pg.title} · ${today()}`, parts: [{ path: rel, title: pg.title, depth: 0, virtual: false }] }
    }
    if (segs.length === 2) {
      if (!exists(path.join(ROOT, rel)) || !fss.statSync(path.join(ROOT, rel)).isDirectory()) throw new HttpError(404, 'no such section')
      return { kind: 'section', notebook: segs[0], name: `${segs[0]} — ${segs[1]} · ${today()}`, parts: await collectSection(rel, 0) }
    }
    throw new HttpError(400, 'export a page, a section or a notebook')
  }
  const annotate = async parts => { for (const p of parts) { if (p.header) continue; p.empty = p.virtual ? true : isEmptyPage(await store.readPage(p.path)) } return parts }

  // ---- the job ------------------------------------------------------------------------------------------------
  let job = null, child = null, inproc = null
  const finish = (ok, note) => { if (!job) return; job.running = false; job.ok = ok; job.note = note ?? job.note; job.finishedAt = new Date().toISOString(); child = null; inproc = null }
  const desktopPrinter = async () => {
    if (!process.versions?.electron || process.env.ELECTRON_RUN_AS_NODE) return null
    try { const m = await import(pathToFileURL(path.join(repo, 'desktop', 'print.cjs')).href); const p = m.default || m; return p.available ? p : null } catch { return null }
  }

  app.post('/api/export', wrap(async (req, res) => {
    const { path: target, skipEmpty = true, dryRun = false } = req.body || {}
    const p = await plan(target); await annotate(p.parts)
    const pages = p.parts.filter(x => !x.header)
    const skip = x => x.virtual || (skipEmpty && x.empty)
    if (dryRun) return res.json({ target: store.safeRel(target), kind: p.kind, name: p.name, pages, total: pages.length, printable: pages.filter(x => !skip(x)).length })
    if (job?.running) return res.json({ started: false, running: true })
    const client = clientOrigin()
    if (!client) throw new HttpError(500, 'Build the client once (npm run build) or set SLATE_CLIENT_URL so the export can print through it.')
    const printer = await desktopPrinter()
    if (!printer && !ELECTRON) throw new HttpError(500, 'Electron is not installed in node_modules — run npm install.')
    const toPrint = pages.filter(x => !skip(x))
    if (!toPrint.length) throw new HttpError(400, 'nothing to print: every page is empty')
    // Several pages are bound by scripts/merge-pdf.py, which scripts/kit.mjs leaves out of the brothers' copies: say so
    // before printing thirty pages for nothing, not after, with a stack from uv.
    if (toPrint.length > 1 && !exists(MERGE)) throw new HttpError(409, 'This copy of Slate saves one page at a time as a PDF; it cannot bind a section or a notebook into one.')
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-export-'))
    job = { running: true, target: store.safeRel(target), name: p.name, kind: p.kind, startedAt: new Date().toISOString(), finishedAt: null, ok: null, cancelled: false,
      total: toPrint.length, done: 0, current: null, skipped: pages.filter(skip).map(x => x.path), failed: [], phase: 'print', out: null, note: null }
    res.json({ started: true })

    const files = new Map()   // page path → its part's pdf (deleted when the printer fails that page)
    toPrint.forEach((x, i) => files.set(x.path, path.join(tmp, String(i + 1).padStart(3, '0') + '.pdf')))
    const manifest = { timeoutMs: 90000, pages: toPrint.map(x => ({ path: x.path, title: x.title, url: `${client}/?print=${encodeURIComponent(x.path)}&export=1`, file: files.get(x.path) })) }
    await fs.writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest))
    const onLine = line => {
      const [k, idx, ...rest] = line.split(' '); const pg = toPrint[Number(idx)]
      if (k === 'progress') job.current = pg ? { path: pg.path, title: pg.title } : null
      else if (k === 'done') { job.done++ }
      else if (k === 'fail') { if (pg) { job.done++; job.failed.push({ path: pg.path, title: pg.title, error: rest.join(' ') }); files.delete(pg.path) } else if (!job.note) job.note = rest.join(' ') }
    }
    const merge = async () => {
      try {
        if (job.cancelled) return finish(false, 'Cancelled.')
        const printed = new Set([...files].filter(([, f]) => exists(f)).map(([k]) => k))
        const hasPrintedChild = x => { const base = x.path.replace(/\.md$/, '') + '/'; return [...printed].some(y => y.startsWith(base)) }
        const parts = []
        for (const x of p.parts) {
          if (x.header) { if (p.parts.some(y => !y.header && y.path.startsWith(x.path + '/') && printed.has(y.path))) parts.push({ file: null, title: x.title, depth: x.depth }); continue }
          if (printed.has(x.path)) parts.push({ file: files.get(x.path), title: x.title, depth: x.depth })
          else if (hasPrintedChild(x)) parts.push({ file: null, title: x.title, depth: x.depth })
        }
        if (!printed.size) return finish(false, job.note ? 'Nothing was printed: ' + job.note : 'Nothing was printed.')
        job.current = null
        let out = path.join(tmp, 'out.pdf'), merged
        const one = parts.filter(x => x.file)
        if (one.length === 1) { out = one[0].file; merged = { pages: await pageCount(out) } }   // one PDF is already the binder
        else {
          job.phase = 'merge'
          await fs.writeFile(path.join(tmp, 'merge.json'), JSON.stringify({ out, title: p.name, parts }))
          merged = await new Promise((ok, no) => execFile('uv', ['run', '--quiet', MERGE, path.join(tmp, 'merge.json')], { env, cwd: repo, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              if (err) return no(new Error(err.code === 'ENOENT' ? '`uv` is not installed (curl -LsSf https://astral.sh/uv/install.sh | sh)' : (String(stderr || err.message).trim().split('\n').pop() || 'merge failed')))
              try { ok(JSON.parse(String(stdout).trim().split('\n').pop())) } catch { no(new Error('the merge printed no result')) }
            }))
        }
        if (job.cancelled) return finish(false, 'Cancelled.')
        job.phase = 'copy'
        const dir = path.join(ROOT, p.notebook, '_exports'); await fs.mkdir(dir, { recursive: true })
        const name = safeName(p.name); let file = path.join(dir, name + '.pdf')
        for (let n = 2; exists(file); n++) file = path.join(dir, `${name} (${n}).pdf`)
        await fs.copyFile(out, file)
        const gi = path.join(ROOT, '.gitignore'); const cur = await fs.readFile(gi, 'utf8').catch(() => '')
        if (!cur.split(/\r?\n/).some(l => l.trim() === '_exports/')) await fs.writeFile(gi, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + '_exports/\n')
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        job.out = { rel, url: '/files/' + rel.split('/').map(encodeURIComponent).join('/'), bytes: (await fs.stat(file)).size, pages: merged.pages }
        finish(true, job.failed.length ? `${job.failed.length} page${job.failed.length === 1 ? '' : 's'} could not be printed and ${job.failed.length === 1 ? 'was' : 'were'} left out.` : null)
      } catch (e) { finish(false, 'The merge failed: ' + e.message) }
      finally { fs.rm(tmp, { recursive: true, force: true }).catch(() => { }) }
    }

    if (printer) {
      // Slate.app: a hidden window in this very process.
      try { inproc = printer.printPages(manifest, onLine) } catch (e) { finish(false, 'The printer could not start: ' + e.message); fs.rm(tmp, { recursive: true, force: true }).catch(() => { }); return }
      inproc.done.then(merge, e => { finish(false, 'The printer failed: ' + e.message); fs.rm(tmp, { recursive: true, force: true }).catch(() => { }) })
      return
    }
    // Plain Node: a second Electron, invoked directly, as a real Electron (not as Node).
    const penv = { ...env }; delete penv.ELECTRON_RUN_AS_NODE
    child = spawn(ELECTRON, [path.join(repo, 'scripts', 'print-pages.cjs'), path.join(tmp, 'manifest.json')], { cwd: repo, env: penv, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line) } })
    child.stderr.on('data', () => { })
    child.on('error', e => { finish(false, 'The printer could not start: ' + e.message); fs.rm(tmp, { recursive: true, force: true }).catch(() => { }) })
    child.on('close', () => { if (buf.trim()) onLine(buf.trim()); merge() })
  }))

  app.get('/api/export/status', (req, res) => res.json(job || { running: false }))
  app.post('/api/export/cancel', (req, res) => {
    if (!job?.running) return res.json({ running: false })
    job.cancelled = true
    if (inproc) inproc.cancel()
    if (child) child.kill('SIGTERM')
    res.json({ cancelled: true })
  })
  // A page as a Word document or as markdown (SPEC §20.28). Word opens an HTML file with a `.doc` extension and
  // keeps the headings, lists, tables and images — no converter, no dependency, and the file is real enough that
  // Pages and Google Docs open it too. The client renders the markdown, because the renderer that draws the page
  // is the one that should decide what the page looks like.
  const DOC_HEAD = title => `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${title}</title><style>
body{font:12pt/1.5 Calibri,Georgia,serif;color:#111}h1{font-size:20pt}h2{font-size:15pt}h3{font-size:13pt}
table{border-collapse:collapse}td,th{border:1px solid #999;padding:4pt 8pt}img{max-width:100%}
blockquote{margin:0 0 0 18pt;padding-left:10pt;border-left:2pt solid #bbb;color:#444}
code,pre{font-family:Consolas,monospace;font-size:10.5pt;background:#f4f4f6}</style></head><body>`
  app.post('/api/export/file', wrap(async (req, res) => {
    const { path: target, format, html, md } = req.body || {}
    const rel = store.safeRel(target)
    if (!rel.endsWith('.md')) throw new HttpError(400, 'export one page')
    if (!['doc', 'md'].includes(format)) throw new HttpError(400, 'format must be doc or md')
    const pg = await store.readPage(rel)
    if (!pg.exists) throw new HttpError(404, 'no such page')
    const nb = rel.split('/')[0]
    const dir = path.join(ROOT, nb, '_exports')
    await fs.mkdir(dir, { recursive: true })
    const name = `${safeName(pg.title)} · ${today()}.${format}`
    const body = format === 'md'
      ? (typeof md === 'string' && md.trim() ? md : pg.blocks.map(b => b.md).join('\n\n'))
      : DOC_HEAD(pg.title) + (typeof html === 'string' ? html : `<pre>${pg.blocks.map(b => b.md).join('\n\n').replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))}</pre>`) + '</body></html>'
    await fs.writeFile(path.join(dir, name), body, 'utf8')
    res.json({ ok: true, rel: `${nb}/_exports/${name}`, name })
  }))

  app.post('/api/export/open', wrap(async (req, res) => {
    const rel = store.safeRel(req.body?.rel)
    if (!/^[^/]+\/_exports\/[^/]+\.(pdf|doc|md)$/.test(rel)) throw new HttpError(400, 'not an export')
    const abs = path.join(ROOT, rel)
    if (!exists(abs)) throw new HttpError(404, 'no such export')
    store.openInShell(abs, { reveal: !!req.body?.reveal })   // Finder or Explorer (server/fs.js)
    res.json({ ok: true })
  }))
}
