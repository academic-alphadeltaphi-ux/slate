// The plan model (SPEC §20.3): the announcement grammar, placement on meetings, the tasks a class wants done
// before it, the append-only merge of a week's `Plan` page, coverage counts against the next test, and the
// renderers for Hub/_plan.json and Hub/Today/Next 7 days.md. Pure and browser-safe (the src/grade.js pattern):
// scripts/plan.mjs, server/routes/plan.js and the client import it; nothing here touches disk or Date.now().
// Meetings come from src/calendar.js (the one expansion); problem phrases are handed to src/problems.js.
import { COURSES, weeks, weekFor, TERMS } from '../scripts/lib/terms.mjs'
import { SYLLABUS } from '../scripts/lib/syllabus.mjs'
import { expandMeetings, nextTest, coverageWindow, syllabusWeekN, addDays, weekdayOf, daysTo, relDay, shortIso } from './calendar.js'
import { fold, keyOf, extractProblemRefs, summarizeBlocks, HEADING as PROBLEMS_HEADING } from './problems.js'
import { THIS as ED } from './edition.js'

export const HORIZON_DAYS = 14, SHOW_DAYS = 7
export const PLAN_HEADING = '## Before class'
export const STALE = ' · no longer listed'
// Depth-0 GFM task items only — the same rule as server/format.js (which is not browser-safe).
export const TASK_RE = /^[-*] \[( |x|X)\] (.*)$/gm
const TASK_LINE = /^[-*] \[( |x|X)\] (.*)$/
const GROUP_LINE = /^### (.+?)\s*$/
// fold (src/problems.js) is NFD-stripped, lowercased and whitespace-collapsed; foldKey drops trailing punctuation.
export const foldKey = s => fold(s).replace(/[.,;:!]+$/, '').trim()
// A task's stable identity: the text before ` → ` or ` — `, without the stale suffix, folded (SPEC §20.3).
export const taskKey = text => foldKey(String(text || '').replace(/ · no longer listed\s*$/, '').split(/ → | — /)[0])
export const groupKey = label => foldKey(label)
export const planPageRel = (courseKey, week) => `${courseKey}/${week.dir}/Plan.md`
export const problemsPageRel = (courseKey, week) => `${courseKey}/${week.dir}/Problems.md`
// The heading of a meeting's task group: `### Tue Sep 15 · Tutorial`.
export const meetingLabel = m => `${weekdayOf(m.date)} ${shortIso(m.date)} · ${m.kind}`
// The textbook as a task names it: a parenthesised acronym wins ("(WMS)"), else the text before the first comma.
export const textbookName = courseKey => { const t = String(COURSES[courseKey]?.textbook || ''); const a = /\(([A-Z]{2,6})\)/.exec(t); return a ? a[1] : (t.split(',')[0].trim() || 'the textbook') }
const codeOf = courseKey => COURSES[courseKey]?.code || courseKey.replace(/\s+/g, '').slice(0, 6)
const longDay = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }
// The local date and time of an ISO stamp ('2026-09-25T03:59:00Z' → Sep 24 23:59 in Toronto); a date-only string is itself.
export const localParts = iso => {
  const v = String(iso || '')
  if (!/T/.test(v)) return { date: v.slice(0, 10), time: null }
  const d = new Date(v); if (Number.isNaN(d.getTime())) return { date: v.slice(0, 10), time: v.slice(11, 16) || null }
  return { date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
}
const firstLine = md => (String(md || '').split('\n').find(l => l.trim() !== '') || '').trimEnd()

// ---- 1. the announcement grammar (SPEC §20.3) ------------------------------------------------------------------
const pad2 = n => String(n).padStart(2, '0')
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)'
const WEEKDAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?'
const MONTH_N = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
// A date token: optional weekday, month word, day, optional year. The year: explicit wins, else Aug–Dec → the fall term's year, else the winter's.
export const DATE_RE = new RegExp(`(?:\\b${WEEKDAY}\\.?,?\\s+)?\\b(${MONTH})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'i')
// An anchor line: a weekday, a date, an optional `(time, room)`, a separator, then the scope's first line.
export const ANCHOR_RE = new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*|__)?(${WEEKDAY})\\.?,?\\s+(${MONTH})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?:\\*\\*|__)?\\s*(?:\\(([^)]*)\\))?\\s*(?:\\*\\*|__)?\\s*[:.\\-–—]?\\s*(.*)$`, 'i')
const MER = '(?:a\\.?m\\.?|p\\.?m\\.?)'
export const TIME_RE = new RegExp(`(\\d{1,2})(?::(\\d{2}))?\\s*(${MER})?\\s*(?:-|–|—|to|until)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(${MER})?`, 'i')
export const READ_RE = /\b(read|re-read|reading|review|prepare|preview|study)\b/i
export const CHAPTERS_RE = /\bch(?:apter)?s?\.?\s*(\d+[A-Za-z]?(?:\.\d+)?(?:\s*(?:,|and|&|–|-|to)\s*(?:ch(?:apter)?s?\.?\s*)?\d+[A-Za-z]?(?:\.\d+)?)*)/i
export const QUOTED_RE = /[“"]([^”"]{3,120})[”"]/
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/
export const TOPIC_RE = /\b(?:lecture|tutorial|class|session)\s+(?:on|about|covers?|will cover|is on|is about)\s+([^.\n]+)/i
export const BRING_RE = /\bbring\b\s+([^.\n]+)/i
export const DUE_RE = /\b(?:due|submit|submitted|hand in|handed in)\b/i
export const CANCEL_RE = new RegExp(`\\bno\\s+(tutorials?|lectures?|class(?:es)?)\\b[^.\\n]*?\\b(?:on|during|in|for)\\s+(?:the\\s+)?(?:(first\\s+week)|(${MONTH}[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|${WEEKDAY}\\.?,?\\s+${MONTH}[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?))`, 'i')
const CANCEL_ANY = /\bno\s+(?:tutorials?|lectures?|class(?:es)?)\b/i
const PROBLEM_LEAD = /\b(?:problems?|questions?|exercises?)\b/i
const SENT_SPLIT = /(?<=[.!?])(?<!\b(?:ch|chap|ex|no|q|p|pp|sec|vs|fig|eq|e\.g|i\.e)\.)\s+/i

const isoFrom = (monthWord, day, year) => {
  const mo = MONTH_N[monthWord.toLowerCase().slice(0, 4)] || MONTH_N[monthWord.toLowerCase().slice(0, 3)]
  const d = Number(day); if (!mo || d < 1 || d > 31) return null
  const y = year ? Number(year) : mo >= 8 ? Number(TERMS.FALL.start.slice(0, 4)) : Number(TERMS.WINTER.start.slice(0, 4))
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
// The first date token in a text as an ISO date, or null.
export const dateIn = text => { const m = DATE_RE.exec(String(text || '')); return m ? isoFrom(m[1], m[2], m[3]) : null }
export const sentencesOf = text => String(text || '').split(/\n/).flatMap(p => p.split(SENT_SPLIT)).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
const hhmm = (h, m) => `${pad2(h)}:${pad2(m)}`
// A room as the timetable spells it: a space between the letters and the digits ("KP108" → "KP 108").
export const normalisePlace = s => String(s || '').replace(/^[\s,;·]+|[\s,;·]+$/g, '').replace(/^(?:in|at|room)\s+/i, '').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim()

// parseTime('3-5pm, KP108') → { start:'15:00', end:'17:00', where:'KP 108' }; a meridiem on one side applies to both
// unless the span would run backwards ("11-1pm" → 11:00–13:00); no meridiem and end ≤ start → end + 12.
export function parseTime(s) {
  const text = String(s || '').trim(); if (!text) return null
  const m = TIME_RE.exec(text)
  let start = null, end = null
  if (m) {
    let h1 = Number(m[1]), h2 = Number(m[4]); const m1 = Number(m[2] || 0), m2 = Number(m[5] || 0)
    const a = m[3] ? m[3].toLowerCase().replace(/\./g, '') : null, b = m[6] ? m[6].toLowerCase().replace(/\./g, '') : null
    const pm = x => (x < 12 ? x + 12 : x), am = x => (x === 12 ? 0 : x)
    if (a === 'pm') h1 = pm(h1); else if (a === 'am') h1 = am(h1)
    if (b === 'pm') h2 = pm(h2); else if (b === 'am') h2 = am(h2)
    if (!a && b === 'pm' && h1 < 12 && h1 <= h2 - 12) h1 = pm(h1)
    if (!a && !b) { if (h1 < 8) h1 += 12; if (h2 * 60 + m2 <= h1 * 60 + m1) h2 += 12 }
    if (a && !b && h2 * 60 + m2 <= h1 * 60 + m1) h2 += 12
    if (h1 <= 23 && h2 <= 23) { start = hhmm(h1, m1); end = hhmm(h2, m2) }
  }
  const where = normalisePlace(m ? text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length) : text)
  if (!start && !where) return null
  return { start, end, where: where || null }
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim()
const shorten = (s, n = 90) => { const t = clean(s); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t }

// parseAnnouncement({ courseKey, title, body, postedAt, page }) → { anchors, items, issues, topics }
//   anchors: [{ date, start, end, where, line, raw, scope }]
//   items:   [{ kind:'read'|'problems'|'bring'|'due'|'cancel', date|null, anchor|null, text, …, confidence, source:{ page, title, line, raw } }]
//   issues:  [{ kind:'unparsed', text, reason, page, title, line }]      (a problems lead-in with nothing tokenisable)
//   topics:  [{ date, text, line }]                                        (an anchor's topic, from the scope)
// The body is the subpage markdown after the H1, byline and Concerns line. A line starting with a weekday and a date is an
// anchor whose scope runs to the next anchor; the text before the first anchor is unscoped. Sentences with dates but
// no lead-in are informative and ignored on purpose.
export function parseAnnouncement({ courseKey, title, body, postedAt, page }) {
  const lines = String(body || '').split('\n')
  const regions = [{ anchor: null, lines: [], line: 0 }]
  lines.forEach((l, i) => {
    const m = ANCHOR_RE.exec(l)
    const date = m ? isoFrom(m[2], m[3], m[4]) : null
    if (m && date) {
      const t = parseTime(m[5] || '')
      regions.push({ anchor: { date, weekday: m[1], start: t?.start || null, end: t?.end || null, where: t?.where || null, line: i, raw: clean(l), scope: '' }, lines: [m[6] || ''], line: i })
    } else regions[regions.length - 1].lines.push(l)
  })
  const anchors = [], items = [], issues = [], topics = []
  const src = (line, raw) => ({ page, title, line, raw: clean(raw) })
  for (const r of regions) {
    const text = r.lines.join('\n')
    if (r.anchor) { r.anchor.scope = clean(text); anchors.push(r.anchor) }
    const date = r.anchor?.date || null
    const base = { date, anchor: r.anchor ? { start: r.anchor.start, end: r.anchor.end, where: r.anchor.where } : null }
    // problems → src/problems.js; a lead-in that yields nothing is never dropped silently
    const { refs, issues: pIssues } = extractProblemRefs(text)
    if (refs.length) items.push({ kind: 'problems', ...base, refs: refs.map(x => ({ label: x.label, chapter: x.chapter, n: x.n })), text: refs[0].sentence, confidence: 'exact', source: src(r.line, refs[0].sentence) })
    for (const is of pIssues) issues.push({ kind: 'unparsed', text: is.sentence, reason: is.reason, page, title, line: r.line })
    // the anchor's topic: "lecture on X", else the first clause when it is short and not a task
    if (r.anchor) {
      const scope = r.anchor.scope
      // the first clause when it is short and not a task ("First tutorial", "Second lecture on Chapter 2"), else "lecture on X"
      const first = clean(scope.split(/[.;:!?]/)[0] || '')
      const tm = TOPIC_RE.exec(scope)
      let topic = first && first.length <= 60 && !READ_RE.test(first) && !PROBLEM_LEAD.test(first) && !BRING_RE.test(first) && !DUE_RE.test(first) && !CANCEL_ANY.test(first) ? first : null
      if (!topic && tm) topic = clean(tm[1]).replace(/[.;:!]+$/, '')
      if (topic) {
        topics.push({ date, text: topic, line: r.line })
        const ch = CHAPTERS_RE.exec(scope.split(/[.;!?]/)[0] || scope)
        if (ch) items.push({ kind: 'read', ...base, chapters: splitChapters(ch[1]), title: null, link: null, inferredFrom: topic, text: clean(scope.split(/[.;!?]/)[0]), confidence: 'inferred', source: src(r.line, scope.split(/[.;!?]/)[0]) })
      }
    }
    for (const s of sentencesOf(text)) {
      // no class
      const c = CANCEL_RE.exec(s)
      if (c) items.push({ kind: 'cancel', ...base, what: /tutorial/i.test(c[1]) ? 'Tutorial' : /lecture/i.test(c[1]) ? 'Lecture' : null, week: c[2] ? 1 : null, date: c[3] ? dateIn(c[3]) : date, text: s, confidence: 'exact', source: src(r.line, s) })
      else if (CANCEL_ANY.test(s)) issues.push({ kind: 'unplaced', text: s, reason: 'no class, but the grammar could not read which day', page, title, line: r.line })
      // read: chapters, or a quoted title (with the sentence's first link)
      if (READ_RE.test(s)) {
        const lead = s.slice(READ_RE.exec(s).index)
        const ch = CHAPTERS_RE.exec(lead), qt = QUOTED_RE.exec(lead)
        if (ch) items.push({ kind: 'read', ...base, chapters: splitChapters(ch[1]), title: null, link: null, text: s, confidence: 'exact', source: src(r.line, s) })
        else if (qt) { const lk = LINK_RE.exec(s); items.push({ kind: 'read', ...base, chapters: [], title: clean(qt[1]), link: lk ? { text: lk[1], url: lk[2] } : null, text: s, confidence: 'exact', source: src(r.line, s) }) }
      }
      const b = BRING_RE.exec(s)
      if (b) items.push({ kind: 'bring', ...base, text: clean(b[1]).replace(/[.;:!]+$/, ''), confidence: 'exact', source: src(r.line, s) })
      if (DUE_RE.test(s)) { const after = s.slice(DUE_RE.exec(s).index); const d = dateIn(after); if (d) items.push({ kind: 'due', ...base, date: d, text: s, confidence: 'exact', source: src(r.line, s) }) }
    }
  }
  return { anchors, items, issues, topics }
}
function splitChapters(list) {
  const out = []
  for (const part of String(list).split(/\s*(?:,|and|&)\s*/i)) {
    const p = part.replace(/^ch(?:apter)?s?\.?\s*/i, '').trim(); if (!p) continue
    const r = /^(\d+)\s*(?:–|-|to)\s*(?:ch(?:apter)?s?\.?\s*)?(\d+)$/i.exec(p)
    if (r && Number(r[2]) >= Number(r[1]) && Number(r[2]) - Number(r[1]) <= 12) { for (let k = Number(r[1]); k <= Number(r[2]); k++) out.push(String(k)) }
    else out.push(p.replace(/\s*(?:–|-|to)\s*/i, '–'))
  }
  return [...new Set(out)]
}

// ---- 2. placement (SPEC §20.3) -------------------------------------------------------------------------------------
// placeItems(meetings, parsed, { courseKey, postedAt, concernsWeeks:[labels] }) → { placed: Map<meetingId, item[]>, issues }
// An anchored item goes to the course meeting on that date (the kind the topic names when two meet that day); no meeting
// that day → issue `unplaced`. An unscoped item goes to the one meeting in the announcement's Concerns weeks (else the
// week it was posted) on or after the posting date; several or none → `unplaced`. A `due` item goes to the last meeting
// on or before its date. Cancels mutate `meetings[].cancelled` ('no tutorial (announcement of Sep 1)'); an anchor's
// topic and time/room land on the meeting (`topic`, `announced`).
export function placeItems(meetings, parsed, { courseKey, postedAt, concernsWeeks = [], title = '', page = null } = {}) {
  const info = COURSES[courseKey], code = codeOf(courseKey)
  const mine = meetings.filter(m => m.courseKey === courseKey)
  const wks = info ? weeks(info.term) : []
  const placed = new Map(), issues = [...parsed.issues.map(i => ({ ...i, courseKey, course: code }))]
  const put = (m, item) => { if (!placed.has(m.id)) placed.set(m.id, []); placed.get(m.id).push(item) }
  const since = String(postedAt || '').slice(0, 10)
  const posted = since ? weekFor(info?.term || 'Y', since) || (wks.length && since < wks[0].monday ? wks[0] : null) : null
  const scopeWeeks = (concernsWeeks.length ? concernsWeeks.map(l => wks.find(w => w.label === l)).filter(Boolean) : []).concat(!concernsWeeks.length && posted ? [posted] : [])
  const inScope = m => scopeWeeks.some(w => m.week?.n === w.n)
  const mark = (m, reason) => { if (!m.cancelled) m.cancelled = reason }
  // cancels first, so placement sees them
  for (const it of parsed.items.filter(i => i.kind === 'cancel')) {
    const why = `no ${it.what ? it.what.toLowerCase() : 'class'} (announcement of ${shortIso(since || it.date || wks[0]?.monday || '2026-09-07')})`
    const kindOk = m => !it.what || m.kind === it.what
    if (it.week === 1 && wks[0]) { for (const m of mine) if (m.week?.n === 1 && kindOk(m)) mark(m, why) }
    else if (it.date) { const hit = mine.filter(m => m.date === it.date && kindOk(m)); if (hit.length) hit.forEach(m => mark(m, why)); else issues.push({ kind: 'unplaced', courseKey, course: code, text: it.text, reason: `no ${code} class on ${shortIso(it.date)}`, page, title, line: it.source.line }) }
    else if (scopeWeeks.length === 1) { for (const m of mine) if (inScope(m) && kindOk(m)) mark(m, why) }
    else issues.push({ kind: 'unplaced', courseKey, course: code, text: it.text, reason: 'could not tell which class', page, title, line: it.source.line })
  }
  // topics and announced times
  for (const a of parsed.anchors) {
    const t = parsed.topics.find(x => x.date === a.date)
    const hit = pickMeeting(mine, a.date, t?.text)
    if (!hit) continue
    if (t && !hit.cancelled) hit.topic = { text: t.text, source: 'announcement', page }
    if (a.start || a.where) hit.announced = { start: a.start, end: a.end, where: a.where, page, date: a.date }
  }
  for (const it of parsed.items) {
    if (it.kind === 'cancel') continue
    if (it.kind === 'due' && it.date) {
      const before = mine.filter(m => !m.cancelled && m.date <= it.date && (!since || m.date >= since)).sort((a, b) => a.date.localeCompare(b.date))
      const hit = before[before.length - 1] || mine.filter(m => !m.cancelled && m.date <= it.date).pop()
      if (hit) put(hit, it); else issues.push({ kind: 'unplaced', courseKey, course: code, text: it.text, reason: `no ${code} class before ${shortIso(it.date)}`, page, title, line: it.source.line })
      continue
    }
    if (it.date) {
      const hit = pickMeeting(mine, it.date, parsed.topics.find(x => x.date === it.date)?.text)
      // An announcement posted after a class cannot ask you to prepare for it (SPEC §20.21). Say so instead of
      // quietly putting homework on a lecture that is already over.
      if (hit && since && hit.date < since) {
        issues.push({ kind: 'unplaced', courseKey, course: code, text: it.text, reason: `the ${code} class on ${shortIso(hit.date)} had already happened when this was posted on ${shortIso(since)}`, page, title, line: it.source.line })
        continue
      }
      if (hit) put(hit, it); else issues.push({ kind: 'unplaced', courseKey, course: code, text: it.text, reason: `no ${code} class on ${shortIso(it.date)}`, page, title, line: it.source.line })
      continue
    }
    const cands = mine.filter(m => inScope(m) && !m.cancelled && (!since || m.date >= since))
    if (cands.length === 1) put(cands[0], it)
    else issues.push({ kind: 'unplaced', courseKey, course: code, text: it.text, reason: cands.length ? 'could not tell which class' : 'no class in the weeks it concerns', page, title, line: it.source.line })
  }
  return { placed, issues }
}
function pickMeeting(mine, date, topic) {
  const same = mine.filter(m => m.date === date)
  if (!same.length) return null
  const want = /tutorial/i.test(topic || '') ? 'Tutorial' : /lecture/i.test(topic || '') ? 'Lecture' : null
  return same.find(m => want && m.kind === want) || same.find(m => !m.cancelled) || same[0]
}

// ---- 3. what a meeting wants done before it ---------------------------------------------------------------------------
const groupRefs = refs => {
  const by = new Map()
  for (const r of refs) {
    const m = /^(Ch \d+) #(.+)$/.exec(r.label), ex = /^Ex (.+)$/.exec(r.label), pb = /^Problem (.+)$/.exec(r.label)
    const k = m ? m[1] : ex ? 'Ex' : 'Problems', v = m ? m[2] : ex ? ex[1] : pb ? pb[1] : r.label
    if (!by.has(k)) by.set(k, []); by.get(k).push(v)
  }
  return [...by].map(([k, vs]) => (k === 'Ex' ? `Ex ${vs.join(', ')}` : k === 'Problems' ? `Problems ${vs.join(', ')}` : `${k} #${vs.join(', ')}`)).join(' · ')
}

// What a task is, read back out of its own text (SPEC §20.21). The Plan page is the truth and it stores plain
// markdown, so these have to survive a round trip through a `- [ ] …` line rather than living in a side table.
//   (optional) …            → you may skip it
//   … in tutorial / in class → it happens there; there is nothing to do beforehand
//   … opens/available <date> → it is not open yet
export const OPTIONAL_RE = /\b(optional|recommended|not (?:required|graded|marked)|extra practice|ungraded|for practice|if you (?:have time|want|like))\b/i
const IN_CLASS_RE = /\bin (?:the )?(tutorial|class|lecture|lab)\b/i
const NOT_OPEN_RE = /\b(?:opens?|available|posted|released)\s+(?:on\s+)?(\w+ \d{1,2}|\d{4}-\d{2}-\d{2})|\b(?:not (?:yet )?(?:open|available|posted|released)|will be (?:posted|released|available))\b/i
export function taskNature(text) {
  const t = String(text || '')
  return {
    optional: /^\(optional\)/i.test(t) || OPTIONAL_RE.test(t),
    inClass: IN_CLASS_RE.test(t),
    notOpen: NOT_OPEN_RE.test(t),
  }
}
// tasksFor(meeting, ctx) → [{ text, kind, refs?, tick? }] in canonical order: quiz, read, problems, review, bring, due.
// ctx: { items, entry (syllabus week entry), problemsWeek, topicPage (title|null), sheet ({ title, date }|null), deck ({ title, date }|null),
//        prevDate (the course's previous non-cancelled meeting date|null), firstOfWeek (bool), problemsRows: Map key→attempted }
export function tasksFor(m, ctx) {
  const out = [], seen = new Set()
  const add = t => {
    // `optional` is written into the sentence, because the Plan page stores sentences (SPEC §20.21).
    if (t.optional && !/^\(optional\)/i.test(t.text)) t = { ...t, text: `(optional) ${t.text}` }
    const k = taskKey(t.text); if (!k || seen.has(k)) return; seen.add(k); out.push(t)
  }
  const optionalIn = it => OPTIONAL_RE.test(String(it?.text || ''))
  const entry = ctx.entry || null, book = textbookName(m.courseKey), items = ctx.items || []
  const problemsLink = ctx.problemsWeek ? `[[${ctx.problemsWeek.label}/Problems]]` : null
  if (m.kind === 'Tutorial' && entry?.tutorial && /checkpoint/i.test(entry.tutorial)) add({ kind: 'quiz', text: `Checkpoint quiz in tutorial — ${entry.topic || 'this week'}` })
  if (ctx.firstOfWeek && entry?.chapters && !/^test\b/i.test(entry.topic || '') && !/^no class/i.test(entry.topic || '')) add({ kind: 'read', text: `Read ${book} ${entry.chapters}` })
  if (m.kind === 'Lecture' && ctx.topicPage && m.week) add({ kind: 'read', text: `Read the topic page [[${m.week.label}/${ctx.topicPage}]]` })
  for (const it of items.filter(i => i.kind === 'read' && i.confidence === 'exact')) {
    if (it.chapters?.length) add({ kind: 'read', optional: optionalIn(it), text: `Read ${book} Ch ${it.chapters.join(', ')}` })
    else if (it.title) add({ kind: 'read', optional: optionalIn(it), text: `Read “${it.title}”${it.link ? ` (${it.link.text})` : ''} — [[${it.source.title}]]` })
  }
  for (const it of items.filter(i => i.kind === 'read' && i.confidence === 'inferred')) if (it.chapters?.length) add({ kind: 'read', text: `Read ${book} Ch ${it.chapters.join(', ')} — ${longDay[weekdayOf(m.date)]}'s ${m.kind.toLowerCase()} is on it` })
  const refs = items.filter(i => i.kind === 'problems').flatMap(i => i.refs)
  if (refs.length) {
    const all = refs.every(r => ctx.problemsRows?.get(keyOf(r.label)) === true)
    add({ kind: 'problems', optional: items.filter(i => i.kind === 'problems').every(optionalIn), text: `${m.kind === 'Tutorial' ? 'Tutorial problems' : 'Problems'}: ${groupRefs(refs)}${problemsLink ? ` → ${problemsLink}` : ''}`, refs: refs.map(r => r.label), tick: all })
  }
  if (ctx.firstOfWeek && entry?.problems) { const set = String(entry.problems).trim(); add({ kind: 'problems', text: `WebAssign ${set}${problemsLink ? ` → ${problemsLink}` : ''}`, refs: [set], tick: ctx.problemsRows?.get(keyOf(set)) === true }) }
  if (ctx.sheet && ctx.sheet.date < m.date && (!ctx.prevDate || ctx.sheet.date >= ctx.prevDate)) add({ kind: 'review', text: `Review [[Study sheets/${ctx.sheet.title}]]` })
  else if (ctx.deck && ctx.deck.date < m.date && (!ctx.prevDate || ctx.deck.date >= ctx.prevDate)) add({ kind: 'review', text: `Review last week's slides → [[Lectures/${ctx.deck.title}]]` })
  for (const it of items.filter(i => i.kind === 'bring')) add({ kind: 'bring', text: `Bring: ${it.text}` })
  for (const it of items.filter(i => i.kind === 'due')) add({ kind: 'due', text: `Due ${weekdayOf(it.date)} ${shortIso(it.date)}: ${shorten(it.text.replace(/\s*\(.*?\)\s*/g, ' '), 80)}` })
  return out
}

// ---- 3b. a week's own work: a course with no classes (SPEC §20.35) -------------------------------------------------------
// Every task above hangs on a meeting, so an online course — lectures recorded, readings posted — had nowhere to hang
// one, and nothing it asked for became a task: "please read Hesiod's Theogony" sat on a Quercus page, "for next week,
// please read" on another, and the lectures were videos filed under Lectures/. A week of such a course carries its own
// work, written to the week's Plan page under one group and ticked like any other task: the readings its own pages ask
// for, the readings a rolling "Next Week's Reading" page lists (filed in the week after the page last changed), the
// recorded lectures to watch, and the weekly work terms.mjs declares (`weekly`) unless Quercus already lists it that week.
export const VIDEO_RE = /https?:\/\/(?:play\.library\.utoronto\.ca|mymedia\.library\.utoronto\.ca|(?:www\.)?youtube\.com|youtu\.be|vimeo\.com|[\w.-]*zoom\.us\/rec)\S*/i
export const weekGroupLabel = w => `Week ${w.n} · the week's work`
const stripMd = s => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()
const tidyReading = s => String(s).replace(/\s*\((?:pdf|link|attached|below|above)[^)]*\)/gi, '').replace(/\s+from\s+(lines?|pages?|pp\.?)\s+/i, ', $1 ')
  .replace(/(\d)\s*-\s*(\d)/g, '$1–$2').replace(/\s+,/g, ',').replace(/[\s.;:]+$/, '').replace(/\s+/g, ' ').trim()
const lowerArticle = s => String(s).replace(/^(The|A|An)\b/, m => m.toLowerCase())
const READ_LEAD = /(?:\bplease\s+(?:re-?)?read\b|^\s*(?:re-?)?read\b|\b(?:re-?)?read\s*:|\bweek,?\s+(?:please\s+)?(?:re-?)?read\b)\s*:?\s*(.*)$/i
// readingsIn(text) → what a page asks to be read: the rest of a "please read …" sentence, or the numbered or bulleted
// items under a "please read:" line. Markdown emphasis and links are dropped; "from lines 1-453" reads "lines 1–453".
// "You can read the English translation alongside" is not a reading: only a request counts.
export function readingsIn(text) {
  const lines = String(text || '').split('\n'), out = []
  for (let i = 0; i < lines.length; i++) {
    const m = READ_LEAD.exec(lines[i]); if (!m) continue
    const rest = tidyReading(stripMd(m[1].split(/(?<=[.!?])\s+(?=[A-Z])/)[0]))
    if (rest.length > 2 && !/^(?:the following|these|this|below)\b/i.test(rest)) { out.push(rest); continue }
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue
      const item = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(lines[j]); if (!item) break
      const r = tidyReading(stripMd(item[1])); if (r) out.push(r)
    }
  }
  return [...new Set(out)]
}
const tidyLecture = t => String(t).replace(/^(lecture\s*\d+)\s*[-–—:]\s*/i, '$1: ')
const DAY_OFFSET = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
const time12 = hm => { const [h, m] = String(hm).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}` }
// weekWorkFor(courseKey, info, week, { weekPages, generalPages, lectures, hub }) → [{ text, kind, due?, dueTime? }]
// weekPages: { [courseKey]: { [weekN]: [{ title, body, at }] } } — the Quercus pages filed directly in a week's folder;
// generalPages: { [courseKey]: [{ title, body, at }] } — General pages whose title mentions reading; `at` is the date
// Quercus says the page was updated; lectures: { [courseKey]: { [weekN]: [{ title, date, video }] } }.
export function weekWorkFor(courseKey, info, w, { weekPages = {}, generalPages = {}, lectures = {}, hub = null } = {}) {
  const out = [], seen = new Set()
  const add = t => { const k = taskKey(t.text); if (!k || seen.has(k)) return; seen.add(k); out.push(t) }
  const lecs = lectures[courseKey]?.[w.n] || [], here = weekPages[courseKey]?.[w.n] || []
  const norm = s => fold(stripMd(s))
  // A reading that names a document filed in the week links to that document; otherwise to the page that asked for it.
  const linkFor = (reading, fallback) => {
    const r = norm(reading)
    const lec = lecs.find(l => norm(l.title).length > 3 && r.includes(norm(l.title))); if (lec) return `[[Lectures/${lec.title}]]`
    const pg = here.find(p => norm(p.title).length > 3 && r.includes(norm(p.title))); if (pg) return `[[${w.label}/${pg.title}]]`
    return fallback
  }
  for (const p of here) for (const r of readingsIn(p.body)) add({ kind: 'read', text: `Read ${lowerArticle(r)} → ${linkFor(r, `[[${w.label}/${p.title}]]`)}` })
  for (const p of generalPages[courseKey] || []) {
    if (!/\bnext\s+week/i.test(p.title) || !p.at) continue
    const posted = weekFor(info.term, p.at); if (!posted || posted.n + 1 !== w.n) continue
    for (const r of readingsIn(p.body)) add({ kind: 'read', text: `Read ${lowerArticle(r)} → ${linkFor(r, `[[${p.title}]]`)}` })
  }
  for (const l of lecs.filter(x => x.video)) add({ kind: 'watch', text: `Watch ${tidyLecture(l.title)} → [[Lectures/${l.title}]]` })
  for (const x of info.weekly || []) {
    if (w.n < (x.from || 1) || (x.to && w.n > x.to)) continue
    const due = addDays(w.monday, DAY_OFFSET[x.day] ?? 6), sun = addDays(w.monday, 6)
    const re = new RegExp(x.match || x.kind || x.text, 'i')
    const listed = (hub?.deadlines || []).some(d => { const iso = d.dueDate || localParts(d.due).date || ''; return d.courseKey === courseKey && re.test(String(d.title || '')) && iso >= w.monday && iso <= sun })
    if (!listed) add({ kind: x.kind || 'other', due, dueTime: x.time || null, text: `${x.text} — due ${weekdayOf(due)} ${shortIso(due)}${x.time ? `, ${time12(x.time)}` : ''}` })
  }
  return out
}
const kindOfText = s => (/^read\b/i.test(s) ? 'read' : /^watch\b/i.test(s) ? 'watch' : /participation/i.test(s) ? 'participation' : 'other')

// ---- 3c. what Claude decided (SPEC §20.37) --------------------------------------------------------------------------------
// With Claude as the brain (Hub/_settings.json), a class's tasks and a week's work are the tasks Claude put there through
// scripts/brain.mjs — not what the grammar read out of an announcement or the outline listed. The line is Claude's words and,
// when it named one, where to go; the level, reason, link and source ride along to the rows (src/todo.js). The words before
// ` → ` are the task's key, so a link can change without the line losing its tick.
const linkText = link => (/^https?:\/\//.test(link) ? link : `[[${String(link).split('/').pop().replace(/\.md$/, '')}]]`)
export const claudeLine = t => `${t.what}${t.link ? ` → ${linkText(t.link)}` : ''}`
export function claudeTasks(brain, { courseKey, meeting = null, week = null }) {
  return Object.values(brain?.tasks || {})
    .filter(t => t && !t.withdrawn && t.courseKey === courseKey && (meeting
      ? t.attach?.class?.date === meeting.date && t.attach.class.kind === meeting.kind
      : !!week && t.attach?.week === week.n))
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .map(t => ({ text: claudeLine(t), kind: t.kind || 'other', due: t.due || null, dueTime: t.dueTime || null,
      claude: { id: t.id, level: t.level || 'normal', reason: t.reason || null, link: t.link || null, source: t.source || null, graded: t.graded ?? null, done: t.done || null,
        // How long it takes the student, his share of the mark, whether it must be done in one sitting: the day (SPEC §22) and the
        // task sheet read these off the row, so a task that loses them is packed at the kind's default instead. `minutes: 0`
        // means it happens in the room and must survive as 0, so these are `??`, never `||`.
        minutes: t.minutes ?? null, weight: t.weight ?? null, splittable: t.splittable ?? null } }))
}

// ---- 3d. what is already done (SPEC §20.69) --------------------------------------------------------------------------------
// the student does work where the work lives — the Quercus forum, the quiz, WebAssign — and then has to come back and tick it here
// too. The morning pass reads what those places already know and ticks the task for him, once, with the reason: Quercus has
// the hand-in or the grade, the forum has his post (or his reply, for a task that asks for one), the Problems page has the
// WebAssign set ticked, or Claude read the evidence somewhere code cannot and said so (`brain.mjs task done`).
export const normUrl = u => { const m = /^(https?:\/\/[^/?#\s]+)([^?#\s]*)/i.exec(String(u || '').trim()); return m ? m[1].toLowerCase() + m[2].replace(/\/+$/, '') : null }
export const taskLink = t => t?.claude?.link || / → (https?:\/\/\S+)/.exec(String(t?.text || ''))?.[1] || null
export const taskWords = text => String(text || '').replace(/ · no longer listed\s*$/, '').split(' → ')[0]
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// `name` as a whole word of `text`, hyphens included: "Fall-Ex2" is in "WebAssign Fall-Ex2 - up to three attempts", not in "Fall-Ex21".
export const mentions = (text, name) => { const n = String(name || '').trim(); return !!n && new RegExp(`(?:^|[^\\w-])${escRe(n)}(?![\\w-])`, 'i').test(String(text || '')) }
const REPLY_RE = /\brepl(?:y|ies|ying)\b/i
// A task found by the title of what was handed in, not its link, must itself be the hand-in: "Sit Quiz 1" is, "Revise
// before Quiz 1 opens" is not. And the title must carry a number, so "Participation" never matches every participation task.
const HAND_IN_KINDS = new Set(['quiz', 'due', 'participation', 'write'])
const onDay = stamp => { const d = localParts(stamp).date; return d ? `${weekdayOf(d)} ${shortIso(d)}` : null }
// doneEvidence(task, { handedIn, sets }) → { why, by: 'claude' | 'quercus' | 'problems' } or null.
// handedIn: the course's Hub/_hub.json → handedIn rows (scripts/quercus-sync.mjs); sets: [{ set, week, done }] (the WebAssign
// sets of the outline and whether their Problems row is ticked).
export function doneEvidence(task, { handedIn = [], sets = [] } = {}) {
  if (task?.claude?.done) return { why: `Claude: ${task.claude.done.reason || 'done'}`, by: 'claude' }
  const link = normUrl(taskLink(task)), words = taskWords(task?.text)
  for (const h of handedIn || []) {
    const byLink = !!link && (h.urls || []).some(u => normUrl(u) === link)
    if (h.kind === 'discussion') {
      if (!byLink) continue
      const reply = REPLY_RE.test(words), at = reply ? h.posted?.reply : h.posted?.initial
      if (at) return { why: `${reply ? 'your reply' : 'your post'} is on the Quercus forum (${onDay(at)})`, by: 'quercus' }
      continue
    }
    const byName = !byLink && /\d/.test(h.title || '') && (HAND_IN_KINDS.has(task?.kind) || task?.claude?.graded === true) && mentions(words, h.title)
    if (!byLink && !byName) continue
    return { why: h.score != null ? `Quercus has it graded${h.points ? `: ${h.score}/${h.points}` : ''}` : h.submittedAt ? `handed in on Quercus ${onDay(h.submittedAt)}` : h.excused ? 'excused on Quercus' : 'handed in on Quercus', by: 'quercus' }
  }
  for (const s of sets || []) if (s.done && mentions(words, s.set)) return { why: `${s.set} is ticked on the ${s.week || 'week'}'s Problems page`, by: 'problems' }
  return null
}

