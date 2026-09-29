// One model for "a thing to do" (SPEC §20.24). To do, Today and the course screen each built their own rows from
// Hub/_plan.json, and they disagreed: the course screen offered "Open in Quercus" for a checkpoint quiz that happens
// in a tutorial room, while To do — from the same task — said "Happens in the class". A row is built once, here, and
// every screen draws the same one.
//
// A row says four things, in this order, because that is the order they are read:
//   how crucial it is · what it is · when it is wanted · what to do about it (or why there is nothing to do).
import { resolveTask, resolveItem, linkAction } from './resolve.js'
import { taskNature, weekdayOf, shortIso, relDay, daysTo, addDays, textbookName, localParts, mentions, taskWords } from './plan.js'
import { MY_TASKS } from './mytasks.js'
import { pairSets, attachRows, setSays } from './problems.js'

export const plainTask = t => String(t || '').replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => (b || a).split('/').pop())
const stripOptional = s => String(s).replace(/^\(optional\)\s*/i, '')

const KIND = { read: 'Read', review: 'Revise', problems: 'Problems', watch: 'Watch', write: 'Write', quiz: 'Quiz', bring: 'Bring', due: 'Hand in', participation: 'Hand in' }
// A task whose mark counts. These are the ones that are worth being told about twice.
const GRADED = new Set(['quiz', 'due', 'participation'])
// What a mark depends on, what is asked for but unmarked, and what may be skipped (SPEC §20.54): graded, required,
// optional. Claude says `graded` on a task when it knows; when it did not say, the kind and the link decide — a hand-in,
// participation, a quiz, or a link to a Quercus assignment, quiz or forum is marked work. A hand-in row or a test is
// always graded; your own tasks are neither, and carry no tag.
const GRADED_LINK = /\/(assignments|quizzes|discussion_topics)\/\d+/
export function natureOf({ type = null, claude = null, kind = null, link = null, optional = false } = {}) {
  if (type === 'hand-in' || type === 'sit') return 'graded'
  if (type === 'mine') return null
  if (claude?.graded === true) return 'graded'
  if (claude?.graded !== false && (GRADED.has(kind) || GRADED_LINK.test(String(link || claude?.link || '')))) return 'graded'
  return optional ? 'optional' : 'required'
}

// ---- how crucial ------------------------------------------------------------------------------------------------
// Four levels, from two facts: whether it is marked, and how many days are left. `normal` draws no tag — a badge on
// every row is a badge on none.
export const LEVELS = {
  crucial: { rank: 0, label: 'crucial', why: 'marked, or wanted within a day' },
  important: { rank: 1, label: 'important', why: 'marked, or wanted within three days' },
  normal: { rank: 2, label: '', why: 'there is time' },
  optional: { rank: 3, label: 'optional', why: 'you may skip it' },
}
export function priorityOf({ graded = false, optional = false, daysLeft = null } = {}) {
  if (optional) return { level: 'optional', ...LEVELS.optional }
  const d = typeof daysLeft === 'number' ? daysLeft : 99
  if (d <= 1 || (graded && d <= 7)) return { level: 'crucial', ...LEVELS.crucial }
  if (graded || d <= 3) return { level: 'important', ...LEVELS.important }
  return { level: 'normal', ...LEVELS.normal }
}

// Claude's own word on a task (SPEC §20.37): its level and why, and where to go when it named somewhere. Claude already
// weighed the next class and the week, so nothing here raises it.
const claudePriority = c => ({ level: LEVELS[c.level] ? c.level : 'normal', ...(LEVELS[c.level] || LEVELS.normal), why: c.reason || 'Claude decided' })
// A button that stands in for a link gone dead (resolve.js linkAction) says so on the task sheet.
const standNote = a => (a?.stand ? `The page it linked is no longer there — this opens ${a.label === 'Open its week' ? 'its week' : 'where it came from'}` : null)
const withoutLink = text => String(text).replace(/\s+→\s+(?:\[\[[^\]]*\]\]|https?:\/\/\S+)\s*$/, '')

// ---- when it is wanted ------------------------------------------------------------------------------------------
export const dayLabel = iso => `${weekdayOf(iso)} ${shortIso(iso)}`
export const deadlineOf = (iso, today) => (iso ? { date: iso, daysLeft: daysTo(iso, today), day: dayLabel(iso), rel: relDay(iso, today), text: `${dayLabel(iso)} · ${relDay(iso, today)}` } : null)

