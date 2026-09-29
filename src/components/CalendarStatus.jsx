import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import '../styles/calendar.css'

// One line in the What's Next head (SPEC §20.8): how the last push to Google Calendar went and what the readback
// holds, from GET /api/calendar, refreshed the moment the morning pass rewrites Hub/_calendar.json or
// Hub/_calendar-state.json (the watcher broadcasts them as kind 'other').
const TZ = 'America/Toronto'
const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-CA', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }) }
export function statusOf(c) {
  if (!c) return { cls: 'muted', text: 'Calendar unavailable.' }
  const s = c.sync
  if (!s) return { cls: 'muted', text: 'Not synced yet — the 07:10 pass pushes tests, deadlines and tutorials to Google Calendar.' }
  if (!s.ok) return { cls: 'danger', text: `Last calendar sync failed${s.at ? ' ' + when(s.at) : ''}: ${s.note || (s.failed || []).map(f => `${f.op} ${f.tag}`).join(', ') || 'unknown error'}` }
  const mine = (c.events || []).filter(e => !e.slate).length
  const bits = [`Synced ${when(s.at)}`]
  if (s.created) bits.push(`${s.created} added`)
  if (s.updated) bits.push(`${s.updated} updated`)
  if (s.deleted) bits.push(`${s.deleted} removed`)
  if (s.capped) bits.push('more tomorrow')
  bits.push(`${c.tracked ?? 0} on Google Calendar`)
  if (mine) bits.push(`${mine} of yours in the next 7 days`)
  return { cls: 'muted', text: bits.join(' · ') }
}
export default function CalendarStatus({ onOpen }) {
  const [cal, setCal] = useState(null)
  const load = () => api.calendar().then(setCal).catch(() => setCal(null))
  useEffect(() => { load() }, [])
  useEffect(() => api.events(ev => { if (/^Hub\/_calendar(-state)?\.json$/.test(ev.path || '')) load() }), [])
  const s = statusOf(cal)
  return (
    <div className={'cal-status ' + s.cls}>
      <span className="cal-status-ic"><Icon.calendar width="13" height="13" /></span>
      <span className="cal-status-text">{s.text}</span>
      {onOpen && <button className="link" onClick={() => onOpen('Hub/Today/Calendar.md')}>page</button>}
      <a className="link cal-ext" href="https://calendar.google.com" target="_blank" rel="noopener">Google Calendar<Icon.external width="11" height="11" /></a>
    </div>
  )
}