// ---- 4. the Plan page: parse, render, merge (SPEC §20.3, §20.4) ------------------------------------------------------
// parsePlanBlock(md) → { intro:[lines], groups:[{ label, key, start, end, tasks:[{ line, text, done, key, stale }] }], lines }
// The intro is everything before the first `### ` line (the `## Before class` heading and any lines of the student's).
export function parsePlanBlock(md) {
  const lines = String(md || '').split('\n')
  const groups = []
  let cur = null
  const intro = []
  lines.forEach((l, i) => {
    const g = GROUP_LINE.exec(l)
    if (g) { cur = { label: g[1].trim(), key: groupKey(g[1]), start: i, end: lines.length, tasks: [] }; groups.push(cur); return }
    if (!cur) { intro.push(l); return }
    const t = TASK_LINE.exec(l)
    if (t) cur.tasks.push({ line: i, text: t[2], done: t[1] !== ' ', key: taskKey(t[2]), stale: / · no longer listed\s*$/.test(t[2]) })
  })
  groups.forEach((g, i) => { g.end = groups[i + 1] ? groups[i + 1].start : lines.length })
  return { intro, groups, lines }
}
// Every depth-0 task of the container with its group: [{ group, groupKey, text, key, done, stale, line }].
export const planTasks = md => { const p = parsePlanBlock(md); return p.groups.flatMap(g => g.tasks.map(t => ({ group: g.label, groupKey: g.key, ...t }))) }
const renderTask = (t, done = false) => `- [${done ? 'x' : ' '}] ${t.text}`
export const renderGroup = g => [`### ${g.label}`, '', ...g.tasks.map(t => renderTask(t, !!t.tick))].join('\n')
// A fresh container.
export const renderContainer = groups => [PLAN_HEADING, '', ...groups.map(renderGroup).join('\n\n').split('\n')].join('\n')
// mergeContainer(oldMd, groups:[{ label, tasks:[{ text, kind, tick? }] }], prev:{ [groupKey]: [taskKeys] }) → { md, generated }
// Append-only: no line is moved or deleted. A generated task keeps its line (and its tick) when its key is present; a
// missing one is appended after the group's last line; a group not on the page is appended at the end. A task the
// script generated last time (prev) and does not generate now is suffixed ` · no longer listed` when unticked; the
// suffix is removed when it comes back. A `tick: true` task is ticked (never unticked). the student's own lines are untouched.
// An `auto: { why }` task (SPEC §20.69) is ticked once: `autoPrev` ({ 'groupKey|taskKey': … }, the page's memory in
// _plan-state.json) holds the lines already ticked that way, and one the student has unticked since stays as he left it. The ticks
// made now come back as `ticked: [{ group, key, text, why }]`.
export function mergeContainer(oldMd, groups, prev = {}, autoPrev = {}) {
  const base = String(oldMd || '').trim() ? String(oldMd || '') : PLAN_HEADING
  const p = parsePlanBlock(base)
  const lines = [...p.lines]
  const inserts = new Map()   // line index → lines to insert after it
  const generated = {}, ticked = []
  const after = (i, ls) => { if (!inserts.has(i)) inserts.set(i, []); inserts.get(i).push(...ls) }
  const autoTick = (gk, label, t) => { if (!t.auto || autoPrev?.[`${gk}|${t.key}`]) return false; ticked.push({ group: label, key: t.key, text: t.text, why: t.auto.why || null }); return true }
  for (const g of p.groups) {
    const spec = groups.find(s => groupKey(s.label) === g.key)
    const prevKeys = new Set(prev?.[g.key] || [])
    const now = spec ? spec.tasks.map(t => ({ ...t, key: taskKey(t.text) })) : []
    const nowKeys = new Set(now.map(t => t.key))
    for (const t of g.tasks) {
      const s = now.find(x => x.key === t.key)
      let text = t.text, done = t.done
      if (s) {
        if (t.stale) text = text.replace(/ · no longer listed\s*$/, '')
        // A line Claude generated follows Claude's current line (SPEC §20.52). The key — the words before the arrow — is
        // what its tick is stored under, so the arrow can change without the line losing it; a link whose page was since
        // retitled, or a due date Quercus corrected, must not stay on the page as it was first written. A line the rules
        // wrote, or one of the student's, is left as it is.
        if (s.claude && s.text !== text) text = s.text
        if (s.tick && !done) done = true
        else if (!done && autoTick(g.key, g.label, { ...s, text })) done = true
      }
      else if (prevKeys.has(t.key) && !t.done && !t.stale) text = text + STALE
      if (text !== t.text || done !== t.done) lines[t.line] = `- [${done ? 'x' : ' '}] ${text}`
    }
    const missing = now.filter(t => !g.tasks.some(x => x.key === t.key))
    if (missing.length) {
      // after the group's last task (the list grows), else right under the heading (keeping the blank line the editor writes)
      const rendered = missing.map(t => renderTask(t, !!t.tick || autoTick(g.key, g.label, t)))
      if (g.tasks.length) after(g.tasks[g.tasks.length - 1].line, rendered)
      else if (lines[g.start + 1] !== undefined && lines[g.start + 1].trim() === '' && g.start + 1 < g.end) after(g.start + 1, rendered)
      else after(g.start, ['', ...rendered])
    }
    // memory: what is generated now, plus what was generated before and is still a line on the page (so a task can be
    // marked the day the student unticks it, or cleaned the day it comes back); a group without a spec keeps its memory
    if (spec) generated[g.key] = [...new Set([...nowKeys, ...[...prevKeys].filter(k => g.tasks.some(t => t.key === k))])]
    else if (prevKeys.size) generated[g.key] = [...prevKeys]
  }
  const out = []
  lines.forEach((l, i) => { out.push(l); if (inserts.has(i)) out.push(...inserts.get(i)) })
  for (const s of groups) {
    const k = groupKey(s.label)
    if (p.groups.some(g => g.key === k) || !s.tasks.length) continue
    while (out.length && out[out.length - 1].trim() === '') out.pop()
    out.push('', ...renderGroup({ label: s.label, tasks: s.tasks.map(t => ({ ...t, tick: !!t.tick || autoTick(k, s.label, { ...t, key: taskKey(t.text) }) })) }).split('\n'))   // a blank line before the heading and after it, the shape the editor writes
    generated[k] = s.tasks.map(t => taskKey(t.text))
  }
  const md = out.join('\n').replace(/\s+$/, '')
  return { md, generated, ticked }
}
// flipTask(md, key, to) → md with the first depth-0 task whose taskKey is `key` flipped, or null when absent. With `to`
// (true: ticked, false: not) it is set rather than flipped — md unchanged when it already stands so: the timer's Done
// must never untick a task he ticked while the clock ran.
export function flipTask(md, key, to = null) {
  const lines = String(md || '').split('\n')
  const i = lines.findIndex(l => { const t = TASK_LINE.exec(l); return t && taskKey(t[2]) === key })
  if (i < 0) return null
  const t = TASK_LINE.exec(lines[i])
  if (to !== null && (t[1] !== ' ') === !!to) return String(md || '')
  lines[i] = `- [${t[1] === ' ' ? 'x' : ' '}] ${t[2]}`
  return lines.join('\n')
}
// findPlanBlock(blocks, blockId) → the index of the `## Before class` container (by id, then by heading), else -1.
export function findPlanBlock(blocks, blockId) {
  const list = Array.isArray(blocks) ? blocks : []
  if (blockId) { const i = list.findIndex(b => b?.id === blockId); if (i >= 0) return i }
  return list.findIndex(b => firstLine(b?.md) === PLAN_HEADING)
}
// The header block (block 0) of a Plan page: title, meta line, and the announcement sentences the week's tasks came from.
export function renderPlanHeader({ courseKey, week, quotes = [], unplaced = [] }) {
  const w = week, span = w.span || ''
  const parts = [`# Plan · ${w.label}`, `*${codeOf(courseKey)} · ${span} · rebuilt by the morning pass; tick and add lines under Before class freely*`]   // *italic*: the marker the editor writes back
  if (quotes.length || unplaced.length) {
    const ls = ['## From announcements', '']
    for (const q of quotes) ls.push(`- [[${q.title}]] — “${q.text}”`)
    for (const u of unplaced) ls.push(`- Unplaced: “${u.text}” — [[${u.title}]]`)
    parts.push(ls.join('\n'))
  }
  return parts.join('\n\n')
}

