import { Icon } from './Icons.jsx'
import '../styles/source.css'

// Whose words these are (SPEC §20.21). An announcement or a Quercus page imported by the sync rendered on the
// same ruled sheet as the student's own notes, in the same type, so "Academic Integrity" read as something he had
// written. The frontmatter always knew — `tags: ["quercus"]`, a kind, a path under Announcements/ — but nothing
// showed it. This band says who wrote it, when, and where it came from, and tints the sheet so the difference is
// visible before you read a word.
// props: { page }  → null for anything the student wrote himself
const META_RE = /^_(.+?)_\s*$/m
const DATE_RE = /(\d{4}-\d{2}-\d{2})/
const LINK_RE = /\[([^\]]+)\]\((https?:[^)\s]+)\)/

export function sourceOf(page) {
  if (!page) return null
  const fm = page.frontmatter || {}, tags = Array.isArray(fm.tags) ? fm.tags : []
  const path = String(page.path || '')
  const announcement = /\/Announcements\//.test(path) || fm.kind === 'announcement'
  const quercus = tags.includes('quercus')
  if (!announcement && !quercus) return null
  const md = (page.blocks || []).map(b => b.md).join('\n')
  const meta = META_RE.exec(md)?.[1] || ''
  const link = LINK_RE.exec(meta) || LINK_RE.exec(md)
  const date = DATE_RE.exec(meta)?.[1] || null
  // "From Quercus · Topics · 2026-09-09" — the first segment looks like a name to `[A-Z][a-z]+ [A-Z]`, and only the
  // *start* was excluded, so the header read "From From Quercus". Nobody is called Quercus (SPEC §20.31).
  const who = meta.split('·').map(s => s.trim()).find(s => /^[A-Z][a-z]+ [A-Z]/.test(s) && !/Quercus/i.test(s)) || null
  return {
    what: announcement ? 'Announcement' : 'Quercus page',
    who: who || (announcement ? 'your professor' : null),
    date, url: link && /^https?:/.test(link[2]) ? link[2] : null,
    kind: announcement ? 'announcement' : 'page',
  }
}

export default function SourceBanner({ page }) {
  const s = sourceOf(page)
  if (!s) return null
  const when = s.date ? new Date(s.date + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'long', day: 'numeric' }) : null
  return (
    <div className={'srcbar srcbar-' + s.kind}>
      <span className="srcbar-ic">{s.kind === 'announcement' ? <Icon.megaphone width="15" height="15" /> : <Icon.external width="15" height="15" />}</span>
      <span className="srcbar-text">
        <b>{s.what}</b>
        <span>Not your notes — {s.who ? `posted by ${s.who}` : 'from Quercus'}{when ? ` on ${when}` : ''}</span>
      </span>
      {s.url && <a className="btn small" href={s.url} target="_blank" rel="noopener">Open on Quercus<Icon.external width="12" height="12" /></a>}
    </div>
  )
}
