import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { termsOf, weeksOf, currentWeekOf, shortWeek } from '../notes.js'
import { THIS as ED } from '../edition.js'
import { transcribeAll, SPEECH } from '../transcribe.js'
import '../styles/notes.css'

// Put files into the notebooks by hand (SPEC §20.30). Everything in the Library arrived through the Quercus sync;
// a handout from a friend, a photo of the board, a recording made on a phone had nowhere to go. Drop files here,
// say which course, which week and what kind of thing they are, and each one becomes a page in that week's folder
// with the file on it — the same shape the sync writes, so the week screen, the course screen and the Library all
// pick them up with no special case.
//
// The category is a *folder in the week*, and it is a free field: typing one that does not exist makes it. That is
// how new kinds of thing get added anywhere — the week screen shows every folder it finds, not a fixed six.
//
// A recording can be transcribed the moment it is filed (SPEC §20.36): on this computer, one after another, each page
// showing its transcript when its turn is done. You can close the sheet while they run.
// props: { courses:[{key,code,name,color}], today, defaultCourse, onClose, onDone(paths) }
// The categories offered before any folder has been seen. An edition without study sheets must not suggest one:
// the field makes whatever you type, so offering it would file a document into a folder no screen ever shows.
const KNOWN = ['Lectures', 'Problems', 'Recordings', ...(ED.sheets ? ['Study sheets'] : []), 'Notes']
const IMG = /\.(png|jpe?g|gif|webp|heic|avif)$/i
const AUD = /\.(m4a|mp3|wav|aac|flac|ogg|mp4|mov|webm)$/i
const PDF = /\.pdf$/i
const kindOf = name => (PDF.test(name) ? 'pdf' : IMG.test(name) ? 'image' : AUD.test(name) ? 'media' : 'file')
const titleOf = name => name.replace(/\.[^.]+$/, '').replace(/[\/\\:]/g, '-').trim().slice(0, 120) || 'Untitled'
const mb = b => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`)

export default function AddFiles({ courses = [], today, defaultCourse, onClose, onDone }) {
  const list = courses.filter(c => c.key)
  const [key, setKey] = useState(() => defaultCourse || list[0]?.key || null)
  const [term, setTerm] = useState(null)
  const [weekN, setWeekN] = useState(null)
  const [cat, setCat] = useState('Lectures')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(null), [error, setError] = useState(null), [done, setDone] = useState(null)
  const [transcribe, setTranscribe] = useState(SPEECH)   // recordings: transcribe them once filed (never where speech is off)
  const [queued, setQueued] = useState(0)
  const [seen, setSeen] = useState([])          // categories that already exist in this course
  const course = list.find(c => c.key === key) || null
  const recordings = files.filter(f => kindOf(f.name) === 'media').length

  const terms = useMemo(() => (key ? termsOf(key) : []), [key])
  const here = useMemo(() => (key ? currentWeekOf(key, today) : null), [key, today])
  const activeTerm = term || here?.term || terms[0] || null
  const weeks = useMemo(() => (key ? weeksOf(key, activeTerm) : []), [key, activeTerm])
  const week = weeks.find(w => w.n === weekN) || weeks.find(w => w.n === here?.n) || weeks[0] || null

  useEffect(() => { setTerm(null); setWeekN(null) }, [key])
  // Which folders this course already uses, so the categories offered are the real ones plus whatever you type.
  useEffect(() => {
    if (!key || !activeTerm) return
    let alive = true
    api.pages(`${key}/${activeTerm}`).then(ws => {
      if (!alive) return
      const names = new Set()
      for (const wk of ws) for (const k of wk.children || []) if (k.title !== 'Plan') names.add(k.title)
      setSeen([...new Set([...KNOWN, ...names])].sort())
    }).catch(() => setSeen(KNOWN))
    return () => { alive = false }
  }, [key, activeTerm])
  // A recording belongs under Recordings: dropping one while the category is still the default moves it there.
  useEffect(() => { if (recordings && files.length === recordings && cat === 'Lectures') setCat('Recordings') }, [recordings, files.length])

  const add = picked => setFiles(cur => [...cur, ...picked.filter(f => !cur.some(x => x.name === f.name && x.size === f.size))])
  const drop = e => { e.preventDefault(); add([...(e.dataTransfer?.files || [])]) }

  const file = async () => {
    if (!course || !week || !files.length || !cat.trim()) return
    setBusy('filing'); setError(null); setDone(null); setQueued(0)
    const dir = `${course.key}/${week.dir}/${cat.trim()}`
    const made = [], media = []
    try {
      for (const f of files) {
        setBusy(f.name)
        let page
        try { page = (await api.createPage({ dir, title: titleOf(f.name) })).path }
        catch (e) { if (e.status !== 409) throw e; page = `${dir}/${titleOf(f.name)}.md` }   // already there: put the file on it
        const a = await api.upload(page, f)
        const kind = kindOf(f.name)
        const el = { id: Math.random().toString(36).slice(2, 8), type: kind === 'pdf' ? 'file' : kind, src: a.src, size: a.size, x: 48, y: 96, z: 1 }
        const cur = await api.page(page)
        await api.saveLayout(page, { version: 1, elements: [...(cur.layout?.elements || []), el] }, cur.layoutHash)
        await api.frontmatter(page, { kind: kind === 'media' ? 'notes' : 'lecture', tags: ['added by hand'] }).catch(() => { })
        made.push(page)
        if (kind === 'media') media.push(page)
      }
      setDone(made); setFiles([]); onDone?.(made)
      if (transcribe && media.length) {
        const rs = await transcribeAll(media)
        const failed = rs.filter(r => r.error)
        setQueued(rs.length - failed.length)
        if (failed.length) setError(`Could not start transcribing ${failed.map(r => r.page.split('/').pop().replace(/\.md$/, '')).join(', ')}: ${failed[0].error}`)
      }
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs np af" style={{ '--c': course?.color || 'var(--accent)' }} onClick={e => e.stopPropagation()} role="dialog" aria-label="Add files">
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head"><h2>Add files</h2><p>{course && week ? `${course.code} · ${shortWeek(week.label)} · ${cat || '…'}` : 'Pick a course and a week'}</p></div>
        <div className="cs-body np-body">
          <label className="af-drop" onDragOver={e => e.preventDefault()} onDrop={drop}>
            <input type="file" multiple hidden onChange={e => { add([...e.target.files]); e.target.value = '' }} />
            <Icon.plus width="18" height="18" />
            <b>Drop files here, or choose them</b>
            <small>PDFs, recordings, images, anything</small>
          </label>

          {files.length > 0 && (
            <ul className="af-list">{files.map(f => (
              <li key={f.name + f.size}>
                <span className="af-ic">{(Icon[kindOf(f.name) === 'media' ? 'headphones' : kindOf(f.name) === 'image' ? 'image' : 'file'] || Icon.file)({ width: 14, height: 14 })}</span>
                <span className="grow">{f.name}<small>{mb(f.size)}</small></span>
                {busy === f.name ? <span className="af-go">filing…</span>
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

          <div className="np-step">
            <span className="np-k">Category</span>
            <div className="np-chips">
              {seen.map(c => <button key={c} className={'np-chip' + (c === cat ? ' on' : '')} onClick={() => setCat(c)}>{c}</button>)}
            </div>
            <input className="af-cat" value={cat} onChange={e => setCat(e.target.value)} placeholder="…or type a new one" spellCheck={false} />
          </div>

          {recordings > 0 && SPEECH && (
            <label className="af-tr">
              <input type="checkbox" checked={transcribe} onChange={e => setTranscribe(e.target.checked)} />
              <span className="grow"><b>Transcribe {recordings === 1 ? 'the recording' : `the ${recordings} recordings`} once filed</b>
                <small>On this computer, one after another — you can close this while they run.</small></span>
            </label>)}

          {error && <p className="home-error np-error">{error}</p>}
          {done && <p className="af-done">Filed {done.length} file{done.length === 1 ? '' : 's'} into {cat} · {shortWeek(week?.label || '')}.
            {queued > 0 && ` Transcribing ${queued === 1 ? 'the recording' : `${queued} recordings`} — each page shows its transcript when it is done.`}</p>}
          <div className="np-go">
            <span className="np-say">{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} → ${course?.code} · ${shortWeek(week?.label || '')} · ${cat}` : 'Nothing chosen yet'}</span>
            <button className="btn primary" disabled={!files.length || !week || !cat.trim() || !!busy} onClick={file}>{busy ? 'Filing…' : 'File them'}</button>
          </div>
        </div>
      </div>
    </div>)
}