// ---- 5. coverage (SPEC §20.3): three counts, no percentage ---------------------------------------------------------------
// coverageCounts({ window, today, material:Set<weekN>, sheets:Set<weekN>, problems:{ [weekN]:{ attempted, assigned } }, tasks:{ [weekN]:{ done, total } } })
// → { sheets:{ done, total }, problems:{ done, total }|null, tasks:{ done, total }|null, elapsedWeeks, totalWeeks }
// sheets: weeks of the window that have material in the notebook (a deck, a recording or a Quercus topic page) and a study
// sheet, over such weeks with material; problems attempted over assigned on the window's Problems pages; plan tasks ticked
// over total on the window's Plan pages. Null when there is nothing to count. Elapsed = weeks whose Monday is on or before today.
export function coverageCounts({ window, today, material = new Set(), sheets = new Set(), problems = {}, tasks = {}, term = 'Y' } = {}) {
  const win = window?.weeks || []
  const all = weeks(term)
  const elapsed = win.filter(n => { const w = all.find(x => x.n === n); return w && w.monday <= today }).length
  const withMaterial = win.filter(n => material.has(n))
  const s = { done: withMaterial.filter(n => sheets.has(n)).length, total: withMaterial.length }
  const p = win.reduce((a, n) => ({ done: a.done + (problems[n]?.attempted || 0), total: a.total + (problems[n]?.assigned || 0) }), { done: 0, total: 0 })
  const t = win.reduce((a, n) => ({ done: a.done + (tasks[n]?.done || 0), total: a.total + (tasks[n]?.total || 0) }), { done: 0, total: 0 })
  return { sheets: s, problems: p.total ? p : null, tasks: t.total ? t : null, elapsedWeeks: elapsed, totalWeeks: win.length }
}
// The one-line form Home shows under a course card: `Midterm 1 · in 34 days · sheets 1/1 · problems 0/4`.
export function coverageLine(test, today) {
  if (!test) return null
  const n = daysTo(test.date, today), c = test.coverage || {}
  const bits = [test.title, n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? `${-n} days ago` : `in ${n} days`]
  const parts = []
  if (ED.sheets && c.sheets?.total) parts.push(`sheets ${c.sheets.done}/${c.sheets.total}`)   // never in an edition with no sheets: it would read `sheets 0/6` for ever
  if (c.problems) parts.push(`problems ${c.problems.done}/${c.problems.total}`)
  if (c.tasks) parts.push(`tasks ${c.tasks.done}/${c.tasks.total}`)
  return [...bits, ...(parts.length ? parts : ['no signals yet'])].join(' · ')
}

