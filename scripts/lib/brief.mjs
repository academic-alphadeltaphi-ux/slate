// The brief: everything one short Claude session needs to decide one course (SPEC §21).
//
// The heavy brain reads the whole notebook and decides everything in one long pass — 36M tokens of context re-read on
// a morning, which a Claude Pro plan cannot carry. The light brain is shown a brief instead: the course's weeks and
// classes, what is due, the open tasks, and each item that waits with the words the fetch could read from it and a
// *proposal* — where the deterministic rules (scripts/lib/filing.mjs, the module's name, the posting date) would put it,
// with the reason. Claude confirms or corrects; nothing here decides.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, weeks, weekFor, todayIso, isClassDay } from './terms.mjs'
import { SYLLABUS } from './syllabus.mjs'
import { readBrain, inboxItems, weekNOf } from './brain.mjs'
import { readJson } from './problems.mjs'
import { bucketFor, FOLDER, pageWeek, fileWeek, isAdmin } from './filing.mjs'
import { meetingId } from '../../src/calendar.js'
import { namesIt } from '../../src/resolve.js'

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
const pad = n => String(n).padStart(2, '0')
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const weekdayOf = iso => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T12:00:00').getDay()]
const toronto = iso => { try { return new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false }).replace(',', '') } catch { return iso } }

// The week a module's name points at. Professors number by their own calendar, but the name usually carries a date:
// "Week 2 (September 14-18) - Module 1" → the term week holding Sep 14; "Week 3" alone → term week 3.
export function weekFromModule(module, wks, term) {
  const m = String(module || '')
  const d = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(m)
  if (d && wks.length) {
    const month = MONTHS[d[1].toLowerCase().slice(0, 4)] || MONTHS[d[1].toLowerCase().slice(0, 3)]
    const year = month >= 8 ? wks[0].monday.slice(0, 4) : wks[wks.length - 1].monday.slice(0, 4)
    const w = weekFor(term, `${year}-${pad(month)}-${pad(Number(d[2]))}`)
    if (w) return { week: w, because: `the module is named for ${d[0]}` }
  }
  const n = /\bweek\s*(\d{1,2})\b/i.exec(m)
  if (n && wks[Number(n[1]) - 1]) return { week: wks[Number(n[1]) - 1], because: `the module is named Week ${n[1]}` }
  return null
}

const firstChars = async (abs, n) => {
  let t = ''
  try { t = await fs.readFile(abs, 'utf8') } catch { return null }
  t = t.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > n ? t.slice(0, n) + ' […]' : t
}
// The words the fetch could read: the page, then a PDF's cached text or a transcript beside it.
async function excerptOf(root, page, n) {
  const parts = []
  const own = await firstChars(path.join(root, page), Math.min(n, 900)); if (own) parts.push(own)
  const assets = path.join(root, String(page).replace(/\.md$/, '.assets'))
  for (const f of (await fs.readdir(assets).catch(() => [])).filter(f => /\.txt$/i.test(f)).slice(0, 2)) {
    const t = await firstChars(path.join(assets, f), n); if (t) parts.push(`[${f}] ${t}`)
  }
  return parts.join('\n').slice(0, n + 200)
}

const partFor = (info, folder) => {
  const kinds = new Set((info.meetings || []).map(m => m.kind))
  if (kinds.size <= 1) return kinds.size ? (kinds.has('Tutorial') ? 'tutorial' : 'lecture') : 'both'
  if (folder === 'Problems') return 'tutorial'
  if (folder === 'Lectures' || folder === 'Recordings') return 'lecture'
  return 'both'
}
const kindFor = folder => ({ Lectures: 'lecture', Readings: 'reading', Problems: 'problem-set', Videos: 'lecture', General: 'admin' })[folder] || 'notes'

