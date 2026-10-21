#!/usr/bin/env node
// Winter 2027 begins Mon Jan 11, not Jan 4 (SPEC §20.72). The notebooks were scaffolded on the old start: a Week 14 (Jan 4)
// that never meets, and every winter week one number too high. This moves each course's `Winter 2027/` into the numbering
// terms.mjs now gives. Files only: what holds anything is moved, only empty scaffolding is removed, and a notebook already
// in the new numbering is left alone, so a second run does nothing.
//   node scripts/shift-winter.mjs --yes-migrate [--dry-run] [--root /path]
//
// A week folder holds two kinds of thing, and they move differently:
//   by date   — the week's own page and what the app, the student and the Quercus sync put in it. It belongs to its Monday, so
//               `Week 15 (Jan 11)/Notes` becomes `Week 14 (Jan 11)/Notes`.
//   by number — what was placed from a scripts/lib/syllabus.mjs week key: ECO227's Problems page and Textbook shelf. Those
//               keys were written in the course outline's numbering (its winter Week 1 is Jan 11), which is the new one, so
//               the page keeps its number: `Week 15 (Jan 11)/Textbook` goes to `Week 15 (Jan 18)/Textbook`.
// The old Week 14 (Jan 4) has no Monday to go to: what would move by date from it must be empty scaffolding, and is removed;
// anything else stops the run. The old Week 26 (Apr 5) has no number to go to: a by-number page there stops the run.
// Nothing is written until every course has been planned without a stop.
// A moved Problems page keeps its registry entry under its new path (Hub/_problems.json), and a header that is still the
// script's ("_Week 15 (Jan 11) · from the course outline · WMS_") takes its new week label with its hash, so it stays the
// script's; one the student edited is his and keeps its words. Afterwards: node scripts/textbook.mjs --course "ECO 227Y1" --week N
// --force for N = 14…25 (each cut printed again under its new week label), then node scripts/problems.mjs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, TERMS, weeks, short, isoOf } from './lib/terms.mjs'
import { SYLLABUS } from './lib/syllabus.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags, guardMigration } from './lib/argv.mjs'
import { acquireLock } from './lib/brain.mjs'
import { sha1, looksGenerated } from './lib/problems.mjs'
import { parsePage, joinPage } from '../server/format.js'

guardFlags(['--dry-run', '--root', '--yes-migrate'])
guardMigration('shift-winter.mjs', 'it renumbers every Winter 2027 week folder from the Jan 4 start to the Jan 11 one')

const OLD_START = '2027-01-04', NEW_START = '2027-01-11'
const DRY = process.argv.includes('--dry-run'), ROOT = notesRoot(process.argv)
const WINTER = TERMS.WINTER
if (WINTER.start !== NEW_START) { console.error(`terms.mjs still starts the winter on ${WINTER.start}: move WINTER.start to ${NEW_START} first.`); process.exit(2) }

const log = (...a) => console.log(...a)
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
const dayOf = iso => new Date(iso + 'T12:00:00')
const sunday = iso => { const d = dayOf(iso); d.setDate(d.getDate() + 6); return d }
const rel = p => path.relative(ROOT, p)

// The winter weeks as terms.mjs numbered them with the old start: the same walk as weeks(), from OLD_START.
function oldWinter(term) {
  const all = weeks(term), first = all.filter(w => w.term !== WINTER.name).length, out = []
  for (let d = dayOf(OLD_START); d <= dayOf(WINTER.end); d.setDate(d.getDate() + 7)) {
    const iso = isoOf(d)
    if (WINTER.reading.includes(iso)) continue
    const n = first + out.length + 1, label = `Week ${n} (${short(d)})`
    out.push({ n, monday: iso, label, span: `${short(d)} – ${short(sunday(iso))}` })
  }
  return out
}
// The things in a week folder, grouped by page: Notes.md + Notes.blocks.json + Notes.assets/ + Notes/ are one.
async function groupsIn(dir) {
  const groups = new Map(), extra = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === '_slate.json' || e.name === '.DS_Store') { extra.push(e.name); continue }
    const base = e.name.replace(/\.(md|blocks\.json|assets)$/, '')
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push(e.name)
  }
  return { groups, extra }
}
const bodyOf = md => String(md).replace(/^---\n[\s\S]*?\n---\n?/, '')
// An untouched scaffold page: frontmatter and nothing else (or only the week's own heading), no ink, no attachments, no subpages.
async function emptyScaffold(dir, base, names, heading = null) {
  for (const n of names) {
    const p = path.join(dir, n), st = await fs.stat(p)
    if (n === `${base}.md`) { const b = bodyOf(await fs.readFile(p, 'utf8')).trim(); if (b && b !== heading) return false }
    else if (st.isDirectory()) { if ((await fs.readdir(p)).some(x => x !== '.DS_Store' && x !== '_slate.json')) return false }
    else return false
  }
  return true
}
const byNumber = (course, n, base) => (base === 'Problems' || base === 'Textbook') && SYLLABUS[course]?.weeks?.[n] != null

