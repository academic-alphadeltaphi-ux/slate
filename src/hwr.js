// Client helpers for recognised handwriting (SPEC §20.9), kept out of Canvas so its edits stay small: hit-testing
// ink for the right-click, the context-menu items, the ink-to-text block, and the card's relative time.
import { hitStroke, strokeBounds } from './ink.js'
import { hasText, isStale } from './inkhash.js'

// The same frame math as Canvas.inkFrame: ink with a parent is translated to the parent and scaled by
// parent.w / parentW. null when the parent is not laid out (collapsed, gone).
export const frameOf = (el, pos) => {
  if (!el.parent) return { off: { x: 0, y: 0 }, k: 1 }
  const p = pos.get(el.parent); if (!p) return null
  return { off: { x: p.x, y: p.y }, k: el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1 }
}
const isPen = s => s && s.tool !== 'highlighter' && Array.isArray(s.points) && s.points.length > 0
export const penStrokesOf = el => (el?.strokes || []).filter(isPen)

// The topmost ink element with writing under a page point (last drawn wins), within `radius` page px of a pen
// stroke. Highlighter marks are not writing: they never hit, and an element with only marks is skipped, as is ink
// riding on a collapsed document.
export function hitInkAt(elements, pos, x, y, radius = 6) {
  const hidden = new Set(elements.filter(e => e.hidden).map(e => e.id))
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]
    if (el.type !== 'ink' || (el.parent && hidden.has(el.parent))) continue
    const pen = penStrokesOf(el); if (!pen.length) continue
    const f = frameOf(el, pos); if (!f) continue
    const lx = (x - f.off.x) / f.k, ly = (y - f.off.y) / f.k
    for (const s of pen) if (hitStroke(s, lx, ly, radius / f.k)) return { el, stroke: s }
  }
  return null
}

// Bounding box of the element's pen strokes in page space (the card sits under it, Convert pins the block at it).
export function penBox(el, frame) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of penStrokesOf(el)) { const b = strokeBounds(s); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1) }
  if (x0 === Infinity) return null
  return { x: frame.off.x + x0 * frame.k, y: frame.off.y + y0 * frame.k, w: (x1 - x0) * frame.k, h: (y1 - y0) * frame.k }
}

// The right-click menu on handwriting. `on` = { recognise, show, copy, convert, all }. Items are what
// ContextMenu renders: { label, onClick } or '-'.
export function inkMenuItems({ el, inkCount = 1, on }) {
  const items = []
  if (!hasText(el)) items.push({ label: 'Recognise handwriting', onClick: on.recognise })
  else if (isStale(el)) items.push({ label: 'Recognise again (ink changed)', onClick: on.recognise }, { label: 'Show recognised text (out of date)', onClick: on.show }, { label: 'Copy text', onClick: on.copy })
  else if (!(el.lines || []).length) items.push({ label: 'Show recognised text', onClick: on.show }, '-', { label: 'Recognise again', onClick: on.recognise })
  else items.push({ label: 'Show recognised text', onClick: on.show }, { label: 'Copy text', onClick: on.copy }, { label: 'Convert to text', onClick: on.convert }, '-', { label: 'Recognise again', onClick: on.recognise })
  if (inkCount > 1) items.push('-', { label: 'Recognise all handwriting on this page', onClick: on.all })
  return items
}

// Ink-to-text (OneNote's): one text block, the lines joined by hard breaks (a trailing backslash, exactly what
// the editor's HardBreakMd writes for Shift-Enter), pinned at the writing's top-left — on a rule of the page
// (multiples of --lh = 24 px) for page ink, or relative to the document for ink riding on one, like addNote.
export const RULE = 24
export function textBlockFromInk(el, frame) {
  const md = (el.lines || []).map(l => String(l.text || '').trim()).filter(Boolean).join('\\\n')
  if (el.parent) {
    const b = penBox(el, { off: { x: 0, y: 0 }, k: 1 }) || { x: 0, y: 0 }
    return { md, parent: el.parent, parentW: el.parentW, x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y)) }
  }
  const b = penBox(el, frame) || { x: 0, y: 0 }
  return { md, x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y / RULE) * RULE) }
}

// "just now" · "4 min ago" · "3 h ago" · a date. Used by the card's kicker.
export const ago = (iso, now = Date.now()) => {
  const t = new Date(iso).getTime(); if (!iso || Number.isNaN(t)) return ''
  const m = Math.round((now - t) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