// The rules' proposal for one waiting page, with why. `wks` are the course's weeks; `posted` its posting date.
export function propose(it, info, wks, excerpt = '') {
  const title = String(it.title || path.basename(String(it.page || ''), '.md'))
  const mod = weekFromModule(it.module, wks, info.term)
  const postedWeek = it.posted ? weekFor(info.term, it.posted) : null
  const because = []
  let week = null, folder = null
  if (it.kind === 'page') {
    // A module's forum, quiz, hand-in or video was read into the shape of a page (SPEC §20.53); the fetch's own line under
    // the title says which. Those have shelves of their own — Assignments, Videos — whatever their title looks like.
    const item = /^_?Quercus (discussion forum|quiz|assignment|video)\b/m.exec(String(excerpt || ''))?.[1] || null
    const pw = pageWeek(title, it.module, wks)
    if (pw) { week = pw.week; folder = pw.lecture ? 'Lectures' : /\breading/i.test(title) ? 'Readings' : null; because.push(pw.lecture ? 'a lecture page in a numbered module' : 'the title carries its week number') }
    else if (mod) { week = mod.week; because.push(mod.because); folder = /\breading/i.test(title) ? 'Readings' : /\b(quiz|forum|discussion|assignment|hand-?in)\b/i.test(title) ? 'Assignments' : /\bvideo|watch|mini-?lecture\b/i.test(title) ? 'Videos' : null }
    if (item && week) { folder = item === 'video' ? 'Videos' : 'Assignments'; because.push(`the fetch read it from the module's ${item}`) }
    else if (week && /\b(video|watch|mini-?lecture)\b/i.test(title)) { folder = 'Videos'; because.push('a video, by its title') }
    if (item === 'quiz' && week) { because.push('a quiz'); return { to: `${week.dir}/Assignments`, folder: 'Assignments', kind: 'exam', for: partFor(info, 'Assignments'), confidence: 'high', because: because.join('; ') } }
    if (item && item !== 'video' && week) return { to: `${week.dir}/Assignments`, folder: 'Assignments', kind: 'problem-set', for: partFor(info, 'Assignments'), confidence: 'high', because: because.join('; ') }
    if (!week) { because.push('no week in its title or module: course-wide'); return { to: 'General', folder: 'General', kind: 'admin', for: null, confidence: 'low', because: because.join('; ') } }
    if (!folder) { because.push('a topic page for the week itself'); return { to: week.dir, folder: null, kind: 'notes', for: partFor(info, 'Lectures'), confidence: mod ? 'medium' : 'high', because: because.join('; ') } }
  } else {
    const bucket = bucketFor(title, { module: it.module, heading: it.heading })
    if (bucket === 'admin' || isAdmin(title)) { because.push('named like course administration'); return { to: 'General', folder: 'General', kind: 'syllabus', for: null, confidence: 'medium', because: because.join('; ') } }
    // A tool's guide — installing R, getting into WebAssign, a software walkthrough — is for the whole course, not a week.
    if (/\b(install(ation|ing)?|set-?up guide|getting started|how to (use|access|log ?in)|user guide|software)\b/i.test(title)) { because.push('a guide to a tool, for the whole course'); return { to: 'General', folder: 'General', kind: 'admin', for: null, confidence: 'medium', because: because.join('; ') } }
    folder = FOLDER[bucket] || 'Lectures'
    if ((/\breading|chapter\b/i.test(title) || /\breading/i.test(String(it.from || ''))) && folder === 'Lectures') { folder = 'Readings'; if (/\breading/i.test(String(it.from || '')) && !/\breading|chapter\b/i.test(title)) because.push(`linked from "${it.from}"`) }
    because.push(`the name reads as ${bucket}`)
    if (mod) { week = mod.week; because.push(mod.because) }
    else if (postedWeek) { week = fileWeek(postedWeek, it.from, wks); because.push(week === postedWeek ? `posted in ${postedWeek.label}` : `linked as next week's from ${postedWeek.label}`) }
    if (!week) { because.push('no week known'); return { to: 'General', folder: 'General', kind: kindFor(folder), for: null, confidence: 'low', because: because.join('; ') } }
  }
  const to = folder ? `${week.dir}/${folder}` : week.dir
  const confidence = mod && (it.kind === 'page' || folder !== 'Lectures') ? 'high' : mod || postedWeek ? 'medium' : 'low'
  return { to, folder, kind: kindFor(folder), for: partFor(info, folder), confidence, because: because.join('; ') }
}

