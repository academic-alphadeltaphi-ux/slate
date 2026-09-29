import { Icon } from './Icons.jsx'
import { plainTask } from './TaskSheet.jsx'
import { taskNature, relDay, weekdayOf, shortIso } from '../plan.js'
import '../styles/timetable.css'

// One course's to-do, over whatever you were looking at (SPEC §20.21). Clicking "3 to do" on a course used to
// navigate to the whole list, where you then had to find that course again; this answers the question you asked.
// props: { course:{code,name,color,key}, rows:[{task,meeting,action,optional,notOpen,inClass}], today, onClose, onOpen, onToggle, onAll }
export default function CourseTodoSheet({ course, rows, today, onClose, onOpen, onToggle, onAll }) {
  if (!course) return null
  const go = a => { if (!a) return; if (a.url) window.open(a.url, '_blank', 'noopener'); else { onClose(); onOpen(a.path) } }
  const doable = rows.filter(r => !r.inClass && !r.notOpen)
  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs cs-course" onClick={e => e.stopPropagation()} role="dialog" aria-label={`${course.code} to do`}>
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head" style={{ '--c': course.color }}>
          <span className="tag" style={{ '--c': course.color }}>{course.code}</span>
          <h2>{doable.length === 0 ? 'Nothing to do' : `${doable.length} to do`}</h2>
          <p>{course.name}</p>
        </div>
        <div className="cs-body">
          {rows.length === 0 ? <p className="blank">Nothing to prepare for this course.</p> : (
            <ul className="cts-list">
              {rows.map((r, i) => (
                <li key={i} className={(r.done ? 'done ' : '') + (r.inClass || r.notOpen ? 'passive' : '')}>
                  {r.inClass || r.notOpen
                    ? <span className="cts-ic"><Icon.calendar width="13" height="13" /></span>
                    : <input type="checkbox" checked={!!r.done} disabled={!r.canTick} onChange={() => onToggle?.(r)} />}
                  <span className="cts-main">
                    {/* A row, not a plan task: your own tasks (SPEC §20.32) have no meeting behind them. */}
                    <span className="cts-text">{r.title}</span>
                    <span className="cts-meta">
                      {r.optional && <span className="todo-flag optional">optional</span>}
                      {r.notOpen && <span className="todo-flag locked">not open yet</span>}
                      <span>{r.meeting ? <>{r.inClass ? `in the ${String(r.meeting.kind).toLowerCase()}` : `before ${String(r.meeting.kind).toLowerCase()}`} · {relDay(r.meeting.date, today)}</> : `yours · ${r.when}`}</span>
                    </span>
                  </span>
                  {!r.inClass && !r.notOpen && r.action && (
                    <button className="cts-do" onClick={() => go(r.action)} title={r.action.label}>
                      {r.action.url ? <Icon.external width="13" height="13" /> : <Icon.chevron width="14" height="14" />}
                    </button>)}
                </li>))}
            </ul>)}
          <div className="cs-links"><button className="btn small" onClick={() => { onClose(); onAll?.() }}>Everything, all courses</button></div>
        </div>
      </div>
    </div>)
}
