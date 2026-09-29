import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { THIS as ED } from '../../edition.js'
import { Icon } from '../Icons.jsx'
import { daysTo, relDay, shortIso, weekdayOf, flipTask, findPlanBlock, coverageLine } from '../../plan.js'
import '../../styles/plan.css'

// The pieces Home, What's next and the course screen share (SPEC §20.3): one copy of Hub/_plan.json per tab (usePlan),
// the tickable task list, the test card with its three coverage counts, and the one-line course summary. Dates are
// formatted through src/calendar.js (shortIso), never `short(string)`.

// ---- one shared copy of GET /api/plan ---------------------------------------------------------------------------------
const store = { plan: null, error: null, fresh: false, busy: false, promise: null, subs: new Set(), unsub: null, timer: null }
const emit = () => { const s = { plan: store.plan, error: store.error, fresh: store.fresh, busy: store.busy }; for (const f of [...store.subs]) f(s) }
// Load (or refresh: the server recomputes ticks and counts from disk first, writing nothing). Concurrent calls share one request.
export function loadPlan(refresh = false) {
  if (store.promise) return store.promise
  store.busy = true; emit()
  // A plan that has not been built yet is a 404, and it is where every install starts — not a failure. Passing the
  // server's own sentence through to the screen ("no plan yet: press Refresh on What's next or run node
  // scripts/plan.mjs --pages") named a screen that no longer exists and asked a non-technical person for a shell
  // command. `fresh` separates the two so the screen can say the true thing (SPEC §20.48).
  store.promise = api.plan(refresh).then(p => { store.plan = p; store.error = p?.note || null; store.fresh = false })
    .catch(e => { store.fresh = e.status === 404; store.error = e.status === 404 ? null : e.message; if (e.status === 404) store.plan = null })
    .finally(() => { store.promise = null; store.busy = false; emit() })
  return store.promise
}
// The explicit rebuild (Refresh): plan.mjs --pages writes the Plan pages, then the file is reloaded.
export async function rebuildPlan() {
  store.busy = true; emit()
  try { const r = await api.planRebuild(); if (r?.running && !r?.ok) return r; return r }
  catch (e) { store.error = e.message; return { ok: false, error: e.message } }
  finally { store.busy = false; await loadPlan(false) }
}
const schedule = refresh => { clearTimeout(store.timer); store.timer = setTimeout(() => loadPlan(refresh), 700) }
function subscribe(f) {
  store.subs.add(f)
  if (!store.unsub) store.unsub = api.events(ev => { if (ev.path === 'Hub/_plan.json') schedule(false); else if (ev.kind === 'md' && /\/Plan\.md$/.test(ev.path || '')) schedule(true) })
  return () => { store.subs.delete(f); if (!store.subs.size && store.unsub) { store.unsub(); store.unsub = null } }
}
// usePlan({ refresh }) → { plan, error, fresh, busy, refresh(), rebuild(), patch(fn) }. With refresh: true the mount recomputes
// ticks first, so a box ticked on a Plan page is already reflected when the screen comes back.
export function usePlan({ refresh = false } = {}) {
  const [s, setS] = useState({ plan: store.plan, error: store.error, fresh: store.fresh, busy: store.busy })
  useEffect(() => { const un = subscribe(setS); loadPlan(refresh); return un }, [])
  return { plan: s.plan, error: s.error, fresh: s.fresh, busy: s.busy, refresh: () => loadPlan(true), rebuild: rebuildPlan, patch: fn => { store.plan = fn(store.plan); emit() } }
}

