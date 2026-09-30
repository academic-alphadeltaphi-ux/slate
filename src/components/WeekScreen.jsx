import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { Flags, Flag } from './Flags.jsx'
import { Track, testFlag } from './Viz.jsx'
import MdLite from './MdLite.jsx'
import { setProblemRow } from '../tick.js'
import { useTranscribe } from '../transcribe.js'
import { labelText, setSays } from '../problems.js'
import { startNote, startNewNote, noteTitle, shortWeek } from '../notes.js'
import { useDialog } from './Dialog.jsx'
import { THIS as ED } from '../edition.js'
import { rowsFor } from '../todo.js'
import { addDays } from '../plan.js'
import { usePlan, toggleTask, todayIso, nowHM } from './plan/PlanBits.jsx'
import { useMyTasks, toggleMyTask } from './MyTasks.jsx'
import '../styles/screens.css'
import '../styles/todo.css'
import '../styles/week.css'

// The week (SPEC §20.13, merged §20.24, redrawn §20.26, simplified §20.39). This screen has one job — **see everything
// the week holds, and get to work on it** — and every version that tried to do more than that got in the way. The
// six-buckets-as-tabs version hid five sixths of the week behind a click. The scrolling version that replaced it put
// what to do, what was not filed yet, and three rows of navigation between the student and the files.
//
// Then the three-tab version (§20.39) went too: "I work week by week — I need to see everything that is week by week,
// and what I missed" (SPEC §20.54). So the week is **one page, top to bottom**: its classes, what there is to do in it —
// ticked in place, what was missed said so, at its level — and then every file in it, a shelf per category, with the
// class a document is for as a small word on its row rather than a tab that hides the other half. No tabs, no jump bar:
// one scroll is the whole week.
//
// Under a tab the week is a **shelf per category** — Lectures, Recordings, Problems, Study sheets, Notes, and any
// category of your own — each one boxed, titled, and holding nothing but the pages inside it: click one to open it,
// *New page* on its own head to add one, × on a row to send one to the trash. Notes is a shelf like the rest, so the
// week's sheet and every note beside it are pages you open, not text quoted at you on the way past.
//
// Problems is the one thing you *do* here rather than read, so its shelf holds cards: the card opens the questions,
// and its questions are chips you tick as you work. There is no page of your own to make first (SPEC §20.32).
//
// Nothing here opens a container in the editor (SPEC §20.33). A tick goes through PUT /api/page like every other
// (src/tick.js). Read-only otherwise: GET /api/week.
// props: { path: '<Course>/<Term>/<Week>', initialTab, onOpen(path), onOpenTitle(title), onOpenPair(left, right),
//          onOpenTerm(path), onOpenCourse(key), onOpenWeek(path, tab) }
const I = (name, p = { width: 15, height: 15 }) => (Icon[name] || Icon.file)(p)
const fmtDay = iso => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '')
const bodyOf = s => (s?.md || '').replace(/^#\s+.*$/m, '').replace(/^_.*_$/gm, '').trim()

// Which class a thing belongs to (SPEC §20.38): Claude says so when it files a document (`for` in the frontmatter).
const partOf = x => (x?.for ? String(x.for).toLowerCase() : null)
const partOfSet = s => [s.questions, s.solutions, s.guide, ...(s.extra || [])].filter(Boolean).map(d => partOf(d)).find(Boolean) || null
const forSays = p => (p === 'both' ? 'the week' : 'the ' + p)
// The folders of a week, always in this order and always shown — an empty shelf says the week has no recording yet,
// which is worth knowing, and it means the shelf you reach for is in the same place in every week of every course.
// `plan` is not one of them: the week's to-do lives on To do.
// The five categories every week has, in one order — and, among the folders a week may also hold, the three the brain
// files by name (SPEC §20.53): readings beside the lectures, videos next, the module's assignments after the problems.
// Any other folder (R, Listening) follows in the section's own order.
const ORDER = ['lectures', 'x:Readings', 'x:Textbook', 'x:Videos', 'notes', 'recordings', 'problems', 'x:Assignments', ...(ED.sheets ? ['sheets'] : [])]
const CORE = new Set(['lectures', 'notes', 'recordings', 'problems', ...(ED.sheets ? ['sheets'] : [])])
const ALL = 'all'
// What a new page is, by the folder you put it in.
const KIND_OF = { Lectures: 'lecture', Recordings: 'notes', Problems: 'problem-set', Readings: 'reading', Textbook: 'reading', Videos: 'notes', Assignments: 'problem-set', 'Study sheets': 'summary' }
const FOLDERS = [['Lectures', 'board'], ['Readings', 'bookOpen'], ['Textbook', 'book'], ['Videos', 'eye'], ['Recordings', 'headphones'], ['Problems', 'pencil'], ['Assignments', 'checkSquare'], ...(ED.sheets ? [['Study sheets', 'bookmark']] : [])]
// How many things a folder holds — always what is actually drawn under it, so a heading never disagrees with its list.
const countOf = s => (s.sets ? s.sets.length + (s.loose || []).length : s.items.length)

export default function WeekScreen({ path, initialTab = null, onOpen, onOpenTitle, onOpenPair, onOpenTerm, onOpenCourse, onOpenWeek }) {
  const [d, setD] = useState(null), [error, setError] = useState(null), [note, setNote] = useState(null)
  const tab = ALL   // the whole week, always (SPEC §20.54)
  const dialog = useDialog()
  const seq = useRef(0), key = path.split('/')[0]
  const load = () => { const n = ++seq.current; return api.week(path).then(x => { if (n === seq.current) { setD(x); setError(null) } }).catch(e => { if (n === seq.current) setError(e.message) }) }
  useEffect(() => { setD(null); setNote(null); load() }, [path])
  // The weeks of the term with what each holds, for the row of cells over the page (SPEC §20.63) — the same Track the
  // course page draws, instead of a row of numbers that said nothing about the weeks.
  const [termData, setTermData] = useState(null)
  useEffect(() => {
    if (!d?.term) return
    let alive = true
    api.term(key, d.term).then(x => { if (alive) setTermData(x) }).catch(() => { if (alive) setTermData(null) })
    return () => { alive = false }
  }, [key, d?.term])
  // What there is to do in this week, the rows To do and Home build (src/todo.js), kept to this week — a class's tasks by
  // the week the class is in, a week's own work by its week, a hand-in or a test by the day it falls on. Past weeks keep
  // their done ones too, so the page can say what was missed beside what was done.
  const { plan, patch, refresh } = usePlan()
  const [hub, setHub] = useState(null), [ctx, setCtx] = useState({}), [titles, setTitles] = useState([])
  useEffect(() => { api.titles().then(setTitles).catch(() => { }) }, [])
  useEffect(() => {
    api.hub().then(setHub).catch(() => { })
    api.course(key).then(x => setCtx({ links: x.links?.items || [], general: x.general || [], courseUrl: x.course?.url, tests: x.tests || [] })).catch(() => { })
  }, [key])
  const today = todayIso(), now = nowHM()
  // His own tasks for this course, dated in this week (SPEC §23: a task he adds on Today's work shows on its week too).
  const mine = useMyTasks((hub?.courses || []).map(c => c.code))
  const weekRows = useMemo(() => {
    const w = d?.week
    if (!plan || !w?.monday) return []
    const sunday = addDays(w.monday, 6)
    const rows = rowsFor({ plan, hub, tests: plan.tests || [], today, now, courseKey: key, ctxFor: () => ({ ...ctx, titles }), mine: mine.tasks, courses: hub?.courses || [], past: 'all' })
    return rows.filter(r => (r.type === 'prep' || r.type === 'in-class' ? r.meeting?.week?.n === w.n : r.type === 'week' ? r.week?.n === w.n : r.by >= w.monday && r.by <= sunday))
  }, [plan, hub, ctx, titles, d?.week?.monday, key, today, mine.tasks])
  const tickRow = async r => {
    if (r.type === 'mine') { try { await toggleMyTask(r.raw); mine.reload() } catch (e) { setNote(`Could not tick that: ${e.message}`) } return }
    if (!(r.type === 'prep' || r.type === 'week')) return
    try {
      if (!(await toggleTask(r.meeting, r.task))) return
      const flip = list => list.map(y => (y.key === r.task.key ? { ...y, done: !y.done } : y))
      patch(p => p ? { ...p, meetings: p.meetings.map(x => x.id !== r.meeting.id ? x : { ...x, before: flip(x.before), tasks: x.tasks ? { ...x.tasks, done: x.tasks.done + (r.task.done ? -1 : 1) } : x.tasks }),
        weeks: (p.weeks || []).map(x => x.id !== r.meeting.id ? x : { ...x, work: flip(x.work) }) } : p)
      refresh()
    } catch (e) { setNote(`Could not tick that: ${e.message}`) }
  }
  useEffect(() => {
    let t = null
    const off = api.events(ev => { const p = ev.path || ''; if (p.startsWith(key + '/') || p === 'Hub/_problems.json' || p === 'Hub/_review.json') { clearTimeout(t); t = setTimeout(load, 600) } })
    return () => { off(); clearTimeout(t) }
  }, [path])
  // Esc goes up to the course, as it goes from a course to Home — unless a field or a dialog has the keyboard.
  useEffect(() => {
    const h = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const a = document.activeElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName || '') || a?.isContentEditable || document.querySelector('.modal-backdrop, .cs-scrim')) return
      onOpenCourse(key)
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [path])

  const openTitle = t => (onOpenTitle ? onOpenTitle(t) : onOpen(t))
  // One problem row, set from a chip: drawn at once, written through the page, then read back.
  const setRow = async (page, r, state) => {
    const put = y => (y.key === r.key ? { ...y, ...state } : y)
    setD(x => x && { ...x, sections: x.sections.map(s => (s.id !== 'problems' ? s : { ...s, sets: (s.sets || []).map(g => ({ ...g, rows: g.rows.map(put) })), loose: (s.loose || []).map(put) })) })
    try { if (!(await setProblemRow(page, r.key, state))) setNote('That row is no longer on the page — reloading.') }
    catch (e) { setNote(`Could not tick that: ${e.message}`) }
    load()
  }

  // Ticking a question on the covers shelf writes to the week that *holds* the page, not the week you are looking at.
  const setCoverRow = async (cv, r, state) => {
    const put = y => (y.key === r.key ? { ...y, ...state } : y)
    setD(x => x && { ...x, covers: (x.covers || []).map(c => (c.key !== cv.key || c.from.n !== cv.from.n ? c
      : { ...c, sets: c.sets.map(g => ({ ...g, rows: g.rows.map(put) })) })) })
    try { if (!(await setProblemRow(`${cv.from.dir}/Problems.md`, r.key, state))) setNote('That row is no longer on the page — reloading.') }
    catch (e) { setNote(`Could not tick that: ${e.message}`) }
    load()
  }

  // A tab per *kind* of class, then All. Per kind and not per meeting: `for` says "the tutorial", never "Tuesday's
  // tutorial", so a week with two lectures is one Lecture tab with both days named under it.
  const classes = useMemo(() => {
    if (!d) return []
    const by = new Map()
    const add = kind => { const k = String(kind || '').toLowerCase(); if (k && !by.has(k)) by.set(k, { key: k, label: kind, meetings: [] }); return by.get(k) }
    for (const m of d.meetings || []) add(m.kind)?.meetings.push(m)
    for (const kind of d.classes || []) add(kind)
    return [...by.values()]
  }, [d])

  // What a tab shows. A class's tab: what is filed for it, plus what serves the week as a whole. All: everything the
  // week holds, whether or not anyone has said which class it is for.
  const sheetRow = s => ({ path: s.path, title: noteTitle(d.course.code, d.week.label), kind: 'notes', for: null, date: null, sheet: true,
    words: bodyOf(s).split(/\s+/).filter(Boolean).length, pdfs: 0, media: 0, images: 0, transcribed: false })
  const cut = (pick, all = false) => {
    const out = []
    for (const s of d?.sections || []) {
      if (s.id === 'plan') continue
      let items = (s.items || []).filter(pick)
      const sets = s.sets ? s.sets.filter(x => pick({ for: partOfSet(x) })) : null
      // A row on the week's Problems page that no document claims belongs to the week, not to either class: it would
      // read as the lecture's *and* the tutorial's if it were on both tabs, so it is on All.
      const loose = s.id === 'problems' && all ? s.loose || [] : []
      // The week's own sheet is a page like any other, so it stands on the Notes shelf instead of having its text
      // spilled onto the screen. It only exists once something is written in it — an empty Notes.md is scaffolding.
      if (s.id === 'notes' && bodyOf(s)) items = [sheetRow(s), ...items]
      if (CORE.has(s.id) || items.length || sets?.length || loose.length) out.push({ ...s, items, ...(sets ? { sets, loose } : {}) })
    }
    const rank = s => { const i = ORDER.indexOf(s.id); return i < 0 ? ORDER.length : i }
    return out.sort((a, b) => rank(a) - rank(b))
  }
  const panels = useMemo(() => {
    if (!d) return {}
    const out = { [ALL]: cut(() => true, true) }
    for (const c of classes) out[c.key] = cut(x => partOf(x) === c.key || partOf(x) === 'both')
    return out
  }, [d, classes])
  const count = bs => (bs || []).reduce((a, s) => a + countOf(s), 0)

  // Landing on a folder: the term grid and the course screen hand over a bucket ("problems", "notes"). Every folder is
  // on All, so that is where it lands, and one scroll puts it under the eye.
  const landed = useRef(null)
  useEffect(() => {
    const want = `${path}|${initialTab || ''}`
    if (!d || landed.current === want) return
    landed.current = want
    if (!initialTab || initialTab === ALL || classes.some(c => c.key === initialTab)) return
    setTimeout(() => document.querySelector(`[data-bucket="${initialTab}"]`)?.scrollIntoView({ block: 'start' }), 40)
  }, [d, path, initialTab])

  if (error && !d) return <div className="home"><div className="home-empty"><p>{error}</p><button className="btn" onClick={() => onOpenCourse(key)}>Back to the course</button></div></div>
  if (!d) return <div className="home" />
  const { course: c, week: w } = d
  const intro = (d.intro || '').replace(/^#\s+.*\n?/, '').trim()
  const here = classes.find(x => x.key === tab) || null
  const shown = panels[tab] || panels[ALL] || []
  // What this week's classes work through that is filed in another week (SPEC §20.50). It shows on that class's tab
  // and on All, and it counts towards the tab's number, because a heading that disagrees with its list is the bug
  // this screen was rebuilt to remove.
  const coversFor = k => (d.covers || []).filter(cv => k === ALL || cv.key === k)
  const coversN = k => coversFor(k).reduce((a, cv) => a + cv.sets.length + cv.items.length, 0)
  const notes = (d.sections || []).find(s => s.id === 'notes') || null
  const others = d.others || []
  const written = (notes?.items?.length || 0) > 0 || !!bodyOf(notes)
  const wk = { courseKey: key, code: c.code, week: { dir: `${d.term}/${w.label}`, label: w.label } }

  const write = async () => {
    try { onOpen(await startNote(api, wk)) }
    catch (e) { setNote(`Could not start that note: ${e.message}`) }
  }
  const writeNew = async () => {
    try { onOpen(await startNewNote(api, wk)) }
    catch (e) { setNote(`Could not start a new note: ${e.message}`) }
  }
  // A week flagged for review (SPEC §21.13): a flag and a line of what to go over, asked in the dialog every other name is
  // asked in. It rides on the tests whose weeks include this one — their rows on To do and Home, the course's Next test.
  const flagWeek = async on => {
    const w = d.week
    let note = ''
    if (on) {
      note = await dialog.prompt({ title: `Flag ${shortWeek(w.label)} for review`, label: 'What to go over before the test — a few words, or nothing', value: d.review?.note || '', placeholder: 'e.g. the derivations from the second lecture', confirmLabel: d.review ? 'Save' : 'Flag it' })
      if (note == null) return
    }
    try { await api.flagWeek(key, w.n, w.label, on, note); await load(); api.hub().then(setHub).catch(() => { }) }
    catch (e) { setNote(`Could not flag the week: ${e.message}`) }
  }
  // Sending a page to the trash from the shelf it stands on. Nothing is deleted outright — /api/trash is the same
  // move the file tree uses, so it can be put back.
  const removePage = async it => {
    const ok = await dialog.confirm({ title: `Remove “${it.title}”?`, message: 'It goes to the trash, so you can put it back.', confirmLabel: 'Remove it', danger: true })
    if (!ok) return
    try { await api.trash(it.path); await load() }
    catch (e) { setNote(`Could not remove that: ${e.message}`) }
  }
  // A page anywhere in the week (SPEC §20.38), made where you are looking: on the tutorial's tab, what you add is the
  // tutorial's. Its `kind` follows the folder it lands in.
  const newPage = async folder => {
    if (folder === 'Notes') return writeNew()
    const title = await dialog.prompt({ title: `New page in ${folder || shortWeek(w.label)}`, label: here ? `What is it called? It will be the ${here.key}'s.` : 'What is it called?', value: '', confirmLabel: 'Create it' })
    if (!title?.trim()) return
    try {
      const dir = `${key}/${d.term}/${w.label}${folder ? '/' + folder : ''}`
      const p = (await api.createPage({ dir, title: title.trim() })).path
      await api.frontmatter(p, { kind: KIND_OF[folder] || 'notes', ...(here ? { for: here.key } : {}) }).catch(() => { })
      onOpen(p)
    } catch (e) { setNote(e.status === 409 ? `There is already a page called “${title.trim()}” there.` : `Could not make that page: ${e.message}`) }
  }
  const newCategory = async () => {
    const name = await dialog.prompt({ title: `A new category in ${shortWeek(w.label)}`, label: 'What kind of thing is it? (Readings, Labs, Handouts…)', value: '', confirmLabel: 'Next' })
    if (name?.trim()) await newPage(name.trim())
  }

  // What the panel draws: every shelf of this tab, plus the week's loose pages as one more (on All only). `folder` is
  // where this shelf's New page lands — null for the loose ones, which sit straight in the week.
  const FOLDER_OF = { lectures: 'Lectures', recordings: 'Recordings', problems: 'Problems', sheets: 'Study sheets', notes: 'Notes' }
  const shelves = [
    ...shown.map(s => ({ ...s, folder: s.custom ? s.title : FOLDER_OF[s.id] || s.title })),
    ...(tab === ALL && others.length ? [{ id: 'others', title: 'Loose in this week', icon: 'file', path: null, items: others, folder: null }] : []),
  ]
  const anything = count(panels[ALL]) > 0 || others.length > 0 || written
  // the tests still ahead whose weeks include this one: where the flag will be seen
  const reaches = (ctx.tests || []).filter(t => t.date >= today && t.window?.weeks?.includes(w.n))
  return (
    <div className="home week" style={{ '--c': c.color }}>
      <div className="home-head">
        <div>
          <div className="home-kicker">
            <button className="link" onClick={() => onOpenCourse(key)}>{c.code}</button> · <button className="link" onClick={() => onOpenTerm(`${key}/${d.term}`)}>{d.term}</button>
            {w.current ? ' · this week' : w.readingWeek ? ' · reading week' : w.elapsed ? ' · past' : ' · ahead'}
          </div>
          <h1 className="home-title">{shortWeek(w.label)}<span className="wk-span">{w.span}</span></h1>
          {/* What the outline calls this week — for an online course, which module it is (SPEC §20.52). */}
          {w.topic && <p className="wk-topic">{w.topic}</p>}
          {w.n && (d.review
            ? <p className="wk-review"><Flag kind="review" small />{d.review.note && <span className="wk-review-note">{d.review.note}</span>}
                {reaches.length > 0 && <span className="wk-review-on">on {reaches.map(t => t.title).join(', ')}</span>}
                <button className="link" onClick={() => flagWeek(true)}>Edit</button><button className="link" onClick={() => flagWeek(false)}>Unflag</button></p>
            : <p className="wk-review"><button className="link" onClick={() => flagWeek(true)} title="A flag and a line of what to go over, shown on the tests that cover this week">{I('bookmark', { width: 13, height: 13 })}Flag for review</button></p>)}
        </div>
        <div className="home-actions">
          <button className="btn" disabled={!d.prev} title="The week before" onClick={() => onOpenWeek(d.prev)}>‹ Previous</button>
          <button className="btn" disabled={!d.next} title="The week after" onClick={() => onOpenWeek(d.next)}>Next ›</button>
          <button className="btn primary" title={`${noteTitle(c.code, w.label)} — on ruled paper`} onClick={write}>
            <Icon.pencil width="14" height="14" />{written ? 'Continue your notes' : 'Take notes'}</button>
        </div>
      </div>
      {(d.weeks || []).length > 1 && (
        <nav className="wk-strip" aria-label={`Weeks of ${d.term}`}>
          <Track cells={d.weeks.map(x => {
            const t = (termData?.weeks || []).find(y => y.n === x.n)
            const test = t?.monday ? (ctx.tests || []).find(tt => tt.date >= t.monday && tt.date < addDays(t.monday, 7)) : null
            return { key: x.label, n: x.n, state: t?.state || (x.elapsed ? 'empty' : 'future'), current: x.current, open: x.label === w.label, flag: test ? testFlag(test.title) : null,
              title: `${x.label} · ${x.span}${test ? ` · ${test.title}` : ''}${x.label === w.label ? ' — this page' : ' — open the week'}`, onClick: () => x.label !== w.label && onOpenWeek(x.dir) }
          })} />
        </nav>)}
      {note && <div className="home-error">{note}</div>}
      {intro && <section className="card wk-intro"><MdLite md={intro} onOpenTitle={openTitle} /></section>}

      {/* The desk and the shelves (SPEC §20.64): the week's seven days and what there is to do in them on the left, every
          document filed in the week on shelves to the right, two by two, each document a card. */}
      <div className="wk-body">
        <div className="wk-left">
          <WeekCal d={d} rows={weekRows} today={today} />
          {/* What there is to do in the week — and, once it has gone by, what was missed (SPEC §20.54). */}
          <WeekTodo rows={weekRows} ready={!!plan} past={!!w.elapsed && !w.current} onToggle={tickRow} onOpen={onOpen} here={`${path}.md`} />
        </div>

      <section className="card wk-panel wk-shelves">
        {shelves.map(s => (
          <Shelf key={s.id} s={s} showFor={tab === ALL} forClass={here?.key || null}
            onOpen={onOpen} onOpenPair={onOpenPair} onOpenTitle={openTitle} onRemove={removePage}
            onRow={(r, st) => setRow(s.path, r, st)} onNew={() => newPage(s.folder)} />))}

        {coversFor(tab).map(cv => (
          <CoversShelf key={cv.key + cv.from.n} cv={cv} onOpen={onOpen} onOpenPair={onOpenPair} onOpenTitle={openTitle}
            onRow={(r, st) => setCoverRow(cv, r, st)} onOpenWeek={onOpenWeek} />))}

        <div className="wk-add">
          <span>Another shelf{here ? ` for the ${here.key}` : ''}:</span>
          {FOLDERS.filter(([f]) => !shelves.some(s => s.folder === f)).map(([f, ic]) => (
            <button key={f} className="wk-add-b" onClick={() => newPage(f)}>{I(ic, { width: 13, height: 13 })}{f}</button>))}
          <button className="wk-add-b" onClick={() => newPage(null)}>{I('file', { width: 13, height: 13 })}Loose page</button>
          <button className="wk-add-b" onClick={newCategory}>{I('plus', { width: 13, height: 13 })}A category of your own</button>
        </div>
      </section>
      </div>

      {!anything && <p className="blank wk-foot">Slides, recordings and problems file themselves into this week as they are posted.</p>}
    </div>
  )
}

// ---- the week as seven days (SPEC §20.64) --------------------------------------------------------------------------------
// One row per day: the day, its classes as blocks in the course's pigment with their time and room and what they are on,
// and how many things are wanted by that day. Today is gilt; days gone by are dimmed. The timetable's shape, folded to
// one week and one course, so the page opens on where the week's time actually goes.
function WeekCal({ d, rows, today }) {
  const w = d.week
  if (!w?.monday) return null
  const days = Array.from({ length: 7 }, (_, i) => addDays(w.monday, i))
  return (
    <section className="card wk-cal">
      <header className="wk-shelf-head"><span className="wk-shelf-ic">{I('calendar')}</span><h3>The week</h3><span className="wk-cal-span">{w.span}</span></header>
      <ol className="wk-cal-days">
        {days.map(date => {
          const ms = (d.meetings || []).filter(m => m.date === date)
          const due = rows.filter(r => r.by === date && !r.done && r.type !== 'in-class')
          const x = new Date(date + 'T12:00:00')
          return (
            <li key={date} className={'wk-cal-day' + (date === today ? ' today' : date < today ? ' past' : '')}>
              <span className="wk-cal-d"><b>{x.toLocaleDateString('en-CA', { weekday: 'short' })}</b><i>{x.getDate()}</i></span>
              <span className="wk-cal-main">
                {ms.map(m => (
                  <span key={m.id} className={'wk-cal-class' + (m.cancelled ? ' off' : '')} title={m.cancelled ? `Cancelled — ${m.cancelled}` : m.topic?.text || ''}>
                    <b>{String(m.kind)}</b><span>{m.start}–{m.end}{m.where ? ` · ${m.where}` : ''}</span>
                    {(m.cancelled || m.topic?.text) && <em>{m.cancelled || m.topic.text}</em>}
                  </span>))}
                {ms.length === 0 && due.length === 0 && <span className="wk-cal-none">—</span>}
              </span>
              {due.length > 0 && <span className="wk-cal-due" title={due.map(r => r.title).join('\n')}><i />{due.length} to do</span>}
            </li>)
        })}
      </ol>
    </section>)
}

// ---- what there is to do in the week (SPEC §20.54) -----------------------------------------------------------------------
// The same rows To do and Home draw, kept to this week and listed plainly: a tick, what kind of thing, what it is, whether
// a mark depends on it, how crucial, when — and *missed* in red once its day has passed unticked. A week that has gone by
// shows its done ones struck through beside what was missed, so the page answers "what did I not do" at a glance.
// `here`: this week's own page — a row whose button stands in for a dead link with its week (src/resolve.js) has nothing to
// open on the week it is already shown on.
function WeekTodo({ rows, ready, past, onToggle, onOpen, here = null }) {
  const counted = rows.filter(r => r.type !== 'sit')
  const done = counted.filter(r => r.done), missed = rows.filter(r => r.overdue)
  const go = a => { if (!a) return; if (a.url) window.open(a.url, '_blank', 'noopener'); else onOpen(a.path) }
  const tickable = r => r.type === 'prep' || r.type === 'week' || r.type === 'mine'
  return (
    <section className="card wk-todo">
      <header className="wk-shelf-head">
        <span className="wk-shelf-ic">{I('checklist')}</span>
        <h3>To do this week</h3>
        {counted.length > 0 && <span className={'wk-todo-sum' + (missed.length ? ' late' : '')}>{done.length} of {counted.length} done{missed.length ? ` · ${missed.length} missed` : ''}</span>}
      </header>
      {!ready ? <p className="wk-shelf-empty">Reading the plan…</p>
        : rows.length === 0 ? <p className="wk-shelf-empty">{past ? 'Nothing was listed for this week.' : 'Nothing listed for this week yet.'}</p> : (
          <ul className="wk-todo-list">
            {rows.map(r => (
              <li key={r.id} className={(r.done ? 'done' : '') + (r.overdue ? ' late' : '')}>
                {tickable(r)
                  ? <button className={'todo-tick' + (r.done ? ' on' : '')} onClick={() => onToggle(r)} title={r.done ? 'Not done after all' : 'Mark it done'}>{I('check', { width: 11, height: 11 })}</button>
                  : <span className="wk-todo-ic" title={r.type === 'sit' ? 'A test' : r.type === 'hand-in' ? 'Handed in on Quercus' : 'Happens in the class'}>{I(r.type === 'sit' ? 'board' : r.type === 'hand-in' ? 'external' : 'calendar', { width: 13, height: 13 })}</span>}
                <span className="wk-todo-kind">{r.kindLabel}</span>
                <span className="wk-todo-title">{r.title}</span>
                <span className="wk-todo-tail">
                  <Flags r={r} small />
                  <span className={'wk-todo-when' + (r.overdue ? ' late' : '')}>{r.when}</span>
                  {r.action && !r.inClass && !r.notOpen && !r.done && r.action.path !== here && <button className="link wk-todo-go" onClick={() => go(r.action)}>{r.action.label}</button>}
                </span>
              </li>))}
          </ul>)}
    </section>)
}

// ---- one shelf: a category, and the pages standing in it -------------------------------------------------------------
// Boxed and titled, so where one category ends and the next begins is never in doubt, and its own *New page* sits on
// its head rather than in one row at the foot of the screen that could mean any of them.
function Shelf({ s, showFor, forClass, onOpen, onOpenPair, onOpenTitle, onRow, onRemove, onNew }) {
  const n = countOf(s)
  return (
    <section className={'wk-shelf' + (s.id === 'problems' ? ' wk-wide' : '')} data-bucket={s.id}>
      <header className="wk-shelf-head">
        <span className="wk-shelf-ic">{I(s.icon, { width: 15, height: 15 })}</span>
        <h3>{s.title}</h3>
        {n > 0 && <span className="wk-shelf-n">{n}</span>}
        <button className="wk-shelf-new" onClick={onNew} title={`A new page in ${s.title}${forClass ? `, for the ${forClass}` : ''}`}>
          {I('plus', { width: 13, height: 13 })}New page</button>
      </header>
      {s.id === 'problems'
        ? <Problems sec={s} showFor={showFor} onOpen={onOpen} onOpenPair={onOpenPair} onOpenTitle={onOpenTitle} onRow={onRow} onRemove={onRemove} />
        : s.items.length > 0
          ? <div className="wk-items">{s.items.map(it => <ItemCard key={it.path} it={it} showFor={showFor} onOpen={onOpen} onRemove={onRemove} />)}</div>
          : <p className="wk-shelf-empty">Nothing here yet.</p>}
    </section>)
}

// ---- what a class works through, when that is not this week's folder (SPEC §20.50) -----------------------------------
// ECO206's tutorial meets on the Monday and works through the previous week's lecture. The week page is one folder, so
// Week 2 showed a tutorial on "Constrained Optimization" and not one page that phrase refers to, while the to-do for it
// jumped back to Week 1 — the same course, the same Monday, two screens that did not agree. The pages stay where they
// were filed; this shelf says which week they are in and opens them there. No remove button: they are not this week's
// to throw away.
const DAY_FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }
function CoversShelf({ cv, onOpen, onOpenPair, onOpenTitle, onRow, onOpenWeek }) {
  const n = cv.sets.length + cv.items.length
  return (
    <section className="wk-shelf wk-covers wk-wide" data-bucket={'covers:' + cv.key}>
      <header className="wk-shelf-head">
        <span className="wk-shelf-ic">{I('pencil', { width: 15, height: 15 })}</span>
        <h3>What {DAY_FULL[cv.day] || fmtDay(cv.date)}’s {String(cv.kind).toLowerCase()} covers</h3>
        {n > 0 && <span className="wk-shelf-n">{n}</span>}
        <button className="link wk-covers-from" title={`Open ${cv.from.label}`} onClick={() => onOpenWeek(cv.from.dir, cv.key)}>
          from {shortWeek(cv.from.label)}</button>
      </header>
      {cv.sets.length > 0 && (
        <Problems sec={{ sets: cv.sets, loose: [] }} showFor={false} onOpen={onOpen} onOpenPair={onOpenPair}
          onOpenTitle={onOpenTitle} onRow={onRow} onRemove={null} />)}
      {cv.items.length > 0 && (
        <div className="wk-items">{cv.items.map(it => <ItemCard key={it.path} it={it} showFor={false} onOpen={onOpen} onRemove={null} />)}</div>)}
    </section>)
}

