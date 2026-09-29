import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { Flags } from './Flags.jsx'
import { THIS as ED } from '../edition.js'
import { kindIcon } from '../kinds.js'
import GradeSim from './GradeSim.jsx'
import { CoverageBars, usePlan, toggleTask } from './plan/PlanBits.jsx'
import TaskSheet, { taskItem } from './TaskSheet.jsx'
import { rowsFor, practiceRows } from '../todo.js'
import More from './More.jsx'
import { Ring, Meter, Track, Stack, Timeline, LoadStrip, testFlag as flagOf } from './Viz.jsx'
import { standing, componentScore } from '../grade.js'
import { addDays, daysTo, localParts } from '../plan.js'
import { parseProblemsBlock, findProblemsBlock, withScore, labelText, pairSets } from '../problems.js'
import { useMyTasks, AddTask, toggleMyTask, removeMyTask } from './MyTasks.jsx'
import '../styles/screens.css'
import '../styles/course.css'

// The course screen (SPEC §20.4, redrawn §20.24, rebuilt §20.35): one screen per course in the Home slot, a read-only view of
// GET /api/course assembled from files that already exist. Files are the truth: a watcher event under the notebook or
// on the Hub files it reads reloads the screen (debounced), so a task ticked on a Problems page or a sheet the 10:00
// build wrote shows within a second. Its own writes are two: Confirm/Undo (POST /api/study/confirm, as on Home) and
// the score field of a set row (PUT /api/page with the base hash, the row rewritten by src/problems.js withScore).
// Esc returns to Home.
//
// A dashboard, not a column of bands (SPEC §20.35). The page was one tall stack of cards that all looked alike, so it read
// as a list to scroll rather than a course to understand. The term runs along the top as a row of weeks. The left
// column is what to do, in the order it is asked: prepare for the next class — for a course with no classes, this
// week's work — then the rest of the list by date, practice, and what the professor said. The right column is where
// you are: the next test, the dates ahead, what the mark is made of, what this week holds, what the course is. Each
// draws its facts its own way — a ring, rows by date, meters, a feed, a countdown, a timeline, a stacked bar, a grid of
// counts. Everything rarer is behind one More.
// props: { courseKey, initialTerm, onOpen(path), onOpenSection(path), onOpenWeek(path, tab), onHome(), onTake() }
const HUB_FILES = new Set(['Hub/_hub.json', 'Hub/_study-queue.json', 'Hub/_plan.json', 'Hub/_problems.json'])
const fmtDay = iso => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '')
const fmtShort = iso => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '')
const fmt = iso => (iso ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const inDays = n => (n < 0 ? `${-n} days ago` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 14 ? `in ${n} days` : `in ${Math.round(n / 7)} weeks`)
const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`
const TEST_HORIZON = 14
const mins = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0) }
const dayName = iso => new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long' })
const TODO_IC = { sit: 'board', 'hand-in': 'pencil', 'in-class': 'calendar', prep: 'checklist', mine: 'checklist', practice: 'pencil', 'prep-set': 'pencil', week: 'checklist' }
const I = (name, p = { width: 15, height: 15 }) => (Icon[name] || Icon.file)(p)
// Something to open, and somewhere worth going: not a room you sit in, not a thing that has not opened yet.
const doable = r => !!r.action && !r.inClass && !r.notOpen

export default function CourseScreen({ courseKey, initialTerm, onOpen, onOpenSection, onOpenWeek, onHome, onTake, onDay }) {
  const [d, setD] = useState(null), [error, setError] = useState(null), [note, setNote] = useState(null)
  const seq = useRef(0)
  const load = () => { const n = ++seq.current; return api.course(courseKey).then(x => { if (n === seq.current) { setD(x); setError(null) } }).catch(e => { if (n === seq.current) setError(e.message) }) }
  useEffect(() => { load() }, [courseKey])
  // Reload on any event under this notebook or on the Hub files the route reads (debounced: the 10:00 build writes many files).
  useEffect(() => {
    let t = null
    const off = api.events(ev => { const p = ev.path || ''; if (p.startsWith(courseKey + '/') || HUB_FILES.has(p)) { clearTimeout(t); t = setTimeout(load, 600) } })
    return () => { off(); clearTimeout(t) }
  }, [courseKey])
  // Esc goes back to Home, as it closed the popover this screen replaces — unless a field or a dialog has the keyboard.
  useEffect(() => {
    const h = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const a = document.activeElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName || '') || a?.isContentEditable || document.querySelector('.modal-backdrop, .cs-scrim')) return
      onHome()
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onHome])
  const confirm = async (key, on) => { try { await api.confirmSheet(key, on) } catch (e) { setNote(e.message) } load() }
  const { plan, refresh: refreshPlan, patch } = usePlan({ refresh: true })
  // Ticking from the sheet writes through the same PUT /api/page the editor uses.
  const tick = async (m, t) => {
    try {
      if (!(await toggleTask(m, t))) return
      const flip = list => list.map(y => (y.key === t.key ? { ...y, done: !y.done } : y))
      patch(pl => pl ? { ...pl, meetings: pl.meetings.map(x => x.id !== m.id ? x : { ...x, before: flip(x.before) }), weeks: (pl.weeks || []).map(x => x.id !== m.id ? x : { ...x, work: flip(x.work) }) } : pl)
      refreshPlan()
    } catch (e) { setNote(`Could not tick that: ${e.message}`) }
  }
  const [titles, setTitles] = useState([])
  const [sheet, setSheet] = useState(null)
  const [calc, setCalc] = useState(false)   // the mark calculator, opened from Your mark
  useEffect(() => { api.titles().then(setTitles).catch(() => {}) }, [])
  // Your own tasks for this course (SPEC §20.32), ticked and deleted on their own page.
  const mine = useMyTasks(d?.course?.code ? [d.course.code] : [])
  const tickRow = async r => {
    if (r.type !== 'mine') return tick(r.meeting, r.task)
    try { await toggleMyTask(r.raw); mine.reload() } catch (e) { setNote(`Could not tick that: ${e.message}`) }
  }
  const removeRow = async r => { try { await removeMyTask(r.raw); mine.reload() } catch (e) { setNote(`Could not delete that: ${e.message}`) } }
  // Which term runs along the top. Defaults to the one the sidebar asked for, else the one you are in.
  const [term, setTerm] = useState(initialTerm || null)
  useEffect(() => { setTerm(initialTerm || null) }, [courseKey, initialTerm])
  const activeTerm = term || d?.week?.term || (d?.terms || [])[0] || null
  // Every week of that term, for the row of weeks: /api/course carries only the weeks up to the next test.
  const [termData, setTermData] = useState(null)
  useEffect(() => {
    if (!activeTerm) { setTermData(null); return }
    let alive = true
    api.term(courseKey, activeTerm).then(x => { if (alive) setTermData(x) }).catch(() => { if (alive) setTermData(null) })
    return () => { alive = false }
  }, [courseKey, activeTerm, d?.builtAt])

  // What this course wants from you, from the one row model (src/todo.js) — the same rows To do and Home build, so a
  // checkpoint quiz that happens in a tutorial room never grows an "Open in Quercus" button here alone (SPEC §20.24).
  const rows = useMemo(() => {
    if (!d) return []
    const ctx = { titles, links: d.links.items, general: d.general, courseUrl: d.course.url }
    return rowsFor({ plan, hub: { deadlines: d.deadlines }, tests: d.tests, today: d.today, now: d.now?.slice(11, 16) || null, courseKey, testHorizon: TEST_HORIZON, ctxFor: () => ctx, mine: mine.tasks, courses: [d.course] })
      .map(r => (r.color ? r : { ...r, color: d.course.color }))
  }, [d, plan, titles, courseKey, mine.tasks])
  // What is worth doing when there is time: the week's problem sets and guides, last week to next (SPEC §20.33).
  const practice = useMemo(() => (d ? practiceRows({ weeks: d.problems?.weeks || [], course: d.course, today: d.today, curN: d.week?.n ?? null }) : []), [d])
  // The next two weeks of this course, day by day (SPEC §20.64): its classes and everything it wants — Home's load strip,
  // kept to one course, so a heavy Monday is seen from the course as well as from the week.
  const courseLoad = useMemo(() => {
    if (!d) return []
    return Array.from({ length: 14 }, (_, i) => addDays(d.today, i)).map(date => {
      const classes = (plan?.meetings || []).filter(m => m.courseKey === courseKey && m.date === date && !m.cancelled)
        .map(m => { const start = m.announced?.start || m.start, end = m.announced?.end || m.end; return { course: m.course, color: m.color, kind: m.kind, start, end, minutes: Math.max(0, mins(end) - mins(start)) } })
      const due = rows.filter(r => r.by === date && !r.done)
      return { date, classes, minutes: classes.reduce((a, x) => a + x.minutes, 0), due }
    })
  }, [d, plan, rows, courseKey])

  if (error && !d) return <div className="home course-screen"><div className="home-empty"><p>{error}</p><button className="btn" onClick={onHome}>Back to Home</button></div></div>
  if (!d) return <div className="home course-screen" />
  const c = d.course, nc = d.nextClass || {}
  const go = a => { if (!a) return; if (a.url) window.open(a.url, '_blank', 'noopener'); else onOpen(a.path) }
  const pick = r => setSheet(sheetOf(r, { titles, links: d.links.items, general: d.general, courseUrl: d.course.url }, d.today, tickRow, removeRow))
  // A course with no classes (an online course) has no next class to prepare for: its first card is this week's work.
  const noClasses = !(c.meetings || []).length
  // The first card's tasks are left out of the list below it, so a task is on the page once.
  const first = noClasses
    ? rows.filter(r => r.weekWork)
    : nc.date ? [...rows.filter(r => r.next), ...practice.filter(p => p.type === 'prep-set' && p.meetingDate === nc.date && /tutorial/i.test(nc.kind || ''))] : []
  const inFirst = new Set(first.map(r => r.id))
  // His own tasks due within the week head the rest, ahead of the backlog, so one he just added is seen (SPEC §23).
  const ownSoon = r => (r.type === 'mine' && !r.done && !r.overdue && r.by !== '9999-12-31' && r.by <= addDays(d.today, 7) ? 0 : 1)
  const rest = [...rows.filter(r => !inFirst.has(r.id) && !r.optional), ...practice.filter(p => p.type === 'prep-set' && !inFirst.has(p.id))]
    .sort((a, b) => ownSoon(a) - ownSoon(b) || a.by.localeCompare(b.by) || a.priority.rank - b.priority.rank)
  const extra = [...practice.filter(p => p.type === 'practice'), ...rows.filter(r => r.optional && !inFirst.has(r.id))]
  // The three numbers cut into the cover (SPEC §20.64): the next class and how ready you are for it, the next test, the mark.
  const doneFirst = first.filter(r => r.done).length
  const test0 = d.tests[0], st = c.grading ? standing(c.grading, c.scores || {}) : null
  const dial = [
    noClasses
      ? (d.week ? { n: Math.max(0, daysTo(addDays(d.week.monday, 6), d.today)), unit: 'days', cap: `left in the week · ${doneFirst} of ${first.length} done` } : { n: '—', cap: 'between terms' })
      : nc.date ? { n: nc.now ? 'now' : nc.inDays === 0 ? 'today' : nc.inDays, unit: nc.now || nc.inDays === 0 ? '' : nc.inDays === 1 ? 'day' : 'days', cap: `to ${dayName(nc.date)}'s ${String(nc.kind || 'class').toLowerCase()} · ${doneFirst} of ${first.length} prepared` }
      : { n: '—', cap: nc.why === 'reading week' ? 'reading week' : nc.why === 'between terms' ? 'between terms' : 'no class on the timetable' },
    test0 ? { n: test0.inDays, unit: test0.inDays === 1 ? 'day' : 'days', cap: `to ${String(test0.title).split(' · ')[0]} · ${fmtShort(test0.date)}` } : { n: '—', cap: 'no test dated yet' },
    st?.best?.grade != null ? { n: st.best.grade.toFixed(0), unit: '%', cap: `mark so far · ${Math.round(st.best.weightKnown || 0)} % of the course marked` } : { n: '—', cap: c.grading ? 'nothing marked yet' : 'no marking scheme on file' },
  ]

  return (
    <div className="home course-screen" style={{ '--c': c.color }}>
      <Head d={d} term={activeTerm} termData={termData} setTerm={setTerm} onOpenWeek={onOpenWeek} onTake={onTake} dial={dial} />
      {(note || (error && d)) && <div className="home-error">{note || error}</div>}

      <section className="card cx-load">
        <h2><span className="grow">The next two weeks</span><span className="card-note">hours of class and what is wanted, day by day · click a day to see it on To do</span></h2>
        <LoadStrip load={courseLoad} today={d.today} onDay={onDay} heads />
      </section>

      <div className="cx">
        <div className="cx-main">
          {noClasses
            ? <WeekWork d={d} rows={first} onPick={pick} onTick={tickRow} go={go} />
            : <Prepare d={d} rows={first} onPick={pick} onTick={tickRow} go={go} />}
          <OnYourList d={d} rows={rest} onPick={pick} onTick={tickRow} go={go} onAdded={mine.reload} />
          <Holds d={d} onOpen={onOpen} onOpenWeek={onOpenWeek} />
          <Practice d={d} rows={extra} onPick={pick} go={go} onOpenWeek={onOpenWeek} />
          <Announcements d={d} onOpen={onOpen} />
        </div>
        <aside className="cx-side">
          <NextTest d={d} onOpen={onOpen} onOpenWeek={onOpenWeek} />
          <ComingUp d={d} termData={termData} onOpen={onOpen} />
          <Mark c={c} today={d.today} onOpen={onOpen} open={calc} onToggle={() => setCalc(x => !x)} />
          <About d={d} onOpenSection={onOpenSection} />
        </aside>
      </div>

      <More label="Everything else">
        <Problems d={d} onOpen={onOpen} onOpenWeek={onOpenWeek} onChanged={load} onNote={setNote} />
        {ED.sheets && <Sheets d={d} onOpen={onOpen} onConfirm={confirm} />}
        <LinksAdmin d={d} onOpen={onOpen} onOpenSection={onOpenSection} />
        {d.tests.length > 1 && <section className="card"><h2>Every test after this one</h2>
          <ul className="list">{d.tests.slice(1).map(x => (
            <li key={x.date}><span className="grow">{x.title}{x.detail && <small>{x.detail}</small>}</span><span className="when">{fmtDay(x.date)}</span></li>))}</ul></section>}
      </More>
      {calc && c.grading && <Calculator c={c} onClose={() => setCalc(false)} />}
      {sheet && <TaskSheet item={sheet} onClose={() => setSheet(null)} onOpen={onOpen} onToggle={sheet.onToggle} onDelete={sheet.onDelete} />}
    </div>
  )
}