// ---- helpers --------------------------------------------------------------------------------------------------------
export const todayIso = () => new Date().toLocaleDateString('en-CA')
export const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
export const courseColor = (plan, key) => plan?.meetings?.find(m => m.courseKey === key)?.color || plan?.tests?.find(t => t.courseKey === key)?.color || null
// The next non-cancelled meeting of a course (or any course) whose end is still ahead.
export const nextMeetingOf = (plan, key, today = todayIso(), now = nowHM()) => (plan?.meetings || []).find(m => (!key || m.courseKey === key) && !m.cancelled && `${m.date}T${m.announced?.end || m.end}` >= `${today}T${now}`) || null
export const fmtStamp = iso => (iso ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const basename = p => String(p || '').split('/').pop().replace(/\.md$/, '')
// Tick a task from the timeline: flip the `- [ ]` in the page's `## Before class` container through PUT /api/page with
// the base hash, one retry on a stale hash. Returns true when the page changed. `to` (true|false) sets the box instead of
// flipping it — true, with nothing written, when it already stands so.
export async function toggleTask(m, task, to = null) {
  if (!m?.planPage || task?.pending) return false
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await api.page(m.planPage)
    const bi = findPlanBlock(p.blocks, m.planBlock)
    if (bi < 0) return false
    const md = flipTask(p.blocks[bi].md, task.key, to)
    if (!md) return false
    if (md === p.blocks[bi].md) return true
    try { await api.savePage(m.planPage, p.blocks.map((b, j) => (j === bi ? { id: b.id, md } : { id: b.id, md: b.md })), p.hash); return true }
    catch (e) { if (e.status !== 409) throw e }
  }
  return false
}

// PlanButton and TaskList went with the last link to a Plan page (SPEC §20.25): nothing imported them, and both
// existed only to open the file the ticks are stored in.
// The timetable draws its own blocks (Timetable.jsx); the old MeetingRow / DueRow / TestRow / CalRow list rows
// went with the vertical timeline they were written for (SPEC §20.13).

// ---- coverage: three counts, no percentage (SPEC §20.3) ---------------------------------------------------------------
export function CoverageBars({ test, compact = false }) {
  const c = test?.coverage; if (!c) return null
  // A signal with nothing in it gets no bar. An empty track next to a dash reads as broken, not as "none yet".
  const Bar = ({ k, v, title }) => (!v?.total ? null : <div className="cov-row" title={title}><span className="cov-k">{k}</span><span className="cov-bar"><i style={{ width: `${Math.round((100 * v.done) / v.total)}%` }} /></span><span className="cov-v">{v.done}/{v.total}</span></div>)
  // The study-sheet bar counts weeks with material that have a sheet. In an edition that builds none, `total` is still
  // every week with material while `done` is permanently 0 — a readiness meter pinned at zero that can never move, on
  // every test, for ever. It is not a bar with nothing in it; it is a bar that lies. It does not exist here, and it
  // does not count towards whether there is anything to measure (SPEC §20.48).
  const sheets = ED.sheets ? c.sheets : null
  const none = !(sheets?.total || c.problems?.total || c.tasks?.total)
  return (
    <div className={'cov' + (compact ? ' compact' : '')}>
      <div className="cov-head">How ready you are{test.window ? <small> · {test.window.label}{test.window.assumed ? ' (assumed)' : ''} · {c.elapsedWeeks} of {c.totalWeeks} weeks elapsed</small> : null}</div>
      {none ? <div className="cov-none muted">nothing to measure yet</div> : <>
        <Bar k="study sheets" v={sheets} title="Weeks with material that have a study sheet" />
        <Bar k="problems" v={c.problems} title="Problems attempted over assigned in the window" />
        <Bar k="things to do" v={c.tasks} title="Tasks ticked over total in the window" />
      </>}
    </div>
  )
}
export function TestCard({ test, today = todayIso(), onClick }) {
  if (!test) return null
  const n = daysTo(test.date, today)
  return (
    <button className="wn-test" style={{ '--c': test.color }} onClick={onClick} title={`${test.course} · ${test.title} · ${weekdayOf(test.date)} ${shortIso(test.date)} — open the course`}>
      <div className="course-code">{test.course}</div>
      <div className="wn-test-title">{test.title} · {weekdayOf(test.date)} {shortIso(test.date)}</div>
      <div className="wn-count">{n}<small>{n === 1 ? 'day' : 'days'}</small></div>
      <CoverageBars test={test} />
    </button>
  )
}
// Home's one line under a course card: `Midterm 1 · in 34 days · sheets 1/1 · problems 0/4` (`no signals yet` before anything).
export function CourseLine({ plan, courseKey, today = todayIso() }) {
  const t = plan?.tests?.find(x => x.courseKey === courseKey)
  const line = coverageLine(t, today)
  return line ? <div className="course-test">{line}</div> : null
}
export { relDay, shortIso, weekdayOf, daysTo, basename }
