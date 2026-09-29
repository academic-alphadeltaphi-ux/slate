// A PDF rendered as a stack of pages on the canvas, with a selectable text layer, highlight and
// underline annotations, and click-to-note. Annotations are sidecar elements with parent = this
// element; each carries the quoted text so Claude can read them, and Claude can create one with
// only `text`: the app finds the passage and fills in `page` and `rects`. SPEC.md §5.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createPortal } from 'react-dom'
import ContextMenu from './ContextMenu.jsx'
import { Icon } from './Icons.jsx'
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export const HL_COLORS = ['#ffd60a', '#34c759', '#ff9f0a', '#ff375f', '#5ac8fa', '#bf5af2']
const PAGE_GAP = 12
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
const round1 = n => Math.round(n * 10) / 10

// Merge per-glyph client rects into one rect per line, in page units.
function rectsFromRange(range, p) {
  const pageDiv = p.div, pr = pageDiv.getBoundingClientRect()
  const scale = pr.width / p.pageW   // rendered px per PDF point, whatever the canvas zoom is
  const raw = [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5)
    .map(r => ({ x: (r.left - pr.left) / scale, y: (r.top - pr.top) / scale, w: r.width / scale, h: r.height / scale }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  for (const r of raw) {
    const L = lines[lines.length - 1]
    if (L && Math.abs(r.y - L.y) < Math.max(r.h, L.h) * 0.5) { const right = Math.max(L.x + L.w, r.x + r.w); L.x = Math.min(L.x, r.x); L.w = right - L.x; L.y = Math.min(L.y, r.y); L.h = Math.max(L.h, r.h) }
    else lines.push({ ...r })
  }
  return lines.map(r => ({ x: round1(r.x), y: round1(r.y), w: round1(r.w), h: round1(r.h) }))
}

// Locate a quoted passage in a rendered page's text layer. Returns rects or null.
function findQuote(p, quote) {
  const tl = p.textLayer; if (!tl) return null
  const divs = tl.textDivs, strs = tl.textContentItemsStr
  let text = '', map = []
  for (let i = 0; i < strs.length; i++) {
    for (let j = 0; j < strs[i].length; j++) { text += strs[i][j]; map.push([i, j]) }
    if (p.items?.[i]?.hasEOL) { text += ' '; map.push([i, strs[i].length - 1]) }
  }
  const build = keepSpaces => {
    let out = '', omap = []
    for (let k = 0; k < text.length; k++) {
      const c = text[k].toLowerCase(), ws = /\s/.test(c)
      if (ws) { if (!keepSpaces || out.endsWith(' ') || !out) continue; out += ' '; omap.push(map[k]); continue }
      out += c; omap.push(map[k])
    }
    return { out, omap }
  }
  const q = norm(quote); if (!q) return null
  let hit = null
  for (const keep of [true, false]) {
    const needle = keep ? q : q.replace(/ /g, '')
    const { out, omap } = build(keep)
    const at = out.indexOf(needle)
    if (at >= 0) { hit = { start: omap[at], end: omap[at + needle.length - 1] }; break }
  }
  if (!hit) return null
  const sn = divs[hit.start[0]]?.firstChild, en = divs[hit.end[0]]?.firstChild
  if (!sn || !en) return null
  const range = document.createRange()
  range.setStart(sn, Math.min(hit.start[1], sn.length)); range.setEnd(en, Math.min(hit.end[1] + 1, en.length))
  return rectsFromRange(range, p)
}

// `locate` ({ page, text, nonce } | null) is a search hit (SPEC §20.6): once that page's text layer has drawn, the phrase
// is flashed on it like a highlight for ~2 s. findQuote lowercases but does not fold accents; when it misses, the
// page-level locate box the canvas draws is all you get, by design.
export default function PdfEl({ el, url, width, annotations = [], scrollRoot, palette = [], onSetPalette, onAnnotate, onAnnotationResolved, onRemoveAnnotation, onNoteAt, eager = false, onReady, locate = null }) {
  const colors = palette.length ? palette : HL_COLORS.map(c => ({ color: c, label: '' }))
  const [editPalette, setEditPalette] = useState(null)
  const [doc, setDoc] = useState(null)
  const [pageSizes, setPageSizes] = useState([])
  const [error, setError] = useState(null)
  const [settledWidth, setSettledWidth] = useState(width)
  const [selBar, setSelBar] = useState(null)
  const [menu, setMenu] = useState(null)
  const rootRef = useRef(null)
  const pages = useRef(new Map())
  const downRef = useRef(null)
  const cbs = useRef({}); cbs.current = { onAnnotate, onAnnotationResolved, onRemoveAnnotation, onNoteAt }
  const annRef = useRef(annotations); annRef.current = annotations
  const [flash, setFlash] = useState(null)                 // { page, rects, nonce }
  const locRef = useRef(locate); locRef.current = locate
  const flashRef = useRef(null)
  const ensure = idx => { let p = pages.current.get(idx); if (!p) { p = { idx }; pages.current.set(idx, p) } return p }

  useEffect(() => { const t = setTimeout(() => setSettledWidth(width), 150); return () => clearTimeout(t) }, [width])

  useEffect(() => {
    let cancelled = false
    const task = pdfjs.getDocument({ url })
    task.promise.then(async d => {
      const sizes = await Promise.all(Array.from({ length: d.numPages }, (_, i) => d.getPage(i + 1).then(p => { const v = p.getViewport({ scale: 1 }); return { w: v.width, h: v.height } })))
      if (cancelled) return
      setDoc(d); setPageSizes(sizes)
    }).catch(e => { if (!cancelled) setError(e.message || String(e)) })
    return () => { cancelled = true; task.destroy().catch(() => { }) }
  }, [url])

  const liveScales = useMemo(() => pageSizes.map(s => width / s.w), [pageSizes, width])
  const heights = useMemo(() => pageSizes.map((s, i) => Math.round(s.h * liveScales[i])), [pageSizes, liveScales])
  const renderScales = useMemo(() => pageSizes.map(s => settledWidth / s.w), [pageSizes, settledWidth])
  const renderScalesRef = useRef(renderScales); renderScalesRef.current = renderScales
  const docRef = useRef(doc); docRef.current = doc

  const resolvePending = idx => {
    const p = pages.current.get(idx); if (!p?.textLayer) return
    for (const a of annRef.current) {
      if (a.rects?.length || !a.text) continue
      if (a.page && a.page !== idx + 1) continue
      const rects = findQuote(p, a.text)
      if (rects?.length) cbs.current.onAnnotationResolved(a.id, { page: idx + 1, rects: rects.map(r => ({ page: idx + 1, ...r })) })
    }
  }
  const tryFlash = idx => {
    const l = locRef.current, p = pages.current.get(idx)
    if (!l || !l.text || l.page !== idx + 1 || !p?.textLayer || flashRef.current === l.nonce) return
    const rects = findQuote(p, l.text)
    if (!rects?.length) return
    flashRef.current = l.nonce
    setFlash({ page: idx + 1, rects, nonce: l.nonce })
    setTimeout(() => setFlash(f => (f?.nonce === l.nonce ? null : f)), 2200)
  }
  const renderPage = async idx => {
    const p = pages.current.get(idx), d = docRef.current, scale = renderScalesRef.current[idx]
    if (!p?.canvas || !d || !scale) return
    if (p.renderedScale === scale || p.rendering === scale) return
    p.rendering = scale
    try {
      const page = await d.getPage(idx + 1)
      if (p.rendering !== scale) return
      const viewport = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      p.task?.cancel()
      p.canvas.width = Math.floor(viewport.width * dpr); p.canvas.height = Math.floor(viewport.height * dpr)
      const task = page.render({ canvasContext: p.canvas.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) })
      p.task = task
      await task.promise
      if (p.rendering !== scale) return
      p.div.style.setProperty('--scale-factor', String(scale))
      p.textLayerDiv.replaceChildren()
      const textContent = await page.getTextContent()
      if (p.rendering !== scale) return
      const tl = new pdfjs.TextLayer({ textContentSource: textContent, container: p.textLayerDiv, viewport })
      await tl.render()
      p.textLayer = tl; p.items = textContent.items; p.renderedScale = scale; p.rendering = null
      resolvePending(idx)
      tryFlash(idx)
    } catch (e) { if (p.rendering === scale) p.rendering = null; if (!/cancel/i.test(String(e))) console.error(e) }
  }
  const releasePage = idx => {
    const p = pages.current.get(idx); if (!p || (!p.renderedScale && !p.rendering)) return
    p.task?.cancel(); p.task = null
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0 }
    p.textLayerDiv?.replaceChildren(); p.textLayer = null; p.renderedScale = null; p.rendering = null
  }
  const readyRef = useRef(false)
  const checkReady = () => {
    if (readyRef.current || !onReady) return
    if (pageSizes.length && pageSizes.every((_, i) => pages.current.get(i)?.renderedScale)) { readyRef.current = true; onReady() }
  }
  useEffect(() => {
    if (!doc || !pageSizes.length) return
    if (eager) { pageSizes.forEach((_, i) => renderPage(i).then(checkReady)); return }
    const root = scrollRoot?.current || null
    const io = new IntersectionObserver(entries => { for (const en of entries) { const idx = Number(en.target.dataset.page); if (en.isIntersecting) renderPage(idx); else releasePage(idx) } }, { root, rootMargin: '900px 0px' })
    for (const [, p] of pages.current) if (p.div) io.observe(p.div)
    return () => io.disconnect()
  }, [doc, pageSizes, renderScales, eager])
  useEffect(() => { for (const [idx, p] of pages.current) if (p.textLayer) resolvePending(idx) }, [annotations])
  useEffect(() => { if (locate) for (const [idx, p] of pages.current) if (p.textLayer) tryFlash(idx) }, [locate?.nonce])   // a page already rendered
  useEffect(() => () => { for (const [, p] of pages.current) p.task?.cancel() }, [])

  // ---- selection → annotate bar ---------------------------------------------------------------
  const onMouseDown = e => { downRef.current = { x: e.clientX, y: e.clientY, t: Date.now() } }
  const onMouseUp = () => setTimeout(() => {
    const sel = window.getSelection(), root = rootRef.current
    if (!sel || sel.isCollapsed || !root || !root.contains(sel.anchorNode)) { setSelBar(null); return }
    const range = sel.getRangeAt(0)
    const rects = []
    for (const [idx, p] of pages.current) {
      if (!p.textLayerDiv || !p.renderedScale || !range.intersectsNode(p.textLayerDiv)) continue
      const sub = range.cloneRange()
      if (!p.textLayerDiv.contains(range.startContainer)) sub.setStart(p.textLayerDiv, 0)
      if (!p.textLayerDiv.contains(range.endContainer)) sub.setEnd(p.textLayerDiv, p.textLayerDiv.childNodes.length)
      for (const r of rectsFromRange(sub, p)) rects.push({ page: idx + 1, ...r })
    }
    if (!rects.length) { setSelBar(null); return }
    const br = range.getBoundingClientRect(), rr = root.getBoundingClientRect(), z = rr.width / width || 1
    setSelBar({ x: Math.max(0, Math.min((br.left - rr.left) / z, width - 260)), y: (br.top - rr.top) / z - 40, text: sel.toString().replace(/\s+/g, ' ').trim(), rects })
  }, 0)
  const apply = (type, color, label) => {
    if (!selBar) return
    cbs.current.onAnnotate({ type, color, ...(label ? { label } : {}), text: selBar.text, page: selBar.rects[0].page, rects: selBar.rects })
    window.getSelection()?.removeAllRanges(); setSelBar(null)
  }
  const onPageClick = (e, idx) => {
    const d = downRef.current; downRef.current = null
    if (e.target.closest('.pdf-annot, .annot-bar')) return
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
    if (!window.getSelection()?.isCollapsed) return
    const rr = rootRef.current.getBoundingClientRect(), z = rr.width / width || 1
    e.stopPropagation()
    cbs.current.onNoteAt(Math.round((e.clientX - rr.left) / z), Math.round((e.clientY - rr.top) / z))
  }

  const unresolved = annotations.filter(a => !a.rects?.length && a.text)
  return (
    <div ref={rootRef} className="pdf" style={{ width }} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
      {error && <div className="pdf-status">Could not open this PDF: {error}</div>}
      {!doc && !error && <div className="pdf-status">Loading PDF…</div>}
      {unresolved.length > 0 && <div className="pdf-unresolved" title="Highlights whose text has not been located yet. They resolve when their page renders.">{unresolved.length} highlight{unresolved.length > 1 ? 's' : ''} not located yet: {unresolved.map(a => `“${a.text.slice(0, 60)}”`).join(', ')}</div>}
      {pageSizes.map((s, idx) => {
        const scale = liveScales[idx]
        return (
          <div key={idx} data-page={idx} ref={node => { const p = ensure(idx); p.div = node; p.pageW = s.w }} className="pdf-page" style={{ width, height: heights[idx], marginBottom: idx < pageSizes.length - 1 ? PAGE_GAP : 0, '--scale-factor': scale }} onClick={e => onPageClick(e, idx)}>
            <canvas ref={node => { ensure(idx).canvas = node }} />
            <div className="textLayer" ref={node => { ensure(idx).textLayerDiv = node }} />
            <div className="pdf-annots">
              {annotations.flatMap(a => (a.rects || []).filter(r => r.page === idx + 1).map((r, i) => (
                <div key={a.id + ':' + i} className={'pdf-annot ' + a.type} title={a.text} style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale, '--c': a.color || HL_COLORS[0] }}
                  onClick={e => { e.stopPropagation(); setMenu({ id: a.id, type: a.type, x: e.clientX, y: e.clientY }) }}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ id: a.id, type: a.type, x: e.clientX, y: e.clientY }) }} />
              )))}
              {flash?.page === idx + 1 && flash.rects.map((r, i) => <div key={'loc' + i} className="pdf-annot locate" style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }} />)}
            </div>
            <div className="pdf-page-num">{idx + 1}</div>
          </div>
        )
      })}
      {selBar && (
        <div className="annot-bar" style={{ left: selBar.x, top: Math.max(-36, selBar.y) }} onMouseDown={e => e.preventDefault()} onMouseUp={e => e.stopPropagation()}>
          {colors.map(h => <button key={h.color} type="button" className="swatch labeled" style={{ background: h.color }} title={h.label ? `Highlight: ${h.label}` : 'Highlight'} onClick={() => apply('highlight', h.color, h.label)}><span>{h.label ? h.label.slice(0, 3) : ''}</span></button>)}
          <span className="tb-sep" />
          <button type="button" className="tb" title="Underline" onClick={() => apply('underline', '#ff375f')}><u>U</u></button>
          <button type="button" className="tb" title="Copy text" onClick={() => { navigator.clipboard?.writeText(selBar.text); setSelBar(null) }}>Copy</button>
          {onSetPalette && <button type="button" className="tb" title="What each colour means" onClick={() => setEditPalette(colors.map(h => ({ ...h })))}><Icon.gear width="15" height="15" /></button>}
        </div>
      )}
      {editPalette && createPortal(
        <div className="palette-edit" onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
          <div className="meta-title">What each highlight colour means</div>
          {editPalette.map((h, i) => (
            <label key={h.color} className="meta-field"><span className="swatch" style={{ background: h.color }} /><input value={h.label} placeholder="e.g. exam, definition" onChange={e => setEditPalette(list => list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></label>
          ))}
          <div className="meta-actions"><button className="btn small" onClick={() => setEditPalette(null)}>Cancel</button><button className="btn small primary" onClick={() => { onSetPalette(editPalette); setEditPalette(null) }}>Save</button></div>
        </div>,
        document.body
      )}
      {menu && <ContextMenu at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={[
        ...(annotations.find(a => a.id === menu.id)?.label ? [{ label: `“${annotations.find(a => a.id === menu.id).label}”`, onClick: () => { } }] : []),
        { label: menu.type === 'underline' ? 'Remove underline' : 'Remove highlight', danger: true, onClick: () => cbs.current.onRemoveAnnotation(menu.id) },
      ]} />}
    </div>
  )
}