// ---- the rows ---------------------------------------------------------------------------------------------------
// One task on one meeting. `ctx` is what resolve.js needs: { titles, links, general, courseUrl }.
// `isNext`: the meeting is the course's next class (SPEC §20.33). What to do before it is never "there is time" —
// preparing for the next class is the first thing a course asks — so a normal task is raised to important.
export function prepRow(t, m, ctx, today, isNext = false) {
  const c = t.claude || null
  // The grammar's "in class" / "not open yet" readings are for the rules' own sentences: Claude's row keeps Claude's link
  // and level (SPEC §20.37), so a task worded "hand it in in class" is not stripped of its button (review 2026-09-18).
  const nat = c ? { ...taskNature(t.text), inClass: false, notOpen: false } : taskNature(t.text)
  const deadline = deadlineOf(m.date, today)
  const graded = GRADED.has(t.kind)
  const optional = c ? c.level === 'optional' : nat.optional
  // Nothing to open for something that happens in the room: offering Quercus there is a button that lies.
  const action = nat.inClass ? null : c?.link ? linkAction(c.link, { courseKey: m.courseKey, week: m.week, source: c.source }, ctx) : resolveTask(t, m, ctx)
  const base = c ? claudePriority(c) : priorityOf({ graded, optional, daysLeft: deadline?.daysLeft })
  const past = deadline.daysLeft < 0, overdue = past && !t.done && !nat.inClass
  return {
    id: m.id + '|' + t.key, type: nat.inClass ? 'in-class' : 'prep', done: !!t.done, canTick: !t.pending,
    task: t, meeting: m, next: isNext, overdue,
    optional, notOpen: nat.notOpen, inClass: nat.inClass,
    nature: natureOf({ type: nat.inClass ? 'in-class' : 'prep', claude: c, kind: t.kind, link: c?.link, optional }),
    priority: !c && isNext && base.level === 'normal' ? { level: 'important', ...LEVELS.important, why: 'to do before your next class' } : base,
    title: stripOptional(plainTask(c ? withoutLink(t.text) : t.text)),
    kindLabel: nat.inClass ? 'In the class' : KIND[t.kind] || 'Prepare',
    course: m.course, courseKey: m.courseKey, color: m.color,
    by: m.date, deadline, when: `${past ? 'was ' : ''}${nat.inClass ? 'in the' : 'before the'} ${String(m.kind).toLowerCase()} · ${deadline.day}`,
    action, note: standNote(action) || noteFor({ inClass: nat.inClass, kind: m.kind, notOpen: nat.notOpen, action, textbook: bookFor(m.courseKey, t.text) }),
    // Where this came from — never the Plan page it is *stored* on (SPEC §20.25): the announcement that said it, or
    // failing that the week it belongs to, which draws the whole list.
    reason: c?.reason || null,
    source: c?.source ? { label: 'Where Claude read it', path: c.source }
      : m.sources?.[0] ? { label: 'The announcement it came from', path: m.sources[0] }
      : m.week?.dir && m.courseKey ? { label: 'The week it belongs to', path: `${m.courseKey}/${m.week.dir}.md` } : null,
  }
}

