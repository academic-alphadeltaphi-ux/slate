#!/usr/bin/env node
// The plan (SPEC §20.3): the one writer of Hub/_plan.json, Hub/Today/Next 7 days.md, Hub/_plan-state.json and, with
// --pages, a week's Plan page wherever the next fourteen days carry a task. Deterministic and connector-free; the logic
// is src/plan.js, this file only gathers what is on disk and writes what changed (temp-then-rename, never a byte when
// the content is equal — _plan.json is compared without its updatedAt stamp).
//   node scripts/plan.mjs [--root p] [--today YYYY-MM-DD] [--days 14] [--course "ECO 208Y1"] [--dry-run] [--json] [--print]
//       recompute ticks and counts from disk → Hub/_plan.json + Hub/Today/Next 7 days.md   (the 10:00 build, review step 2)
//   node scripts/plan.mjs --pages [--json]
//       also merge every week's Plan page, append-only (the 07:10 pass, POST /api/plan/rebuild)
//   node scripts/plan.mjs --dry-run --json --print
//       the read-only refresh (GET /api/plan?refresh=1): nothing is written, the plan object is printed as the last line
//       with `updatedAt` = when Hub/_plan.json was last written (null before the first pass) — SPEC §20.1, nothing is
//       written by navigation.
// Exit 0 on a clean run; a thrown error prints and exits 1. With --json the last line is the summary (the plan with --print).
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { COURSES, weeks, WEEK_PAGES, localStamp, todayIso } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { parsePage, joinPage, newId } from '../server/format.js'
import { readJson, writeAtomic, patchFrontmatterRaw, PROBLEMS_JSON } from './lib/problems.mjs'
import { buildPlan, mergeContainer, findPlanBlock, renderNextPage, groupKey, HORIZON_DAYS, PLAN_HEADING, VIDEO_RE } from '../src/plan.js'
import { guardFlags } from './lib/argv.mjs'

guardFlags(['--course', '--days', '--dry-run', '--json', '--pages', '--print', '--root', '--today'])