// ---- the head: the course, where the term is, and the term itself as a row of weeks ------------------------------------
// The big glass header carried the professor, the rooms, the textbook and the weights — facts read once a term — above
// everything asked daily. It is one line now, and the facts moved to About at the bottom of the right column. The term
// replaced "Every week", a grid of thirteen cards: one cell per week, its colour saying what the week holds, a flag
// over a week with a test in it, a click opening the week.
function Head({ d, term, termData, setTerm, onOpenWeek, onTake, dial = [] }) {
  const c = d.course, w = d.week
  const weeks = termData?.term === term ? termData.weeks || [] : []
  const cells = weeks.map(x => {
    const test = d.tests.find(t => x.monday && t.date >= x.monday && t.date < addDays(x.monday, 7))
    return {
      key: x.label, n: x.n, state: x.readingWeek ? 'future' : x.state, current: x.current, flag: test ? flagOf(test.title) : null,
      title: `${x.label} · ${x.span}${x.readingWeek ? ' · reading week' : ''}${test ? ` · ${test.title}` : ''} — open the week`,
      onClick: () => onOpenWeek?.(`${c.key}/${term}/${x.label}`),
    }
  })
  return (
    <header className="cx-head">
      <div className="cx-head-top">
        <div className="cx-id">
          <span className="cd-code">{c.code}</span>
          <h1 className="cx-name">{c.name}</h1>
          <p className="cx-meta">
            {w ? `${w.term} · ${w.readingWeek ? 'reading week' : `week ${w.n}${weeks.length ? ` of ${weeks.length}` : ''}`}` : 'Between terms'}
            {c.professor ? ` · ${c.professor}` : ''}
          </p>
        </div>
        <div className="cx-actions">
          {w && <button className="btn" onClick={() => onOpenWeek?.(w.dir ? `${c.key}/${w.dir}` : w.page)}>Open this week</button>}
          <button className="btn primary" title={`Take notes for ${c.code}`} onClick={() => onTake?.()}><Icon.pencil width="14" height="14" />Take notes</button>
        </div>
      </div>
      {dial.length > 0 && (
        <div className="cx-dial" role="group" aria-label="The course at a glance">
          {dial.map((x, i) => <div key={i}><b>{x.n}{x.unit ? <small>{x.unit}</small> : null}</b><span>{x.cap}</span></div>)}
        </div>)}
      {cells.length > 0 && (
        <div className="cx-term">
          <div className="cx-term-k">
            {(d.terms || []).length > 1
              ? <span className="tabs">{d.terms.map(t => <button key={t} className={'tab' + (t === term ? ' on' : '')} onClick={() => setTerm(t)}>{t}</button>)}</span>
              : <b>{term}</b>}
            <span className="cx-legend"><i className="lg-done" />{ED.sheets ? 'study sheet' : 'worked on'}<i className="lg-partial" />material<i className="lg-empty" />nothing filed<i className="lg-future" />ahead</span>
          </div>
          <Track cells={cells} />
        </div>)}
    </header>)
}

