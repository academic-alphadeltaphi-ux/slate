#!/usr/bin/env node
// The textbook in slate, and the week's pages of it (SPEC §20.67, §20.68).
//
//   node scripts/textbook.mjs import --course "ECO 227Y1" --bundle <mindtap.json> --images <dir> [--only 1,2] [--force]
//       A MindTap e-book: keep it under the course's `Textbook/` section, one page per chapter with the chapter printed
//       to PDF, the chapter documents under `Textbook/_source/`, the figures under `Textbook/_images/`, and
//       `_textbook.json`, the index the weekly pass reads. The bundle is what the MindTap reader serves (`nodes` + one
//       `chapter` document per activity), fetched once from the student's own logged-in session — see SPEC §20.67 for how.
//
//   node scripts/textbook.mjs import --course "ECO 206Y1" --pdf <book.pdf> [--toc <toc.json>] [--offset N] [--edition "5th ed. (Pearson)"] [--only 3] [--force]
//       A book that is one PDF (Perloff): the same section, index and chapter pages, each chapter page carrying its
//       pages copied out of the book behind a cover. The chapters and their numbered sections come from the PDF's own
//       outline (bookmarks); when the file has none worth the name, `--toc` gives them by hand as a JSON list of
//       `[level, title, page]` or `{ level, title, page }` (book page numbers, with `--offset` the PDF page of book
//       page 1 minus one). The PDF itself is kept as `Textbook/_source/book.pdf`.
//
//   node scripts/textbook.mjs [--course KEY] [--week N] [--force]
//       For every course whose notebook holds a textbook, and for every week the course names chapters for — the
//       outline's `chapters` line in scripts/lib/syllabus.mjs, or, when the professor publishes the outline week by
//       week on Quercus (ECO206), the week's synced topic page's own "Read: Textbook 3.1–3.3" line — put just those
//       sections onto the week's own `Textbook` shelf as `WMS 2.1–2.3` / `Perloff 3.1–3.3`: the page a task reading
//       "Read Perloff 3.1–3.3" opens, and the reading the study sheet is built from. A page that exists is left alone
//       (it may carry ink); `--force` remakes its PDF and keeps the ink. A course whose terms.mjs line names a textbook
//       that is not in its notebook yet is reported with the weeks waiting for it, and nothing is written.
//
//   Common: [--root <dir>] [--dry-run] [--json]. Deterministic, no connector; runs in the morning pass after the fetch.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { COURSES, weeks, localStamp } from './lib/terms.mjs'
import { SYLLABUS } from './lib/syllabus.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { parseChapters, readingTitle, readLineChapters, shortBookName, groupSections, cutChapter, documentHtml, bookPages, tocToChapters, cutPdfRanges, pageSpan } from './lib/textbook.mjs'
import { printHtml } from './lib/print-html.mjs'
import { newId } from '../server/format.js'
import { WIN, findUv } from './lib/platform.mjs'
import { hasDevTools } from '../server/devtools.js'

const USAGE = `node scripts/textbook.mjs import --course KEY --bundle <json> --images <dir> [--only 1,2] [--force] [--root] [--dry-run] [--json]
node scripts/textbook.mjs import --course KEY --pdf <book.pdf> [--toc <json>] [--offset N] [--edition TEXT] [--only 1,2] [--force] [--root] [--dry-run] [--json]
node scripts/textbook.mjs [--course KEY] [--week N] [--force] [--root] [--dry-run] [--json]`
guardFlags(['--bundle', '--course', '--dry-run', '--edition', '--force', '--images', '--json', '--offset', '--only', '--pdf', '--root', '--toc', '--week'], USAGE)

const args = process.argv.slice(2)
const val = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const IMPORT = args[0] === 'import'
const DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json'), FORCE = args.includes('--force')
const ROOT = notesRoot(process.argv)
process.env.SLATE_ROOT = ROOT                       // before server/pdf-text.js fixes its ROOT at import
const { textFor } = await import('../server/pdf-text.js')
const log = (...a) => { if (!JSON_OUT) console.log(...a) }
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
const writeJson = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(v, null, 2) + '\n') }

