import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import TaskSheet from './TaskSheet.jsx'
import HowLong from './HowLong.jsx'
import { ClassSheet } from './Timetable.jsx'
import { rowsFor } from '../todo.js'
import { usePlan, toggleTask, courseColor, todayIso, nowHM } from './plan/PlanBits.jsx'
import { useMyTasks, toggleMyTask, addMyTask } from './MyTasks.jsx'
import { shortIso, addDays, daysTo } from '../calendar.js'
import { renderMyTask } from '../mytasks.js'
import { startWork, kindOfRow, DEFAULT_MINUTES } from '../work.js'
import { wallsOf, snapStart, pushDown, isMissed, draftCount, dayClock, unwrapped } from '../today.js'
import '../styles/day.css'

// Today's work (SPEC §23, his answers of 2026-09-29): the to-dos on the left, the day on the right as a timeline in the
// manner of Structured — a rail, a capsule per thing in its course's pigment, the words beside it, height by duration.
// Two states only: faded is a draft (Claude's proposal, or his own drop he has not confirmed), solid is confirmed. He
// confirms one block or the whole day; anything he adds or moves after that is faded again until he confirms the
// change. Taking a block off puts the to-do back in the list with no hour, and Claude never proposes it again that day.
// Nothing here drafts by itself: Claude drafts at 07:00 or when Draft is pressed, and nothing refills a hole.
// props: { onOpen(path), onOpenCourse(key) }
const PX = 180                                               // pixels an hour: a ten-minute block is 30 px, one line
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0) }
const HHMM = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`
const clock = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`     // unwrapped, the way the API reads it
const dur = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`)
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const round5 = n => Math.round(n / 5) * 5
const longDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })
const tickable = r => !!r && (r.type === 'prep' || r.type === 'mine' || r.type === 'week')
const CLAUDE = '#8b6cf6'

// A glyph per kind of work, drawn in the course's pigment (his answer: "icon by kind, course color").
const svg = (d, extra = {}) => props => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...extra} {...props}>{d}</svg>
const G = {
  spark: svg(<path d="M8 1.5l1.4 4.1L13.5 7 9.4 8.4 8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor" stroke="none" />),
  fork: svg(<><path d="M5 1.5v5a1.5 1.5 0 0 0 3 0v-5M6.5 1.5v13" /><path d="M11.5 14.5v-13c-1.6.6-2.3 2.4-2.3 4.6 0 1.6.7 2.4 2.3 2.4" /></>),
  walk: svg(<><circle cx="9" cy="2.6" r="1.3" fill="currentColor" stroke="none" /><path d="M7.5 5.5L6 9.5l2.5 1.5.5 3.5M7.5 5.5l2.5 1 1.5 2M6 9.5l-2 4.5M7.5 5.5L5 6.5 4 8.5" /></>),
  play: svg(<path d="M5 3l8 5-8 5z" fill="currentColor" stroke="none" />),
  flag: svg(<><path d="M3.5 14.5v-13" /><path d="M3.5 2h8l-1.8 3 1.8 3h-8" /></>),
  chat: svg(<path d="M2.5 3.5h11v7h-6l-3.5 3v-3h-1.5z" />),
  event: svg(<><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></>),
  left: svg(<path d="M10 3L5 8l5 5" />),
  right: svg(<path d="M6 3l5 5-5 5" />),
}
const KIND_ICON = { read: Icon.book, watch: Icon.video, problems: Icon.pencil, review: Icon.checklist, write: Icon.pen, due: G.flag, quiz: Icon.checkSquare, participation: G.chat, prepare: Icon.clipboard, bring: Icon.clip, mine: Icon.star, other: Icon.dot }
const glyphOf = kind => KIND_ICON[kind] || Icon.dot

export default function Work({ onOpen, onOpenCourse }) {
  // The clock as the day reads it (src/today.js dayClock): until the hard end a night past midnight is still the day
  // before, at 24:40 — its blocks after midnight are not missed, the now-line and Start stay, a Redraft starts from now.
  const [wallClock, setWallClock] = useState(() => ({ date: todayIso(), min: toMin(nowHM()) }))
  const [data, setData] = useState(null)
  const { date: today, nowMin: nowM } = dayClock(wallClock.date, wallClock.min, data?.day?.window?.hardEndMin ?? 1620)
  const now = unwrapped(nowM)                                  // HH:MM that sorts as text, for rowsFor
  const [view, setView] = useState(today)
  const viewRef = useRef(view); viewRef.current = view
  const isToday = view === today
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [sheet, setSheet] = useState(null)
  const [picked, setPicked] = useState(null)
  const [ask, setAsk] = useState(null)
  const [drag, setDrag] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [draftMenu, setDraftMenu] = useState(false)
  const [draftNote, setDraftNote] = useState('')
  const [drafting, setDrafting] = useState(null)
  const [sending, setSending] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [justAdded, setJustAdded] = useState([])
  const laneRef = useRef(null), calRef = useRef(null), listRef = useRef(null), dragRef = useRef(null), draftBtn = useRef(null), draftPop = useRef(null)
  const { plan, refresh } = usePlan({ refresh: false })
  const [hub, setHub] = useState(null)
  const [titles, setTitles] = useState([])
  const courses = hub?.courses || []
  const mine = useMyTasks(courses.map(c => c.code))

  const load = () => { const d = viewRef.current; return api.day(d).then(r => { if (viewRef.current !== d) return; setData(r); if (r.drafting) setDrafting(r.drafting); if (r.sending) setSending(r.sending) }).catch(e => setError(e.message)) }
  useEffect(() => { api.hub().then(setHub).catch(() => { }); api.titles().then(setTitles).catch(() => { }) }, [])
  useEffect(() => { setData(null); load() }, [view])
  useEffect(() => { const t = setInterval(() => { setWallClock({ date: todayIso(), min: toMin(nowHM()) }); load() }, 60000); return () => clearInterval(t) }, [])
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), 9000); return () => clearTimeout(t) }, [error])
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t) }, [notice])
  useEffect(() => { const h2 = () => load(); window.addEventListener('slate:work', h2); window.addEventListener('slate:plan', h2); return () => { window.removeEventListener('slate:work', h2); window.removeEventListener('slate:plan', h2) } }, [])
  useEffect(() => {
    let t = null
    // The plan reloads itself on its own events (usePlan); the day is read again when anything it is made of changes.
    const un = api.events?.(ev => { const p = String(ev?.path || ev?.rel || ev?.file || ''); if (!/_day|_work-log|_attendance|_estimates|_plan\.json|Plan\.md|My tasks/.test(p)) return; clearTimeout(t); t = setTimeout(load, 400) })
    return () => { clearTimeout(t); if (typeof un === 'function') un() }
  }, [])
  // A session running (the day agent, the calendar agent): watch it, and read the day when it ends.
  const watchJob = (job, statusFn, set) => {
    if (!job?.running) return
    const t0 = job.startedAt ? new Date(job.startedAt).getTime() : Date.now()
    const id = setInterval(async () => {
      setElapsed(Math.round((Date.now() - t0) / 1000))
      const st = await statusFn().catch(() => null)
      if (st) { set(st); if (!st.running) { clearInterval(id); load(); refresh() } }
    }, 2500)
    return () => clearInterval(id)
  }
  useEffect(() => watchJob(drafting, api.dayDraftStatus, setDrafting), [drafting?.running, drafting?.startedAt])
  useEffect(() => watchJob(sending, api.daySendStatus, setSending), [sending?.running, sending?.startedAt])
  useEffect(() => {
    if (!draftMenu) return
    const down = e => { if (draftPop.current?.contains(e.target) || draftBtn.current?.contains(e.target)) return; setDraftMenu(false) }
    const key = e => { if (e.key === 'Escape') setDraftMenu(false) }
    window.addEventListener('pointerdown', down); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key) }
  }, [draftMenu])

  // ---- the rows and the day ------------------------------------------------------------------------------------
  // `past: 'all'` keeps a finished to-do of a class gone by, so its block still knows it is done.
  const rows = useMemo(() => rowsFor({ plan, hub, tests: plan?.tests || [], today: view, now: isToday ? now : null, testHorizon: 14, ctxFor: () => ({ titles }), mine: mine.tasks, courses, past: 'all' })
    .map(r => (r.color || !r.courseKey ? r : { ...r, color: courseColor(plan, r.courseKey) })), [plan, hub, titles, view, now, mine.tasks])
  const rowOf = id => rows.find(r => r.id === id) || null
  const day = data?.day || null
  const running = data?.running || null
  const blocks = useMemo(() => (day?.blocks || []).map(b => { const row = rowOf(b.rowId); const done = !!b.done || !!row?.done; return { ...b, row, done, missed: isMissed({ ...b, done }, { date: view, today, nowMin: nowM }), running: !!running && running.rowId === b.rowId } }), [day, rows, running, nowM])
  const counts = draftCount({ ...day, blocks })
  const scheduled = useMemo(() => { const m = new Map(); for (const b of blocks) if (!m.has(b.rowId)) m.set(b.rowId, b); return m }, [blocks])

  // ---- acts ---------------------------------------------------------------------------------------------------------
  const act = async body => {
    try { const r = await api.dayAct({ date: view, ...body }); if (r?.day) setData(d => ({ ...d, day: r.day })); if (r?.notice) setNotice(r.notice); setError(null) }
    catch (e) { setError(e.data?.error || e.message); load() }
  }
  const place = (rowId, start, end) => act({ op: 'place', rowId, start: clock(start), end: clock(end) })
  const move = (id, start, end) => act({ op: 'move', id, start: clock(start), end: clock(end) })
  const remove = id => act({ op: 'remove', id })
  const confirm = ids => act({ op: 'confirm', ...(ids ? { ids } : {}) })
  const moveMeal = (name, start) => act({ op: 'meal', name, start: start == null ? null : clock(start) })
  const sizeMeal = (name, minutes, start) => act({ op: 'mealsize', name, minutes, ...(start != null ? { start: clock(start) } : {}) })
  const workable = (id, on) => act({ op: 'workable', id, on })
  const draft = async () => {
    setDraftMenu(false)
    try { const r = await api.dayDraft({ date: view, note: draftNote }); if (r.day) setData(d => ({ ...d, day: r.day })); else { setDrafting(r); setElapsed(0) } setDraftNote('') }
    catch (e) { setError(e.data?.error || e.message) }
  }
  const send = async () => { try { const r = await api.daySend({ date: view }); setSending(r); setElapsed(0) } catch (e) { setError(e.data?.error || e.message) } }
  const tick = async row => {
    if (!tickable(row)) return
    try {
      if (row.type === 'mine') { const ok = await toggleMyTask(row.raw); mine.reload(); if (!ok) return }
      else { if (!(await toggleTask(row.meeting, row.task))) return; refresh() }
      const b = scheduled.get(row.id)
      if (!row.done && !(running && running.rowId === row.id)) setAsk({ row, planned: b ? b.end - b.start : null })
      setTimeout(load, 400)
    } catch (e) { setError(`Could not tick “${row.title}”: ${e.message}`) }
  }
  const start = async (row, b) => { try { await startWork(row, { block: { id: b.id, minutes: b.end - b.start } }); load() } catch (e) { setError(e.data?.error || e.message) } }
  const attend = async (m, attended) => { try { const r = await api.attendance({ meetingId: m.id, attended, courseKey: m.courseKey, date: m.date, kind: m.kind }); setData(d => ({ ...d, attendance: r.classes })); load() } catch (e) { setError(e.message) } }
  const openBlock = b => b.row && setSheet({ ...b.row, blockWhy: b.why || null, blockBy: b.by, blockAt: HHMM(b.start) })

  // ---- the lane ---------------------------------------------------------------------------------------------------
  const busy = day?.busy || []
  const win = day?.window || { startMin: 540, endMin: 1440, hardEndMin: 1620 }
  const hard = win.hardEndMin
  const from = Math.floor(Math.min(win.startMin, ...busy.map(b => b.start), ...blocks.map(b => b.start)) / 60) * 60
  const to = hard
  const y = m => ((clamp(m, from, to) - from) / 60) * PX
  const timeAt = clientY => { const el = laneRef.current; if (!el) return from; return from + ((clientY - el.getBoundingClientRect().top) / PX) * 60 }
  const overLane = (x, yy) => { const el = calRef.current; if (!el) return false; const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && yy >= r.top && yy <= r.bottom }
  const overList = (x, yy) => { const el = listRef.current; if (!el) return false; const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && yy >= r.top && yy <= r.bottom }
  // What a drop may not sit on: the classes, walks, events he cannot work through, meals — and the blocks already done.
  const wallsFor = (kind, exceptId = null) => [...wallsOf(busy, { meals: kind !== 'meal' }), ...blocks.filter(b => b.done && b.id !== exceptId).map(b => ({ start: b.start, end: b.end }))]
  const pushable = blocks.map(b => ({ id: b.id, start: b.start, end: b.end, done: b.done }))

  // begin(e, d): d = { kind: 'row' | 'block' | 'resize' | 'meal' | 'mealsize', … }. A press without movement is a click.
  // The drag lives in a ref beside its state: the release reads the ref, so a quick flick drops where the pointer was.
  const begin = (e, d) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); const st = { ...d, y0: e.clientY, x0: e.clientX, moved: false, over: d.kind !== 'row', off: false, grab: d.kind === 'row' ? 0 : timeAt(e.clientY) - (d.start ?? from) }; dragRef.current = st; setDrag(st) }
  useEffect(() => {
    if (!drag) return
    const onMove = e => {
      const d = dragRef.current; if (!d) return
      const moved = d.moved || Math.abs(e.clientY - d.y0) > 4 || Math.abs(e.clientX - d.x0) > 4
      if (!moved) return
      const over = overLane(e.clientX, e.clientY), off = d.kind === 'block' && overList(e.clientX, e.clientY)
      const p = calRef.current
      if (p && over) { const pr = p.getBoundingClientRect(); if (e.clientY < pr.top + 56) p.scrollTop -= 14; else if (e.clientY > pr.bottom - 56) p.scrollTop += 14 }
      let next
      if (d.kind === 'resize' || d.kind === 'mealsize') {
        const w = wallsFor(d.kind === 'mealsize' ? 'meal' : 'block', d.id).filter(x => x.start >= d.start + 5)
        let end = clamp(round5(timeAt(e.clientY)), d.start + (d.kind === 'mealsize' ? 15 : 10), hard)
        const wall = w.filter(x => x.start < end).sort((a, b) => a.start - b.start)[0]
        if (wall) end = Math.max(d.start + (d.kind === 'mealsize' ? 15 : 10), wall.start)     // the foot stops at the next wall, as the server does
        if (d.kind === 'mealsize') end = d.start + clamp(Math.floor((end - d.start) / 5) * 5, 15, 240)   // a meal is 15 to 240 minutes, in fives — all the server keeps
        next = { ...d, moved, over: true, end }
      } else {
        const raw = clamp(round5(timeAt(e.clientY) - d.grab), 0, hard - d.len)
        const s = over ? snapStart(raw, d.len, wallsFor(d.kind === 'meal' ? 'meal' : 'block', d.id), from, hard) : raw
        next = { ...d, moved, over, off, start: s, end: s + d.len }
      }
      dragRef.current = next; setDrag(next)
    }
    const up = () => {
      const d = dragRef.current; dragRef.current = null; setDrag(null)
      if (!d) return
      if (!d.moved) { d.onClick?.(); return }
      if (d.kind === 'row') { if (d.over && d.start != null) place(d.rowId, d.start, d.end) }
      else if (d.kind === 'block') { if (d.off) remove(d.id); else if (d.over && d.start !== d.s0) move(d.id, d.start, d.end) }
      else if (d.kind === 'resize') { if (d.end !== d.e0) move(d.id, d.start, d.end) }
      else if (d.kind === 'meal') { if (d.over && d.start !== d.s0) moveMeal(d.name, d.start) }
      else if (d.kind === 'mealsize') { if (d.end !== d.e0) sizeMeal(d.name, d.end - d.start) }
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [!!drag, from, hard, day])

  // While something is dragged over the lane, the blocks it would push are drawn where they would go.
  const preview = useMemo(() => {
    if (!drag?.moved || !drag.over || drag.start == null) return null
    if (drag.kind === 'mealsize' || drag.kind === 'resize') { const anchor = { id: drag.id || 'meal', start: drag.start, end: drag.end }; return pushDown(pushable, anchor, wallsFor(drag.kind === 'mealsize' ? 'meal' : 'block', drag.id).filter(w => !(w.start === drag.s0 && drag.kind === 'mealsize')), { hardEnd: hard }) }
    const anchor = { id: drag.kind === 'block' ? drag.id : drag.kind === 'meal' ? `meal:${drag.name}` : '__new', start: drag.start, end: drag.end }
    const walls = drag.kind === 'meal' ? wallsOf(busy.filter(b => !(b.kind === 'meal' && b.title === drag.name))) : wallsFor('block', drag.id)
    return pushDown(pushable, anchor, walls, { hardEnd: hard })
  }, [drag, blocks, busy])
  const shownAt = b => { if (drag?.moved && (drag.kind === 'block' || drag.kind === 'resize') && drag.id === b.id) return drag; const p = preview?.blocks.find(x => x.id === b.id); return p || b }

  const scrolled = useRef(null)
  useEffect(() => {
    if (!day || day.date !== view || !calRef.current || scrolled.current === view) return
    scrolled.current = view
    const first = Math.min(...blocks.filter(b => !b.done).map(b => b.start), Infinity)
    const at = isToday ? nowM - 60 : Number.isFinite(first) ? first - 30 : win.startMin
    calRef.current.scrollTop = Math.max(0, ((at - from) / 60) * PX - 40)
  }, [day, view])

  // ---- the list -----------------------------------------------------------------------------------------------------
  // For the day: what he just added, Claude's picks in his order, what is on the day, what is due by tomorrow, and his
  // own tasks — "Show all" has everything open, by when it is due.
  const openRows = rows.filter(r => !r.inClass && r.type !== 'sit' && r.type !== 'in-class' && (!r.done || scheduled.has(r.id)))
  const dueIn = r => (r.by && r.by !== '9999-12-31' ? daysTo(r.by, view) : null)
  const forDay = useMemo(() => {
    const out = [], seen = new Set(), push = r => { if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r) } }
    const open = new Map(openRows.map(r => [r.id, r]))
    for (const id of justAdded) push(open.get(id))
    for (const id of day?.draft?.picks || []) push(open.get(id))
    for (const b of blocks) push(open.get(b.rowId))
    // Behind is not "due soon": the backlog comes in through Claude's picks, or when it is crucial, never all at once.
    const soon = r => !r.overdue && dueIn(r) != null && dueIn(r) >= 0 && dueIn(r) <= 1
    const rest = openRows.filter(r => !seen.has(r.id) && !r.done && (soon(r) || (r.overdue && r.priority?.level === 'crucial') || (r.type === 'mine' && (dueIn(r) == null || dueIn(r) <= 1)) || (day?.removed || []).includes(r.id)))
    rest.sort((a, b) => (dueIn(a) ?? 99) - (dueIn(b) ?? 99)).forEach(push)
    return out
  }, [openRows, day, blocks, justAdded])
  const groups = useMemo(() => {
    const g = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [] }
    for (const r of openRows) { const d = dueIn(r); if (r.overdue) g.overdue.push(r); else if (d == null) g.none.push(r); else if (d <= 0) g.today.push(r); else if (d === 1) g.tomorrow.push(r); else if (d <= 7) g.week.push(r); else g.later.push(r) }
    return [['today', isToday ? 'Due today' : `Due ${shortIso(view)}`, g.today], ['tomorrow', 'Due the next day', g.tomorrow], ['week', 'This week', g.week], ['overdue', 'Behind', g.overdue], ['later', 'Later', g.later], ['none', 'No date', g.none]].filter(([, , l]) => l.length)
  }, [openRows, view])
  const added = id => { mine.reload(); setJustAdded(a => [id, ...a.filter(x => x !== id)]); setTimeout(load, 500) }

  // ---- the header's words -------------------------------------------------------------------------------------------
  const dayWord = isToday ? 'today' : view === addDays(today, 1) ? 'tomorrow' : shortIso(view)
  const hasClaudeDraft = blocks.some(b => b.by === 'claude')
  const status = drafting?.running && drafting.date === view ? `Claude is drafting ${dayWord}… ${elapsed}s`
    : !blocks.length ? (day?.draft ? 'Claude found nothing to place' : 'Nothing planned yet')
    : counts.drafts === 0 ? `Confirmed${day?.confirmedAt ? ` at ${String(day.confirmedAt).slice(11, 16)}` : ''}`
    : counts.changes ? `${counts.drafts} change${counts.drafts === 1 ? '' : 's'} to confirm`
    : `Draft · ${counts.drafts} block${counts.drafts === 1 ? '' : 's'} to confirm${counts.confirmed ? ` · ${counts.confirmed} confirmed` : ''}`
  const canSend = counts.confirmed > 0 && counts.drafts === 0
  const sentLine = sending?.running ? `Sending to Google Calendar… ${elapsed}s` : sending && sending.ok === false ? `Could not send: ${sending.note || 'see the log'}` : day?.sent?.failed ? `Google Calendar: ${day.sent.failed}` : day?.sent ? `In Google Calendar since ${String(day.sent.at).slice(11, 16)}` : null
  const lifting = !!drag?.moved && drag.kind === 'block'
  const planned = blocks.filter(b => !b.done).reduce((n, b) => n + b.end - b.start, 0)

  return (
    <div className="dy">
      <header className="dy-top">
        <div className="dy-date">
          <div className="dy-nav">
            <h1>{longDate(view)}</h1>
            <button className="dy-round" onClick={() => setView(addDays(view, -1))} title="The day before"><G.left /></button>
            <button className="dy-round" onClick={() => setView(addDays(view, 1))} title="The day after"><G.right /></button>
            {!isToday && <button className="dy-pill small" onClick={() => setView(today)}>Today</button>}
          </div>
          <p className={'dy-status' + (drafting?.running ? ' busy' : '')}>
            {drafting?.running && <i className="dy-pulse" />}
            <span>{status}</span>
            {planned > 0 && !drafting?.running && <span className="dy-dim"> · {dur(planned)} of work</span>}
            {day?.draft?.steer && hasClaudeDraft && <span className="dy-steer"><G.spark width="11" height="11" /> {day.draft.steer}</span>}
          </p>
        </div>
        <div className="dy-actions">
          {data?.brain !== false && <span className="dy-anchor">
            <button ref={draftBtn} className="dy-pill ghost claude" disabled={!!drafting?.running} onClick={() => setDraftMenu(m => !m)} title="Claude drafts the day around what you already put on it">
              <G.spark width="13" height="13" />{drafting?.running ? 'Drafting…' : hasClaudeDraft || day?.draft ? 'Redraft' : 'Draft my day'}
            </button>
            {draftMenu && <form className="dy-pop" ref={draftPop} onSubmit={e => { e.preventDefault(); draft() }}>
              <label>Anything for Claude? <small>optional</small></label>
              <input autoFocus value={draftNote} onChange={e => setDraftNote(e.target.value)} placeholder="light day · ECO208 first · nothing after 22:00" maxLength={300} />
              <p>{isToday ? `From ${HHMM(nowM)} on.` : 'The whole day.'} Only Claude’s faded blocks are replaced — what you put down or confirmed stays, and what you took off is never proposed again.</p>
              <button className="dy-pill dark" type="submit"><G.spark width="12" height="12" />Draft</button>
            </form>}
          </span>}
          {data?.brain === false && <button className="dy-pill ghost" onClick={draft}>Draft</button>}
          {counts.drafts > 0 && <button className="dy-pill dark" onClick={() => confirm(null)} title="Every faded block becomes solid">{counts.changes ? `Confirm ${counts.drafts} change${counts.drafts === 1 ? '' : 's'}` : counts.confirmed ? 'Confirm the rest' : 'Confirm day'}<span className="dy-count">{counts.drafts}</span></button>}
          {canSend && <button className="dy-pill ghost" disabled={!!sending?.running} onClick={send} title="Your confirmed blocks as events in your Google Calendar"><G.event width="13" height="13" />{sending?.running ? 'Sending…' : day?.sent ? 'Send again' : 'Send to Google Calendar'}</button>}
        </div>
        {sentLine && <p className="dy-sent">{sentLine}</p>}
      </header>
      {data && !('drafting' in data) && <div className="dy-banner">Slate is still running an older server under this screen: quit Slate (Cmd-Q) and open it again.</div>}
      {drafting && !drafting.running && drafting.ok === false && drafting.date === view && <div className="dy-banner">Claude’s draft did not finish: {drafting.note || 'see the output'}</div>}

      <div className={'dy-body' + (drag?.moved ? ' dragging' : '')}>
        <aside className={'dy-list' + (lifting && drag.off ? ' drop' : '')} ref={listRef}>
          <div className="dy-list-head">
            <div className="dy-seg">
              <button className={showAll ? '' : 'on'} onClick={() => setShowAll(false)}>For {dayWord}<span>{forDay.length}</span></button>
              <button className={showAll ? 'on' : ''} onClick={() => setShowAll(true)}>All<span>{openRows.filter(r => !r.done).length}</span></button>
            </div>
            <Adder courses={courses} date={view} onAdded={added} onError={setError} />
            {lifting && <p className="dy-dropnote">Drop here to take it off the day — it comes back to this list.</p>}
          </div>
          {!showAll
            ? <ul className="dy-rows">{forDay.map(r => <Row key={r.id} r={r} b={scheduled.get(r.id)} day={today} dragging={drag?.kind === 'row' && drag.rowId === r.id} onTick={() => tick(r)} onOpen={() => setSheet(r)} onJump={b => { if (calRef.current) calRef.current.scrollTo({ top: Math.max(0, y(b.start) - 80), behavior: 'smooth' }) }}
                onBegin={e => begin(e, { kind: 'row', rowId: r.id, title: r.title, color: r.color, kindOf: kindOfRow(r), len: Math.max(10, minutesOf(r, data?.estimates)), start: null, end: null, onClick: () => setSheet(r) })} />)}
                {!forDay.length && <li className="dy-empty">Nothing due by {view === today ? 'tomorrow' : 'the next day'}. <button className="link" onClick={() => setShowAll(true)}>Show all</button></li>}</ul>
            : groups.map(([key, label, list]) => (
              <section key={key} className="dy-group"><h3>{label}<span>{list.length}</span></h3>
                <ul className="dy-rows">{list.map(r => <Row key={r.id} r={r} b={scheduled.get(r.id)} day={today} dragging={drag?.kind === 'row' && drag.rowId === r.id} onTick={() => tick(r)} onOpen={() => setSheet(r)} onJump={b => { if (calRef.current) calRef.current.scrollTo({ top: Math.max(0, y(b.start) - 80), behavior: 'smooth' }) }}
                  onBegin={e => begin(e, { kind: 'row', rowId: r.id, title: r.title, color: r.color, kindOf: kindOfRow(r), len: Math.max(10, minutesOf(r, data?.estimates)), start: null, end: null, onClick: () => setSheet(r) })} />)}</ul>
              </section>))}
        </aside>

        <section className="dy-cal" ref={calRef}>
          {!day ? <div className="dy-loading">Reading the day…</div> : (
            <div className="dy-lane" ref={laneRef} style={{ height: y(to) + 40 }}>
              {hoursOf(from, to).map(m => <div key={m} className={'dy-hour' + (m >= 1440 ? ' late' : '')} style={{ top: y(m) }}><span>{HHMM(m)}</span></div>)}
              <div className="dy-night" style={{ top: y(1440), height: y(to) - y(1440) }}><span>after midnight</span></div>
              <div className="dy-rail" />
              {freeGaps(busy, blocks, Math.max(win.startMin, isToday ? nowM : 0), win.endMin).map(g => <div key={'f' + g.start} className="dy-free" style={{ top: y(g.start), height: y(g.end) - y(g.start) }}><span>{dur(g.end - g.start)} free</span></div>)}
              {busy.filter(b => b.kind === 'event' && b.workable && !b.skipped).map((b, i) => (
                <button key={'wk' + i} className="dy-band" style={{ top: y(b.start), height: Math.max(22, y(b.end) - y(b.start)) }} onClick={() => b.id && workable(b.id, false)} title={`${b.title} · ${HHMM(b.start)}–${HHMM(b.end)} — time you can work in. Click if you can’t after all.`}><span>{b.title} · you can work here</span></button>))}
              {busy.filter(b => !(b.kind === 'event' && b.workable && !b.skipped) && b.kind !== 'kept' && b.kind !== 'past').map((b, i) => {
                if (b.kind === 'walk') return <div key={'w' + i} className="dy-walk" style={{ top: y(b.start), height: y(b.end) - y(b.start) }}><G.walk width="11" height="11" />{b.end - b.start} min walk</div>
                if (b.kind === 'meal') {
                  const d = drag && (drag.kind === 'meal' || drag.kind === 'mealsize') && drag.name === b.title ? drag : null
                  const s = d ? d.start : b.start, e = d ? d.end : b.end
                  return <Item key={'m' + i} top={y(s)} h={y(e) - y(s)} cls={'meal' + (d?.moved ? ' dragging' : '')} color="var(--dy-meal)" icon={G.fork} title={b.title} meta={`${HHMM(s)}–${HHMM(e)} · ${e - s} min`}
                    onDown={ev => begin(ev, { kind: 'meal', name: b.title, len: b.end - b.start, s0: b.start, start: b.start, end: b.end })} onDouble={() => day.meals?.[b.title] && moveMeal(b.title, null)}
                    hint={`${b.title} — drag to another hour${day.meals?.[b.title] ? ', double-click to put it back' : ''}; drag its foot to make it longer, every day`}
                    grip={ev => begin(ev, { kind: 'mealsize', name: b.title, start: b.start, end: b.end, s0: b.start, e0: b.end })} />
                }
                if (b.kind === 'class') {
                  const m = plan?.meetings?.find(x => x.id === b.id) || null, missed = data?.attendance?.[b.id]?.attended === false
                  return <Item key={'c' + i} top={y(b.start)} h={y(b.end) - y(b.start)} cls={'class' + (b.skipped ? ' skipped' : '')} color={b.color || 'var(--dy-ink)'} solid icon={Icon.cap} title={b.title}
                    meta={`${HHMM(b.start)}–${HHMM(b.end)}${b.where ? ` · ${b.where}` : ''}${b.skipped ? ' · not going' : missed ? ' · missed' : ''}`} sub={b.inside?.length ? `During it: ${b.inside.map(x => x.title).join(' · ')}` : null}
                    onClick={() => m && setPicked({ m, ahead: view > today || (isToday && b.start > nowM), past: view < today || (isToday && b.end <= nowM) })} hint={`${b.title} — what happens in it, and whether you are there`} />
                }
                return <Item key={'e' + i} top={y(b.start)} h={y(b.end) - y(b.start)} cls={b.kind} color="var(--dy-event)" solid icon={G.event} title={b.title} meta={`${HHMM(b.start)}–${HHMM(b.end)}`}
                  actions={b.kind === 'event' && b.id ? <button className="dy-mini" onClick={() => workable(b.id, true)} title="A bus, a train: time you can work in">I can work here</button> : null} />
              })}
              {blocks.map(b => {
                const at = shownAt(b), dragging = drag?.moved && drag.id === b.id
                const glyph = b.done ? Icon.check : glyphOf(b.kind || kindOfRow(b.row || {}))
                const pushed = !dragging && preview && (at.start !== b.start || at.end !== b.end)
                const offNow = preview?.off?.includes(b.id)
                const cls = ['block', b.state, b.by, b.done && 'done', b.missed && 'missed', b.running && 'running', dragging && 'dragging', dragging && drag.off && 'off', pushed && 'pushed', offNow && 'gone'].filter(Boolean).join(' ')
                const tag = b.done ? null : b.missed ? <span className="dy-tag miss">Missed</span> : b.state === 'draft' ? (b.by === 'claude' ? <span className="dy-tag claude"><G.spark width="10" height="10" />Claude</span> : <span className="dy-tag">Not confirmed</span>) : b.running ? <span className="dy-tag run">Working</span> : null
                return <Item key={b.id} top={y(at.start)} h={y(at.end) - y(at.start)} cls={cls} color={b.color || 'var(--dy-ink)'} solid={b.state === 'confirmed'} icon={glyph} title={b.title}
                  meta={`${HHMM(at.start)}–${HHMM(at.end)} · ${dur(at.end - at.start)}${b.course ? ` · ${b.course}` : ''}`} tag={tag} hint={`${b.title} — drag to move it, or onto the list to take it off the day`}
                  onDown={e => begin(e, { kind: 'block', id: b.id, rowId: b.rowId, len: b.end - b.start, s0: b.start, e0: b.end, start: b.start, end: b.end, onClick: () => openBlock(b) })}
                  grip={b.done ? null : e => begin(e, { kind: 'resize', id: b.id, rowId: b.rowId, start: b.start, end: b.end, e0: b.end })}
                  node={b.row && tickable(b.row) && b.state === 'confirmed' ? () => tick(b.row) : null}
                  actions={b.done ? null : <>
                    {b.state === 'draft' && <button className="dy-mini ok" onClick={() => confirm([b.id])} title="Keep it: it becomes solid">Confirm</button>}
                    {b.state === 'confirmed' && !b.missed && b.row && (b.running ? null : <button className="dy-mini" onClick={() => start(b.row, b)} title="Start the timer on it"><G.play width="9" height="9" />Start</button>)}
                    {b.missed ? <button className="dy-mini" onClick={() => remove(b.id)}>Back to list</button> : <button className="dy-icon" onClick={() => remove(b.id)} title="Take it off the day — it goes back to the list"><Icon.x width="12" height="12" /></button>}
                  </>} />
              })}
              {drag?.kind === 'row' && drag.moved && drag.over && drag.start != null && <Item top={y(drag.start)} h={y(drag.end) - y(drag.start)} cls="block draft student ghost" color={drag.color || 'var(--dy-ink)'} icon={glyphOf(drag.kindOf)} title={drag.title} meta={`${HHMM(drag.start)}–${HHMM(drag.end)} · ${dur(drag.len)}`} />}
              {isToday && nowM >= from && nowM <= to && <div className="dy-now" style={{ top: y(nowM) }}><span>{HHMM(nowM)}</span></div>}
              {!blocks.length && !drag && !drafting?.running && <div className="dy-hint" style={{ top: y(Math.max(win.startMin, isToday ? nowM : 0)) + 12 }}>Drag a to-do here{data?.brain !== false ? ', or let Claude draft the day' : ''}.</div>}
            </div>)}
        </section>
      </div>
      {(error || notice) && <div className={'dy-toast' + (error ? ' err' : '')} onClick={() => { setError(null); setNotice(null) }}>{error || notice}</div>}

      {sheet && <TaskSheet item={{ ...sheet, onToggle: tickable(sheet) ? () => tick(sheet) : null }} onClose={() => setSheet(null)} onOpen={p => { setSheet(null); onOpen(p) }} onToggle={tickable(sheet) ? () => tick(sheet) : null} />}
      {ask && <HowLong row={ask.row} planned={ask.planned} onDone={() => { setAsk(null); load() }} />}
      {picked && <ClassSheet m={picked.m} onClose={() => setPicked(null)} onOpen={p => { setPicked(null); onOpen(p) }} onToggle={(m, t) => { toggleTask(m, t).then(() => { refresh(); setPicked(null) }) }} past={picked.past} ahead={picked.ahead} attendance={data?.attendance?.[picked.m.id]} onAttend={attend} />}
    </div>)
}

const hoursOf = (from, to) => { const out = []; for (let m = Math.ceil(from / 60) * 60; m <= to; m += 60) out.push(m); return out }
// How long a to-do takes when dropped: his own number, else Claude's, else the usual for its kind.
const minutesOf = (r, est) => est?.[r.id]?.minutes || (Number.isFinite(r.task?.claude?.minutes) && r.task.claude.minutes > 0 ? r.task.claude.minutes : null) || DEFAULT_MINUTES[kindOfRow(r)] || 30
// The gaps of half an hour or more that nothing holds — where a drop would go.
function freeGaps(busy, blocks, lo, hi) {
  const taken = [...busy.filter(b => !b.workable && b.kind !== 'kept' && b.kind !== 'past'), ...blocks].map(b => ({ start: b.start, end: b.end })).sort((a, b) => a.start - b.start)
  const out = []; let cur = lo
  for (const t of taken) { if (t.end <= cur) continue; if (t.start >= hi) break; if (t.start - cur >= 30) out.push({ start: cur, end: t.start }); cur = Math.max(cur, t.end) }
  if (hi - cur >= 30) out.push({ start: cur, end: hi })
  return out
}

// One thing on the timeline: the capsule on the rail (its height is its length; the glyph at its head), the words beside
// it. A capsule shorter than its words keeps them on one line.
function Item({ top, h, cls, color, solid = false, icon: Glyph, title, meta, sub = null, tag = null, actions = null, hint, onDown, onClick, onDouble, grip = null, node = null }) {
  const height = Math.max(26, h), short = height < 50
  return (
    <div className={`dy-item ${cls}${short ? ' short' : ''}`} style={{ top, height, '--c': color }} onPointerDown={onDown} onClick={onClick} onDoubleClick={onDouble} title={hint}>
      <span className={'dy-cap' + (solid ? ' solid' : '')}>
        <span className="dy-glyph" onPointerDown={node ? e => e.stopPropagation() : undefined} onClick={node ? e => { e.stopPropagation(); node() } : undefined} title={node ? 'Mark it done' : undefined}>{Glyph && <Glyph width="14" height="14" />}</span>
        {grip && <span className="dy-grip" onPointerDown={e => { e.stopPropagation(); grip(e) }} title="Drag to change how long" />}
      </span>
      <span className="dy-words">
        <span className="dy-meta">{meta}{tag}</span>
        <span className="dy-title">{title}</span>
        {sub && !short && <span className="dy-sub">{sub}</span>}
      </span>
      {actions && <span className="dy-acts" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>{actions}</span>}
    </div>)
}

// One to-do in the list: the tick, the title, then its course and when it is due (counted from today, whichever day is
// on screen) — and its hour when it is on the day. Press and move to drag it onto an hour; a plain click opens it.
function Row({ r, b, day, dragging, onTick, onOpen, onJump, onBegin }) {
  const d = r.by && r.by !== '9999-12-31' ? daysTo(r.by, day) : null
  const due = r.overdue ? 'late' : d == null ? null : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : d < 7 ? `due ${new Date(r.by + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short' })}` : `due ${shortIso(r.by)}`
  return (
    <li className={'dy-row' + (b ? ' on' : '') + (r.done ? ' done' : '') + (dragging ? ' dragging' : '')} style={{ '--c': r.color || 'var(--dy-muted)' }} onPointerDown={onBegin}>
      <button className={'dy-tick' + (r.done ? ' on' : '')} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onTick() }} disabled={!tickable(r)} title={tickable(r) ? (r.done ? 'Not done after all' : 'Mark it done') : 'Tick it where it lives'}>{r.done && <Icon.check width="11" height="11" />}</button>
      <span className="dy-row-main">
        <span className="dy-row-title">{r.title}</span>
        <small>{r.course ? <><i className="dy-dot" />{r.course}</> : 'yours'}{due ? <span className={r.overdue || d === 0 ? 'hot' : ''}> · {due}</span> : null}</small>
      </span>
      {b && <button className={'dy-when ' + b.state} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onJump(b) }} title="On the day — show it">{HHMM(b.start)}</button>}
    </li>)
}

