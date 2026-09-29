import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { THIS as ED } from '../edition.js'
import '../styles/term.css'

// The weeks of one term, inside the course screen (SPEC §20.14, redrawn §20.24). This was a table — one row per week,
// one column per file, a cell you clicked to reach that file. Two things killed it. A week is now a single page that
// holds all six of its things, so the per-cell click was a second route to the same place; and a spreadsheet of
// thirteen rows and six columns is the tree in another costume. One card per week, saying what is in it: the count
// of each thing it holds, dim when it holds none. Clicking the card opens the week.
// props: { courseKey, term, onOpenWeek(path) }
const COLS = [
  { id: 'notes', label: 'notes', icon: 'notes' },
  { id: 'lectures', label: 'lectures', icon: 'board' },
  { id: 'recordings', label: 'recordings', icon: 'headphones' },
  ...(ED.sheets ? [{ id: 'sheets', label: 'study sheets', icon: 'bookmark' }] : []),
  { id: 'problems', label: 'problems', icon: 'pencil' },
  { id: 'plan', label: 'to do', icon: 'checklist' },
]
const I = (n, p = { width: 13, height: 13 }) => (Icon[n] || Icon.file)(p)

export default function TermWeeks({ courseKey, term, onOpenWeek }) {
  const [d, setD] = useState(null), [error, setError] = useState(null)
  const seq = useRef(0)
  const load = () => { const n = ++seq.current; return api.term(courseKey, term).then(x => { if (n === seq.current) { setD(x); setError(null) } }).catch(e => { if (n === seq.current) setError(e.message) }) }
  useEffect(() => { setD(null); load() }, [courseKey, term])
  useEffect(() => {
    let t = null
    const off = api.events(ev => { const p = ev.path || ''; if (p.startsWith(courseKey + '/') || p.startsWith('Hub/')) { clearTimeout(t); t = setTimeout(load, 600) } })
    return () => { off(); clearTimeout(t) }
  }, [courseKey, term])

  if (error) return <p className="blank">Could not read this term: {error}</p>
  if (!d) return <p className="blank">Reading the term…</p>
  return (
    <div className="tw-grid">
      {d.weeks.map(w => {
        const cells = Object.fromEntries(w.columns.map(c => [c.id, c]))
        const held = COLS.filter(c => cells[c.id]?.has && (cells[c.id].count || cells[c.id].state === 'done' || cells[c.id].state === 'partial' || cells[c.id].state === 'todo'))
        return (
          <button key={w.label} className={'tw-week' + (w.current ? ' current' : '') + (w.elapsed ? ' elapsed' : ' future')}
            onClick={() => onOpenWeek(`${courseKey}/${term}/${w.label}`)} title={`Open ${w.label} — everything in it on one page`}>
            <span className="tw-top">
              <span className="tw-name">{w.label.replace(/\s*\(.*\)$/, '')}</span>
              {w.current ? <span className="pill on">now</span> : w.readingWeek ? <span className="pill">reading week</span> : null}
            </span>
            <span className="tw-span">{w.span}</span>
            {w.topic && <span className="tw-topic" title={w.topic}>{w.topic}</span>}
            <span className="tw-holds">
              {held.length === 0
                ? <span className="tw-none">{w.elapsed ? 'nothing filed' : 'not yet'}</span>
                : held.map(c => (
                  <span key={c.id} className={'tw-hold ' + (cells[c.id].state || '')} title={`${c.label}: ${cells[c.id].line}`}>
                    {I(c.icon)}{cells[c.id].count ? <b>{cells[c.id].count}</b> : null}
                  </span>))}
            </span>
          </button>)
      })}
    </div>
  )
}
