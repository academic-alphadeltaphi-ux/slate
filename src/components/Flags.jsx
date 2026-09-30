import { Icon } from './Icons.jsx'

// One word beside a task, the same word on every screen that draws one (SPEC §20.63). They were grey pills that all read
// alike — "required", "important", "missed" in the same tint — so none of them registered. Each meaning has a fixed
// colour and a small icon now: missed is a filled oxblood clock, crucial an oxblood outline with a warning, important a
// gilt star, graded the ink-filled cap from the icon, required an ink outline with a tick, optional a dashed grey,
// not-open a grey lock. The order on a row is what is late, then how crucial, then what it is for the mark.
const FLAGS = {
  missed: { icon: 'clock', label: 'Missed', why: 'its day has passed and it is not ticked' },
  crucial: { icon: 'alert', label: 'Crucial', why: 'marked, or wanted within a day' },
  important: { icon: 'star', label: 'Important', why: 'marked, or wanted within three days' },
  graded: { icon: 'cap', label: 'Graded', why: 'a mark depends on it' },
  required: { icon: 'check', label: 'Required', why: 'the course asks for it, but does not mark it' },
  optional: { icon: 'minus', label: 'Optional', why: 'you may skip it' },
  locked: { icon: 'lock', label: 'Not open yet', why: 'it appears here when it opens' },
  // a week he flagged (SPEC §21.13): gilt like important, but an outline — it is his reminder, not the course's weight
  review: { icon: 'bookmark', label: 'For review', why: 'you flagged this week; it shows on the tests that cover it' },
}
export function Flag({ kind, text = null, why = null, small = false }) {
  const f = FLAGS[kind]
  if (!f) return null
  const I = Icon[f.icon] || Icon.dot
  const s = small ? 10 : 11
  return <span className={'flag flag-' + kind + (small ? ' small' : '')} title={why || f.why}><I width={s} height={s} strokeWidth="2.4" />{text || f.label}</span>
}
// The flags a row wears. `importantToo` is off on a screen that already says the row is for the next class; `nature` is
// true, false, or 'graded' for a line with room for the one that changes what you do.
export function rowFlags(r, { late = true, priority = true, nature = true, importantToo = true } = {}) {
  if (!r) return []
  const out = []
  if (late && r.overdue && !r.done) out.push({ kind: 'missed', why: FLAGS.missed.why })
  if (priority && !r.done) {
    const l = r.priority?.level
    if (l === 'crucial') out.push({ kind: 'crucial', why: r.priority.why })
    else if (l === 'important' && importantToo) out.push({ kind: 'important', why: r.priority.why })
  }
  if (nature && r.nature === 'graded') out.push({ kind: 'graded', text: r.points ? `Graded · ${r.points} pts` : 'Graded' })
  else if (nature === true && r.nature === 'required') out.push({ kind: 'required' })
  else if (nature === true && (r.nature === 'optional' || r.optional)) out.push({ kind: 'optional' })
  if (r.notOpen) out.push({ kind: 'locked' })
  return out
}
export function Flags({ r, small = false, ...opts }) {
  const fs = rowFlags(r, opts)
  return fs.length ? <>{fs.map((f, i) => <Flag key={f.kind + i} {...f} small={small} />)}</> : null
}
