import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import '../styles/export.css'

// The export dialog (SPEC §20.10): the dry run's counts, the skip-empty choice, live progress while the job
// prints and merges, then the result with Open / Reveal in Finder and the pages that could not be printed.
// Opened from the sidebar's section and notebook menus and the ··· page menu (App: actions.exportPdf).
// Closing it never stops the export; reopening it shows the job that is running.
// props: { target: { path: 'ECO 208Y1/Fall 2026', name: 'Fall 2026', kind: 'section' | 'notebook' }, onClose }
const fmtMB = b => (b / 1e6).toFixed(1) + ' MB'
const n = (k, s) => `${k} ${s}${k === 1 ? '' : 's'}`
const crumbOf = p => p.replace(/\.md$/, '').split('/').slice(2).join(' › ')
export default function ExportDialog({ target, onClose }) {
  const [plan, setPlan] = useState(null)        // the dry run
  const [skipEmpty, setSkipEmpty] = useState(true)
  const [job, setJob] = useState(null)          // /api/export/status while one runs or just ran
  const [err, setErr] = useState(null)
  const [t, setT] = useState(0)
  const poll = useRef(null)
  useEffect(() => {
    setPlan(null); setErr(null)
    api.exportStatus().then(s => { if (s.running) setJob(s) }).catch(() => { })
    api.exportStart({ path: target.path, dryRun: true }).then(setPlan).catch(e => setErr(e.message))
  }, [target.path])
  useEffect(() => {
    if (!job?.running) return
    const tick = async () => { try { const s = await api.exportStatus(); setJob(s); setT(Math.max(0, Math.round((Date.now() - new Date(s.startedAt)) / 1000))) } catch { } }
    tick(); poll.current = setInterval(tick, 1000)
    return () => clearInterval(poll.current)
  }, [job?.running])
  useEffect(() => { const h = e => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const start = async () => {
    setErr(null)
    try { const r = await api.exportStart({ path: target.path, skipEmpty }); if (r.started) setJob(await api.exportStatus()); else setErr('Another export is already running.') }
    catch (e) { setErr(e.message) }
  }
  const empties = plan ? plan.pages.filter(p => p.empty && !p.virtual).length : 0
  const virtuals = plan ? plan.pages.filter(p => p.virtual).length : 0
  const withContent = plan ? plan.pages.filter(p => !p.empty && !p.virtual).length : 0
  const printable = plan ? (skipEmpty ? withContent : withContent + empties) : 0
  const pct = job?.total ? Math.round((job.done / job.total) * 100) : 0
  const title = job ? (job.running ? `Exporting ${job.name}` : job.ok ? 'Export finished' : job.cancelled ? 'Export cancelled' : 'Export failed') : `Export ${target.name} to one PDF`
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog export-dialog" role="dialog" onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') onClose(); e.stopPropagation() }}>
        <div className="dialog-title">{title}</div>
        {!job && plan && <>
          <div className="dialog-msg">
            <strong className="exp-count">{n(plan.total, 'page')} · {withContent} with content</strong>
            {virtuals > 0 && <> · {virtuals} without a file</>}. Every page prints as ⌘P would — printouts rendered, ink included — on Letter paper, in list order, with a bookmark per page.
          </div>
          {empties > 0 && <label className="exp-check"><input type="checkbox" checked={skipEmpty} onChange={e => setSkipEmpty(e.target.checked)} /> Skip the {n(empties, 'empty page')}</label>}
          <div className="exp-summary">{printable === 0 ? 'Nothing to print.' : <>{n(printable, 'page')} will print · about {Math.max(5, printable * 3)} s · saved in <span className="exp-path">{target.path.split('/')[0]}/_exports/</span></>}</div>
        </>}
        {!job && !plan && !err && <div className="dialog-msg">Counting pages…</div>}
        {job?.running && <>
          <div className="exp-bar" aria-hidden="true"><span style={{ width: `${job.phase === 'print' ? pct : 100}%` }} /></div>
          <div className="exp-progress">
            {job.phase === 'print'
              ? <>Printing {Math.min(job.done + 1, job.total)} of {job.total}{job.current && <> · <span className="exp-current">{crumbOf(job.current.path) || job.current.title}</span></>}</>
              : job.phase === 'merge' ? 'Merging into one PDF…' : 'Saving…'}
            <span className="exp-time"> · {t} s</span>
          </div>
          <div className="exp-hint">Closing this window does not stop the export.</div>
        </>}
        {job && !job.running && job.ok && job.out && <div className="exp-result">
          <strong>{job.out.rel.split('/').pop()}</strong>
          <div className="exp-sub">{n(job.out.pages, 'page')} · {fmtMB(job.out.bytes)} · in {job.out.rel.split('/').slice(0, -1).join('/')}</div>
          {job.note && <div className="exp-note">{job.note}</div>}
        </div>}
        {job && !job.running && !job.ok && <div className="exp-note danger">{job.note || 'The export did not finish.'}</div>}
        {job?.failed?.length > 0 && !job.running && <ul className="exp-failed">{job.failed.map(f => <li key={f.path}><span>{f.title}</span><small>{f.error}</small></li>)}</ul>}
        {err && <div className="exp-note danger">{err}</div>}
        <div className="dialog-actions">
          {!job && <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!plan || printable === 0} onClick={start}>Start</button></>}
          {job?.running && <><button className="btn" onClick={() => api.exportCancel().catch(() => { })}>Cancel export</button><button className="btn primary" onClick={onClose}>Close</button></>}
          {job && !job.running && <>
            {job.ok && job.out && <><button className="btn" onClick={() => api.reveal(job.out.rel).catch(() => { })}>Reveal in Finder</button><button className="btn" onClick={() => api.exportOpen(job.out.rel).catch(e => setErr(e.message))}>Open</button></>}
            {!job.ok && plan && <button className="btn" onClick={() => setJob(null)}>Try again</button>}
            <button className="btn primary" onClick={onClose}>Done</button>
          </>}
        </div>
      </div>
    </div>
  )
}
