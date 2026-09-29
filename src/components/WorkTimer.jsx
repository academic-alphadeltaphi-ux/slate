import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { toggleTask } from './plan/PlanBits.jsx'
import { toggleMyTask } from './MyTasks.jsx'
import '../styles/work.css'

// The timer (SPEC §22): a pill over every screen while something is being worked on — the clock, the thing, pause,
// resume, stop. Stop asks *Done?*; Done ticks the task where it lives and writes the session to the work log, Not yet
// writes the session only. The session lives on the server (Hub/_work-log.json → running), so a reload, another
// screen or a restart of the app does not lose it.
const two = n => String(n).padStart(2, '0')
const activeSeconds = (r, now = Date.now()) => (r?.segments || []).reduce((n, g) => n + Math.max(0, ((g.to ? new Date(g.to).getTime() : now) - new Date(g.from).getTime()) / 1000), 0)

export default function WorkTimer() {
  const [run, setRun] = useState(null)
  const [, setTick] = useState(0)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = () => api.workStatus().then(s => setRun(s.running || null)).catch(() => { })
  useEffect(() => { load(); const h = () => load(); window.addEventListener('slate:work', h); const t = setInterval(load, 30000); return () => { window.removeEventListener('slate:work', h); clearInterval(t) } }, [])
  useEffect(() => { if (!run || run.paused) return; const t = setInterval(() => setTick(x => x + 1), 1000); return () => clearInterval(t) }, [run?.id, run?.paused])
  if (!run) return null
  const s = Math.round(activeSeconds(run)), mm = Math.floor(s / 60), ss = s % 60
  const clock = mm >= 60 ? `${Math.floor(mm / 60)}:${two(mm % 60)}:${two(ss)}` : `${two(mm)}:${two(ss)}`
  const op = async body => { setBusy(true); try { const r = await api.work(body); setRun(r.running || null); return r } catch { return null } finally { setBusy(false) } }
  const stop = async done => {
    const r = await op({ op: 'stop', done })
    if (r && done && run.tick) {
      // Set, never flipped: he may have ticked it while the clock ran (a row's tick stays live during a run).
      try { if (run.tick.raw) await toggleMyTask(run.tick.raw, true); else if (run.tick.meeting) await toggleTask(run.tick.meeting, run.tick.task, true) } catch { }
      window.dispatchEvent(new Event('slate:plan'))
    }
    setAsking(false); window.dispatchEvent(new Event('slate:work'))
  }
  return (
    <div className={'wt' + (run.paused ? ' paused' : '')} role="status" aria-live="polite">
      <span className="wt-clock" title={run.startedAt ? `Started ${String(run.startedAt).slice(11, 16)}` : undefined}>{clock}</span>
      <span className="wt-what"><b>{run.title}</b><small>{[run.course, run.planned ? `planned ${run.planned} min` : null, run.paused ? 'paused' : null].filter(Boolean).join(' · ')}</small></span>
      {run.paused
        ? <button className="btn small" disabled={busy} onClick={() => op({ op: 'resume' })}>Resume</button>
        : <button className="btn small" disabled={busy} onClick={() => op({ op: 'pause' })}>Pause</button>}
      {asking
        ? <span className="wt-ask"><span>Done?</span>
          <button className="btn small primary" disabled={busy} onClick={() => stop(true)}>Done</button>
          <button className="btn small" disabled={busy} onClick={() => stop(false)}>Not yet</button>
          <button className="icon-btn" title="Keep going" onClick={() => setAsking(false)}><Icon.x width="12" height="12" /></button></span>
        : <button className="btn small" disabled={busy} onClick={() => setAsking(true)}>Stop</button>}
    </div>)
}
