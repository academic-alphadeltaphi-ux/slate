import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

// In-app confirm / prompt / alert, so nothing ever shows a browser popup.
const Ctx = createContext(null)
export function DialogProvider({ children }) {
  const [d, setD] = useState(null)
  const api = useMemo(() => ({
    confirm: opts => new Promise(resolve => setD({ kind: 'confirm', ...opts, resolve })),
    prompt: opts => new Promise(resolve => setD({ kind: 'prompt', ...opts, resolve })),
    alert: opts => new Promise(resolve => setD({ kind: 'alert', ...(typeof opts === 'string' ? { message: opts } : opts), resolve })),
    choose: opts => new Promise(resolve => setD({ kind: 'choose', ...opts, resolve })),   // options: [{ value, label, hint?, recommended? }] → value or null
  }), [])
  const close = v => { d?.resolve(v); setD(null) }
  return <Ctx.Provider value={api}>{children}{d && <DialogView d={d} onClose={close} />}</Ctx.Provider>
}
export const useDialog = () => useContext(Ctx)

function DialogView({ d, onClose }) {
  const [v, setV] = useState(d.value || '')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select?.() }, [])
  const ok = () => { if (d.kind === 'choose') return; onClose(d.kind === 'prompt' ? v : true) }
  const cancel = () => onClose(d.kind === 'prompt' || d.kind === 'choose' ? null : false)
  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div className="dialog" role="dialog" onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter') ok(); e.stopPropagation() }}>
        {d.title && <div className="dialog-title">{d.title}</div>}
        {d.message && <div className="dialog-msg">{d.message}</div>}
        {d.kind === 'prompt' && <label className="dialog-field">{d.label && <span>{d.label}</span>}<input ref={ref} value={v} placeholder={d.placeholder || ''} onChange={e => setV(e.target.value)} /></label>}
        {d.kind === 'choose' && <div className="dialog-options">{d.options.map(o => <button key={String(o.value)} ref={o.recommended ? ref : null} className={'dialog-option' + (o.recommended ? ' recommended' : '')} onClick={() => onClose(o.value)}><span className="dialog-option-label">{o.label}</span>{o.hint && <span className="dialog-option-hint">{o.hint}</span>}</button>)}</div>}
        <div className="dialog-actions">
          {d.kind !== 'alert' && <button className="btn" onClick={cancel}>Cancel</button>}
          {d.kind !== 'choose' && <button ref={d.kind !== 'prompt' ? ref : null} className={'btn primary' + (d.danger ? ' danger' : '')} onClick={ok}>{d.confirmLabel || (d.kind === 'alert' ? 'OK' : 'Confirm')}</button>}
        </div>
      </div>
    </div>
  )
}
