import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { Flags } from './Flags.jsx'
import { THIS as ED } from '../edition.js'
import ReviewLink from './ReviewLink.jsx'
import MdLite from './MdLite.jsx'
import More from './More.jsx'
import Timetable, { ClassSheet } from './Timetable.jsx'
import TaskSheet, { taskItem } from './TaskSheet.jsx'
import CourseTodoSheet from './CourseTodoSheet.jsx'
import { rowsFor, isOpen } from '../todo.js'
import CalendarStatus from './CalendarStatus.jsx'
import { useMyTasks, AddTask, toggleMyTask, removeMyTask } from './MyTasks.jsx'
import { usePlan, toggleTask, courseColor, todayIso, nowHM, nextMeetingOf, basename } from './plan/PlanBits.jsx'
import { addDays, weekdayOf, relDay, daysTo, SHOW_DAYS } from '../plan.js'
import '../styles/screens.css'
import '../styles/hub.css'

// Today (SPEC §20.17, drawn a fourth time §20.34). The courses are the page: each is a panel carrying its own near
// future — the next class, what to do before it, the next thing that is marked. Above them, one sentence saying what
// is happening. Below, the week as a timetable, what to do as an agenda of days, then the morning note and what
// arrived, grouped by course. Each block draws its facts its own way, so the page reads as four different things
// rather than one tinted card copied forty times. Everything rarer is behind one More.
// props: { onOpen(path), onOpenTitle(title), onOpenCourse(key), onScreen(name), onTake(courseKey), onDay(iso) — To do, narrowed to one day }
const fmt = iso => (iso ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const dayShort = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })
const minutes = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0) }
const stripHead = md => String(md || '').replace(/^---[\s\S]*?---\n?/, '').replace(/^# .*\n/, '').trim()
// The files Home is drawn from that nobody clicks to change: the morning pass writes them, so the screen has to watch
// them the way every other screen watches its own (SPEC §8). Without this Home was the one screen that never noticed —
// a window opened before 07:10 kept yesterday's morning note, yesterday's hub and a stale question count until it was
// reloaded or Sync was pressed. The plan and your own tasks already watch Hub/_plan.json and My tasks.md themselves.
const WATCHED = { 'Hub/_hub.json': 'hub', 'Hub/Today/Morning note.md': 'note', 'Hub/_study-queue.json': 'queue', 'Hub/_brain.json': 'brain' }
// Something to open, and somewhere worth going: not a room you sit in, not a thing that has not opened yet.
const doable = r => !!r.action && !r.inClass && !r.notOpen
// A row you tick yourself: a class's task, a week's own work (SPEC §20.35), or one of your own.
const tickable = r => (r.type === 'prep' || r.type === 'mine' || r.type === 'week') && r.canTick

// What the last check did, in one clause (SPEC §21.8): "3 new, 3 filed" — or, on the app runner after the button,
// "3 new, waiting for the next check". Early in the term the numbers are small, and that is the point of saying them.
function lastRunWords(r) {
  const f = r.fetched || {}, fresh = (f.newFiles || 0) + (f.newAnnouncements || 0) + (f.newPages || 0)
  if (r.ok === false) return r.reason === 'token' ? 'the Quercus key was refused' : r.reason === 'network' ? 'Quercus could not be reached' : 'the last check failed'
  const filed = r.totals?.placed ?? 0, waiting = r.waiting ?? 0
  return `${fresh} new, ${filed} filed${waiting ? `, ${waiting} waiting for the next check` : ''}`
}

export default function Home({ onOpen, onOpenTitle, onOpenCourse, onScreen, onTake, onDay }) {
  const [picked, setPicked] = useState(null)   // the class whose sheet is open (SPEC §20.18)
  const [task, setTask] = useState(null)      // the one task whose sheet is open (SPEC §20.19)
  const [courseTodo, setCourseTodo] = useState(null)   // one course's to-do, in its own bubble (SPEC §20.21)
  const [titles, setTitles] = useState([])
  const [ctx, setCtx] = useState({})
  const [hub, setHub] = useState(null)
  const mine = useMyTasks((hub?.courses || []).map(c => c.code))
  // How far behind the fetch is. The pass is scheduled every `cadenceDays` (the edition's, served with the hub) and only
  // fires while the Mac is awake, so a laptop that lives shut can go a week without one; Home says so and the button
  // becomes the way to catch up.
  const every = Number(hub?.cadenceDays) || 3
  const stale = (() => {
    if (!hub?.updatedAt) return 0
    const days = Math.floor((Date.now() - new Date(hub.updatedAt).getTime()) / 86400000)
    return days > every ? days : 0
  })()   // your own tasks (SPEC §20.32)
  const { plan, error: planError, fresh: planFresh, busy, refresh, rebuild, patch } = usePlan({ refresh: true })
  const [error, setError] = useState(null)
  const [fresh, setFresh] = useState(false)   // set up, nothing fetched yet — the first screen of a new install
  const [note, setNote] = useState(null)
  const [queue, setQueue] = useState(null)
  const [brain, setBrain] = useState(null)   // Claude as the brain (SPEC §20.37)
  const [syncing, setSyncing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [clock, setClock] = useState(() => ({ today: todayIso(), now: nowHM() }))
  useEffect(() => { const t = setInterval(() => setClock({ today: todayIso(), now: nowHM() }), 60000); return () => clearInterval(t) }, [])
  const { today, now } = clock

  // A hub that is not there yet is the state every install starts in, not a failure — it is what Home shows between
  // the end of setup and the first fetch. Saying so in the server's own words ("no hub yet: run the Quercus sync")
  // made the first screen a stranger ever sees read like a crash report, and told them to run something by hand when
  // the button underneath already does it. Only a real failure keeps its message, because a 401 or a dead network is
  // the one thing worth repeating verbatim: it is what tells them, or their Claude, what to fix.
  const load = () => api.hub()
    .then(h => { setHub(h); setError(null); setFresh(false) })
    .catch(e => { setFresh(e.status === 404); setError(e.status === 404 ? null : e.message) })
  const loadNote = () => api.page('Hub/Today/Morning note.md').then(p => setNote(p.blocks.map(b => b.md).join('\n\n'))).catch(() => setNote(null))
  const loadQueue = () => api.studyQueue().then(setQueue).catch(() => setQueue(null))
  const loadBrain = () => api.brain().then(setBrain).catch(() => setBrain(null))
  const [attendance, setAttendance] = useState({})
  // attendance belongs to Today's work (SPEC §22); an edition without it never asks the route, which is not mounted there
  useEffect(() => { if (ED.work === false) return; api.attendanceAll().then(a => setAttendance(a.classes || {})).catch(() => { }) }, [])
  const attend = async (m, attended) => { try { const r = await api.attendance({ meetingId: m.id, attended, courseKey: m.courseKey, date: m.date, kind: m.kind }); setAttendance(r.classes || {}) } catch (e) { setError(e.message) } }
  useEffect(() => { load(); loadNote(); loadQueue(); loadBrain() }, [])
  // Each of the four files above, reloaded when it changes on disk. Debounced per file, because one brain run writes
  // _brain.json once per decision and the fetch rewrites the hub several times over a pass; the app's own writes are
  // never broadcast, so a click that confirms a sheet does not come back round as an event.
  useEffect(() => {
    const load1 = { hub: load, note: loadNote, queue: loadQueue, brain: loadBrain }
    const timers = new Map()
    const un = api.events(ev => {
      const which = WATCHED[ev.path]
      if (!which) return
      clearTimeout(timers.get(which))
      timers.set(which, setTimeout(load1[which], 500))
    })
    return () => { un(); for (const t of timers.values()) clearTimeout(t) }
  }, [])
  useEffect(() => { api.titles().then(setTitles).catch(() => {}) }, [])
  useEffect(() => { if (!hub) return; Promise.all((hub.courses || []).map(c => api.course(c.key).then(d => [c.key, { links: d.links.items, general: d.general, courseUrl: d.course.url }]).catch(() => null))).then(rs => setCtx(Object.fromEntries(rs.filter(Boolean)))) }, [hub])
  const confirm = async (key, on) => { await api.confirmSheet(key, on).catch(() => {}); loadQueue() }
  const sync = async () => {
    setSyncing(true); setElapsed(0); setError(null)
    try {
      await api.sync()
      const t0 = Date.now()
      for (;;) {
        await new Promise(r => setTimeout(r, 3000))
        const st = await api.syncStatus(); setElapsed(Math.round((Date.now() - t0) / 1000))
        if (!st.running) { if (st.ok === false) setError(st.note || 'The check ended with an error.'); break }
      }
      await load(); await loadNote(); await loadQueue(); await loadBrain()
    } catch (e) { setError(e.message) } finally { setSyncing(false) }
  }
  // A tick is drawn at once — on a class's tasks or on a week's own work — then the plan is read back from disk.
  const toggle = async (m, t) => {
    try {
      if (!(await toggleTask(m, t))) return
      const flip = list => list.map(y => (y.key === t.key ? { ...y, done: !y.done } : y))
      patch(p => p ? { ...p, meetings: p.meetings.map(x => x.id !== m.id ? x : { ...x, before: flip(x.before), tasks: x.tasks ? { ...x.tasks, done: x.tasks.done + (t.done ? -1 : 1) } : x.tasks }),
        weeks: (p.weeks || []).map(x => x.id !== m.id ? x : { ...x, work: flip(x.work) }) } : p)
      refresh()
    } catch (e) { setError(`Could not tick “${t.text}”: ${e.message}`) }
  }
  // A row ticks where it lives: your own tasks on their own page, everything else on the week's Plan page.
  const tickRow = async r => {
    if (r.type !== 'mine') return toggle(r.meeting, r.task)
    try { await toggleMyTask(r.raw); mine.reload() } catch (e) { setError(`Could not tick “${r.title}”: ${e.message}`) }
  }
  const removeRow = async r => { try { await removeMyTask(r.raw); mine.reload() } catch (e) { setError(`Could not delete “${r.title}”: ${e.message}`) } }
  const go = a => { if (!a) return; if (a.url) window.open(a.url, '_blank', 'noopener'); else onOpen(a.path) }

  const days = useMemo(() => Array.from({ length: SHOW_DAYS }, (_, i) => addDays(today, i)).map(d => plan?.days?.find(x => x.date === d) || { date: d, weekday: weekdayOf(d), rel: relDay(d, today), events: [] }), [plan, today])
  const live = (plan?.meetings || []).find(m => m.date === today && !m.cancelled && (m.announced?.start || m.start) <= now && now < (m.announced?.end || m.end))
  const next = nextMeetingOf(plan, null, today, now)
  const colorOf = k => hub?.courses.find(c => c.key === k)?.color || courseColor(plan, k)
  // Everything this course wants, with where each thing goes — the one row model the To do page and the course
  // screen use (src/todo.js, SPEC §20.24), so a task never says two different things in two places.
  const ctxFor = key => ({ ...(ctx[key] || {}), titles })
  const todoFor = c => rowsFor({ plan, today, now, courseKey: c.key, ctxFor, mine: mine.tasks, courses: hub?.courses || [] })
  const allTodo = useMemo(() => rowsFor({ plan, hub, tests: plan?.tests || [], today, now, testHorizon: 14, ctxFor, mine: mine.tasks, courses: hub?.courses || [] })
    .map(r => (r.color ? r : { ...r, color: colorOf(r.courseKey) })), [plan, hub, ctx, titles, today, now, mine.tasks])
  // The week's load, for the strip over the timetable (SPEC §20.63): each day's hours of class, in the courses' pigments,
  // and everything wanted by that day — the same rows the agenda draws, so the strip and the list never disagree.
  const weekLoad = useMemo(() => days.map(d => {
    const classes = d.events.filter(e => e.type === 'meeting').map(e => plan?.meetings?.find(m => m.id === e.ref)).filter(m => m && !m.cancelled)
      .map(m => { const start = m.announced?.start || m.start, end = m.announced?.end || m.end; return { course: m.course, color: m.color, kind: m.kind, start, end, minutes: Math.max(0, minutes(end) - minutes(start)) } })
    const due = allTodo.filter(r => r.by === d.date && !r.done)
    return { date: d.date, classes, minutes: classes.reduce((a, c) => a + c.minutes, 0), due }
  }), [days, plan, allTodo])
  // One task on its own, over the page: ticked where it lives, deleted only when it is yours.
  const pick = r => setTask(r.type === 'mine' ? { ...r, onToggle: () => tickRow(r), onDelete: () => removeRow(r) }
    : r.type === 'prep' || r.type === 'in-class' ? { ...taskItem(r.task, r.meeting, ctxFor(r.courseKey), today, r.next), onToggle: () => toggle(r.meeting, r.task) }
    : r.type === 'week' ? { ...r, onToggle: r.canTick ? () => toggle(r.meeting, r.task) : null }
    : { ...r, onToggle: null })

  return (
    <div className="home hub">
      <div className="home-head">
        <div>
          <div className="home-kicker">Home</div>
          <h1 className="home-title">{new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
          {/* one sentence, set like a deck under the headline: the size of a sentence that matters */}
          <p className="td-say">
            {live ? <>You are in <b style={{ '--c': live.color }}>{live.course} {live.kind.toLowerCase()}</b> until {live.announced?.end || live.end}{(live.announced?.where || live.where) ? <span className="td-say-dim"> · {live.announced?.where || live.where}</span> : null}.</>
              : next ? <>Next up is <b style={{ '--c': next.color }}>{next.course} {next.kind.toLowerCase()}</b> {relDay(next.date, today)} at {next.announced?.start || next.start}{(next.announced?.where || next.where) ? <span className="td-say-dim"> · {next.announced?.where || next.where}</span> : null}.</>
                : <>Nothing scheduled in the next two weeks.</>}
          </p>
        </div>
        <div className="home-actions">
          {hub && <span className={'muted' + (stale > 0 ? ' hub-stale' : '')}>Checked {fmt(hub.updatedAt)}{hub.lastRun ? ` · ${lastRunWords(hub.lastRun)}` : ''}</span>}
          <button className={'btn' + (stale > 0 ? ' primary' : '')} onClick={sync} disabled={syncing}
            title={stale > 0 ? `Nothing has been fetched for ${stale} days — it runs by itself every ${every === 1 ? "day" : every + " days"}, only while the Mac is awake` : 'Fetch Quercus and let Claude file what is new'}>
            {syncing ? `Checking… ${elapsed}s` : stale > 0 ? `Check Quercus · ${stale} days behind` : 'Check Quercus'}</button>
          {/* The one thing the student does himself, first among the actions (SPEC §20.26). */}
          <button className="btn primary" title="Take notes ⌘⇧N" onClick={() => onTake?.(true)}><Icon.pencil width="14" height="14" />Take notes</button>
        </div>
      </div>

      {(fresh || (error && !hub)) && (
        <div className="home-first">
          <h2>{fresh ? 'Nothing has been fetched from Quercus yet' : 'Quercus could not be reached'}</h2>
          <p>{fresh ? 'The first check reads your courses, files what is there and works out what there is to do. It takes a few minutes.'
            : <>This is what it said: <span className="home-first-why">{error}</span></>}</p>
          <button className="btn primary" onClick={sync} disabled={syncing}>
            {syncing ? `Checking… ${elapsed}s` : fresh ? 'Do the first check' : 'Try again'}</button>
        </div>
      )}
      {error && hub && <div className="home-error">{error}</div>}

      {hub && (
        <div className="td-body">
          <h2 className="hm-band"><span>My courses</span></h2>
          <div className="td-courses" style={{ '--n': hub.courses.length }}>
            {hub.courses.map(c => (
              <CoursePanel key={c.key} c={c} plan={plan} today={today} now={now} queue={queue} todoRows={todoFor(c)}
                onConfirm={confirm} onOpenCourse={onOpenCourse} onTake={onTake} onPick={pick} onToggle={tickRow} go={go}
                onTodo={() => setCourseTodo({ course: c, rows: todoFor(c) })} />
            ))}
          </div>

          <h2 className="hm-band"><span>This week</span>
            <span className="hm-band-links"><button className="link" onClick={() => rebuild()} disabled={busy} title="Rebuild the week from the calendar and the announcements">{busy ? 'Working…' : 'Refresh'}</button></span>
          </h2>
          <section className="card td-week">
            {plan ? <Timetable days={days} plan={plan} today={today} now={now} onPick={setPicked} load={weekLoad} onDay={onDay} attendance={attendance} />
              : <p className="blank">{planFresh ? 'No week built yet — Refresh builds it from your timetable and what Quercus has said.'
                : planError ? `No week built yet. ${planError}` : 'Reading your week…'}</p>}
          </section>

          <Agenda rows={allTodo} today={today} courses={hub.courses} onAdded={mine.reload} onScreen={onScreen} onToggle={tickRow} onPick={pick} go={go} />

          <div className="td-foot">
            {note && <MorningNote md={stripHead(note)} onOpen={onOpenTitle || onOpen} />}
            {brain?.enabled && <ClaudeCard brain={brain} courses={hub.courses} colorOf={colorOf} onOpen={onOpen} />}
            <NewSince hub={hub} colorOf={colorOf} onOpen={onOpen} />
          </div>

          <More label="Everything else" count={(hub.errors?.length || 0) + (plan?.issues?.length || 0)}>
            <section className="card"><h2>Sunday review</h2><ReviewLink onOpen={onOpen} /></section>
            <section className="card"><h2>Calendar</h2><CalendarStatus onOpen={onOpen} /></section>
            {ED.sheets && queue?.blocked?.length > 0 && (
              <section className="card"><h2>Study sheets waiting on something</h2>
                <ul className="list">{queue.blocked.map(b => <li key={b.key}><span className="tag" style={{ '--c': colorOf(b.courseKey) }}>{b.course}</span><span className="grow">Session {b.session}<small>{b.blocked}</small></span></li>)}</ul></section>)}
            {plan?.issues?.length > 0 && (
              <section className="card"><h2>Sentences I could not file</h2>
                <ul className="list">{plan.issues.map((s, i) => (
                  <li key={i}><span className="tag" style={{ '--c': courseColor(plan, s.courseKey) }}>{s.course}</span>
                    <span className="grow"><span className="wn-quote">“{s.text}”</span><small>{s.reason} · <button className="link" onClick={() => onOpen(s.page)}>{basename(s.page)}</button></small></span></li>))}</ul></section>)}
            {hub.errors?.length > 0 && <section className="card"><h2>Problems with the last check</h2><ul className="list">{hub.errors.map((e, i) => <li key={i}><span className="grow">{e}</span></li>)}</ul></section>}
            <section className="card">
              <h2>Full lists</h2>
              <ul className="list">
                <li><span className="grow"><button className="link" onClick={() => onOpen('Hub/Today/My tasks.md')}>Your own tasks, as a page</button></span></li>
                <li><span className="grow"><button className="link" onClick={() => onOpen('Hub/Today/Deadlines.md')}>Every deadline</button></span></li>
                <li><span className="grow"><button className="link" onClick={() => onOpen('Hub/Today/Tests.md')}>Every test</button></span></li>
                <li><span className="grow"><button className="link" onClick={() => onOpen('Hub/Today/Grades.md')}>Every mark</button></span></li>
                <li><span className="grow"><button className="link" onClick={() => onOpen('Hub/Today/Schedule.md')}>The timetable</button></span></li>
              </ul>
            </section>
          </More>
        </div>
      )}
      {picked && <ClassSheet m={picked} onClose={() => setPicked(null)} onOpen={p => { setPicked(null); onOpen(p) }} onToggle={toggle}
        past={picked.date < today || (picked.date === today && (picked.announced?.end || picked.end) <= now)} attendance={attendance[picked.id]} onAttend={ED.work !== false ? attend : null} />}
      {task && <TaskSheet item={task} onClose={() => setTask(null)} onOpen={onOpen} onToggle={task.onToggle} onDelete={task.onDelete} />}
      {courseTodo && <CourseTodoSheet {...courseTodo} today={today} onClose={() => setCourseTodo(null)} onOpen={onOpen} onToggle={tickRow} onAll={() => onScreen?.('todo')} />}
    </div>
  )
}

// One course, and everything about its near future: the next class and what to do before it — the course screen's
// first group, in small (SPEC §20.34) — then the next thing that is marked, then the way in. A course with no classes
// shows its week instead, and this week's work under it (SPEC §20.35).
function CoursePanel({ c, plan, today, now, queue, todoRows = [], onConfirm, onOpenCourse, onTodo, onTake, onPick, onToggle, go }) {
  const m = nextMeetingOf(plan, c.key, today, now)
  const noClasses = !(c.meetings || []).length
  const test = (plan?.tests || []).find(t => t.courseKey === c.key)
  const due = (plan?.deadlines || []).filter(d => d.courseKey === c.key && d.dueDate && daysTo(d.dueDate, today) >= 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
  const soonest = !test ? due : !due ? test : daysTo(test.date, today) <= daysTo(due.dueDate, today) ? test : due
  const isTest = soonest && soonest === test
  const n = soonest ? daysTo(isTest ? soonest.date : soonest.dueDate, today) : null
  const ready = queue?.ready?.find(r => r.courseKey === c.key && !r.confirmed)
  const running = m && m.date === today && (m.announced?.start || m.start) <= now && now < (m.announced?.end || m.end)
  const todo = todoRows.filter(isOpen).length
  // What the next class wants first — or, with no classes, this week's work — done ones last and struck through, so a tick is seen to land.
  // …and his own tasks for the course due by tomorrow, so a to-do he just added is on the course's panel (SPEC §23).
  const soonMine = r => r.type === 'mine' && !r.done && r.by && r.by !== '9999-12-31' && r.by <= addDays(today, 1)
  const first = todoRows.filter(r => (m ? r.next : r.weekWork) || soonMine(r)).sort((a, b) => Number(a.done) - Number(b.done))
  const where = m && (m.announced?.where || m.where)
  return (
    <article className={'td-panel' + (running ? ' live' : '')} style={{ '--c': c.color }}>
      <button className="td-panel-head" onClick={() => onOpenCourse(c.key)} title={`Open ${c.code}`}>
        <span className="td-panel-code">{c.code}</span>
        <span className="td-panel-name">{c.name}</span>
        {c.standing && <span className="td-panel-mark">{c.standing.grade.toFixed(0)}%</span>}
      </button>

      <div className="td-panel-body">
        <div className="td-slot">
          <div className="td-slot-k">{running ? 'In class now' : m || !noClasses ? 'Next class' : 'This week'}{m && !running && <span className="td-slot-rel">{relDay(m.date, today)}</span>}</div>
          {m ? <div className="td-slot-v">{m.kind}<span className="td-slot-dim"> · {running ? `until ${m.announced?.end || m.end}` : `${dayShort(m.date)}, ${m.announced?.start || m.start}`}{where ? ` · ${where}` : ''}</span></div>
            : noClasses ? <div className="td-slot-v">{c.week ? String(c.week).replace(/\s*\(.*\)$/, '') : 'Between terms'}<span className="td-slot-dim"> · online, at your own pace</span></div>
            : <div className="td-slot-v td-slot-dim">No class scheduled</div>}
          {(m || (noClasses && c.week)) && (
            <div className="td-before">
              <div className="td-before-k">{m ? 'Before it' : "This week's work"}</div>
              {first.length === 0 ? <p className="td-before-none">{m ? 'Nothing to prepare.' : 'Nothing listed yet.'}</p> : (
                <ul className="td-before-list">
                  {first.slice(0, 3).map(r => (
                    <li key={r.id} className={r.done ? 'done' : ''}>
                      {tickable(r)
                        ? <button className={'todo-tick' + (r.done ? ' on' : '')} title={r.done ? 'Not done after all' : 'Mark it done'} onClick={() => onToggle(r)}><Icon.check width="11" height="11" /></button>
                        : <span className="td-before-ic" title="Happens in the class"><Icon.calendar width="13" height="13" /></span>}
                      <button className="td-before-title" onClick={() => onPick(r)} title="Open it on its own">{r.title}</button>
                      {doable(r) && !r.done && <button className="link td-before-go" onClick={() => go(r.action)}>{r.action.fallback ? 'Quercus' : 'Open'}</button>}
                    </li>))}
                </ul>)}
              {first.length > 3 && <button className="link td-before-more" onClick={onTodo}>{first.length - 3} more</button>}
            </div>)}
        </div>

        <div className="td-slot">
          <div className="td-slot-k">{isTest ? 'Next test' : due ? 'Next to hand in' : 'Nothing marked ahead'}</div>
          {soonest ? <div className="td-marked">
            <span className="td-marked-n">{n}<small>{n === 1 ? 'day' : 'days'}</small></span>
            <span className="td-marked-t">{soonest.title}</span>
          </div> : <div className="td-slot-v td-slot-dim">Nothing dated yet</div>}
        </div>
      </div>

      <div className="td-panel-foot">
        {todo > 0 ? <button className="pill on" onClick={onTodo} title={`What ${c.code} wants`}>{todo} to do</button> : <span className="td-clear">Nothing to do</span>}
        {ED.sheets && ready && <button className="td-nudge" onClick={() => onConfirm(ready.key, true)}>Session {ready.session} ready →</button>}
        <button className="td-take" title={`Take notes for ${c.code}`} onClick={() => onTake?.(c.key)}><Icon.pencil width="12" height="12" />Take notes</button>
      </div>
    </article>)
}

// The morning note is written by the 07:00 pass one thing to a line — `New: …`, `Today: …`, the day's blocks as
// `09:55–10:05 · FCS298 · …`, `Next tests: …` — with single newlines between them, which markdown folds into one
// paragraph: twelve lines read as one wall. So it is drawn a line at a time: the label in its own column, the blocks as
// a small timetable, and what the eye has to catch (a date, a time, days left, "crucial", "late") set in bold or
// underlined, whether or not the pass marked it itself. The first two lines show; the rest is one click away (§20.18).
const NOTE_BLOCK = /^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\s*·\s*([^·]+?)\s*·\s*(.+)$/
const NOTE_LABEL = /^((?:[A-Z][\w']*)(?: [\w']+){0,2}):\s+(.+)$/
const MON = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*'
const WHEN = new RegExp([
  `\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* \\d{1,2} ${MON}\\b`, `\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* ${MON} \\d{1,2}\\b`,
  `\\b${MON} \\d{1,2}\\b`, '\\b(?:today|tonight|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\b',
].join('|'), 'g')
const LOUD = /\b\d{1,2}:\d{2}(?:\s*[–-]\s*\d{1,2}:\d{2})?|\(\d+(?: days?)?\)|\bin \d+ days?\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) days? (?:late|left)\b|(?<![\w-])(?:crucial|overdue|late|closes|due)(?![\w-])|\b[A-Z]{3}\d{3}\b/gi
// Mark a plain line: dates underlined, the loud things bold. A line the pass already marked with ** is left as it wrote it.
// Links and code are left alone: a date inside a [[wikilink]] is part of a title.
const mark = t => t.split(new RegExp(`(${WHEN.source})`)).map((x, i) => (i % 2 ? `++${x}++` : x.replace(LOUD, m => `**${m}**`))).join('')
const emphasise = t => /\*\*|\+\+/.test(t) ? t : t.split(/(\[\[[^\]]+\]\]|\[[^\]]+\]\([^)\s]+\)|`[^`]+`)/).map((x, i) => (i % 2 ? x : mark(x))).join('')
function noteRows(md) {
  const out = []
  for (const l of md.split('\n').map(x => x.trim()).filter(Boolean)) {
    const b = NOTE_BLOCK.exec(l.replace(/^[-*]\s+/, ''))
    if (b) { const last = out[out.length - 1]; const blk = { from: b[1], to: b[2], course: b[3], text: b[4] }; if (last?.type === 'blocks') last.items.push(blk); else out.push({ type: 'blocks', items: [blk] }); continue }
    const m = NOTE_LABEL.exec(l.replace(/^[-*]\s+/, '').replace(/^\*\*([^*]+):\*\*/, '$1:'))
    out.push(m ? { type: 'line', label: m[1], text: m[2] } : { type: 'line', label: null, text: l })
  }
  return out
}
function MorningNote({ md, onOpen }) {
  const [open, setOpen] = useState(false)
  const rows = noteRows(md), shown = open ? rows : rows.slice(0, 2)
  const ink = t => <MdLite md={emphasise(t)} className="note-body" onOpenTitle={x => onOpen(x)} />
  return (
    <section className="card note td-note">
      <h2><span className="grow">This morning</span>{rows.length > 2 && <button className="link" onClick={() => setOpen(o => !o)}>{open ? 'Less' : 'All of it'}</button>}</h2>
      <div className="td-note-head mn">
        {shown.map((r, i) => r.type === 'blocks'
          ? <div key={i} className="mn-row"><span className="mn-label">Work</span>
              <ul className="mn-blocks">{r.items.map((b, j) => <li key={j}><span className="mn-time">{b.from}–{b.to}</span><span className="mn-course">{b.course}</span><span className="mn-what">{ink(b.text)}</span></li>)}</ul></div>
          : <div key={i} className={'mn-row' + (r.label ? '' : ' bare')}>{r.label && <span className="mn-label">{r.label}</span>}<div className="mn-text">{ink(r.text)}</div></div>)}
        {!open && rows.length > 2 && <button className="link mn-more" onClick={() => setOpen(true)}>{rows.length - 2} more {rows.length - 2 === 1 ? 'line' : 'lines'}</button>}
      </div>
    </section>)
}

// To do as an agenda (SPEC §20.34). It was a board of cards, the same tinted card as the course panels above it, so
// the page read as one long grid. It is a list of days now: the date as a calendar page on the left, the day's
// things beside it. Things more than a week off wait under Later with their own dates.
function Agenda({ rows, today, courses = [], onAdded, onScreen, onToggle, onPick, go }) {
  const [adding, setAdding] = useState(false)
  const open = rows.filter(isOpen)
  const waiting = rows.filter(r => !r.done)
  const overdue = waiting.filter(r => r.deadline && r.deadline.daysLeft < 0)
  const soon = waiting.filter(r => r.deadline && r.deadline.daysLeft >= 0 && r.deadline.daysLeft <= 7)
  const later = waiting.filter(r => !overdue.includes(r) && !soon.includes(r))
  const days = [...soon.reduce((m, r) => m.set(r.by, [...(m.get(r.by) || []), r]), new Map())]
  const row = (r, full = false) => <AgendaRow key={r.id} r={r} full={full} onToggle={onToggle} onPick={onPick} go={go} />
  return (<>
    <h2 className="hm-band"><span>To do</span>
      <em>{open.length === 0 ? 'nothing outstanding' : `${open.length} open across your courses`}</em>
      <span className="hm-band-links">
        <button className="link" onClick={() => setAdding(a => !a)}>{adding ? 'Done adding' : 'Add a task'}</button>
        <button className="link" onClick={() => onScreen?.('todo')}>See all</button>
      </span>
    </h2>
    <section className="card ag">
      {adding && <div className="ag-add"><AddTask courses={courses} autoFocus onAdded={onAdded} onCancel={() => setAdding(false)} /></div>}
      {waiting.length === 0 ? <p className="blank ag-empty">Nothing to prepare and nothing due.</p> : <>
        {overdue.length > 0 && <AgendaDay label="Overdue" late>{overdue.map(r => row(r, true))}</AgendaDay>}
        {days.map(([date, g]) => <AgendaDay key={date} date={date} today={today}>{g.map(r => row(r))}</AgendaDay>)}
        {later.length > 0 && <AgendaDay label="Later" sub={later.length > 6 ? `${later.length - 6} more on To do` : null}>{later.slice(0, 6).map(r => row(r, true))}</AgendaDay>}
      </>}
    </section>
  </>)
}

function AgendaDay({ date = null, label = '', sub = null, today, late = false, children }) {
  const d = date ? new Date(date + 'T12:00:00') : null
  return (
    <div className="ag-day">
      <div className={'ag-date' + (late ? ' late' : '') + (date && date === today ? ' today' : '')}>
        {d ? <><b>{d.toLocaleDateString('en-CA', { weekday: 'short' })}</b><strong>{d.getDate()}</strong><span>{d.toLocaleDateString('en-CA', { month: 'short' })} · {relDay(date, today)}</span></>
          : <><b className="ag-date-word">{label}</b>{sub && <span>{sub}</span>}</>}
      </div>
      <ul className="ag-rows">{children}</ul>
    </div>)
}

// A row under its day: the day is already on the left, so the row says what it is, what kind, and the one button.
// `full` keeps the date in the line, for Overdue and Later where the left column is a word rather than a day.
function AgendaRow({ r, full, onToggle, onPick, go }) {
  const day = r.deadline?.day
  const when = full || !day ? r.when : String(r.when).replace(day, '').replace(/\s*·\s*$/, '').replace(/^\s*·\s*/, '').trim()
  return (
    <li className={'ag-row p-' + r.priority.level + (r.done ? ' done' : '')} style={{ '--c': r.color || 'var(--muted-2)' }}>
      {tickable(r)
        ? <button className={'todo-tick' + (r.done ? ' on' : '')} title={r.done ? 'Not done after all' : 'Mark it done'} onClick={() => onToggle(r)}><Icon.check width="12" height="12" /></button>
        : <span className="ag-ic">{r.type === 'sit' ? <Icon.board width="14" height="14" /> : <Icon.calendar width="14" height="14" />}</span>}
      <span className="ag-main">
        <button className="ag-title" onClick={() => onPick(r)} title="Open it on its own">{r.title}</button>
        <small>
          {r.course && <span className="tag">{r.course}</span>}
          {/* "In the class · in the tutorial" said the same thing twice: a thing that happens in the room is its place */}
          <span>{r.type === 'in-class' ? when : [r.kindLabel, when].filter(Boolean).join(' · ')}</span>
          <Flags r={r} small importantToo={!!(r.next || r.weekWork)} nature="graded" />
        </small>
      </span>
      {doable(r) && <button className="btn small" onClick={() => go(r.action)}>{r.action.fallback ? 'Open Quercus' : r.action.label}</button>}
    </li>)
}

// Claude as the brain (SPEC §20.37): what it decided in its last run, each with the reason it gave; what it asked you; what
// still waits for it. A placement you cannot see the reason for is a placement you cannot trust.
const DECIDED = { place: 'Placed', move: 'Moved', ignore: 'Set aside', review: 'Read', link: 'Linked', 'task-add': 'New task', 'task-edit': 'Changed', 'task-withdraw': 'Dropped', class: 'Class', ask: 'Asked you', answered: 'Settled' }
const WAITING = { file: 'file', page: 'Quercus page', 'page-update': 'changed page', announcement: 'announcement', desktop: 'from your Desktop folder' }
const segs = rel => String(rel || '').replace(/\.md$/, '').split('/')
// A task edit's summary ends with the fields the patch named — `(graded, dueTime)` — which are keys, not words.
const FIELD = { what: 'wording', class: 'class', week: 'week', due: 'date', dueTime: 'time', level: 'how crucial', kind: 'kind', link: 'link', source: 'source', graded: 'graded', reason: 'reason' }
const changedFields = d => { if (d.type !== 'task-edit') return null; const m = /\(([^()]*)\)$/.exec(d.summary || ''); return m ? m[1].split(', ').map(k => FIELD[k] || k).join(' · ') : null }
// "Hub/Inbox/ECO 208Y1/Ch 2.md → ECO 208Y1/Fall 2026/Week 2 (Sep 14)/Lectures/Ch 2.md" → "Ch 2 → Week 2 (Sep 14) · Lectures"
const decidedText = d => {
  const m = /^(.*) → (.*)$/.exec(d.summary || '')
  if (d.type === 'ignore') return segs(d.summary).pop()
  // "2026-09-07 Welcome → CLA 204H1/Fall 2026/Week 1 (Sep 7).md, …" → "2026-09-07 Welcome → Week 1 (Sep 7)"
  if (m && d.type === 'link') return `${m[1]} → ${m[2].split(', ').map(p => segs(p).pop()).join(', ')}`
  if (d.type === 'task-edit') return String(d.summary || '').replace(/\s*\([^()]*\)$/, '')
  if (!m || !['place', 'move'].includes(d.type)) return d.summary
  const to = segs(m[2]), where = to.slice(1, -1).filter(s => !/^(Fall|Winter|Summer|Spring) \d{4}$/.test(s)).join(' · ')
  return `${to[to.length - 1]} → ${where || to[0]}`
}
function ClaudeCard({ brain, courses = [], colorOf, onOpen }) {
  // Compact by default (SPEC §20.66): the question clamped, three decisions, the rest behind Show all — the card stood at
  // five times the height of the cards beside it.
  const [all, setAll] = useState(false)
  const code = k => courses.find(c => c.key === k)?.code || k
  const counts = Object.entries(brain.decisions.reduce((m, d) => ({ ...m, [d.type]: (m[d.type] || 0) + 1 }), {}))
  const shown = all ? brain.decisions : brain.decisions.slice(0, 3)
  const waiting = all ? brain.waiting : brain.waiting.slice(0, 3)
  const more = brain.decisions.length > 3 || brain.waiting.length > 3
  return (
    <section className={'card cl' + (all ? ' all' : '')}>
      <h2><span className="grow">Claude’s decisions</span>{brain.running && <span className="pill">working</span>}</h2>
      {brain.questions.length > 0 && (
        <div className="cl-block">
          <h3>It asked you</h3>
          <ul className="list">{brain.questions.map(q => (
            <li key={q.id}>{q.courseKey && <span className="tag" style={{ '--c': colorOf(q.courseKey) }}>{code(q.courseKey)}</span>}
              <span className="grow cl-q" onClick={() => setAll(true)} title={all ? undefined : 'Read the whole question'}>{q.text}{q.page && <small><button className="link" onClick={e => { e.stopPropagation(); onOpen(q.page) }}>{basename(q.page)}</button></small>}</span></li>))}</ul>
        </div>)}
      <div className="cl-block">
        <h3>{brain.lastRun ? `Last run · ${fmt(brain.lastRun.startedAt)}` : 'Last run'}</h3>
        {!brain.lastRun ? <p className="blank">Claude has not run yet.</p> : !brain.decisions.length ? <p className="blank">Nothing needed deciding.</p> : (<>
          <p className="cl-sum">{counts.map(([t, k]) => `${k} ${(DECIDED[t] || t).toLowerCase()}`).join(' · ')}</p>
          <ul className="cl-list">{shown.map(d => (
            <li key={d.id} title={all ? undefined : d.reason || undefined}><span className="cl-type">{DECIDED[d.type] || d.type}</span>
              <span className="grow">{decidedText(d)}{changedFields(d) && <span className="cl-fields">{changedFields(d)}</span>}{d.reason && <small>{d.reason}</small>}</span></li>))}</ul>
          {(more || brain.questions.length > 0) && <button className="link" onClick={() => setAll(a => !a)}>{all ? 'Show fewer' : brain.decisions.length > 3 ? `Show all ${brain.decisions.length}` : 'Show everything'}</button>}
        </>)}
      </div>
      {brain.waiting.length > 0 && (
        <div className="cl-block">
          <h3>Waiting for Claude <span className="cl-n">{brain.waiting.length}</span></h3>
          <ul className="list">{waiting.map(w => (
            <li key={w.id}><span className="tag" style={{ '--c': colorOf(w.courseKey) }}>{code(w.courseKey)}</span>
              <span className="grow"><button className="link" onClick={() => onOpen(w.page)}>{w.title}</button><small>{WAITING[w.kind] || w.kind}</small></span></li>))}</ul>
        </div>)}
    </section>)
}

// What arrived since the last check, grouped by course (SPEC §20.34): a count line per course, then its first three.
// It was one flat list — fourteen identical rows for a course added in term buried the one announcement that mattered.
function NewSince({ hub, colorOf, onOpen }) {
  const [all, setAll] = useState({})
  const items = [
    ...hub.news.map((n, i) => ({ key: 'n' + i, courseKey: n.courseKey, course: n.course, title: n.title, what: 'announcement', page: n.page })),
    ...hub.files.map((f, i) => ({ key: 'f' + i, courseKey: f.courseKey, course: f.course, title: f.name, what: 'file', sub: f.where, page: f.page })),
    ...(hub.pages || []).map((p, i) => ({ key: 'p' + i, courseKey: p.courseKey, course: p.course, title: p.title, what: p.updated ? 'changed page' : 'page', page: p.page })),
    ...(hub.sheets || []).map((s, i) => ({ key: 's' + i, courseKey: s.courseKey, course: s.course, title: `Study sheet · Session ${s.session}`, what: 'study sheet', sub: s.week, page: s.page })),
  ]
  const groups = [...items.reduce((m, x) => m.set(x.courseKey, [...(m.get(x.courseKey) || []), x]), new Map())]
  const counted = g => [['announcement', 'announcement'], ['file', 'file'], ['page', 'page'], ['study sheet', 'study sheet']]
    .map(([w, label]) => { const k = g.filter(x => x.what === w || (w === 'page' && x.what === 'changed page')).length; return k ? `${k} ${label}${k === 1 ? '' : 's'}` : null })
    .filter(Boolean).join(' · ')
  return (
    <section className="card nw">
      <h2><span className="grow">New since the last check</span>{items.length > 0 && <span className="pill">{items.length}</span>}</h2>
      {items.length === 0 ? <p className="blank">Nothing new.</p> : groups.map(([key, g]) => {
        const open = !!all[key], shown = open ? g : g.slice(0, 3)
        return (
          <div key={key} className="nw-course" style={{ '--c': colorOf(key) }}>
            <div className="nw-head"><span className="tag">{g[0].course}</span><span className="nw-sum">{counted(g)}</span></div>
            <ul className="nw-list">{shown.map(x => (
              <li key={x.key}><button className="nw-item" onClick={() => onOpen(x.page)}><span className="nw-title">{x.title}</span><span className="nw-what">{x.sub ? `${x.what} · ${x.sub}` : x.what}</span></button></li>))}</ul>
            {g.length > 3 && <button className="link nw-more" onClick={() => setAll(a => ({ ...a, [key]: !open }))}>{open ? 'Show fewer' : `Show all ${g.length}`}</button>}
          </div>)
      })}
    </section>)
}
