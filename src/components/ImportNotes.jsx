import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { termsOf, weeksOf, currentWeekOf, shortWeek, notesDir } from '../notes.js'
import '../styles/notes.css'

// Notes you wrote somewhere else, brought in (SPEC §20.38). Add files does this for documents — a handout, a recording, a
// photo of the board — but a note written in Obsidian, exported from Notes, or handed over by someone else had no way in,
// and a notebook you cannot put your own writing into is not a notebook. Drop .md or .txt files, say which course and week,
// and each becomes a page under that week's Notes with the text *as the page* — not a file attached to one — so it is
// searchable, tickable and editable like anything you wrote here.
// props: { courses:[{key,code,name,color}], today, defaultCourse, onClose, onDone(paths) }
const TEXT = /\.(md|markdown|txt|text)$/i
const titleOf = (name, text) => (/^#\s+(.+)$/m.exec(text)?.[1] || name.replace(/\.[^.]+$/, '')).replace(/[\/\\:]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Note'
const kb = b => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`)

export default function ImportNotes({ courses = [], today = new Date().toLocaleDateString('en-CA'), defaultCourse, onClose, onDone }) {
  const list = courses.filter(c => c.key)
  const [key, setKey] = useState(() => defaultCourse || list[0]?.key || null)
  const [term, setTerm] = useState(null)
  const [weekN, setWeekN] = useState(null)
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(null), [error, setError] = useState(null), [done, setDone] = useState(null)
  const course = list.find(c => c.key === key) || null

  const terms = useMemo(() => (key ? termsOf(key) : []), [key])
  const here = useMemo(() => (key ? currentWeekOf(key, today) : null), [key, today])
  const activeTerm = term || here?.term || terms[0] || null
  const weeks = useMemo(() => (key ? weeksOf(key, activeTerm) : []), [key, activeTerm])
  const week = weeks.find(w => w.n === weekN) || weeks.find(w => w.n === here?.n) || weeks[0] || null
  useEffect(() => { setTerm(null); setWeekN(null) }, [key])

  const add = picked => {
    if (picked.some(f => !TEXT.test(f.name))) setError('Only written notes come in this way — .md or .txt. A PDF, an image or a recording goes through Add files.')
    setFiles(cur => [...cur, ...picked.filter(f => TEXT.test(f.name) && !cur.some(x => x.name === f.name && x.size === f.size))])
  }
  const drop = e => { e.preventDefault(); add([...(e.dataTransfer?.files || [])]) }

  const bring = async () => {
    if (!course || !week || !files.length) return
    setBusy('importing'); setError(null); setDone(null)
    const dir = notesDir(course.key, week.dir)
    const made = []
    try {
      for (const f of files) {
        setBusy(f.name)
        // Its own front matter is not ours: the app writes the header, the file gives the words.
        const text = (await f.text()).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
        let title = titleOf(f.name, text), page = null
        for (let i = 1; i <= 20 && !page; i++) {
          const t = i === 1 ? title : `${title} ${i}`
          try { page = (await api.createPage({ dir, title: t })).path; title = t }
          catch (e) { if (e.status !== 409) throw e }        // a note by that name is already in this week: the next one along
        }
        if (!page) throw new Error(`there are already twenty notes called “${title}” in that week`)
        const cur = await api.page(page)
        await api.savePage(page, [{ id: null, md: /^#\s+/.test(text) ? text : `# ${title}\n\n${text}` }], cur.hash)
        await api.frontmatter(page, { kind: 'notes', tags: ['imported'] }).catch(() => { })
        made.push(page)
      }
      setDone(made); setFiles([]); onDone?.(made)
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs np af" style={{ '--c': course?.color || 'var(--accent)' }} onClick={e => e.stopPropagation()} role="dialog" aria-label="Import notes">
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head"><h2>Import notes</h2><p>{course && week ? `${course.code} · ${shortWeek(week.label)} · Notes` : 'Pick a course and a week'}</p></div>
        <div className="cs-body np-body">
          <label className="af-drop" onDragOver={e => e.preventDefault()} onDrop={drop}>
            <input type="file" multiple hidden accept=".md,.markdown,.txt,.text,text/markdown,text/plain" onChange={e => { add([...e.target.files]); e.target.value = '' }} />
            <Icon.download width="18" height="18" />
            <b>Drop notes here, or choose them</b>
            <small>Markdown or plain text — each one becomes a page you can keep writing on</small>
          </label>

          {files.length > 0 && (
            <ul className="af-list">{files.map(f => (
              <li key={f.name + f.size}>
                <span className="af-ic"><Icon.notes width="14" height="14" /></span>
                <span className="grow">{f.name}<small>{kb(f.size)}</small></span>
                {busy === f.name ? <span className="af-go">importing…</span>
                  : <button className="af-x" title="Not this one" onClick={() => setFiles(cur => cur.filter(x => x !== f))}><Icon.x width="12" height="12" /></button>}
              </li>))}</ul>)}

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
              <button key={w.label} className={'np-week' + (w.n === week?.n ? ' on' : '') + (here && w.n === here.n ? ' now' : '')}
                title={`${w.label} · ${w.span}`} onClick={() => setWeekN(w.n)}><b>{w.n}</b><span>{w.span.split(' – ')[0]}</span></button>))}</div>
          </div>

          {error && <p className="home-error np-error">{error}</p>}
          {done && <p className="af-done">Brought in {done.length} note{done.length === 1 ? '' : 's'} · {course?.code} {shortWeek(week?.label || '')}. They are yours now — open one and keep writing.</p>}
          <div className="np-go">
            <span className="np-say">{files.length ? `${files.length} note${files.length === 1 ? '' : 's'} → ${course?.code} · ${shortWeek(week?.label || '')} · Notes` : 'Nothing chosen yet'}</span>
            <button className="btn primary" disabled={!files.length || !week || !!busy} onClick={bring}>{busy ? 'Importing…' : 'Bring them in'}</button>
          </div>
        </div>
      </div>
    </div>)
}