// ---- the week's problems (SPEC §20.32, plainer §20.39) ----------------------------------------------------------------
// One card per set. The card opens the questions — that is what you want nine times out of ten, so it is the whole card
// and not one button among three — and the questions are chips you tick as you work: once when you have tried one,
// again once you have checked it against the solutions. There is no page of your own to make first: the questions are
// already here, and that is what you work on.
const NEXT = r => (!r.attempted ? { attempted: true, reviewed: false } : !r.reviewed ? { attempted: true, reviewed: true } : { attempted: false, reviewed: false })
const SAY = r => (r.reviewed ? 'tried, and checked against the solutions' : r.attempted ? 'tried' : 'not tried yet')

function Problems({ sec, showFor, onOpen, onOpenPair, onOpenTitle, onRow, onRemove }) {
  const sets = (sec.sets || []).filter(s => s.role !== 'guide'), guides = (sec.sets || []).filter(s => s.role === 'guide'), loose = sec.loose || []
  return (
    <div className="pb">
      {sets.length > 0 && <div className="pb-sets">{sets.map(s => <SetCard key={s.key} s={s} showFor={showFor} onOpen={onOpen} onOpenPair={onOpenPair} onRow={onRow} onRemove={onRemove} />)}</div>}
      {guides.length > 0 && (
        <div className="pb-guides">{guides.map(g => (
          <button key={g.key} className="pb-guide" onClick={() => onOpen(g.guide.path)} title={`Open ${g.name}`}>
            <span className="pb-guide-ic">{I('bookOpen', { width: 15, height: 15 })}</span>
            <span className="pb-guide-main"><b>{g.name}</b><small>{setSays(g)}</small></span>
            {I('chevron', { width: 14, height: 14 })}
          </button>))}</div>)}
      {loose.length > 0 && (
        <div className="pb-loose">
          <h4>{sets.length ? 'Also assigned, with no set filed here' : 'Assigned this week'}</h4>
          <ul>{loose.map(r => (
            <li key={r.key} className={r.attempted ? 'on' : ''}>
              <button className={'pb-box' + (r.reviewed ? ' reviewed' : r.attempted ? ' tried' : '')} title={`${SAY(r)} — click to change`} onClick={() => onRow(r, NEXT(r))}>{r.attempted && I('check', { width: 11, height: 11 })}</button>
              <span className="pb-loose-label">{labelText(r.label)}</span>
              {r.source?.title && <button className="link pb-src" title="Where this was asked" onClick={() => onOpenTitle(r.source.title)}>{String(r.source.title).replace(/_/g, ' ')}</button>}
            </li>))}</ul>
        </div>)}
      {(sets.some(s => s.rows.length) || loose.length > 0) && <p className="pb-help">Tick a question once when you have tried it, and again once you have checked it against the solutions.</p>}
    </div>)
}

