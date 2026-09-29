// Claude as the brain (SPEC §20.37). With `brain: true` in Hub/_settings.json no rule decides anything in slate: the fetch
// only downloads, and every placement, task, cancelled class, topic and link is Claude's — made through scripts/brain.mjs,
// checked here, and remembered in Hub/_brain.json with its reason and the way back. The plan (src/plan.js) reads this file
// instead of the announcement grammar and the course outline; the Plan pages stay the truth for ticks.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { COURSES, weeks, weekFor, localStamp } from './terms.mjs'
import { readJson, writeAtomic } from './problems.mjs'
import { movePage, reorder, followHub, followSyncState, restoreSyncState, setKind, setPart, splitRel, KINDS, WHICH_CLASS, INBOX_PREFIX } from './move.mjs'
import { parsePage, joinPage, newId } from '../../server/format.js'
import { expandMeetings } from '../../src/calendar.js'
import { taskKey, planTasks, findPlanBlock, planPageRel, flipTask, groupKey, meetingLabel, weekGroupLabel } from '../../src/plan.js'

export const BRAIN_JSON = root => path.join(root, 'Hub', '_brain.json')
export const SETTINGS_JSON = root => path.join(root, 'Hub', '_settings.json')
export const INBOX_JSON = root => path.join(root, 'Hub', '_inbox.json')
export const IGNORED_PREFIX = INBOX_PREFIX + 'Ignored/'
export const LEVELS = ['crucial', 'important', 'normal', 'optional']
export const TASK_KINDS = ['read', 'watch', 'problems', 'review', 'write', 'quiz', 'bring', 'due', 'participation', 'prepare', 'other']
// Pages that belong to a week itself; nothing is placed under these names directly in a week's folder.
const WEEK_PAGES = new Set(['Plan', 'Problems', 'Notes', 'Lectures', 'Recordings', 'Study sheets'])
const ISO = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const json = v => JSON.stringify(v, null, 2) + '\n'
const exists = p => fs.access(p).then(() => true, () => false)

// Claude's own records that name a page by its path — a task's `link` and `source` — follow a move like the hub's rows and
// the sync's memory do (SPEC §20.52): a page retitled by a later decision left "Where Claude read it" opening nothing. A
// page's subpages move with it, so a path under the old one follows as well. → [{ id, field, before }] for an exact undo.
export function followTasks(brain, moves) {
  const changed = []
  for (const { from, to } of moves) {
    const fromDir = from.replace(/\.md$/, '') + '/', toDir = to.replace(/\.md$/, '') + '/'
    for (const t of Object.values(brain?.tasks || {})) {
      for (const field of ['link', 'source']) {
        const v = t?.[field]; if (typeof v !== 'string') continue
        const next = v === from ? to : v.startsWith(fromDir) ? toDir + v.slice(fromDir.length) : null
        if (next === null) continue
        changed.push({ id: t.id, field, before: v }); t[field] = next
      }
    }
  }
  return changed
}
export function restoreTasks(brain, changed) { for (const c of changed || []) if (brain.tasks[c.id]) brain.tasks[c.id][c.field] = c.before; return (changed || []).length }

// ---- the registry ---------------------------------------------------------------------------------------------------------
export const emptyBrain = () => ({ version: 1, current: null, tasks: {}, classes: {}, questions: {}, decisions: [], runs: [] })
export async function readBrain(root) {
  const b = await readJson(BRAIN_JSON(root), null)
  return { ...emptyBrain(), ...(b || {}), tasks: b?.tasks || {}, classes: b?.classes || {}, questions: b?.questions || {}, decisions: b?.decisions || [], runs: b?.runs || [] }
}
export async function writeBrain(root, brain) {
  brain.decisions = brain.decisions.slice(-1000); brain.runs = brain.runs.slice(-200)
  await writeAtomic(BRAIN_JSON(root), json(brain))
}
export const readSettings = async root => (await readJson(SETTINGS_JSON(root), {})) || {}
export const brainEnabled = async root => !!(await readSettings(root)).brain
// How the morning run thinks (SPEC §24): 'single' — one pass reads and decides everything (scripts/brain-prompt.md);
// 'team' — a coordinator, one agent per course, a critic and a day lead (scripts/brain/coordinator.md). Single unless set.
export const BRAIN_MODES = ['single', 'team']
export const brainMode = settings => (settings?.brainMode === 'team' ? 'team' : 'single')
export const brainPromptFile = settings => (brainMode(settings) === 'team' ? 'brain/coordinator.md' : 'brain-prompt.md')
// What the plan reads (src/plan.js buildPlan's `inputs.brain`).
export const brainForPlan = brain => ({ enabled: true, tasks: brain.tasks, classes: brain.classes, questions: brain.questions })

