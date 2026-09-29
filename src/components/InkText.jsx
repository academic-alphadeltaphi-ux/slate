import { useEffect, useState } from 'react'
import { Icon } from './Icons.jsx'
import { ago } from '../hwr.js'
import { hasText, isStale } from '../inkhash.js'
import '../styles/hwr.css'

// The recognised-handwriting card (SPEC §20.9): opaque, under the ink and never over it, scaled 1/zoom like the
// toolbar, clamped inside the canvas. Shows the lines (dimmed under 0.6 confidence), Copy, Convert to text, and
// Recognise / Recognise again; says when the ink changed since, when no words were found, and why recognition is
// unavailable. Props: el (the ink element), box (penBox in page space), zoom, canvasW, busy, error, onRecognise,
// onConvert, onClose. Every pointer event stops here so a click on the card never starts a stroke or a text box.
const WIDTH = 360
export default function InkTextCard({ el, box, zoom = 1, canvasW = 1000, busy = false, error = null, onRecognise, onConvert, onClose }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t) }, [copied])
  const has = hasText(el), stale = has && isStale(el), lines = has ? el.lines || [] : []
  const copy = () => { navigator.clipboard?.writeText(el.text || '').then(() => setCopied(true)).catch(() => { }) }
  const stop = e => e.stopPropagation()
  const left = Math.max(4, Math.min(box.x, canvasW / zoom - (WIDTH + 20) / zoom)), top = box.y + box.h + 12
  const kicker = busy ? 'Recognising…' : has ? `Handwriting · ${lines.length} line${lines.length === 1 ? '' : 's'} · ${ago(el.textAt)}` : 'Handwriting'
  return (
    <div className={'ink-text' + (stale ? ' stale' : '')} style={{ left, top, width: WIDTH, transform: `scale(${1 / zoom})`, transformOrigin: '0 0' }}
      onPointerDown={stop} onPointerUp={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop} role="dialog" aria-label="Recognised handwriting">
      <div className="ink-text-k">
        <span className="ink-text-ic"><Icon.pen width="13" height="13" /></span>
        <span className="ink-text-title">{kicker}</span>
        <span className="spacer" />
        <button type="button" className="el-head-btn" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      {error && <div className="ink-text-msg ink-text-err">{error}</div>}
      {!busy && !error && stale && <div className="ink-text-msg">Ink changed since — <button type="button" className="ink-text-link" onClick={onRecognise}>Recognise again</button></div>}
      {!busy && !error && has && lines.length === 0 && <div className="ink-text-msg">No words found in this ink.</div>}
      {!busy && lines.length > 0 && (
        <div className="ink-text-body">
          {lines.map((l, i) => <div key={i} className={'ink-text-line' + (l.confidence < 0.6 ? ' low' : '')} title={l.confidence < 0.6 ? 'low confidence' : undefined}>{l.text}</div>)}
        </div>
      )}
      {!busy && (
        <div className="ink-text-actions">
          {lines.length > 0 && <button type="button" className="btn small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
          {lines.length > 0 && !stale && <button type="button" className="btn small" onClick={onConvert} title="Replace the ink with a text block (⌘Z puts the ink back)">Convert to text</button>}
          {(!has || stale || error) && <button type="button" className="btn small primary" onClick={onRecognise}>{has ? 'Recognise again' : 'Recognise'}</button>}
        </div>
      )}
    </div>
  )
}
