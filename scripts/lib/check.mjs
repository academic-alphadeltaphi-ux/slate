// What code can see about a course's open tasks and documents, for the course agent and the critic to decide on (SPEC
// §24.5). Code flags, Claude decides: a flag is a question with its evidence, never a correction. Nothing here writes.
//
// Born of the first live team run (2026-09-29): the course agents were told to re-read every open task one at a time
// and, at medium effort, did not — two tested no link, and the task the team was built for kept its wrong level. What a
// program can test (a path on disk, a date against a level, words against minutes, two tasks on one link) it now tests,
// so the agent's attention goes to the judgment.
//
// checkCourse(root, courseKey, { today }) → { courseKey, course, today, open, flagged, tasks: [...], documents: [...] }
//   tasks[i] = { id, what, kind, level, minutes, graded, attach, due, link, flags: [{ kind, why, suggest? }] }
//   documents[i] = { page, flags: [...] }
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, weeks, weekFor } from './terms.mjs'
import { readJson } from './problems.mjs'
import { readBrain, weekNOf, tickedOnPage } from './brain.mjs'
import { expandMeetings, daysTo, addDays, nextTest, coverageWindow } from '../../src/calendar.js'

export const READ_WPM = 150                                    // dense course reading with its maths: about 150 words a minute
export const SLIDES_WPM = 60                                   // a deck is studied, not read: graphs and derivations per slide
const NO_LINK_OK = /textbook|in print|print copy|paper|\bbuy\b|borrow|in the room|in class|your own|revision|by hand/i
const exists = p => fs.access(p).then(() => true, () => false)
const wordsIn = s => (String(s || '').match(/[\p{L}\p{N}]+/gu) || []).length
const stripFront = s => String(s || '').replace(/^---\n[\s\S]*?\n---\n?/, '')
const round5 = n => Math.max(10, Math.round(n / 5) * 5)
const tokens = s => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])

// The words a reader meets: the page's own text plus every text layer or transcript beside it in its .assets folder.
export async function wordsOfPage(root, rel) {
  const p = path.join(root, rel)
  const text = await fs.readFile(p, 'utf8').catch(() => null); if (text === null) return null
  let n = wordsIn(stripFront(text))
  const assets = p.replace(/\.md$/, '.assets')
  for (const f of await fs.readdir(assets).catch(() => [])) if (/\.(pdf\.txt|txt)$/i.test(f)) n += wordsIn(await fs.readFile(path.join(assets, f), 'utf8').catch(() => ''))
  return n
}

// The course's next dated test and next quiz, each with the weeks it covers and how near "near" is: three weeks for a
// test, two for a quiz (the student's rule of 2026-09-29: a missed task falls to normal until a test covering it is close).
function testsAhead(courseKey, today) {
  const out = []
  const t = nextTest(courseKey, today); if (t) out.push({ ...t, near: 21 })
  if ((COURSES[courseKey]?.grading?.components || []).some(c => c.key === 'quizzes')) { const q = nextTest(courseKey, today, { component: 'quizzes' }); if (q?.component === 'quizzes') out.push({ ...q, near: 14 }) }
  return out.map(x => ({ ...x, daysLeft: daysTo(x.date, today), weeks: coverageWindow(courseKey, x, today)?.weeks || [] }))
}

