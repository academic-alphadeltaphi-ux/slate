#!/usr/bin/env node
// The study set (SPEC §21.16): a study guide, an exercise sheet and a week at a glance for one week of one course, built
// by the student's own Claude when they ask for it, and printed onto pages in that week's `Study set` folder.
// The skill is optional: it ships in extras/study-set-pro/ and is not a skill until `add` copies it into .claude/skills/.
//
//   node scripts/study-set.mjs add | remove | status          the skill itself
//   node scripts/study-set.mjs start <course> <week>          the week's sources, and a work folder for this set
//   node scripts/study-set.mjs pages <work> <pdf> <pages>     PDF pages as pictures (ink and figures included): 3,5,7-9
//   node scripts/study-set.mjs check <work> guide|sheet|glance [--list] [--no-render]
//   node scripts/study-set.mjs print <work> guide|sheet|glance
//
// <work> is study-set-work/<CODE>-week-<N> in this folder (what `start` printed); a bare <CODE>-week-<N> is found there.
// Inside it: brief.md and formulas.json (the main writer's), guide/ and sheet/ (HTML parts in name order, an optional
// figs.mjs), glance.mjs (the glance spec), images/ (pages), out/ (what check and print build). Nothing here talks to
// Claude, Quercus or the network, except the MathJax a page loads while it is rendered.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, notesRoot } from './lib/root.mjs'
import { COURSES, weeks, localStamp } from './lib/terms.mjs'
import { newId } from '../server/format.js'

const args = process.argv.slice(2)
const cmd = args[0]
const flag = n => args.includes(n)
const SRC = path.join(REPO, 'extras', 'study-set-pro'), DEST = path.join(REPO, '.claude', 'skills', 'study-set-pro')
const WORK_ROOT = path.join(REPO, 'study-set-work')
const LIB = path.join(REPO, 'scripts', 'lib', 'study-set')
const DOCS = { guide: { dir: 'guide', out: 'guide', page: 'study guide' }, sheet: { dir: 'sheet', out: 'exercise', page: 'exercise sheet' }, glance: { dir: null, out: 'glance', page: 'at a glance' } }
const die = (msg, code = 1) => { process.stderr.write(msg.replace(/\s*$/, '\n')); process.exit(code) }
const say = s => process.stdout.write(s + '\n')
const words = s => (String(s).match(/\S+/g) || []).length
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const writeSafe = (p, text) => { const t = p + '.tmp-study-set'; fs.writeFileSync(t, text); fs.renameSync(t, p) }
const rel = (from, p) => path.relative(from, p).split(path.sep).join('/')
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const plain = s => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()

