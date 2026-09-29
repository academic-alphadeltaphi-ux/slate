import { useState } from 'react'
import { weekdayOf, shortIso } from '../plan.js'
import '../styles/viz.css'

// Small drawings for numbers (SPEC §20.35). A course had one way to show a number — a word in a grey line — so a share
// done, a mark's weights, the weeks of a term and the dates ahead all read the same. These draw each as its own shape:
// a ring for how much of a list is done, a stacked bar for what a mark is made of, a row of cells for a term, a line
// of dates for what is coming, a meter for a set's questions. Plain SVG and boxes, coloured by --c, no library.

// How much of something is done, as a ring with the count inside.
export function Ring({ value = 0, total = 0, size = 64, stroke = 7, label = null, sub = null, title = null }) {
  const r = (size - stroke) / 2, len = 2 * Math.PI * r
  const f = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0
  return (
    <span className={'vz-ring' + (total > 0 && value >= total ? ' full' : '')} style={{ width: size, height: size }} role="img" aria-label={title || `${value} of ${total} done`} title={title || undefined}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle className="vz-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        {f > 0 && <circle className="vz-ring-fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - f)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      </svg>
      <span className="vz-ring-in"><b>{label ?? (total > 0 ? `${value}/${total}` : '—')}</b>{sub && <small>{sub}</small>}</span>
    </span>)
}

// A share as a bar: `value` of `total`, and optionally a second, stronger share inside it (tried, then checked).
export function Meter({ value = 0, total = 0, strong = null, wide = false, title = null }) {
  const pct = n => `${total > 0 ? Math.round((100 * Math.max(0, Math.min(n, total))) / total) : 0}%`
  return (
    <span className={'vz-meter' + (wide ? ' wide' : '')} role="img" aria-label={title || `${value} of ${total}`} title={title || undefined}>
      <i style={{ width: pct(value) }} />{strong != null && <i className="strong" style={{ width: pct(strong) }} />}
    </span>)
}

// The weeks of a term in one row: one cell per week, its state as a fill, the current week ringed, a flag over a week
// with a test in it. `cells`: [{ key, n, state: 'done'|'partial'|'empty'|'future', current, flag, title, onClick }].
export function Track({ cells = [] }) {
  return (
    <div className="vz-track" style={{ '--n': Math.max(1, cells.length) }}>
      {cells.map(c => (
        <button key={c.key} className={'vz-cell ' + (c.state || 'future') + (c.current ? ' now' : '') + (c.open ? ' open' : '') + (c.flag ? ' flagged' : '')} title={c.title} onClick={c.onClick}>
          {c.flag && <span className="vz-flag">{c.flag}</span>}
          <span className="vz-cell-bar" />
          <span className="vz-cell-n">{c.n}</span>
        </button>))}
    </div>)
}

// What a whole is made of, as one bar: each part as wide as its weight, filled as far as it has gone.
// `parts`: [{ key, label, weight, filled (0–1), note }].
export function Stack({ parts = [] }) {
  const total = parts.reduce((s, p) => s + (p.weight || 0), 0) || 1
  return (
    <div className="vz-stack">
      <div className="vz-stack-bar">
        {parts.map((p, i) => (
          <span key={p.key} className={'vz-stack-part t' + (i % 4)} style={{ flexGrow: p.weight || 0 }} title={`${p.label} · ${p.weight}%${p.note ? ` · ${p.note}` : ''}`}>
            <i style={{ width: `${Math.round(100 * Math.max(0, Math.min(1, p.filled || 0)))}%` }} />
          </span>))}
      </div>
      <ul className="vz-stack-key">
        {parts.map((p, i) => (
          <li key={p.key}><span className={'vz-swatch t' + (i % 4)} /><b>{p.weight}%</b><span>{p.label}</span>{p.note && <small>{p.note}</small>}</li>))}
      </ul>
      {total !== 100 && <p className="vz-stack-odd">Weights add up to {Math.round(total)}%.</p>}
    </div>)
}

// Dated things down a line, soonest first. `items`: [{ key, date, day, rel, title, sub, tone: 'test'|'due'|'class'|'plain', onClick }].
export function Timeline({ items = [] }) {
  return (
    <ol className="vz-tl">
      {items.map(x => {
        const Tag = x.onClick ? 'button' : 'div'
        return (
          <li key={x.key} className={'vz-tl-item ' + (x.tone || 'plain')}>
            <span className="vz-tl-dot" />
            <Tag className="vz-tl-body" onClick={x.onClick} {...(x.onClick ? { type: 'button' } : {})}>
              <span className="vz-tl-when"><b>{x.day}</b>{x.rel && <small>{x.rel}</small>}</span>
              <span className="vz-tl-main"><span className="vz-tl-title">{x.title}</span>{x.sub && <small>{x.sub}</small>}</span>
            </Tag>
          </li>)
      })}
    </ol>)
}