export async function checkCourse(root, courseKey, { today } = {}) {
  const info = COURSES[courseKey]; if (!info) throw new Error(`no course ${courseKey}`)
  const brain = await readBrain(root)
  const hub = (await readJson(path.join(root, 'Hub', '_hub.json'), {})) || {}
  const horizonEnd = new Date(Date.parse(today + 'T12:00:00') + 60 * 864e5).toISOString().slice(0, 10)
  const meetings = expandMeetings(today, horizonEnd).filter(m => m.courseKey === courseKey)
  const cancelledId = id => !!brain.classes?.[id]?.cancel
  const nextClass = meetings.find(m => m.date >= today && !m.cancelled && !cancelledId(m.id)) || null
  const tests = testsAhead(courseKey, today)
  const termWeeks = weeks(info.term), curWeek = weekFor(info.term, today)?.n ?? null
  const deadlines = (hub.deadlines || []).filter(d => d.courseKey === courseKey && d.url)
  // the course's books by their authors (terms.mjs `textbook`: "Williamson, Macroeconomics …", "Bagieu, Layers … · Satrapi, …"):
  // a task that names one is read on paper, and needs no link
  const paperBooks = String(info.textbook || '').split(/\s+·\s+/).map(x => x.split(',')[0].trim()).filter(x => /^[A-Z][\p{L}-]{2,}$/u.test(x))

  const open = []
  for (const t of Object.values(brain.tasks)) {
    if (!t || t.withdrawn || t.courseKey !== courseKey || t.done) continue
    if (await tickedOnPage(root, t)) continue
    open.push(t)
  }

  const tasks = []
  for (const t of open) {
    const flags = [], flag = (kind, why, suggest) => flags.push(suggest ? { kind, why, suggest } : { kind, why })
    const weekN = weekNOf(courseKey, t.attach)
    const wk = termWeeks.find(w => w.n === weekN), when = t.due || t.attach?.class?.date || (wk ? addDays(wk.monday, 6) : null)
    const dIn = when ? daysTo(when, today) : null
    const past = t.attach?.class ? t.attach.class.date < today : weekN != null && curWeek != null && weekN < curWeek

    // the link
    const link = t.link || null
    if (!link) { if (!NO_LINK_OK.test(t.what) && !paperBooks.some(b => t.what.includes(b))) flag('link', 'no link, and its words do not say it is a paper book or his own work') }
    else if (/^https?:/i.test(link)) {
      if (/\/courses\/\d+\/?$/.test(link)) flag('link', 'links the course home page, not the thing itself')
    } else {
      if (!(await exists(path.join(root, link)))) flag('link', `not on disk: ${link}`)
      if (/\/Week [^/]+\/Problems\.md$/.test(link)) flag('link', "links a week's Problems page, not the set itself")
    }
    if ((t.graded || ['due', 'quiz', 'participation'].includes(t.kind)) && !/^https?:/i.test(link || '')) {
      const words = tokens(t.what), d = deadlines.find(x => [...tokens(x.title)].filter(w => words.has(w)).length >= 2)
      if (d) flag('link', `graded work with a Quercus deadline "${d.title}" — its own URL is ${d.url}`, JSON.stringify({ link: d.url }))
    }

    // the class or week
    if (t.attach?.class) {
      const { date, kind } = t.attach.class
      const m = expandMeetings(date, date).find(x => x.courseKey === courseKey && x.kind === kind)
      if (!m) flag('class', `${courseKey} has no ${kind} on ${date}`)
      else if (m.cancelled || cancelledId(m.id)) flag('class', `the ${kind} on ${date} is cancelled (${m.cancelled || brain.classes[m.id].cancel})`)
    } else if (weekN != null && !termWeeks.some(w => w.n === weekN)) flag('class', `week ${weekN} is not a week of the term`)

    // the level, against today's date
    const graded = !!(t.graded || ['due', 'quiz', 'participation'].includes(t.kind))
    const covering = tests.filter(x => weekN != null && x.weeks.includes(weekN) && x.daysLeft >= 0 && x.daysLeft <= x.near)
    if (!past && dIn != null && dIn >= 0) {
      if (graded && dIn <= 1 && t.level !== 'crucial') flag('level', `marked and due ${dIn === 0 ? 'today' : 'tomorrow'} — step 6 says crucial`, 'crucial')
      else if (graded && dIn <= 3 && ['normal', 'optional'].includes(t.level)) flag('level', `marked and due in ${dIn} days — step 6 says important`, 'important')
      else if (nextClass && t.attach?.class && t.attach.class.date === nextClass.date && t.attach.class.kind === nextClass.kind && ['normal', 'optional'].includes(t.level) && t.kind !== 'bring') flag('level', `prepares ${courseKey}'s next class (${nextClass.kind} ${nextClass.date}) — step 6 says important`, 'important')
      if (t.level === 'crucial' && dIn > 3 && !covering.some(x => x.daysLeft <= 3)) flag('level', `crucial, but its day is ${dIn} days away`, 'important')
    }
    if (past) {
      if (['important', 'crucial'].includes(t.level) && !covering.length) flag('level', `missed, and no test covering week ${weekN} is near (${tests.map(x => `${x.title.split(' · ')[0]} in ${x.daysLeft} d`).join(', ') || 'none dated'}) — the missed-task rule says normal`, 'normal')
      if (['normal', 'optional'].includes(t.level) && covering.length) flag('level', `missed, and ${covering[0].title.split(' · ')[0]} (in ${covering[0].daysLeft} d) covers week ${weekN} — the missed-task rule says important`, 'important')
    }

    // the minutes
    if (t.minutes == null) flag('minutes', 'no minutes: the day is built from them')
    else if (link && !/^https?:/i.test(link) && (t.kind === 'read' || /^(read|look through|go through|preview)\b/i.test(t.what))) {
      // Only when the page is the reading itself — a guide beside a printed book is not the book — and short enough texts
      // are left to judgment. Too few minutes is what overloads a day (Perloff 4.2–4.4: 13,400 words set at 60), so that
      // side is flagged from 1,500 words and a quarter short (60 against 90 must show); too many only when far out.
      const slides = /\/Lectures\//.test(link) || /\bslides?\b|\bdeck\b/i.test(t.what)
      const beside = /in print|print copy|paper|beside you|with the reading guide/i.test(t.what)
      const words = beside ? null : await wordsOfPage(root, link)
      if (words) {
        const wpm = slides ? SLIDES_WPM : READ_WPM, base = round5(words / wpm)
        if (words >= 1500 && t.minutes < base * 0.75) flag('minutes', `${t.minutes} min for ${words.toLocaleString('en-US')} words — about ${base} at ${wpm} words a minute${slides ? ' (a deck)' : ''}`, String(base))
        else if (words >= 2500 && t.minutes > base * 3) flag('minutes', `${t.minutes} min for ${words.toLocaleString('en-US')} words — more than three times the ${base} at ${wpm} words a minute`, String(base))
      }
    }

    tasks.push({ id: t.id, what: t.what, kind: t.kind || null, level: t.level, minutes: t.minutes ?? null, graded: !!t.graded, attach: t.attach, due: t.due || null, link, flags })
  }

  // two open tasks on one thing
  // Same slate page and words that overlap: a generic URL (webassign.net) or a forum's post and reply share a link rightly.
  const jaccard = (x, y) => { const a = tokens(x), b = tokens(y); const inter = [...a].filter(w => b.has(w)).length; return inter / (new Set([...a, ...b]).size || 1) }
  for (const a of tasks) {
    if (!a.link || /^https?:/i.test(a.link)) continue
    const same = tasks.filter(b => b !== a && b.link === a.link && jaccard(a.what, b.what) >= 0.4)
    if (same.length) a.flags.push({ kind: 'duplicate', why: `the same link as ${same.map(b => `${b.id} "${b.what.slice(0, 60)}"`).join(', ')} — one thing twice, or two parts of it?` })
  }

  // documents from last week to next week that do not say which class they are for
  const documents = []
  const span = termWeeks.filter(w => curWeek != null && w.n >= curWeek - 1 && w.n <= curWeek + 1)
  for (const w of span) {
    const dir = path.join(root, courseKey, w.dir)
    for (const sub of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!sub.isDirectory() || /\.assets$/.test(sub.name) || sub.name === 'Notes') continue
      for (const f of await fs.readdir(path.join(dir, sub.name)).catch(() => [])) {
        if (!f.endsWith('.md')) continue
        const rel = path.join(courseKey, w.dir, sub.name, f)
        const head = (await fs.readFile(path.join(root, rel), 'utf8').catch(() => '')).match(/^---\n([\s\S]*?)\n---/)?.[1] || ''
        if (!/^for:\s*"?(lecture|tutorial|both)"?/m.test(head)) documents.push({ page: rel, flags: [{ kind: 'for', why: 'no for: — it shows under no class on the week screen' }] })
      }
    }
  }

  return { courseKey, course: info.code, today, open: tasks.length, flagged: tasks.filter(t => t.flags.length).length, tasks, documents }
}
