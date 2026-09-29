import { useEffect, useRef, useState } from 'react'
// Inline rename input. Enter commits, Esc cancels, blur commits.
export default function InlineName({ value, onCommit, onCancel, className }) {
  const [v, setV] = useState(value)
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const commit = () => { const s = v.trim(); if (s && s !== value) onCommit(s); else onCancel() }
  return <input ref={ref} className={'inline-name ' + (className || '')} value={v} onChange={e => setV(e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onCancel(); e.stopPropagation() }}
    onBlur={commit} onClick={e => e.stopPropagation()} />
}