// ---- prepare for the next class (SPEC §20.33, first on the page §20.35) ------------------------------------------------
const BigDay = ({ iso }) => {
  const x = new Date(String(iso).slice(0, 10) + 'T12:00:00')
  return <span className="cx-bigday"><b>{x.toLocaleDateString('en-CA', { weekday: 'short' })}</b><strong>{x.getDate()}</strong><span>{x.toLocaleDateString('en-CA', { month: 'short' })}</span></span>
}

function Prepare({ d, rows, onPick, onTick, go }) {
  const nc = d.nextClass || {}
  if (!nc.date) return (
    <section className="card cx-prep">
      <div className="cx-k">Prepare for your next class</div>
      <p className="cx-prep-none">{nc.why === 'reading week' ? 'Reading week — no classes this week.' : nc.why === 'between terms' ? 'Between terms — the next class appears when the term starts.' : 'No class on the timetable.'}</p>
    </section>)
  const done = rows.filter(r => r.done).length
  const kind = String(nc.kind || 'class').toLowerCase()
  return (
    <section className="card cx-prep">
      <div className="cx-prep-head">
        <BigDay iso={nc.date} />
        <div className="cx-prep-what">
          <div className="cx-k">Prepare for your next class</div>
          <h2 className="cx-prep-title">{nc.kind}{nc.where && <span> · {nc.where}</span>}</h2>
          <p className="cx-prep-when">{fmtDay(nc.date)} · {nc.start}–{nc.end} · <b>{nc.now ? 'on now' : inDays(nc.inDays)}</b>{nc.changed ? ' · changed by an announcement' : ''}</p>
          {nc.topic?.text && <p className="cx-prep-topic">On {nc.topic.text}</p>}
        </div>
        {rows.length > 0 && <Ring value={done} total={rows.length} size={78} stroke={8} sub="done" title={`${done} of ${rows.length} done before the ${kind}`} />}
      </div>
      {rows.length === 0
        ? <p className="cx-prep-none">Nothing to prepare for this {kind}{nc.topic?.text ? ` — it is on ${nc.topic.text}` : ''}.</p>
        : <ul className="cx-check">{rows.map(r => <CheckRow key={r.id} r={r} onPick={onPick} onTick={onTick} go={go} />)}</ul>}
    </section>)
}

