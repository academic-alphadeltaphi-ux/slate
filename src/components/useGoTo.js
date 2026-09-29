// Canvas-side hook for landing on a search hit (SPEC.md §20.6): given a `goTo` target, wait until the thing is
// measured, scroll the canvas so it sits in view, and return the page-space rect Canvas draws the locate flash
// around. Targets: { kind:'text', block } | { kind:'pdf', el, page } | { kind:'transcript', el } | { kind:'ink', el };
// `nonce` retriggers, so opening the same hit twice flashes twice. One mechanism for every kind: a container, a
// PDF page (PdfEl flashes the phrase itself once its text layer draws), the player (MediaEl seeks it), or the
// ink's own bounding box (ink has no DOM node; the box comes from the strokes, through the parent's offset).
import { useEffect, useRef, useState } from 'react'
import { FIRST } from '../layout.js'
import { strokeBounds, halfWidth } from '../ink.js'
import '../styles/search.css'

const FLASH_MS = 1900, TRIES = 40, RETRY_MS = 150

export function useGoTo(goTo, { canvasRef, pageRef, zoomRef, sizes, layout, pos }) {
  const [located, setLocated] = useState(null)
  const live = useRef(null); live.current = { sizes, layout, pos }     // the retry loop must see fresh measurements, not the closure's
  useEffect(() => {
    if (!goTo || !goTo.kind) return
    let tries = 0, timer = null, dead = false
    const attempt = () => {
      if (dead) return
      const c = canvasRef.current, pg = pageRef.current
      const rect = c && pg ? rectFor(goTo, live.current, pg, zoomRef.current || 1) : null
      if (!rect) { if (++tries < TRIES) timer = setTimeout(attempt, RETRY_MS); return }   // PDF pages and sizes arrive async; give up quietly after ~6 s
      const z = zoomRef.current || 1, cr = c.getBoundingClientRect(), pr = pg.getBoundingClientRect()
      // A container sits about a third down the viewport; a document page, a player or ink gets 72 px of paper above it.
      const above = goTo.kind === 'text' ? Math.round(c.clientHeight / 3) : 72
      const top = c.scrollTop + (pr.top - cr.top) + rect.y * z - above
      const left = c.scrollLeft + (pr.left - cr.left) + rect.x * z - 48
      c.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: 'smooth' })
      setLocated(rect)
      timer = setTimeout(() => { if (!dead) setLocated(null) }, FLASH_MS)
    }
    attempt()
    return () => { dead = true; clearTimeout(timer); setLocated(null) }
  }, [goTo?.nonce])
  return located
}

function elRect(id, { sizes, pos }) {
  const p = pos.get(id), s = sizes.get(id)
  return p && s && s.h > 0 ? { x: p.x, y: p.y, w: s.w, h: s.h } : null
}
// The anonymous first block is keyed FIRST; if the page has since given it an id, the lowest text block stands in.
function firstText(st) {
  const direct = elRect(FIRST, st)
  if (direct) return direct
  let best = null
  for (const [id, p] of st.pos) if (p.kind === 'text' && (!best || p.y < best.p.y)) best = { id, p }
  return best ? elRect(best.id, st) : null
}
function rectFor(g, st, pageEl, zoom) {
  if (g.kind === 'text') return g.block ? elRect(g.block, st) : firstText(st)
  if (g.kind === 'pdf') {
    const el = st.layout?.elements?.find(e => e.id === g.el)
    if (!el) return null
    if (el.hidden || el.display === 'card') return elRect(g.el, st)                       // nothing to scroll inside a card or a pill
    const node = pageEl.querySelector(`.el[data-id="${cssEscape(g.el)}"] .pdf-page[data-page="${(g.page || 1) - 1}"]`)
    if (!node) return null
    const pr = pageEl.getBoundingClientRect(), r = node.getBoundingClientRect()
    if (!r.height) return null
    return { x: (r.left - pr.left) / zoom, y: (r.top - pr.top) / zoom, w: r.width / zoom, h: r.height / zoom }
  }
  if (g.kind === 'transcript') return elRect(g.el, st)
  if (g.kind === 'ink') {
    const el = st.layout?.elements?.find(e => e.id === g.el)
    if (!el?.strokes?.length) return null
    let off = { x: 0, y: 0 }, k = 1
    if (el.parent) {
      const p = st.pos.get(el.parent); if (!p) return null
      off = { x: p.x, y: p.y }; k = el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1   // the same offset InkSvg draws with
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of el.strokes) {
      if (!s.points?.length) continue
      const b = strokeBounds(s), hw = halfWidth(s)
      x0 = Math.min(x0, b.x0 - hw); y0 = Math.min(y0, b.y0 - hw); x1 = Math.max(x1, b.x1 + hw); y1 = Math.max(y1, b.y1 + hw)
    }
    if (!isFinite(x0)) return null
    return { x: off.x + x0 * k, y: off.y + y0 * k, w: (x1 - x0) * k, h: (y1 - y0) * k }
  }
  return null
}
const cssEscape = s => (window.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'))