// One of a week's own tasks (SPEC §20.35): the work of a course with no classes — a reading, a recorded lecture, the
// weekly assignment — wanted by the end of its week, or by its own due date, and ticked on the week's Plan page like a
// class's task. `w` is a plan.weeks entry. The current week's work is the first thing such a course asks, so, like the
// next class's tasks, a normal one is raised to important.
export function weekRow(t, w, ctx, today) {
  const c = t.claude || null
  const due = t.due || addDays(w.week.monday, 6)
  const deadline = deadlineOf(due, today)
  const nat = c ? { ...taskNature(t.text), inClass: false, notOpen: false } : taskNature(t.text)
  const optional = c ? c.level === 'optional' : nat.optional
  const action = c?.link ? linkAction(c.link, { courseKey: w.courseKey, week: w.week, source: c.source }, ctx) : resolveTask(t, { courseKey: w.courseKey, week: w.week }, ctx)
  const base = c ? claudePriority(c) : priorityOf({ graded: t.kind === 'participation', optional, daysLeft: deadline.daysLeft })
  const past = deadline.daysLeft < 0
  return {
    id: w.id + '|' + t.key, type: 'week', done: !!t.done, canTick: !t.pending,
    task: t, meeting: { id: w.id, courseKey: w.courseKey, planPage: w.planPage, planBlock: w.planBlock, week: w.week },
    weekWork: !!w.current, week: w.week, overdue: past && !t.done,
    optional, notOpen: nat.notOpen, inClass: false,
    nature: natureOf({ type: 'week', claude: c, kind: t.kind, link: c?.link, optional }),
    priority: !c && w.current && base.level === 'normal' ? { level: 'important', ...LEVELS.important, why: 'this week’s work' } : base,
    // The title stops before its link: "Watch Lecture 1: Welcome → Lecture 1- Welcome" said the lecture twice, and the
    // button already opens it.
    title: stripOptional(plainTask(withoutLink(t.text))).replace(/\s+—\s+due\s.*$/, ''),
    kindLabel: KIND[t.kind] || 'To do',
    course: w.course, courseKey: w.courseKey, color: w.color,
    by: due, deadline,
    when: t.due ? `${past ? 'was ' : ''}due ${dayLabel(due)}${t.dueTime ? ` at ${t.dueTime}` : ''}` : `${w.current ? 'this week' : w.week.label.replace(/\s*\(.*\)$/, '')} · ${past ? 'was ' : ''}by ${dayLabel(due)}`,
    action, note: standNote(action) || noteFor({ action, textbook: bookFor(w.courseKey, t.text) }),
    reason: c?.reason || null,
    source: c?.source ? { label: 'Where Claude read it', path: c.source } : { label: 'The week it belongs to', path: `${w.courseKey}/${w.week.dir}.md` },
  }
}

// Something to hand in, from Hub/_hub.json's deadlines.
export function dueRow(d, ctx, today, color = null) {
  // The day it is due where the student is, not on the server's clock: Quercus writes `2026-09-22T03:59:59Z` for a Monday 23:59
  // in Toronto, and slicing that stamp put every such hand-in on the day after (SPEC §20.52). The plan already reads the
  // stamp this way (buildPlan); the raw hub rows the screens hand over here did not.
  const lp = localParts(d.due)
  const iso = d.dueDate || lp.date || null
  if (!iso) return null
  const dueTime = d.dueTime !== undefined ? d.dueTime : lp.time
  const deadline = deadlineOf(iso, today)
  const action = resolveItem(d, ctx)
  return {
    id: 'due|' + (d.title || '') + iso, type: 'hand-in', done: false, canTick: false, overdue: deadline.daysLeft < 0,
    optional: false, notOpen: false, inClass: false, nature: 'graded',
    priority: priorityOf({ graded: true, daysLeft: deadline.daysLeft }),
    title: d.title || 'Untitled', kindLabel: 'Hand in',
    course: d.course, courseKey: d.courseKey, color: d.color || color,
    by: iso, deadline, when: `${deadline.daysLeft < 0 ? 'was ' : ''}due ${dayLabel(iso)}${dueTime ? ` at ${dueTime}` : ''}`,
    dueTime: dueTime || null,   // the packer (src/dayplan.js) places the work before the hour, not just the day
    points: d.points || null,
    action, note: noteFor({ action }),
    source: d.page ? { label: 'Its page in slate', path: d.page } : null,
  }
}

// A test, once it is close enough to change this week (To do's horizon; the course screen counts every one of them down).
export function testRow(t, ctx, today) {
  const deadline = deadlineOf(t.date, today)
  const action = resolveItem(t, ctx)
  return {
    id: 'test|' + t.courseKey + t.date, type: 'sit', done: false, canTick: false,
    optional: false, notOpen: false, inClass: true, nature: 'graded',
    priority: priorityOf({ graded: true, daysLeft: deadline.daysLeft }),
    title: t.title, kindLabel: 'Test',
    course: t.course, courseKey: t.courseKey, color: t.color,
    by: t.date, deadline, when: `${dayLabel(t.date)}${t.window?.label ? ` · covers ${t.window.label}` : ''}`,
    action, note: null, source: null,
  }
}