// A course with no classes — lectures recorded, readings posted — is prepared for a week at a time (SPEC §20.35): the
// week's readings, its lectures to watch and its participation, each a task ticked like any other.
function WeekWork({ d, rows, onPick, onTick, go }) {
  const w = d.week
  if (!w) return <section className="card cx-prep"><div className="cx-k">This week's work</div><p className="cx-prep-none">Between terms — the work appears when the term starts.</p></section>
  const done = rows.filter(r => r.done).length
  const left = daysTo(addDays(w.monday, 6), d.today)
  return (
    <section className="card cx-prep">
      <div className="cx-prep-head">
        <span className="cx-bigday"><b>Week</b><strong>{w.n}</strong><span>{fmtShort(w.monday)}</span></span>
        <div className="cx-prep-what">
          <div className="cx-k">This week's work</div>
          <h2 className="cx-prep-title">{w.topic || w.label.replace(/\s*\(.*\)$/, '')}</h2>
          <p className="cx-prep-when">{w.span} · at your own pace · <b>{left <= 0 ? 'the week ends today' : `${plural(left, 'day')} left in the week`}</b></p>
        </div>
        {rows.length > 0 && <Ring value={done} total={rows.length} size={78} stroke={8} sub="done" title={`${done} of ${rows.length} done this week`} />}
      </div>
      {rows.length === 0
        ? <p className="cx-prep-none">Nothing listed for this week yet — readings and lectures appear here as Quercus posts them.</p>
        : <ul className="cx-check">{rows.map(r => <CheckRow key={r.id} r={r} onPick={onPick} onTick={onTick} go={go} />)}</ul>}
    </section>)
}

function CheckRow({ r, onPick, onTick, go }) {
  const s = r.set
  const tickable = (r.type === 'prep' || r.type === 'mine' || r.type === 'week') && r.canTick
  return (
    <li className={'cx-check-row' + (r.done ? ' done' : '')}>
      {tickable
        ? <button className={'todo-tick' + (r.done ? ' on' : '')} onClick={() => onTick(r)} title={r.done ? 'Not done after all' : 'Mark it done'}><Icon.check width="12" height="12" /></button>
        : <span className="cx-check-ic" title={r.inClass ? 'Happens in the class' : undefined}>{I(r.kindLabel === 'Guide' ? 'bookOpen' : TODO_IC[r.type] || 'checklist', { width: 14, height: 14 })}</span>}
      <span className="cx-check-main">
        <button className="cx-check-title" onClick={() => onPick(r)} title="Open it on its own">{r.title}</button>
        <small>
          <span>{r.inClass ? String(r.when).split(' · ')[0] : r.kindLabel}</span>
          {s?.total > 0 && <><Meter value={s.tried} strong={s.checked} total={s.total} title={`${s.tried} of ${s.total} tried`} /><span>{s.tried}/{s.total} tried</span></>}
          <Flags r={r} small importantToo={false} />
        </small>
      </span>
      {doable(r) && !r.done && <button className="btn small" onClick={() => go(r.action)} title={r.action.fallback ? 'This one has no link of its own — the course page in Quercus is the nearest thing' : r.action.label}>{r.action.fallback ? 'Quercus' : r.action.label}</button>}
    </li>)
}

