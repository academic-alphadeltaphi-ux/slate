import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { THIS as ED } from '../edition.js'
import { useTranscribe, SPEECH } from '../transcribe.js'
import '../styles/screens.css'
import '../styles/library.css'

// The library (SPEC §20.23): three courses, then the kinds of thing each holds, then the documents. One long
// scrolling page put everything on screen at once and read as a pile; drilling down means each step answers a
// single question — which course, what kind of thing, which document — and search cuts straight through all
// three, because when you are hunting a document you do not care where it lives.
// The kinds are the week's shelves in the week's order (SPEC §20.53, §20.57) — readings, videos and assignments included,
// so a thing on a week's shelf is under the same word here — then what a course has beside its weeks.
// A room of drawn shelves — spines, cassettes, notebooks, pinned cards — was built and taken out the same hour (SPEC §20.64).
const KINDS = [
  ['lectures', 'Slides & handouts', 'board'],
  ['readings', 'Readings', 'bookOpen'],
  ['textbook', 'Textbook', 'book'],
  ['videos', 'Videos', 'video'],
  ['recordings', 'Recordings', 'headphones'],
  ['problems', 'Problem sets', 'pencil'],
  ['assignments', 'Assignments', 'checkSquare'],
  ...(ED.sheets ? [['sheets', 'Study sheets', 'bookmark']] : []),
  ['submitted', 'Work I submitted', 'clipboard'],
  ['announcements', 'Announcements', 'megaphone'],
  ['course info', 'Course info', 'file'],
  ['notes', 'My notes', 'notes'],
  ['other', 'Other', 'file'],
]
const LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]))
const ICON = Object.fromEntries(KINDS.map(([k, , i]) => [k, i]))
const I = (n, p = { width: 15, height: 15 }) => (Icon[n] || Icon.file)(p)
const when = ms => (ms ? new Date(ms).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '')

export default function Library({ onOpen, onOpenCourse, onOpenWeek, onOpenPair, onAdd }) {
  const [d, setD] = useState(null), [error, setError] = useState(null)
  const [course, setCourse] = useState(null), [kind, setKind] = useState(null), [q, setQ] = useState('')
  const load = () => api.library().then(x => { setD(x); setError(null) }).catch(e => setError(e.message))
  useEffect(() => { load() }, [])
  useEffect(() => { let t = null; const off = api.events(() => { clearTimeout(t); t = setTimeout(load, 900) }); return () => { off(); clearTimeout(t) } }, [])

  const rows = d?.rows || []
  const needle = q.trim().toLowerCase()
  const found = needle ? rows.filter(r => String(r.title || '').toLowerCase().includes(needle) || (r.week || '').toLowerCase().includes(needle) || (r.file || '').toLowerCase().includes(needle)) : null
  const forCourse = course ? rows.filter(r => r.courseKey === course.key) : []
  const kindsOf = list => KINDS.map(([k, label, icon]) => ({ k, label, icon, items: list.filter(x => x.bucket === k) })).filter(x => x.items.length)

  if (error) return <div className="home"><div className="home-empty"><p>{error}</p></div></div>

  const crumbs = (
    <div className="lib-crumbs">
      <button className={'lib-crumb' + (!course ? ' on' : '')} onClick={() => { setCourse(null); setKind(null) }}>All courses</button>
      {course && <><span className="lib-crumb-sep">›</span><button className={'lib-crumb' + (!kind ? ' on' : '')} style={{ '--c': course.color }} onClick={() => setKind(null)}>{course.code}</button></>}
      {course && kind && <><span className="lib-crumb-sep">›</span><span className="lib-crumb on">{LABEL[kind] || kind}</span></>}
    </div>)

  const title = !d ? 'Reading your courses…'
    : found ? `${found.length} match${found.length === 1 ? '' : 'es'}`
    : course ? (kind ? LABEL[kind] : course.name)
    : `${rows.length} documents`

  return (
    <div className="home lib">
      <div className="home-head">
        <div>
          <div className="home-kicker">Library</div>
          <h1 className="home-title">{title}</h1>
        </div>
        <div className="home-actions">
          <label className="lib-search">
            <Icon.search width="14" height="14" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search every document" />
            {q && <button className="lib-clear" onClick={() => setQ('')}><Icon.x width="12" height="12" /></button>}
          </label>
          {/* Everything here arrived through the sync; this is how anything else gets in (SPEC §20.30). */}
          <button className="btn primary" title="Put your own PDFs, recordings or images into a week" onClick={() => onAdd?.(course?.key)}><Icon.plus width="14" height="14" />Add files</button>
        </div>
      </div>

      {d && (found
        ? (found.length === 0
          ? <p className="blank lib-none">Nothing matches. <button className="link" onClick={() => setQ('')}>Clear the search</button></p>
          : <div className="lib-grid lib-results">{found.map(r => <Doc key={r.path} r={r} onOpen={onOpen} onOpenWeek={onOpenWeek} onOpenPair={onOpenPair} showCourse />)}</div>)

        : !course
          ? <div className="lib-courses-grid" style={{ '--n': d.courses.length }}>
              {d.courses.map(c => {
                const list = rows.filter(r => r.courseKey === c.key), kinds = kindsOf(list)
                const most = Math.max(1, ...kinds.map(g => g.items.length))
                // What a course holds, as a short bar chart — one row per kind with its number — rather than a heap of
                // pills that all looked the same (SPEC §20.34).
                return (
                  <button key={c.key} className="lib-coursecard" style={{ '--c': c.color }} onClick={() => setCourse(c)}>
                    <span className="lib-coursecard-head"><span className="lib-code">{c.code}</span><span className="lib-coursecard-name">{c.name}</span></span>
                    <span className="lib-coursecard-body">
                    <span className="lib-count"><b>{list.length}</b>document{list.length === 1 ? '' : 's'}</span>
                    <span className="lib-kinds">
                      {kinds.map(g => (
                        <span key={g.k} className="lib-kind">
                          <span className="lib-kind-ic">{I(g.icon, { width: 13, height: 13 })}</span>
                          <span className="lib-kind-name">{g.label}</span>
                          <span className="lib-kind-bar"><i style={{ width: `${Math.max(8, Math.round((100 * g.items.length) / most))}%` }} /></span>
                          <b>{g.items.length}</b>
                        </span>))}
                    </span>
                    <span className="lib-coursecard-foot">Browse<Icon.chevron width="15" height="15" /></span>
                    </span>
                  </button>)
              })}
            </div>

          : !kind
            ? <>{crumbs}
                <div className="lib-kinds-grid">
                  {kindsOf(forCourse).map(g => (
                    <button key={g.k} className="lib-kindcard" style={{ '--c': course.color }} onClick={() => setKind(g.k)}>
                      <span className="lib-kindcard-ic">{I(g.icon, { width: 20, height: 20 })}</span>
                      <span className="lib-kindcard-name">{g.label}</span>
                      <span className="lib-kindcard-n">{g.items.length}</span>
                    </button>))}
                </div>
              </>

            : <>{crumbs}
                <div className="lib-grid">{forCourse.filter(r => r.bucket === kind).map(r => <Doc key={r.path} r={r} onOpen={onOpen} onOpenWeek={onOpenWeek} onOpenPair={onOpenPair} />)}</div>
              </>)}
    </div>
  )
}