// One of your own tasks, from Hub/Today/My tasks.md (SPEC §20.32). It is ticked like a plan task, has a deadline only
// when you gave it one, and a button only when its own words name somewhere to go — a link, a wikilink, a tool the
// course's Links page knows. The course's Quercus page is never offered as a guess for something you wrote yourself.
const UNDATED = '9999-12-31'
export function myRow(t, { course = null, today, ctx = {} } = {}) {
  const deadline = t.date ? deadlineOf(t.date, today) : null
  const found = resolveTask({ text: t.text }, course ? { courseKey: course.key } : null, ctx)
  const action = found && !found.fallback ? found : null
  return {
    // The id is the line with its box read open: a tick rewrites `raw`, and a row whose id changed with it lost its block
    // on the day, its estimate and its timer. Ids made before this were made from open lines, so they still match.
    id: 'mine|' + t.raw.replace(/^- \[[xX]\] /, '- [ ] '), type: 'mine', done: !!t.done, canTick: true, raw: t.raw, task: null, meeting: null,
    optional: false, notOpen: false, inClass: false, nature: null, overdue: !!deadline && deadline.daysLeft < 0 && !t.done,
    priority: priorityOf({ daysLeft: deadline?.daysLeft }),
    title: plainTask(t.text), kindLabel: 'Your task',
    course: course?.code || null, courseKey: course?.key || null, color: course?.color || null,
    by: t.date || UNDATED, deadline, when: deadline ? deadline.day : 'no date',
    action, note: action ? null : 'Your own — tick it when it is done',
    source: { label: 'Your task list', path: MY_TASKS },
  }
}

// Why a row has no button — said plainly, rather than left as an empty space or, worse, a link that goes nowhere useful. When
// the thing is in the course's textbook, the row says which book rather than "nothing to open" (SPEC §20.38).
function noteFor({ inClass = false, kind = 'class', notOpen = false, action = null, textbook = null } = {}) {
  if (inClass) return `Happens in the ${String(kind).toLowerCase()} — nothing to open first`
  if (notOpen) return 'Not open yet — it appears here when it is'
  if (!action) return textbook ? `In your textbook — ${textbook}. Tick it when it is done` : 'Nothing to open — a reading, your own work. Tick it when it is done'
  return null
}
// The course's textbook, when this is a thing you do in it: its name is in the words, or the words name chapters.
const CHAPTERS = /\bch(?:apter)?s?\.?\s*\d|\bp{1,2}\.?\s*\d|\bexercises?\b|\bproblems?\b/i
function bookFor(courseKey, text) {
  const name = courseKey ? textbookName(courseKey) : null
  if (!name || name === 'the textbook') return null
  const said = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(text || ''))
  return said || CHAPTERS.test(String(text || '')) ? name : null
}