const args = process.argv.slice(2)
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json'), PAGES = args.includes('--pages'), PRINT = args.includes('--print')
const ONLY = opt('--course'), TODAY = opt('--today') || todayIso(), DAYS = Number(opt('--days')) || HORIZON_DAYS
const ROOT = notesRoot(process.argv)
const HUB = path.join(ROOT, 'Hub')
const PLAN_JSON = path.join(HUB, '_plan.json'), STATE_JSON = path.join(HUB, '_plan-state.json'), NEXT_MD = path.join(HUB, 'Today', 'Next 7 days.md')
const log = (...a) => { if (!JSON_OUT) console.log(...a) }
const sha1 = t => crypto.createHash('sha1').update(String(t)).digest('hex')
const readText = async p => { try { return await fs.readFile(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const isDir = async p => { try { return (await fs.stat(p)).isDirectory() } catch { return false } }
const listMd = async dir => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_') && !e.name.startsWith('.')).map(e => e.name.slice(0, -3)).sort()
const tagsOf = fm => (Array.isArray(fm?.tags) ? fm.tags.map(String) : [])
const dateOfTitle = (title, fm) => (/\((\d{4}-\d{2}-\d{2})\)/.exec(title)?.[1] || /(\d{4}-\d{2}-\d{2})/.exec(title)?.[1] || String(fm?.created || '').slice(0, 10) || null)
const textOf = page => page.blocks.map(b => b.md).join('\n\n')
// When Quercus last changed a synced page: its meta line says `updated 2026-09-10`; the file's own stamp is the sync's.
const stampOf = (text, fm) => /· updated (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] || String(fm?.updated || fm?.created || '').slice(0, 10) || null

// ---- gather ---------------------------------------------------------------------------------------------------------
async function gather() {
  const hub = await readJson(path.join(HUB, '_hub.json'), null)
  const sync = await readJson(path.join(HUB, '_sync-state.json'), {})
  const state = await readJson(STATE_JSON, { pages: {} }); state.pages ||= {}
  const reg = await readJson(PROBLEMS_JSON(ROOT), {})
  const calendar = await readJson(path.join(HUB, '_calendar.json'), null)
  // Claude as the brain (SPEC §20.37): its tasks and its word on classes replace the grammar and the outline.
  const settings = await readJson(path.join(HUB, '_settings.json'), {})
  const brainReg = settings?.brain ? await readJson(path.join(HUB, '_brain.json'), {}) : null
  const brain = settings?.brain ? { enabled: true, tasks: brainReg?.tasks || {}, classes: brainReg?.classes || {}, questions: brainReg?.questions || {} } : null
  const sheets = Object.values(sync.sheets || {}).filter(s => s?.courseKey && s.date).map(s => ({ courseKey: s.courseKey, date: s.date, week: s.week, session: s.session, page: s.page, title: path.posix.basename(String(s.page || ''), '.md') }))
  const announcements = [], planPages = {}, problemsPages = {}, topicPages = {}, lectures = {}, recordings = {}, sheetPages = {}, weekPages = {}, generalPages = {}, present = []
  for (const [courseKey, info] of Object.entries(COURSES)) {
    if (ONLY && courseKey !== ONLY && info.code !== ONLY) continue
    if (await isDir(path.join(ROOT, courseKey))) present.push(courseKey)   // a course with no notebook gets no Plan page of its own work
    const annDir = path.join(ROOT, courseKey, 'Announcements', 'Announcements')
    for (const title of await listMd(annDir)) {
      const text = await readText(path.join(annDir, title + '.md')); if (text === null) continue
      const parsed = parsePage(text), lines = parsed.blocks.map(b => b.md).join('\n\n').split('\n')
      const metaAt = lines.findIndex(l => /^_\d{4}-\d{2}-\d{2} · .*_$/.test(l.trim()))
      const body = lines.slice(metaAt >= 0 ? metaAt + 1 : 0).filter(l => !/^Concerns \[\[/.test(l.trim())).join('\n')
      const postedAt = String(parsed.frontmatter?.created || '').slice(0, 10) || /^(\d{4}-\d{2}-\d{2})/.exec(title)?.[1] || null
      const concerns = [...text.matchAll(/Concerns ((?:\[\[Week \d+ \([^)]*\)\]\](?:, )?)+)/g)].flatMap(m => [...m[1].matchAll(/\[\[(Week \d+ \([^)]*\))\]\]/g)].map(x => x[1]))
      announcements.push({ courseKey, page: `${courseKey}/Announcements/Announcements/${title}.md`, title, postedAt, body, concerns })
    }
    topicPages[courseKey] = {}; lectures[courseKey] = {}; recordings[courseKey] = {}; sheetPages[courseKey] = {}; weekPages[courseKey] = {}; generalPages[courseKey] = []
    for (const w of weeks(info.term)) {
      const dir = path.join(ROOT, courseKey, w.dir)
      const titles = await listMd(dir); if (!titles.length) continue
      for (const title of titles) {
        const rel = `${courseKey}/${w.dir}/${title}.md`
        if (title === 'Plan') { const text = await readText(path.join(dir, 'Plan.md')); if (text !== null) planPages[rel] = { blocks: parsePage(text).blocks, hash: sha1(text) }; continue }
        if (title === 'Problems') { const text = await readText(path.join(dir, 'Problems.md')); if (text !== null) problemsPages[rel] = { blocks: parsePage(text).blocks, blockId: reg.pages?.[rel]?.blockId || null }; continue }
        if (['Notes', 'Lectures', 'Recordings', 'Study sheets'].includes(title)) continue
        const text = await readText(path.join(dir, title + '.md')); if (text === null) continue
        const page = parsePage(text), tags = tagsOf(page.frontmatter)
        if (tags.includes('quercus') && tags.includes('page')) {
          (topicPages[courseKey][w.n] ||= []).push(title)
          ;(weekPages[courseKey][w.n] ||= []).push({ title, body: textOf(page), at: stampOf(text, page.frontmatter) })   // what the page asks for (SPEC §20.35)
        }
      }
      for (const title of await listMd(path.join(dir, 'Lectures'))) {
        const text = await readText(path.join(dir, 'Lectures', title + '.md')), page = text === null ? null : parsePage(text)
        ;(lectures[courseKey][w.n] ||= []).push({ title, date: dateOfTitle(title, page?.frontmatter || null), video: !!page && VIDEO_RE.test(textOf(page)) })   // video: a recorded lecture to watch
      }
      for (const title of await listMd(path.join(dir, 'Recordings'))) (recordings[courseKey][w.n] ||= []).push(title)
      for (const title of await listMd(path.join(dir, 'Study sheets'))) (sheetPages[courseKey][w.n] ||= []).push(title)
    }
    // The course's Quercus pages in General that are about reading — a rolling "Next Week's Reading" (SPEC §20.35).
    for (const title of await listMd(path.join(ROOT, courseKey, 'General'))) {
      if (!/read/i.test(title)) continue
      const text = await readText(path.join(ROOT, courseKey, 'General', title + '.md')); if (text === null) continue
      const page = parsePage(text)
      if (tagsOf(page.frontmatter).includes('quercus')) generalPages[courseKey].push({ title, body: textOf(page), at: stampOf(text, page.frontmatter) })
    }
  }
  return { today: TODAY, days: DAYS, announcements, hub, calendar, sheets, planPages, problemsPages, topicPages, lectures, recordings, sheetPages, weekPages, generalPages, present: new Set(present), state, reg, brain }
}

// ---- pages (--pages) -------------------------------------------------------------------------------------------------
const freshId = blocks => { let id; do id = newId(); while (blocks.some(b => b.id === id)); return id }
// The week folder's _slate.json order gains 'Plan' once (the standard week pages first when the file is new).
async function ensureOrder(dir, name) {
  const file = path.join(dir, '_slate.json')
  const meta = await readJson(file, null)
  if (Array.isArray(meta?.order) && meta.order.includes(name)) return false
  const order = Array.isArray(meta?.order) ? [...meta.order] : []
  if (!order.length) { const have = await listMd(dir); for (const [t] of WEEK_PAGES) if (have.includes(t)) order.push(t) }
  order.push(name)
  if (!DRY) await writeAtomic(file, JSON.stringify({ ...(meta || {}), order }, null, 2) + '\n')
  return true
}
// One Plan page: the header (block 0) is the script's only when the page is new, block 0 is blank (an empty page, or a page
// that starts with an anchored block), or its hash is the one recorded in _plan-state.json. A page with no registry entry
// and a different block 0 — a Plan.md the student wrote himself (one anchorless container), or a header he edited — is his:
// block 0 is left byte for byte, only the `## Before class` container (found by id, then by heading, created at the end)
// is merged, append-only. Frontmatter keeps its bytes except `plan` added to tags (and `kind: "notes"` when it has no kind).
async function applyPage(spec, state) {
  const file = path.join(ROOT, spec.path)
  const text = await readText(file), exists = text !== null
  const parsed = parsePage(text ?? '')
  const blocks = parsed.blocks.map(b => ({ id: b.id, md: b.md }))
  if (!blocks.length || blocks[0].id !== null) blocks.unshift({ id: null, md: '' })
  const reg = state.pages[spec.path] || null
  const owned = !exists || !blocks[0].md.trim() || (!!reg?.headerHash && reg.headerHash === sha1(blocks[0].md))
  let headerRewritten = false
  if (owned && blocks[0].md !== spec.header) { blocks[0].md = spec.header; headerRewritten = true }
  let i = findPlanBlock(blocks, reg?.blockId)
  if (i < 0) { blocks.push({ id: freshId(blocks), md: PLAN_HEADING }); i = blocks.length - 1 }
  const before = blocks[i].md
  const { md, generated, ticked } = mergeContainer(before, spec.groups, reg?.generated || {}, reg?.auto || {})
  blocks[i].md = md
  const tags = tagsOf(parsed.frontmatter)
  const fmRaw = exists
    ? patchFrontmatterRaw(parsed.frontmatterRaw, { ...(parsed.frontmatterRaw ? {} : { created: localStamp() }), ...(parsed.frontmatter?.kind ? {} : { kind: 'notes' }), tags: tags.includes('plan') ? tags : [...tags, 'plan'] })
    : `---\ncreated: "${localStamp()}"\nkind: "notes"\ntags: ["plan"]\n---\n`
  const next = joinPage({ frontmatterRaw: fmRaw, blocks })
  const changed = next !== (text ?? '')
  if (changed && !DRY) { await writeAtomic(file, next); await ensureOrder(path.dirname(file), 'Plan') }
  const added = md.split('\n').filter(l => /^- \[ \] /.test(l)).length - before.split('\n').filter(l => /^- \[ \] /.test(l)).length
  // What the pass ticked for him (SPEC §20.69), kept for good: a line in here is never ticked again, so his untick stands.
  // A dry run records nothing — the tick was not written.
  const auto = { ...(reg?.auto || {}) }
  if (!DRY) for (const t of ticked) auto[`${groupKey(t.group)}|${t.key}`] = { at: localStamp(), why: t.why }
  state.pages[spec.path] = { headerHash: owned ? sha1(blocks[0].md) : null, blockId: blocks[i].id, generated, ...(Object.keys(auto).length ? { auto } : {}), at: changed ? localStamp() : (reg?.at || localStamp()) }   // once the student edits the header it is his: no hash, never rewritten
  return { page: spec.path, created: !exists, changed, headerRewritten, tasks: spec.groups.reduce((n, g) => n + g.tasks.length, 0), added: Math.max(0, added), ticked: ticked.map(t => ({ ...t, text: t.text.split(' → ')[0] })) }
}

// ---- run --------------------------------------------------------------------------------------------------------------
// One writing pass at a time. The morning's `--pages` and To do's Refresh (POST /api/plan/rebuild) each read the Plan pages
// and Hub/_plan-state.json first and wrote them last: the second writer dropped the `auto` memory of what the first had
// ticked, and a line the student unticked was ticked again (SPEC §20.69, review 2026-09-29). The pass holds the lock from before
// its reads to after its writes; a second one waits for it. A holder that is gone, or ten minutes old, no longer counts.
const PLAN_LOCK = path.join(HUB, '.tmp-plan.lock')
if (PAGES && !DRY) {
  await fs.mkdir(HUB, { recursive: true })
  const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  for (let i = 0; ; i++) {
    try { await fs.writeFile(PLAN_LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); break }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      let held = null; try { held = JSON.parse(await fs.readFile(PLAN_LOCK, 'utf8')) } catch { }
      const age = Date.now() - (held?.at || (await fs.stat(PLAN_LOCK).catch(() => null))?.mtimeMs || 0)
      if (held?.pid ? !alive(held.pid) || age > 600_000 : age > 10_000) { await fs.rm(PLAN_LOCK, { force: true }); continue }
      if (i >= 300) throw new Error(`another plan.mjs --pages (pid ${held?.pid ?? '?'}) has held Hub/.tmp-plan.lock for a minute`)
      await new Promise(r => setTimeout(r, 200))
    }
  }
  process.on('exit', () => { try { if (JSON.parse(fsSync.readFileSync(PLAN_LOCK, 'utf8')).pid === process.pid) fsSync.rmSync(PLAN_LOCK, { force: true }) } catch { } })
}
const inputs = await gather()
let { plan, pageSpecs } = buildPlan(inputs)
let pagesWritten = 0
const autoTicked = []   // what the pass ticked because Quercus, the Problems page or Claude says it is done (SPEC §20.69)
if (PAGES) {
  for (const spec of pageSpecs) {
    const r = await applyPage(spec, inputs.state)
    if (r.changed) pagesWritten++
    for (const t of r.ticked) autoTicked.push({ course: COURSES[spec.courseKey]?.code || spec.courseKey, page: spec.path, task: t.text, why: t.why })
    log(`  ${spec.courseKey} ${spec.week.label}: ${r.created ? 'created' : r.changed ? 'merged' : 'unchanged'} · ${r.tasks} task(s)${r.added ? ` +${r.added}` : ''}${r.ticked.length ? ` · ticked ${r.ticked.length}` : ''}${r.headerRewritten && !r.created ? ' · header' : ''}${DRY ? ' (dry run)' : ''}`)
    for (const t of r.ticked) log(`    ticked: ${t.text} — ${t.why}`)
  }
  // reread the pages (ticks, the student's lines) and rebuild the plan on what is now on disk
  if (!DRY && pageSpecs.length) {
    for (const spec of pageSpecs) { const text = await readText(path.join(ROOT, spec.path)); if (text !== null) inputs.planPages[spec.path] = { blocks: parsePage(text).blocks, hash: sha1(text) } }
    ;({ plan, pageSpecs } = buildPlan(inputs))
  }
}
for (const is of plan.issues) log(`  issue ${is.course} ${is.title}: ${is.reason} — ${is.text}`)

let filesWritten = 0
const stripStamp = o => JSON.stringify({ ...o, updatedAt: null, summary: { ...o.summary, written: 0 } })
const old = await readJson(PLAN_JSON, null)
const planChanged = !old || stripStamp(old) !== stripStamp(plan)
plan.summary.written = pagesWritten
plan.updatedAt = planChanged && !DRY ? localStamp() : (old?.updatedAt || null)   // dry: the stamp stays the file's (when it was last written), never now
if (planChanged) { if (!DRY) await writeAtomic(PLAN_JSON, JSON.stringify(plan, null, 2) + '\n'); filesWritten++ }
if (PAGES && !DRY) {
  const oldState = await readJson(STATE_JSON, null)
  // What another pass ticked meanwhile stays remembered, whatever this one read at its start — a lock taken over from a
  // dead holder is the one way left for two to overlap — so its line is never ticked again after the student unticks it.
  for (const [p, v] of Object.entries(oldState?.pages || {})) {
    const mine = inputs.state.pages[p]
    if (!mine) inputs.state.pages[p] = v
    else if (v?.auto) mine.auto = { ...v.auto, ...(mine.auto || {}) }
  }
  const noAt = s => JSON.stringify({ pages: Object.fromEntries(Object.entries(s?.pages || {}).map(([k, v]) => [k, { ...v, at: null }])) })
  if (!oldState || noAt(oldState) !== noAt(inputs.state)) { await writeAtomic(STATE_JSON, JSON.stringify({ pages: inputs.state.pages }, null, 2) + '\n'); filesWritten++ }
}
{
  const oldNext = await readText(NEXT_MD)
  const fm = oldNext ? (parsePage(oldNext).frontmatterRaw || '---\nkind: "summary"\n---\n') : '---\nkind: "summary"\n---\n'
  const next = fm + renderNextPage(plan)
  if (next !== oldNext) { if (!DRY) await writeAtomic(NEXT_MD, next); filesWritten++ }
}
const out = { meetings: plan.summary.meetings, tasks: plan.summary.tasks, pages: plan.summary.pages, pagesWritten, issues: plan.issues.length, written: pagesWritten + filesWritten, dry: DRY, pagesMode: PAGES, autoTicked }
if (JSON_OUT) console.log(JSON.stringify(PRINT ? plan : out))
else console.log(`Plan: ${out.meetings} meeting(s) in ${DAYS} days, ${out.pages} plan page(s), ${out.tasks.done}/${out.tasks.total} task(s) ticked${autoTicked.length ? ` (${autoTicked.length} by this pass)` : ''}${out.issues ? `, ${out.issues} issue(s)` : ''}; ${out.written} file(s) written${DRY ? ' (dry run, nothing written)' : ''}.`)
