import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { COLORS } from '../editor/extensions.js'

export default function ContextMenu({ at, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const x = Math.min(at.x, window.innerWidth - 220), y = Math.min(at.y, window.innerHeight - 40 * items.length - 16)
  // Portalled to the body: a fixed position inside the zoomed page would be relative to the page.
  return createPortal(
    <div className="ctx" ref={ref} style={{ left: x, top: y }} role="menu">
      {items.map((it, i) => it === '-' ? <div key={i} className="ctx-sep" /> :
        it.swatches ? (
          <div key={i} className="ctx-swatches">
            {[null, ...COLORS].map(c => <button key={c || 'none'} className={'swatch' + (c ? '' : ' none')} style={{ background: c || 'transparent' }} title={c || 'No colour'} onClick={() => { it.onPick(c); onClose() }} />)}
          </div>
        ) : (
          <button key={i} className={'ctx-item' + (it.danger ? ' danger' : '')} onClick={() => { it.onClick(); onClose() }}>{it.label}</button>
        ))}
    </div>,
    document.body
  )
}