// One writer at a time: a second terminal, or the four course agents of a team morning (SPEC §24) writing at once, must not
// interleave a read and a write of Hub/_brain.json — nor of Hub/_problems.json, which `problems.mjs --add` reads first and
// rewrites last. `.tmp-` so neither the watcher nor the snapshots see it. A writer waits up to a minute: four agents
// sending batches queue for seconds, not ten of them (the old limit).
// acquireLock(root) → release(); withLock(root, fn) holds it around fn.
export async function acquireLock(root) {
  const lock = path.join(root, 'Hub', '.tmp-brain.lock')
  await fs.mkdir(path.dirname(lock), { recursive: true })
  for (let i = 0; ; i++) {
    try { const h = await fs.open(lock, 'wx'); await h.writeFile(String(process.pid)); await h.close(); break }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      const st = await fs.stat(lock).catch(() => null)
      if (st && Date.now() - st.mtimeMs > 120_000) { await fs.rm(lock, { force: true }); continue }
      if (i > 300) throw new Error('another brain.mjs or problems.mjs command has held Hub/.tmp-brain.lock for a minute')
      await new Promise(r => setTimeout(r, 200))
    }
  }
  // `process.exit` inside the holder (brain.mjs's fail()) skips any finally: the lock stayed for two minutes and the next
  // command waited and failed (review 2026-09-18). An exit handler removes it synchronously either way.
  const onExit = () => { try { fsSync.rmSync(lock, { force: true }) } catch { } }
  process.once('exit', onExit)
  return async () => { process.off('exit', onExit); await fs.rm(lock, { force: true }) }
}
export async function withLock(root, fn) {
  const release = await acquireLock(root)
  try { return await fn() } finally { await release() }
}

// ---- checks -----------------------------------------------------------------------------------------------------------------
export function courseKeyOf(x) {
  const s = String(x ?? '').trim(); if (!s) return null
  if (COURSES[s]) return s
  const f = s.replace(/\s+/g, '').toUpperCase()
  return Object.entries(COURSES).find(([k, c]) => String(c.code).toUpperCase() === f || k.replace(/\s+/g, '').toUpperCase() === f)?.[0] || null
}
const codes = () => Object.values(COURSES).map(c => c.code).join(', ')
const oneLine = (v, name, min, max) => {
  const s = String(v ?? '').trim()
  if (s.length < min || s.length > max || /[\r\n]/.test(s)) throw new Error(`${name}: one line of ${min}–${max} characters`)
  return s
}
export const reasonOf = v => oneLine(v, 'reason', 3, 300)
export function safeRel(rel) {
  const norm = path.posix.normalize(String(rel ?? '').replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '')
  if (!norm || norm === '.' || norm.split('/').some(s => s === '..' || s === '')) throw new Error(`bad path: ${rel}`)
  return norm
}
const badName = s => !s || s.length > 120 || s.startsWith('.') || s.startsWith('_') || /\.(assets|md|json)$/i.test(s) || /[\\/:\x00-\x1f]/.test(s)
const pageExists = async (root, rel) => /\.md$/.test(rel) && exists(path.join(root, safeRel(rel)))
export const weekNOf = (courseKey, attach) => attach?.week ?? (attach?.class ? weekFor(COURSES[courseKey].term, attach.class.date)?.n ?? null : null)