const plans = [], stops = []
for (const [course, info] of Object.entries(COURSES)) {
  if (info.term !== 'Y' && info.term !== 'S') continue
  const termDir = path.join(ROOT, course, WINTER.name)
  if (!(await exists(termDir))) continue
  const olds = oldWinter(info.term), news = weeks(info.term).filter(w => w.term === WINTER.name)
  const onDisk = async w => (await exists(path.join(termDir, w.label))) || (await exists(path.join(termDir, `${w.label}.md`)))
  const oldHere = [], newHere = []
  for (const w of olds) if (await onDisk(w)) oldHere.push(w.label)
  for (const w of news) if (await onDisk(w)) newHere.push(w.label)
  if (!oldHere.length) { log(`${course}: already in the new numbering (${newHere.length} weeks), left alone`); continue }
  if (newHere.length) { stops.push(`${course}: both numberings on disk (${oldHere[0]} … and ${newHere[0]} …); sort it by hand`); continue }

  const plan = { course, termDir, moves: [], removes: [], rewrites: [], orders: new Map(), registry: [], olds, news }
  const target = (o, how) => news.find(w => (how === 'number' ? w.n === o.n : w.monday === o.monday)) || null
  for (const o of olds) {
    const dir = path.join(termDir, o.label), byDate = target(o, 'date')
    // the week's own page, by date; its heading names the week
    const own = [`${o.label}.md`, `${o.label}.blocks.json`, `${o.label}.assets`]
    const ownHere = []
    for (const n of own) if (await exists(path.join(termDir, n))) ownHere.push(n)
    const heading = `# Week ${o.n} · ${o.span}`
    if (ownHere.length) {
      if (byDate) {
        for (const n of ownHere) plan.moves.push([path.join(termDir, n), path.join(termDir, byDate.label + n.slice(o.label.length)), 'week page, by date'])
        plan.rewrites.push([path.join(termDir, `${byDate.label}.md`), heading, `# Week ${byDate.n} · ${byDate.span}`])
      } else if (await emptyScaffold(termDir, o.label, ownHere, heading)) for (const n of ownHere) plan.removes.push([path.join(termDir, n), 'empty week page'])
      else stops.push(`${course}: ${o.label}.md holds more than its heading and there is no ${o.monday} week any more`)
    }
    if (!(await exists(dir))) continue
    const { groups } = await groupsIn(dir)
    const order = (await readJson(path.join(dir, '_slate.json'), {})).order || []
    for (const [base, names] of groups) {
      const how = byNumber(course, o.n, base) ? 'number' : 'date', to = target(o, how)
      if (!to) {
        if (how === 'date' && await emptyScaffold(dir, base, names)) { for (const n of names) plan.removes.push([path.join(dir, n), 'empty scaffold']); continue }
        stops.push(`${course}: ${o.label}/${base} moves by ${how} and there is no ${how === 'date' ? `${o.monday} week` : `Week ${o.n}`} any more`)
        continue
      }
      for (const n of names) plan.moves.push([path.join(dir, n), path.join(termDir, to.label, n), `by ${how}`])
      if (!plan.orders.has(to.label)) plan.orders.set(to.label, { date: [], number: [] })
      if (order.includes(base)) plan.orders.get(to.label)[how].push([order.indexOf(base), base, o.label])
      if (base === 'Problems') plan.registry.push([`${course}/${WINTER.name}/${o.label}/Problems.md`, `${course}/${WINTER.name}/${to.label}/Problems.md`, o.label, to.label])
    }
    plan.removes.push([dir, 'emptied week folder'])
  }
  // pages in the term folder that are not week pages (ECO206's `Winter 2027.md`): their week headings follow the dates, and
  // an empty Jan 4 section goes
  for (const e of await fs.readdir(termDir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md') || olds.some(o => e.name === `${o.label}.md`)) continue
    plan.rewrites.push([path.join(termDir, e.name), null, null])
  }
  for (const [from, to] of plan.moves) if (await exists(to) && !plan.moves.some(([f]) => f === to)) stops.push(`${course}: ${rel(to)} is already there`)
  plans.push(plan)
}

if (stops.length) { log('\nNothing moved. Stopped on:'); for (const s of stops) log(`  · ${s}`); process.exit(1) }
if (!plans.length) { log('\nNothing to do.'); process.exit(0) }

// The text of a term page: `## Week 15 (Jan 11)` / `# Week 15 · Jan 11 – Jan 17` take the new number of their Monday; the
// first block, when it is nothing but the Jan 4 week's two headings, is dropped.
function rewriteTermPage(md, plan) {
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(md)?.[0] || '', body = md.slice(fm.length)
  const gone = plan.olds.filter(o => !plan.news.some(w => w.monday === o.monday))
  let out = body
  for (const o of gone) {
    const re = new RegExp(`^## ${o.label.replace(/[()]/g, '\\$&')}\\n\\n---\\n[^]*?\\n---\\n# Week ${o.n} · ${o.span}\\n\\n(?=<!-- slate:block )`)
    out = out.replace(re, '')
  }
  for (const o of plan.olds) {
    const w = plan.news.find(x => x.monday === o.monday); if (!w) continue
    out = out.split(`## ${o.label}\n`).join(`## \u0000${w.label}\n`).split(`# Week ${o.n} · ${o.span}\n`).join(`# Week \u0000${w.n} · ${w.span}\n`)
  }
  return fm + out.replace(/\u0000/g, '')
}

const release = DRY ? null : await acquireLock(ROOT)
try {
  for (const plan of plans) {
    log(`\n${plan.course} · ${WINTER.name}: ${plan.olds[0].label} … ${plan.olds.at(-1).label}  →  ${plan.news[0].label} … ${plan.news.at(-1).label}`)
    for (const o of plan.olds) {
      const own = plan.moves.filter(([f]) => path.dirname(f) === plan.termDir && path.basename(f).startsWith(o.label + '.')), inside = plan.moves.filter(([f]) => path.dirname(f) === path.join(plan.termDir, o.label))
      const gone = plan.removes.filter(([p]) => p === path.join(plan.termDir, o.label) || path.dirname(p) === path.join(plan.termDir, o.label) || path.basename(p).startsWith(o.label + '.'))
      log(`  ${o.label}`)
      for (const [f, t, why] of [...own, ...inside]) log(`    ${path.basename(f)}  →  ${path.relative(plan.termDir, t)}   (${why})`)
      for (const [p, why] of gone.filter(([p]) => p !== path.join(plan.termDir, o.label))) log(`    ${path.basename(p)}  removed (${why})`)
    }
    for (const [from, to] of plan.registry) log(`  registry  ${path.relative(plan.course, from)}  →  ${path.relative(plan.course, to)}`)
    if (DRY) continue
    for (const [from, to] of plan.moves) { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to) }
    for (const [p] of plan.removes) {
      if (!(await exists(p))) continue
      const st = await fs.stat(p)
      if (st.isDirectory()) { await fs.rm(path.join(p, '_slate.json'), { force: true }); await fs.rm(path.join(p, '.DS_Store'), { force: true }); await fs.rmdir(p).catch(e => log(`    kept ${rel(p)}: ${e.code}`)) }
      else await fs.rm(p)
    }
    for (const [file, from, to] of plan.rewrites) {
      if (!(await exists(file))) continue
      const md = await fs.readFile(file, 'utf8')
      const next = from == null ? rewriteTermPage(md, plan) : md.replace(new RegExp(`^${from.replace(/[()]/g, '\\$&')}$`, 'm'), to)
      if (next !== md) { await fs.writeFile(file, next); log(`  rewrote ${path.relative(plan.termDir, file)}`) }
    }
    // each new week folder's order: what came by date in its old order, then what came by number
    for (const w of plan.news) {
      const o = plan.orders.get(w.label); if (!o) continue
      const order = [...o.date.sort((a, b) => a[0] - b[0]), ...o.number.sort((a, b) => a[0] - b[0])].map(x => x[1])
      await fs.writeFile(path.join(plan.termDir, w.label, '_slate.json'), JSON.stringify({ order: [...new Set(order)] }, null, 2) + '\n')
    }
    const termMeta = await readJson(path.join(plan.termDir, '_slate.json'), {})
    await fs.writeFile(path.join(plan.termDir, '_slate.json'), JSON.stringify({ ...termMeta, order: plan.news.map(w => w.label) }, null, 2) + '\n')
    if (plan.registry.length) {
      const file = path.join(ROOT, 'Hub', '_problems.json'), reg = await readJson(file, null)
      const pages = {}
      for (const [k, v] of Object.entries(reg?.pages || {})) pages[plan.registry.find(([f]) => f === k)?.[1] || k] = v
      for (const [, to, oldLabel, newLabel] of plan.registry) {
        const page = path.join(ROOT, to), text = await fs.readFile(page, 'utf8').catch(() => null); if (text == null) continue
        const parsed = parsePage(text), blocks = parsed.blocks.map(b => ({ id: b.id, md: b.md })), entry = pages[to] || null
        if (!blocks.length || blocks[0].id !== null) continue
        const owned = entry && 'headerHash' in entry ? !!entry.headerHash && entry.headerHash === sha1(blocks[0].md) : looksGenerated(blocks[0].md)
        if (!owned) { log(`  ${path.relative(plan.course, to)}: its header is the student's, left as it is`); continue }
        const md = blocks[0].md.replace(new RegExp(`^_${oldLabel.replace(/[()]/g, '\\$&')} · `, 'm'), `_${newLabel} · `)
        if (md === blocks[0].md) continue
        blocks[0].md = md
        await fs.writeFile(page, joinPage({ frontmatterRaw: parsed.frontmatterRaw, blocks }))
        pages[to] = { ...(entry || {}), headerHash: sha1(md) }
        log(`  ${path.relative(plan.course, to)}: header says ${newLabel}`)
      }
      if (reg) { reg.pages = pages; await fs.writeFile(file + '.tmp', JSON.stringify(reg, null, 2) + '\n'); await fs.rename(file + '.tmp', file) }
    }
  }
} finally { if (release) await release() }
log(DRY ? '\nDry run, nothing written.' : '\nDone. Now: node scripts/textbook.mjs --course "ECO 227Y1" --week N --force for N = 14…25, then node scripts/problems.mjs.')