// The book's short name — "WMS" from "Wackerly, Mendenhall & Scheaffer, Mathematical Statistics with Applications
// (WMS) · WebAssign", "Perloff" from "Perloff, Microeconomics: …" — the word the outline, the topic pages, the
// Problems pages and the To do rows already use (src/plan.js textbookName is the same rule).
const shortName = key => shortBookName(COURSES[key]?.textbook, 'Textbook')
// What the page header calls the copy: the WebAssign e-book for MindTap (the wording ECO227's pages have), else what
// the import was told, else "the PDF".
const editionOf = index => index.edition || (index.format === 'pdf' ? 'the PDF' : 'the WebAssign e-book')
const TEXTBOOK = 'Textbook'
const tbDir = key => path.join(ROOT, key, TEXTBOOK)
const indexPath = key => path.join(tbDir(key), '_textbook.json')
// A page's name from a chapter's name: "Chapter 1&#58; What Is Statistics?" → "Chapter 1 — What Is Statistics".
const pageName = s => String(s || '').replace(/&#58;|&colon;/g, ':').replace(/&amp;/g, '&').replace(/\s*[:：]\s*/, ' — ').replace(/[?？]/g, '').replace(/[\/\\]/g, '–').replace(/\s+/g, ' ').trim()

// ---- python, for the book that is one PDF ------------------------------------------------------------------------------
// scripts/pdf-cut.py needs PyMuPDF: the OCR venv has it (bin/install-ocr.sh); uv can lend one of its own Pythons with it for
// the run; a system python3 may have it. The first that imports fitz is used for the run; none → a plain error naming the
// install script. A bare `python3` is tried only where Apple's developer tools are: without them it is the dialog offering
// to install them (server/devtools.js), which the 07:30 run put in front of a brother (review 2026-09-29) — and on Windows
// it can be the Store's stand-in, so there it is never tried.
const run = promisify(execFile)
const PDF_CUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf-cut.py')
const NO_PYTHON = 'No python with PyMuPDF on this computer — install uv (setup step "deps"), or run bin/install-ocr.sh (or set SLATE_OCR_PYTHON), to cut a PDF textbook.'
let PY = undefined
async function python() {
  if (PY !== undefined) return PY
  const uv = findUv()
  const tries = [
    process.env.SLATE_OCR_PYTHON && [process.env.SLATE_OCR_PYTHON],
    [path.join(os.homedir(), '.local/share/slate/venv/bin/python')],
    uv && [uv, 'run', '--quiet', '--no-project', '--managed-python', '--with', 'pymupdf', 'python'],   // only uv's own Pythons: never the system's shim
    !WIN && hasDevTools() && ['python3'],
  ].filter(Boolean)
  for (const [cmd, ...pre] of tries) { try { await run(cmd, [...pre, '-c', 'import fitz'], { timeout: pre.length ? 180_000 : 20_000 }); PY = [cmd, ...pre]; return PY } catch { } }   // uv may fetch PyMuPDF the first time
  PY = null
  return null
}
async function pdfTool(argv, { timeoutMs = 300_000 } = {}) {
  const py = await python()
  if (!py) throw new Error(NO_PYTHON)
  const { stdout } = await run(py[0], [...py.slice(1), PDF_CUT, ...argv], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const out = JSON.parse(stdout)
  if (out.error) throw new Error(out.error)
  return out
}
const rangesArg = ranges => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')

// Add `name` to a folder's _slate.json order when it is not there (at `after` when given), leaving the rest alone.
async function addToOrder(dir, name, { after = null } = {}) {
  const f = path.join(dir, '_slate.json')
  const meta = await readJson(f, {})
  const order = Array.isArray(meta.order) ? meta.order : []
  if (order.includes(name)) return false
  const at = after != null && order.includes(after) ? order.indexOf(after) + 1 : order.length
  order.splice(at, 0, name)
  if (!DRY) await writeJson(f, { ...meta, order })
  return true
}

// A page holding one printout: the markdown, the sidecar with the PDF element (ink and notes on it kept), the file.
// `render(pdfPath)` makes the file — Chrome printing HTML for a MindTap chapter, python copying pages for a PDF book.
async function placePrintout({ mdPath, frontmatter, body, render, pdfName }) {
  const base = mdPath.replace(/\.md$/, ''), assets = base + '.assets', pdf = path.join(assets, pdfName)
  if (DRY) return { pdf, size: 0, pages: null }
  await fs.mkdir(assets, { recursive: true })
  await render(pdf)
  const size = (await fs.stat(pdf)).size
  const side = base + '.blocks.json'
  const prev = await readJson(side, { version: 1, elements: [] })
  const keep = (prev.elements || []).filter(e => e.type !== 'pdf' && e.type !== 'text' && !(e.type === 'file' && /\.pdf$/i.test(String(e.src || ''))))
  const old = (prev.elements || []).find(e => e.type === 'pdf' || (e.type === 'file' && /\.pdf$/i.test(String(e.src || ''))))
  const id = old?.id || newId()
  await writeJson(side, { version: 1, elements: [...keep, { id, type: 'pdf', src: `${path.basename(assets)}/${pdfName}`, size }] })
  const created = /created:\s*"?([^"\n]+)"?/.exec(await fs.readFile(mdPath, 'utf8').catch(() => ''))?.[1] || localStamp()
  await fs.writeFile(mdPath, `---\ncreated: "${created}"\n${frontmatter}\n---\n\n${body.trim()}\n`)
  const t = await textFor(pdf, { write: true }).catch(e => ({ error: e.message, pages: [] }))   // the words, for search, Ask and the sheet builder
  return { pdf, size, pages: t.pages?.length ?? null, textError: t.error || null }
}
const printRender = (html, dirs) => pdf => printHtml({ html, out: pdf, dirs })
const cutRender = ({ src, ranges, title, subtitle, book, note }) => async pdf => {
  if (process.env.SLATE_FAKE_PRINT === '1' && !(await python())) { await printHtml({ html: '', out: pdf }); return }   // the suite without PyMuPDF: a placeholder, as for Chrome
  await pdfTool(['cut', src, pdf, '--ranges', rangesArg(ranges), '--title', title, '--subtitle', subtitle || '', '--book', book || '', '--note', note || ''])
}

