import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'
import { api } from '../api.js'
import { startWork, kindOfRow, DEFAULT_MINUTES } from '../work.js'
import { THIS as ED } from '../edition.js'
import { Flags } from './Flags.jsx'
import { weekdayOf, shortIso, relDay } from '../plan.js'
import { plainTask, prepRow } from '../todo.js'
import '../styles/timetable.css'

// One thing to do, on its own, over whatever you were looking at (SPEC §20.19). Clicking a task anywhere in the
// app opens this rather than navigating: it says what the task is, which course, when it is wanted and where it
// came from, and its first button *does* it — opening the syllabus page in slate, the problems page, or Quercus.
// When there is nothing to open it says why, rather than offering a link that goes somewhere else (SPEC §20.24).
// With Today's work on (§22.10) it also says how long the thing takes and lets the student say otherwise: his number is
// the row's minutes on the day, in the draft and when he drags it onto an hour.
// props: { item, onClose, onOpen(path), onToggle(), where }
export { plainTask }

const h = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`)

export default function TaskSheet({ item, onClose, onOpen, onToggle, onDelete }) {
  const [err, setErr] = useState(null)
  if (!item) return null
  const { title, course, color, kindLabel, when, deadline, priority, source, action, note, done, canTick } = item
  const go = () => { if (!action) return; if (action.url) window.open(action.url, '_blank', 'noopener'); else { onClose(); onOpen(action.path) } }
  const askable = ED.work !== false && !!item.id && item.type !== 'sit' && item.type !== 'in-class'
  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs cs-task" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head" style={{ '--c': color }}>
          <span className="cs-head-top">
            {course && <span className="tag" style={{ '--c': color }}>{course}</span>}
            <Flags r={item} />
          </span>
          <h2>{title}</h2>
          <p>{[kindLabel, deadline?.text || when].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="cs-body">
          <div className="cs-actions">
            {action && <button className="btn primary cs-do" onClick={go}>{action.url ? <>{action.label}<Icon.external width="13" height="13" /></> : action.label}</button>}
            {canTick && <button className={'btn' + (done ? '' : ' cs-done')} onClick={() => { onToggle?.(); onClose() }}>{done ? 'Not done after all' : 'Mark it done'}</button>}
            {/* the sheet stays open when the server says no ("already working on … — stop it first"), with its words */}
            {ED.work !== false && canTick && !done && item.id && <button className="btn" onClick={() => { setErr(null); startWork(item).then(() => onClose(), e => setErr(`Could not start the timer: ${e.data?.error || e.message}`)) }} title="Start the timer on it"><Icon.clock width="13" height="13" />Start working</button>}
            {onDelete && <button className="btn cs-delete" onClick={() => { onDelete(); onClose() }}>Delete this task</button>}
          </div>
          {err && <p className="home-error">{err}</p>}
          {/* opened from a block on Today's work: why Claude put it there, read only here, never on the calendar (SPEC §23) */}
          {item.blockWhy && <p className="cs-why"><b>{item.blockBy === 'claude' ? 'Why Claude proposed it' : 'Why it was proposed'}{item.blockAt ? ` at ${item.blockAt}` : ''}</b>{item.blockWhy}</p>}
          {askable && <Estimate item={item} />}
          {/* ticked by the morning pass, not by him (SPEC §20.69): say what said it was done, so a wrong tick is easy to take back */}
          {done && item.task?.auto?.why && <p className="blank cs-noaction">Ticked for you by the morning check — {item.task.auto.why}.</p>}
          {note && <p className="blank cs-noaction">{note}.</p>}
          {source && <div className="cs-source">
            <span>Where this came from</span>
            <button className="link" onClick={() => { onClose(); onOpen(source.path) }}>{source.label}</button>
          </div>}
        </div>
      </div>
    </div>)
}

// How long it takes: his own number when he set one, else Claude's minutes from the morning, else the usual for the kind.
// Five minutes a step; saved as he goes, and the day reads it at once.
function Estimate({ item }) {
  const [own, setOwn] = useState(undefined)
  useEffect(() => { let live = true; api.estimates().then(e => { if (live) setOwn(e.rows?.[item.id]?.minutes ?? null) }).catch(() => { if (live) setOwn(null) }); return () => { live = false } }, [item.id])
  const claude = Number.isFinite(item.task?.claude?.minutes) && item.task.claude.minutes > 0 ? item.task.claude.minutes : null
  const usual = DEFAULT_MINUTES[kindOfRow(item)] ?? 45
  const shown = own ?? claude ?? usual
  const source = own != null ? 'yours' : claude ? 'Claude’s estimate' : `the usual for ${kindOfRow(item) === 'mine' ? 'a task of yours' : kindOfRow(item)}`
  // A step shows at once and the next one counts from it; the saves go one after another, and only the last one's answer
  // is taken — three quick clicks are fifteen minutes, not five.
  const chain = useRef(Promise.resolve()), last = useRef(0)
  const save = m => {
    setOwn(m); const n = ++last.current
    chain.current = chain.current.then(async () => { try { const r = await api.estimate({ rowId: item.id, minutes: m, title: item.title }); if (n === last.current) { setOwn(r.entry?.minutes ?? null); window.dispatchEvent(new Event('slate:plan')) } } catch { } })
  }
  if (own === undefined) return null
  return (
    <div className="cs-est">
      <b>How long</b>
      <span className="dw-step">
        <button className="icon-btn" title="Five minutes less" onClick={() => save(Math.max(5, shown - 5))}><Icon.minus width="12" height="12" /></button>
        <b>{h(shown)}</b>
        <button className="icon-btn" title="Five minutes more" onClick={() => save(Math.min(600, shown + 5))}><Icon.plus width="12" height="12" /></button>
      </span>
      <small className="td-say-dim">{source}</small>
      {own != null && <button className="link" onClick={() => save(null)}>back to {claude ? 'Claude’s' : 'the usual'}</button>}
    </div>)
}

// Build the sheet's item from a plan task on a meeting. The row model is src/todo.js — one task reads the same in the
// sheet, on To do, on Today and on the course screen, and decides *there* whether it has anything to open.
// `ctx` is what resolve.js needs: { titles, links, general, courseUrl }.
export const taskItem = (t, m, ctx, today, isNext = false) => {
  const day = today || new Date().toLocaleDateString('en-CA')
  const r = prepRow(t, m, ctx || {}, day, isNext)
  return { ...r, when: `before the ${String(m.kind).toLowerCase()} · ${weekdayOf(m.date)} ${shortIso(m.date)} · ${relDay(m.date, day)}` }
}