// ---- links (SPEC §21.11) -----------------------------------------------------------------------------------------------
// Every to-do opens something: the Quercus URL of the thing, else the slate page it concerns. The brothers' to-dos came out
// with no button — the prompt asked for `link` and a session left it out — so the brief hands over the link for every
// waiting item, class, week and deadline, and `run.mjs finish` keeps the morning open until each task it wrote has one.
const exists = p => fs.access(p).then(() => true, () => false)
const normUrl = u => { const m = /^(https?:\/\/[^/?#\s]+)([^?#\s]*)/i.exec(String(u || '').trim()); return m ? m[1].toLowerCase() + m[2].replace(/\/+$/, '') : null }
const LISTS = /^\/(modules|assignments|quizzes|discussion_topics|pages|files|announcements|grades|syllabus|users)$/
// → null when `link` opens the thing, else why it does not. The course's own Quercus page, or one of its lists, opens
// Quercus and leaves the student to look: that is not a link to the thing.
export async function linkProblem(root, courseKey, link) {
  if (!link) return 'no link'
  const s = String(link)
  if (/^https?:\/\//i.test(s)) {
    const u = normUrl(s), home = normUrl(COURSES[courseKey]?.url)
    if (/\s/.test(s) || !u || /^https?:\/\/[^/]+$/i.test(u)) return 'not the address of a thing'
    if (home && (u === home || (u.startsWith(home) && LISTS.test(u.slice(home.length))))) return 'the course\'s own Quercus page, not the thing'
    return null
  }
  if (!/\.md$/.test(s) || s.split('/').includes('..')) return 'neither a URL nor a page path ending in .md'
  return (await exists(path.join(root, s))) ? null : 'no page there any more (moved, renamed or ignored)'
}
// Every page of a folder and the folders in it, as paths from the root: a document's own page, never its .assets.
async function pagesUnder(root, rel, depth = 4) {
  const out = []
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || e.name.startsWith('_') || e.name.endsWith('.assets')) continue
    if (e.isDirectory() && depth > 0) out.push(...await pagesUnder(root, `${rel}/${e.name}`, depth - 1))
    else if (e.isFile() && e.name.endsWith('.md')) out.push(`${rel}/${e.name}`)
  }
  return out
}
// The likeliest link for a task that has none that opens: the page it named, where it went (brain.mjs follows only its
// own moves); the hand-in its words name; the document of its week its words name; else the week itself.
async function suggestLink(root, t, hub) {
  const info = COURSES[t.courseKey]; if (!info) return { link: null, why: null }
  if (t.link && !/^https?:/i.test(t.link)) {
    const hit = (await pagesUnder(root, t.courseKey)).find(p => path.posix.basename(p) === path.posix.basename(String(t.link)))
    if (hit) return { link: hit, why: `the page it named, now at ${hit}` }
  }
  const d = (hub?.deadlines || []).filter(x => x.courseKey === t.courseKey && (x.url || x.page)).map(x => ({ x, s: namesIt(t.what, x.title) })).filter(x => x.s).sort((a, b) => b.s - a.s)[0]?.x
  if (d) return { link: d.url || d.page, why: `${d.title}, named in its words` }
  const w = weeks(info.term).find(x => x.n === weekNOf(t.courseKey, t.attach))
  if (!w) return { link: null, why: null }
  const doc = (await pagesUnder(root, `${t.courseKey}/${w.dir}`)).map(p => ({ p, s: namesIt(t.what, path.posix.basename(p, '.md')) })).filter(x => x.s).sort((a, b) => b.s - a.s)[0]?.p
  if (doc) return { link: doc, why: 'the document of its week its words name' }
  const wp = `${t.courseKey}/${w.dir}.md`
  return (await exists(path.join(root, wp))) ? { link: wp, why: 'the week it is for; nothing more exact is named', weak: true } : { link: null, why: null }
}
// A task with nothing to open, rightly (the student, 2026-09-29: "if the link is available, link it; try your best to find it"):
// its words say where it lives — a paper book, in class, the student's own work — the rule scripts/lib/check.mjs holds too.
const NO_LINK_OK = /textbook|in print|print copy|paper|\bbuy\b|borrow|in the room|in class|your own|own work|revision|by hand/i
export function linklessOk(t) {
  const books = String(COURSES[t.courseKey]?.textbook || '').split(/\s+·\s+/).map(x => x.split(',')[0].trim()).filter(x => /^[A-Z][\p{L}-]{2,}$/u.test(x))
  return NO_LINK_OK.test(t.what || '') || books.some(b => String(t.what || '').includes(b))
}
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`
// The tasks written or changed since `since` (the run's start) that are open and open nothing, each with the command that
// gives it the likeliest link. `task edit` takes its fields as JSON on stdin (it has no --link flag).
// → [{ id, course, what, link, problem, suggest, command }]
export async function linkGate(root, brain, since, { hub } = {}) {
  if (hub === undefined) hub = await readJson(path.join(root, 'Hub', '_hub.json'), null)
  const out = []
  for (const t of Object.values(brain?.tasks || {})) {
    // every open task, not only this run's: a to-do on the screen is a to-do, whenever it was written (the student, 2026-09-29) —
    // the first morning after an update links what older runs left bare. `since` stays for callers that pass it.
    if (!t || t.withdrawn || t.done) continue
    const problem = await linkProblem(root, t.courseKey, t.link)
    if (!problem) continue
    const { link, why, weak } = await suggestLink(root, t, hub)
    const id = t.id, course = COURSES[t.courseKey]?.code || t.courseKey
    // the thing itself was found: it is the link, and nothing else will do
    if (link && !weak) { const edit = { link, reason: `the link it lacked: ${why}`.slice(0, 300) }; out.push({ id, course, what: t.what, link: t.link || null, problem, suggest: link, command: `echo ${sq(JSON.stringify(edit))} | node scripts/brain.mjs task edit ${id}` }); continue }
    // nothing exact, and its words say it lives nowhere online: a task without a link, rightly — a dead link is still mended
    if (problem === 'no link' && linklessOk(t)) continue
    // nothing exact found by code: look for it (the quercus skill), and only if it truly lives nowhere, say where in its words
    const search = `node scripts/quercus-sweep.mjs --modules --course ${COURSES[t.courseKey]?.id ?? '<id>'}`
    const found = { link: '<the URL or page you found>', reason: 'found it' }, say = { what: `${t.what} (paper textbook)`, reason: 'nothing online to open' }   // task words refuse " — ": the true one of (paper textbook), (in class), (your own work)
    out.push({ id, course, what: t.what, link: t.link || null, problem, suggest: null, week: link || null, search,
      command: `look for it: ${search} (and the notebook's pages); found → echo ${sq(JSON.stringify(found))} | node scripts/brain.mjs task edit ${id}; nothing online → echo ${sq(JSON.stringify(say))} | node scripts/brain.mjs task edit ${id} (or "(in class)", "(your own work)": the one that is true)${link ? `; last resort, its week page: ${link}` : ''}` })
  }
  return out
}

