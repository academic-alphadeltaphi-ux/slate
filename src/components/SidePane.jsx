import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import Canvas from './Canvas.jsx'
import AskPanel from './AskPanel.jsx'
import { THIS as ED } from '../edition.js'
import { Icon } from './Icons.jsx'
import PageHeader, { placeOf } from './PageHeader.jsx'
import { kindIcon } from '../kinds.js'
import '../styles/sidepane.css'

// The right pane (SPEC §20.10): its own page, its own SSE subscription, status and bar, and a second Canvas
// whose keyboard handler is gated by `active`. App renders it next to the left pane while `split` is set; the
// page list keeps driving the left pane, this one is changed by ⌘K, the swap button, "Open to the right" or a
// wikilink clicked inside it. Rename, kind chip and history stay with the left pane and the page list.
// The Ask rail (SPEC §20.7) docks beside this pane's canvas while it is the active pane: App passes `askOpen`; `onAppend`
// defaults to this pane's own canvas so Save as note lands on the page the rail shows.
// props: { path, goTo, active, onActivate, onClose, onSwap, onOpen(path), onPrint(path), onCanvasRef(handle), onPage(page|null), askOpen, onAppend(md, opts), dark, adaptInk, highlights, onSetHighlights }
const STATUS = { saving: 'Saving…', saved: 'Saved', error: 'Save failed', conflict: 'Changed on disk', reloaded: 'Updated from disk', uploading: 'Uploading…', recognising: 'Recognising handwriting…', recognised: 'Handwriting recognised' }
export default function SidePane({ path, goTo = null, active, onActivate, onClose, onSwap, onOpen, onPrint, onCanvasRef, onPage, askOpen = false, onAppend, dark, adaptInk, highlights, onSetHighlights }) {
  const [page, setPage] = useState(null)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState('')
  const [external, setExternal] = useState(null)
  const fileInput = useRef(null)
  const pathRef = useRef(path); pathRef.current = path
  const cbs = useRef({}); cbs.current = { onCanvasRef, onPage, onOpen }
  useEffect(() => {
    let alive = true
    setPage(null); setErr(null); setStatus(''); setExternal(null)
    api.page(path).then(p => { if (!alive) return; setPage(p); cbs.current.onPage?.(p) }).catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false; cbs.current.onPage?.(null); cbs.current.onCanvasRef?.(null) }
  }, [path])
  // Disk changes to this page (Claude, Obsidian, a script) reach the Canvas as `external`, like the left pane.
  useEffect(() => api.events(ev => {
    if (ev.kind !== 'md' && ev.kind !== 'layout') return
    const p = ev.kind === 'md' ? ev.path : ev.path.replace(/\.blocks\.json$/, '.md')
    if (p === pathRef.current) setExternal(ev)
  }), [])
  useEffect(() => { if (status && status !== 'conflict') { const t = setTimeout(() => setStatus(''), 2500); return () => clearTimeout(t) } }, [status])
  // A stable callback ref: the handle goes to the bar's Add-files input and up to the shell (AskPanel, ⌘K targets).
  const canvasRef = useCallback(r => { cbs.current._canvas = r; cbs.current.onCanvasRef?.(r) }, [])
  // Wikilinks open in the pane they were clicked in: resolved like the shell does, same notebook first.
  const openTitle = async title => {
    const want = title.toLowerCase()
    const t = (await api.titles()).filter(x => (want.includes('/') ? ('/' + x.path.toLowerCase()).endsWith('/' + want + '.md') : x.title.toLowerCase() === want))
    const hit = t.find(x => x.notebook === pathRef.current.split('/')[0]) || t[0]
    if (hit) cbs.current.onOpen?.(hit.path); else setStatus('error')
  }
  const crumb = path.split('/')
  const kind = page?.frontmatter?.kind
  return (
    <section className={'pane pane-right' + (active ? ' active' : '')} onPointerDownCapture={onActivate}>
      <header className="topbar pane-bar">
        <span className="crumb">{crumb[0]} › {crumb[1]}{crumb.length > 3 ? ' › …' : ''}</span>
        {page && <h1 className="title pane-title" title={page.path}><span className="pl-icon title-icon">{(Icon[kindIcon(kind)] || Icon.file)({ width: 15, height: 15 })}</span>{page.title}</h1>}
        <span className="spacer" />
        <span className={'status ' + status}>{STATUS[status] || ''}</span>
        {page && <button className="icon-btn" title="Add files: PDFs, audio, video, images, anything" onClick={() => fileInput.current?.click()}><Icon.plus /></button>}
        <input ref={fileInput} type="file" multiple hidden onChange={e => { const fs = [...e.target.files]; e.target.value = ''; cbs.current._canvas?.addFiles?.(fs) }} />
        {page && <button className="icon-btn" title="Print or save as PDF" onClick={() => onPrint(path)}><Icon.print /></button>}
        <button className="icon-btn" title="Swap the two panes" onClick={onSwap}><Icon.swap /></button>
        <button className="icon-btn" title="Close this pane" onClick={onClose}><Icon.x /></button>
      </header>
      {page && <PageHeader page={page} />}
      <div className="ask-dock">
        {page
          ? <Canvas key={path} ref={canvasRef} className={placeOf(path).isNotes ? '' : 'doc'} page={page} active={active} goTo={goTo} external={external} onStatus={setStatus} onOpenTitle={openTitle} dark={dark} adaptInk={adaptInk} highlights={highlights} onSetHighlights={onSetHighlights} />
          : <div className="canvas empty-canvas"><div className="empty big">{err ? `Could not open this page: ${err}` : 'Loading…'}</div></div>}
        {ED.ask && askOpen && page && <AskPanel page={page} onAppend={onAppend || ((md, o) => cbs.current._canvas?.appendBlock?.(md, o))}
          onReadInk={() => cbs.current._canvas?.recogniseInk?.()} />}
      </div>
    </section>
  )
}
