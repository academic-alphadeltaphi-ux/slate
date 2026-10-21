// A page per problem (SPEC §20.73). Every itemised row on a week's Problems page, in a course with `problemPages`, gets
// `<Week>/Problems/<set>/<name>.md` (the path is `problemPageRel` in src/problems.js, from the label alone): the question
// cut out of its PDF, room to work, and the solution folded to a pill until he asks for it. The solution is the course's
// own when a file has one — the set's `…_Questions_and_Solutions.pdf`, or the `Answer:` under the question in the same
// file — and otherwise Claude's, written by the morning run through `problem-pages.mjs solve` and marked as Claude's.
//
// What the script owns, and only while nobody has touched it: the page's first block (the source line and the cropped
// question) and the solution block, each recorded by hash in Hub/_problem-pages.json (the §20.2 header rule). The
// `## My work` block and anything he writes or draws are his from the first second; a crop he or the morning run cut by
// hand (`crop`) is never recut.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { COURSES, weeks, localStamp, todayIso } from './terms.mjs'
import { pageRel, readProblemsPage, readJson, writeAtomic, sha1, patchFrontmatterRaw } from './problems.mjs'
import { problemPlace, problemPageRel, docRole, setKey, labelText } from '../../src/problems.js'
import { parsePage, joinPage, newId } from '../../server/format.js'
import { acquireLock } from './brain.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REGISTRY = root => path.join(root, 'Hub', '_problem-pages.json')
const PY = () => process.env.SLATE_OCR_PYTHON || path.join(os.homedir(), '.local/share/slate/venv/bin/python')
const CROP = path.join(REPO, 'scripts', 'problem-crop.py')
// The week page's column: FLOW_X, FLOW_TOP and MAX_AUTO_W in src/layout.js. The solution is pinned a screen of empty
// paper below the work heading, so writing under the question never runs into it.
const FLOW_X = 48, FLOW_TOP = 48, COLUMN = 645, RULE = 24, WORK_ROOM = 624
const snap = y => Math.round(y / RULE) * RULE
const exists = p => fsSync.existsSync(p)
const readText = async p => { try { return await fs.readFile(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const encSrc = s => String(s).replace(/ /g, '%20')
const wikiTitle = src => { const m = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(String(src || '').trim()); return m ? m[1].trim() : null }

export function python(args, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(PY(), ['-I', CROP, ...args], { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      let out = null
      try { out = JSON.parse(String(stdout || '').trim().split('\n').pop() || 'null') } catch { }
      if (out) return resolve(out)
      reject(new Error(err ? `problem-crop.py: ${err.message.split('\n')[0]}` : 'problem-crop.py printed nothing'))
    })
  })
}
export const pythonReady = () => exists(PY())

// ---- where each problem is -------------------------------------------------------------------------------------------
// The course's textbook, chapter by chapter: its page, the PDF on it (a screenshot PDF or a cut of the book), the pages.
async function textbookOf(root, courseKey) {
  const dir = path.join(root, courseKey, 'Textbook')
  const idx = await readJson(path.join(dir, '_textbook.json'), null)
  if (!idx) return null
  const chapters = new Map()
  for (const c of idx.chapters || []) {
    if (c.type && c.type !== 'chapter') continue
    const page = c.page || c.title
    const pdf = await pdfOn(path.join(dir, page + '.md'))
    chapters.set(Number(c.n), { n: Number(c.n), title: c.title || page, page: `${courseKey}/Textbook/${page}.md`, pdf, pages: c.pages || null })
  }
  return { book: idx.book || idx.short || 'the textbook', short: idx.short || null, heading: idx.problemsHeading || 'Problems', chapters }
}
// The first PDF a page shows, absolute, or null.
async function pdfOn(absMd) {
  const side = await readJson(absMd.replace(/\.md$/, '.blocks.json'), null)
  const el = (side?.elements || []).find(e => (e.type === 'pdf' || e.type === 'file') && /\.pdf$/i.test(e.src || ''))
  if (!el) return null
  const abs = path.join(path.dirname(absMd), el.src)
  return exists(abs) ? abs : null
}
// A document the row names, filed somewhere in its week: Problems/, Lectures/, the week folder itself.
async function findDoc(root, weekRel, title) {
  const base = path.join(root, weekRel)
  for (const sub of ['Problems', '', 'Lectures', 'Readings', 'Assignments']) {
    const abs = path.join(base, sub, title + '.md')
    if (exists(abs)) return { rel: path.posix.join(weekRel, sub, title + '.md').replace(/\/\//g, '/'), abs, dir: path.join(base, sub) }
  }
  return null
}
// The solutions that pair with a questions document (src/problems.js pairSets' rule: the same set name, the other role).
async function solutionsFor(doc) {
  const title = path.basename(doc.abs, '.md')
  if (docRole(title) !== 'questions') return null
  const names = (await fs.readdir(doc.dir).catch(() => [])).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
  const other = names.find(n => n !== title && docRole(n) === 'solutions' && setKey(n) === setKey(title))
  if (!other) return null
  const abs = path.join(doc.dir, other + '.md')
  const pdf = await pdfOn(abs)
  return pdf ? { title: other, pdf } : null
}

// What one row's page is cut from. { kind: 'book', … } | { kind: 'doc', … } | { kind: 'waiting', … } | { kind: 'none', why }
async function sourceOf(root, job, book) {
  const { place, row, weekRel } = job
  if (place.chapter != null) {
    const ch = book?.chapters.get(place.chapter)
    if (!book || !ch) return { kind: 'none', why: `no Chapter ${place.chapter} in this course's Textbook section` }
    if (!ch.pdf) return { kind: 'waiting', chapter: ch, book }
    return { kind: 'book', pdf: ch.pdf, n: place.n, after: book.heading, chapter: ch, book, solutions: null }
  }
  const title = wikiTitle(row.src)
  if (!title) return { kind: 'none', why: 'the row names no document' }
  const doc = await findDoc(root, weekRel, title)
  if (!doc) return { kind: 'none', why: `“${title}” is not filed in ${weekRel}` }
  const pdf = await pdfOn(doc.abs)
  if (!pdf) return { kind: 'none', why: `“${title}” has no PDF on it` }
  if (!place.n) return { kind: 'none', why: `no question number in “${labelText(row.label)}”` }
  return { kind: 'doc', pdf, n: place.n, after: null, doc: { title, rel: doc.rel }, solutions: await solutionsFor(doc), selfSolved: docRole(title) === 'solutions' }
}

// ---- the page --------------------------------------------------------------------------------------------------------
const nameOfWeek = w => w.label.replace(/\s*\(.*\)$/, '')
function headBlock(job, src, crop) {
  const w = job.week, weekLink = `[[${w.dir.split('/').pop()}/Problems|${nameOfWeek(w)}'s problems]]`
  const asked = wikiTitle(job.row.src)
  const bits = []
  if (src.kind === 'book' || src.kind === 'waiting') {
    bits.push(src.book.book, `[[${src.chapter.page.replace(/^[^/]+\//, '').replace(/\.md$/, '')}|${src.chapter.title}]]`)
    if (asked) bits.push(`set in [[${asked}]]`)
  } else if (src.kind === 'doc') {
    const pages = [...new Set((crop?.question || []).map(p => p.page))]
    bits.push(`From [[${src.doc.title}]]${pages.length ? `, p. ${pages.join('–')}` : ''}`)
  } else if (asked) bits.push(`Set in [[${asked}]]`)
  bits.push(weekLink)
  const meta = `_${bits.join(' · ')}_`
  const label = labelText(job.row.label)
  if (src.kind === 'waiting') {
    const ch = src.chapter
    const short = `Chapter ${ch.n}`
    return `${meta}\n\n**${label} is not in slate yet:** ${short} has no pages here. Screenshot ${short}${ch.pages ? ` (${ch.pages})` : ''} in ${src.book.short === 'Williamson' ? 'BibliU' : 'the e-book'} and give the screenshots to Claude, who files them on [[${ch.page.replace(/^[^/]+\//, '').replace(/\.md$/, '')}|${short}]]; the next morning run then cuts this problem out and works its solution.`
  }
  if (src.kind === 'none' || !crop?.questionPng) return `${meta}\n\n**The question could not be cut out of its file** (${crop?.error || src.why}). Open the source above; the morning run cuts it by hand.`
  return `${meta}\n\n![${label}](${encSrc(`${job.place.name}.assets/question.png`)})`
}
const WORK = '## My work'
function solutionBlock({ official, claude, waiting }) {
  const parts = ['## Solution']
  if (official) parts.push(`_The course's own${official.title ? `, from [[${official.title}]]` : ''}${official.pages?.length ? `, p. ${official.pages.join('–')}` : ''}._`, `![Solution](${encSrc(official.src)})`)
  if (claude) parts.push(official ? '### Worked by Claude' : '', `_Worked by Claude, not the course's — every number recomputed (${claude.date}). Where it and your tutorial disagree, the tutorial wins; say so on the page._`, claude.md.trim())
  if (!official && !claude) parts.push(waiting ? '_Waits for the problem itself._' : `_Not written yet: the next morning run works it out and checks every number._`)
  return parts.filter(Boolean).join('\n\n')
}
const solutionTitle = ({ official, claude }) => (official ? "Solution · the course's" : claude ? 'Solution · worked by Claude' : 'Solution · not written yet')
const solutionKind = ({ official, claude }) => (official ? 'official' : claude ? 'claude' : 'pending')

// Read what the page's assets hold now: the course's solution picture, Claude's text.
async function solutionParts(absPage, entry, waiting) {
  const assets = absPage.replace(/\.md$/, '.assets')
  const name = path.basename(absPage, '.md')
  const official = exists(path.join(assets, 'solution.png')) ? { src: `${name}.assets/solution.png`, title: entry?.solutionFrom?.title || null, pages: entry?.solutionFrom?.pages || null } : null
  const md = await readText(path.join(assets, 'claude-solution.md'))
  const claude = md && md.trim() ? { md: md.replace(/^<!--\s*(\d{4}-\d{2}-\d{2})\s*-->\n?/, ''), date: /^<!--\s*(\d{4}-\d{2}-\d{2})\s*-->/.exec(md)?.[1] || todayIso() } : null
  return { official, claude, waiting }
}

// Write or refresh one page. `crop` is { questionPng, questionH, questionW, solutionPng, pages, … } or null.
async function writePage(root, job, src, crop, reg, { dry }) {
  const abs = path.join(root, job.rel)
  const old = await readText(abs)
  const entry = reg.pages[job.rel] || {}
  const waiting = src.kind === 'waiting'
  if (crop?.solutionFrom) entry.solutionFrom = crop.solutionFrom
  const sol = await solutionParts(abs, entry, waiting)
  const head = headBlock(job, src, crop), solMd = solutionBlock(sol)
  // The picture is drawn at two pixels a point and shown at its pixel width, down to the column: 2·W px wide at most 645.
  const imgH = crop?.questionW ? Math.round(2 * crop.questionH * Math.min(COLUMN, 2 * crop.questionW) / (2 * crop.questionW)) : 96
  const solY = snap(FLOW_TOP + 120 + imgH + 48 + 48 + WORK_ROOM)
  const fm = { kind: 'problem', tags: ['problem'], ...(job.for ? { for: job.for } : {}), problem: labelText(job.row.label), solution: waiting ? 'waiting' : solutionKind(sol) }
  let changed = false, created = false
  if (old === null) {
    const solId = newId(), workId = newId()
    const page = { frontmatterRaw: patchFrontmatterRaw('', { created: localStamp(), ...fm }), blocks: [{ id: null, md: head }, { id: workId, md: WORK }, { id: solId, md: solMd }] }
    const side = { version: 1, elements: [{ id: workId, type: 'text', w: 'auto' }, { id: solId, type: 'text', x: FLOW_X, y: solY, w: 'auto', z: 1, hidden: true, title: solutionTitle(sol) }] }
    if (!dry) {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await writeAtomic(abs, joinPage(page))
      await writeAtomic(abs.replace(/\.md$/, '.blocks.json'), JSON.stringify(side, null, 2) + '\n')
    }
    Object.assign(entry, { head: sha1(head), solution: sha1(solMd), solutionId: solId, y: solY, kind: fm.solution })
    changed = created = true
  } else {
    const pg = parsePage(old)
    const blocks = pg.blocks.slice()
    const i0 = blocks[0]?.id === null ? 0 : -1
    // The first block: rewritten only while it is still exactly what this script last wrote.
    if (i0 === 0 && blocks[0].md !== head && sha1(blocks[0].md) === entry.head) { blocks[0] = { id: null, md: head }; entry.head = sha1(head); changed = true }
    const si = blocks.findIndex(b => b.id && b.id === entry.solutionId)
    const kindNow = waiting ? 'waiting' : solutionKind(sol)
    let refold = false
    if (si >= 0 && blocks[si].md !== solMd && sha1(blocks[si].md) === entry.solution) { blocks[si] = { id: blocks[si].id, md: solMd }; entry.solution = sha1(solMd); changed = true; refold = kindNow !== entry.kind }
    let frontmatterRaw = pg.frontmatterRaw
    if (pg.frontmatter?.solution !== fm.solution) { frontmatterRaw = patchFrontmatterRaw(pg.frontmatterRaw || '', { solution: fm.solution }); changed = true }
    if (changed && !dry) {
      await writeAtomic(abs, joinPage({ frontmatterRaw, blocks }))
      // A solution that has just become something to read folds again, with the pill saying what it is; a pill he has
      // not moved follows the question's new height.
      const sideAbs = abs.replace(/\.md$/, '.blocks.json')
      const side = await readJson(sideAbs, { version: 1, elements: [] })
      const el = side.elements.find(e => e.id === entry.solutionId)
      if (el) {
        if (refold) el.hidden = true
        el.title = solutionTitle(sol)
        if (el.y === entry.y && solY !== entry.y) { el.y = solY; entry.y = solY }
        await writeAtomic(sideAbs, JSON.stringify(side, null, 2) + '\n')
      }
    }
    entry.kind = kindNow
  }
  Object.assign(entry, { course: job.courseKey, week: job.week.n, problem: labelText(job.row.label), source: src.kind === 'book' || src.kind === 'doc' ? path.relative(root, src.pdf) : null, updatedAt: localStamp() })
  reg.pages[job.rel] = entry
  return { changed, created }
}

// ---- cutting -----------------------------------------------------------------------------------------------------------
async function render(png, parts, pdf) {
  await fs.mkdir(path.dirname(png), { recursive: true })
  return python(['render', png, ...parts.flatMap(p => ['--part', `${pdf}@${p.page}:${p.rect.join(',')}`])])
}
// Locate every job cut from one file in one read of it, then render each question (and the solution the same file holds).
async function cutFrom(root, pdf, jobs, { dry }) {
  const after = jobs[0].src.after
  const ns = [...new Set(jobs.map(j => j.src.n))]
  let loc
  try { loc = await python(['locate', pdf, '--n', ns.join(','), ...(after ? ['--after', after] : [])]) }
  catch (e) { for (const j of jobs) j.crop = { error: e.message }; return }
  for (const j of jobs) {
    const it = loc.items?.[String(j.src.n)]
    if (loc.error || !it || it.error) { j.crop = { error: loc.error || it?.error || 'not found' }; continue }
    j.crop = { question: it.question, text: it.text || null }
    if (dry) continue
    const assets = path.join(root, j.rel.replace(/\.md$/, '.assets'))
    if (j.manual) continue
    const q = await render(path.join(assets, 'question.png'), it.question, pdf).catch(e => ({ error: e.message }))
    if (q.error) { j.crop.error = q.error; continue }
    Object.assign(j.crop, { questionPng: q.out, questionW: q.width / 2, questionH: q.height / 2 })
    if (it.solution?.length && j.src.selfSolved) {
      const s = await render(path.join(assets, 'solution.png'), it.solution, pdf).catch(() => null)
      if (s && !s.error) j.crop.solutionFrom = { title: j.src.doc?.title || null, pages: [...new Set(it.solution.map(p => p.page))] }
    }
  }
}
// The course's own solutions file: cut each question's `Solution` part out of it.
async function cutSolutions(root, pdf, title, jobs, { dry }) {
  let loc
  try { loc = await python(['locate', pdf, '--n', [...new Set(jobs.map(j => j.src.n))].join(',')]) } catch { return }
  for (const j of jobs) {
    const it = loc.items?.[String(j.src.n)]
    if (!it || it.error) continue
    const parts = it.solution?.length ? it.solution : it.question       // no `Solution:` line: the whole answered question
    if (!parts?.length || dry) continue
    const s = await render(path.join(root, j.rel.replace(/\.md$/, '.assets'), 'solution.png'), parts, pdf).catch(() => null)
    if (s && !s.error) j.crop = { ...(j.crop || {}), solutionFrom: { title, pages: [...new Set(parts.map(p => p.page))] } }
  }
}

// build(root, opts) → { pages, created, updated, pending: [rel], waiting: [{ page, chapter }], errors: [{ page, error }] }
export const courseKeyOf = c => (!c ? null : COURSES[c] ? c : Object.keys(COURSES).find(k => COURSES[k].code === c) || c)
export async function build(root, { course = null, week = null, force = false, dry = false, log = () => { } } = {}) {
  course = courseKeyOf(course)
  const reg = await readJson(REGISTRY(root), { pages: {} }); reg.pages ||= {}
  const out = { pages: 0, created: 0, updated: 0, pending: [], waiting: [], errors: [] }
  for (const [courseKey, info] of Object.entries(COURSES)) {
    if (!info.problemPages) continue
    if (course && course !== courseKey) continue
    const book = await textbookOf(root, courseKey)
    for (const w of weeks(info.term)) {
      if (week != null && w.n !== Number(week)) continue
      const pg = await readProblemsPage(root, pageRel(courseKey, w), null)
      if (!pg) continue
      const weekRel = `${courseKey}/${w.dir}`
      const jobs = []
      const seen = new Set()
      for (const row of pg.rows) {
        const place = problemPlace(row.label)
        if (!place) continue
        const rel = problemPageRel(weekRel, row.label)
        if (seen.has(rel)) continue
        seen.add(rel)
        const job = { courseKey, week: w, weekRel, row, place, rel }
        job.src = await sourceOf(root, job, book)
        const entry = reg.pages[rel]
        job.manual = !!entry?.manual
        const haveQ = exists(path.join(root, rel.replace(/\.md$/, '.assets'), 'question.png'))
        // Cut again only when there is nothing yet, the source changed, or --force; a page already cut is left alone.
        job.needsCut = (job.src.kind === 'book' || job.src.kind === 'doc') && !job.manual && (force || !haveQ || entry?.source !== path.relative(root, job.src.pdf))
        if (job.src.kind === 'doc') {
          const docMd = await readText(path.join(root, job.src.doc.rel))
          job.for = /^for:\s*"?(lecture|tutorial|both)"?/m.exec(docMd || '')?.[1] || null
        }
        jobs.push(job)
      }
      if (!jobs.length) continue
      // One read of each file for all the problems cut from it.
      const byPdf = new Map()
      for (const j of jobs.filter(j => j.needsCut)) { const k = j.src.pdf; if (!byPdf.has(k)) byPdf.set(k, []); byPdf.get(k).push(j) }
      for (const [pdf, js] of byPdf) await cutFrom(root, pdf, js, { dry })
      const bySol = new Map()
      for (const j of jobs.filter(j => j.src.kind === 'doc' && j.src.solutions && (j.needsCut || !exists(path.join(root, j.rel.replace(/\.md$/, '.assets'), 'solution.png'))))) {
        const k = j.src.solutions.pdf; if (!bySol.has(k)) bySol.set(k, []); bySol.get(k).push(j)
      }
      for (const [pdf, js] of bySol) await cutSolutions(root, pdf, js[0].src.solutions.title, js, { dry })
      for (const j of jobs) {
        // A page cut on an earlier run keeps its picture: say so to the head block.
        if (!j.needsCut && (j.src.kind === 'book' || j.src.kind === 'doc')) {
          const png = path.join(root, j.rel.replace(/\.md$/, '.assets'), 'question.png')
          if (exists(png)) { const e = reg.pages[j.rel] || {}; j.crop = { ...(j.crop || {}), questionPng: png, questionW: e.questionW || COLUMN, questionH: e.questionH || 96, question: e.questionParts || null } }
        }
        if (j.crop?.questionPng && j.crop.question) Object.assign(reg.pages[j.rel] ||= {}, { questionW: j.crop.questionW, questionH: j.crop.questionH, questionParts: j.crop.question })
        if (j.crop?.text && !dry) await fs.writeFile(path.join(root, j.rel.replace(/\.md$/, '.assets'), 'question.txt'), j.crop.text).catch(() => { })
        const r = await writePage(root, j, j.src, j.crop, reg, { dry })
        out.pages++
        if (r.created) out.created++; else if (r.changed) out.updated++
        const e = reg.pages[j.rel]
        if (j.src.kind === 'waiting') out.waiting.push({ page: j.rel, chapter: j.src.chapter.title, pages: j.src.chapter.pages })
        else if (j.src.kind === 'none' || j.crop?.error) out.errors.push({ page: j.rel, error: j.crop?.error || j.src.why })
        if (e?.kind === 'pending') out.pending.push(j.rel)
        log(`  ${j.rel}: ${r.created ? 'created' : r.changed ? 'updated' : 'unchanged'} · ${e?.kind || j.src.kind}${j.crop?.error ? ' · ' + j.crop.error : ''}`)
      }
    }
  }
  if (!dry) await saveRegistry(root, reg, { course })
  return out
}

// Merge this run's entries into the registry under the brain's lock: two course agents may run this at once.
async function saveRegistry(root, reg, { course }) {
  const release = await acquireLock(root)
  try {
    const now = await readJson(REGISTRY(root), { pages: {} }); now.pages ||= {}
    for (const [rel, e] of Object.entries(reg.pages)) if (!course || e.course === course) now.pages[rel] = e
    now.updatedAt = localStamp()
    await writeAtomic(REGISTRY(root), JSON.stringify(now, null, 2) + '\n')
  } finally { await release?.() }
}

// ---- Claude's solution, and a crop by hand ---------------------------------------------------------------------------
// `figures`: SVG or PNG files the solution draws (a budget line, indifference curves). Each is copied into the page's
// assets and `![…](<its file name>)` in the markdown is pointed at the copy.
export async function solve(root, rel, md, { figures = [] } = {}) {
  const abs = path.join(root, rel)
  if (!exists(abs)) throw new Error(`no such page: ${rel}`)
  let text = String(md || '').trim()
  if (text.length < 40) throw new Error('the solution is empty or too short to be one')
  if (/^#{1,2}\s/m.test(text)) throw new Error('start at ### or below: the block already has its ## Solution heading')
  const assets = abs.replace(/\.md$/, '.assets'), name = path.basename(abs, '.md')
  await fs.mkdir(assets, { recursive: true })
  for (const f of figures) {
    if (!/\.(svg|png)$/i.test(f)) throw new Error(`a figure is an .svg or a .png: ${f}`)
    const base = path.basename(f)
    if (['question.png', 'solution.png'].includes(base)) throw new Error(`${base} is the page's own picture; name the figure something else`)
    if (/\.svg$/i.test(base)) {
      // Paper of its own: a transparent figure drawn in black vanishes on the dark theme's sheet.
      const svg = await fs.readFile(f, 'utf8')
      const first = /<rect\b[^>]*>/i.exec(svg)?.[0] || ''
      const white = /fill="(?:#fff|#ffffff|white)"/i.test(first) && /width="100%"|\bx="0"/.test(first)
      await fs.writeFile(path.join(assets, base), white ? svg : svg.replace(/(<svg\b[^>]*>)/i, '$1<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>'))
    } else await fs.copyFile(f, path.join(assets, base))
    text = text.split(`](${base})`).join(`](${encSrc(`${name}.assets/${base}`)})`)
  }
  await fs.writeFile(path.join(assets, 'claude-solution.md'), `<!-- ${todayIso()} -->\n${text}\n`)
  return refresh(root, rel)
}
// Rewrite one page's solution block from what its assets hold now (after solve or crop).
async function refresh(root, rel) {
  const reg = await readJson(REGISTRY(root), { pages: {} }); reg.pages ||= {}
  const e = reg.pages[rel]
  if (!e) throw new Error(`${rel} is not a page problem-pages.mjs made`)
  const abs = path.join(root, rel)
  const pg = parsePage(await fs.readFile(abs, 'utf8'))
  const sol = await solutionParts(abs, e, e.kind === 'waiting')
  const md = solutionBlock(sol)
  const si = pg.blocks.findIndex(b => b.id === e.solutionId)
  if (si < 0) return { page: rel, written: false, why: 'the solution block is gone from the page' }
  if (sha1(pg.blocks[si].md) !== e.solution && pg.blocks[si].md !== md) return { page: rel, written: false, why: 'the solution block was edited on the page; left as it is' }
  const kindNow = solutionKind(sol)
  pg.blocks[si] = { id: e.solutionId, md }
  await writeAtomic(abs, joinPage({ frontmatterRaw: patchFrontmatterRaw(pg.frontmatterRaw || '', { solution: kindNow }), blocks: pg.blocks }))
  const sideAbs = abs.replace(/\.md$/, '.blocks.json')
  const side = await readJson(sideAbs, { version: 1, elements: [] })
  const el = side.elements.find(x => x.id === e.solutionId)
  if (el) { if (kindNow !== e.kind) el.hidden = true; el.title = solutionTitle(sol); await writeAtomic(sideAbs, JSON.stringify(side, null, 2) + '\n') }
  Object.assign(e, { solution: sha1(md), kind: kindNow, updatedAt: localStamp() })
  const release = await acquireLock(root)
  try { const now = await readJson(REGISTRY(root), { pages: {} }); now.pages ||= {}; now.pages[rel] = e; await writeAtomic(REGISTRY(root), JSON.stringify(now, null, 2) + '\n') }
  finally { await release?.() }
  return { page: rel, written: true, solution: kindNow }
}
// crop(root, rel, parts, { solution }) — parts: ["<pdf>@<page>:<x0>,<y0>,<x1>,<y1>", …], the pdf absolute or relative to
// the notes root. Marks the page's crop as cut by hand, so no later run recuts it.
export async function crop(root, rel, parts, { solution = false } = {}) {
  const reg = await readJson(REGISTRY(root), { pages: {} }); reg.pages ||= {}
  const e = reg.pages[rel]
  if (!e) throw new Error(`${rel} is not a page problem-pages.mjs made`)
  const specs = parts.map(p => { const m = /^(.*)@(\d+):([\d.,]+)$/.exec(p); if (!m) throw new Error(`bad --part ${p}`); return `${path.isAbsolute(m[1]) ? m[1] : path.join(root, m[1])}@${m[2]}:${m[3]}` })
  const png = path.join(root, rel.replace(/\.md$/, '.assets'), solution ? 'solution.png' : 'question.png')
  await fs.mkdir(path.dirname(png), { recursive: true })
  const r = await python(['render', png, ...specs.flatMap(s => ['--part', s])])
  if (r.error) throw new Error(r.error)
  if (solution) e.solutionFrom = { title: e.solutionFrom?.title || null, pages: specs.map(s => Number(/@(\d+):/.exec(s)[1])) }
  else Object.assign(e, { manual: true, questionW: r.width / 2, questionH: r.height / 2 })
  const release = await acquireLock(root)
  try { const now = await readJson(REGISTRY(root), { pages: {} }); now.pages ||= {}; now.pages[rel] = e; await writeAtomic(REGISTRY(root), JSON.stringify(now, null, 2) + '\n') }
  finally { await release?.() }
  return solution ? refresh(root, rel) : { page: rel, written: true, png: path.relative(root, png) }
}

// status(root) → every page with what it still needs: Claude's solution (pending), the book (waiting), a cut (errors).
export async function status(root, { course = null } = {}) {
  course = courseKeyOf(course)
  const reg = await readJson(REGISTRY(root), { pages: {} })
  const rows = []
  for (const [rel, e] of Object.entries(reg.pages || {})) {
    if (course && e.course !== course) continue
    if (!exists(path.join(root, rel))) continue
    const assets = path.join(root, rel.replace(/\.md$/, '.assets'))
    rows.push({ page: rel, problem: e.problem, course: e.course, week: e.week, solution: e.kind, source: e.source, question: exists(path.join(assets, 'question.png')) ? path.join(assets, 'question.png') : null,
      text: await readText(path.join(assets, 'question.txt')), manual: !!e.manual })
  }
  return rows.sort((a, b) => a.page.localeCompare(b.page))
}