// ---- 6. buildPlan: everything in one pass --------------------------------------------------------------------------------
// inputs: { today, days, announcements:[{ courseKey, page, title, postedAt, body, concerns:[labels] }], hub, calendar,
//           sheets:[{ courseKey, date, week, session, page, title }], planPages:{ [rel]:{ blocks, hash } },
//           problemsPages:{ [rel]:{ blocks, blockId } }, topicPages:{ [courseKey]:{ [weekN]:[titles] } },
//           lectures:{ [courseKey]:{ [weekN]:[{ title, date }] } }, recordings:{ [courseKey]:{ [weekN]:[titles] } },
//           sheetPages:{ [courseKey]:{ [weekN]:[titles] } }, state:{ pages:{ [rel]:{ generated, blockId, headerHash } } } }
// → { plan, pageSpecs:[{ path, courseKey, week, header, groups, quotes, unplaced }] }
// The start of the term that has begun most recently — the plan looks back to it (SPEC §20.54).
export const termStart = today => { const starts = Object.values(TERMS).map(t => t.start).sort(); return starts.filter(s => s <= today).pop() || starts[0] }
export function buildPlan(inputs) {
  const { today, days = HORIZON_DAYS, announcements = [], hub = null, calendar = null, sheets = [], planPages = {}, problemsPages = {}, topicPages = {}, lectures = {}, recordings = {}, sheetPages = {}, state = { pages: {} } } = inputs
  const from = today, to = addDays(today, days - 1)
  // The window looks back as well as ahead (SPEC §20.54): a class or a week whose day has passed still holds what was not
  // done, and that stays on To do, at its own level, until it is ticked — however far back, to the start of the term.
  // `from`/`days` still bound the days board and Next 7 days; `since` bounds the meetings and the weeks' work.
  const since = inputs.since || termStart(today)
  const all = expandMeetings(since < addDays(today, -21) ? since : addDays(today, -21), to)
  // Claude as the brain (SPEC §20.37): no grammar reads the announcements and no outline hands out tasks; Claude's word on
  // a class — cancelled, or what it is about — lands on the meeting. A class the calendar already cancels stays cancelled.
  const brain = inputs.brain?.enabled ? inputs.brain : null
  if (brain) for (const [id, c] of Object.entries(brain.classes || {})) {
    const m = all.find(x => x.id === id); if (!m || !c) continue
    if (c.cancel && !m.cancelled) m.cancelled = c.cancel
    if (c.topic) m.topic = { text: c.topic, source: 'claude', page: null }
  }
  // announcements → placement
  const placed = new Map(), issues = [], quotesByWeek = new Map()
  const recent = addDays(today, -21)
  for (const a of brain ? [] : announcements) {
    const parsed = parseAnnouncement(a)
    const ahead = parsed.anchors.some(x => x.date >= today) || parsed.items.some(x => x.date && x.date >= today)
    if (String(a.postedAt || '').slice(0, 10) < recent && !ahead) continue
    const r = placeItems(all, parsed, { courseKey: a.courseKey, postedAt: a.postedAt, concernsWeeks: a.concerns || [], title: a.title, page: a.page })
    for (const [id, items] of r.placed) { if (!placed.has(id)) placed.set(id, []); placed.get(id).push(...items) }
    issues.push(...r.issues)
    for (const an of parsed.anchors) {
      const m = all.find(x => x.courseKey === a.courseKey && x.date === an.date)
      if (!m?.week) continue
      const k = `${a.courseKey}|${m.week.n}`
      if (!quotesByWeek.has(k)) quotesByWeek.set(k, [])
      if (!quotesByWeek.get(k).some(q => q.text === an.raw)) quotesByWeek.get(k).push({ title: a.title, text: an.raw, date: an.date })
    }
  }
  const info = k => COURSES[k]
  const problemsRowsOf = rel => { const pg = problemsPages[rel]; if (!pg) return null; const s = summarizeBlocks(pg.blocks, pg.blockId); return { rows: new Map(s.rows.map(r => [r.key, r.attempted])), counts: s.counts, blockId: s.blockId } }
  const weekOf = (courseKey, n) => weeks(info(courseKey)?.term || 'Y').find(w => w.n === n) || null
  // What is already done, per course (SPEC §20.69): Quercus's hand-ins, grades and forum posts, and the WebAssign sets whose
  // Problems row is ticked. A generated task that is one of them carries `auto` to the merge, which ticks it once.
  const evidence = new Map()
  const evidenceOf = courseKey => {
    if (evidence.has(courseKey)) return evidence.get(courseKey)
    const sets = SYLLABUS[courseKey]?.webassign ? Object.entries(SYLLABUS[courseKey].weeks || {}).map(([n, wk]) => [weekOf(courseKey, Number(n)), String(wk?.problems || '').trim()]).filter(([w, set]) => w && set)
      .map(([w, set]) => ({ set, week: w.label, done: problemsRowsOf(problemsPageRel(courseKey, w))?.rows.get(keyOf(set)) === true })) : []
    const ev = { handedIn: (hub?.handedIn || []).filter(h => h.courseKey === courseKey), sets }
    evidence.set(courseKey, ev)
    return ev
  }
  const withEvidence = (courseKey, list) => { for (const t of list) { const ev = doneEvidence(t, evidenceOf(courseKey)); if (ev) t.auto = ev } return list }
  // A line the morning pass ticked says why on its row (the task sheet shows it); one the student ticked himself carries nothing.
  const autoOf = (rel, gk, t) => (t.done ? state.pages?.[rel]?.auto?.[`${gk}|${t.key}`] || null : null)
  const sheetBefore = (courseKey, date) => sheets.filter(s => s.courseKey === courseKey && s.date < date).sort((a, b) => a.date.localeCompare(b.date)).pop() || null
  const deckBefore = (courseKey, date) => Object.values(lectures[courseKey] || {}).flat().filter(d => d.date && d.date < date).sort((a, b) => a.date.localeCompare(b.date)).pop() || null
  // meetings in the horizon, with their generated tasks
  const horizon = all.filter(m => m.date >= since && m.date <= to)
  const specsByWeek = new Map()   // `${courseKey}|${n}` → { courseKey, week, groups: [{ meeting, label, tasks }] }
  const meetings = horizon.map(m => {
    const entry = m.week ? SYLLABUS[m.courseKey]?.weeks?.[syllabusWeekN(m.courseKey, m.kind, m.week.n)] || null : null
    const sw = m.week ? syllabusWeekN(m.courseKey, m.kind, m.week.n) : null
    const problemsWeek = sw != null ? weekOf(m.courseKey, sw) : null
    const problemsRel = problemsWeek ? problemsPageRel(m.courseKey, problemsWeek) : null
    const pr = problemsRel ? problemsRowsOf(problemsRel) : null
    const prev = all.filter(x => x.courseKey === m.courseKey && !x.cancelled && x.date < m.date).pop() || null
    const firstOfWeek = !m.cancelled && !all.some(x => x.courseKey === m.courseKey && !x.cancelled && x.week?.n === m.week?.n && x.date < m.date)
    const sheet = sheetBefore(m.courseKey, m.date), deck = deckBefore(m.courseKey, m.date)
    const items = placed.get(m.id) || []
    const generated = withEvidence(m.courseKey, m.cancelled ? [] : brain ? claudeTasks(brain, { courseKey: m.courseKey, meeting: m }) : tasksFor(m, { items, entry, problemsWeek, topicPage: m.week ? (topicPages[m.courseKey]?.[m.week.n] || [])[0] || null : null, sheet, deck, prevDate: prev?.date || null, firstOfWeek, problemsRows: pr?.rows || null }))
    const planRel = m.week ? planPageRel(m.courseKey, m.week) : null
    if (m.week) {
      const k = `${m.courseKey}|${m.week.n}`
      if (!specsByWeek.has(k)) specsByWeek.set(k, { courseKey: m.courseKey, week: weekOf(m.courseKey, m.week.n) || m.week, groups: [] })   // the full week (span, monday), not the meeting's { n, label, dir }
      specsByWeek.get(k).groups.push({ meeting: m.id, label: meetingLabel(m), tasks: generated })
    }
    // tasks as the page has them (the student's lines included), else the generated ones as a preview
    const page = planRel ? planPages[planRel] : null
    let before = generated.map(t => ({ text: t.text, key: taskKey(t.text), done: false, kind: t.kind, generated: true, stale: false, pending: true, ...(t.claude ? { claude: t.claude } : {}) })), planBlock = null, tasks = null
    if (page) {
      const bi = findPlanBlock(page.blocks, state.pages?.[planRel]?.blockId)
      if (bi >= 0) {
        planBlock = page.blocks[bi].id || null
        const gen = new Set(state.pages?.[planRel]?.generated?.[groupKey(meetingLabel(m))] || [])
        const mine = planTasks(page.blocks[bi].md).filter(t => t.groupKey === groupKey(meetingLabel(m)))
        if (mine.length) {
          before = mine.map(t => { const g = generated.find(x => taskKey(x.text) === t.key), auto = autoOf(planRel, groupKey(meetingLabel(m)), t); return { text: t.text, key: t.key, done: t.done, kind: g?.kind || 'other', generated: gen.has(t.key) || !!g, stale: t.stale, pending: false, line: t.line, ...(g?.claude ? { claude: g.claude } : {}), ...(auto ? { auto } : {}) } })
          tasks = { done: before.filter(t => t.done).length, total: before.length }
        }
      }
    }
    const sources = [...new Set(items.map(i => i.source?.page).filter(Boolean))]
    return {
      id: m.id, courseKey: m.courseKey, course: m.course, color: m.color, date: m.date, day: m.day, start: m.start, end: m.end, where: m.where, kind: m.kind,
      week: m.week, topic: m.topic, announced: m.announced || null, cancelled: m.cancelled,
      planPage: page ? planRel : null, planBlock, tasks, before,
      problems: pr && pr.counts.assigned ? { done: pr.counts.attempted, total: pr.counts.assigned, page: problemsRel } : null,
      sources,
    }
  })
  // A week's own work, for a course with no classes (SPEC §20.35): one group on the week's Plan page, for the weeks the
  // horizon touches. `inputs.present` (when given) is the courses with a notebook: none gets a page it has no folder for.
  const weekWork = []
  for (const [courseKey, info] of Object.entries(COURSES)) {
    // with Claude as the brain every course has the group: a task Claude puts in a week rather than before one class
    if ((!brain && (info.meetings || []).length) || (inputs.present && !inputs.present.has(courseKey))) continue
    for (const w of weeks(info.term)) {
      const sun = addDays(w.monday, 6)
      if (w.monday > to || sun < since) continue
      const label = weekGroupLabel(w), gk = groupKey(label), rel = planPageRel(courseKey, w), page = planPages[rel]
      const generated = withEvidence(courseKey, brain ? claudeTasks(brain, { courseKey, week: w }) : weekWorkFor(courseKey, info, w, inputs))
      let work = generated.map(t => ({ text: t.text, key: taskKey(t.text), done: false, kind: t.kind, due: t.due || null, dueTime: t.dueTime || null, generated: true, stale: false, pending: true, ...(t.claude ? { claude: t.claude } : {}) })), planBlock = null, tasks = null
      if (page) {
        const bi = findPlanBlock(page.blocks, state.pages?.[rel]?.blockId)
        if (bi >= 0) {
          planBlock = page.blocks[bi].id || null
          const onPage = planTasks(page.blocks[bi].md).filter(t => t.groupKey === gk)
          // A task this group generated once stays generated: a rolling page like "Next Week's Reading" moves on to the
          // week after without withdrawing last week's readings, which must not turn "no longer listed".
          const gen = new Set(state.pages?.[rel]?.generated?.[gk] || [])
          if (!brain) for (const t of onPage) if (gen.has(t.key) && !generated.some(g => taskKey(g.text) === t.key)) generated.push({ text: t.text.replace(/ · no longer listed\s*$/, ''), kind: kindOfText(t.text), due: /participation/i.test(t.text) ? dateIn(t.text) : null })
          if (onPage.length) {
            work = onPage.map(t => { const g = generated.find(x => taskKey(x.text) === t.key), auto = autoOf(rel, gk, t); return { text: t.text, key: t.key, done: t.done, kind: g?.kind || kindOfText(t.text), due: g?.due || null, dueTime: g?.dueTime || null, generated: gen.has(t.key) || !!g, stale: t.stale, pending: false, line: t.line, ...(g?.claude ? { claude: g.claude } : {}), ...(auto ? { auto } : {}) } })
            tasks = { done: work.filter(t => t.done).length, total: work.length }
          }
        }
      }
      const k = `${courseKey}|${w.n}`
      if (!specsByWeek.has(k)) specsByWeek.set(k, { courseKey, week: w, groups: [] })
      specsByWeek.get(k).groups.push({ label, tasks: generated })
      weekWork.push({ id: `${courseKey}|${w.label}`, courseKey, course: codeOf(courseKey), color: info.color || null, week: { n: w.n, label: w.label, dir: w.dir, monday: w.monday, span: w.span },
        current: w.monday <= today && today <= sun, planPage: page ? rel : null, planBlock, tasks, work })
    }
  }
  // page specs, one per course-week that carries at least one generated task
  // a page is created only when the week carries a task; an existing page keeps being merged (header, stale marks) either way
  const pageSpecs = [...specsByWeek.values()].filter(s => s.groups.some(g => g.tasks.length) || planPages[planPageRel(s.courseKey, s.week)]).map(s => {
    const k = `${s.courseKey}|${s.week.n}`
    const quotes = (quotesByWeek.get(k) || []).sort((a, b) => a.date.localeCompare(b.date))
    const unplaced = issues.filter(i => i.courseKey === s.courseKey && i.kind === 'unplaced' && weekFor(info(s.courseKey)?.term || 'Y', dateIn(i.text) || '')?.n === s.week.n)
    return { path: planPageRel(s.courseKey, s.week), courseKey: s.courseKey, week: s.week, groups: s.groups.map(g => ({ label: g.label, tasks: g.tasks })), header: renderPlanHeader({ courseKey: s.courseKey, week: s.week, quotes, unplaced }), quotes, unplaced }
  })
  // deadlines: hub.deadlines (Quercus rows and the WebAssign rows problems.mjs adds), less a WebAssign set a Plan page of its
  // course has ticked (SPEC §20.69) — the task Claude put in another week names the same set, and the tick is the set done.
  const tickedLines = courseKey => Object.entries(planPages).filter(([rel]) => rel.startsWith(courseKey + '/')).flatMap(([rel, pg]) => {
    const bi = findPlanBlock(pg.blocks, state.pages?.[rel]?.blockId)
    return bi >= 0 ? planTasks(pg.blocks[bi].md).filter(t => t.done).map(t => taskWords(t.text)) : []
  })
  // A set a live task names is that task (src/todo.js rowsFor): Home and Next 7 days call it by the task's words, not the
  // outline's "· week of Sep 28 · date unconfirmed".
  const liveTasks = [...meetings.flatMap(m => (m.before || []).map(t => [m.courseKey, t])), ...weekWork.flatMap(w => (w.work || []).map(t => [w.courseKey, t]))].filter(([, t]) => !t.done && !t.stale)
  const taskFor = d => liveTasks.find(([ck, t]) => ck === d.courseKey && mentions(taskWords(t.text), d.set))?.[1] || null
  const deadlines = (hub?.deadlines || []).filter(d => !(d.set && tickedLines(d.courseKey).some(l => mentions(l, d.set)))).map(d => (d.set && taskFor(d) ? { ...d, title: taskWords(taskFor(d).text) } : d)).map(d => { const lp = localParts(d.due); const dueDate = d.dueDate || lp.date || null; return { ...d, dueDate, dueTime: d.dueTime !== undefined ? d.dueTime : lp.time, daysLeft: dueDate ? daysTo(dueDate, today) : d.daysLeft } })
  // tests: the next dated grading item per course, with its window and coverage counts — and its next quiz too when the
  // course keeps quizzes as their own component (FCS298): without it the day never knew Quiz 1 was three days away and
  // left ~470 minutes of its preparation for the day it opened (SPEC §24.5).
  const tests = []
  const nextsOf = courseKey => {
    const out = [nextTest(courseKey, today)]
    if ((COURSES[courseKey]?.grading?.components || []).some(c => c.key === 'quizzes')) { const q = nextTest(courseKey, today, { component: 'quizzes' }); if (q?.component === 'quizzes') out.push(q) }
    return out.filter(Boolean).filter((t, i, a) => a.findIndex(x => x.date === t.date) === i).sort((a, b) => a.date.localeCompare(b.date))
  }
  for (const courseKey of Object.keys(COURSES)) for (const t of nextsOf(courseKey)) {
    const window = coverageWindow(courseKey, t, today)
    const term = info(courseKey).term, wks = weeks(term)
    const material = new Set(), sheetWeeks = new Set(), problems = {}, tasks = {}
    for (const w of wks) {
      if ((lectures[courseKey]?.[w.n] || []).length || (recordings[courseKey]?.[w.n] || []).length || (topicPages[courseKey]?.[w.n] || []).length) material.add(w.n)
      if ((sheetPages[courseKey]?.[w.n] || []).length || sheets.some(s => s.courseKey === courseKey && s.week === w.label)) sheetWeeks.add(w.n)
      const pr = problemsRowsOf(problemsPageRel(courseKey, w)); if (pr && pr.counts.assigned) problems[w.n] = { attempted: pr.counts.attempted, assigned: pr.counts.assigned }
      const pl = planPages[planPageRel(courseKey, w)]
      if (pl) { const bi = findPlanBlock(pl.blocks, state.pages?.[planPageRel(courseKey, w)]?.blockId); if (bi >= 0) { const ts = planTasks(pl.blocks[bi].md); if (ts.length) tasks[w.n] = { done: ts.filter(x => x.done).length, total: ts.length } } }
    }
    const hubTest = (hub?.tests || []).find(x => x.courseKey === courseKey && x.date === t.date)
    tests.push({ courseKey, course: codeOf(courseKey), color: info(courseKey).color || null, key: t.key, title: t.title, date: t.date, daysLeft: daysTo(t.date, today), url: hubTest?.url || null, assumed: !!t.assumed,
      window: window ? { label: window.label, weeks: window.weeks, from: window.from, to: window.to, source: window.source, assumed: window.assumed } : null,
      coverage: coverageCounts({ window, today, material, sheets: sheetWeeks, problems, tasks, term }) })
  }
  // personal calendar events (slate === null) inside the horizon
  const cal = (calendar?.events || []).filter(e => e && !e.slate).map(e => { const s = localParts(e.start), en = localParts(e.end); return { id: e.id || null, title: e.title || '(untitled)', date: s.date, start: e.allDay ? null : s.time, end: e.allDay ? null : en.time, allDay: !!e.allDay || !s.time, location: e.location || '', calendar: e.calendar || null } }).filter(e => e.date >= from && e.date <= to)
  // days and their events
  const daysOut = []
  for (let d = from, i = 0; i < days; d = addDays(d, 1), i++) {
    const ev = []
    meetings.forEach(m => { if (m.date === d) ev.push({ type: 'meeting', ref: m.id, at: m.announced?.start || m.start }) })
    deadlines.forEach((x, j) => { if (x.dueDate === d) ev.push({ type: 'due', ref: j, at: x.confirmed === false ? null : x.dueTime || null }) })
    tests.forEach(t => { if (t.date === d) ev.push({ type: 'test', ref: t.key, courseKey: t.courseKey, at: meetings.find(m => m.courseKey === t.courseKey && m.date === d)?.start || null }) })
    cal.forEach((c, j) => { if (c.date === d) ev.push({ type: 'calendar', ref: j, at: c.start }) })
    ev.sort((a, b) => (a.at || '00:00').localeCompare(b.at || '00:00') || a.type.localeCompare(b.type))
    daysOut.push({ date: d, weekday: weekdayOf(d), rel: relDay(d, today), events: ev })
  }
  const pages = pageSpecs.map(s => { const pg = planPages[s.path]; const bi = pg ? findPlanBlock(pg.blocks, state.pages?.[s.path]?.blockId) : -1; const ts = bi >= 0 ? planTasks(pg.blocks[bi].md) : []; return { path: s.path, courseKey: s.courseKey, course: codeOf(s.courseKey), week: s.week.label, exists: !!pg, tasks: { done: ts.filter(t => t.done).length, total: ts.length } } })
  const tasksAll = meetings.reduce((a, m) => ({ done: a.done + (m.tasks?.done || 0), total: a.total + (m.tasks?.total || 0) }), { done: 0, total: 0 })
  // what Claude could not decide alone and asked the student (SPEC §20.37): the open ones, oldest first
  const questions = brain ? Object.values(brain.questions || {}).filter(q => q && !q.answered).sort((a, b) => String(a.at).localeCompare(String(b.at))) : []
  const plan = { version: 1, updatedAt: null, today, since, from, to, days: daysOut, meetings, weeks: weekWork, deadlines, tests, calendar: cal, issues, brain: !!brain, questions, pages, summary: { meetings: meetings.length, tasks: tasksAll, pages: pages.length, issues: issues.length, written: 0 } }
  return { plan, pageSpecs }
}

