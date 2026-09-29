import { useState } from 'react'
import { Icon } from './Icons.jsx'
import { api } from '../api.js'

// "How long did it take?" (SPEC §22): asked once, over the page, when a thing is ticked without the timer running on
// it. The estimate is preselected; a chip is one click; Skip records nothing. What is answered teaches the calibration
// the day is built from — the app's ratio per course and kind, and Claude's own `minutes` next morning.
// props: { row (a todo row), planned (minutes), onDone() }
export default function HowLong({ row, planned = null, onDone }) {
  const base = Number.isFinite(planned) && planned > 0 ? planned : 30
  const [minutes, setMinutes] = useState(base)
  const [busy, setBusy] = useState(false)
  const chips = [[0.5, '½'], [0.75, '¾'], [1, 'as planned'], [1.5, '1½×'], [2, '2×']].map(([f, l]) => [Math.max(5, Math.round((base * f) / 5) * 5), l])
  const kind = row.type === 'hand-in' ? 'due' : row.type === 'mine' ? 'mine' : (row.task?.kind || 'other')
  const send = async () => {
    setBusy(true)
    try { await api.work({ op: 'asked', rowId: row.id, title: row.title, courseKey: row.courseKey || null, course: row.course || null, kind, planned: Number.isFinite(planned) ? planned : null, minutes, done: true }) } catch { }
    setBusy(false); onDone?.()
  }
  return (
    <div className="cs-scrim" onClick={() => onDone?.()}>
      <div className="cs cs-task hl" onClick={e => e.stopPropagation()} role="dialog" aria-label="How long did it take?">
        <button className="cs-x" onClick={() => onDone?.()} title="Skip"><Icon.x width="15" height="15" /></button>
        <div className="cs-head" style={{ '--c': row.color || 'var(--muted-2)' }}>
          {row.course && <span className="tag" style={{ '--c': row.color }}>{row.course}</span>}
          <h2>How long did it take?</h2>
          <p>{row.title}{Number.isFinite(planned) ? ` · planned ${planned} min` : ''}</p>
        </div>
        <div className="cs-body">
          <div className="hl-chips">
            {chips.map(([m, l]) => <button key={l} className={'tab' + (minutes === m ? ' on' : '')} onClick={() => setMinutes(m)} title={`${m} min`}>{l}<small>{m} min</small></button>)}
          </div>
          <div className="hl-row">
            <label>or exactly <input type="number" min="1" max="600" step="5" value={minutes} onChange={e => setMinutes(Math.max(1, Math.round(Number(e.target.value) || 0)))} /> min</label>
            <span className="grow" />
            <button className="btn" onClick={() => onDone?.()}>Skip</button>
            <button className="btn primary" onClick={send} disabled={busy}>{busy ? 'Saving…' : 'That long'}</button>
          </div>
          <p className="blank hl-why">What you answer teaches the day: the estimate for this kind of work in this course moves a third of the way toward it.</p>
        </div>
      </div>
    </div>)
}