// ---- import ----------------------------------------------------------------------------------------------------------
async function importBook() {
  const key = val('--course')
  if (!key || !COURSES[key]) { console.error(`--course must name a course in scripts/lib/terms.mjs (got ${key || 'nothing'})`); process.exit(2) }
  if (val('--pdf')) return importPdf(key)
  const bundlePath = val('--bundle'), imagesDir = val('--images')
  if (!bundlePath || !(await exists(bundlePath))) { console.error('--bundle <mindtap.json> (or --pdf <book.pdf>) is required'); process.exit(2) }
  const only = val('--only') ? new Set(val('--only').split(',').map(s => s.trim())) : null
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'))
  const book = String(COURSES[key].textbook || bundle.title || 'the textbook').replace(/\s*·.*$/, '')
  const short = shortName(key)
  const dir = tbDir(key)
  const chapters = (bundle.chapters || []).filter(c => c?.chapter?.sections).sort((a, b) => a.order - b.order)
  if (!chapters.length) { console.error('the bundle holds no chapter documents'); process.exit(2) }
  const out = { course: key, book, short, format: 'mindtap', written: [], kept: [], images: 0, dry: DRY }

  // The sources and the figures first: the weekly pass reads these, and a chapter page can be rebuilt from them.
  if (!DRY) await fs.mkdir(path.join(dir, '_source'), { recursive: true })
  const wanted = new Set()
  const index = { book, short, format: 'mindtap', edition: val('--edition') || 'the WebAssign e-book', isbn: bundle.isbn || null, bookId: bundle.bookId || null, fetchedAt: bundle.fetchedAt || null, importedAt: localStamp(), chapters: [] }
  for (const c of chapters) {
    const doc = c.chapter, ord = String(doc.chapterOrdinal || '').trim()
    const type = String(doc.chapterType || '').toUpperCase() === 'APPENDIX' ? 'appendix' : 'chapter'
    const n = type === 'chapter' && /^\d+$/.test(ord) ? Number(ord) : null
    const title = pageName(c.name)
    const file = `_source/${String(c.order).padStart(2, '0')}.json`
    for (const s of doc.sections) for (const m of String(s.content || '').matchAll(/data-filename="([^"]+)"/g)) wanted.add(m[1])
    index.chapters.push({ order: c.order, n, type, title, page: title, source: file, pages: bookPages(groupSections(doc)), sections: groupSections(doc).filter(g => g.kind !== 'contents').map(g => ({ label: g.label, title: g.title, kind: g.kind })) })
    if (!DRY) await writeJson(path.join(dir, file), doc)
  }
  if (imagesDir) {
    if (!DRY) await fs.mkdir(path.join(dir, '_images'), { recursive: true })
    for (const f of wanted) {
      const from = path.join(imagesDir, f), to = path.join(dir, '_images', f)
      if (!(await exists(from))) continue
      if (!(await exists(to))) { if (!DRY) await fs.copyFile(from, to); out.images++ }
    }
  }
  index.figures = wanted.size
  if (!DRY) await writeJson(indexPath(key), index)

  // One page per chapter, the whole chapter printed.
  const order = []
  for (const c of chapters) {
    const entry = index.chapters.find(x => x.order === c.order)
    order.push(entry.page)
    if (only && !only.has(String(entry.n ?? '')) && !only.has(entry.title)) { out.kept.push(entry.page); continue }
    const mdPath = path.join(dir, `${entry.page}.md`)
    const pdfPath = path.join(dir, `${entry.page}.assets`, `${entry.page}.pdf`)
    if (!FORCE && await exists(pdfPath) && await exists(mdPath)) { out.kept.push(entry.page); continue }
    const groups = cutChapter(c.chapter, { all: true })
    const html = documentHtml({ title: entry.title, subtitle: [book, entry.pages ? `book ${entry.pages}` : null].filter(Boolean).join(' · '), book: `${short} · ${index.edition}`, groups })
    const list = entry.sections.filter(s => s.kind === 'section').map(s => `- ${s.label} ${s.title}`).join('\n')
    const body = `# ${entry.title}\n\n_${book} · ${index.edition}${entry.pages ? ` · book ${entry.pages}` : ''}_\n\n${list}`
    log(`${DRY ? 'would print' : 'printing'} ${entry.page} …`)
    const r = await placePrintout({ mdPath, frontmatter: `kind: "reading"\ntags: ["textbook", "${short}"]`, body, render: printRender(html, { _images: path.join(dir, '_images') }), pdfName: `${entry.page}.pdf` })
    out.written.push({ page: entry.page, pdf: path.relative(ROOT, r.pdf), size: r.size, pages: r.pages })
  }
  if (!DRY) {
    await writeJson(path.join(dir, '_slate.json'), { ...(await readJson(path.join(dir, '_slate.json'), {})), order, label: `${book} — ${index.edition}, a chapter a page; the week's sections are cut onto each week's own Textbook shelf.` })
    await addToOrder(path.join(ROOT, key), TEXTBOOK, { after: 'General' })
  }
  const lost = []
  for (const f of wanted) if (!(await exists(path.join(dir, '_images', f)))) lost.push(f)
  out.figuresMissing = lost.length
  return out
}

