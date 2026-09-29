import { memo, useMemo } from 'react'
import { strokePath } from '../ink.js'

// All strokes of the page in one SVG over the page. Strokes with a parent are translated to the
// parent's current position and scaled if the parent was resized since they were drawn.
// `colorMap` swaps the theme's neutral ink (black on light paper, white on dark) so handwriting stays readable in both.
export const InkSvg = memo(function InkSvg({ elements, pos, live, extent, colorMap = {} }) {
  const paths = useMemo(() => {
    const out = [], hidden = new Set(elements.filter(e => e.hidden).map(e => e.id))
    for (const el of elements) {
      if (el.type !== 'ink' || !Array.isArray(el.strokes)) continue
      if (el.parent && hidden.has(el.parent)) continue   // a collapsed document takes its ink with it
      let offset = { x: 0, y: 0 }, scale = 1
      if (el.parent) { const p = pos.get(el.parent); if (!p) continue; offset = { x: p.x, y: p.y }; scale = el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1 }
      for (const s of el.strokes) if (s.points?.length) out.push({ key: el.id + ':' + s.id, ...strokePath(s, { scale, offset }), color: colorMap[s.color] || s.color, tool: s.tool })
    }
    return out
  }, [elements, pos, colorMap])
  const P = ({ p }) => (p.fill
    ? <path d={p.d} fill={p.color} className={p.tool} />
    : <path d={p.d} fill="none" stroke={p.color} strokeWidth={p.strokeWidth} strokeLinecap="butt" strokeLinejoin="round" className={p.tool} />)
  const lv = live ? { ...strokePath(live.stroke, { offset: live.offset, scale: live.scale, live: true }), color: colorMap[live.stroke.color] || live.stroke.color, tool: live.stroke.tool } : null
  return (
    <svg className="ink-svg" width={extent.w} height={extent.h} viewBox={`0 0 ${extent.w} ${extent.h}`}>
      {paths.map(p => <P key={p.key} p={p} />)}
      {lv && <P p={lv} />}
    </svg>
  )
})