function SetCard({ s, showFor, onOpen, onOpenPair, onRow, onRemove }) {
  const tried = s.rows.filter(r => r.attempted).length, checked = s.rows.filter(r => r.reviewed).length
  const open = s.questions || s.main
  const part = partOfSet(s)
  return (
    <article className="pb-set">
      <button className="pb-set-head" onClick={() => onOpen(open.path)} title={`Open ${open.title}`}>
        <span className="pb-set-ic">{I('pencil', { width: 16, height: 16 })}</span>
        <span className="pb-set-id">
          <span className="pb-set-name">{s.name}</span>
          <span className="pb-set-says">{setSays(s)}{s.rows.length ? ` · ${tried} of ${s.rows.length} tried${checked ? `, ${checked} checked` : ''}` : ''}</span>
        </span>
        {showFor && part && <span className="pill">{forSays(part)}</span>}
        <span className="pb-set-go">{I('chevron', { width: 15, height: 15 })}</span>
      </button>
      {onRemove && <button className="wk-x" title={`Remove ${s.name}`} onClick={() => onRemove({ path: s.main.path, title: s.name })}>{I('x', { width: 13, height: 13 })}</button>}
      {s.rows.length > 0 && (
        <div className="pb-qs">
          {s.rows.map(r => (
            <button key={r.key} className={'pb-q' + (r.reviewed ? ' reviewed' : r.attempted ? ' tried' : '')} title={`${r.part}: ${SAY(r)} — click to change`} onClick={() => onRow(r, NEXT(r))}>
              {r.part.replace(/^Q(?=\d)/i, '')}
            </button>))}
        </div>)}
      {s.questions && s.solutions && onOpenPair && (
        <button className="btn small pb-sol" title="The questions on the left, the solutions beside them" onClick={() => onOpenPair(s.questions.path, s.solutions.path)}>
          {I('eye', { width: 13, height: 13 })}With the solutions</button>)}
      {!s.questions && s.solutions && <button className="btn small pb-sol" onClick={() => onOpen(s.solutions.path)}>Open the solutions</button>}
    </article>)
}