// The book that is one PDF: its outline → the index; a chapter page = the chapter's pages behind a cover.
async function importPdf(key) {
  const pdfPath = val('--pdf')
  if (!(await exists(pdfPath))) { console.error(`--pdf: no file at ${pdfPath}`); process.exit(2) }
  const only = val('--only') ? new Set(val('--only').split(',').map(s => s.trim())) : null
  const book = String(COURSES[key].textbook || 'the textbook').replace(/\s*·.*$/, '')
  const short = shortName(key)
  const edition = val('--edition') || 'the PDF'
  const dir = tbDir(key)
  const info = await pdfTool(['toc', pdfPath])
  let toc = info.toc, labels = info.labels || null
  if (val('--toc')) {
    // By hand: a list of [level, title, page] or { level, title, page }, or { toc, labels } when the file has no page
    // labels of its own and the hand outline says what the book prints on each page ("1", "E-6").
    const hand = JSON.parse(await fs.readFile(val('--toc'), 'utf8'))
    const offset = Number(val('--offset') || 0)
    toc = (Array.isArray(hand) ? hand : hand.toc || []).map(e => Array.isArray(e) ? [e[0], e[1], +e[2] + offset] : { ...e, page: +e.page + offset })
    if (!Array.isArray(hand) && Array.isArray(hand.labels) && hand.labels.length === info.pages) labels = hand.labels
  }
  const chapters = tocToChapters(toc, { pageCount: info.pages, labels })
  if (!chapters.length) { console.error(`the PDF's outline names no chapter (${info.toc.length} bookmarks) — pass --toc <json> with the chapters and their sections by page`); process.exit(2) }
  const out = { course: key, book, short, format: 'pdf', pages: info.pages, written: [], kept: [], dry: DRY }
  const source = '_source/book.pdf'
  if (!DRY) {
    await fs.mkdir(path.join(dir, '_source'), { recursive: true })
    const dst = path.join(dir, source)
    const same = (await exists(dst)) && (await fs.stat(dst)).size === (await fs.stat(pdfPath)).size
    if (!same) await fs.copyFile(pdfPath, dst)
    if (val('--toc')) await fs.copyFile(val('--toc'), path.join(dir, '_source', 'toc.json'))   // the hand-written outline, kept beside the book it describes
  }
  const index = { book, short, format: 'pdf', edition, source, toc: val('--toc') ? '_source/toc.json' : null, pageCount: info.pages, labels, importedAt: localStamp(), chapters: [] }
  chapters.forEach((c, i) => {
    const title = pageName(c.title)
    index.chapters.push({ order: i, n: c.n, type: c.type, title, page: title, from: c.from, to: c.to, pages: pageSpan([[c.from, c.to]], labels), sections: c.sections })
  })
  if (!DRY) await writeJson(indexPath(key), index)

  const order = []
  for (const entry of index.chapters) {
    order.push(entry.page)
    if (only && !only.has(String(entry.n ?? '')) && !only.has(entry.title)) { out.kept.push(entry.page); continue }
    const mdPath = path.join(dir, `${entry.page}.md`)
    const pdfOut = path.join(dir, `${entry.page}.assets`, `${entry.page}.pdf`)
    if (!FORCE && await exists(pdfOut) && await exists(mdPath)) { out.kept.push(entry.page); continue }
    const list = entry.sections.filter(s => s.kind === 'section').map(s => `- ${s.label} ${s.title}`).join('\n')
    const body = `# ${entry.title}\n\n_${book} · ${edition}${entry.pages ? ` · book ${entry.pages}` : ''}_\n\n${list}`
    log(`${DRY ? 'would cut' : 'cutting'} ${entry.page} (PDF pages ${entry.from}–${entry.to}) …`)
    const r = await placePrintout({ mdPath, frontmatter: `kind: "reading"\ntags: ["textbook", "${short}"]`, body, pdfName: `${entry.page}.pdf`,
      render: cutRender({ src: path.join(dir, source), ranges: [[entry.from, entry.to]], title: entry.title, subtitle: [book, entry.pages ? `book ${entry.pages}` : null].filter(Boolean).join(' · '), book: `${short} · ${edition}` }) })
    out.written.push({ page: entry.page, pdf: path.relative(ROOT, r.pdf), size: r.size, pages: r.pages })
  }
  if (!DRY) {
    await writeJson(path.join(dir, '_slate.json'), { ...(await readJson(path.join(dir, '_slate.json'), {})), order, label: `${book} — ${edition}, a chapter a page; the week's sections are cut onto each week's own Textbook shelf.` })
    await addToOrder(path.join(ROOT, key), TEXTBOOK, { after: 'General' })
  }
  return out
}

