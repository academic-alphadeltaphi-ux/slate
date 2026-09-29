import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { computeLayout, FIRST, MAX_AUTO_W, MIN_W, DEFAULT_W, ANNOTATION_TYPES, OVERLAY_TYPES, elementKind } from '../layout.js'
import { buildExtensions } from '../editor/extensions.js'
import { createRenderer } from '../editor/markdown.js'
import { inkBounds, inkColorMap } from '../ink.js'
import TextBlock from './TextBlock.jsx'
import PdfEl from './PdfEl.jsx'
import { FileCard, ImageEl, fetchTranscript, hms } from './Elements.jsx'
import { InkSvg } from './Ink.jsx'

// A read-only rendering of one page for printing: every PDF page rendered up front, ink included,
// scaled to the paper width or printed as a single sheet the size of the content.
// Export mode (SPEC §20.10): `/?print=<page>&export=1` is what the export printer loads in its hidden Electron
// window. No bar, always Letter, and instead of calling window.print the view marks <html data-ready="1"> once
// every document is drawn, every element measured, fonts and images loaded — the printer waits for that mark.
// On a load error the bar still renders "Could not load the page: …" so the printer can fail that page early.
const LETTER_PRINTABLE_PX = 720   // 8.5in minus two 0.5in margins at 96dpi
const PRINT_INK = inkColorMap(true, false)   // "ink follows the theme" for a light sheet
const settle = async () => {
  try { await document.fonts?.ready } catch { }
  await Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }) })))
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
}
export default function PrintView({ path, onClose }) {
  const exporting = !onClose && new URLSearchParams(window.location.search).get('export') === '1'   // the in-app overlay never sets it
  const [page, setPage] = useState(null)
  const [error, setError] = useState(null)
  const [sizes, setSizes] = useState(() => new Map())
  const [mode, setMode] = useState('fit')
  const [pdfReady, setPdfReady] = useState(0)
  const [mediaReady, setMediaReady] = useState(0)   // recordings whose transcript has been looked for
  const [printed, setPrinted] = useState(false)
  useEffect(() => { api.page(path).then(setPage).catch(e => setError(e.message)) }, [path])
  useEffect(() => { if (page && !onClose) document.title = exporting ? page.title : page.title + ' — slate' }, [page])
  const close = () => (onClose ? onClose() : (window.location.href = '/'))
  useEffect(() => { if (exporting) return; const h = e => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const resolveSrc = useCallback(src => (/^(https?:|data:|blob:|\/)/.test(src || '') ? src : api.fileUrl(page.dir, src)), [page?.dir])
  const extensions = useMemo(() => (page ? buildExtensions({ resolveSrc }) : null), [resolveSrc, !!page])
  const renderer = useMemo(() => (extensions ? createRenderer(extensions) : null), [extensions])
  const ro = useMemo(() => new ResizeObserver(entries => setSizes(prev => { const m = new Map(prev); for (const en of entries) m.set(en.target.dataset.id, { w: en.target.offsetWidth, h: en.target.offsetHeight }); return m })), [])
  const observe = useCallback(el => { if (!el) return; ro.observe(el); return () => ro.unobserve(el) }, [ro])
  const blocks = page?.blocks || [], layout = page?.layout || { elements: [] }
  const { pos, content } = useMemo(() => computeLayout(blocks, layout, sizes, 1200), [blocks, layout, sizes])
  const ink = useMemo(() => inkBounds(layout.elements, pos), [layout, pos])
  const w = Math.max(content.w, ink.w) + 48, h = Math.max(content.h, ink.h) + 48
  // What prints: non-empty text (notes on a collapsed document stay with it) and visible boxes.
  // Readiness only waits for those, or a hidden document would keep the view rendering forever.
  const hiddenIds = new Set(layout.elements.filter(e => e.hidden).map(e => e.id))
  const elOf = b => (b.id && layout.elements.find(e => e.id === b.id)) || {}
  const texts = blocks.filter(b => b.md.trim() && !(elOf(b).parent && hiddenIds.has(elOf(b).parent)))
  const boxes = layout.elements.filter(e => e.type !== 'text' && !OVERLAY_TYPES.has(e.type) && !e.hidden)
  const pdfCount = boxes.filter(e => elementKind(e) === 'pdf').length
  const mediaCount = boxes.filter(e => elementKind(e) === 'media').length
  const measured = [...texts.map(b => b.id || FIRST), ...boxes.map(e => e.id)].every(id => !pos.has(id) || sizes.has(id))
  const ready = !!page && measured && pdfReady >= pdfCount && mediaReady >= mediaCount
  useEffect(() => {
    if (!ready || printed) return
    setPrinted(true)
    if (exporting) { settle().then(() => { document.documentElement.dataset.ready = '1' }); return }   // the printer takes it from here
    setTimeout(() => window.print(), 600)
  }, [ready])
  if (error) return <div className="print-bar">Could not load the page: {error}</div>
  if (!page) return <div className="print-bar">Loading…</div>
  const zoom = mode === 'fit' ? Math.min(1, LETTER_PRINTABLE_PX / w) : 1
  return (
    <div className="print-root">
      <style>{mode === 'fit' ? '@page { size: letter; margin: 0.5in }' : `@page { size: ${Math.ceil(w)}px ${Math.ceil(h)}px; margin: 0 }`}</style>
      {!exporting && <div className="print-bar">
        <button className="btn" onClick={close} title="Back to the notes (Esc)">← Back</button>
        <strong>{page.title}</strong>
        <span className="seg text"><button className={mode === 'fit' ? 'on' : ''} onClick={() => setMode('fit')}>Fit to Letter width</button><button className={mode === 'sheet' ? 'on' : ''} onClick={() => setMode('sheet')}>One sheet, actual size</button></span>
        <span className="spacer" />
        <span className="muted">{ready ? 'Ready' : `Rendering… (${pdfReady}/${pdfCount} documents)`}</span>
        <button className="btn primary" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>}
      <div className="print-page" style={{ width: w, height: h, zoom }}>
        {texts.map(b => {
          const id = b.id || FIRST, p = pos.get(id); if (!p) return null
          const el = elOf(b)
          return (
            <div key={id} data-id={id} ref={observe} className="el el-text" style={{ left: p.x, top: p.y, width: p.w === 'auto' ? undefined : p.w, maxWidth: p.w === 'auto' ? Math.max(MIN_W, MAX_AUTO_W) : undefined, fontFamily: el.style?.font || undefined, fontSize: el.style?.size ? el.style.size + 'px' : undefined, color: el.style?.color || undefined }}>
              <TextBlock id={id} md={b.md} focused={false} renderer={renderer} onFocus={() => { }} onOpenTitle={() => { }} />
            </div>
          )
        })}
        {boxes.map(el => {
          const p = pos.get(el.id); if (!p) return null
          const url = resolveSrc(el.src), kind = elementKind(el)
          return (
            <div key={el.id} data-id={el.id} ref={observe} className={'el el-' + kind} style={{ left: p.x, top: p.y, width: kind === 'media' ? Math.max(typeof p.w === 'number' ? p.w : 0, MAX_AUTO_W) : p.w }}>
              {kind === 'pdf' ? <PdfEl el={el} url={url} width={typeof p.w === 'number' ? p.w : DEFAULT_W.pdf} eager onReady={() => setPdfReady(n => n + 1)} annotations={layout.elements.filter(a => ANNOTATION_TYPES.has(a.type) && a.parent === el.id)} onAnnotate={() => { }} onAnnotationResolved={() => { }} onRemoveAnnotation={() => { }} onNoteAt={() => { }} />
                : kind === 'image' ? <ImageEl el={el} url={url} width="100%" />
                : kind === 'media' ? <PrintRecording el={el} url={url} onReady={() => setMediaReady(n => n + 1)} />
                : <FileCard el={el} url={url} />}
            </div>
          )
        })}
        {/* Paper is always light: the neutral ink drawn in dark mode (#f2f2f7) prints as the light theme shows it, dark. */}
        <InkSvg elements={layout.elements} pos={pos} live={null} extent={{ w, h }} colorMap={PRINT_INK} />
      </div>
    </div>
  )
}

// A recording on paper is its transcript (SPEC §20.33). The page printed a file card — a name and a size — because a
// player cannot print, and the words, which are the part worth keeping, stayed behind in `<audio>.transcript.json`.
// Every paragraph prints with the moment it was said. The printer waits until the transcript has been looked for.
function PrintRecording({ el, url, onReady }) {
  const [tr, setTr] = useState(undefined)            // undefined: still looking · null: not transcribed
  const told = useRef(false)
  useEffect(() => { let alive = true; fetchTranscript(el, url).then(t => { if (alive) setTr(t) }); return () => { alive = false } }, [el.src, url])
  useEffect(() => { if (tr !== undefined && !told.current) { told.current = true; onReady?.() } }, [tr])
  const name = decodeURIComponent((el.src || '').split('/').pop() || '')
  const paras = tr?.paragraphs || []
  return (
    <div className="print-rec">
      <div className="print-rec-head">
        <b>{name}</b>
        <span>{tr ? `Transcript · ${paras.length} paragraphs${tr.minutes ? ` · ${tr.minutes} min` : ''}` : tr === null ? 'Recording · not transcribed yet' : ''}</span>
      </div>
      {paras.map((p, i) => <p key={i} className="print-rec-p"><span className="print-rec-t">{hms(p.start)}</span>{p.text}</p>)}
    </div>)
}
