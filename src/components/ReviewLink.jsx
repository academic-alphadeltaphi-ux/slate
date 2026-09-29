import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import '../styles/review.css'

// The Sunday review lives in the hidden Hub notebook (SPEC §20.5); this link in the Home head is how it is reached.
// Latest = the largest date suffix among Hub/Review's pages — no route, no state file: the page list the server already
// serves is enough, and a missing folder is just []. review.mjs writes from outside the server, so the watcher
// broadcasts the page and the folder's _slate.json: refresh on anything under Hub/Review/.
const DATE_RE = /(\d{4}-\d{2}-\d{2})$/
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const labelOf = iso => { const d = new Date(iso + 'T12:00:00'); return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}` }
// → { date, path } of the newest review among the rows of GET /api/pages?dir=Hub/Review, or null.
export function latestReview(rows) {
  let best = null
  for (const r of rows || []) {
    if (r.virtual || typeof r.title !== 'string') continue
    const m = DATE_RE.exec(r.title); if (!m) continue
    if (!best || m[1] > best.date) best = { date: m[1], path: r.path || `Hub/Review/${r.title}.md` }
  }
  return best
}

export default function ReviewLink({ onOpen }) {
  const [latest, setLatest] = useState(null)
  useEffect(() => {
    let alive = true, timer = null
    const load = () => api.pages('Hub/Review').then(rows => { if (alive) setLatest(latestReview(rows)) }).catch(() => { if (alive) setLatest(null) })
    load()
    const off = api.events(ev => { if (typeof ev?.path === 'string' && ev.path.startsWith('Hub/Review/')) { clearTimeout(timer); timer = setTimeout(load, 300) } })
    return () => { alive = false; clearTimeout(timer); off() }
  }, [])
  if (!latest) return null
  return (
    <button type="button" className="review-link" title="Open the last Sunday review" onClick={() => onOpen(latest.path)}>
      <Icon.bookmark width="13" height="13" />Last review · {labelOf(latest.date)}
    </button>
  )
}
// Mounted by Home.jsx as the first child of `.home-actions`. App.openPage sets the section to Hub/Review, so the
// page list then shows every past review, newest first (Hub/Review/_slate.json, written by review.mjs).
