import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { startNote, startNewNote, termsOf, weeksOf, currentWeekOf, noteTitle, shortWeek, notesDir } from '../notes.js'
import '../styles/notes.css'

// Take notes, from anywhere (SPEC §20.26). Two choices and a button: which course, which week. Both are answered
// before it opens — the course you have next and the week you are in — so the common case is *Take notes* then
// Enter. A week that already has a note says so, and Enter continues it. It is not the only door any more (SPEC
// §20.33): *New note* starts another one for the same week — a tutorial and a lecture are two notes, not one — and
// every other note that week holds is one click away underneath.
// props: { courses:[{key,code,name,color}], today, defaultCourse, onClose, onOpen(path) }
export default function NotePicker({ courses = [], today, defaultCourse, onClose, onOpen }) {
  const list = courses.filter(c => c.key)
  const [key, setKey] = useState(() => defaultCourse || list[0]?.key || null)
  const [term, setTerm] = useState(null)
  const [weekN, setWeekN] = useState(null)
  const [written, setWritten] = useState({})     // week label → true when its sheet already has words
  const [extra, setExtra] = useState([])         // the notes filed beside the chosen week's sheet
  const [busy, setBusy] = useState(null), [error, setError] = useState(null)
  const course = list.find(c => c.key === key) || null

  const terms = useMemo(() => (key ? termsOf(key) : []), [key])
  const here = useMemo(() => (key ? currentWeekOf(key, today) : null), [key, today])
  const activeTerm = term || here?.term || terms[0] || null
  const weeks = useMemo(() => (key ? weeksOf(key, activeTerm) : []), [key, activeTerm])
  const week = weeks.find(w => w.n === weekN) || weeks.find(w => w.n === here?.n) || weeks[0] || null

  // Reset the week when the course changes, and ask that course's term which weeks already hold a note.
  useEffect(() => { setTerm(null); setWeekN(null); setWritten({}) }, [key])
  useEffect(() => {
    if (!key || !activeTerm) return
    let alive = true
    api.term(key, activeTerm)
      .then(d => { if (alive) setWritten(Object.fromEntries((d.weeks || []).map(w => [w.label, w.columns?.find(c => c.id === 'notes')?.state === 'done']))) })
      .catch(() => { })
    return () => { alive = false }
  }, [key, activeTerm])
  useEffect(() => {
    setExtra([])
    if (!key || !week) return
    let alive = true
    api.pages(notesDir(key, week.dir)).then(ps => { if (alive) setExtra((ps || []).filter(p => !p.virtual).map(p => ({ title: p.title, path: p.path }))) }).catch(() => { })
    return () => { alive = false }
  }, [key, week?.dir])

  // mode: 'continue' (the week's sheet, created on the way in), 'new' (another note for the week), or a path to open.
  const go = async mode => {
    if (!course || !week || busy) return
    setBusy(mode); setError(null)
    try {
      const w = { courseKey: course.key, code: course.code, week }
      onOpen(mode === 'new' ? await startNewNote(api, w) : mode === 'continue' ? await startNote(api, w) : mode)
    } catch (e) { setError(e.message); setBusy(null) }
  }
  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); go('continue') }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [course, week, busy])

  const has = week ? !!written[week.label] || extra.length > 0 : false
  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs np" style={{ '--c': course?.color || 'var(--accent)' }} onClick={e => e.stopPropagation()} role="dialog" aria-label="Take notes">
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head">
          <h2>Take notes</h2>
          <p>{course && week ? noteTitle(course.code, week.label) : 'Pick a course and a week'}</p>
        </div>
        <div className="cs-body np-body">
          <div className="np-step">
            <span className="np-k">Course</span>
            <div className="np-chips">{list.map(c => (
              <button key={c.key} className={'np-chip' + (c.key === key ? ' on' : '')} style={{ '--c': c.color }} onClick={() => setKey(c.key)}>{c.code}</button>))}</div>
          </div>

          {terms.length > 1 && (
            <div className="np-step">
              <span className="np-k">Term</span>
              <div className="np-chips">{terms.map(t => (
                <button key={t} className={'np-chip' + (t === activeTerm ? ' on' : '')} onClick={() => { setTerm(t); setWeekN(null) }}>{t}</button>))}</div>
            </div>)}

          <div className="np-step">
            <span className="np-k">Week</span>
            <div className="np-weeks">{weeks.map(w => (
              <button key={w.label} className={'np-week' + (w.n === week?.n ? ' on' : '') + (here && w.n === here.n ? ' now' : '') + (written[w.label] ? ' has' : '')}
                title={`${w.label} · ${w.span}${written[w.label] ? ' · already has a note' : ''}`} onClick={() => setWeekN(w.n)}>
                <b>{w.n}</b><span>{w.span.split(' – ')[0]}</span>
              </button>))}</div>
          </div>

          {error && <p className="home-error np-error">{error}</p>}
          <div className="np-go">
            <span className="np-say">{week ? <>{shortWeek(week.label)} · {week.span}{here && week.n === here.n ? ' · this week' : ''}</> : 'No weeks in this term'}</span>
            {has
              ? <span className="np-actions">
                  <button className="btn" disabled={!!busy} title={`Another note for ${shortWeek(week.label)}, beside the one it has`} onClick={() => go('new')}>
                    <Icon.plus width="13" height="13" />{busy === 'new' ? 'Opening…' : 'New note'}</button>
                  <button className="btn primary" disabled={!!busy} onClick={() => go('continue')}>{busy === 'continue' ? 'Opening…' : 'Continue this note'}</button>
                </span>
              : <button className="btn primary" disabled={!week || !!busy} onClick={() => go('continue')}>{busy ? 'Opening…' : 'Start writing'}</button>}
          </div>
          {extra.length > 0 && (
            <div className="np-step np-extra">
              <span className="np-k">Also this week</span>
              <div className="np-chips">{extra.map(n => (
                <button key={n.path} className="np-chip" title={`Continue ${n.title}`} disabled={!!busy} onClick={() => go(n.path)}>{n.title}</button>))}</div>
            </div>)}
        </div>
      </div>
    </div>)
}