// ---- the rest of the list, as rows by date ----------------------------------------------------------------------------
function OnYourList({ d, rows, onPick, onTick, go, onAdded }) {
  const [adding, setAdding] = useState(false), [all, setAll] = useState(false)
  const open = rows.filter(r => !r.done)
  const shown = all ? open : open.slice(0, 6)
  return (
    <section className="card cx-list">
      <h2><span className="grow">Also on your list</span>
        <span className="card-note">{open.length ? plural(open.length, 'thing') : 'nothing else'}</span>
        <button className="link" onClick={() => setAdding(a => !a)}>{adding ? 'Done adding' : 'Add a task'}</button></h2>
      {adding && <AddTask courses={[d.course]} defaultCourse={d.course.key} autoFocus onAdded={onAdded} onCancel={() => setAdding(false)} />}
      {open.length === 0 ? <p className="blank">Nothing else is wanted from this course yet.</p> : (
        <ul className="cx-rows">{shown.map(r => {
          const tickable = (r.type === 'prep' || r.type === 'mine' || r.type === 'week') && r.canTick
          return (
            <li key={r.id} className={'cx-row p-' + r.priority.level}>
              <span className={'cx-row-when' + (r.deadline && r.deadline.daysLeft <= 1 ? ' urgent' : '')}>
                {r.deadline ? <><b>{r.deadline.day}</b><small>{r.deadline.rel}</small></> : <><b>No date</b><small>whenever</small></>}
              </span>
              {tickable
                ? <button className={'todo-tick' + (r.done ? ' on' : '')} onClick={() => onTick(r)} title="Mark it done"><Icon.check width="12" height="12" /></button>
                : <span className="cx-check-ic">{I(TODO_IC[r.type] || 'checklist', { width: 14, height: 14 })}</span>}
              <span className="cx-row-main">
                <button className="cx-row-title" onClick={() => onPick(r)} title="Open it on its own">{r.title}</button>
                <small>
                  <span>{r.inClass ? String(r.when).split(' · ')[0] : r.kindLabel}</span>
                  <Flags r={r} small />
                </small>
              </span>
              {doable(r) ? <button className="btn small" onClick={() => go(r.action)}>{r.action.fallback ? 'Quercus' : r.action.label}</button> : <span />}
            </li>)
        })}</ul>)}
      {open.length > 6 && <button className="link cd-more" onClick={() => setAll(a => !a)}>{all ? 'Fewer' : `All ${open.length}`}</button>}
    </section>)
}

// ---- practice: problem sets and guides, each with how far it has got --------------------------------------------------
function Practice({ d, rows, onPick, go, onOpenWeek }) {
  const w = d.thisWeek
  if (!rows.length) return null
  return (
    <section className="card cx-practice">
      <h2><span className="grow">Practice</span><span className="card-note">not marked · when you have time</span>
        {w?.problems && <button className="link" onClick={() => onOpenWeek?.(w.dir, 'problems')}>This week's problems</button>}</h2>
      <ul className="cx-sets">{rows.map(r => {
        const s = r.set
        const where = r.type === 'practice' ? String(r.when).split(' · ')[0] : r.when
        return (
          <li key={r.id} className="cx-set">
            <span className="cx-set-ic">{I(r.kindLabel === 'Guide' ? 'bookOpen' : 'pencil', { width: 15, height: 15 })}</span>
            <span className="cx-set-main">
              <button className="cx-set-title" onClick={() => onPick(r)} title="Open it on its own">{r.title}</button>
              <small>{[where, s?.says || r.kindLabel].filter(Boolean).join(' · ')}</small>
            </span>
            {s?.total > 0
              ? <span className="cx-set-meter"><Meter value={s.tried} strong={s.checked} total={s.total} wide title={`${s.tried} tried, ${s.checked} checked, of ${s.total}`} /><b>{s.tried}/{s.total}</b></span>
              : <span className="cx-set-meter" />}
            {r.action ? <button className="btn small" onClick={() => go(r.action)}>{r.action.label}</button> : <span />}
          </li>)
      })}</ul>
    </section>)
}

// ---- the right column ---------------------------------------------------------------------------------------------------
// The next test as a countdown, then the weeks it covers and how ready you are.
function NextTest({ d, onOpen, onOpenWeek }) {
  const t = d.tests[0], r = d.readiness
  if (!t) return <section className="card cx-test"><h2>Next test</h2><p className="blank">No test dates known yet.</p></section>
  return (
    <section className="card cx-test">
      <h2><span className="grow">Next test</span><button className="link" onClick={() => onOpen('Hub/Today/Tests.md')}>All tests</button></h2>
      <div className="cx-count"><b>{t.inDays}</b><span>{t.inDays === 1 ? 'day' : 'days'} to go</span></div>
      <div className="cx-test-title">{t.title}</div>
      <div className="cx-test-sub">{fmtDay(t.date)}{t.detail ? ` · ${t.detail}` : ''}</div>
      {r && (
        <div className="cd-ready">
          <div className="cx-test-cover">Covers {r.window?.label || `weeks ${r.from}–${r.to}`}{r.window?.assumed ? ' — a best guess' : ''}</div>
          <div className="cd-strip">{r.weeks.map(w => (
            <button key={w.n} className={'cd-cell ' + w.state + (w.current ? ' current' : '')} onClick={() => onOpenWeek?.(w.page.replace(/\.md$/, ''))}
              title={`${w.label} · ${w.state === 'future' ? 'not yet' : w.state === 'done' ? (ED.sheets ? `${plural(w.sheets, 'study sheet')}` : 'you have worked on it') : w.state === 'partial' ? (ED.sheets ? 'material, no study sheet' : 'material, nothing written yet') : 'nothing arrived'}`} />))}</div>
          <div className="cd-strip-labels"><span>Week {r.from}</span><span>Week {r.to}</span></div>
          <CoverageBars test={{ coverage: r.counts, window: r.window }} compact />
        </div>)}
    </section>)
}

// Every dated thing ahead — tests, hand-ins, marked work outside the tests, reading week — on one line of dates.
function ComingUp({ d, termData, onOpen }) {
  const today = d.today, c = d.course
  const testDates = new Set(d.tests.map(t => t.date))
  const graded = (c.grading?.components || []).filter(x => x.key !== 'tests')
    .flatMap(x => (x.items || []).filter(i => i.date && !testDates.has(i.date)).map(i => ({ ...i, comp: x.label })))
  const items = [
    ...d.tests.map(t => ({ key: 't' + t.date, date: t.date, title: t.title, sub: [t.window?.label && `covers ${t.window.label}`, t.detail].filter(Boolean).join(' · '), tone: 'test', onClick: () => onOpen('Hub/Today/Tests.md') })),
    // the Toronto day of a Quercus stamp, as the rows read it (src/todo.js dueRow, SPEC §20.52)
    ...(d.deadlines || []).map(x => { const lp = localParts(x.due), t = x.dueTime !== undefined ? x.dueTime : lp.time; return { key: 'd' + x.title + (x.dueDate || x.due), date: x.dueDate || lp.date, title: x.title, tone: 'due',
      sub: `due${t ? ` at ${t}` : ''}${x.points ? ` · ${x.points} points` : ''}`, onClick: x.url ? () => window.open(x.url, '_blank', 'noopener') : x.page ? () => onOpen(x.page) : null } }),
    ...graded.map(i => ({ key: 'g' + i.key + i.date, date: i.date, title: i.label, sub: i.comp, tone: 'due' })),
    ...(termData?.weeks || []).filter(x => x.readingWeek && x.monday).map(x => ({ key: 'rw' + x.monday, date: x.monday, title: 'Reading week', sub: 'no classes', tone: 'plain' })),
  ].filter(x => x.date && x.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6)
    .map(x => ({ ...x, day: fmtDay(x.date), rel: inDays(daysTo(x.date, today)) }))
  return (
    <section className="card cx-coming">
      <h2>Coming up</h2>
      {items.length === 0 ? <p className="blank">Nothing dated ahead.</p> : <Timeline items={items} />}
    </section>)
}

// What the mark is made of, as one bar: each part as wide as its weight, filled as far as it has been marked.
function Mark({ c, today, onOpen, open, onToggle }) {
  const g = c.grading
  if (!g) return <section className="card cx-mark"><h2>Your mark</h2><p className="blank">No marking scheme on file for this course yet.</p></section>
  const scores = c.scores || {}, scheme = g.schemes[0]
  const parts = g.components.filter(x => !x.bonus && scheme.weights[x.key] != null).map(x => {
    const s = componentScore(x, scheme, scores)
    const next = (x.items || []).find(i => i.date && i.date >= today && scores[x.key]?.[i.key] == null)
    return {
      key: x.key, label: x.label, weight: scheme.weights[x.key], filled: s.total ? Math.min(s.known, s.total) / s.total : 0,
      note: s.known ? `${Math.min(s.known, s.total)} of ${s.total} marked` : next ? `first ${fmtShort(next.date)}` : x.many ? 'as they come' : '',
    }
  })
  const bonus = g.components.filter(x => x.bonus)
  const st = standing(g, scores)
  return (
    <section className="card cx-mark">
      <h2><span className="grow">Your mark</span><button className="link" onClick={() => onOpen('Hub/Today/Grades.md')}>Every course</button></h2>
      <div className="cx-mark-now">
        {st.best?.grade == null
          ? <b className="none">Nothing marked yet</b>
          : <><b>{st.best.grade.toFixed(1)}<small>%</small></b>{st.letter && <span className="sim-letter">{st.letter}</span>}</>}
        <span>{Math.round(st.best?.weightKnown || 0)}% of the course marked</span>
      </div>
      <Stack parts={parts} />
      {(g.schemes.length > 1 || bonus.length > 0) && (
        <p className="cx-mark-note">{[
          g.schemes.length > 1 && `Counted two ways — ${g.schemes.map(s => s.name).join(' or ')} — and the better one is used.`,
          ...bonus.map(b => `${b.label} adds up to ${Math.round(b.bonus * 100)}% on top.`),
        ].filter(Boolean).join(' ')}</p>)}
      <button className="btn small cx-mark-go" onClick={onToggle}>{open ? 'Close the calculator' : 'What do I need for an A?'}</button>
    </section>)
}

// The calculator over the page, rather than a card nobody scrolled to.
function Calculator({ c, onClose }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true)
  }, [onClose])
  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs cx-calc" style={{ '--c': c.color }} onClick={e => e.stopPropagation()} role="dialog" aria-label="Work out your mark">
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="14" height="14" /></button>
        <div className="cs-head"><span className="tag">{c.code}</span><h2>Work out your mark</h2><p>Type a mark into any row to see where it leaves you.</p></div>
        <div className="cs-body"><GradeSim course={c} /></div>
      </div>
    </div>)
}

