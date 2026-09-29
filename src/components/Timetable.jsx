import { useMemo } from 'react'
import { Icon } from './Icons.jsx'
import { weekdayOf, shortIso, relDay } from '../plan.js'
import { LoadStrip } from './Viz.jsx'
import '../styles/timetable.css'

// The week as an actual timetable (SPEC §20.18). The board it replaces stacked cards in a column per day, so an
// 11–1 class and a 3–5 class sat touching with nothing between them and no way to read a time off the screen.
// Here the hours are an axis: every class is placed and sized by its real start and end, the gaps are the gaps in
// the day, and a line marks where "now" is. Only things that happen at a time are here — what is due and what to
// revise live on the To do page, because a schedule that also carries a task list is not a schedule.
// props: { days, plan, today, now, onPick(meeting), load ([{ date, classes, minutes, due }] — the strip over the days, SPEC §20.63), onDay(iso) }
const MIN = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0) }
const HHMM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
// Google's "Week 38 of 2026" / "Numéros de semaine" all-day entries are noise on a student's timetable.
const WEEKNUM = /^(week\s*\d+|semaine\s*\d+|wk\s*\d+|num[ée]ros?\s+de\s+semaine)\b/i


export default function Timetable({ days, plan, today, now, onPick, load = null, onDay = null, attendance = null }) {
  const byId = id => plan?.meetings?.find(m => m.id === id)
  const cols = useMemo(() => days.map(d => {
    const timed = [], allDay = []
    for (const ev of d.events) {
      if (ev.type === 'meeting') { const m = byId(ev.ref); if (m) timed.push({ kind: 'class', m, start: MIN(m.announced?.start || m.start), end: MIN(m.announced?.end || m.end) }) }
      else if (ev.type === 'calendar') {   // src/plan.js emits 'calendar'; 'cal' matched nothing and hid every personal event
        const c = plan.calendar?.[ev.ref]
        if (!c || WEEKNUM.test(c.title || '')) continue
        if (c.allDay) allDay.push(c); else timed.push({ kind: 'cal', c, start: MIN(c.start), end: c.end ? MIN(c.end) : MIN(c.start) + 60 })   // +60 was meant for an event with no end only
      }
    }
    return { date: d.date, timed: timed.sort((a, b) => a.start - b.start), allDay }
  }), [days, plan])

  // The window is what the week actually uses, rounded out to the hour — never a fixed 8-to-9 with dead space.
  const [from, to] = useMemo(() => {
    const all = cols.flatMap(c => c.timed)
    if (!all.length) return [9 * 60, 18 * 60]
    const lo = Math.min(...all.map(x => x.start)), hi = Math.max(...all.map(x => x.end))
    return [Math.floor(lo / 60) * 60 - 60, Math.ceil(hi / 60) * 60 + 60]
  }, [cols])
  const span = to - from
  const y = m => ((m - from) / span) * 100
  const hours = []
  for (let m = Math.ceil(from / 60) * 60; m < to; m += 60) hours.push(m)
  const nowM = MIN(now), showNow = nowM >= from && nowM <= to

  return (
    <div className="tt">
      <div className="tt-corner" />
      {cols.map(c => (
        <div key={'h' + c.date} className={'tt-dayhead' + (c.date === today ? ' today' : '')}>
          <b>{weekdayOf(c.date)}</b><i>{shortIso(c.date).replace(/^\w+\s/, '')}</i>
          {c.date === today && <span className="tt-todaydot" />}
        </div>))}

      {/* The load strip (SPEC §20.63): its cells fall into the day columns (src/components/Viz.jsx LoadStrip). */}
      {load && <LoadStrip load={load} today={today} onDay={onDay} />}

      {cols.some(c => c.allDay.length) && <>
        <div className="tt-allday-k">all day</div>
        {cols.map(c => (
          <div key={'a' + c.date} className="tt-allday">
            {c.allDay.map((e, i) => <span key={i} className="tt-chip" title={e.title}>{e.title}</span>)}
          </div>))}
      </>}

      <div className="tt-hours">
        {hours.map(m => <div key={m} className="tt-hour" style={{ top: `${y(m)}%` }}><span>{HHMM(m)}</span></div>)}
      </div>
      {cols.map(c => (
        <div key={'c' + c.date} className={'tt-col' + (c.date === today ? ' today' : '')}>
          {hours.map(m => <div key={m} className="tt-rule" style={{ top: `${y(m)}%` }} />)}
          {c.date === today && showNow && <div className="tt-now" style={{ top: `${y(nowM)}%` }}><i /></div>}
          {c.timed.map((x, i) => {
            if (x.kind === 'cal') return (
              <div key={i} className="tt-ev tt-cal" style={{ top: `${y(x.start)}%`, height: `${((x.end - x.start) / span) * 100}%` }} title={x.c.title}>
                <b>{x.c.title}</b><span>{x.c.start}{x.c.end ? `–${x.c.end}` : ''}</span>
              </div>)
            const m = x.m, live = m.date === today && x.start <= nowM && nowM < x.end
            const done = m.tasks ? m.tasks.done >= m.tasks.total : true
            // A No ahead of the class is "not going"; it is missed only once the class has been.
            const gone = m.date < today || (m.date === today && nowM >= x.end), away = attendance?.[m.id]?.attended === false, missed = away && gone
            return (
              <button key={i} className={'tt-ev tt-class' + (m.cancelled ? ' off' : '') + (live ? ' live' : '') + (gone ? ' past' : '') + (away ? ' missed' : '')}
                style={{ top: `${y(x.start)}%`, height: `${((x.end - x.start) / span) * 100}%`, '--c': m.color }}
                onClick={() => onPick?.(m)} title={`${m.course} ${m.kind}${m.where ? ' · ' + m.where : ''} — click for what to do`}>
                <b>{m.course}</b>
                <span className="tt-ev-kind">{m.kind}</span>
                <span className="tt-ev-meta">{HHMM(x.start)}–{HHMM(x.end)}{(m.announced?.where || m.where) ? ` · ${m.announced?.where || m.where}` : ''}</span>
                {m.cancelled ? <span className="tt-ev-flag">cancelled</span>
                  : away ? <span className="tt-ev-flag">{missed ? 'missed' : 'not going'}</span>
                  : m.tasks?.total ? <span className={'tt-ev-flag' + (done ? ' ok' : '')}>{done ? 'ready' : `${m.tasks.total - m.tasks.done} to do`}</span> : null}
              </button>)
          })}
        </div>))}
    </div>
  )
}

