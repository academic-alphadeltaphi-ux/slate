// Flow-or-pin layout. SPEC.md §5. Pure function: blocks + sidecar + measured sizes → positions.
export const FLOW_X = 48, FLOW_TOP = 48, GAP = 48, MAX_AUTO_W = 645, MIN_W = 160   // FLOW_TOP and GAP are multiples of the 24px baseline so flowed text lands on the rules
// Document mode (SPEC §20.28): the same blocks, one column, nothing pinned. A page carries `mode: "doc"` in its
// layout sidecar and every element flows in file order at a wider measure — 860px against the canvas's 645 — with
// the sheet centred and edged like a page rather than running off into empty desk.
export const DOC_W = 860, DOC_GAP = 24
export const isDoc = layout => layout?.mode === 'doc'
// The ruled-paper pitch (--lh in styles.css). A pinned element's y snaps to it, so a box that is clicked into
// existence, dragged or dropped puts its text on the rules instead of between them (SPEC §12). x is never snapped:
// the rules are horizontal. Hold Alt while dragging to place a box off the baseline.
export const RULE = 24
export const snapRule = y => Math.round(y / RULE) * RULE
export const DEFAULT_W = { text: 'auto', image: 420, file: 340, media: 480, pdf: 620 }
export const ANNOTATION_TYPES = new Set(['highlight', 'underline'])
export const OVERLAY_TYPES = new Set(['highlight', 'underline', 'ink'])   // rendered by their parent or the ink layer, never laid out
// A `file` whose src is a PDF renders as pages; older sidecars used type "file" for PDFs.
// `display: "card"` shows any document as a plain file card instead of its printout or player.
export const elementKind = e => (e.display === 'card' ? 'file' : e.type === 'file' && /\.pdf$/i.test(e.src || '') ? 'pdf' : e.type)
// The kind a document would have without `display: "card"`: what the card can expand back into.
export const inlineKind = e => (e.type === 'pdf' || (e.type === 'file' && /\.pdf$/i.test(e.src || '')) ? 'pdf' : e.type === 'media' ? 'media' : null)
export const FIRST = '__first'   // key for the anonymous first text block

export function computeLayout(blocks, layout, sizes, canvasW, doc = false) {
  const byId = new Map((layout?.elements || []).map(e => [e.id, e]))
  const items = []
  blocks.forEach((b, i) => items.push({ id: b.id || FIRST, kind: 'text', el: (b.id && byId.get(b.id)) || {}, order: i }))
  ;(layout?.elements || []).forEach((e, i) => { if (e.type !== 'text' && !OVERLAY_TYPES.has(e.type)) items.push({ id: e.id, kind: elementKind(e), el: e, order: 10000 + i }) })
  const size = id => sizes.get(id) || { w: 0, h: 0, measured: false }
  // In document mode nothing is pinned: a page written on the canvas reads as a document without moving a byte
  // on disk, and switching back puts every box exactly where it was.
  const pinned = it => !doc && typeof it.el.x === 'number' && typeof it.el.y === 'number'
  const gap = doc ? DOC_GAP : GAP
  const widthOf = it => (typeof it.el.w === 'number' ? it.el.w : DEFAULT_W[it.kind] ?? 'auto')
  const pos = new Map()
  // Pinned first. Flowed elements then stack from the top and skip past any pinned element they
  // would collide with inside the flow column, the way text wraps around a float. A box pinned
  // to the right of the text, or below it, never moves the text.
  const inColumn = (x, w) => x < FLOW_X + MAX_AUTO_W && x + (w || 0) > FLOW_X
  const obstacles = []
  for (const it of items) if (pinned(it) && !it.el.parent) {
    pos.set(it.id, { x: it.el.x, y: it.el.y, w: widthOf(it), h: it.el.h, z: it.el.z ?? 0, pinned: true, kind: it.kind })
    const s = size(it.id); if (inColumn(it.el.x, s.w)) obstacles.push({ top: it.el.y, bottom: it.el.y + s.h })
  }
  // Children of pinned parents count as obstacles for the flow; children of flowed parents are placed after it.
  const placeChildren = () => {
    let progress = true
    while (progress) {
      progress = false
      for (const it of items) if (it.el.parent && !pos.has(it.id) && pos.has(it.el.parent)) {
        const p = pos.get(it.el.parent)
        // A note placed on a document keeps its place when the document is resized.
        const k = it.el.parentW && typeof p.w === 'number' ? p.w / it.el.parentW : 1
        const x = p.x + (it.el.x || 0) * k, y = p.y + (it.el.y || 0) * k
        pos.set(it.id, { x, y, w: widthOf(it), h: it.el.h, z: (it.el.z ?? p.z) + 0.5, pinned: true, kind: it.kind, child: true, parentScale: k })
        const s = size(it.id); if (p.pinned && inColumn(x, s.w)) obstacles.push({ top: y, bottom: y + s.h })
        progress = true
      }
    }
  }
  placeChildren()
  const hasParent = it => it.el.parent && items.some(o => o.id === it.el.parent)
  let y = FLOW_TOP
  for (const it of [...items].sort((a, b) => a.order - b.order)) if (!pinned(it) && !hasParent(it)) {
    const h = size(it.id).h
    for (let guard = 0; guard < 100; guard++) {
      const hit = obstacles.find(o => o.top < y + h + gap && o.bottom + gap > y)
      if (!hit) break
      y = hit.bottom + gap
    }
    pos.set(it.id, { x: FLOW_X, y, w: doc && typeof it.el.w === 'number' ? Math.min(it.el.w, DOC_W) : widthOf(it), h: it.el.h, z: it.el.z ?? 0, pinned: false, kind: it.kind })
    y += h + gap
  }
  placeChildren()
  let w = 0, h = 0
  for (const [id, p] of pos) { const s = size(id); w = Math.max(w, p.x + s.w); h = Math.max(h, p.y + s.h) }
  return { pos, content: { w, h } }
}

// The page has no edges: always leave most of a viewport of empty paper past the content, right and down.
// A document does have edges — a sheet of a fixed width, tall enough for what is on it and a screen more.
export function pageExtent(content, canvasW, canvasH, doc = false) {
  if (doc) return { w: DOC_W + FLOW_X * 2, h: Math.max(content.h + Math.round(canvasH * 0.5), canvasH - 40) }
  return { w: Math.max(content.w + Math.round(canvasW * 0.75), canvasW + 240), h: Math.max(content.h + Math.round(canvasH * 0.75), canvasH + 240) }
}

export function maxZ(layout) { return (layout?.elements || []).reduce((m, e) => Math.max(m, e.z ?? 0), 0) }
export function minZ(layout) { return (layout?.elements || []).reduce((m, e) => Math.min(m, e.z ?? 0), 0) }

// Reading order = spatial order: pinned text blocks by (y, x), then flowed in file order. SPEC.md §4.
export function reorderBlocks(blocks, pos) {
  const keyed = blocks.map((b, i) => ({ b, i, p: pos.get(b.id || FIRST) }))
  const pinned = keyed.filter(k => k.p?.pinned).sort((a, b) => (a.p.y - b.p.y) || (a.p.x - b.p.x))
  const flowed = keyed.filter(k => !k.p?.pinned)
  const next = [...pinned, ...flowed].map(k => k.b)
  const changed = next.some((b, i) => b !== blocks[i])
  return changed ? next : blocks
}
