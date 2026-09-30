// Topics he flagged for review (SPEC §21.13): one file in the notes, Hub/_review.json, written only by the server (PUT
// /api/review, the week screen's Flag a topic for review) or by `brain.mjs review` when he asks his Claude, and read by
// the routes that draw a week, a course and the hub, and by the morning's brief. The sync never touches it; an update
// never reaches it.
//
//   { "version": 2, "courses": { "<course key>": { "<week n>": { "week": "Week 3 (Sep 21)",
//       "topics": [{ "id": "f-1a2b3c", "topic": "IS-LM", "note": "the derivations", "at": "…" }] } } } }
//
// `n` is the week's number in its course's term (scripts/lib/terms.mjs weeks), the number a test's coverage window lists.
// A topic of null is the week as a whole. v2026.09.30 wrote one flag a week, { week, note, at }: it reads as that week's
// one topic, null, with its note.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { topicsLine } from '../../src/review.js'

export const REVIEW_JSON = root => path.join(root, 'Hub', '_review.json')
export const NOTE = 'Topics flagged for review from the week screen, each with an optional short note; they show on the tests whose windows hold their week, and the morning turns a week of them into one review task before the test. SPEC §21.13.'
export const NOTE_MAX = 120, TOPIC_MAX = 80, TOPICS_MAX = 12

// One line, trimmed, at most `max` characters: a reminder, not a page.
export const cleanNote = (v, max = NOTE_MAX) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const newId = () => 'f-' + crypto.randomBytes(3).toString('hex')
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

// A week's entry in the shape of now, whatever wrote it.
export function weekOf(entry, n) {
  if (!entry || typeof entry !== 'object') return null
  // an id written by hand may be missing: its place in the list stands in, so an edit by id finds the same topic twice running
  const topics = Array.isArray(entry.topics) ? entry.topics.filter(t => t && typeof t === 'object').map((t, i) => ({ id: String(t.id || `f-${i}`), topic: cleanNote(t.topic, TOPIC_MAX) || null, note: cleanNote(t.note), at: t.at || null }))
    : 'note' in entry || 'at' in entry ? [{ id: 'f-week', topic: null, note: cleanNote(entry.note), at: entry.at || null }] : []
  return topics.length ? { week: typeof entry.week === 'string' && entry.week ? entry.week : `Week ${n}`, topics } : null
}
export async function readReview(root) {
  let j = null
  try { j = JSON.parse(await fs.readFile(REVIEW_JSON(root), 'utf8')) } catch { }
  const courses = {}
  for (const [k, weeks] of Object.entries(j && typeof j.courses === 'object' && j.courses ? j.courses : {})) {
    for (const [n, e] of Object.entries(weeks || {})) { const w = weekOf(e, n); if (w) (courses[k] ||= {})[n] = w }
  }
  return { version: 2, courses }
}

// The file with one change to one week's topics — the server's route and `brain.mjs review` both write through this.
//   { topic, note, id? }  add a topic (or, when `id` or the same words name one already there, change it)
//   { remove: true, id? | topic? }  take one topic off; with neither, the whole week
// → { doc, week: the week's entry after it, or null }
export function withReview(doc, course, n, week, op) {
  const courses = { ...(doc.courses || {}) }, weeks = { ...(courses[course] || {}) }
  const cur = weekOf(weeks[n], n) || { week: `Week ${n}`, topics: [] }
  let topics = [...cur.topics]
  if (op.remove) {
    const hit = op.id ? topics.findIndex(t => t.id === op.id) : 'topic' in op ? topics.findIndex(t => same(t.topic, cleanNote(op.topic, TOPIC_MAX) || null)) : -2
    if (hit === -1) throw new Error('that topic is not flagged')
    topics = hit === -2 ? [] : topics.filter((_, i) => i !== hit)
  } else {
    const topic = cleanNote(op.topic, TOPIC_MAX) || null, note = cleanNote(op.note)
    const at = op.id ? topics.findIndex(t => t.id === op.id) : topics.findIndex(t => same(t.topic, topic))
    if (op.id && at === -1) throw new Error('that topic is not flagged')
    // matched by its words, a topic keeps the spelling it was flagged with and takes the new note; by its id, it takes both
    if (at >= 0) topics[at] = { ...topics[at], topic: op.id ? topic : topics[at].topic, note, at: new Date().toISOString() }
    else { if (topics.length >= TOPICS_MAX) throw new Error(`at most ${TOPICS_MAX} topics a week`); topics.push({ id: newId(), topic, note, at: new Date().toISOString() }) }
  }
  const label = typeof week === 'string' && week.trim() ? week.trim().slice(0, 60) : cur.week
  if (topics.length) weeks[n] = { week: label, topics }; else delete weeks[n]
  if (Object.keys(weeks).length) courses[course] = weeks; else delete courses[course]
  return { doc: { _note: NOTE, version: 2, courses }, week: weeks[n] || null }
}


// A task the morning wrote for a flagged week says so first in its reason; that is how one is told from any other review task.
export const FOR_FLAG = /^flagged for review\b/i
export const REVIEW_LEAD_DAYS = 10   // a flagged week becomes a task once a test that covers it is this close

// What the morning brief says about one course's flags (scripts/lib/brief.mjs): each flagged week with its topics, the tests
// ahead that cover it and the task already written for it; the tasks written for a week he has since unflagged.
//   flags: this course's { [n]: { week, topics } }; weeks: terms.mjs weeks; tests: calendar.js testsFor (with windows);
//   tasks: brain.tasks of the course; pageOf(w) → the week's page or null
export async function reviewBrief({ flags = {}, weeks = [], tests = [], tasks = [], pageOf }) {
  const open = tasks.filter(t => t && !t.withdrawn && t.kind === 'review')
  const review = [], pages = new Set()
  for (const [n, e] of Object.entries(flags)) {
    const f = weekOf(e, n), w = weeks.find(x => x.n === Number(n)); if (!f || !w) continue
    const page = await pageOf(w); if (page) pages.add(page)
    const on = tests.filter(t => Array.isArray(t.window?.weeks) && t.window.weeks.includes(w.n)).map(t => ({ title: t.title, date: t.date, inDays: t.inDays }))
    const task = open.find(t => page && t.link === page) || null
    review.push({ week: w.n, label: w.label, topics: f.topics.map(t => ({ topic: t.topic, note: t.note || null })), line: topicsLine(f.topics),
      flagged: f.topics.map(t => String(t.at || '').slice(0, 10)).sort().pop() || null, page, tests: on,
      task: task ? { id: task.id, what: task.what, due: task.due || null, done: !!task.done } : null })
  }
  const orphans = open.filter(t => !t.done && FOR_FLAG.test(t.reason || '') && !pages.has(t.link)).map(t => ({ id: t.id, what: t.what }))
  const needs = review.filter(r => !r.task && r.tests.some(t => t.inDays <= REVIEW_LEAD_DAYS)).map(r => `Week ${r.week}`)
  return { review, orphans, needs }
}