// What this week holds, as a grid of counts; each opens that part of the week.
function Holds({ d, onOpen, onOpenWeek }) {
  const w = d.thisWeek
  if (!w) return null
  const p = w.problems, pc = p?.counts
  const tiles = [
    { icon: 'notes', label: 'your notes', n: w.notes?.count || 0, open: () => (w.notes?.path ? onOpen(w.notes.path) : onOpenWeek?.(w.dir, 'notes')) },
    { icon: 'board', label: 'lectures', n: w.lectures?.items.length || 0, open: () => onOpenWeek?.(w.dir, 'lectures') },
    { icon: 'headphones', label: 'recordings', n: w.recordings?.items.length || 0, open: () => onOpenWeek?.(w.dir, 'recordings') },
    ...(ED.sheets ? [{ icon: 'bookmark', label: 'study sheets', n: w.sheets?.items.length || 0, open: () => onOpenWeek?.(w.dir, 'sheets') }] : []),
    // Problems counts the exercises the page lists when it lists any, and otherwise the sets filed in the folder (SPEC §20.24).
    { icon: 'pencil', label: pc?.assigned ? 'questions tried' : 'problem sets', n: pc?.assigned || pairSets(p?.items).filter(s => s.role === 'set').length || 0, text: pc?.assigned ? `${pc.attempted}/${pc.assigned}` : null, open: () => onOpenWeek?.(w.dir, 'problems') },
  ]
  return (
    <section className="card cx-holds-card">
      <h2><span className="grow">This week holds</span><button className="link" onClick={() => onOpenWeek?.(w.dir)}>{w.label.replace(/\s*\(.*\)$/, '')}</button></h2>
      <div className="cx-holds">{tiles.map(t => (
        <button key={t.label} className={'cx-hold' + (t.n ? '' : ' zero')} onClick={t.open}>
          <span className="pl-icon">{I(t.icon, { width: 15, height: 15 })}</span>
          <b>{t.text || t.n || '—'}</b><span>{t.label}</span>
        </button>))}</div>
    </section>)
}

