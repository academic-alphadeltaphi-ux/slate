import { useMemo, useState } from 'react'
import { standing, neededFor, progress } from '../grade.js'

// Where your mark stands, for one course (SPEC §20.15). Rewritten because the old one answered in three cramped
// statistic boxes that collided as soon as the card was narrow, and buried the only question worth asking.
// It now reads as three sentences: where you stand, where you land if the rest goes a certain way, and what you
// need for the grade you want. Every graded thing is a row; what Quercus returned is filled in and marked, the
// rest is yours to try. The course's own rules apply (best-of, drop-lowest, ECO206's two competing schemes)
// because src/grade.js is the same model the morning pass uses — the number here is the number in the email.
const clamp = v => (v === '' || v == null ? null : Math.max(0, Math.min(100, Number(v))))
const fmt = v => (v == null ? '—' : v.toFixed(1))
const day = iso => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '')

export default function GradeSim({ course }) {
  const g = course.grading
  const known = course.scores || {}
  const [scores, setScores] = useState(() => JSON.parse(JSON.stringify(known)))
  const [fill, setFill] = useState(() => { const st = standing(g, known); return st.best.grade != null ? Math.round(st.best.grade) : 75 })
  // Typing an average over a `many` component replaces the individual marks (`all`), or the drop rule would keep
  // reading the marks Quercus returned and ignore the number just typed.
  const set = (ck, ik, v) => setScores(s => { const cur = { ...(s[ck] || {}), [ik]: clamp(v) }; if (ik === 'avg') delete cur.all; return { ...s, [ck]: cur } })
  const isKnown = (ck, ik) => known[ck]?.[ik] != null
  const touched = JSON.stringify(scores) !== JSON.stringify(known)

  const st = useMemo(() => standing(g, scores), [g, scores])
  const proj = useMemo(() => standing(g, scores, fill), [g, scores, fill])
  const prog = useMemo(() => progress(g, scores), [g, scores])
  const targets = useMemo(() => [['A−', 80], ['A', 85], ['A+', 90]].map(([l, t]) => [l, t, neededFor(g, scores, t)]), [g, scores])

  return (
    <section className="sim">
      <div className="sim-top">
        <div className="sim-stat">
          <div className="sim-k">Where you stand</div>
          {st.best?.grade == null
            ? <div className="sim-none">Nothing marked yet</div>
            : <div className="sim-big">{fmt(st.best.grade)}<small>%</small>{st.letter && <span className="sim-letter">{st.letter}</span>}</div>}
          <div className="sim-s">{prog.written}% of the course written{g.schemes.length > 1 && st.best?.name ? ` · ${st.best.name} is ahead` : ''}</div>
        </div>
        <div className="sim-stat">
          <div className="sim-k">If the rest averages</div>
          <div className="sim-slider">
            <input type="range" min="40" max="100" value={fill} onChange={e => setFill(Number(e.target.value))} />
            <b>{fill}%</b>
          </div>
          <div className="sim-s">you finish at <b className="sim-land">{fmt(proj.best?.grade)}%</b>{proj.letter && <span className="sim-letter">{proj.letter}</span>}</div>
        </div>
        <div className="sim-stat sim-needs">
          <div className="sim-k">To finish with</div>
          <div className="sim-need-row">
            {targets.map(([l, t, need]) => (
              <div key={l} className={'sim-need' + (need === 0 ? ' locked' : need === Infinity ? ' gone' : '')} title={`${t}% overall`}>
                <b>{l}</b><span>{need == null ? '—' : need === 0 ? 'locked in' : need === Infinity ? 'gone' : `${need.toFixed(0)}%`}</span>
              </div>))}
          </div>
          <div className="sim-s">on everything still to come</div>
        </div>
      </div>

      <div className="sim-marks">
        {g.components.map(comp => {
          const w = g.schemes.map(s => s.weights[comp.key]).filter(x => x != null)
          const weight = comp.bonus ? `+${Math.round(comp.bonus * 100)}% bonus` : [...new Set(w)].map(x => x + '%').join(' / ')
          const rule = [...new Set(g.schemes.map(s => s.best?.[comp.key]).filter(Boolean))]
          const note = [rule.length ? `best ${rule.join('/')}` : '', comp.best ? `top ${comp.best} of ${comp.count}` : '', comp.dropLowestFraction ? `lowest ${Math.round(comp.dropLowestFraction * 100)}% dropped` : ''].filter(Boolean).join(' · ')
          const rows = comp.many ? [{ key: 'avg', label: 'Average so far', date: null }] : comp.items
          return (
            <div key={comp.key} className="sim-comp">
              <div className="sim-comp-head"><b>{comp.label}</b><span className="pill">{weight}</span>{note && <i>{note}</i>}</div>
              <div className="sim-cells">
                {rows.map(it => (
                  <label key={it.key} className={'sim-cell' + (isKnown(comp.key, it.key) ? ' known' : '')}>
                    <span className="sim-cell-n">{it.label}</span>
                    <span className="sim-cell-d">{it.date ? day(it.date) : ''}</span>
                    <input type="number" min="0" max="100" placeholder="—" value={scores[comp.key]?.[it.key] ?? ''} onChange={e => set(comp.key, it.key, e.target.value)} />
                  </label>))}
              </div>
            </div>)
        })}
      </div>
      {touched && <button className="link sim-reset" onClick={() => setScores(JSON.parse(JSON.stringify(known)))}>Reset to what Quercus says</button>}
    </section>
  )
}
