import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'
import { INK_COLORS, INK_SIZES, ERASER_SIZES } from '../ink.js'
import { SPEECH } from '../transcribe.js'

export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
export const stepZoom = (z, dir) => {
  const i = ZOOM_STEPS.findIndex(s => s >= z - 0.001)
  const j = dir > 0 ? Math.min(ZOOM_STEPS.length - 1, (i < 0 ? ZOOM_STEPS.length - 1 : i) + 1) : Math.max(0, (i < 0 ? 0 : i) - 1)
  return ZOOM_STEPS[j]
}
const keep = e => e.preventDefault()
// Declared outside the component so React keeps the buttons mounted across renders.
const T = ({ on, title, onClick, disabled, children, cls = '' }) => <button type="button" className={cls + (on ? ' on' : '')} title={title} disabled={disabled} onMouseDown={keep} onClick={onClick}>{children}</button>
const sizeDot = (px, max) => Math.max(4, Math.min(18, Math.round(4 + (14 * px) / max)))
// What the microphone is doing, in the words that tell you whether to keep talking.
const DICT_SAY = {
  listening: 'Listening — speak, and each phrase lands where the cursor is.',
  hearing: 'Hearing you…',
  thinking: 'Writing that down…',
  warming: 'Loading the recogniser — the first phrase takes a moment, then it is instant.',
}
const ls = { get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { } } }

// The floating tool pill (SPEC §20.28). It sat centred over the top of the page and covered the first two lines of
// every note, with no way to move it — so it moves now: drag the grip, and where you put it is remembered. It also
// carries the two things the page is really switched between — freeform canvas or document — and the microphone,
// because dictating is a way of writing, not a setting.
// props: { …, doc, setDoc, dictation: { on, supported, error, toggle } }
export default function Tools({ tool, setTool, zoom, setZoom, canUndo, canRedo, onUndo, onRedo, penInfo, doc = false, setDoc, dictation }) {
  const set = patch => setTool(t => ({ ...t, ...patch }))
  const pick = mode => set({ mode: tool.mode === mode && mode !== 'select' ? 'select' : mode })
  const drawing = tool.mode !== 'select'
  const [at, setAt] = useState(() => ls.get('slate.toolsAt', null))   // { x, y } from the canvas's top-left, or null = the corner
  const [shown, setShown] = useState(null)                             // `at`, kept where it can be seen (below)
  const [more, setMore] = useState(false)
  const el = useRef(null)
  useEffect(() => { ls.set('slate.toolsAt', at) }, [at])

  // Where the pill may sit: inside the page area, and never under the pane's top bar (SPEC §20.32). The position is
  // saved once for every page, but the page area does not start in the same place on every page: under a document's
  // header it starts below the bar, on a note it starts *behind* the bar, which floats over the ruled sheet. A spot
  // saved at y=8 on a lecture put the pill behind the bar on every note — there, just never visible. The drag used to
  // clamp only to the page area, and nothing clamped on render, so a spot saved in a wider window also hung off the
  // right edge. Both are clamped now, on every render, resize and change of the pill's own size.
  const clamp = p => {
    const node = el.current, host = node?.parentElement
    if (!p || !host) return p
    const h = host.getBoundingClientRect(), box = node.getBoundingClientRect()
    const bar = host.closest('.pane')?.querySelector('.topbar')?.getBoundingClientRect()
    const top = bar && bar.bottom > h.top ? bar.bottom - h.top + 8 : 8
    return { x: Math.max(8, Math.min(h.width - box.width - 8, p.x)), y: Math.max(top, Math.min(h.height - box.height - 8, p.y)) }
  }
  useLayoutEffect(() => {
    const node = el.current, host = node?.parentElement
    if (!host) return
    const fit = () => setShown(s => { const n = clamp(at); return s && n && s.x === n.x && s.y === n.y ? s : n })
    fit()
    const ro = new ResizeObserver(fit); ro.observe(host); ro.observe(node)
    return () => ro.disconnect()
  }, [at])

  // Drag by the grip, under the same rule.
  const startDrag = e => {
    e.preventDefault()
    const box = el.current.getBoundingClientRect(), host = el.current.parentElement.getBoundingClientRect()
    const dx = e.clientX - box.left, dy = e.clientY - box.top
    const move = ev => setAt(clamp({ x: ev.clientX - host.left - dx, y: ev.clientY - host.top - dy }))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const place = at ? shown || at : null
  const style = place ? { left: place.x, top: place.y, right: 'auto' } : undefined

  return (
    <div ref={el} className={'tools' + (drawing ? ' drawing' : '') + (dictation?.on ? ' listening' : '')} style={style}>
      <div className="tools-row">
        <span className="tools-grip" title="Drag to move these tools" onPointerDown={startDrag} onDoubleClick={() => setAt(null)}><Icon.grip width="12" height="12" /></span>

        {/* What kind of page this is, before anything you can do to it. */}
        <div className="seg">
          <T on={!doc} title="Canvas: put anything anywhere, write by hand, draw" onClick={() => setDoc?.(false)}><Icon.grid /></T>
          <T on={doc} title="Document: one column, wide measure, plain typing" onClick={() => setDoc?.(true)}><Icon.notes /></T>
        </div>
        <span className="tools-sep" />

        {doc ? null : (<>
          <div className="seg">
            <T on={tool.mode === 'select'} title="Select and type (V)" onClick={() => pick('select')}><Icon.cursor /></T>
            <T on={tool.mode === 'pen'} title="Pen (P)" onClick={() => pick('pen')}><Icon.pen /></T>
            <T on={tool.mode === 'highlighter'} title="Highlighter (H)" onClick={() => pick('highlighter')}><Icon.highlighter /></T>
            <T on={tool.mode === 'eraser'} title="Eraser (E)" onClick={() => pick('eraser')}><Icon.eraser /></T>
            <T on={tool.mode === 'lasso'} title="Lasso: circle handwriting to move, resize, recolour or delete it (L)" onClick={() => pick('lasso')}><Icon.lasso /></T>
            <T on={tool.mode === 'clip'} title="Clip: drag a rectangle over a PDF page or an image to copy that part beside it (C)" onClick={() => pick('clip')}><Icon.crop /></T>
          </div>
          <span className="tools-sep" />
        </>)}

        {dictation && SPEECH && (<>
          <T cls={'tb icon mic' + (dictation.on ? ' on' : '')} title={dictation.supported ? (dictation.on ? 'Stop dictating' : 'Dictate: speak and it is typed for you, on this machine') : 'This browser cannot record audio'}
            disabled={!dictation.supported} onClick={dictation.toggle}><Icon.mic /></T>
          <span className="tools-sep" />
        </>)}

        {/* Undo, redo and zoom are used a hundred times less than the tools, and they were half the pill's width.
            They live behind the chevron; ⌘Z, ⌘−, ⌘+ and ⌘0 never needed a button at all (SPEC §20.31). */}
        <T cls={'tb icon tools-more' + (more ? ' on' : '')} title={more ? 'Fewer controls' : 'Undo, redo, zoom'} onClick={() => setMore(m => !m)}><Icon.chevron /></T>
        {more && (<>
          <span className="tools-sep" />
          <T cls="tb icon" title="Undo (⌘Z)" disabled={!canUndo} onClick={onUndo}><Icon.undo /></T>
          <T cls="tb icon" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={onRedo}><Icon.redo /></T>
          <span className="tools-sep" />
          <T cls="tb icon" title="Zoom out (⌘−)" onClick={() => setZoom(z => stepZoom(z, -1))}><Icon.minus /></T>
          <T cls="tb zoom" title="Reset zoom (⌘0)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</T>
          <T cls="tb icon" title="Zoom in (⌘+)" onClick={() => setZoom(z => stepZoom(z, 1))}><Icon.plus /></T>
          {penInfo && <span className="tools-info" title="What the browser receives from your input device">{penInfo.type === 'pen' ? `pen · ${penInfo.pressure.toFixed(2)}${penInfo.tilt ? ` · ${penInfo.tilt}` : ''}` : `${penInfo.type} · no pressure`}</span>}
        </>)}
      </div>

      {dictation?.on && <div className="tools-row sub"><span className="tools-hint listening">{DICT_SAY[dictation.state] || DICT_SAY.listening}</span></div>}
      {dictation?.error && <div className="tools-row sub"><span className="tools-hint warn">{dictation.error}</span></div>}

      {drawing && !doc && (
        <div className="tools-row sub">
          {tool.mode === 'clip' ? <span className="tools-hint">Drag a rectangle over a PDF page or an image. The clip lands beside it as a picture you can drag and resize; it is also copied to the clipboard.</span>
          : tool.mode === 'lasso' ? <span className="tools-hint">Draw a loop around handwriting. Then drag it, pull the corner, pick a colour, or press ⌫.</span> : tool.mode === 'eraser' ? (
            <>
              <div className="seg text">
                <T on={tool.eraser === 'stroke'} title="Erase whole strokes you touch" onClick={() => set({ eraser: 'stroke' })}>Stroke</T>
                <T on={tool.eraser === 'partial'} title="Erase only the part you touch" onClick={() => set({ eraser: 'partial' })}>Partial</T>
              </div>
              <span className="tools-sep" />
              <span className="dots">{ERASER_SIZES.map(r => <T key={r} cls="dot" on={tool.eraserSize === r} title={`Eraser ${r * 2}px`} onClick={() => set({ eraserSize: r })}><span className="ring" style={{ width: sizeDot(r, ERASER_SIZES[ERASER_SIZES.length - 1]), height: sizeDot(r, ERASER_SIZES[ERASER_SIZES.length - 1]) }} /></T>)}</span>
            </>
          ) : (
            <>
              <span className="dots colors">{INK_COLORS.map(c => <T key={c} cls="dot" on={tool.color === c} title={c} onClick={() => set({ color: c })}><span className="disc" style={{ background: c, width: 14, height: 14 }} /></T>)}</span>
              <span className="tools-sep" />
              <span className="dots">{INK_SIZES.map(w => <T key={w} cls="dot" on={tool.size === w} title={`${w}px`} onClick={() => set({ size: w })}><span className="disc" style={{ width: sizeDot(w, INK_SIZES[INK_SIZES.length - 1]), height: sizeDot(w, INK_SIZES[INK_SIZES.length - 1]), background: tool.color }} /></T>)}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