// checkTask(root, input) → a task as the registry keeps it, or throws with the one thing that is wrong.
//   { course, what, class: { date, kind? } | week: n | due, level?, kind?, due?, dueTime?, link?, source?, reason }
export async function checkTask(root, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('a task is a JSON object')
  const courseKey = courseKeyOf(input.course ?? input.courseKey)
  if (!courseKey) throw new Error(`course: one of ${codes()}`)
  const info = COURSES[courseKey]
  const what = oneLine(input.what, 'what', 3, 160)
  if (/ → | — /.test(what) || /\[\[|\]\]/.test(what) || /^\s*(?:[-*] \[|#)/.test(what)) throw new Error('what: plain words — no " → ", " — ", wikilinks, checkboxes or headings (a link goes in `link`)')
  if (/ · no longer listed\s*$/.test(what)) throw new Error('what: must not end with " · no longer listed"')
  const level = input.level ?? 'normal'; if (!LEVELS.includes(level)) throw new Error(`level: one of ${LEVELS.join(', ')}`)
  const kind = input.kind ?? 'other'; if (!TASK_KINDS.includes(kind)) throw new Error(`kind: one of ${TASK_KINDS.join(', ')}`)
  const due = input.due ?? null; if (due !== null && !ISO.test(String(due))) throw new Error('due: YYYY-MM-DD')
  const dueTime = input.dueTime ?? null; if (dueTime !== null && (!due || !HHMM.test(String(dueTime)))) throw new Error('dueTime: HH:MM, and only with due')
  const cls = input.class ?? null, week = input.week ?? null
  if (cls && week != null) throw new Error('a task goes before one class or in one week, not both')
  let attach
  if (cls) {
    if (typeof cls !== 'object' || !ISO.test(String(cls.date))) throw new Error('class: { "date": "YYYY-MM-DD", "kind": "Lecture" }')
    const on = expandMeetings(cls.date, cls.date).filter(m => m.courseKey === courseKey && (!cls.kind || m.kind === cls.kind))
    if (!on.length) throw new Error(`class: ${info.code} has no ${cls.kind ? String(cls.kind).toLowerCase() : 'class'} on ${cls.date}`)
    if (on.length > 1) throw new Error(`class: ${info.code} has a ${on.map(m => m.kind.toLowerCase()).join(' and a ')} on ${cls.date} — say which with class.kind`)
    attach = { class: { date: cls.date, kind: on[0].kind } }
  } else if (week != null) {
    const w = weeks(info.term).find(x => x.n === Number(week))
    if (!w) throw new Error(`week: ${info.code} has weeks 1–${weeks(info.term).length}`)
    attach = { week: w.n }
  } else if (due) {
    const w = weekFor(info.term, due)
    if (!w) throw new Error(`due: ${due} is outside ${info.code}'s term`)
    attach = { week: w.n }
  } else throw new Error('a task needs `class` ({ date, kind }), `week` (a number) or `due`')
  const link = input.link ?? null
  if (link !== null) {
    if (/^https?:\/\//.test(String(link))) { if (/\s/.test(link)) throw new Error('link: a URL has no spaces') }
    else if (!(await pageExists(root, link))) throw new Error(`link: no such page ${link} (a path from the notes root, ending in .md, or a URL)`)
  }
  const source = input.source ?? null
  if (source !== null && !(await pageExists(root, source))) throw new Error(`source: no such page ${source}`)
  // Whether a mark depends on it (SPEC §20.54): true, false, or null when Claude did not say — the rows then read the kind and the link.
  const graded = input.graded === undefined || input.graded === null ? null : typeof input.graded === 'boolean' ? input.graded : (() => { throw new Error('graded: true or false') })()
  // How long it takes, its share of the mark, whether it must be one sitting (SPEC §22): Claude's word, each optional.
  const minutes = input.minutes === undefined || input.minutes === null ? null : (Number.isInteger(input.minutes) && input.minutes >= 0 && input.minutes <= 600 ? input.minutes : (() => { throw new Error('minutes: a whole number of minutes, 0 to 600 (0 = sat in the room, no time of its own)') })())
  const weight = input.weight === undefined || input.weight === null ? null : (typeof input.weight === 'number' && input.weight >= 0 && input.weight <= 100 ? input.weight : (() => { throw new Error('weight: percent of the final mark, 0 to 100') })())
  const splittable = input.splittable === undefined || input.splittable === null ? null : typeof input.splittable === 'boolean' ? input.splittable : (() => { throw new Error('splittable: true or false') })()
  return { id: input.id ?? null, courseKey, what, kind, level, attach, due, dueTime, link, source, graded, minutes, weight, splittable, reason: reasonOf(input.reason) }
}

// A second task with the same words on the same week's Plan page would share its tick: flipTask flips the first match.
const clashWith = (brain, t, skipId = null) => Object.values(brain.tasks).find(x => x && x.id !== skipId && !x.withdrawn && x.courseKey === t.courseKey
  && weekNOf(x.courseKey, x.attach) === weekNOf(t.courseKey, t.attach) && taskKey(x.what) === taskKey(t.what)) || null

// Whether a task's line is ticked on its week's Plan page.
export async function tickedOnPage(root, t) {
  const info = COURSES[t.courseKey], n = weekNOf(t.courseKey, t.attach)
  const w = weeks(info.term).find(x => x.n === n); if (!w) return false
  const text = await fs.readFile(path.join(root, planPageRel(t.courseKey, w)), 'utf8').catch(() => null); if (text === null) return false
  const blocks = parsePage(text).blocks, i = findPlanBlock(blocks, null); if (i < 0) return false
  return planTasks(blocks[i].md).some(x => x.key === taskKey(t.what) && x.done)
}

// ---- decisions --------------------------------------------------------------------------------------------------------------
export function decide(brain, { type, summary, reason = null, undo }) {
  const d = { id: 'd-' + newId(), at: localStamp(), run: brain.current || null, type, summary, reason, undo, undone: null }
  brain.decisions.push(d)
  return d
}

// ---- tasks ------------------------------------------------------------------------------------------------------------------
// All or nothing: every input is checked (against the registry and against each other) before one is kept.
export async function addTasks(root, brain, inputs) {
  const list = Array.isArray(inputs) ? inputs : [inputs]
  if (!list.length) throw new Error('no tasks given')
  const checked = []
  for (const [i, input] of list.entries()) {
    const at = list.length > 1 ? `task ${i + 1}: ` : ''
    try {
      const t = await checkTask(root, input)
      if (t.id && brain.tasks[t.id]) throw new Error(`${t.id} already exists — use task edit`)
      const same = clashWith(brain, t) || checked.find(x => x.courseKey === t.courseKey && weekNOf(x.courseKey, x.attach) === weekNOf(t.courseKey, t.attach) && taskKey(x.what) === taskKey(t.what))
      if (same) throw new Error(`the same words are already a task in that week (${same.id || 'earlier in this list'}): "${same.what}"`)
      checked.push(t)
    } catch (e) { throw new Error(at + e.message) }
  }
  return checked.map(t => {
    const id = t.id || 't-' + newId()
    const task = { ...t, id, at: localStamp(), run: brain.current || null, withdrawn: null }
    brain.tasks[id] = task
    const d = decide(brain, { type: 'task-add', summary: `${COURSES[t.courseKey].code} · ${t.what}`, reason: t.reason, undo: { task: id } })
    return { ...task, decision: d.id }
  })
}

export async function editTask(root, brain, id, patch) {
  const before = brain.tasks[id]
  if (!before) throw new Error(`no task ${id}`)
  if (before.withdrawn) throw new Error(`${id} was withdrawn — add a new task instead`)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('task edit expects a JSON object of the fields to change')
  for (const k of ['id', 'at', 'run', 'withdrawn', 'attach', 'courseKey', 'done']) if (k in patch) throw new Error(`${k} cannot be edited${k === 'attach' ? ' — change class, week or due' : ''}`)
  const input = { ...before, course: before.courseKey, ...(before.attach.class ? { class: before.attach.class } : { week: before.attach.week }), ...patch }
  if ('class' in patch && patch.class) delete input.week
  if ('week' in patch && patch.week != null) delete input.class
  const t = await checkTask(root, input)
  const moved = taskKey(t.what) !== taskKey(before.what) || JSON.stringify(t.attach) !== JSON.stringify(before.attach)
  if (moved && await tickedOnPage(root, before)) throw new Error(`${id} is ticked on its Plan page: its words and its class or week stay as they are — add a new task for the new thing`)
  if (moved && clashWith(brain, t, id)) throw new Error(`the same words are already a task in that week: "${t.what}"`)
  brain.tasks[id] = { ...before, ...t, id, at: before.at, run: before.run, withdrawn: null, editedAt: localStamp() }
  const d = decide(brain, { type: 'task-edit', summary: `${COURSES[t.courseKey].code} · ${before.what}${t.what !== before.what ? ` → ${t.what}` : ''} (${Object.keys(patch).filter(k => k !== 'reason').join(', ') || 'reason'})`, reason: t.reason, undo: { before } })
  return { ...brain.tasks[id], decision: d.id }
}

export function withdrawTask(brain, id, reason) {
  const before = brain.tasks[id]
  if (!before) throw new Error(`no task ${id}`)
  if (before.withdrawn) throw new Error(`${id} was already withdrawn ${before.withdrawn.at}`)
  const why = reasonOf(reason)
  brain.tasks[id] = { ...before, withdrawn: { at: localStamp(), reason: why } }
  const d = decide(brain, { type: 'task-withdraw', summary: `${COURSES[before.courseKey].code} · ${before.what}`, reason: why, undo: { before } })
  return { id, decision: d.id }
}

// Done already, on evidence (SPEC §20.69): what Claude read that says the work is in — a grade that came back under another
// name, the forum, the WebAssign answer note, a hand-in the task's link does not point at. Nothing is ticked here: the next
// plan pass (`plan.mjs --pages`) ticks the line once, and an untick of the student's stands after that. Undo takes the word back,
// and unticks the line when it was this word that ticked it.
export async function doneTask(root, brain, id, reason) {
  const before = brain.tasks[id]
  if (!before) throw new Error(`no task ${id}`)
  if (before.withdrawn) throw new Error(`${id} was withdrawn ${before.withdrawn.at}`)
  if (before.done) throw new Error(`${id} was already marked done ${before.done.at}`)
  if (await tickedOnPage(root, before)) throw new Error(`${id} is already ticked on its Plan page`)
  const why = reasonOf(reason)
  brain.tasks[id] = { ...before, done: { at: localStamp(), reason: why } }
  const d = decide(brain, { type: 'task-done', summary: `${COURSES[before.courseKey].code} · ${before.what}`, reason: why, undo: { task: id } })
  return { id, decision: d.id }
}
// The line the plan pass ticked on Claude's word, unticked again — never one the student ticked himself.
async function untickClaudes(root, t) {
  const info = COURSES[t.courseKey], n = weekNOf(t.courseKey, t.attach)
  const w = weeks(info.term).find(x => x.n === n); if (!w) return false
  const rel = planPageRel(t.courseKey, w), key = taskKey(t.what)
  const st = await readJson(path.join(root, 'Hub', '_plan-state.json'), {})
  const gk = groupKey(t.attach?.class ? meetingLabel(t.attach.class) : weekGroupLabel(w))
  if (!String(st?.pages?.[rel]?.auto?.[`${gk}|${key}`]?.why || '').startsWith('Claude:')) return false
  const text = await fs.readFile(path.join(root, rel), 'utf8').catch(() => null); if (text === null) return false
  const page = parsePage(text), i = findPlanBlock(page.blocks, st.pages[rel].blockId); if (i < 0) return false
  if (!planTasks(page.blocks[i].md).some(x => x.key === key && x.done)) return false
  page.blocks[i] = { ...page.blocks[i], md: flipTask(page.blocks[i].md, key) }
  await writeAtomic(path.join(root, rel), joinPage({ frontmatterRaw: page.frontmatterRaw, blocks: page.blocks }))
  return true
}

// ---- classes: cancelled, or what they are about -----------------------------------------------------------------------------
export function setClass(brain, { course, date, kind, cancel = null, topic = null, clear = false, reason }) {
  const courseKey = courseKeyOf(course); if (!courseKey) throw new Error(`course: one of ${codes()}`)
  if (!ISO.test(String(date))) throw new Error('date: YYYY-MM-DD')
  const m = expandMeetings(date, date).find(x => x.courseKey === courseKey && x.kind === kind)
  if (!m) throw new Error(`${COURSES[courseKey].code} has no ${String(kind).toLowerCase()} on ${date}`)
  if (!clear && cancel === null && topic === null) throw new Error('say --cancel "why", --topic "what it is about" or --clear')
  const why = reasonOf(reason)
  const key = m.id, before = brain.classes[key] || null
  if (clear) { if (!before) throw new Error(`nothing is set on ${key}`); delete brain.classes[key] }
  else brain.classes[key] = { ...(before || {}), ...(cancel !== null ? { cancel: oneLine(cancel, 'cancel', 3, 120) } : {}), ...(topic !== null ? { topic: oneLine(topic, 'topic', 2, 160) } : {}), reason: why, at: localStamp() }
  const what = clear ? 'cleared' : [cancel !== null ? `cancelled: ${cancel}` : null, topic !== null ? `topic: ${topic}` : null].filter(Boolean).join(' · ')
  const d = decide(brain, { type: 'class', summary: `${COURSES[courseKey].code} ${kind} ${date} · ${what}`, reason: why, undo: { key, before } })
  return { key, entry: brain.classes[key] || null, decision: d.id }
}

// ---- questions for the student -----------------------------------------------------------------------------------------------------
export async function ask(root, brain, { text, course = null, page = null }) {
  const q = oneLine(text, 'question', 8, 400)
  const courseKey = course ? courseKeyOf(course) : null
  if (course && !courseKey) throw new Error(`course: one of ${codes()}`)
  if (page && !(await pageExists(root, page))) throw new Error(`page: no such page ${page}`)
  const id = 'q-' + newId()
  brain.questions[id] = { id, at: localStamp(), run: brain.current || null, courseKey, text: q, page: page || null, answered: null }
  const d = decide(brain, { type: 'ask', summary: q, undo: { question: id } })
  return { id, decision: d.id }
}
export function answered(brain, id, reason) {
  const q = brain.questions[id]; if (!q) throw new Error(`no question ${id}`)
  if (q.answered) throw new Error(`${id} was already answered ${q.answered.at}`)
  const why = reasonOf(reason)
  q.answered = { at: localStamp(), reason: why }
  const d = decide(brain, { type: 'answered', summary: q.text, reason: why, undo: { question: id } })
  return { id, decision: d.id }
}

// ---- the inbox --------------------------------------------------------------------------------------------------------------
export async function inboxItems(root, { all = false } = {}) {
  const ib = await readJson(INBOX_JSON(root), null)
  if (ib?.items) return Object.values(ib.items).filter(it => it && (all || (it.status || 'waiting') === 'waiting'))
  // before the fetch keeps Hub/_inbox.json: the pages under Hub/Inbox/<course>/
  const out = [], dir = path.join(root, 'Hub', 'Inbox')
  for (const c of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!c.isDirectory() || c.name === 'Ignored' || c.name.startsWith('.') || c.name.startsWith('_')) continue
    for (const e of await fs.readdir(path.join(dir, c.name), { withFileTypes: true }).catch(() => []))
      if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) out.push({ id: null, page: `${INBOX_PREFIX}${c.name}/${e.name}`, courseKey: courseKeyOf(c.name), title: e.name.slice(0, -3), status: 'waiting' })
  }
  return out
}
async function inboxPage(root, idOrPage) {
  if (/\.md$/.test(String(idOrPage))) return safeRel(idOrPage)
  const ib = await readJson(INBOX_JSON(root), null)
  const it = ib?.items?.[idOrPage]; if (!it?.page) throw new Error(`no inbox item ${idOrPage}`)
  return safeRel(it.page)
}
async function markInbox(root, page, patch) {
  const ib = await readJson(INBOX_JSON(root), null), before = []
  if (!ib?.items) return before
  for (const [id, it] of Object.entries(ib.items)) if (it?.page === page) { before.push({ id, before: it }); ib.items[id] = { ...it, ...patch } }
  if (before.length) await writeAtomic(INBOX_JSON(root), json(ib))
  return before
}
async function restoreInbox(root, before) {
  if (!before?.length) return
  const ib = await readJson(INBOX_JSON(root), null); if (!ib?.items) return
  for (const b of before) ib.items[b.id] = b.before
  await writeAtomic(INBOX_JSON(root), json(ib))
}

// An item that is not a page to place — an announcement, a Quercus page that changed — once Claude has read it and done what
// it asks (tasks, links, a class, a question). It stays where it is; only its status changes.
export async function reviewItem(root, brain, id, reason) {
  const ib = await readJson(INBOX_JSON(root), null), it = ib?.items?.[id]
  if (!it) throw new Error(`no inbox item ${id}`)
  if ((it.status || 'waiting') !== 'waiting') throw new Error(`${id} is already ${it.status}`)
  // Only a page really waiting refuses: one under Ignored/, or one a later decision has moved on (its record kept the old
  // path), is an update to read and close — else the update of an ignored page waited forever (2026-09-29, the practice
  // quiz's description update pointed into Ignored/ after its copy was swapped).
  const p = String(it.page || '')
  if (p.startsWith(INBOX_PREFIX) && !p.startsWith(IGNORED_PREFIX) && await pageExists(root, p)) throw new Error(`${id} is a page waiting in the inbox — place it or ignore it`)
  const why = reasonOf(reason)
  ib.items[id] = { ...it, status: 'reviewed', decidedAt: localStamp() }
  await writeAtomic(INBOX_JSON(root), json(ib))
  const d = decide(brain, { type: 'review', summary: `${it.kind || 'item'} · ${it.title || it.page}`, reason: why, undo: { inbox: [{ id, before: it }] } })
  return { id, decision: d.id }
}

// ---- placing a page ---------------------------------------------------------------------------------------------------------
// `to` is a folder of a course notebook: `General`, `General/<folder>`, `<Term>/<Week N (…)>` or `<Term>/<Week N (…)>/<folder>`,
// optionally starting with the course's notebook name to place a page in another course.
export function resolveDest(to, fromCourse) {
  let segs = safeRel(to).split('/')
  let courseKey = fromCourse
  if (COURSES[segs[0]]) { courseKey = segs[0]; segs = segs.slice(1) }
  if (!courseKey) throw new Error('to: start with the course notebook, e.g. "ECO 206Y1/General"')
  const info = COURSES[courseKey], wks = weeks(info.term)
  const example = `"General", "${wks[0].dir}" or "${wks[0].dir}/Lectures"`
  if (!segs.length) throw new Error(`to: a folder inside ${courseKey} — ${example}`)
  if (segs[0] === 'General') {
    if (segs.length > 2 || (segs[1] !== undefined && badName(segs[1]))) throw new Error(`to: General, or one folder inside it — ${example}`)
    return { courseKey, section: segs.join('/'), weekLevel: false }
  }
  const w = wks.find(x => x.term === segs[0] && x.label === segs[1])
  if (!w) throw new Error(`to: "${segs.slice(0, 2).join('/')}" is not a week of ${info.code} — ${example}`)
  if (segs.length > 3) throw new Error(`to: at most a week and one folder in it — ${example}`)
  if (segs[2] !== undefined && (badName(segs[2]) || segs[2] === 'Study sheets' || segs[2] === 'Notes')) throw new Error(`to: "${segs[2]}" is not a folder a document goes in (Study sheets and Notes are yours)`)
  return { courseKey, section: segs.join('/'), weekLevel: segs.length === 2 }
}

export async function placePage(root, brain, idOrPage, { to, title = null, kind = null, part = null, reason, dry = false }) {
  const fromRel = await inboxPage(root, idOrPage)
  const why = reasonOf(reason)
  const inbox = fromRel.startsWith(INBOX_PREFIX)
  if (fromRel.startsWith(IGNORED_PREFIX)) throw new Error('that page was ignored — undo the ignore first')
  const src = splitRel(fromRel)
  const fromCourse = inbox ? courseKeyOf(fromRel.split('/')[2]) : courseKeyOf(src.courseKey)
  if (!inbox && !fromCourse) throw new Error(`${fromRel} is not in a course notebook or the inbox`)
  if (!inbox && /\/(Announcements|Study sheets)\//.test(fromRel)) throw new Error('announcements and study sheets stay where they are written — link an announcement to its weeks instead')
  if (!inbox && WEEK_PAGES.has(src.title) && /^(Fall|Winter|Summer|Spring)\b[^/]*\/Week [^/]+$/.test(src.section)) throw new Error(`${src.title} belongs to its week and does not move`)
  if (!(await exists(path.join(root, fromRel)))) throw new Error(`no such page: ${fromRel}`)
  const dest = resolveDest(to, fromCourse)
  const newTitle = title === null ? src.title : oneLine(title, 'title', 1, 120)
  if (badName(newTitle)) throw new Error(`title: "${newTitle}" is not a page name`)
  if (dest.weekLevel && WEEK_PAGES.has(newTitle)) throw new Error(`title: "${newTitle}" is a week's own page`)
  if (kind !== null && !KINDS.includes(kind)) throw new Error(`kind: one of ${KINDS.join(', ')}`)
  if (part !== null && !WHICH_CLASS.includes(part)) throw new Error(`for: one of ${WHICH_CLASS.join(', ')}`)
  if (part !== null && !/^(Fall|Winter|Summer|Spring)[^/]*\/Week /.test(dest.section)) throw new Error('for: a document in a week belongs to a class; General is the whole course')
  const toRel = `${dest.courseKey}/${dest.section}/${newTitle}.md`
  const moved = await movePage(root, fromRel, toRel, { dry })
  if (dry) return { from: fromRel, to: toRel, moved, dry: true }
  const orderAt = await reorder(path.join(root, path.dirname(fromRel)), src.title, null)
  await reorder(path.join(root, path.dirname(toRel)), null, newTitle)
  const kindBefore = kind !== null ? await setKind(root, toRel, kind) : undefined
  const partBefore = part !== null ? await setPart(root, toRel, part) : undefined
  const hubRows = await followHub(root, [{ from: fromRel, to: toRel }])
  const sync = await followSyncState(root, [{ from: fromRel, to: toRel }])
  const tasks = followTasks(brain, [{ from: fromRel, to: toRel }])
  const inboxBefore = await markInbox(root, fromRel, { status: 'placed', to: toRel, decidedAt: localStamp() })
  const d = decide(brain, { type: inbox ? 'place' : 'move', summary: `${fromRel} → ${toRel}${part ? ` · for the ${part === 'both' ? 'week' : part}` : ''}`, reason: why,
    undo: { from: toRel, to: fromRel, orderAt, kind: kind !== null ? { before: kindBefore } : null, part: part !== null ? { before: partBefore } : null, sync, tasks, inbox: inboxBefore } })
  return { from: fromRel, to: toRel, part, moved, hubRows, syncRecords: sync.length, tasksFollowed: tasks.length, decision: d.id }
}

// Something the fetch brought that is not a course document — a banner, a duplicate, an empty page. It moves to
// Hub/Inbox/Ignored/<course>/, never to the trash, so an undo can bring it back.
export async function ignoreItem(root, brain, idOrPage, reason) {
  const fromRel = await inboxPage(root, idOrPage)
  const why = reasonOf(reason)
  if (!fromRel.startsWith(INBOX_PREFIX) || fromRel.startsWith(IGNORED_PREFIX)) throw new Error('only a page waiting in the inbox can be ignored')
  // A re-upload of something already ignored found its name taken under Ignored/, the move refused, and it waited in the
  // inbox for good (ECO227 Tutorial 2 and Mathematical Review 1, 2026-09-26 → 29): the second one takes "<title> (2)".
  let toRel = IGNORED_PREFIX + fromRel.slice(INBOX_PREFIX.length)
  const taken = async rel => { const st = path.join(root, rel.replace(/\.md$/, '')); for (const s of ['.md', '.blocks.json', '.assets', '']) if (await exists(st + s)) return true; return false }
  for (let n = 2; await taken(toRel); n++) toRel = IGNORED_PREFIX + fromRel.slice(INBOX_PREFIX.length).replace(/\.md$/, ` (${n}).md`)
  await movePage(root, fromRel, toRel)
  const orderAt = await reorder(path.join(root, path.dirname(fromRel)), splitRel(fromRel).title, null)
  const sync = await followSyncState(root, [{ from: fromRel, to: toRel }])
  await followHub(root, [{ from: fromRel, to: toRel }])
  const tasks = followTasks(brain, [{ from: fromRel, to: toRel }])
  const inboxBefore = await markInbox(root, fromRel, { status: 'ignored', to: toRel, decidedAt: localStamp() })
  const d = decide(brain, { type: 'ignore', summary: fromRel, reason: why, undo: { from: toRel, to: fromRel, orderAt, kind: null, sync, tasks, inbox: inboxBefore } })
  return { from: fromRel, to: toRel, decision: d.id }
}

// Which class a document belongs to (SPEC §20.38), for a page already in a week: the lecture, the tutorial, or both when it
// serves the week — a study sheet, a reading the whole week uses.
export async function partPage(root, brain, pageRel, part, reason) {
  const rel = safeRel(pageRel)
  if (!WHICH_CLASS.includes(part)) throw new Error(`for: one of ${WHICH_CLASS.join(', ')}`)
  const why = reasonOf(reason)
  if (!(await pageExists(root, rel))) throw new Error(`no such page: ${rel}`)
  const { courseKey, section } = splitRel(rel)
  if (!COURSES[courseKey] || !/^(Fall|Winter|Summer|Spring)[^/]*\/Week /.test(section)) throw new Error('for: a document in a week of a course notebook (General is the whole course)')
  const before = await setPart(root, rel, part)
  const d = decide(brain, { type: 'part', summary: `${rel} · for the ${part === 'both' ? 'week' : part}`, reason: why, undo: { page: rel, before } })
  return { page: rel, part, before, decision: d.id }
}

// What a page already filed is (SPEC §20.37): lecture, reading, problem-set… A page that moved to another shelf keeps the kind
// it was placed with, and `place` refuses a move to where the page already is, so this is the one way to say what it is now.
export async function kindPage(root, brain, pageRel, kind, reason) {
  const rel = safeRel(pageRel)
  if (!KINDS.includes(kind)) throw new Error(`kind: one of ${KINDS.join(', ')}`)
  const why = reasonOf(reason)
  if (!(await pageExists(root, rel))) throw new Error(`no such page: ${rel}`)
  if (rel.startsWith(INBOX_PREFIX)) throw new Error(`${rel} is waiting in the inbox — place it with --kind instead`)
  if (!COURSES[splitRel(rel).courseKey]) throw new Error(`${rel} is not in a course notebook`)
  if (/\/(Announcements|Study sheets)\//.test(rel)) throw new Error('announcements and study sheets keep the kind they are written with')
  const before = await setKind(root, rel, kind)
  const d = decide(brain, { type: 'kind', summary: `${rel} · ${before ?? 'no kind'} → ${kind}`, reason: why, undo: { page: rel, before } })
  return { page: rel, kind, before, decision: d.id }
}

// ---- an announcement on the weeks it is about ------------------------------------------------------------------------------
// The week's own page gains `- [[<announcement>]]` under `## From announcements`, once (the line quercus-sync used to write
// from the dates an announcement mentioned).
export async function linkAnnouncement(root, brain, annRel, weekDirs, reason) {
  const rel = safeRel(annRel)
  const why = reasonOf(reason)
  const { courseKey } = splitRel(rel)
  if (!COURSES[courseKey] || !rel.startsWith(`${courseKey}/Announcements/Announcements/`)) throw new Error('link: an announcement page, <course>/Announcements/Announcements/<title>.md')
  if (!(await exists(path.join(root, rel)))) throw new Error(`no such page: ${rel}`)
  const list = (Array.isArray(weekDirs) ? weekDirs : [weekDirs]).filter(Boolean)
  if (!list.length) throw new Error('say which week with --week "<Term>/<Week N (…)>"')
  const wks = weeks(COURSES[courseKey].term)
  const title = splitRel(rel).title, line = `- [[${title}]]`, out = []
  const targets = list.map(dir => { const w = wks.find(x => x.dir === dir); if (!w) throw new Error(`week: "${dir}" is not a week of ${COURSES[courseKey].code} — e.g. "${wks[0].dir}"`); return w })
  for (const w of targets) {
    const pageRel = `${courseKey}/${w.dir}.md`, file = path.join(root, pageRel)
    let md = await fs.readFile(file, 'utf8').catch(() => null)
    if (md !== null && md.split('\n').includes(line)) continue
    const created = md === null
    if (created) md = `---\ncreated: "${localStamp()}"\nkind: "notes"\n---\n# Week ${w.n} · ${w.span}\n`
    md = /^## From announcements$/m.test(md) ? md.replace(/^## From announcements\n/m, `## From announcements\n${line}\n`) : md.trimEnd() + `\n\n## From announcements\n${line}\n`
    await writeAtomic(file, md)
    out.push({ page: pageRel, created })
  }
  if (!out.length) throw new Error(`${title} is already linked from ${list.join(', ')}`)
  const d = decide(brain, { type: 'link', summary: `${title} → ${out.map(o => o.page).join(', ')}`, reason: why, undo: { line, pages: out } })
  return { linked: out, decision: d.id }
}

// ---- runs -------------------------------------------------------------------------------------------------------------------
export function startRun(brain, note = null) {
  const open = brain.runs.find(r => r.id === brain.current && !r.endedAt)
  // A run nobody closed (the session died while the Mac slept, 2026-09-27) ends where its work ended, not when the next
  // one starts: stamped with the next start it read as a 25-hour run with no decisions.
  if (open) {
    const mine = brain.decisions.filter(d => d.run === open.id && !d.undone)
    open.endedAt = mine.map(d => d.at).filter(Boolean).sort().pop() || open.startedAt
    open.decisions = mine.length
    open.note = [open.note, 'interrupted: never closed, closed by the next run'].filter(Boolean).join(' · ')
  }
  const r = { id: 'r-' + newId(), startedAt: localStamp(), endedAt: null, note: note || null, decisions: 0 }
  brain.runs.push(r); brain.current = r.id
  return r
}
export function endRun(brain, note = null) {
  const r = brain.runs.find(x => x.id === brain.current)
  if (!r) throw new Error('no run in progress (brain.mjs run start)')
  r.endedAt = localStamp(); if (note) r.note = note
  r.decisions = brain.decisions.filter(d => d.run === r.id && !d.undone).length
  brain.current = null
  return r
}
export function decisionsOf(brain, run = 'last') {
  const id = run === 'last' ? (brain.current || brain.runs[brain.runs.length - 1]?.id) : run
  return { run: brain.runs.find(r => r.id === id) || null, decisions: brain.decisions.filter(d => d.run === id) }
}

// ---- undo -------------------------------------------------------------------------------------------------------------------
export async function undoDecision(root, brain, id) {
  const d = brain.decisions.find(x => x.id === id)
  if (!d) throw new Error(`no decision ${id}`)
  if (d.undone) throw new Error(`${id} was already undone ${d.undone.at}`)
  const u = d.undo || {}
  if (['place', 'move', 'ignore'].includes(d.type)) {
    await movePage(root, u.from, u.to)
    await reorder(path.join(root, path.dirname(u.from)), splitRel(u.from).title, null)
    await reorder(path.join(root, path.dirname(u.to)), null, splitRel(u.to).title, u.orderAt)
    if (u.kind) await setKind(root, u.to, u.kind.before)
    if (u.part) await setPart(root, u.to, u.part.before)
    await followHub(root, [{ from: u.from, to: u.to }])
    await restoreSyncState(root, u.sync)
    restoreTasks(brain, u.tasks)
    await restoreInbox(root, u.inbox)
  } else if (d.type === 'task-add') {
    const t = brain.tasks[u.task]
    if (t && !t.withdrawn) brain.tasks[u.task] = { ...t, withdrawn: { at: localStamp(), reason: `undo of ${id}` } }
  } else if (d.type === 'task-edit' || d.type === 'task-withdraw') {
    brain.tasks[u.before.id] = u.before
  } else if (d.type === 'task-done') {
    const t = brain.tasks[u.task]
    if (t) { brain.tasks[u.task] = { ...t, done: null }; await untickClaudes(root, t) }
  } else if (d.type === 'class') {
    if (u.before) brain.classes[u.key] = u.before; else delete brain.classes[u.key]
  } else if (d.type === 'link') {
    for (const p of u.pages || []) {
      const file = path.join(root, p.page)
      const md = await fs.readFile(file, 'utf8').catch(() => null); if (md === null) continue
      const lines = md.split('\n'), i = lines.indexOf(u.line); if (i < 0) continue
      lines.splice(i, 1)
      await writeAtomic(file, lines.join('\n').replace(/\n## From announcements\n*$/, '\n'))
    }
  } else if (d.type === 'part') {
    await setPart(root, u.page, u.before)
  } else if (d.type === 'kind') {
    await setKind(root, u.page, u.before)
  } else if (d.type === 'review') {
    await restoreInbox(root, u.inbox)
  } else if (d.type === 'ask') {
    delete brain.questions[u.question]
  } else if (d.type === 'answered') {
    if (brain.questions[u.question]) brain.questions[u.question].answered = null
  } else if (d.type === 'day') {
    // The day as it stood before Claude decided it (SPEC §22): the file and the page, put back byte for byte, or removed.
    const dayFile = path.join(root, 'Hub', '_day.json'), page = path.join(root, 'Hub', 'Today', "Today's work.md")
    const cur = JSON.parse(await fs.readFile(dayFile, 'utf8').catch(() => 'null'))
    const file = cur && cur.days && typeof cur.days === 'object' ? cur : { version: 2, days: cur && cur.date ? { [cur.date]: cur } : {} }
    if (u.before?.day) file.days[u.date] = u.before.day; else delete file.days[u.date]
    if (Object.keys(file.days).length) await writeAtomic(dayFile, JSON.stringify(file, null, 2) + '\n'); else await fs.rm(dayFile, { force: true })
    if (u.before?.page != null) await writeAtomic(page, u.before.page); else await fs.rm(page, { force: true })
  } else throw new Error(`${d.type} cannot be undone`)
  d.undone = { at: localStamp(), run: brain.current || null }
  return { id, type: d.type, summary: d.summary }
}