// A problem set's questions and solutions are one row (SPEC §20.32): the row opens the questions, and Solutions opens
// them with the solutions beside them.
function Doc({ r, onOpen, onOpenWeek, onOpenPair, showCourse = false }) {
  // A page that is only a link — a video still on MyMedia, a forum on Quercus — wears the kind's icon, not "TEXT".
  const badge = r.ext || (r.words && !r.url ? 'TEXT' : null)
  const rec = (r.audio || 0) + (r.video || 0)          // a recording is audio or video; both can be transcribed
  const src = !r.url ? null : /library\.utoronto\.ca/i.test(r.url) ? 'MyMedia' : /youtu\.?be/i.test(r.url) ? 'YouTube' : /zoom\.us/i.test(r.url) ? 'Zoom' : 'Quercus'
  return (
    <article className="lib-doc" style={{ '--c': r.color }}>
      <button className="lib-doc-open" onClick={() => onOpen(r.path)} title={`Open ${r.title}`}>
        <span className={'lib-badge k-' + (r.video ? 'video' : r.audio ? 'audio' : r.pdfs ? 'pdf' : r.images ? 'img' : 'text')}>
          {r.video ? I('video', { width: 15, height: 15 }) : r.audio ? I('headphones', { width: 15, height: 15 }) : badge || I(ICON[r.bucket] || 'file', { width: 15, height: 15 })}
        </span>
        <span className="lib-doc-main">
          <span className="lib-doc-title">{r.title.replace(/^\d{4}-\d{2}-\d{2}\s*/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')}</span>
          <span className="lib-doc-meta">
            {showCourse && <span className="tag" style={{ '--c': r.color }}>{r.course}</span>}
            {/* Spans, not buttons: the whole card is a button, and a button inside a button is invalid HTML (React said so). */}
            {r.week && <span className="lib-week" role="link" tabIndex={0} onClick={e => { e.stopPropagation(); onOpenWeek(`${r.courseKey}/${r.term}/${r.week}`) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOpenWeek(`${r.courseKey}/${r.term}/${r.week}`) } }}>{r.week.replace(/\s*\(.*\)$/, '')}</span>}
            {r.solutions && onOpenPair && <span className="lib-sol" role="button" tabIndex={0} title="The questions with the solutions beside them"
              onClick={e => { e.stopPropagation(); onOpenPair(r.path, r.solutions.path) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOpenPair(r.path, r.solutions.path) } }}><Icon.eye width="11" height="11" />Solutions</span>}
            {r.role === 'guide' && <span className="pill">guide</span>}
            {r.transcribed && <span className="pill">transcribed</span>}
            {rec > 0 && !r.transcribed && SPEECH && <span className="pill warn">not transcribed</span>}
            {r.date ? <span>{r.date}</span> : r.modified ? <span>{when(r.modified)}</span> : null}
          </span>
        </span>
      </button>
      {rec > 0 && !r.transcribed && <Transcribe path={r.path} />}
      {r.url
        ? <a className="lib-src" href={r.url} target="_blank" rel="noopener" title={`Open it on ${src}`} onClick={e => e.stopPropagation()}>{src}<Icon.external width="11" height="11" /></a>
        : r.courseUrl ? <a className="lib-src dim" href={r.courseUrl} target="_blank" rel="noopener" title="This one has no direct link — opens the course on Quercus" onClick={e => e.stopPropagation()}>Course<Icon.external width="11" height="11" /></a>
        : null}
    </article>)
}

// A recording with no transcript, transcribed from its row (SPEC §20.36); the Library reloads on the transcript's file event.
function Transcribe({ path }) {
  const stt = useTranscribe(path)
  if (stt.off) return null
  return stt.busy
    ? <span className="lib-src dim" title={stt.say}>{stt.phase === 'queued' ? 'Waiting…' : 'Transcribing…'}</span>
    : <button className="lib-src lib-tr" onClick={stt.start} title={stt.phase === 'error' ? stt.note : 'Turn the recording into text, on this computer'}><Icon.mic width="11" height="11" />{stt.phase === 'error' ? 'Try again' : 'Transcribe'}</button>
}
