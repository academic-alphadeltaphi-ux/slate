import { useState } from 'react'
import { Icon } from './Icons.jsx'

// One disclosure per screen (SPEC §20.14). Everything a screen can show but rarely needs — diagnostics, settings,
// reference lists — lives behind this, so the default view is short and the answer to "where do I click" is
// "the thing in front of you". Closed by default; the state is per screen, not persisted, because the point is
// that opening it is a deliberate act.
export default function More({ label = 'More', children, count = 0 }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'more' + (open ? ' open' : '')}>
      <button className="more-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Icon.chevron width="13" height="13" />
        <span>{label}</span>
        {count > 0 && !open && <span className="pill">{count}</span>}
      </button>
      {open && <div className="more-body">{children}</div>}
    </div>
  )
}