// "Test 1 · Problem solving" → T1, "Midterm 2 · online" → MT2: the flag over a week of the term, on the course page and the week's.
export const testFlag = title => {
  const m = /\b(midterm|test|quiz|exam)\s*#?\s*(\d+)/i.exec(String(title || ''))
  if (!m) return /final/i.test(String(title)) ? 'Final' : 'Test'
  return (m[1].toLowerCase() === 'midterm' ? 'MT' : m[1][0].toUpperCase()) + m[2]
}

// The load of a run of days (SPEC §20.63, shared §20.64): per day, a bar of class hours in the courses' pigments, a bead
// per thing wanted by that day, and the numbers under them; hovering reads the day out, clicking opens To do narrowed
// to it. `load`: [{ date, classes: [{ course, color, kind, start, end, minutes }], minutes, due: [rows] }]. `heads` draws
// a weekday and date over each cell — the timetable has its own, and there the strip is `display: contents` so its
// cells fall into the timetable's columns.
const hrs = m => (m % 60 ? (m / 60).toFixed(1).replace(/\.0$/, '') : String(m / 60))
export function LoadStrip({ load = [], today = null, onDay = null, heads = false, label = 'load' }) {
  const [tip, setTip] = useState(null)
  const maxMin = Math.max(60, ...load.map(l => l.minutes))
  const n = load.length
  return (
    <div className={'ld' + (heads ? ' ld-own' : '')} style={{ '--n': n }}>
      {!heads && <div className="ld-k">{label}</div>}
      {load.map((l, i) => (
        <div key={l.date} className={'ld-cell' + (i >= n - 2 ? ' ld-r' : '')}>
          <button className={'ld-day' + (l.date === today ? ' today' : '')} onMouseEnter={() => setTip(l.date)} onMouseLeave={() => setTip(null)} onFocus={() => setTip(l.date)} onBlur={() => setTip(null)}
            onClick={() => onDay?.(l.date)} aria-label={`${weekdayOf(l.date)} ${shortIso(l.date)}: ${hrs(l.minutes)} hours of class, ${l.due.length} to do — see the day on To do`}>
            {heads && <span className="ld-head"><b>{weekdayOf(l.date)}</b><i>{shortIso(l.date).replace(/^\w+\s/, '')}</i></span>}
            <span className="ld-bar">{l.classes.map((c, j) => <i key={j} className="ld-seg" style={{ width: `${(c.minutes / maxMin) * 100}%`, '--c': c.color }} />)}</span>
            <span className="ld-due">{l.due.slice(0, 8).map((r, j) => <i key={j} style={{ '--c': r.color }} />)}{l.due.length > 8 && <em>+{l.due.length - 8}</em>}</span>
            <span className="ld-n">{l.minutes ? `${hrs(l.minutes)} h` : '—'}{l.due.length ? ` · ${l.due.length} to do` : ''}</span>
          </button>
          {tip === l.date && (
            <div className="ld-tip" role="tooltip">
              <b>{weekdayOf(l.date)} {shortIso(l.date).replace(/^\w+\s/, '')}</b>
              <small>{l.minutes ? `${hrs(l.minutes)} h of class` : 'no class'}{l.due.length ? ` · ${l.due.length} thing${l.due.length === 1 ? '' : 's'} to do` : ' · nothing wanted'}</small>
              {(l.classes.length > 0 || l.due.length > 0) && <ul>
                {l.classes.map((c, j) => <li key={'c' + j} style={{ '--c': c.color }}><i /><span>{c.course} {String(c.kind).toLowerCase()}</span><em>{c.start}–{c.end}</em></li>)}
                {l.due.slice(0, 6).map((r, j) => <li key={'d' + j} style={{ '--c': r.color }}><i /><span>{r.course ? `${r.course} · ` : ''}{r.title}</span></li>)}
                {l.due.length > 6 && <li><span>and {l.due.length - 6} more</span></li>}
              </ul>}
              <span className="ld-tip-go">Click to see the day on To do</span>
            </div>)}
        </div>))}
    </div>)
}
