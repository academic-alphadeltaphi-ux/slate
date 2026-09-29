import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { sourceOf } from './SourceBanner.jsx'
import { pairSets, setSays } from '../problems.js'
import '../styles/pagehead.css'

// The header above a page that is not your own notes (SPEC §20.23). Ruled paper is where you write; a lecture
// handout, a recording or a study sheet is a document you read, so it loses the rules and gains a calm header
// instead: where it sits, what it is called, where it came from, and the way out to Quercus.
//
// A document in a week's Problems also says which set it belongs to, and when the set has solutions, offers them
// beside it (SPEC §20.32) — the questions stay on the left, the solutions open in the right pane, and the same
// button closes them. Without the shell's callbacks (the right pane's own header) the bar only names the set.
// props: { page, onPrint, split, onOpenPair(left, right), onCloseRight() }
const BUCKET_LABEL = { Lectures: 'Slides & handouts', Recordings: 'Recording', 'Study sheets': 'Study sheet', Problems: 'Problem set', Announcements: 'Announcement', General: 'Course info', Notes: 'Notes' }
const fmt = ms => (ms ? new Date(ms).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '')

// Where a page sits, read from its path: <Course>/<Term>/<Week>/<Bucket>/<Page>.
export function placeOf(path) {
  const p = String(path || '').replace(/\.md$/, '').split('/')
  const course = p[0] || null
  const week = p.find(x => /^Week \d+/.test(x)) || null
  const bucket = p.length > 2 ? p[p.length - 2] : null
  return {
    course, week: week ? week.replace(/\s*\(.*\)$/, '') : null,
    label: BUCKET_LABEL[bucket] || (p[1] === 'General' ? 'Course info' : null),
    isNotes: p[p.length - 1] === 'Notes' || bucket === 'Notes',
  }
}

// The set a page under `…/Problems/` belongs to, from the names of the pages beside it.
function useSetOf(page) {
  const [set, setSet] = useState(null)
  const dir = page?.path ? page.path.split('/').slice(0, -1).join('/') : ''
  const inProblems = dir.split('/').pop() === 'Problems'
  useEffect(() => {
    setSet(null)
    if (!inProblems) return
    let alive = true
    api.pages(dir).then(list => {
      if (!alive) return
      const s = pairSets((list || []).filter(p => !p.virtual)).find(g => [g.questions, g.solutions, g.guide].some(x => x?.path === page.path))
      setSet(s || null)
    }).catch(() => { })
    return () => { alive = false }
  }, [page?.path])
  return set
}

export default function PageHeader({ page, onPrint, split = null, onOpenPair, onCloseRight }) {
  const set = useSetOf(page)
  if (!page) return null
  const place = placeOf(page.path)
  if (place.isNotes) return null                       // your own notes keep the ruled sheet and no chrome
  const src = sourceOf(page)
  const trail = [place.course, place.week, place.label].filter(Boolean).join(' · ')
  const when = src?.date ? new Date(src.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'long', day: 'numeric' }) : fmt(page.modified)
  const isQuestions = set?.questions?.path === page.path, isSolutions = set?.solutions?.path === page.path
  const showing = !!set?.solutions && split === set.solutions.path
  return (
    <header className="pghead">
      <div className="pghead-in">
        {trail && <div className="pghead-trail">{trail}</div>}
        <h1 className="pghead-title">{page.title}</h1>
        {set && (
          <div className="pghead-set">
            <span className="pghead-set-name">{set.name}</span>
            <span className="pghead-set-says">{isSolutions && set.questions ? 'the solutions to this set' : setSays(set)}</span>
            {isQuestions && set.solutions && onOpenPair && (showing
              ? <button className="btn small" onClick={() => onCloseRight?.()}><Icon.eyeOff width="13" height="13" />Hide the solutions</button>
              : <button className="btn small primary" title="The solutions beside the questions, in the right pane" onClick={() => onOpenPair(page.path, set.solutions.path)}><Icon.eye width="13" height="13" />Show solutions</button>)}
            {isSolutions && set.questions && onOpenPair && <button className="btn small" title="The questions on the left, these solutions beside them" onClick={() => onOpenPair(set.questions.path, page.path)}>The questions beside it</button>}
          </div>)}
        <div className="pghead-foot">
          <span className="pghead-from">{src ? `From ${src.who && src.who !== 'your professor' ? src.who : 'Quercus'}${when ? ` · ${when}` : ''}` : when ? `Yours · ${when}` : 'Yours'}</span>
          {/* Print left with the print dialog (SPEC §20.28): Save a copy in the top bar writes a real PDF, Word or
              Markdown file, so a second button here was both redundant and stranded beside the source line. */}
          {src?.url && <span className="pghead-actions"><a className="btn small" href={src.url} target="_blank" rel="noopener">Quercus<Icon.external width="12" height="12" /></a></span>}
        </div>
      </div>
    </header>
  )
}
