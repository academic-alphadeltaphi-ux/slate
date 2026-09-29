import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { noteNameOf, isWeekNote } from '../notes.js'
import ContextMenu from './ContextMenu.jsx'
import ImportNotes from './ImportNotes.jsx'
import SaveAs from './SaveAs.jsx'
import { useDialog } from './Dialog.jsx'
import '../styles/screens.css'
import '../styles/notes.css'

// My notes (SPEC §20.26). The Library holds what the student was *given* — slides, problem sets, recordings, the
// professor's announcements. This holds what he wrote: one card per note, newest first, the first lines of it on
// the card so a week is recognisable without opening it. The button that starts a new one is the first thing on
// the page, because a notebook you cannot write in from its own front page is not a notebook.
// props: { onOpen(path), onOpenCourse(key), onTake() }
const when = ms => (ms ? new Date(ms).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '')
const words = n => `${n} word${n === 1 ? '' : 's'}`

export default function Notes({ onOpen, onOpenCourse, onTake }) {
  const dialog = useDialog()
  const [menu, setMenu] = useState(null)      // the ··· menu of one note
  const [saving, setSaving] = useState(null)  // the note whose Save a copy sheet is open
  const [importing, setImporting] = useState(false)   // notes written elsewhere, brought in (SPEC §20.38)
  const [d, setD] = useState(null), [error, setError] = useState(null)
  const [only, setOnly] = useState('all')
  const [bodies, setBodies] = useState({})
  const load = () => api.library().then(x => { setD(x); setError(null) }).catch(e => setError(e.message))
  useEffect(() => { load() }, [])
  useEffect(() => { let t = null; const off = api.events(() => { clearTimeout(t); t = setTimeout(load, 900) }); return () => { off(); clearTimeout(t) } }, [])

  // What the student wrote: a week's notes sheet, and any page of his own that is not something Quercus posted.
  const rows = useMemo(() => (d?.rows || [])
    .filter(r => r.bucket === 'notes' || (r.bucket === 'other' && !r.fromQuercus))
    .map(r => ({ ...r, name: noteNameOf(r.path, r.course) || r.title }))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0)), [d])
  const courses = d?.courses || []
  const shown = rows.filter(r => only === 'all' || r.courseKey === only)

  // The first lines of each note, so a card says what is in it. One request per note, only for what is on screen.
  useEffect(() => {
    let alive = true
    for (const r of shown.slice(0, 24)) {
      if (bodies[r.path] !== undefined) continue
      api.page(r.path).then(p => {
        if (!alive) return
        const text = p.blocks.map(b => b.md).join('\n').replace(/^#\s+.*$/m, '').replace(/^_.*_$/gm, '')
          .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => (b || a).split('/').pop())
          .replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim()
        setBodies(b => ({ ...b, [r.path]: text }))
      }).catch(() => { if (alive) setBodies(b => ({ ...b, [r.path]: '' })) })
    }
    return () => { alive = false }
  }, [shown.map(r => r.path).join('|')])

  // Every note is manageable from here: a copy in any format, or gone (SPEC §20.30).
  const open = (e, r) => setMenu({ at: { x: e.clientX - 180, y: e.clientY + 10 }, items: [
    { label: 'Open', onClick: () => onOpen(r.path) },
    { label: 'Save a copy… (PDF, Word, Markdown)', onClick: () => setSaving({ path: r.path, title: r.name, dir: r.path.split('/').slice(0, -1).join('/') }) },
    '-',
    { label: 'Move this note to Trash', danger: true, onClick: async () => {
      if (!(await dialog.confirm({ title: `Move “${r.name}” to the trash?`, message: 'It stays in Notebooks/.trash until you empty it by hand.', confirmLabel: 'Move to Trash', danger: true }))) return
      try { await api.trash(r.path); load() } catch (err) { setError(err.message) }
    } },
  ] })

  if (error) return <div className="home"><div className="home-empty"><p>{error}</p></div></div>
  return (
    <div className="home notes">
      <div className="home-head">
        <div>
          <div className="home-kicker">My notes</div>
          <h1 className="home-title">{rows.length === 0 ? 'Nothing written yet' : `${rows.length} note${rows.length === 1 ? '' : 's'}`}</h1>
        </div>
        <div className="home-actions">
          <button className="btn" title="Notes you wrote somewhere else — Markdown or plain text" onClick={() => setImporting(true)}><Icon.download width="14" height="14" />Import notes</button>
          <button className="btn primary" onClick={onTake}><Icon.pencil width="14" height="14" />Take notes</button>
        </div>
      </div>

      {rows.length > 0 && courses.length > 1 && (
        <div className="nt-filters">
          <span className="tabs">
            <button className={'tab' + (only === 'all' ? ' on' : '')} onClick={() => setOnly('all')}>Everything</button>
            {courses.map(c => <button key={c.key} className={'tab' + (only === c.key ? ' on' : '')} onClick={() => setOnly(c.key)}>{c.code}</button>)}
          </span>
        </div>)}

      {shown.length === 0 ? (
        <div className="nt-blank">
          <h2>{rows.length === 0 ? 'Your notebook is empty' : 'Nothing for this course yet'}</h2>
          <p>Notes live in the week they belong to. Pick a course and a week and start writing — the sheet is named
            for you, and it turns up here, on the week, and on the course from then on.</p>
          <button className="btn primary" onClick={onTake}><Icon.pencil width="14" height="14" />Take notes</button>
        </div>
      ) : (
        <div className="nt-grid">
          {shown.map(r => (
            <article key={r.path} className="nt-card" style={{ '--c': r.color || 'var(--muted-2)' }} tabIndex={0} onClick={() => onOpen(r.path)}
              onKeyDown={e => { if (e.key === 'Enter') onOpen(r.path) }} title={`Open ${r.name}`}>
              <div className="nt-card-top">
                <button className="tag" style={{ '--c': r.color }} onClick={e => { e.stopPropagation(); onOpenCourse(r.courseKey) }}>{r.course}</button>
                <span className="nt-when">{when(r.modified)}</span>
                <button className="nt-more" title="Save a copy, or delete this note" onClick={e => { e.stopPropagation(); open(e, r) }}>···</button>
              </div>
              <div className="nt-title">{r.name}</div>
              {bodies[r.path] ? <div className="nt-body">{bodies[r.path]}</div> : null}
              <div className="nt-foot">
                <span className="pl-icon">{Icon.notes({ width: 13, height: 13 })}</span>
                <span>{isWeekNote(r.path) || /\/Notes\//.test(r.path) ? r.week : 'a page of your own'}</span>
                {r.words > 0 && <span>· {words(r.words)}</span>}
              </div>
            </article>))}
        </div>)}
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {saving && <SaveAs page={saving} onClose={() => setSaving(null)} />}
      {importing && <ImportNotes courses={courses} defaultCourse={only === 'all' ? undefined : only} onClose={() => setImporting(false)} onDone={load} />}
    </div>)
}