// Add a to-do: what, which course (optional), when — the day on screen unless he says otherwise. It shows at the top
// of the list at once, and everywhere else a task of his shows (Home, To do, the course, the week).
function Adder({ courses, date, onAdded, onError }) {
  const [text, setText] = useState(''), [course, setCourse] = useState(''), [when, setWhen] = useState(date), [busy, setBusy] = useState(false), [open, setOpen] = useState(false)
  useEffect(() => { setWhen(date) }, [date])
  const submit = async e => {
    e.preventDefault()
    const what = text.trim(); if (!what || busy) return
    setBusy(true)
    try {
      const code = courses.find(c => c.key === course)?.code || null
      await addMyTask({ text: what, course: code, date: when || null })
      setText(''); onAdded('mine|' + renderMyTask({ text: what, course: code, date: when || null }))
    } catch (x) { onError(`Could not add that: ${x.message}`) } finally { setBusy(false) }
  }
  return (
    <form className={'dy-add' + (open || text ? ' open' : '')} onSubmit={submit}>
      <span className="dy-add-plus"><Icon.plus width="13" height="13" /></span>
      <input value={text} onChange={e => setText(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Add a to-do…" onKeyDown={e => { if (e.key === 'Escape') { setText(''); e.currentTarget.blur() } }} />
      {(open || text) && <span className="dy-add-opts">
        <select value={course} onChange={e => setCourse(e.target.value)} title="Course">
          <option value="">No course</option>
          {courses.map(c => <option key={c.key} value={c.key}>{c.code}</option>)}
        </select>
        <input type="date" value={when} onChange={e => setWhen(e.target.value)} title="When it is due — empty for whenever" />
        <button className="dy-pill dark small" disabled={!text.trim() || busy}>{busy ? 'Adding…' : 'Add'}</button>
      </span>}
    </form>)
}
