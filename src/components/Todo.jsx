import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { Flags } from './Flags.jsx'
import { Ring } from './Viz.jsx'
import TaskSheet from './TaskSheet.jsx'
import { rowsFor, isOpen, dayLabel } from '../todo.js'
import { usePlan, toggleTask, courseColor, todayIso, nowHM } from './plan/PlanBits.jsx'
import { daysTo } from '../plan.js'
import { useMyTasks, AddTask, toggleMyTask, removeMyTask } from './MyTasks.jsx'
import HowLong from './HowLong.jsx'
import { startWork } from '../work.js'
import { THIS as ED } from '../edition.js'
import '../styles/screens.css'
import '../styles/todo.css'

// To do (SPEC §20.18, rebuilt §20.19, simplified §20.34, a ledger §20.61). Every line is a thing you can act on: its
// button *does* it — opens the syllabus page, the problems page, the study sheet, or Quercus — and the circle ticks it.
// What each course's next class wants comes first, in its own group, because that is the first thing a course asks
// (SPEC §20.33); an online course has no next class, so this week's work stands there instead (SPEC §20.35). The rest
// follows by day. It was a grid of cards; forty cards that all said "required · Open it" read as one wall, so it is a
// ledger now, one line per thing, read down: the tick, the course, what it is, how crucial, when, the button.
// The rows themselves are src/todo.js, shared with Home and the course screen (SPEC §20.24).
// props: { onOpen(path), onOpenCourse(key), day (an ISO day the list is narrowed to, from the week's load strip on Home — SPEC §20.63), onDay(iso|null) }
const TEST_HORIZON = 14   // a test 54 days away is not something to do today — the course screen counts it down
const tickable = r => r.type === 'prep' || r.type === 'mine' || r.type === 'week'