// What the course is: read once a term, so it is the last thing in the column.
function About({ d, onOpenSection }) {
  const c = d.course
  const facts = [['Taught by', c.professor], ['Meets', c.meets], ['Textbook', c.textbook]].filter(([, v]) => v)
  return (
    <section className="card cx-about">
      <h2>About this course</h2>
      {facts.length > 0 && <dl className="cx-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      <div className="cx-links">
        {/* The book itself, when the notebook holds it a chapter a page (SPEC §20.67); the week's sections sit on each week's own Textbook shelf. */}
        {c.textbookSection && <button className="btn small" onClick={() => onOpenSection(c.textbookSection)}>{I('book', { width: 12, height: 12 })}Textbook</button>}
        {c.url && <a className="btn small" href={c.url} target="_blank" rel="noopener">Quercus{I('external', { width: 12, height: 12 })}</a>}
        {d.links.items.slice(0, 3).map((l, i) => <a key={i} className="btn small" href={l.url} target="_blank" rel="noopener">{l.label}{I('external', { width: 12, height: 12 })}</a>)}
        <button className="btn small" onClick={() => onOpenSection(`${c.key}/General`)}>Syllabus &amp; admin</button>
      </div>
      <p className="cx-checked">Checked {fmt(d.updatedAt)}</p>
    </section>)
}

// ---- the professor's words, as a dated feed ----------------------------------------------------------------------------
function Announcements({ d, onOpen }) {
  const a = d.announcements
  return (
    <section className="card">
      <h2><span className="grow">Announcements</span><button className="link" onClick={() => onOpen(a.index)}>All</button></h2>
      {a.items.length === 0 ? <p className="blank">Nothing posted yet.</p>
        : <ul className="cd-feed">{a.items.slice(0, 4).map(x => {
          const day = x.date ? new Date(String(x.date).slice(0, 10) + 'T12:00:00') : null
          return (
            <li key={x.path}>
              <button className={'cd-feed-item' + (x.isNew ? ' new' : '')} onClick={() => onOpen(x.path)} title={`Open ${x.title}`}>
                <span className="cd-feed-date">{day ? <><span>{day.toLocaleDateString('en-CA', { month: 'short' })}</span><b>{day.getDate()}</b></> : <span>—</span>}</span>
                <span className="cd-feed-main"><span className="cd-feed-title">{x.title}</span><small>{x.weeks.length ? `Concerns ${x.weeks.join(', ')}` : x.snippet}</small></span>
                {x.isNew && <span className="pill on cd-feed-new">new</span>}
              </button>
            </li>)
        })}</ul>}
    </section>)
}

// ---- everything else --------------------------------------------------------------------------------------------------
// A clickable list row: icon, title + small, optional bar and right-hand text, chevron. `as` is the element: an <li> in a
// list, a <div> when the row is already inside one (a week's Problems row carries its sets). `bar` is a percentage.
const Row = ({ icon, title, small, when, whenClass = '', bar = null, onClick, className = '', as: Tag = 'li' }) => (
  <Tag className={'cd-row ' + className} onClick={onClick} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onClick?.() }}>
    <span className="pl-icon">{I(icon)}</span>
    <span className="grow">{title}{small && <small>{small}</small>}</span>
    {bar != null && <span className="cd-prog-bar" aria-hidden="true"><i style={{ width: `${bar}%` }} /></span>}
    {when != null && when !== '' && <span className={'when ' + whenClass}>{when}</span>}
    <span className="cd-chev">{I('chevron', { width: 14, height: 14 })}</span>
  </Tag>)

// The sheet over the page shows the same row; a prep task can be ticked from it.
const sheetOf = (r, ctx, today, onTick, onDelete) => (r.type === 'mine'
  ? { ...r, onToggle: () => onTick(r), onDelete: () => onDelete(r) }
  : r.type === 'prep' || r.type === 'in-class'
  ? { ...taskItem(r.task, r.meeting, ctx, today, r.next), onToggle: r.canTick ? () => onTick(r) : null }
  : r.type === 'week' ? { ...r, onToggle: r.canTick ? () => onTick(r) : null }
  : { ...r, onToggle: null })

function Sheets({ d, onOpen, onConfirm }) {
  const w = d.thisWeek
  return (
    <section className="card">
      <h2>Study sheets {w?.sheets && <button className="link" onClick={() => onOpen(w.sheets.path)}>this week</button>}</h2>
      {d.sheets.length === 0 ? <p className="blank">No sheet built yet. A session is flagged on Home the morning after it lands.</p>
        : <ul className="list">{d.sheets.slice(0, 8).map(s => <Row key={s.path} icon="bookmark" title={s.title} small={`${s.week}${s.hasPdf ? '' : ' · no printout yet'}`} when={s.date ? fmtDay(s.date) : ''} onClick={() => onOpen(s.path)} />)}</ul>}
      {d.queue.ready.length > 0 && <><h3>Ready to build</h3><ul className="list">{d.queue.ready.map(r => (
        <li key={r.key} className={r.confirmed ? '' : 'new'}><span className="grow">Session {r.session} — {r.week}<small>{r.confirmed ? 'confirmed · builds at 10:00' : 'everything uploaded? confirm and it is built at 10:00'}</small></span>
          <button className={'btn small' + (r.confirmed ? '' : ' primary')} onClick={() => onConfirm(r.key, !r.confirmed)}>{r.confirmed ? 'Undo' : 'Confirm'}</button></li>))}</ul></>}
      {d.queue.blocked.length > 0 && <><h3>Waiting on</h3><ul className="list">{d.queue.blocked.map(b => <li key={b.key}><span className="grow">Session {b.session}<small>{b.blocked}</small></span></li>)}</ul></>}
    </section>)
}

