import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useDialog } from './Dialog.jsx'
import ContextMenu from './ContextMenu.jsx'
import { summarizeBlocks, solutionHeading, labelText } from '../problems.js'
import { THIS as ED } from '../edition.js'
import '../styles/problems.css'

// The kind chip of a Problems page (SPEC §20.2): `Problem set · 1/4 attempted · 1 reviewed`, computed from the page's
// own blocks with src/problems.js, refreshed after every save (own saves are not on SSE: the shell's `status` is the
// signal) and on an external change to the file. Click → a small menu: Write the solution… (the chooser hands the
// row to Ask the page's `solution` preset), Refresh from announcements (POST /api/problems/refresh), Kind and tags…
// (the usual popover). No pill, no bar: the page wears no chrome beyond this chip.
// props: { page, onMeta(e), status? }
import { openAsk } from '../ask.js'   // openAsk({ page, preset, block, problem, question }) (SPEC §20.7)

// ---- one shared copy of GET /api/problems for the page-list meta, the course screen, anything that wants counts ----
const store = { data: null, promise: null, subs: new Set(), unsub: null, timer: null }
export function refetchProblems() {
  store.promise = api.problems().then(d => { store.data = d; store.promise = null; for (const f of [...store.subs]) f(d); return d }).catch(() => { store.promise = null; return store.data })
  return store.promise
}
function subscribe(f) {
  store.subs.add(f)
  if (!store.unsub) store.unsub = api.events(ev => { if ((ev.kind === 'md' && /\/Problems\.md$/.test(ev.path)) || ev.path === 'Hub/_problems.json') { clearTimeout(store.timer); store.timer = setTimeout(refetchProblems, 800) } })
  if (!store.data && !store.promise) refetchProblems()
  return () => { store.subs.delete(f); if (!store.subs.size && store.unsub) { store.unsub(); store.unsub = null } }
}
// The live _problems.json object (null until the first answer). Re-renders when a Problems page or the file changes on disk.
export function useProblemsSummary() {
  const [d, setD] = useState(store.data)
  useEffect(() => subscribe(setD), [])
  return d
}
export const weekEntryFor = (summary, path) => { for (const c of Object.values(summary?.courses || {})) { const w = c.weeks.find(x => x.page === path); if (w) return w } return null }

// The page list's hover meta on a problem-set row: `1/4 · 1 rev`.
export function ProblemsMeta({ path }) {
  const s = useProblemsSummary()
  const w = weekEntryFor(s, path)
  if (!w || !w.counts.assigned) return null
  const c = w.counts
  return <span className="meta hover-only pl-problems" title={`${c.attempted} of ${c.assigned} attempted · ${c.reviewed} reviewed${c.solved ? ` · ${c.solved} solved` : ''}`}>{c.attempted}/{c.assigned}{c.reviewed ? ` · ${c.reviewed} rev` : ''}</span>
}

const wikiTitle = src => { const m = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(String(src || '').trim()); return m ? m[1].trim() : null }

export default function ProblemsChip({ page, onMeta, status }) {
  const dialog = useDialog()
  const [sum, setSum] = useState(() => summarizeBlocks(page.blocks))
  const [menu, setMenu] = useState(null)
  const [busy, setBusy] = useState(false)
  const pathRef = useRef(page.path); pathRef.current = page.path
  useEffect(() => { setSum(summarizeBlocks(page.blocks)) }, [page])
  const reload = () => api.page(pathRef.current).then(p => { if (p.path === pathRef.current) setSum(summarizeBlocks(p.blocks)); refetchProblems() }).catch(() => { })
  useEffect(() => { if (status === 'saved' || status === 'reloaded') reload() }, [status])
  useEffect(() => api.events(ev => { if (ev.kind === 'md' && ev.path === pathRef.current) reload() }), [])

  const c = sum.counts
  const text = c.assigned ? `Problem set · ${c.attempted}/${c.assigned} attempted${c.reviewed ? ` · ${c.reviewed} reviewed` : ''}${c.solved ? ` · ${c.solved} solved` : ''}` : 'Problem set · nothing listed yet'

  const write = async () => {
    const rows = sum.rows
    if (!rows.length) return dialog.alert({ title: 'Nothing to solve yet', message: 'This page has no rows under “## Problems”. The morning pass adds them from the announcements, the course outline and the topic pages.' })
    const key = await dialog.choose({ title: 'Write the solution under my attempt', message: 'Ask the page writes it as a new container at the end of this page, starting “### Solution · …”, which is what marks the row solved.',
      options: rows.map(r => ({ value: r.key, label: labelText(r.label), hint: r.solved ? 'solved' : r.attempted ? 'attempted' : 'not attempted yet', recommended: r.attempted && !r.solved })) })
    if (!key) return
    const r = rows.find(x => x.key === key); if (!r) return
    const known = weekEntryFor(store.data, page.path)?.rows.find(x => x.key === key)?.source || null
    const request = { page: page.path, preset: 'solution', block: sum.blockId, problem: { key: r.key, label: labelText(r.label), source: known || { kind: null, page: null, title: wikiTitle(r.src) }, heading: solutionHeading(r.label) } }
    if (typeof openAsk !== 'function') return dialog.alert({ title: 'Ask the page is not here yet', message: 'The solution button hands this problem to Ask the page (⌘J). Once that feature is installed, the solution lands at the end of this page as its own container.' })
    await openAsk(request)
  }
  const refresh = async () => {
    setBusy(true)
    try {
      const r = await api.problemsRefresh()
      if (r?.running && !r?.ok) await dialog.alert({ title: 'Already refreshing', message: 'A refresh is running; the page updates when it finishes.' })
      else await reload()
    } catch (e) { await dialog.alert({ title: 'Refresh failed', message: e.message }) }
    finally { setBusy(false) }
  }
  const open = e => {
    const at = { x: e.clientX, y: e.clientY + 12 }
    setMenu({ at, items: [
      ...(ED.ask ? [{ label: 'Write the solution…', onClick: write }] : []),
      { label: busy ? 'Refreshing…' : 'Refresh from announcements', onClick: () => { if (!busy) refresh() } },
      '-',
      { label: 'Kind and tags…', onClick: () => onMeta?.({ clientX: at.x, clientY: at.y - 12 }) },
    ] })
  }
  return (<>
    <button className={'chip problems-chip' + (busy ? ' busy' : '')} title="Problems on this page: attempted, reviewed, solved. Click for the solution and refresh actions." onClick={open}>{text}</button>
    {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
  </>)
}
