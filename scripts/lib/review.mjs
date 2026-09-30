// Weeks he flagged for review (SPEC §21.13): one file in the notes, Hub/_review.json, written only by the server (PUT
// /api/review, the week screen's Flag for review) or by his Claude when he asks, and read by the routes that draw a week,
// a course and the hub. The morning's sync never touches it; an update never reaches it.
//
//   { "version": 1, "courses": { "<course key>": { "<week n>": { "week": "Week 3 (Sep 21)", "note": "…", "at": "…" } } } }
//
// `n` is the week's number in its course's term (scripts/lib/terms.mjs weeks), the number a test's coverage window lists.
import fs from 'node:fs/promises'
import path from 'node:path'

export const REVIEW_JSON = root => path.join(root, 'Hub', '_review.json')
export const NOTE = 'Weeks flagged for review from the week screen, each with an optional short note; they show on the tests whose weeks they are in. SPEC §21.13.'
export const NOTE_MAX = 120

export async function readReview(root) {
  try { const j = JSON.parse(await fs.readFile(REVIEW_JSON(root), 'utf8')); return j && typeof j.courses === 'object' && j.courses ? j : { version: 1, courses: {} } }
  catch { return { version: 1, courses: {} } }
}
// One line, trimmed, at most NOTE_MAX characters: it is a reminder, not a page.
export const cleanNote = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '')

// The file with one week's flag set (`flag` = { week, note }) or removed (null) — the server's route and `brain.mjs review`
// both write through this, so the two agree on the shape.
export function withFlag(doc, course, n, flag) {
  const flags = { ...(doc.courses?.[course] || {}) }
  if (flag) flags[n] = { week: typeof flag.week === 'string' && flag.week.trim() ? flag.week.trim().slice(0, 60) : `Week ${n}`, note: cleanNote(flag.note), at: new Date().toISOString() }
  else delete flags[n]
  const courses = { ...(doc.courses || {}) }
  if (Object.keys(flags).length) courses[course] = flags; else delete courses[course]
  return { _note: NOTE, version: 1, courses }
}

// A task the morning wrote for a flag says so first in its reason; that is how one is told from any other review task.
export const FOR_FLAG = /^flagged for review\b/i
export const REVIEW_LEAD_DAYS = 10   // a flag becomes a task once a test that covers its week is this close

// What the morning brief says about the flags of one course (scripts/lib/brief.mjs): each flag with the tests ahead that
// cover its week and the task already written for it, and the tasks written for a flag he has since removed.
//   flags: this course's { [n]: { week, note, at } }; weeks: terms.mjs weeks; tests: calendar.js testsFor (with windows);
//   tasks: brain.tasks of the course; pageOf(w) → the week's page or null
export async function reviewBrief({ flags = {}, weeks = [], tests = [], tasks = [], pageOf }) {
  const open = tasks.filter(t => t && !t.withdrawn && t.kind === 'review')
  const review = [], pages = new Set()
  for (const [n, f] of Object.entries(flags)) {
    const w = weeks.find(x => x.n === Number(n)); if (!w) continue
    const page = await pageOf(w); if (page) pages.add(page)
    const on = tests.filter(t => Array.isArray(t.window?.weeks) && t.window.weeks.includes(w.n)).map(t => ({ title: t.title, date: t.date, inDays: t.inDays }))
    const task = open.find(t => page && t.link === page) || null
    review.push({ week: w.n, label: w.label, note: f.note || null, flagged: String(f.at || '').slice(0, 10) || null, page, tests: on,
      task: task ? { id: task.id, what: task.what, due: task.due || null, done: !!task.done } : null })
  }
  const orphans = open.filter(t => !t.done && FOR_FLAG.test(t.reason || '') && !pages.has(t.link)).map(t => ({ id: t.id, what: t.what }))
  const needs = review.filter(r => !r.task && r.tests.some(t => t.inDays <= REVIEW_LEAD_DAYS)).map(r => `Week ${r.week}`)
  return { review, orphans, needs }
}