// One row per week's problems, this week and next first. A week shows the exercises its page lists (each set row
// carries the score field — the mark typed here is written at the end of its row as ` · 17/20`, src/problems.js
// withScore) *and* the documents filed in `Problems/`, because a week often has only the second (SPEC §20.24).
function Problems({ d, onOpen, onOpenWeek, onChanged, onNote }) {
  const [all, setAll] = useState(false)
  const p = d.problems, wa = p.webassign
  const weeks = all ? p.weeks : p.weeks.slice(0, 6)
  const rel = w => (w.current ? 'this week' : w.upcoming && d.week && w.n === d.week.n + 1 ? 'next week' : w.upcoming ? 'later' : '')
  return (
    <section className="card">
      <h2>Every problem set</h2>
      {wa && <div className="cd-wa"><a href={wa.url || '#'} target="_blank" rel="noopener">WebAssign</a> · {wa.scored} of {wa.count} sets scored{wa.avg != null ? ` · average ${wa.avg.toFixed(0)}%` : ''}{wa.banked ? ` · ${wa.banked.toFixed(2)} pts banked of ${Math.round(wa.bonus * 100)}` : ''}{wa.confirmed ? '' : ' · dates unconfirmed'}</div>}
      {p.weeks.length === 0 ? <p className="blank">Nothing filed under Problems yet. Problem sets and tutorial sheets land here as they are posted.</p>
        : <ul className="list cd-problems">{weeks.map(w => {
          const c = w.counts || null
          const sets = (w.rows || []).filter(r => r.kind === 'set')
          // A set's questions and its solutions are one line (SPEC §20.32); the row opens the week's Problems tab, always.
          const docs = pairSets(w.items || [])
          const weekPath = w.page.replace(/\/Problems\.md$/, '')
          const small = [w.week, rel(w), c?.assigned ? `${c.attempted} of ${plural(c.assigned, 'item')} attempted${c.reviewed ? ` · ${c.reviewed} reviewed` : ''}${c.solved ? ` · ${c.solved} solved` : ''}` : docs.length ? plural(docs.filter(s => s.role === 'set').length, 'set') : 'nothing listed yet'].filter(Boolean).join(' · ')
          return (<li key={w.page} className="cd-pw">
            <Row as="div" icon="pencil" className={w.upcoming ? 'upcoming' : ''} title={w.topic || 'Problems'} small={small}
              when={c?.assigned ? `${c.attempted}/${c.assigned}` : ''} whenClass={c?.assigned && c.attempted === c.assigned ? 'done' : ''}
              bar={c?.assigned ? Math.round((100 * c.attempted) / c.assigned) : null}
              onClick={() => onOpenWeek?.(weekPath, 'problems')} />
            {sets.length > 0 && <ul className="cd-sets">{sets.map(r => (
              <li key={r.key} className={'cd-set' + (r.attempted ? ' attempted' : '')}>
                <span className="cd-set-ic" title={r.attempted ? 'attempted' : 'not attempted yet'}>{I('check', { width: 13, height: 13 })}</span>
                <span className="lbl">{labelText(r.label)}</span>
                {r.due && <span className="cd-set-due">due {fmtDay(r.due)}</span>}
                <ScoreField page={w.page} row={r} onSaved={onChanged} onError={onNote} />
              </li>))}</ul>}
            {docs.length > 0 && <ul className="cd-docs">{docs.map(x => (
              <li key={x.key}><button className="cd-doc" onClick={() => onOpen(x.main.path)} title={`Open ${x.main.title}`}>
                <span className="cd-set-ic">{I(x.role === 'guide' ? 'bookOpen' : 'file', { width: 13, height: 13 })}</span><span className="lbl">{x.label}</span>
                <span className="cd-chev">{I('chevron', { width: 13, height: 13 })}</span></button></li>))}</ul>}
          </li>)
        })}</ul>}
      {p.weeks.length > 6 && <button className="link cd-more" onClick={() => setAll(a => !a)}>{all ? 'Fewer' : `All ${p.weeks.length} weeks`}</button>}
    </section>)
}
function ScoreField({ page, row, onSaved, onError }) {
  const cur = row.score ? `${row.score.got}/${row.score.of}` : ''
  const [v, setV] = useState(cur)
  useEffect(() => { setV(cur) }, [cur])
  const commit = async () => {
    const t = v.trim(), m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(t)
    if (t && !m) { onError('Type the mark as got/of, like 17/20.'); setV(cur); return }
    if ((m ? `${Number(m[1])}/${Number(m[2])}` : '') === cur) return
    try { await writeScore(page, row.key, m ? Number(m[1]) : null, m ? Number(m[2]) : null); onError(null); onSaved() } catch (e) { onError(`Could not write the score: ${e.message}`); setV(cur) }
  }
  return <input className="cd-score" value={v} placeholder="–/–" title="The mark for this set, written at the end of its row as · 17/20" onChange={e => setV(e.target.value)} onBlur={commit} onClick={e => e.stopPropagation()}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } else if (e.key === 'Escape') { setV(cur); e.currentTarget.blur() } }} />
}
// The row line rewritten on the page through the editor's own save path: base hash, one retry on a stale hash.
async function writeScore(page, key, got, of) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await api.page(page)
    const bi = findProblemsBlock(p.blocks)
    if (bi < 0) throw new Error('the page has no “## Problems” block')
    const lines = p.blocks[bi].md.split('\n'), r = parseProblemsBlock(p.blocks[bi].md).rows.find(x => x.key === key)
    if (!r) throw new Error('the row is no longer on the page')
    lines[r.line] = withScore(lines[r.line], got, of)
    const blocks = p.blocks.map((b, j) => ({ id: b.id, md: j === bi ? lines.join('\n') : b.md }))
    try { await api.savePage(page, blocks, p.hash); return } catch (e) { if (e.status !== 409 || attempt) throw e }
  }
}

function LinksAdmin({ d, onOpen, onOpenSection }) {
  const c = d.course
  return (
    <section className="card">
      <h2>Links &amp; admin {d.links.page && <button className="link" onClick={() => onOpen(d.links.page)}>page</button>}</h2>
      <ul className="list">
        {c.url && <li><span className="pl-icon">{I('external')}</span><span className="grow"><a href={c.url} target="_blank" rel="noopener">Quercus</a><small>opens in the browser</small></span></li>}
        {d.links.items.map((l, i) => <li key={i}><span className="pl-icon">{I('external')}</span><span className="grow"><a href={l.url} target="_blank" rel="noopener">{l.label}</a><small>{l.module}</small></span></li>)}
        {!c.url && d.links.items.length === 0 && <li><span className="grow muted">No links yet.</span></li>}
      </ul>
      {d.general.length > 0 && <><h3>General</h3><ul className="list">{d.general.slice(0, 8).map(p => <Row key={p.path} icon={kindIcon(p.kind) || 'file'} title={p.title} onClick={() => onOpen(p.path)} />)}</ul>
        {d.general.length > 8 && <button className="link cd-more" onClick={() => onOpenSection(`${c.key}/General`)}>all {d.general.length} pages</button>}</>}
    </section>)
}
