// Ink: stroke data in, SVG paths out. Strokes are stored as arrays of [x, y, pressure, t] in
// page pixels (or relative to a parent element), never as images. SPEC.md §5.
import { getStroke } from 'perfect-freehand'

export const INK_COLORS = ['#1d1d1f', '#f2f2f7', '#2563eb', '#e11d48', '#16a34a', '#ea580c', '#7c3aed', '#ffd60a']
export const INK_SIZES = [1.5, 2.5, 3.5, 5, 7, 10]          // pen width in page px
export const ERASER_SIZES = [6, 12, 22, 36]                 // eraser radius in page px
export const newStrokeId = () => Math.random().toString(36).slice(2, 8)
export const isDarkTheme = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || (t !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) }
export const defaultInkColor = () => (isDarkTheme() ? '#f2f2f7' : '#1d1d1f')
// What the neutral ink looks like in the other theme, when "ink follows theme" is on.
export const inkColorMap = (adapt, dark) => (!adapt ? {} : dark ? { '#1d1d1f': '#f2f2f7' } : { '#f2f2f7': '#1d1d1f' })
export const compactPoint = (x, y, p, t) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round((p ?? 0.5) * 100) / 100, Math.round(t)]
export const HIGHLIGHTER_FACTOR = 3.2
export const halfWidth = s => (s.tool === 'highlighter' ? (s.width * HIGHLIGHTER_FACTOR) / 2 : s.width / 2)

function outlineToPath(pts) {
  if (!pts.length) return ''
  const d = [`M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    d.push(`Q ${a[0].toFixed(1)} ${a[1].toFixed(1)} ${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)}`)
  }
  return d.join(' ') + ' Z'
}
// Smooth centreline through the points (quadratic through midpoints). Used for the flat highlighter.
function centerlinePath(pts) {
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[0][0] + 0.1} ${pts[0][1]}`
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`
  }
  const l = pts[pts.length - 1]
  return d + ` L ${l[0].toFixed(1)} ${l[1].toFixed(1)}`
}

// Returns { d, fill } for pens (a filled outline that follows pressure) or { d, strokeWidth } for
// the highlighter (a flat marker: constant width, square ends).
export function strokePath(stroke, { scale = 1, offset = { x: 0, y: 0 }, live = false } = {}) {
  const pts = stroke.points.map(p => [p[0] * scale + offset.x, p[1] * scale + offset.y, p[2]])
  if (stroke.tool === 'highlighter') return { d: centerlinePath(pts), strokeWidth: stroke.width * HIGHLIGHTER_FACTOR * scale }
  const outline = getStroke(pts, { size: stroke.width * scale, thinning: 0.62, smoothing: 0.5, streamline: live ? 0.35 : 0.45, simulatePressure: !stroke.pen, last: !live })
  return { d: outlineToPath(outline), fill: true }
}

export function strokeBounds(stroke) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of stroke.points) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1] }
  return { x0, y0, x1, y1 }
}
// Extent of all ink on the page, in page coordinates, so the paper grows as you draw.
export function inkBounds(elements, pos) {
  let w = 0, h = 0
  const hidden = new Set(elements.filter(e => e.hidden).map(e => e.id))
  for (const el of elements) {
    if (el.type !== 'ink' || !el.strokes?.length || (el.parent && hidden.has(el.parent))) continue
    let off = { x: 0, y: 0 }, k = 1
    if (el.parent) { const p = pos.get(el.parent); if (!p) continue; off = { x: p.x, y: p.y }; k = el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1 }
    for (const s of el.strokes) { const b = strokeBounds(s), hw = halfWidth(s); w = Math.max(w, off.x + (b.x1 + hw) * k); h = Math.max(h, off.y + (b.y1 + hw) * k) }
  }
  return { w, h }
}

const segDist = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
  return Math.hypot(ax + t * dx - x, ay + t * dy - y)
}
// Whole-stroke eraser: does the circle (x, y, radius) touch the stroke? Coordinates in stroke space.
export function hitStroke(stroke, x, y, radius) {
  const b = strokeBounds(stroke), r = radius + halfWidth(stroke)
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false
  const pts = stroke.points
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= r
  for (let i = 1; i < pts.length; i++) if (segDist(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true
  return false
}
// Partial eraser: remove the part of the stroke inside the circle. Returns null when untouched,
// otherwise the surviving pieces as new strokes (possibly none).
export function eraseStrokePartial(stroke, x, y, radius) {
  const b = strokeBounds(stroke), r = radius + halfWidth(stroke)
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return null
  const pts = stroke.points
  const keep = pts.map(p => Math.hypot(p[0] - x, p[1] - y) > r)
  const cut = new Array(pts.length).fill(false)
  for (let i = 1; i < pts.length; i++) if (keep[i - 1] && keep[i] && segDist(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) cut[i] = true
  if (keep.every(Boolean) && !cut.some(Boolean)) return null
  const out = []
  let run = []
  const flush = () => { if (run.length >= 2) out.push({ ...stroke, id: newStrokeId(), points: run }); run = [] }
  for (let i = 0; i < pts.length; i++) { if (cut[i]) flush(); if (keep[i]) run.push(pts[i]); else flush() }
  flush()
  return out
}