// buildBrief(root, courseKey) → the brief for one course, or null when nothing waits for it.
export async function buildBrief(root, courseKey, { today = todayIso(), horizon = 14, excerpt = 1400, all = false } = {}) {
  const info = COURSES[courseKey]; if (!info) throw new Error(`not a course: ${courseKey}`)
  const wks = weeks(info.term)
  const everything = (await inboxItems(root, { all: true })).filter(it => it.courseKey === courseKey)
  const items = everything.filter(it => all || (it.status || 'waiting') === 'waiting')
  const brain = await readBrain(root), hub = await readJson(path.join(root, 'Hub', '_hub.json'), null)
  // What a task is decided from once the inbox is empty: the announcements of the last fortnight, reviewed or not, and
  // what is already filed in the weeks around today. Without these a tasks-only session has nothing to go on.
  const since = addDays(today, -14)
  const recent = []
  for (const it of everything.filter(it => (it.kind === 'announcement' || it.kind === 'changed' || it.kind === 'page-update') && (it.posted || '') >= since && (it.status || 'waiting') !== 'waiting').slice(-6))
    recent.push({ kind: it.kind, title: it.title, posted: it.posted || null, page: it.page, excerpt: await excerptOf(root, it.page, 700) })
  const filed = []
  for (const w of wks.filter(w => w.monday >= addDays(today, -13) && w.monday <= addDays(today, horizon))) {
    for (const folder of ['Lectures', 'Readings', 'Problems', 'Assignments', 'Videos', 'Textbook']) {   // Textbook: the week's sections of the book, what a reading links
      const dir = path.join(root, courseKey, w.dir, folder)
      for (const f of (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.md') && !f.startsWith('_')).slice(0, 12)) {
        if (filed.length >= 30) break
        let head = ''; try { head = await fs.readFile(path.join(dir, f), 'utf8') } catch { }
        const part = /^for:\s*"?(lecture|tutorial|both)"?/m.exec(head)?.[1] || null
        // a forum, quiz or hand-in read from a module is done on Quercus: its URL is what a task about it links (SPEC §21.11)
        const quercus = /^_Quercus (?:discussion forum|quiz|assignment)\b.*\[open on Quercus\]\((https?:\/\/[^)\s]+)\)/m.exec(head)?.[1] || null
        filed.push({ week: w.n, folder, title: f.slice(0, -3), for: part, page: `${courseKey}/${w.dir}/${folder}/${f}`, ...(quercus ? { quercus } : {}), excerpt: head.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 240) })
      }
    }
  }
  const topics = SYLLABUS[courseKey]?.weeks || {}
  // A week's own page (the week screen): the link of a task with nothing more exact to open (SPEC §21.11). Only a page that
  // is there — brain.mjs refuses a link to one that is not.
  const weekPages = new Map()
  const weekPage = async w => { if (!w) return null; if (!weekPages.has(w.n)) weekPages.set(w.n, (await exists(path.join(root, courseKey, w.dir + '.md'))) ? `${courseKey}/${w.dir}.md` : null); return weekPages.get(w.n) }
  const classes = []
  for (let d = today, i = 0; i <= horizon; d = addDays(d, 1), i++) {
    if (!isClassDay(d)) continue
    for (const m of info.meetings || []) if (m.day === weekdayOf(d)) {
      // Claude's word on the class (brain.mjs class): kept under the meeting's id, { cancel, topic, reason, at } — looked for
      // by a courseKey/date/kind the entry never carries, it never matched, and a cancelled class still asked for its prep
      const ov = brain.classes?.[meetingId(courseKey, d, m.kind)]
      // isClassDay knows every term; the course has its own. A Winter course's Tuesday is not a class in October (its
      // prep tasks would have linked nowhere, and the link gate found them: scenario `resume`, 2026-09-29)
      const w = weekFor(info.term, d); if (!w) continue
      classes.push({ date: d, day: m.day, kind: m.kind, start: m.start, end: m.end, where: m.where || null, week: w?.label || null, link: await weekPage(w), ...(ov?.cancel ? { cancelled: ov.cancel } : {}), ...(ov?.topic ? { topic: ov.topic } : {}) })
    }
  }
  const waiting = [], reviews = []
  for (const it of items) {
    const base = { id: it.id, kind: it.kind || 'page', title: it.title, page: it.page, module: it.module || null, heading: it.heading || null, from: it.from || null, posted: it.posted || null, quercus: it.quercus || null }
    const text = await excerptOf(root, it.page, excerpt)
    // a page that changed on Quercus (`page-update`) already lives where it was put: it is read, not placed
    if (it.kind === 'announcement' || it.kind === 'changed' || it.kind === 'update' || it.kind === 'page-update') reviews.push({ ...base, excerpt: text })
    else {
      // The link a task about it takes: a forum, quiz or hand-in is done on Quercus, so its Quercus URL — the one the morning
      // ticks the task by once Quercus has it (SPEC §20.69); anything else is read in slate, on the page `place` puts it at:
      // where the proposal says, or the path `place` prints after → when it goes elsewhere.
      const proposal = propose(it, info, wks, text)
      const onQuercus = /^_?Quercus (discussion forum|quiz|assignment)\b/m.test(String(text || ''))
      waiting.push({ ...base, proposal, link: onQuercus && it.quercus ? it.quercus : `${courseKey}/${proposal.to}/${path.posix.basename(String(it.page || ''), '.md')}.md`, excerpt: text })
    }
  }
  // a deadline's link: its own Quercus URL, else its page in slate (a WebAssign set's Problems page), else the week it falls in
  const dl = []
  for (const d of (hub?.deadlines || []).filter(d => d.courseKey === courseKey)) {
    const due = toronto(d.due)
    dl.push({ title: d.title, due, url: d.url || null, link: d.url || d.page || await weekPage(weekFor(info.term, d.dueDate || due.slice(0, 10))), points: d.points ?? null, submitted: !!d.submitted })
  }
  const tests = (hub?.tests || []).filter(t => t.courseKey === courseKey && t.date >= today).slice(0, 4).map(t => ({ title: t.title, date: t.date }))
  // an open task whose link opens nothing says why (`linkProblem`): give it one with `task edit` while the course is open
  const tasks = []
  for (const t of Object.values(brain.tasks || {}).filter(t => t && !t.withdrawn && t.courseKey === courseKey)) {
    const problem = t.done ? null : await linkProblem(root, courseKey, t.link)
    tasks.push({ id: t.id, what: t.what, class: t.attach?.class || null, week: t.attach?.week ?? null, due: t.due || null, level: t.level, kind: t.kind || null, link: t.link || null, ...(problem ? { linkProblem: problem } : {}) })
  }
  const questions = Object.values(brain.questions || {}).filter(q => q && !q.answered && q.courseKey === courseKey).map(q => ({ id: q.id, text: q.text }))
  // Nothing waiting is not nothing to do: a class in the next few days with no task yet, or a deadline with none, still
  // needs the tasks pass — a short session with an empty inbox. A course with neither is skipped, which is what keeps a
  // quiet morning cheap.
  const soon = addDays(today, 6)
  const attachedTo = (date, kind) => tasks.some(t => t.class?.date === date && t.class?.kind === kind)
  const classNeeds = classes.filter(c => c.date <= soon && !c.cancelled && !attachedTo(c.date, c.kind))
  const dueNeeds = dl.filter(d => !d.submitted && d.due.slice(0, 10) <= soon && !tasks.some(t => t.due && d.due.startsWith(t.due)))
  if (!items.length && !classNeeds.length && !dueNeeds.length) return null
  const near = wks.filter(w => addDays(w.monday, 27) >= today && w.monday <= addDays(today, 42))
  return {
    why: items.length ? 'inbox' : 'tasks', needs: { classes: classNeeds.map(c => `${c.kind} ${c.date}`), deadlines: dueNeeds.map(d => d.title) },
    today, course: { key: courseKey, code: info.code, name: info.name, term: info.term, meets: info.meets || null, professor: info.professor || null, tutorialLag: info.tutorialLag || null, folders: ['Lectures', 'Readings', 'Problems', 'Videos', 'Assignments', 'Recordings', 'Notes'] },
    weeks: await Promise.all(near.map(async w => ({ n: w.n, dir: w.dir, span: w.span, page: await weekPage(w), ...(topics[w.n]?.topic ? { topic: topics[w.n].topic } : {}) }))),
    classes, deadlines: dl, tests, tasks, questions, waiting, reviews, recent, filed,
  }
}
// Every course with something waiting, in the order of terms.mjs.
export async function courseBriefs(root, opts) {
  const out = []
  for (const key of Object.keys(COURSES)) { const b = await buildBrief(root, key, opts); if (b) out.push(b) }
  return out
}