// ---- the skill --------------------------------------------------------------------------------------------------------
const hashTree = dir => {
  const out = {}
  const walk = (d, base = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = base ? `${base}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (!e.name.startsWith('.')) out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(d, e.name))).digest('hex') } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
function install({ refresh = false } = {}) {
  if (refresh && !fs.existsSync(DEST)) return say('The study set skill is not installed here: nothing to refresh.')
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) die('This copy of Slate has no study set in it yet. Update first (say "update Slate"), then ask again.')
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(DEST), { recursive: true })
  fs.cpSync(SRC, DEST, { recursive: true })
  const kit = readJson(path.join(REPO, 'kit.json'), {})
  fs.writeFileSync(path.join(DEST, '.installed.json'), JSON.stringify({ at: new Date().toISOString(), from: kit.tag || null }, null, 2) + '\n')
  fs.mkdirSync(WORK_ROOT, { recursive: true })
  say(refresh ? 'The study set skill is refreshed to this version.'
    : 'The study set skill is installed (Pro version). Ask for one like this: "do the study set for week 3 of ECO206". ' +
      'It builds a study guide, an exercise sheet and a week at a glance, and puts them in that week\'s Study set folder in Slate. ' +
      'If this conversation does not see the skill yet, start a new conversation in the Slate folder.')
}
function remove() {
  if (!fs.existsSync(DEST)) return say('The study set skill is not installed.')
  fs.rmSync(DEST, { recursive: true, force: true })
  say('The study set skill is removed. The study sets already in Slate stay where they are; the work folder study-set-work/ stays too (it can be deleted).')
}
function status() {
  const on = fs.existsSync(path.join(DEST, 'SKILL.md'))
  const a = hashTree(SRC), b = hashTree(DEST)
  const same = on && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v)
  say(`study set skill: ${on ? `installed${same ? '' : ' (an older version: node scripts/study-set.mjs add --refresh)'}` : fs.existsSync(SRC) ? 'not installed (node scripts/study-set.mjs add)' : 'not in this copy (update Slate first)'}`)
  let root = null; try { root = notesRoot([]) } catch { }
  const sets = []
  for (const [nb, c] of Object.entries(COURSES)) for (const w of weeks(c.term)) {
    const shelf = root && path.join(root, nb, w.dir, 'Study set')
    if (shelf && fs.existsSync(shelf)) sets.push(`  ${c.code} ${w.label}: ${fs.readdirSync(shelf).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')).join(' · ')}`)
  }
  say(sets.length ? `in Slate:\n${sets.join('\n')}` : 'no study set in Slate yet')
}

// ---- the week ---------------------------------------------------------------------------------------------------------
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
function courseOf(q) {
  const k = norm(q), all = Object.entries(COURSES)
  const hit = all.find(([nb, c]) => norm(c.code) === k || norm(nb) === k) || all.find(([nb, c]) => norm(nb).startsWith(k) || norm(c.code).startsWith(k))
  if (!hit) die(`No course "${q}" here. The courses: ${all.map(([nb, c]) => `${c.code} (${nb})`).join(', ') || 'none yet'}.`)
  return { notebook: hit[0], ...hit[1] }
}
function workOf(w) {
  if (!w) die('Which work folder? The one `start` printed, e.g. study-set-work/ECO206-week-3.')
  const cands = [path.resolve(w), path.join(WORK_ROOT, w), path.join(WORK_ROOT, path.basename(w))]
  const dir = cands.find(d => fs.existsSync(path.join(d, 'set.json')))
  if (!dir) die(`${w} is not a study set work folder (no set.json). Run: node scripts/study-set.mjs start <course> <week>`)
  return { dir, set: readJson(path.join(dir, 'set.json')) }
}

// What a PDF holds beyond its words: the pages with annotations (the professor's ink, highlights) and with pictures
// (images, or a page drawn with many paths — a chart). Read in Node with pdf.js's legacy build; capped so a textbook
// chapter cannot stall the listing.
let pdfjsLib = null
async function pdfFacts(file, { deep = true } = {}) {
  pdfjsLib ||= await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(file))
  const task = pdfjsLib.getDocument({ data, disableFontFace: true, isEvalSupported: false, verbosity: 0 })
  try {
    const doc = await task.promise, n = doc.numPages, ink = [], pics = [], t0 = Date.now()
    const OPS = pdfjsLib.OPS, IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].filter(x => x != null))
    for (let i = 1; deep && i <= n && n <= 150; i++) {
      if (Date.now() - t0 > 20000) break
      const p = await doc.getPage(i)
      const ann = (await p.getAnnotations()).filter(a => !['Link', 'Widget', 'Popup'].includes(a.subtype))
      if (ann.length) ink.push(i)
      const ops = await p.getOperatorList()
      const paths = ops.fnArray.filter(f => f === OPS.constructPath).length
      if (ops.fnArray.some(f => IMG.has(f)) || paths > 40) pics.push(i)
      p.cleanup()
    }
    return { pages: n, ink, pics }
  } catch (e) { return { pages: null, error: String(e.message || e).slice(0, 80) } }
  finally { await task.destroy().catch(() => { }) }
}
const ranges = list => { const out = []; for (const n of list) { const last = out[out.length - 1]; if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]) } return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',') }
const SKIP = /(^_slate\.json$|\.blocks\.json$|\.tmp-|^\.|\.DS_Store$)/
const TEXTY = /\.(txt|srt|vtt)$/i
const DEEP_IN = /^(Lectures|Problems|Assignments|Notes)(\/|$)/