// ---- what a week reads -------------------------------------------------------------------------------------------------
// The outline's `chapters` line when scripts/lib/syllabus.mjs has one for the week (ECO227; '' means "nothing this
// week" and is respected), else the first "Read: Textbook …" line on a Quercus page synced into the week's folder
// (ECO206's topic pages, one a week, unlocked as the term goes — so a week that is still locked names nothing yet and
// is asked again tomorrow). → { chapters, source: 'outline' | 'topic page', page } or null.
async function weekReads(key, w, short) {
  const wk = SYLLABUS[key]?.weeks?.[w.n]
  if (wk && wk.chapters !== undefined) return /^(test|no class)/i.test(String(wk.topic || '')) || !wk.chapters ? null : { chapters: wk.chapters, source: 'outline', topic: wk.topic || '' }
  const weekDir = path.join(ROOT, key, w.dir)
  let names = []
  try { names = (await fs.readdir(weekDir)).filter(f => f.endsWith('.md')).sort() } catch { return null }
  for (const f of names) {
    const md = await fs.readFile(path.join(weekDir, f), 'utf8').catch(() => '')
    const head = md.slice(0, 600)
    if (!/tags:\s*\[[^\]]*"quercus"/.test(head)) continue
    const chapters = readLineChapters(md, { book: short })
    if (chapters) return { chapters, source: 'topic page', page: f.replace(/\.md$/, ''), topic: wk?.topic || (/^#\s+(?:\d+\s*[:.]\s*)?(.+)$/m.exec(md)?.[1] || '').trim() }
  }
  return null
}

// ---- the week's pages --------------------------------------------------------------------------------------------------
async function weekly() {
  const onlyCourse = val('--course'), onlyWeek = val('--week') ? Number(val('--week')) : null
  const report = { courses: [], waiting: [], dry: DRY }
  for (const [key, info] of Object.entries(COURSES)) {
    if (onlyCourse && key !== onlyCourse) continue
    const index = await readJson(indexPath(key), null)
    const short = index?.short || shortName(key)
    if (!index) {
      // No book in this notebook. A course whose terms.mjs line names one is worth a line: which weeks are waiting.
      if (!info.textbook) continue
      const named = []
      for (const w of weeks(info.term)) { if (onlyWeek != null && w.n !== onlyWeek) continue; const r = await weekReads(key, w, short); if (r) named.push({ week: w.n, chapters: r.chapters, source: r.source }) }
      if (named.length) report.waiting.push({ course: key, book: short, textbook: info.textbook, named })
      continue
    }
    const c = { course: key, book: short, format: index.format || 'mindtap', written: [], kept: [], skipped: [] }
    report.courses.push(c)
    const docs = new Map()                                         // chapter key → what the cut reads, read once
    const entryFor = k => typeof k === 'number'
      ? index.chapters.find(x => x.type === 'chapter' && x.n === k)
      : (() => { const name = k.slice('appendix:'.length); const apps = index.chapters.filter(x => x.type === 'appendix'); return name ? apps.find(x => x.title.toLowerCase().includes(name)) : (apps.length === 1 ? apps[0] : null) })()
    const docFor = async k => {
      if (docs.has(k)) return docs.get(k)
      const entry = entryFor(k)
      const doc = entry && index.format !== 'pdf' ? await readJson(path.join(tbDir(key), entry.source), null) : null
      docs.set(k, entry && (index.format === 'pdf' || doc) ? { entry, doc } : null)
      return docs.get(k)
    }
    const nameOf = k => (typeof k === 'number' ? `chapter ${k}` : `the ${k.slice('appendix:'.length) || ''} appendix`.replace(/\s+/g, ' '))
    for (const w of weeks(info.term)) {
      if (onlyWeek != null && w.n !== onlyWeek) continue
      const reads = await weekReads(key, w, short)
      if (!reads) continue
      const want = parseChapters(reads.chapters)
      if (!want.size) { c.skipped.push({ week: w.n, why: `nothing in "${reads.chapters}" names a chapter` }); continue }
      const title = readingTitle(short, reads.chapters)
      const groups = [], ranges = [], links = []
      for (const [k, v] of want) {
        const hit = await docFor(k)
        if (!hit) { c.skipped.push({ week: w.n, why: `${nameOf(k)} is not in the book on disk` }); continue }
        if (index.format === 'pdf') { const r = cutPdfRanges(hit.entry, v); if (r.length) { ranges.push(...r); links.push(hit.entry.page) } }
        else { const cut = cutChapter(hit.doc, v); if (cut.length) { groups.push(...cut); links.push(hit.entry.page) } }
      }
      if (!groups.length && !ranges.length) { c.skipped.push({ week: w.n, why: `no section of the book matches "${reads.chapters}"` }); continue }
      const weekDir = path.join(ROOT, key, w.dir), shelf = path.join(weekDir, TEXTBOOK)   // the week's own Textbook shelf, beside Readings
      const mdPath = path.join(shelf, `${title}.md`), pdfPath = path.join(shelf, `${title}.assets`, `${title}.pdf`)
      if (!FORCE && await exists(mdPath) && await exists(pdfPath)) { c.kept.push({ week: w.n, page: title }); continue }
      // no Python to cut a PDF book with: the week is skipped and says why, rather than the morning's textbook step failing
      if (index.format === 'pdf' && !DRY && process.env.SLATE_FAKE_PRINT !== '1' && !(await python())) { c.skipped.push({ week: w.n, why: NO_PYTHON }); continue }
      const pages = index.format === 'pdf' ? pageSpan(ranges, index.labels) : bookPages(groups)
      const edition = editionOf(index)
      const said = reads.source === 'outline' ? 'the course outline names' : 'the topic page names'
      const subtitle = [reads.topic, w.label, pages ? `book ${pages}` : null].filter(Boolean).join(' · ')
      const note = `The sections ${said} for this week. The whole chapter is under ${TEXTBOOK}.`
      const list = index.format === 'pdf'
        ? [...want].map(([k, v]) => { const e = entryFor(k); if (!e) return null; const secs = v.all ? e.sections.filter(s => s.kind === 'section') : e.sections.filter(s => s.kind === 'section' && (v.sections?.has(Number(String(s.label).split('.')[1])) || (v.fromEnd != null && Number(String(s.label).split('.')[1]) >= v.fromEnd))); return v.all ? `- ${e.title}${e.pages ? ` (${e.pages})` : ''}` : secs.map(s => `- ${s.label} ${s.title}`).join('\n') }).filter(Boolean).join('\n')
        : groups.filter(g => g.kind !== 'contents').map(g => `- ${g.label ? g.label + ' ' : ''}${g.title}${g.sections.length > 1 ? ` (with ${g.sections.slice(1).map(s => s.sectionTitle).filter(Boolean).join(', ').toLowerCase()})` : ''}`).join('\n')
      const from = reads.source === 'topic page' && reads.page ? ` · named on [[${w.label}/${reads.page}]]` : ''
      const body = `# ${title}\n\n_${index.book} · ${reads.topic || w.label}${reads.topic ? ` · ${w.label}` : ''}${pages ? ` · book ${pages}` : ''} · cut from ${[...new Set(links)].map(l => `[[${l}]]`).join(', ')}${from}_\n\n${list}`
      log(`${DRY ? (index.format === 'pdf' ? 'would cut' : 'would print') : (index.format === 'pdf' ? 'cutting' : 'printing')} ${key} · ${w.label} · ${title} (${reads.source}) …`)
      if (!DRY) await fs.mkdir(shelf, { recursive: true })
      const render = index.format === 'pdf'
        ? cutRender({ src: path.join(tbDir(key), index.source), ranges, title, subtitle, book: `${short} · ${edition}`, note })   // in the order the week names them (3.4, 4.1, 5.4, then 2.5), each chapter's own pages already merged
        : printRender(documentHtml({ title, subtitle, book: `${short} · ${edition}`, groups, note }), { _images: path.join(tbDir(key), '_images') })
      const r = await placePrintout({ mdPath, frontmatter: `kind: "reading"\ntags: ["textbook", "${short}"]\nfor: "both"`, body, render, pdfName: `${title}.pdf` })
      if (!DRY) await addToOrder(shelf, title)
      c.written.push({ week: w.n, page: title, source: reads.source, path: path.relative(ROOT, mdPath), pdf: path.relative(ROOT, r.pdf), size: r.size, pages: r.pages, textError: r.textError })
    }
  }
  return report
}

const result = IMPORT ? await importBook() : await weekly()
if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
else if (IMPORT) console.log(`${result.course}: ${result.written.length} chapter page${result.written.length === 1 ? '' : 's'} ${DRY ? 'would be ' : ''}written, ${result.kept.length} kept${result.format === 'mindtap' ? `, ${result.images} figure${result.images === 1 ? '' : 's'} copied${result.figuresMissing ? `, ${result.figuresMissing} figure(s) missing` : ''}` : ` (${result.pages} PDF pages)`}.`)
else {
  if (!result.courses.length && !result.waiting.length) console.log('No notebook holds a textbook yet — nothing to cut. (scripts/textbook.mjs import puts one there.)')
  for (const c of result.courses) {
    console.log(`${c.course} · ${c.book}: ${c.written.length} week page${c.written.length === 1 ? '' : 's'} ${DRY ? 'would be ' : ''}written, ${c.kept.length} already there${c.skipped.length ? `, ${c.skipped.length} skipped` : ''}.`)
    for (const s of c.skipped) console.log(`  week ${s.week}: ${s.why}`)
    for (const x of c.written) console.log(`  week ${x.week}: ${x.page}${x.pages != null ? ` · ${x.pages} pages` : ''} · ${x.source}${x.textError ? ` · text: ${x.textError}` : ''}`)
  }
  for (const wt of result.waiting) {
    console.log(`${wt.course} · ${wt.book}: the book is not in the notebook yet (scripts/textbook.mjs import --course "${wt.course}" --pdf …); ${wt.named.length} week${wt.named.length === 1 ? '' : 's'} waiting for it:`)
    for (const n of wt.named) console.log(`  week ${n.week}: ${wt.book} ${n.chapters} (${n.source})`)
  }
}
