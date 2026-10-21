import { memo, useMemo } from 'react'
import { strokePath } from '../ink.js'

// A committed stroke never changes, so its outline (perfect-freehand over every point) is computed once per stroke and
// frame, not on every render: with 2,963 strokes on a page, recomputing them all at each pen-up was a stall that grew with
// every line written. The point count guards the one stroke that is mutated, the live one, should it ever reach here.
const outlines = new WeakMap()
const outlineOf = (s, scale, x, y) => {
  const c = outlines.get(s)
  if (c && c.n === s.points.length && c.k === scale && c.x === x && c.y === y) return c.out
  const out = strokePath(s, { scale, offset: { x, y } })
  outlines.set(s, { n: s.points.length, k: scale, x, y, out })
  return out
}
// Declared outside the component, so React keeps each <path> mounted across renders. Declared inside, it was a new
// component type on every render, and React unmounted and recreated every stroke on the page at each pen movement.
const InkPath = memo(function InkPath({ d, fill, strokeWidth, color, tool }) {
  return fill
    ? <path d={d} fill={color} className={tool} />
    : <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="butt" strokeLinejoin="round" className={tool} />
})
// One ink element's strokes, drawn at its parent's place. Its own memo: dragging a screenshot re-renders the handwriting
// on that screenshot and nothing else, where every drag frame used to walk every stroke on the page.
const InkGroup = memo(function InkGroup({ el, x, y, k, colorMap }) {
  return el.strokes.map(s => {
    if (!s.points?.length) return null
    const o = outlineOf(s, k, x, y)
    return <InkPath key={s.id} d={o.d} fill={o.fill} strokeWidth={o.strokeWidth} color={colorMap[s.color] || s.color} tool={s.tool} />
  })
})

// All strokes of the page in one SVG over the page. Strokes with a parent are translated to the
// parent's current position and scaled if the parent was resized since they were drawn.
// `colorMap` swaps the theme's neutral ink (black on light paper, white on dark) so handwriting stays readable in both.
// The stroke being drawn is not a prop: the canvas writes it straight into `liveRef`'s path at each pen movement, so
// writing never re-renders the page (drawLive in Canvas.jsx).
export const InkSvg = memo(function InkSvg({ elements, pos, extent, colorMap = {}, liveRef }) {
  const hidden = useMemo(() => new Set(elements.filter(e => e.hidden).map(e => e.id)), [elements])
  return (
    <svg className="ink-svg" width={extent.w} height={extent.h} viewBox={`0 0 ${extent.w} ${extent.h}`}>
      {elements.map(el => {
        if (el.type !== 'ink' || !Array.isArray(el.strokes)) return null
        if (el.parent && hidden.has(el.parent)) return null   // a collapsed document takes its ink with it
        let x = 0, y = 0, k = 1
        if (el.parent) { const p = pos.get(el.parent); if (!p) return null; x = p.x; y = p.y; k = el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1 }
        return <InkGroup key={el.id} el={el} x={x} y={y} k={k} colorMap={colorMap} />
      })}
      {liveRef && <path ref={liveRef} data-live="" />}
    </svg>
  )
})