// A document. A recording with no transcript carries its own Transcribe button (SPEC §20.36), so it is not opened just
// to find the one under its player; the week reloads on the transcript's file event.
function ItemCard({ it, showFor, onOpen, onRemove }) {
  // A page you wrote is measured in words however few there are; a filed document only once there is prose worth noting.
  const bits = [it.pdfs && `${it.pdfs} PDF${it.pdfs === 1 ? '' : 's'}`, it.media && `${it.media} recording${it.media === 1 ? '' : 's'}`, it.images && `${it.images} image${it.images === 1 ? '' : 's'}`, it.transcribed && 'transcribed', it.words > (it.sheet ? 0 : 30) && `${it.words} word${it.words === 1 ? '' : 's'}`].filter(Boolean)
  const needs = it.media > 0 && !it.transcribed
  const stt = useTranscribe(needs ? it.path : null)
  const part = partOf(it)
  return (
    <div className="wk-item">
      <button className="wk-item-open" onClick={() => onOpen(it.path)} title={`Open ${it.title}`}>
        <span className="wk-item-title">{it.title.replace(/\s*\((\d{4}-\d{2}-\d{2})\)$/, '').replace(/_/g, ' ')}</span>
        {showFor && part && <span className="pill wk-item-for">{forSays(part)}</span>}
        {it.date && <span className="wk-item-date">{fmtDay(it.date)}</span>}
        <span className="chiprow">{bits.length ? bits.map((b, i) => <span key={i} className="pill">{b}</span>) : <span className="pill">empty page</span>}</span>
      </button>
      {needs && !stt.off && (stt.busy
        ? <span className="wk-item-tr" title={stt.say}>{stt.phase === 'queued' ? stt.say : 'Transcribing…'}</span>
        : <button className="btn small" onClick={stt.start} title={stt.phase === 'error' ? stt.note : 'Turn the recording into text, on this computer'}>{stt.phase === 'error' ? 'Try again' : 'Transcribe'}</button>)}
      {/* The week's own sheet is the one page a week always has: it empties rather than leaves. */}
      {onRemove && !it.sheet && <button className="wk-x" title={`Remove ${it.title}`} onClick={() => onRemove(it)}>{I('x', { width: 13, height: 13 })}</button>}
    </div>)
}