// What to do before a class, over the schedule (SPEC §20.18): clicking a block asks a question, and this answers it
// without leaving the page. Glass, because it is chrome you look past to the timetable underneath.
// `past`: the class has met — the sheet then asks whether the student was there (SPEC §22), and a No becomes catch-up work
// in the morning. `attendance` is his answer so far; `onAttend(m, true|false|null)` records it.
export function ClassSheet({ m, onClose, onOpen, onToggle, past = false, ahead = false, attendance = null, onAttend = null }) {
  if (!m) return null
  const where = m.announced?.where || m.where
  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs" onClick={e => e.stopPropagation()} role="dialog" aria-label={`${m.course} ${m.kind}`}>
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head" style={{ '--c': m.color }}>
          <span className="tag" style={{ '--c': m.color }}>{m.course}</span>
          <h2>{m.kind}</h2>
          <p>{weekdayOf(m.date)} {shortIso(m.date)} · {m.announced?.start || m.start}–{m.announced?.end || m.end}{where ? ` · ${where}` : ''}</p>
          {m.topic?.text && <p className="cs-topic">{m.topic.text}</p>}
        </div>
        {m.cancelled ? <p className="cs-off">Cancelled — {m.cancelled}</p> : (
          <div className="cs-body">
            <h3>Before it</h3>
            {!m.before?.length ? <p className="blank">Nothing to do first.</p> : (
              <ul className="cs-todo">{m.before.map((t, i) => (
                <li key={i} className={t.done ? 'done' : ''}>
                  <input type="checkbox" checked={!!t.done} disabled={!!t.pending} onChange={() => onToggle?.(m, t)} />
                  <span className="cs-todo-text">{String(t.text).replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => (b || a).split('/').pop())}</span>
                  {t.kind && <span className="pill">{t.kind}</span>}
                </li>))}</ul>)}
            {(past || ahead) && onAttend && <div className="cs-attend"><b>{past ? 'Were you there?' : 'Will you be there?'}</b>
              <span className="tabs">
                <button className={'tab' + (attendance?.attended === true ? ' on' : '')} onClick={() => onAttend(m, attendance?.attended === true ? null : true)}>Yes</button>
                <button className={'tab' + (attendance?.attended === false ? ' on' : '')} onClick={() => onAttend(m, attendance?.attended === false ? null : false)}>No</button>
              </span>
              {attendance?.attended === false && <span className="td-say-dim">{past ? 'Claude adds the catch-up in the morning.' : 'Its hours are yours on the day; Claude adds the catch-up after.'}</span>}
            </div>}
            <div className="cs-links">
              {m.week?.dir && <button className="btn small" onClick={() => onOpen(`${m.courseKey}/${m.week.dir}.md`)}>Open the week</button>}
              {m.week?.dir && <button className="btn small" onClick={() => onOpen(`${m.courseKey}/${m.week.dir}/Notes.md`)}>Notes for this week</button>}
              {(m.sources || []).map((p, i) => <button key={i} className="btn small" onClick={() => onOpen(p)}>Where this came from</button>)}
            </div>
          </div>)}
      </div>
    </div>)
}