export default function Todo({ onOpen, onOpenCourse, day = null, course = null, onDay = null }) {
  const { plan, error, fresh, busy, refresh, rebuild, patch } = usePlan({ refresh: true })
  const [hub, setHub] = useState(null)
  // Never synced. Without this the 404 was swallowed and the page said "You are clear" — which is not merely empty,
  // it is false, and falsely reassuring: it reads as "we checked, there is nothing" to someone whose install has
  // never once spoken to Quercus (SPEC §20.48).
  const [noHub, setNoHub] = useState(false)
  const [ctx, setCtx] = useState({})            // per course: links, general pages, Quercus url
  const [titles, setTitles] = useState([])
  const [only, setOnly] = useState('all')
  // Sent here for a day from a course's own strip (SPEC §20.64): that course's tab, until you change it.
  useEffect(() => { if (day) setOnly(course || 'all') }, [day, course])
  const [showDone, setShowDone] = useState(false)
  const [nature, setNature] = useState('all')   // graded, required, optional, or everything (SPEC §20.54)
  const [sheet, setSheet] = useState(null)
  const [clock, setClock] = useState(() => ({ today: todayIso(), now: nowHM() }))
  useEffect(() => { const t = setInterval(() => setClock({ today: todayIso(), now: nowHM() }), 60000); return () => clearInterval(t) }, [])
  const { today } = clock

  useEffect(() => { api.titles().then(setTitles).catch(() => {}) }, [])
  useEffect(() => {
    api.hub().then(async h => {
      setHub(h)
      const out = {}
      await Promise.all((h.courses || []).map(async c => {
        try { const d = await api.course(c.key); out[c.key] = { links: d.links.items, general: d.general, courseUrl: d.course.url } } catch { }
      }))
      setCtx(out)
    }).catch(e => setNoHub(e.status === 404))
  }, [])

  // A tick is drawn at once — on a class's tasks or on a week's own work — then the plan is read back from disk.
  const toggle = async (m, t) => {
    try {
      if (!(await toggleTask(m, t))) return false
      const flip = list => list.map(y => (y.key === t.key ? { ...y, done: !y.done } : y))
      patch(p => p ? { ...p, meetings: p.meetings.map(x => x.id !== m.id ? x : { ...x, before: flip(x.before), tasks: x.tasks ? { ...x.tasks, done: x.tasks.done + (t.done ? -1 : 1) } : x.tasks }),
        weeks: (p.weeks || []).map(x => x.id !== m.id ? x : { ...x, work: flip(x.work) }) } : p)
      refresh()
      return true
    } catch { return false }
  }
  // Your own tasks (SPEC §20.32): added with the line under the filters, ticked and deleted on their own page.
  const mine = useMyTasks((hub?.courses || []).map(c => c.code))
  // A tick asks how long it took (SPEC §22) — once, unless the timer is on that very thing.
  const [ask, setAsk] = useState(null)
  const [err, setErr] = useState(null)
  const tickRow = async r => {
    const wasOpen = !r.done
    let ticked = false
    if (r.type === 'prep' || r.type === 'week') ticked = await toggle(r.meeting, r.task)
    else if (r.type === 'mine') { try { ticked = await toggleMyTask(r.raw); mine.reload() } catch { } }
    else return
    // Only after a tick that took: a failed one changed nothing, and the session it would log would be false.
    if (ticked && wasOpen && ED.work !== false) { const w = await api.workStatus().catch(() => null); if (!(w?.running && w.running.rowId === r.id)) setAsk(r) }
  }
  // The server's own word when the timer cannot start ("already working on … — stop it first"), where he can read it.
  const startRow = async r => { try { setErr(null); await startWork(r) } catch (e) { setErr(`Could not start the timer: ${e.data?.error || e.message}`) } }
  const removeRow = async r => { try { await removeMyTask(r.raw); mine.reload() } catch { } }

  const rows = useMemo(() => rowsFor({
    plan, hub, tests: plan?.tests || [], today, now: clock.now, testHorizon: TEST_HORIZON,
    ctxFor: key => ({ ...(ctx[key] || {}), titles, color: courseColor(plan, key) }),
    mine: mine.tasks, courses: hub?.courses || [], past: showDone ? 'all' : 'open',
  }).map(r => (r.color || !r.courseKey ? r : { ...r, color: courseColor(plan, r.courseKey) })), [plan, hub, ctx, titles, today, clock.now, mine.tasks, showDone])

  const courses = [...new Map(rows.filter(r => r.courseKey).map(r => [r.courseKey, { key: r.courseKey, code: r.course, color: r.color }])).values()]
  const shown = rows.filter(r => (only === 'all' || r.courseKey === only) && (showDone || !r.done) && (nature === 'all' || r.nature === nature) && (!day || r.by === day))
  // What was missed first — a class or a week that has gone by with its task unticked, a hand-in past its day and not in,
  // back to the start of term (SPEC §20.54) — then what the next class wants, then by day. Whenever is your own undated tasks.
  const first = r => r.next || r.weekWork
  const late = r => !!r.deadline && r.deadline.daysLeft < 0 && !r.done
  const groups = [
    ['Missed', late, 'late'],
    ['Before your next class', r => !late(r) && first(r), 'next'],
    ['Today', r => !first(r) && r.by === today],
    ['Tomorrow', r => !first(r) && daysTo(r.by, today) === 1],
    ['This week', r => !first(r) && daysTo(r.by, today) > 1 && daysTo(r.by, today) <= 7],
    ['Later', r => !first(r) && !!r.deadline && daysTo(r.by, today) > 7],
    ['Whenever', r => !first(r) && !r.deadline && !(r.done && r.by < today)],
    ['Done', r => r.done && r.by < today, 'done'],   // shown only with "Show what is done"; used to match no group and vanish
  ]
  const open = rows.filter(isOpen).length
  const doneCount = rows.length - open

  return (
    <div className="home todo">
      <div className="home-head">
        <div>
          <div className="home-kicker">To do</div>
          <h1 className="home-title">{noHub ? 'Nothing checked yet' : day ? `${shown.filter(isOpen).length} thing${shown.filter(isOpen).length === 1 ? '' : 's'} on ${dayLabel(day)}` : open === 0 ? 'You are clear' : `${open} thing${open === 1 ? '' : 's'} to do`}</h1>
        </div>
        <div className="home-actions">
          {rows.length > 0 && <Ring value={doneCount} total={rows.length} size={60} stroke={6} sub="done" title={`${doneCount} of ${rows.length} done`} />}
          <button className="btn" onClick={() => rebuild()} disabled={busy} title="Rebuild the plan from the calendar and the announcements">{busy ? 'Working…' : 'Refresh'}</button>
        </div>
      </div>

      <div className="todo-filters">
        <span className="tabs">
          <button className={'tab' + (only === 'all' ? ' on' : '')} onClick={() => setOnly('all')}>Everything</button>
          {courses.map(c => <button key={c.key} className={'tab' + (only === c.key ? ' on' : '')} onClick={() => setOnly(c.key)}>{c.code}</button>)}
        </span>
        <span className="tabs todo-nature" title="Graded: a mark depends on it. Required: the course asks for it but does not mark it. Optional: you may skip it.">
          {[['all', 'All'], ['graded', 'Graded'], ['required', 'Required'], ['optional', 'Optional']].map(([k, l]) => (
            <button key={k} className={'tab' + (nature === k ? ' on' : '')} onClick={() => setNature(k)}>{l}</button>))}
        </span>
        {day && <button className="tab todo-day" onClick={() => onDay?.(null)} title="Only what is wanted on this day — click to see every day again">{dayLabel(day)}<Icon.x width="11" height="11" /></button>}
        <label className="todo-showdone"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />Show what is done</label>
      </div>
      {hub && <AddTask key={only} courses={hub.courses || []} defaultCourse={only !== 'all' ? only : null} onAdded={mine.reload} />}
      {err && <div className="home-error" onClick={() => setErr(null)}>{err}</div>}

      {(noHub || fresh || (error && !plan)) && (
        <div className="home-first">
          <h2>{noHub ? 'Quercus has not been checked yet' : fresh ? 'Nothing planned yet' : 'The plan could not be read'}</h2>
          <p>{noHub ? 'This page fills in from your courses — what each one wants done before it next meets, and what is due. Press Check Quercus on Home to fetch them for the first time.'
            : fresh ? 'This fills in once your week has been built from your timetable and what your courses have posted.'
              : <>This is what it said: <span className="home-first-why">{error}</span></>}</p>
          {!noHub && <button className="btn primary" onClick={() => rebuild()} disabled={busy}>{busy ? 'Working…' : fresh ? 'Build it' : 'Try again'}</button>}
        </div>
      )}

      {groups.map(([label, test, kind]) => {
        const g = shown.filter(test)
        if (!g.length) return null
        return (
          <section key={label} className={'todo-group' + (kind ? ' ' + kind : '')}>
            <header className="todo-group-head">
              <h2>{label}<span className="todo-group-n">{g.length}</span></h2>
              {kind === 'next' && <p className="todo-group-sub">What each course wants done before it meets again, and this week's work for a course with no classes.</p>}
              {kind === 'late' && <p className="todo-group-sub">Its day has passed and it is not ticked, back to the start of term. Tick it, or leave it and it stays.</p>}
            </header>
            <ul className="todo-rows">
              {g.map(r => <TodoRow key={r.id} r={r} inNext={kind === 'next'} onOpen={onOpen} onOpenCourse={onOpenCourse} onToggle={() => tickRow(r)} onExpand={() => setSheet(r)} onStart={ED.work !== false && !r.done ? () => startRow(r) : null} />)}
            </ul>
          </section>)
      })}
      {shown.length === 0 && plan && !noHub && <p className="blank todo-clear">Nothing to do{only !== 'all' ? ' for this course' : ''}.{doneCount > 0 && !showDone && <> <button className="link" onClick={() => setShowDone(true)}>Show the {doneCount} you have done</button></>}</p>}

      {ask && <HowLong row={ask} planned={null} onDone={() => setAsk(null)} />}
      {sheet && <TaskSheet item={sheet} onClose={() => setSheet(null)} onOpen={onOpen}
        onToggle={tickable(sheet) ? () => tickRow(sheet) : null}
        onDelete={sheet.type === 'mine' ? () => removeRow(sheet) : null} />}
    </div>
  )
}

// One line of the ledger: the tick, the course, the title with its kind and when under it, how crucial, the date, and
// the one button that does it. How crucial it is shows only when it changes what you do: crucial, or optional; in the
// next-class group the group already says important. The title opens the thing on its own.
function TodoRow({ r, inNext, onOpen, onOpenCourse, onToggle, onExpand, onStart = null }) {
  const go = e => { e.stopPropagation(); if (!r.action) return; if (r.action.url) window.open(r.action.url, '_blank', 'noopener'); else onOpen(r.action.path) }
  const due = r.deadline ? r.deadline.rel : ''
  const urgent = !!r.deadline && r.deadline.daysLeft <= 1
  return (
    <li className={'todo-row t-' + r.type + ' p-' + (r.priority?.level || 'normal') + (r.done ? ' done' : '') + (r.overdue ? ' late' : '')} style={{ '--c': r.color || 'var(--muted-2)' }}>
      {tickable(r)
        ? <button className={'todo-tick' + (r.done ? ' on' : '')} onClick={onToggle} title={r.done ? 'Not done after all' : 'Mark it done'}><Icon.check width="13" height="13" /></button>
        : <span className="todo-ic" title={r.type === 'sit' ? 'A test' : r.type === 'in-class' ? 'Happens in the class' : undefined}>{r.type === 'sit' ? <Icon.board width="14" height="14" /> : r.type === 'in-class' ? <Icon.calendar width="14" height="14" /> : <Icon.checklist width="14" height="14" />}</span>}
      <span className="todo-row-course">{r.courseKey ? <button className="tag" onClick={() => onOpenCourse(r.courseKey)} title={`Open ${r.course}`}>{r.course}</button> : <span className="todo-row-yours">yours</span>}</span>
      <button className="todo-row-main" onClick={onExpand} title="Open it on its own">
        <span className="todo-row-title">{r.title}</span>
        <small>{[r.kindLabel, r.when].filter(Boolean).join(' · ')}{!r.action && r.note ? ` · ${r.note}` : ''}</small>
      </button>
      <span className="todo-row-flags"><Flags r={r} importantToo={!inNext} /></span>
      <span className={'todo-row-due' + (urgent ? ' urgent' : '')} title={r.deadline?.day || undefined}>{due}</span>
      <span className="todo-row-act">
        {onStart && tickable(r) && !r.inClass && <button className="icon-btn todo-start" onClick={onStart} title="Start the timer on it"><Icon.clock width="14" height="14" /></button>}
        {r.action && !r.inClass && !r.notOpen
          ? <button className="btn small todo-do" onClick={go}>{r.action.label}{r.action.url ? <Icon.external width="11" height="11" /> : null}</button>
          : null}
      </span>
    </li>)
}
