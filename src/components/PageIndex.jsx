import { useState } from 'react'
import { Icon } from './Icons.jsx'
import { kindIcon } from '../kinds.js'
import '../styles/index.css'

// A page that holds other pages opens as an index of them, not as a blank sheet (SPEC §20.16).
// `Announcements`, a section's own page, any page with subpages: the real thing is always a child. The container's own
// text still shows when it has any. There is no way to write on it from here (SPEC §20.33): "Write on this page too"
// invited notes into a page nobody opens again, and the student asked for it gone. Notes are written on a week's notes sheet.
// props: { page, children:[pageRow], onOpen(path) }
const I = (n, p = { width: 16, height: 16 }) => (Icon[n] || Icon.file)(p)
const when = ms => (ms ? new Date(ms).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '')

export default function PageIndex({ page, children, onOpen }) {
  const [showAll, setShowAll] = useState(false)
  const list = showAll ? children : children.slice(0, 24)
  const own = page.blocks.map(b => b.md).join('\n').replace(/^#\s+.*$/m, '').trim()
  return (
    <div className="canvas pidx-canvas">
      <div className="pidx">
        <header className="pidx-head">
          <span className="pidx-icon">{I(kindIcon(page.frontmatter?.kind) || 'file', { width: 20, height: 20 })}</span>
          <div>
            <h1>{page.title}</h1>
            <p>{children.length} {children.length === 1 ? 'page' : 'pages'} inside</p>
          </div>
        </header>

        {children.length === 0
          ? <p className="pidx-blank">Nothing filed here yet.</p>
          : <div className="pidx-grid">
              {list.map(c => (
                <button key={c.path} className="pidx-card" onClick={() => onOpen(c.path)}>
                  <span className="pidx-card-ic">{I(kindIcon(c.kind) || 'file')}</span>
                  <span className="pidx-card-title">{c.title}</span>
                  <span className="pidx-card-meta">
                    {c.children.length > 0 && <span className="pill">{c.children.length} inside</span>}
                    {c.virtual ? <span className="pill">folder</span> : <span>{when(c.modified)}</span>}
                  </span>
                </button>))}
            </div>}
        {children.length > list.length && <button className="link pidx-more" onClick={() => setShowAll(true)}>Show all {children.length}</button>}

        {own && <section className="pidx-own"><h2>On this page</h2><div className="pidx-own-body">{own.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div></section>}
      </div>
    </div>
  )
}