// The week folder as a short listing: a page with its files on one line, the files a page carries summarised (a PDF's
// pages, text, ink and figures; a recording by its transcript; the other formats of one transcript left out), and a
// folder of look-alike pages (Problem Set 3 · Q1 … Q14) folded into one line. Every line costs the reader tokens.
const MEDIA = /\.(mp4|m4a|mp3|mov|webm|ts|wav)$/i, ALT = /\.(srt|vtt|json)$/i
async function assetBits(dir, r) {
  const files = fs.readdirSync(dir).filter(f => !SKIP.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const bits = [], hasTxt = files.some(f => /\.txt$/i.test(f) && !/\.pdf\.txt$/i.test(f))
  for (const f of files) {
    const abs = path.join(dir, f)
    if (fs.statSync(abs).isDirectory()) continue
    if (/\.pdf\.txt$/i.test(f) && files.includes(f.replace(/\.txt$/i, ''))) continue
    if (ALT.test(f) && hasTxt) continue
    if (/\.pdf$/i.test(f)) {
      const x = await pdfFacts(abs, { deep: DEEP_IN.test(r) }), cache = abs + '.txt'
      const b = [`${f}: ${x.pages ? `${x.pages} pp` : `unreadable (${x.error})`}`, fs.existsSync(cache) ? `text ${words(fs.readFileSync(cache, 'utf8'))} words (${f}.txt)` : 'no text cache']
      if (x.ink?.length) b.push(`ink on ${ranges(x.ink)}`)
      if (x.pics?.length) b.push(`figures on ${ranges(x.pics)}`)
      if (/handout/i.test(f)) b.push('pre-class handout: the marked-up / after-class deck wins')
      bits.push(b.join(', '))
    } else if (/\.(txt|md)$/i.test(f)) bits.push(`${f} ${words(fs.readFileSync(abs, 'utf8'))} words${/claude/i.test(f) ? ' (Claude-made, not official)' : ''}`)
    else if (MEDIA.test(f)) bits.push(`${f} (${Math.round(fs.statSync(abs).size / 1048576)} MB${hasTxt ? ', transcript in the .txt' : ', no transcript'})`)
    else bits.push(f)
  }
  return bits
}
async function listFolder(base) {
  const lines = []
  const walk = async (dir, depth) => {
    const pad = '  '.repeat(depth + 1)
    const names = fs.readdirSync(dir).filter(n => !SKIP.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const pages = names.filter(n => n.endsWith('.md')).map(n => n.slice(0, -3))
    const rows = []
    for (const p of pages) {
      const abs = path.join(dir, p + '.md'), r = rel(base, abs)
      const body = fs.readFileSync(abs, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '')
      const assets = path.join(dir, p + '.assets'), bits = fs.existsSync(assets) ? await assetBits(assets, r) : []
      if (/^(Study sheets|Study set)$/.test(p) && depth === 0) continue
      rows.push({ p, r: r.replace(/\.md$/, ''), n: words(body), bits, sig: bits.map(b => b.split(/[:\s]/)[0]).join('|') })
    }
    // look-alike pages: same files under each (question.txt, question.png, solution.png …)
    const bySig = {}
    for (const x of rows) if (x.sig && /\d/.test(x.p)) (bySig[x.sig] ||= []).push(x)
    const folded = new Set()
    for (const [sig, xs] of Object.entries(bySig)) if (xs.length >= 3) {
      xs.forEach(x => folded.add(x))
      const total = xs.reduce((t, x) => t + x.n + x.bits.reduce((u, b) => u + (Number(/(\d+) words/.exec(b)?.[1]) || 0), 0), 0)
      lines.push(`${pad}${rel(base, dir)}/ — ${xs.length} pages, ${xs[0].p} … ${xs[xs.length - 1].p}; each holds ${sig.split('|').join(', ')} (${total} words in all)`)
    }
    for (const x of rows) if (!folded.has(x) && (x.n > 3 || x.bits.length)) lines.push(`${pad}${x.r}${x.n > 3 ? ` — page, ${x.n} words` : ''}${x.bits.length ? `${x.n > 3 ? ';' : ' —'} ${x.bits.join('; ')}` : ''}`)
    for (const n of names) {
      const abs = path.join(dir, n)
      if (!fs.statSync(abs).isDirectory() || n.endsWith('.assets')) continue
      if (/^(Study sheets|Study set)$/.test(n) && depth === 0) continue
      if (n === 'Earlier versions') { lines.push(`${pad}${rel(base, abs)}/ — superseded copies: not sources`); continue }
      if (depth < 3) await walk(abs, depth + 1)
    }
  }
  await walk(base, 0)
  return lines.length ? lines.join('\n') : '  (empty)'
}

async function start() {
  const [q, wq] = [args[1], args[2]]
  if (!q || !wq) die('usage: node scripts/study-set.mjs start <course> <week number>')
  const c = courseOf(q), list = weeks(c.term), n = Number(String(wq).replace(/\D/g, ''))
  const w = list.find(x => x.n === n)
  if (!w) die(`${c.code} has weeks 1–${list.length}; there is no week ${wq}.`)
  const root = notesRoot([]), weekDir = path.join(root, c.notebook, w.dir)
  if (!fs.existsSync(weekDir)) die(`${c.code} ${w.label} has no folder in the notes yet (${weekDir}): nothing has been filed for it.`)
  const next = list.find(x => x.n === n + 1), nextDir = next && path.join(root, c.notebook, next.dir)
  const dir = path.join(WORK_ROOT, `${norm(c.code)}-week-${n}`)
  for (const d of ['guide', 'sheet', 'images', 'out']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  const set = { course: c.code, name: c.name || '', notebook: c.notebook, week: n, label: w.label, span: w.span, monday: w.monday,
    weekDir: rel(root, weekDir), nextDir: nextDir && fs.existsSync(nextDir) ? rel(root, nextDir) : null, root, started: localStamp() }
  fs.writeFileSync(path.join(dir, 'set.json'), JSON.stringify(set, null, 2) + '\n')
  const brief = path.join(dir, 'brief.md')
  if (!fs.existsSync(brief)) fs.copyFileSync(path.join(LIB, 'brief.md'), brief)
  const shelf = path.join(weekDir, 'Study set')
  const already = fs.existsSync(shelf) ? fs.readdirSync(shelf).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')) : []
  const tests = (c.tests || []).map(t => (Array.isArray(t) ? `${t[0]} ${t[1]}` : `${t.date || ''} ${t.label || ''}`)).join(' · ')
  const coverage = (c.grading?.components || []).flatMap(k => (k.items || []).filter(i => i.coverage).map(i => `${i.label}: ${i.coverage}`)).join(' · ')
  say(`${c.code}${c.name ? ` — ${c.name}` : ''} · ${w.label}, ${w.span} · ${w.term}`)
  say(`work folder: ${dir}`)
  say(`week folder: ${weekDir}`)
  if (c.textbook) say(`textbook: ${c.textbook}`)
  if (c.meets) say(`meets: ${c.meets}${c.tutorialLag ? ' · the tutorial works through the previous week\'s lecture' : ''}`)
  if (tests) say(`tests: ${tests}`)
  if (coverage) say(`coverage: ${coverage}`)
  say(`already in Slate: ${already.length ? already.join(' · ') + ` (a rebuild replaces them; the student's ink on a printout stays)` : 'nothing'}`)
  say(`\nIn the week folder (paths below are relative to it):\n${await listFolder(weekDir)}`)
  if (set.nextDir) { const nd = path.join(root, set.nextDir); say(`\nNext week (${next.label}) — a tutorial or problem set held after the lecture may be here (paths relative to ${nd}):`); say(await listFolder(nd)) }
}

async function pages() {
  const { dir, set } = workOf(args[1])
  const pdfArg = args[2], spec = args[3]
  if (!pdfArg || !spec) die('usage: node scripts/study-set.mjs pages <work> <pdf, relative to the week folder> <pages like 3,5,7-9> [--dpi 110]')
  const cands = [path.resolve(pdfArg), path.join(set.root, set.weekDir, pdfArg), set.nextDir && path.join(set.root, set.nextDir, pdfArg)].filter(Boolean)
  const pdf = cands.find(p => fs.existsSync(p) && /\.pdf$/i.test(p))
  if (!pdf) die(`No PDF at ${pdfArg} (tried the week folder and the next one).`)
  const list = [...new Set(spec.split(',').flatMap(s => { const [a, b] = s.split('-').map(Number); return b ? Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i) : [a] }))].filter(Number.isFinite)
  if (!list.length || list.length > 40) die('Give 1 to 40 pages, like 3,5,7-9.')
  const dpi = Number(args.includes('--dpi') ? args[args.indexOf('--dpi') + 1] : 110)
  const stem = path.join(dir, 'images', path.basename(pdf).replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '-'))
  const [r] = await render([{ kind: 'pdfpages', pdf, pages: list, dpi, stem }])
  if (!r.ok) die(`The pages could not be drawn: ${r.error}`)
  say(r.files.map(f => rel(dir, f)).join('\n') + (r.skipped.length ? `\nskipped: ${r.skipped.join('; ')}` : '') + `\n(${dir})`)
}

// ---- building -----------------------------------------------------------------------------------------------------------
const G = async () => {
  const lib = await import(pathToFileURL(path.join(LIB, 'glance.mjs')).href)
  const check = (cond, msg) => { if (!cond) throw new Error(`check failed: ${msg || 'a number did not come out as printed'}`) }
  return { ...lib, check }
}
async function build(dir, set, kind) {
  const d = DOCS[kind]
  if (!d) die('guide, sheet or glance')
  const out = path.join(dir, 'out', `${d.out}.html`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  if (kind === 'glance') {
    const spec = path.join(dir, 'glance.mjs')
    if (!fs.existsSync(spec)) die(`No ${rel(REPO, spec)} yet.`)
    const g = await G(), mod = await import(pathToFileURL(spec).href + '?t=' + Date.now())
    const r = await mod.default(g)
    if (!r?.pages?.length) die('glance.mjs returned no pages: it must return { title, pages: [page(…), …] }.')
    fs.writeFileSync(out, g.doc(r.title || `${set.course} Week ${set.week} at a glance`, r.pages))
    return { out, title: r.title, sheets: r.pages.length }
  }
  const src = path.join(dir, d.dir)
  const parts = fs.existsSync(src) ? fs.readdirSync(src).filter(f => f.endsWith('.html')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : []
  if (!parts.length) die(`No parts in ${rel(REPO, src)}/ yet (HTML files, built in name order: 01-front.html, 02-….html).`)
  let body = parts.map(f => fs.readFileSync(path.join(src, f), 'utf8').trim()).join('\n\n')
  const figsFile = path.join(src, 'figs.mjs')
  const figs = fs.existsSync(figsFile) ? await (await import(pathToFileURL(figsFile).href + '?t=' + Date.now())).default(await G()) : {}
  const missing = []
  body = body.replace(/<!--\s*fig:([\w-]+)\s*-->/g, (m, name) => (figs[name] != null ? figs[name] : (missing.push(name), m)))
  if (missing.length) die(`Figures named in the parts but not returned by figs.mjs: ${missing.join(', ')}`)
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)
  const title = h1 ? plain(h1[1]) : `${set.course} Week ${set.week} ${d.page}`
  const head = fs.readFileSync(path.join(LIB, 'head.html'), 'utf8').replace('{{TITLE}}', esc(title))
  fs.writeFileSync(out, head + '\n' + body + '\n' + fs.readFileSync(path.join(LIB, 'foot.html'), 'utf8'))
  return { out, title, parts: parts.length, figures: Object.keys(figs).length }
}

// The mechanical checks of a guide or a sheet, read from the HTML (the same ones that kept the first guides honest).
function staticCheck(file, kind, inventory) {
  const doc = fs.readFileSync(file, 'utf8')
  const body = doc.split('<body').slice(-1)[0]
  const text = plain(body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, ' '))
  const quotes = text.match(/["“][^"”]{25,400}["”]/g) || []
  const stamps = text.match(/\b\d{1,2}:\d\d(?::\d\d)?\b/g) || []
  const wheres = (text.match(/\bWhere\b\s*:?/g) || []).length
  const formulas = (doc.match(/class="(formula-box|theorem-box)"/g) || []).length
  const h2s = [...doc.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => ({ t: plain(m[1]), at: m.index }))
  const h3s = [...doc.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map(m => ({ t: plain(m[1]), at: m.index }))
  const faults = []
  const ids = [...doc.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]), idSet = new Set(ids)
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))]
  if (dup.length) faults.push(`duplicate ids: ${dup.slice(0, 12).join(', ')}`)
  const tog = [...doc.matchAll(/toggleSolution\('([^']+)'\)/g)].map(m => m[1])
  const orphan = [...new Set(tog.filter(x => !idSet.has(x)))]
  if (orphan.length) faults.push(`a Show Solution with no solution: ${orphan.slice(0, 12).join(', ')}`)
  const dead = [...new Set([...doc.matchAll(/href="#([^"]+)"/g)].map(m => m[1]).filter(x => !idSet.has(x)))]
  if (dead.length) faults.push(`links to nothing: #${dead.slice(0, 12).join(', #')}`)
  for (const s of doc.match(/<svg[\s\S]*?<\/svg>/g) || []) for (const t of s.match(/<text[^>]*>[\s\S]*?<\/text>/g) || []) if (/\\\(|\\\[/.test(t)) faults.push(`MathJax inside an SVG label (prints blank): ${plain(t).slice(0, 50)}`)
  if (/(?<![\\$])\$[^$\n]{0,60}\\[a-zA-Z]+[^$\n]{0,60}\$/.test(body.replace(/<svg[\s\S]*?<\/svg>/g, ''))) faults.push('a $…$ maths delimiter: use \\( … \\)')
  // tags that open and close in order (void elements and SVG leaves aside)
  const VOID = new Set(['br', 'img', 'hr', 'meta', 'input', 'link', 'circle', 'line', 'path', 'polygon', 'polyline', 'rect', 'ellipse', 'stop', 'use', 'source', 'col', 'wbr'])
  const stack = [], bad = []
  for (const m of body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<\/(body|html)>/g, '').matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m, t = name.toLowerCase()
    if (VOID.has(t) || self) continue
    if (!close) { stack.push(t); continue }
    if (stack[stack.length - 1] === t) { stack.pop(); continue }
    bad.push(`</${t}>`)
    if (stack.includes(t)) while (stack.length && stack.pop() !== t);
  }
  if (bad.length) faults.push(`${bad.length} closing tag(s) out of order, first: ${bad.slice(0, 3).join(' ')}`)
  if (kind === 'guide') {
    if (!h2s.some(h => /Mock/i.test(h.t))) faults.push('no Full Mock section')
    if (!h2s.some(h => /Cheat Sheet/i.test(h.t))) faults.push('no One-Page Master Cheat Sheet section')
    // every numbered teaching section (1., 2., …) ends in its Cumulative Problem Set
    const numbered = h2s.filter(h => /^[1-9]\d*\.\s/.test(h.t) && !/Mock|Cheat/i.test(h.t))
    for (const h of numbered) {
      const end = (h2s.find(x => x.at > h.at) || { at: doc.length }).at
      if (!h3s.some(x => x.at > h.at && x.at < end && /Cumulative Problem Set/i.test(x.t))) faults.push(`section "${h.t.slice(0, 40)}" has no Cumulative Problem Set`)
    }
  }
  if (kind === 'sheet') {
    const parts = h2s.filter(h => /^Part\b/i.test(h.t))
    if (!parts.length) faults.push('no Part headings (h2 "Part 1 — <topic>")')
    for (const h of parts) {
      const end = (h2s.find(x => x.at > h.at) || { at: doc.length }).at
      const levels = new Set(h3s.filter(x => x.at > h.at && x.at < end).map(x => /Level\s*(\d)/i.exec(x.t)?.[1]).filter(Boolean))
      if (levels.size < 4) faults.push(`"${h.t.slice(0, 40)}" has levels ${[...levels].join(', ') || 'none'} — every Part has Levels 1–4`)
    }
  }
  // the lesson: the numbered sections with every practice problem and solution removed — where every course formula
  // must be taught in its own box (a formula only inside a solution is the failure this check exists for)
  let boxes = 0
  if (kind === 'guide' && inventory?.length) {
    const strip = (src, cls) => { let out = '', i = 0; const re = new RegExp(`<div class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'g'); for (;;) { re.lastIndex = i; const m = re.exec(src); if (!m) return out + src.slice(i); out += src.slice(i, m.index); i = divEnd(src, m.index) } }
    let lesson = strip(strip(body, 'solution-content'), 'practice-box')
    const lh = [...lesson.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => ({ t: plain(m[1]), at: m.index }))
    const a = lh.find(h => /^[1-9]\d*\.\s/.test(h.t)), b = lh.find(h => a && h.at > a.at && /Mock|Cheat/i.test(h.t))
    if (a) lesson = lesson.slice(a.at, b ? b.at : undefined)
    const chunks = [...lesson.matchAll(/<div class="(?:definition-box|formula-box|theorem-box)"[^>]*>/g)].map(m => lesson.slice(m.index, divEnd(lesson, m.index)))
    chunks.push(...(lesson.match(/<table\b[\s\S]*?<\/table>/g) || []))
    boxes = chunks.length
    for (const it of inventory) {
      let rx; try { rx = new RegExp(it.match, 'is') } catch { faults.push(`formulas.json: "${it.name}" has a bad pattern`); continue }
      if (!chunks.some(c => rx.test(c))) faults.push(`not taught in a lesson box: "${it.name}" (${rx.test(body) ? 'only inside a problem or a solution' : 'nowhere in the file'})`)
    }
  }
  return { words: words(text), svgs: (doc.match(/<svg\b/g) || []).length, solutions: tog.length, formulas, wheres, quotes, stamps, boxes, h2: h2s.map(h => h.t), faults }
}
function divEnd(src, start) {
  const re = /<div\b|<\/div>/g; re.lastIndex = start; let depth = 0, m
  while ((m = re.exec(src))) { depth += m[0] === '</div>' ? -1 : 1; if (depth === 0) return re.lastIndex }
  return src.length
}

// ---- rendering (scripts/study-set-render.cjs, in a real Electron) ---------------------------------------------------------
function electronBin() {
  let bin = null
  try { bin = createRequire(import.meta.url)('electron') } catch { }
  if (typeof bin !== 'string' || !fs.existsSync(bin)) die('Electron is not installed in this folder, so nothing can be drawn. Run: node scripts/setup.mjs deps')
  return bin
}
function render(jobs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-study-set-')), manifest = path.join(tmp, 'manifest.json')
  fs.writeFileSync(manifest, JSON.stringify({ jobs }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin(), [path.join(REPO, 'scripts', 'study-set-render.cjs'), manifest], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('the renderer ran past ten minutes and was stopped')) }, 600000)
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer); fs.rmSync(tmp, { recursive: true, force: true })
      const lines = out.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      if (lines.length < jobs.length) return reject(new Error(`the renderer stopped early: ${err.trim().split('\n').filter(l => !/deprecat/i.test(l)).slice(-3).join(' ') || 'no output'}`))
      resolve(lines.sort((a, b) => a.i - b.i))
    })
  }).catch(e => die(`Rendering failed: ${e.message}`))
}
const renderFaults = r => {
  const f = []
  if (!r.ok) return [`could not render: ${r.error}`]
  if (r.rawTex) f.push(`${r.rawTex} maths left as raw \\( … \\) — MathJax did not typeset (offline?, or a typo in the TeX)`)
  if (r.mathErrors) f.push(`${r.mathErrors} MathJax error(s): a formula with bad TeX shows in red`)
  if (r.wideDisplay?.length) f.push(`display equation(s) wider than the page: ${r.wideDisplay.slice(0, 5).join(' | ')} — split them over lines`)
  if (r.svgTex?.length) f.push(`TeX inside SVG labels: ${r.svgTex.slice(0, 3).join(' | ')}`)
  if (r.consoleErrors?.length) f.push(`page errors: ${r.consoleErrors.slice(0, 3).join(' | ')}`)
  for (const s of r.sheets || []) {
    if (s.overflowCards.length) f.push(`sheet ${s.sheet}: card(s) overflowing — ${s.overflowCards.join(' | ')}`)
    if (s.wideMath.length) f.push(`sheet ${s.sheet}: maths or figure wider than its card — ${s.wideMath.join(' | ')}`)
    if (s.rawTex) f.push(`sheet ${s.sheet}: raw TeX`)
    if (s.footBottom != null && s.footBottom > s.height) f.push(`sheet ${s.sheet}: the footer is pushed off the page (it ends at ${s.footBottom}px of ${s.height}): too much on this sheet`)
  }
  if ((r.sheets || []).length > 3) f.push(`${r.sheets.length} glance sheets: three at most`)
  return f
}

async function check() {
  const { dir, set } = workOf(args[1]), kind = args[2]
  const b = await build(dir, set, kind)
  const lines = [`${rel(REPO, b.out)} — ${b.title}`], faults = []
  if (kind !== 'glance') {
    const invFile = path.join(dir, 'formulas.json'), inv = kind === 'guide' ? readJson(invFile, null) : null
    if (kind === 'guide' && !inv) faults.push(fs.existsSync(invFile) ? 'formulas.json is not valid JSON (in a pattern, a backslash is written \\\\)' : 'no formulas.json: the inventory of every formula, definition and method the week uses comes first')
    const s = staticCheck(b.out, kind, inv || [])
    lines.push(`words ${s.words} · figures ${s.svgs} · solutions ${s.solutions} · formula boxes ${s.formulas} · Where lists ${s.wheres}${s.wheres < s.formulas ? ' (fewer than formula boxes)' : ''} · quotes ${s.quotes.length} · timestamps ${s.stamps.length}${inv ? ` · inventory ${inv.length} items, lesson boxes ${s.boxes}` : ''}`)
    lines.push(`sections: ${s.h2.map(h => h.slice(0, 32)).join(' | ')}`)
    faults.push(...s.faults)
    if (s.quotes.length > 10) faults.push(`${s.quotes.length} quotations: each must earn its place (--list shows them)`)
    if (flag('--list')) { for (const q of s.quotes) lines.push(`  QUOTE ${q.slice(0, 140)}`); for (const t of s.stamps) lines.push(`  TIME ${t}`) }
  }
  if (!flag('--no-render')) {
    const job = kind === 'glance' ? { kind: 'png', html: b.out, stem: path.join(dir, 'out', 'glance-preview'), dpi: 150 } : { kind: 'report', html: b.out }
    const [r] = await render([job])
    faults.push(...renderFaults(r))
    if (kind === 'glance' && r.ok) lines.push(`previews (150 dpi) — look at every one: ${r.files.map(f => rel(dir, f)).join(', ')}`, ...r.sheets.map(s => `  sheet ${s.sheet}: body ends ${s.bodyBottom}px, footer at ${s.footTop}px of 1056`))
  }
  lines.push(faults.length ? `faults (${faults.length}):\n  ${faults.join('\n  ')}` : 'faults: none')
  say(lines.join('\n'))
  process.exitCode = faults.length ? 1 : 0
}

// ---- printing onto the slate page -------------------------------------------------------------------------------------------
async function print() {
  const { dir, set } = workOf(args[1]), kind = args[2], d = DOCS[kind]
  const b = await build(dir, set, kind)
  const shelf = path.join(set.root, set.weekDir, 'Study set')
  const title = `Week ${set.week} — ${d.page}`, page = path.join(shelf, `${title}.md`), assets = path.join(shelf, `${title}.assets`)
  const base = `${set.course} Week ${set.week} ${d.page}`
  const outDir = path.join(dir, 'out')
  const jobs = kind === 'glance'
    ? [{ kind: 'png', html: b.out, stem: path.join(outDir, 'glance'), dpi: 300 }, { kind: 'pdf', html: b.out, out: path.join(outDir, 'glance.pdf') }]
    : [{ kind: 'pdf', html: b.out, out: path.join(outDir, `${d.out}.pdf`) }]
  const res = await render(jobs)
  const faults = [...new Set(res.flatMap(renderFaults))]
  const fatal = faults.filter(f => /could not render|raw|MathJax error|TeX inside/.test(f))
  if (fatal.length && !flag('--force')) die(`Not printed — fix these first (or --force):\n  ${fatal.join('\n  ')}`)
  fs.mkdirSync(assets, { recursive: true })
  const side = page.replace(/\.md$/, '.blocks.json')
  const prev = readJson(side, { version: 1, elements: [] })
  const els = prev.elements || []
  const parented = new Set(els.map(e => e.parent).filter(Boolean))   // the student's ink and highlights point at what they sit on
  let added = 0, pagesOut = null
  if (kind === 'glance') {
    const pngs = res[0].files, names = pngs.map((_, i) => `${base} — sheet ${i + 1}.png`), pdfName = `${base} (print).pdf`
    pngs.forEach((f, i) => fs.copyFileSync(f, path.join(assets, names[i])))
    fs.copyFileSync(res[1].out, path.join(assets, pdfName))
    const want = [...names.map(n => ({ type: 'image', src: `${title}.assets/${n}` })), { type: 'pdf', src: `${title}.assets/${pdfName}`, display: 'card' }]
    const keep = els.filter(e => {
      if (!String(e.src || '').startsWith(`${title}.assets/`)) return true
      if (want.some(w => w.src === e.src)) return true
      if (parented.has(e.id)) return true          // a sheet that is gone but carries ink: keep it, never lose the ink
      fs.rmSync(path.join(shelf, e.src), { force: true }); return false
    })
    // new sheets go before the print card, in order; an element already there keeps its id (and so its ink)
    const has = new Set(keep.map(e => e.src))
    const fresh = want.filter(w => !has.has(w.src)).map(w => ({ id: newId(), ...w }))
    added = fresh.length
    const card = keep.findIndex(e => e.src === want[want.length - 1].src)
    const merged = card >= 0 ? [...keep.slice(0, card), ...fresh.filter(e => e.type === 'image'), ...keep.slice(card), ...fresh.filter(e => e.type !== 'image')] : [...keep, ...fresh]
    for (const e of merged) if (String(e.src || '').startsWith(`${title}.assets/`) && fs.existsSync(path.join(shelf, e.src))) e.size = fs.statSync(path.join(shelf, e.src)).size
    prev.elements = merged
    pagesOut = pngs.length
  } else {
    const name = `${base}.pdf`
    fs.copyFileSync(res[0].out, path.join(assets, name))
    const old = els.find(e => e.type === 'pdf')
    const keep = els.filter(e => e.type !== 'pdf' && e.type !== 'text')
    prev.elements = [...keep, { id: old?.id || newId(), type: 'pdf', src: `${title}.assets/${name}`, size: fs.statSync(path.join(assets, name)).size }]
    if (old && old.src !== `${title}.assets/${name}`) fs.rmSync(path.join(shelf, old.src), { force: true })
    added = old ? 0 : 1
    pagesOut = (await pdfFacts(res[0].out, { deep: false })).pages
  }
  const oldMd = fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : ''
  const created = /created:\s*"?([^"\n]+)"?/.exec(oldMd)?.[1] || localStamp()
  // the week's topic, for the page's heading: the guide's and the sheet's h1 after the course, a glance's first masthead
  const h1 = kind === 'glance' ? plain(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(fs.readFileSync(b.out, 'utf8'))?.[1] || '') : (b.title || '').replace(/^.*?—\s*/, '')
  const topic = h1.replace(/^Exercise Sheet:?\s*(Week\s*\d+,?\s*)?/i, '').replace(/\s*(Master\s+)?Study Guide\s*$/i, '').trim()
  const line = kind === 'guide' ? 'The week taught from zero: every idea explained, every formula with its symbols named, a problem set after each section, a short mock and a one-page cheat sheet. Solutions are open in the printout.'
    : kind === 'sheet' ? 'Practice in four levels per topic, Easy to Challenge, every course problem placed at its level, full step-by-step solutions.'
    : `${pagesOut} sheet${pagesOut === 1 ? '' : 's'} for a quick review: the definitions, the formulas with their symbols, the key graphs, what to remember and the traps. The print version is the card at the end.`
  fs.mkdirSync(shelf, { recursive: true })
  writeSafe(page, `---\ncreated: "${created}"\nkind: "summary"\ntags: ["week ${set.week}", "study set"]\nfor: "both"\n---\n\n# ${title}${topic ? ` — ${topic}` : ''}\n\n_${line}_\n`)
  writeSafe(side, JSON.stringify(prev, null, 2) + '\n')
  say(`✓ ${set.course} ${title}: ${pagesOut} ${kind === 'glance' ? 'sheet(s)' : 'page(s)'} on ${rel(set.root, page)}${added ? '' : ' (replaced in place: ink on it stays)'}` +
    `\n  in Slate: ${set.notebook} › ${set.label} › Study set › ${title}` + (faults.length ? `\n  note: ${faults.join(' | ')}` : ''))
}

// ---- the commands -------------------------------------------------------------------------------------------------------
const COMMANDS = { add: () => install({ refresh: flag('--refresh') }), remove, status, start, pages, check, print }
if (!COMMANDS[cmd]) die('usage: node scripts/study-set.mjs add | remove | status | start <course> <week> | pages <work> <pdf> <pages> | check <work> guide|sheet|glance | print <work> guide|sheet|glance', 2)
await COMMANDS[cmd]()