// Every open thing for a course (or for all of them, with courseKey null), soonest first, most crucial first within a day.
// `ctxFor(courseKey)` hands over that course's links and Quercus URL.
// `mine` are your own tasks (src/mytasks.js parseMyTasks) and `courses` the hub's course list their codes are read against.
// `now` (HH:MM) lets a class that has already ended today stop being the next one.
// `past` (SPEC §20.54): what a class or a week that has gone by still contributes — 'open' (the default) keeps only what was
// not done, which is what To do and Home want; 'all' keeps the done ones too, for a week page that shows what was missed
// beside what was done. Nothing that happens in the room, and nothing optional, comes back from the past.
export function rowsFor({ plan, hub, tests = null, ctxFor: ctxOf = () => ({}), today, now = null, courseKey = null, testHorizon = null, mine = [], courses = [], past = 'open' }) {
  const out = []
  // The course's deadlines go to resolve.js with the rest: its rule that gives "Hand in Problem Set 1" the assignment's own
  // URL (SPEC §20.39) reads `ctx.deadlines`, and no screen handed them over, so it never fired.
  const ctxFor = key => { const c = ctxOf(key) || {}; return c.deadlines || !hub?.deadlines ? c : { ...c, deadlines: hub.deadlines.filter(d => d.courseKey === key) } }
  const next = nextClasses(plan, today, now)
  const gone = t => (t.claude ? t.claude.level === 'optional' : taskNature(t.text).optional || taskNature(t.text).inClass)
  // A WebAssign set is one thing to do (SPEC §20.69). The outline's row for it — "WebAssign Fall-Ex2 · week of Sep 21 · date
  // unconfirmed", which cannot be ticked — and a task that names the same set are the same work, and To do showed both. The
  // task is the row, wherever it sits (the week the set is for, or the week Claude put it in); it borrows the set's due day
  // when it has none of its own, and once any task naming the set is ticked the set is done. `standsFor`: task → the
  // outline's deadline it stands for; `setDone`: the deadlines a ticked task has closed; `folded`: deadline → the row shown.
  const standsFor = new Map(), setDone = new Set(), folded = new Map()
  {
    const tasks = [...(plan?.meetings || []).flatMap(m => (m.before || []).map(t => [m.courseKey, t])), ...(plan?.weeks || []).flatMap(w => (w.work || []).map(t => [w.courseKey, t]))]
    for (const d of hub?.deadlines || []) {
      if (!d.set || (courseKey && d.courseKey !== courseKey)) continue
      for (const [ck, t] of tasks) {
        if (ck !== d.courseKey || (t.stale && !t.done) || !mentions(taskWords(t.text), d.set)) continue
        if (t.done) setDone.add(d); else if (!standsFor.has(t)) standsFor.set(t, d)
      }
    }
  }
  const lend = (t, row) => { const d = standsFor.get(t); if (d && !folded.has(d)) folded.set(d, row); return row }
  const dueOf = d => ({ due: d.dueDate || localParts(d.due).date || null, dueTime: d.dueTime !== undefined ? d.dueTime : localParts(d.due).time })
  for (const t of mine || []) {
    const course = (courses || []).find(c => c.code === t.course) || null
    if (courseKey && course?.key !== courseKey) continue
    if (t.done && t.date && t.date < today) continue            // done and in the past: it has left the list, not the file
    out.push(myRow(t, { course, today, ctx: ctxFor(course?.key) }))
  }
  for (const m of plan?.meetings || []) {
    if (m.cancelled || (courseKey && m.courseKey !== courseKey)) continue
    const before = m.date < today
    // A task marked "no longer listed" keeps its line on the Plan page — nothing is deleted there (SPEC §20.3) — but it has
    // left the list of things to do, and showing it as crucial because its class is tomorrow is noise (SPEC §20.38).
    for (const t of m.before || []) {
      if (t.stale && !t.done) continue
      if (before && (gone(t) || (t.done && past !== 'all'))) continue
      out.push(lend(t, prepRow(t, m, ctxFor(m.courseKey), today, next.get(m.courseKey)?.id === m.id)))
    }
  }
  // a week's own work (SPEC §20.35): a course with no classes, from this week to the end of the plan's horizon
  for (const w of plan?.weeks || []) {
    if (courseKey && w.courseKey !== courseKey) continue
    const before = addDays(w.week.monday, 6) < today
    for (const t of w.work || []) {
      if (t.stale && !t.done) continue
      if (before && (gone(t) || (t.done && past !== 'all'))) continue
      const set = standsFor.get(t), own = set && !t.due ? { ...t, ...dueOf(set) } : t   // Fall-Ex3 is due Fri Oct 9, not "by the end of the week"
      out.push(lend(t, weekRow(own, w, ctxFor(w.courseKey), today)))
    }
  }
  // A hand-in Claude already made a task of (SPEC §20.52) — the same assignment, by its own URL and its day — is one row:
  // the task, tickable, at Claude's level and with his reason, lent the points the Quercus row knows. Two rows for one
  // thing, on different days and at different levels, was the discrepancy the To do list showed.
  const covered = new Map()
  for (const r of out) { const link = r.task?.claude?.link; if (link && /^https?:\/\//.test(link)) covered.set(`${r.courseKey}|${link}|${r.task.due || r.by}`, r) }
  for (const d of hub?.deadlines || []) {
    if (courseKey && d.courseKey !== courseKey) continue
    if (setDone.has(d)) continue
    if (folded.has(d)) { const row = folded.get(d); if (row.points == null && d.points) row.points = d.points; continue }
    const r = dueRow(d, ctxFor(d.courseKey), today)
    if (!r || (r.deadline.daysLeft < 0 && d.submitted)) continue   // a hand-in missed stays until Quercus says it is in (SPEC §20.54)
    const twin = d.url ? covered.get(`${d.courseKey}|${d.url}|${r.by}`) : null
    if (twin) { if (twin.points == null && d.points) twin.points = d.points; continue }
    out.push(r)
  }
  for (const t of tests || []) {
    if (!t.date || (courseKey && t.courseKey !== courseKey)) continue
    const n = daysTo(t.date, today)
    if (n < 0 || (testHorizon != null && n > testHorizon)) continue
    out.push(testRow(t, ctxFor(t.courseKey), today))
  }
  return out.sort((a, b) => a.by.localeCompare(b.by) || a.priority.rank - b.priority.rank || String(a.title).localeCompare(String(b.title)))
}

// Each course's next class from the plan: the earliest meeting that is not cancelled and not over. → Map courseKey → meeting
export function nextClasses(plan, today, now = null) {
  const out = new Map()
  const at = m => `${m.date}T${m.announced?.start || m.start || '00:00'}`
  for (const m of plan?.meetings || []) {
    if (m.cancelled || m.date < today || (now && m.date === today && (m.announced?.end || m.end || '23:59') <= now)) continue
    const cur = out.get(m.courseKey)
    if (!cur || at(m) < at(cur)) out.set(m.courseKey, m)
  }
  return out
}

// ---- practice: what is worth doing when there is time (SPEC §20.33) ---------------------------------------------------
// The course screen said what had to be done and nothing about the rest, so an ungraded problem set — the thing you do
// between classes — was not on it at all. These rows come from the week's Problems (src/problems.js pairSets): one
// per set or guide in last week, this week and next, never per question, left out once every question has been
// checked against the solutions. Tutorial questions are not practice while their tutorial is ahead — "try them before
// you come and bring your work" — so a tutorial set is `prep-set`, wanted by that tutorial; everything else is optional.
// `weeks` is /api/course's problems.weeks; `course` { key, code, color }.
export function practiceRows({ weeks = [], course = null, today, curN = null }) {
  const out = []
  for (const w of weeks || []) {
    if (curN != null && (w.n < curN - 1 || w.n > curN + 1)) continue
    const { sets } = attachRows(pairSets(w.items || []), w.rows || [])
    const weekPath = String(w.page || '').replace(/\/Problems\.md$/, '')
    for (const s of sets) {
      const tried = s.rows.filter(r => r.attempted).length, checked = s.rows.filter(r => r.reviewed).length
      if (s.rows.length && checked === s.rows.length) continue
      const tutorial = s.role === 'set' && /\btutorial\b/i.test(s.name) && w.tutorial && w.tutorial >= today ? w.tutorial : null
      const deadline = tutorial ? deadlineOf(tutorial, today) : null
      const progress = s.rows.length ? `${tried} of ${s.rows.length} tried` : null
      out.push({
        id: `practice|${w.page}|${s.key}`, type: tutorial ? 'prep-set' : 'practice', done: false, canTick: false, meeting: null, task: null,
        optional: !tutorial, notOpen: false, inClass: false, meetingDate: tutorial,
        priority: tutorial ? priorityOf({ daysLeft: deadline.daysLeft }) : { level: 'optional', ...LEVELS.optional, why: 'practice — not marked, do it when there is time' },
        title: s.name, kindLabel: s.role === 'guide' ? 'Guide' : tutorial ? 'Tutorial questions' : 'Practice',
        course: course?.code || null, courseKey: course?.key || null, color: course?.color || null,
        by: tutorial || '9999-12-31', deadline,
        when: tutorial ? `try them and bring your work · ${deadline.day}` : [w.week?.replace(/\s*\(.*\)$/, ''), setSays(s), progress].filter(Boolean).join(' · '),
        action: s.role === 'guide' ? { label: 'Read it', path: s.guide.path } : { label: 'Work on it', path: `${weekPath}/Problems.md` },
        note: null, source: { label: 'The week it belongs to', path: `${weekPath}.md` },
        set: { name: s.name, tried, checked, total: s.rows.length, says: setSays(s) },
      })
    }
  }
  return out
}

// What "you have N things to do" counts: not what happens in a room, not what is not open yet, not what is done.
export const isOpen = r => !r.done && r.type !== 'in-class' && !r.notOpen && !r.optional