// ---- 7. Hub/Today/Next 7 days.md ------------------------------------------------------------------------------------------
const cell = s => String(s ?? '').replace(/\|/g, '\\|')
export function renderNextPage(plan) {
  const out = ['# Next 7 days', '', `_${weekdayOf(plan.today)} ${shortIso(plan.today)} · rebuilt by the morning pass and by Refresh on What's next. Read, do not edit._`, '']
  const byId = id => plan.meetings.find(m => m.id === id)
  for (const d of plan.days.slice(0, SHOW_DAYS)) {
    out.push(`## ${weekdayOf(d.date)} ${shortIso(d.date)} · ${d.rel}`, '')
    if (!d.events.length) { out.push('_Nothing scheduled._', ''); continue }
    out.push('| Time | Course | What | Where | Topic | Tasks |', '|---|---|---|---|---|---|')
    for (const e of d.events) {
      if (e.type === 'meeting') { const m = byId(e.ref); if (!m) continue; const t = m.announced?.start ? `${m.announced.start}–${m.announced.end || ''}` : `${m.start}–${m.end}`; out.push(`| ${t} | ${m.course} | ${m.cancelled ? `~~${m.kind}~~ · ${cell(m.cancelled)}` : m.kind} | ${cell(m.announced?.where || m.where)} | ${cell(m.topic?.text || '')} | ${m.tasks ? `${m.tasks.done} of ${m.tasks.total}` : m.before.length ? `${m.before.length} to build` : ''} |`) }
      else if (e.type === 'due') { const x = plan.deadlines[e.ref]; if (!x) continue; out.push(`| ${e.at || 'day'} | ${x.course} | due · ${cell(x.title)} | | | |`) }
      else if (e.type === 'test') { const t = plan.tests.find(x => x.key === e.ref && x.courseKey === e.courseKey); if (!t) continue; out.push(`| ${e.at || ''} | ${t.course} | test · ${cell(t.title)} | | ${cell(t.window?.label || '')} | |`) }
      else if (e.type === 'calendar') { const c = plan.calendar[e.ref]; if (!c) continue; out.push(`| ${c.allDay ? 'all day' : `${c.start}–${c.end || ''}`} | | ${cell(c.title)} | ${cell(c.location)} | ${cell(c.calendar || '')} | |`) }
    }
    out.push('')
  }
  out.push('## Tests', '')
  if (!plan.tests.length) out.push('_No dated tests on file._', '')
  else {
    out.push('| Course | Test | Date | Days | Window | Sheets | Problems | Tasks |', '|---|---|---|---|---|---|---|---|')
    for (const t of plan.tests) { const c = t.coverage; out.push(`| ${t.course} | ${cell(t.title)} | ${t.date} | ${t.daysLeft} | ${cell(t.window?.label || '')}${t.window?.assumed ? ' (assumed)' : ''} | ${c.sheets.total ? `${c.sheets.done}/${c.sheets.total}` : '—'} | ${c.problems ? `${c.problems.done}/${c.problems.total}` : '—'} | ${c.tasks ? `${c.tasks.done}/${c.tasks.total}` : '—'} |`) }
    out.push('')
  }
  if (plan.issues.length) {
    out.push('## Not placed', '')
    for (const i of plan.issues) out.push(`- ${i.course} · “${cell(i.text)}” — ${i.reason} — [[${i.title}]]`)
    out.push('')
  }
  if (plan.questions?.length) {
    out.push('## Questions from Claude', '')
    for (const q of plan.questions) out.push(`- ${q.courseKey ? `${codeOf(q.courseKey)} · ` : ''}${cell(q.text)}${q.page ? ` — [[${String(q.page).split('/').pop().replace(/\.md$/, '')}]]` : ''}`)
    out.push('')
  }
  return out.join('\n').replace(/\s+$/, '') + '\n'
}
export { PROBLEMS_HEADING, addDays, weekdayOf, daysTo, relDay, shortIso }
