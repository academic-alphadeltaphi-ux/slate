import { useEffect, useRef, useState } from 'react'
import { COLORS } from '../editor/extensions.js'

// Small anchored form for label / colour / kind / tags. Saves on Enter or the button.
export default function MetaPopover({ at, title, fields, values, onSave, onClose }) {
  const [v, setV] = useState(() => ({ ...values }))
  const ref = useRef(null)
  useEffect(() => {
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown, true); document.addEventListener('keydown', onKey)
    ref.current?.querySelector('input, select')?.focus()
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const save = () => { onSave(v); onClose() }
  const x = Math.min(at.x, window.innerWidth - 320), y = Math.min(at.y, window.innerHeight - 60 * fields.length - 80)
  return (
    <div className="meta-pop" ref={ref} style={{ left: x, top: y }} onKeyDown={e => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') save(); e.stopPropagation() }}>
      <div className="meta-title">{title}</div>
      {fields.map(f => (
        <label key={f.key} className="meta-field">
          <span>{f.label}</span>
          {f.type === 'select' ? (
            <select value={v[f.key] || ''} onChange={e => setV({ ...v, [f.key]: e.target.value || null })}>
              <option value="">—</option>{f.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          ) : f.type === 'color' ? (
            <span className="meta-swatches">{[null, ...COLORS].map(c => <button key={c || 'none'} type="button" className={'swatch' + (c ? '' : ' none') + ((v[f.key] || null) === c ? ' on' : '')} style={{ background: c || 'transparent' }} onClick={() => setV({ ...v, [f.key]: c })} />)}</span>
          ) : f.type === 'tags' ? (
            <input value={Array.isArray(v[f.key]) ? v[f.key].join(', ') : (v[f.key] || '')} placeholder="comma, separated" onChange={e => setV({ ...v, [f.key]: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
          ) : (
            <input value={v[f.key] || ''} placeholder={f.placeholder || ''} maxLength={f.max || 200} onChange={e => setV({ ...v, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="meta-actions"><button className="btn small" onClick={onClose}>Cancel</button><button className="btn small primary" onClick={save}>Save</button></div>
    </div>
  )
}
