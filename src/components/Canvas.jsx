import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { computeLayout, pageExtent, reorderBlocks, maxZ, minZ, FIRST, FLOW_X, MAX_AUTO_W, DOC_W, isDoc, MIN_W, DEFAULT_W, ANNOTATION_TYPES, OVERLAY_TYPES, elementKind, inlineKind, snapRule } from '../layout.js'
import { buildExtensions } from '../editor/extensions.js'
import { createRenderer } from '../editor/markdown.js'
import { newId } from '../editor/ids.js'
import TextBlock from './TextBlock.jsx'
import Toolbar from './Toolbar.jsx'
import ConflictBanner from './ConflictBanner.jsx'
import { FileCard, ImageEl, MediaEl, HiddenCard } from './Elements.jsx'
import PdfEl from './PdfEl.jsx'
import ContextMenu from './ContextMenu.jsx'
import { InkSvg } from './Ink.jsx'
import { Icon } from './Icons.jsx'
import Tools, { stepZoom } from './Tools.jsx'
import { useDialog } from './Dialog.jsx'
import { useGoTo } from './useGoTo.js'
import { compactPoint, hitStroke, eraseStrokePartial, newStrokeId, inkBounds, INK_SIZES, ERASER_SIZES, defaultInkColor, inkColorMap } from '../ink.js'
import { hitInkAt, inkMenuItems, textBlockFromInk, penBox } from '../hwr.js'
import InkTextCard from './InkText.jsx'
import { openAsk } from '../ask.js'
import { THIS as ED } from '../edition.js'
import { start as startDictation, supported as dictationSupported, joinPhrase } from '../dictate.js'

const ls = { get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { } } }
const INK_COLORS_UI = ['#1d1d1f', '#f2f2f7', '#2563eb', '#e11d48', '#16a34a', '#ea580c', '#7c3aed', '#ffd60a']
const isTyping = () => { const a = document.activeElement; return !!a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable) }

// The page: an edge-less surface of flowed and pinned elements. SPEC.md §5, §7, §8.
// `active`: the pane that owns the keyboard (SPEC §20.10); an inactive pane still saves on ⌘S. `goTo`: a search target
// { kind:'text'|'pdf'|'transcript'|'ink', block?, el?, page?, t?, nonce } (SPEC §20.6) — the search group's useGoTo consumes it.
const Canvas = forwardRef(function Canvas({ page, external, onStatus, onOpenTitle, highlights, onSetHighlights, dark = false, adaptInk = true, active = true, goTo = null, className = '', dataSrc = null }, ref) {
  const dialog = useDialog()
  const [blocks, setBlocks] = useState(() => page.blocks.map(b => ({ ...b })))
  const [layout, setLayout] = useState(() => structuredClone(page.layout))
  const [sizes, setSizes] = useState(() => new Map())
  const [focused, setFocused] = useState(null)
  const [focusPoint, setFocusPoint] = useState(null)
  const [editor, setEditor] = useState(null)
  const editorRef = useRef(null); editorRef.current = editor   // dictation inserts through whichever block has the cursor
  const [canvasW, setCanvasW] = useState(1000)
  const [canvasH, setCanvasH] = useState(700)
  const [zoom, setZoom] = useState(() => ls.get('slate.zoom', 1))
  const [dragPos, setDragPos] = useState(null)
  const [resizing, setResizing] = useState(null)
  const [conflict, setConflict] = useState(null)
  const [elMenu, setElMenu] = useState(null)
  const [tool, setTool] = useState(() => ({ mode: 'select', color: defaultInkColor(), size: INK_SIZES[2], eraser: 'stroke', eraserSize: ERASER_SIZES[1] }))
  const [live, setLive] = useState(null)
  const [penInfo, setPenInfo] = useState(null)
  const [eraserPos, setEraserPos] = useState(null)
  const [lasso, setLasso] = useState(null)      // the live lasso polygon, page coordinates
  const [clip, setClip] = useState(null)        // the live clip rectangle, page coordinates
  const [clipped, setClipped] = useState(null)  // the clip just taken, and the offer to ask about it
  const [sel, setSel] = useState(null)          // { keys: Set('inkId:strokeId'), box: { x, y, w, h } }
  const selRef = useRef(null); selRef.current = sel
  const colorMap = useMemo(() => inkColorMap(adaptInk, dark), [adaptInk, dark])
  const [histN, setHistN] = useState(0)
  // The blocks the sync wrote, so they can be drawn as a quoted card rather than as your own writing (SPEC
  // §20.23). Anything typed afterwards is a new block and sits outside the card, on the page proper.
  const quoted = useMemo(() => {
    const tags = Array.isArray(page?.frontmatter?.tags) ? page.frontmatter.tags : []
    const isAnn = /\/Announcements\//.test(page?.path || '') || page?.frontmatter?.kind === 'announcement'
    if (!tags.includes('quercus') && !isAnn) return { has: () => false, kind: '', label: '' }
    const ids = new Set((page.blocks || []).map(b => b.id || FIRST))
    return { has: id => ids.has(id), kind: isAnn ? 'announcement' : 'page', label: isAnn ? 'From Quercus · announcement' : 'From Quercus' }
  }, [page])
  const blocksRef = useRef(blocks), layoutRef = useRef(layout)
  const hashRef = useRef(page.hash), layoutHashRef = useRef(page.layoutHash)
  const timers = useRef({})
  const dragRef = useRef(null), resizeRef = useRef(null), inkRef = useRef(null)
  const toolRef = useRef(tool), focusedRef = useRef(null), zoomRef = useRef(zoom), inkEndedAt = useRef(0)
  const activeRef = useRef(active); activeRef.current = active
  // Mirrors read by the imperative handle and the unmount save (declared once; hwr sets hwrRef to its in-flight promise).
  const posRef = useRef(null), sizesRef = useRef(null), contentRef = useRef({ w: 0, h: 0 }), hwrRef = useRef(null), savePageRef = useRef(null), saveLayoutRef = useRef(null)
  const [inkText, setInkText] = useState(null)   // hwr: { id, busy?, error?, hover? } — the recognised-text card
  const hist = useRef({ undo: [], redo: [] })
  const canvasRef = useRef(null), pageRef = useRef(null)
  const firstIdRef = useRef(null), handlers = useRef({})
  toolRef.current = tool; focusedRef.current = focused; zoomRef.current = zoom
  const updateBlocks = next => { blocksRef.current = typeof next === 'function' ? next(blocksRef.current) : next; setBlocks(blocksRef.current) }
  const updateLayout = next => { layoutRef.current = typeof next === 'function' ? next(layoutRef.current) : next; setLayout(layoutRef.current) }
  useEffect(() => { ls.set('slate.zoom', zoom) }, [zoom])

  // ---- editor plumbing --------------------------------------------------------------------
  const resolveSrc = useCallback(src => (/^(https?:|data:|blob:|\/)/.test(src || '') ? src : api.fileUrl(page.dir, src)), [page.dir])
  const extensions = useMemo(() => buildExtensions({ resolveSrc, placeholder: 'Write…' }), [resolveSrc])
  const renderer = useMemo(() => createRenderer(extensions), [extensions])
  useEffect(() => () => renderer.destroy(), [renderer])

  // ---- measuring ----------------------------------------------------------------------------
  const ro = useMemo(() => new ResizeObserver(entries => setSizes(prev => {
    let m = prev
    for (const en of entries) {
      const id = en.target.dataset.id, w = en.target.offsetWidth, h = en.target.offsetHeight, p = m.get(id)
      if (!p || p.w !== w || p.h !== h) { if (m === prev) m = new Map(prev); m.set(id, { w, h }) }
    }
    return m
  })), [])
  useEffect(() => () => ro.disconnect(), [ro])
  const observe = useCallback(el => { if (!el) return; ro.observe(el); return () => ro.unobserve(el) }, [ro])
  useLayoutEffect(() => {
    const el = canvasRef.current; if (!el) return
    const r = new ResizeObserver(() => { setCanvasW(el.clientWidth); setCanvasH(el.clientHeight) }); r.observe(el); setCanvasW(el.clientWidth); setCanvasH(el.clientHeight)
    return () => r.disconnect()
  }, [])

  const effectiveLayout = useMemo(() => {
    if (!dragPos && !resizing) return layout
    return { ...layout, elements: layout.elements.map(e => e.id === dragPos?.id ? { ...e, x: dragPos.x, y: dragPos.y } : e.id === resizing?.id ? { ...e, w: resizing.w, ...(resizing.h != null ? { h: resizing.h } : {}) } : e) }
  }, [layout, dragPos, resizing])
  // Document mode (SPEC §20.28): one column, nothing pinned, a wider measure. It is a property of the page, kept in
  // the layout sidecar, so a page reads the same way every time it is opened — and switching back is lossless,
  // because nothing on disk moves.
  const doc = isDoc(layout)
  const setDoc = on => { commit(); updateLayout(cur => ({ ...cur, mode: on ? 'doc' : undefined })); scheduleLayout(); if (on) setTool(t => ({ ...t, mode: 'select' })) }
  const measure = doc ? DOC_W : MAX_AUTO_W
  const { pos, content } = useMemo(() => computeLayout(blocks, effectiveLayout, sizes, canvasW / zoom, doc), [blocks, effectiveLayout, sizes, canvasW, zoom, doc])
  posRef.current = pos; sizesRef.current = sizes; contentRef.current = content
  const located = useGoTo(goTo, { canvasRef, pageRef, zoomRef, sizes, layout, pos })
  const extent = useMemo(() => {
    const ink = inkBounds(layout.elements, pos)
    let w = Math.max(content.w, ink.w), h = Math.max(content.h, ink.h)
    if (live) { for (const p of live.stroke.points) { w = Math.max(w, live.offset.x + p[0] + 20); h = Math.max(h, live.offset.y + p[1] + 20) } }
    return pageExtent({ w, h }, canvasW / zoom, canvasH / zoom, doc)
  }, [content, layout, pos, live, canvasW, canvasH, zoom, doc])

  // ---- history: every canvas action except typing (TipTap has its own undo) ---------------------
  const snapshot = () => ({ blocks: blocksRef.current, layout: layoutRef.current })
  const commit = () => { const h = hist.current; h.undo.push(snapshot()); if (h.undo.length > 100) h.undo.shift(); h.redo = []; setHistN(n => n + 1) }
  // Recognised handwriting is not a canvas action (SPEC §20.9): a restored snapshot carries the current text fields of
  // its ink elements, so undo never drops them from the next save (staleness still shows when the strokes differ).
  const carryInkText = snap => ({ ...snap, elements: snap.elements.map(e => { if (e.type !== 'ink' || e.text !== undefined) return e; const cur = layoutRef.current.elements.find(x => x.id === e.id); return cur?.text === undefined ? e : { ...e, text: cur.text, textAt: cur.textAt, inkHash: cur.inkHash, lines: cur.lines } }) })
  const restore = s => { setFocused(null); setEditor(null); updateBlocks(s.blocks); updateLayout(carryInkText(s.layout)); schedulePage(); scheduleLayout() }
  const undo = () => { const h = hist.current; if (!h.undo.length) return; h.redo.push(snapshot()); restore(h.undo.pop()); setHistN(n => n + 1) }
  const redo = () => { const h = hist.current; if (!h.redo.length) return; h.undo.push(snapshot()); restore(h.redo.pop()); setHistN(n => n + 1) }

  // ---- saving --------------------------------------------------------------------------------
  const sv = useRef({ page: { version: 0, saved: 0, inFlight: false }, layout: { version: 0, saved: 0, inFlight: false } })
  const dirtyPage = () => sv.current.page.version !== sv.current.page.saved
  const dirtyLayout = () => sv.current.layout.version !== sv.current.layout.saved
  const conflictRef = useRef(null); conflictRef.current = conflict
  const savePage = useCallback(async () => {
    clearTimeout(timers.current.page)
    const st = sv.current.page
    if (st.inFlight || st.version === st.saved) return
    st.inFlight = true
    const version = st.version, b = blocksRef.current
    try {
      onStatus('saving')
      const r = await api.savePage(page.path, b, hashRef.current)
      hashRef.current = r.hash; st.saved = version
      if (r.blocks?.some((x, i) => x.id !== b[i]?.id)) {
        b.forEach((x, i) => { if (!x.id && r.blocks[i]?.id) adoptFirstId(r.blocks[i].id) })
        const given = new Map(b.map((x, i) => [x, r.blocks[i]?.id]))   // by the block sent, not by index: a box removed mid-flight shifted every anchor
        updateBlocks(cur => cur.map(x => (given.get(x) && given.get(x) !== x.id ? { ...x, id: given.get(x) } : x)))
      }
      onStatus('saved')
    } catch (e) {
      if (e.status === 409) { conflictRef.current = { kind: 'page', current: e.data.current }; setConflict(conflictRef.current); onStatus('conflict') } else { onStatus('error'); console.error(e) }   // still dirty: the banner decides, never a silent reload (review 2026-09-18)
    } finally {
      st.inFlight = false
      if (st.version !== st.saved && !conflictRef.current) savePage()
    }
  }, [page.path, onStatus])
  const addFilesRef = useRef(null)
  const recogniseRef = useRef(() => Promise.resolve())
  const saveLayout = useCallback(async () => {
    clearTimeout(timers.current.layout)
    if (hwrRef.current) await hwrRef.current   // a recognition in flight writes the sidecar first (SPEC §20.9)
    const st = sv.current.layout
    if (st.inFlight || st.version === st.saved) return
    st.inFlight = true
    const version = st.version
    try {
      const ids = new Set(blocksRef.current.map(b => b.id).filter(Boolean))
      const pruned = { ...layoutRef.current, elements: layoutRef.current.elements.filter(e => e.type !== 'text' || ids.has(e.id)) }
      if (pruned.elements.length !== layoutRef.current.elements.length) updateLayout(pruned)
      const r = await api.saveLayout(page.path, pruned, layoutHashRef.current)
      if (r.layoutHash !== undefined) layoutHashRef.current = r.layoutHash
      st.saved = version
    } catch (e) {
      if (e.status === 409) { conflictRef.current = { kind: 'layout', current: e.data.current }; setConflict(conflictRef.current) } else console.error(e)
    } finally {
      st.inFlight = false
      if (st.version !== st.saved && !conflictRef.current) saveLayout()
    }
  }, [page.path])
  const schedulePage = () => { sv.current.page.version++; clearTimeout(timers.current.page); timers.current.page = setTimeout(savePage, 500) }
  const scheduleLayout = () => { sv.current.layout.version++; clearTimeout(timers.current.layout); timers.current.layout = setTimeout(saveLayout, 300) }
  savePageRef.current = savePage; saveLayoutRef.current = saveLayout
  // One new text container through the page's own hash-checked save; ⌘Z removes it. `below: true` pins it one rule
  // under the page's content (ask's Save as note, and a spoken phrase with no cursor anywhere); `after: <id>` pins it
  // under a pinned block or inserts it next in file order; otherwise it flows at the end. Returns the new id.
  const appendBlock = (md, { after, below } = {}) => {
    const id = newId(); commit()
    const cur = blocksRef.current, i = after ? cur.findIndex(b => (b.id || FIRST) === after) : -1
    updateBlocks(bs => (i >= 0 ? [...bs.slice(0, i + 1), { id, md }, ...bs.slice(i + 1)] : [...bs, { id, md }]))
    const p = after ? posRef.current?.get(after) : null, sz = after ? sizesRef.current?.get(after) : null
    if (below && !isDoc(layoutRef.current)) { const c = contentRef.current; updateLayout(l => ({ ...l, elements: [...l.elements, { id, type: 'text', x: FLOW_X, y: snapRule(c.h + 24), w: 'auto', z: maxZ(l) + 1 }] })); scheduleLayout() }
    else if (p?.pinned) { updateLayout(l => ({ ...l, elements: [...l.elements, { id, type: 'text', x: p.x, y: snapRule(p.y + (sz?.h || 0) + 24), w: p.w, z: maxZ(l) + 1 }] })); scheduleLayout() }
    schedulePage()
    return id
  }
  const appendBlockRef = useRef(appendBlock); appendBlockRef.current = appendBlock
  // The handle the shell, the ask rail, history and export call (SPEC §20.7, §20.10). Declared after saveLayout and
  // the schedulers so nothing is in its temporal dead zone; saves go through the refs so the deps stay [page.path].
  useImperativeHandle(ref, () => ({
    async patchFrontmatter(patch) { await savePageRef.current(); const r = await api.frontmatter(page.path, patch); hashRef.current = r.hash; return r },
    addFiles: files => addFilesRef.current(files),
    // One new text container through the page's own hash-checked save; ⌘Z removes it. `below: true` pins it one rule
    // under the page's content (ask's Save as note); `after: <id>` pins it under a pinned block or inserts it next in
    // file order; otherwise it flows at the end. Returns the new id.
    appendBlock: (md, opts) => appendBlockRef.current(md, opts),
    // Read whatever ink is not yet read, now. Ask calls this before it sends, so a question typed seconds after a
    // sentence was written is answered about the sentence and not about "stroke data you cannot read".
    recogniseInk: () => recogniseRef.current(),
    // Every pending save written and acknowledged (export's print view, history's restore).
    async flush() {
      clearTimeout(timers.current.page); clearTimeout(timers.current.layout)
      await savePageRef.current(); await saveLayoutRef.current()
      while (sv.current.page.inFlight || sv.current.layout.inFlight || dirtyPage() || dirtyLayout()) {
        await new Promise(r => setTimeout(r, 50))
        if (!sv.current.page.inFlight && dirtyPage()) await savePageRef.current()
        if (!sv.current.layout.inFlight && dirtyLayout()) await saveLayoutRef.current()
        if (conflictRef.current) break
      }
      return !conflictRef.current   // false: a save above hit the conflict banner, so the page is not fully on disk (history's restore stops there; SPEC §20.10)
    },
    // Replace text and/or layout wholesale (history's restore): committed, so ⌘Z reverts it; saved through the hash checks.
    replace({ blocks, layout } = {}) {
      commit(); setFocused(null); setEditor(null); setSel(null); firstIdRef.current = null
      if (blocks) { updateBlocks(blocks.map(b => ({ ...b }))); schedulePage() }
      if (layout) { updateLayout(structuredClone(layout)); scheduleLayout() }
    },
  }), [page.path])
  useEffect(() => () => {
    clearTimeout(timers.current.page); clearTimeout(timers.current.layout)
    // Ink written in the last few seconds has an idle pass pending that this unmount is about to cancel. Writing and
    // then closing the page is the ordinary way to leave a lecture, and it must not be the one case where the words
    // are never read. The server does it instead: no component state to update, and the strokes are on disk by then
    // because the layout save below is awaited first (SPEC §20.51).
    const pending = hwrIdle.current !== null && autoHwr.current
    clearTimeout(hwrIdle.current); hwrIdle.current = null
    // Dirty saves on unmount wait for a recognition in flight, so its sidecar write is never overwritten.
    const go = async () => {
      const saves = []
      // A save that fails here has no banner to show: the words go to localStorage under the page's path and come back
      // as a marked "Recovered" block the next time the page opens (review of 2026-09-18), rather than vanishing.
      const stash = (kind, e) => { try { const k = 'slate.unsaved:' + page.path, cur = ls.get(k, {}) || {}; cur[kind] = { at: Date.now(), status: e?.status || null, ...(kind === 'page' ? { blocks: blocksRef.current } : { layout: layoutRef.current }) }; ls.set(k, cur) } catch { } }
      if (dirtyPage()) saves.push(api.savePage(page.path, blocksRef.current, hashRef.current).catch(e => stash('page', e)))
      if (dirtyLayout()) saves.push(api.saveLayout(page.path, layoutRef.current, layoutHashRef.current).catch(e => stash('layout', e)))
      if (!pending) return
      await Promise.all(saves)
      api.hwr(page.path).catch(() => { })
    }
    if (hwrRef.current) hwrRef.current.then(go, go); else go()
  }, [page.path])
  // Text a previous unmount could not save (above) comes back as one block, marked, for the student to keep or delete: only the
  // containers whose words differ from what is on disk now. A stashed layout (ink) is not merged blindly; it is logged.
  useEffect(() => {
    const k = 'slate.unsaved:' + page.path
    const st = ls.get(k, null); if (!st) return
    try { localStorage.removeItem(k) } catch { }
    const stashed = st.page?.blocks
    if (Array.isArray(stashed) && stashed.length) {
      const cur = new Map(blocksRef.current.map(b => [b.id || FIRST, b.md]))
      const lost = stashed.filter(b => String(b.md || '').trim() && cur.get(b.id || FIRST) !== b.md).map(b => b.md)
      if (lost.length) {
        const when = new Date(st.page.at || Date.now()).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        appendBlockRef.current(`> **Recovered** — written ${when} but not saved (the page had changed on disk). Keep what you need and delete the rest.\n\n${lost.join('\n\n')}`)
      }
    }
    if (st.layout) console.warn('[slate] ink or layout from', new Date(st.layout.at || 0).toISOString(), 'could not be saved when this page was last closed')
  }, [page.path])

  // ---- keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    const h = e => {
      const mod = e.metaKey || e.ctrlKey
      if (!activeRef.current) { if (mod && e.key === 's') { e.preventDefault(); savePage(); saveLayout() } return }   // an inactive pane only saves
      if (mod && e.key === 's') { e.preventDefault(); savePage(); saveLayout(); return }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(z => stepZoom(z, 1)); return }
      if (mod && e.key === '-') { e.preventDefault(); setZoom(z => stepZoom(z, -1)); return }
      if (mod && e.key === '0') { e.preventDefault(); setZoom(1); return }
      if (mod && e.key.toLowerCase() === 'z' && !focusedRef.current && !isTyping()) { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if (mod || e.altKey || isTyping()) return
      const k = e.key.toLowerCase()
      if (k === 'escape' && inkText) { setInkText(null); return }
      if (selRef.current && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); deleteSelection(); return }
      if (k === 'escape' && selRef.current) { setSel(null); return }
      if (k === 'v' || k === 'escape') setTool(t => ({ ...t, mode: 'select' }))
      else if (k === 'l') setTool(t => ({ ...t, mode: t.mode === 'lasso' ? 'select' : 'lasso' }))
      else if (k === 'c') setTool(t => ({ ...t, mode: t.mode === 'clip' ? 'select' : 'clip' }))
      else if (k === 'p' || k === 'd') setTool(t => ({ ...t, mode: t.mode === 'pen' ? 'select' : 'pen' }))
      else if (k === 'h') setTool(t => ({ ...t, mode: t.mode === 'highlighter' ? 'select' : 'highlighter' }))
      else if (k === 'e') setTool(t => ({ ...t, mode: t.mode === 'eraser' ? 'select' : 'eraser' }))
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [savePage, saveLayout, inkText])
  // Pinch (ctrl+wheel) zooms the page around the cursor, not the browser: the page point under
  // the cursor is put back under it after the zoom. The scaler's offset inside the canvas (the
  // top bar spacer) does not scale, so it is added back separately.
  useEffect(() => {
    const el = canvasRef.current; if (!el) return
    const onWheel = e => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const z0 = zoomRef.current, z1 = Math.min(3, Math.max(0.5, z0 * Math.exp(-e.deltaY * 0.01)))
      if (z1 === z0) return
      const r = el.getBoundingClientRect(), pr = pageRef.current.getBoundingClientRect(), sc = pageRef.current.parentElement
      const px = (e.clientX - pr.left) / z0, py = (e.clientY - pr.top) / z0
      zoomRef.current = z1; setZoom(z1)
      requestAnimationFrame(() => { el.scrollLeft = sc.offsetLeft + px * z1 - (e.clientX - r.left); el.scrollTop = sc.offsetTop + py * z1 - (e.clientY - r.top) })
    }
    el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- external changes (Claude, Obsidian, a terminal) ------------------------------------
  useEffect(() => {
    if (!external) return
    const busy = conflictRef.current || dirtyPage() || dirtyLayout() || focused || dragRef.current || resizeRef.current || inkRef.current
    if (busy) { setConflict(c => c || { kind: external.kind === 'layout' ? 'layout' : 'page', external: true }); return }
    api.page(page.path).then(p => { hashRef.current = p.hash; layoutHashRef.current = p.layoutHash; updateBlocks(p.blocks); updateLayout(p.layout); onStatus('reloaded') }).catch(() => { })
  }, [external])
  const reloadFromDisk = async () => {
    const p = await api.page(page.path)
    hashRef.current = p.hash; layoutHashRef.current = p.layoutHash
    sv.current.page.saved = sv.current.page.version; sv.current.layout.saved = sv.current.layout.version
    setFocused(null); setEditor(null)
    updateBlocks(p.blocks); updateLayout(p.layout); setConflict(null); onStatus('reloaded')
  }
  // Keep mine keeps the side that is yours — the one that is dirty, or the one the 409 came from — and takes disk for the
  // other: re-saving both wrote a stale in-memory layout over highlights Claude had just made (review 2026-09-18).
  const keepMine = async () => {
    const kind = conflictRef.current?.kind
    const p = await api.page(page.path)
    hashRef.current = p.hash; layoutHashRef.current = p.layoutHash
    const dp = dirtyPage() || kind === 'page', dl = dirtyLayout() || kind === 'layout'
    if (!dp) { updateBlocks(p.blocks); sv.current.page.saved = sv.current.page.version }
    if (!dl) { updateLayout(carryInkText(p.layout)); sv.current.layout.saved = sv.current.layout.version }
    if (dp) sv.current.page.version++
    if (dl) sv.current.layout.version++
    conflictRef.current = null; setConflict(null)
    if (dp) await savePage()
    if (dl) await saveLayout()
  }

  // ---- coordinates ----------------------------------------------------------------------------
  const pagePoint = e => { const r = pageRef.current.getBoundingClientRect(), z = zoomRef.current; return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z } }

  // ---- block editing -----------------------------------------------------------------------
  // The anonymous first block keeps its React key when it gets an id, so its element survives
  // (a focused editor, a drag in progress); its measured size and focus are carried over.
  const adoptFirstId = real => {
    firstIdRef.current = real
    setSizes(prev => { if (!prev.has(FIRST)) return prev; const m = new Map(prev); m.set(real, prev.get(FIRST)); return m })
    if (focusedRef.current === FIRST) setFocused(real)
  }
  const ensureId = id => {
    if (id !== FIRST) return id
    const real = newId()
    adoptFirstId(real)
    updateBlocks(cur => cur.map((b, i) => (i === 0 && !b.id ? { ...b, id: real } : b)))
    schedulePage()
    return real
  }
  const ensureElement = (id, extra = {}) => {
    const real = ensureId(id)
    if (!layoutRef.current.elements.some(e => e.id === real)) updateLayout(cur => ({ ...cur, elements: [...cur.elements, { id: real, type: 'text', w: 'auto', ...extra }] }))
    return real
  }
  const setBlockMd = (id, md) => {
    const cur = blocksRef.current.find(b => (b.id || FIRST) === id)
    if (!cur || cur.md === md) return
    updateBlocks(bs => bs.map(b => (b === cur ? { ...b, md } : b)))
    schedulePage()
  }
  const focusBlock = (id, point) => { if (toolRef.current.mode !== 'select') return; setFocused(id); setFocusPoint(point || null) }
  const blurBlock = id => {
    setFocused(cur => (cur === id ? null : cur)); setEditor(ed => (focusedRef.current === id || focusedRef.current === null ? null : ed))   // a click straight into another box has already registered that box's editor
    const b = blocksRef.current.find(x => (x.id || FIRST) === id)
    if (b && !b.md.trim()) {   // an empty box never stays behind
      updateBlocks(cur => cur.filter(x => x !== b))
      if (b.id) { updateLayout(cur => ({ ...cur, elements: cur.elements.filter(e => e.id !== b.id) })); scheduleLayout() }
      sv.current.page.version++
    }
    savePage()
  }
  // A *double* click opens a box. A single click used to, which meant every click on the paper — to dismiss a menu,
  // to put the cursor somewhere, to stop drawing — left an empty box behind (SPEC §20.28).
  // In document mode it used to do nothing at all, on the theory that ⏎ at the end of a block adds the next one: so a
  // sheet you had just switched to a page, or whose writing ended above where you clicked, could not be typed on at
  // all (SPEC §20.40). It now carries on where the writing left off — the column's last box if it is still empty,
  // otherwise a new one under it — instead of pinning a box wherever the pointer happened to be.
  const onCanvasClick = e => {
    if (e.target !== e.currentTarget || e.detail !== 2) return
    if (toolRef.current.mode !== 'select' || Date.now() - inkEndedAt.current < 300) return
    if (doc) {
      const cur = blocksRef.current, last = cur[cur.length - 1]
      setFocusPoint(null)
      setFocused(last && !last.md.trim() ? last.id || FIRST : appendBlock(''))
      return
    }
    const pt = pagePoint(e)
    const x = Math.max(8, Math.round(pt.x)), y = Math.max(0, snapRule(pt.y - 10))
    const id = newId()
    commit()
    updateBlocks(cur => [...cur, { id, md: '' }])
    updateLayout(cur => ({ ...cur, elements: [...cur.elements, { id, type: 'text', x, y, w: 'auto', z: maxZ(cur) + 1 }] }))
    schedulePage(); scheduleLayout()
    setFocused(id); setFocusPoint(null)
  }
  const setBlockStyle = patch => {
    if (!focused) return
    const real = ensureElement(focused)
    updateLayout(cur => ({ ...cur, elements: cur.elements.map(e => {
      if (e.id !== real) return e
      const style = { ...(e.style || {}), ...patch }
      for (const k of Object.keys(style)) if (style[k] == null) delete style[k]
      return { ...e, style }
    }) }))
    if (real !== focused) setFocused(real)
    scheduleLayout()
  }

  // ---- elements: annotations, notes on a document, menu -------------------------------------------
  const addAnnotation = (parentId, a) => { commit(); updateLayout(cur => ({ ...cur, elements: [...cur.elements, { id: newId(), parent: parentId, ...a }] })); scheduleLayout() }
  const patchElement = (id, patch, record = false) => { if (record) commit(); updateLayout(cur => ({ ...cur, elements: cur.elements.map(e => (e.id === id ? { ...e, ...patch } : e)) })); scheduleLayout() }
  const removeElement = id => {
    commit()
    const b = blocksRef.current.find(x => x.id === id)
    if (b) { updateBlocks(cur => cur.filter(x => x !== b)); schedulePage() }
    updateLayout(cur => ({ ...cur, elements: cur.elements.filter(e => e.id !== id && e.parent !== id) }))
    if (focusedRef.current === id) { setFocused(null); setEditor(null) }
    scheduleLayout()
  }
  // Text boxes go by their key (the anonymous first block has no id).
  const removeBlock = key => {
    const b = blocksRef.current.find(x => (x.id || FIRST) === key); if (!b) return
    commit()
    updateBlocks(cur => cur.filter(x => x !== b)); schedulePage()
    if (b.id) { updateLayout(cur => ({ ...cur, elements: cur.elements.filter(e => e.id !== b.id && e.parent !== b.id) })); scheduleLayout() }
    if (focusedRef.current === key) { setFocused(null); setEditor(null) }
  }
  const addNote = (parentId, x, y) => {
    if (toolRef.current.mode !== 'select') return
    const id = newId(), pw = pos.get(parentId)?.w
    commit()
    updateBlocks(cur => [...cur, { id, md: '' }])
    updateLayout(cur => ({ ...cur, elements: [...cur.elements, { id, type: 'text', parent: parentId, ...(typeof pw === 'number' ? { parentW: pw } : {}), x, y, w: 'auto', z: maxZ(cur) + 1 }] }))
    schedulePage(); scheduleLayout()
    setFocused(id); setFocusPoint(null)
  }
  const elementMenu = (e, el, kind) => {
    e.preventDefault(); e.stopPropagation()
    const at = { x: e.clientX, y: e.clientY }
    if (kind === 'text') {
      setElMenu({ at, items: [{ label: 'Delete this text box', danger: true, onClick: () => removeBlock(el.key) }] })
      return
    }
    const name = decodeURIComponent((el.src || '').split('/').pop()), inline = inlineKind(el)
    setElMenu({ at, items: [
      { label: 'Open in a new tab', onClick: () => window.open(resolveSrc(el.src), '_blank', 'noopener') },
      ...(inline ? [{ label: el.display === 'card' ? (inline === 'pdf' ? 'Show as printout (pages)' : 'Show as player') : 'Show as file card', onClick: () => patchElement(el.id, { display: el.display === 'card' ? undefined : 'card' }, true) }] : []),
      { label: el.hidden ? 'Show' : 'Hide (collapse to a pill)', onClick: () => patchElement(el.id, { hidden: !el.hidden }, true) },
      { label: 'Bring to front', onClick: () => patchElement(el.id, { z: maxZ(layoutRef.current) + 1 }, true) },
      { label: 'Send to back', onClick: () => patchElement(el.id, { z: minZ(layoutRef.current) - 1 }, true) },
      { label: 'Reveal in Finder', onClick: () => api.reveal(`${page.dir}/${el.src}`).catch(err => dialog.alert(err.message)) },
      '-',
      { label: 'Remove from page (keeps the file)', danger: true, onClick: () => removeElement(el.id) },
      { label: 'Delete file (moves it to the trash)', danger: true, onClick: async () => {
        if (!(await dialog.confirm({ title: `Delete “${name}”?`, message: 'The file moves to Notebooks/.trash and its notes and highlights leave this page.', confirmLabel: 'Delete file', danger: true }))) return
        removeElement(el.id); api.trashAsset(page.path, el.src).catch(err => dialog.alert(err.message))
      } },
    ] })
  }

  // ---- ink ----------------------------------------------------------------------------------------
  // A pen always draws; the mouse draws when a drawing tool is chosen. Strokes over a document are
  // stored relative to it (and to its width at the time), so they follow it when it moves or is resized.
  const eraseAt = (x, y) => {
    const t = toolRef.current, r = t.eraserSize
    let changed = false
    const next = []
    for (const el of layoutRef.current.elements) {
      if (el.type !== 'ink' || !el.strokes?.length) { next.push(el); continue }
      let off = { x: 0, y: 0 }, k = 1
      if (el.parent) { const p = pos.get(el.parent); if (!p) { next.push(el); continue }; off = { x: p.x, y: p.y }; k = el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1 }
      const lx = (x - off.x) / k, ly = (y - off.y) / k, lr = r / k
      const strokes = []
      for (const s of el.strokes) {
        if (t.eraser === 'partial') { const pieces = eraseStrokePartial(s, lx, ly, lr); if (pieces === null) strokes.push(s); else { changed = true; strokes.push(...pieces) } }
        else if (hitStroke(s, lx, ly, lr)) changed = true
        else strokes.push(s)
      }
      if (strokes.length) next.push(strokes.length === el.strokes.length && !changed ? el : { ...el, strokes })
    }
    if (!changed) return
    if (!inkRef.current?.committed) { commit(); if (inkRef.current) inkRef.current.committed = true }
    updateLayout(cur => ({ ...cur, elements: next })); scheduleLayout()
  }
  const addInkPoints = e => {
    const st = inkRef.current; if (!st || st.eraser) return
    const r = pageRef.current.getBoundingClientRect(), ne = e.nativeEvent || e, z = zoomRef.current
    const evs = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents() : []
    for (const ev of (evs.length ? evs : [ne])) {
      const pt = compactPoint((ev.clientX - r.left) / z - st.scope.offset.x, (ev.clientY - r.top) / z - st.scope.offset.y, ev.pressure, ev.timeStamp - st.t0)
      const last = st.stroke.points[st.stroke.points.length - 1]
      if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.6 && Math.abs(pt[2] - last[2]) < 0.05) continue
      st.stroke.points.push(pt)
    }
  }
  const onInkDown = e => {
    if (e.pointerType === 'touch') return
    const t = toolRef.current, isPen = e.pointerType === 'pen'
    if (t.mode === 'select' && !isPen) return
    if (e.target.closest('.tools, .toolbar, .annot-bar, .ctx, .grip, .handle, .meta-pop, .palette-edit, .hidden-card, .banner, .el-head, .sel-box, .sel-bar, .ink-text, .locate-box')) return
    if (e.button !== 0 && e.button !== 5) return
    e.preventDefault(); e.stopPropagation()
    if (focusedRef.current) { setFocused(null); setEditor(null); savePage() }
    if (t.mode === 'lasso' && e.button === 0) { try { pageRef.current.setPointerCapture(e.pointerId) } catch { } const pt = pagePoint(e); inkRef.current = { lasso: true, pts: [[pt.x, pt.y]] }; setSel(null); setLasso([[pt.x, pt.y]]); return }
    if (t.mode === 'clip' && e.button === 0) { try { pageRef.current.setPointerCapture(e.pointerId) } catch { } const pt = pagePoint(e); inkRef.current = { clip: true, start: pt }; setClip({ x: pt.x, y: pt.y, w: 0, h: 0 }); return }
    const eraser = t.mode === 'eraser' || (isPen && (e.button === 5 || (e.buttons & 32)))
    try { pageRef.current.setPointerCapture(e.pointerId) } catch { }
    const pt = pagePoint(e)
    if (eraser) { inkRef.current = { eraser: true, committed: false }; setEraserPos(pt); eraseAt(pt.x, pt.y); return }
    const host = e.target.closest('.el[data-kind="pdf"], .el[data-kind="image"]')
    const hp = host ? pos.get(host.dataset.id) : null
    const scope = hp ? { parent: host.dataset.id, offset: { x: hp.x, y: hp.y }, parentW: typeof hp.w === 'number' ? hp.w : null } : { parent: null, offset: { x: 0, y: 0 }, parentW: null }
    const mode = t.mode === 'highlighter' ? 'highlighter' : 'pen'
    const stroke = { id: newStrokeId(), tool: mode, color: t.color, width: t.size, pen: isPen, points: [] }
    inkRef.current = { scope, stroke, t0: (e.nativeEvent || e).timeStamp }
    addInkPoints(e)
    setLive({ stroke: { ...stroke, points: stroke.points.slice() }, offset: scope.offset, scale: 1 })
  }
  const onInkMove = e => {
    if (e.pointerType === 'pen') setPenInfo({ type: 'pen', pressure: e.pressure, tilt: e.tiltX || e.tiltY ? `${e.tiltX}°/${e.tiltY}°` : null })
    else if (toolRef.current.mode !== 'select' && e.buttons) setPenInfo({ type: e.pointerType, pressure: e.pressure, tilt: null })
    if (toolRef.current.mode === 'eraser') setEraserPos(pagePoint(e))
    const st = inkRef.current; if (!st) return
    if (st.lasso) { const pt = pagePoint(e); const l = st.pts[st.pts.length - 1]; if (Math.hypot(pt.x - l[0], pt.y - l[1]) > 2) { st.pts.push([pt.x, pt.y]); setLasso(st.pts.slice()) } return }
    if (st.clip) { setClip(rectOf(st.start, pagePoint(e))); return }
    if (st.eraser) { if (e.buttons) { const pt = pagePoint(e); eraseAt(pt.x, pt.y) } return }
    addInkPoints(e)
    setLive({ stroke: { ...st.stroke, points: st.stroke.points.slice() }, offset: st.scope.offset, scale: 1 })
  }
  const onInkUp = e => {
    const st = inkRef.current; if (!st) return
    inkRef.current = null; inkEndedAt.current = Date.now()
    try { pageRef.current.releasePointerCapture(e.pointerId) } catch { }
    if (st.lasso) { setLasso(null); setSel(selectByPolygon(st.pts)); return }
    if (st.clip) { const r = rectOf(st.start, pagePoint(e)); setClip(null); if (r.w >= 4 && r.h >= 4) makeClip(r); else setTool(t => ({ ...t, mode: 'select' })); return }
    if (st.eraser) { scheduleRecognise(); return }      // erasing changes the ink too, so its text is stale as well
    addInkPoints(e); setLive(null)
    const stroke = st.stroke
    if (stroke.points.length === 1) stroke.points.push(stroke.points[0].slice())
    commit()
    updateLayout(cur => {
      const idx = cur.elements.findIndex(el => el.type === 'ink' && (el.parent || null) === st.scope.parent && (el.parentW || null) === st.scope.parentW)
      if (idx >= 0) { const el = cur.elements[idx]; const elements = cur.elements.slice(); elements[idx] = { ...el, strokes: [...el.strokes, stroke] }; return { ...cur, elements } }
      return { ...cur, elements: [...cur.elements, { id: newId(), type: 'ink', ...(st.scope.parent ? { parent: st.scope.parent, parentW: st.scope.parentW } : {}), strokes: [stroke] }] }
    })
    scheduleLayout(); scheduleRecognise()
  }
  // ---- lasso: select handwriting, then move, resize, recolour or delete it (OneNote-style) ------------
  const inkFrame = el => { if (!el.parent) return { off: { x: 0, y: 0 }, k: 1 }; const p = pos.get(el.parent); if (!p) return null; return { off: { x: p.x, y: p.y }, k: el.parentW && typeof p.w === 'number' ? p.w / el.parentW : 1 } }
  // ---- handwriting to text (SPEC §20.9) ----------------------------------------------------------------------------
  // Recognise ink elements: a dirty layout is flushed first so the server reads the current strokes, then one POST;
  // the reply's layoutHash is adopted (the write was the server's own, the watcher does not echo it) and the text
  // fields are merged into the elements with no version bump, since disk already has them. Layout saves and the
  // unmount save wait on hwrRef while this runs.
  const allInkIds = () => layoutRef.current.elements.filter(e => e.type === 'ink' && e.strokes?.some(s => s.tool !== 'highlighter' && s.points?.length)).map(e => e.id)
  const recognise = (ids, { quiet = false } = {}) => {
    ids = [...new Set(ids)].filter(id => layoutRef.current.elements.some(e => e.id === id && e.type === 'ink'))
    if (!ids.length) return Promise.resolve()
    const p = (async () => {
      if (dirtyLayout()) await saveLayout()
      while (sv.current.layout.inFlight) await new Promise(r => setTimeout(r, 30))
      // The idle pass must not open the ink card under the pen or put an error in front of someone mid-sentence.
      if (!quiet) setInkText({ id: ids[0], busy: true })
      onStatus('recognising')
      try {
        const r = await api.hwr(page.path, ids.length === 1 ? { elementId: ids[0] } : { elementIds: ids })
        if (typeof r.layoutHash === 'string') layoutHashRef.current = r.layoutHash
        const byId = new Map((r.results || []).filter(x => !x.skipped).map(x => [x.id, x]))
        if (byId.size) updateLayout(cur => ({ ...cur, elements: cur.elements.map(e => { const x = byId.get(e.id); return x ? { ...e, text: x.text, textAt: x.textAt, inkHash: x.inkHash, lines: x.lines } : e }) }))
        onStatus('recognised'); if (!quiet) setInkText({ id: ids[0] })
      } catch (e) {
        onStatus('error'); if (!quiet) setInkText({ id: ids[0], error: e.data?.note || e.message })
        // No recogniser on this Mac (a 503), or it broke: stop the idle pass for this page rather than retrying every
        // few seconds for the rest of the session. The menu item still runs, and still says why.
        if (quiet) autoHwr.current = false
      }
    })()
    const q = p.finally(() => { if (hwrRef.current === q) hwrRef.current = null })
    hwrRef.current = q
    return q
  }
  // Recognition used to run only when asked — a menu item, a toolbar button, or the every-three-days pass. So the
  // words on a page existed only if you had thought to ask for them, and Ask, reading the page you were writing on,
  // answered "I can see one ink element and it arrives as stroke data only" about a sentence you had just written
  // (SPEC §20.51). It runs itself now, a few seconds after the pen stops: unchanged ink is skipped by its hash, so a
  // pass over a page you are not writing on costs nothing, and by the time a question is typed the words are there.
  const HWR_IDLE = 4000
  const autoHwr = useRef(true)
  const hwrIdle = useRef(null)
  const scheduleRecognise = () => {
    if (!autoHwr.current) return
    clearTimeout(hwrIdle.current)
    hwrIdle.current = setTimeout(() => { if (!inkRef.current) recognise(allInkIds(), { quiet: true }) }, HWR_IDLE)
  }
  recogniseRef.current = () => recognise(allInkIds(), { quiet: true })
  useEffect(() => () => clearTimeout(hwrIdle.current), [])

  // OneNote's ink-to-text: one text block with hard breaks, pinned at the writing's top-left on a rule, the strokes
  // removed — one history step (⌘Z puts the ink back and removes the block).
  const convertInkToText = id => {
    const el = layoutRef.current.elements.find(e => e.id === id && e.type === 'ink'), f = el && inkFrame(el)
    if (!el?.lines?.length || !f) return
    const b = textBlockFromInk(el, f); if (!b.md) return
    commit()
    const bid = newId()
    updateBlocks(cur => [...cur, { id: bid, md: b.md }])
    updateLayout(cur => ({ ...cur, elements: [...cur.elements.filter(e => e.id !== id), { id: bid, type: 'text', x: b.x, y: b.y, w: 'auto', z: maxZ(cur) + 1, ...(b.parent ? { parent: b.parent, parentW: b.parentW } : {}) }] }))
    schedulePage(); scheduleLayout(); setInkText(null); setSel(null)
  }
  // Right-click on handwriting (within 6 screen px of a pen stroke): ink is the top layer, so it wins over the document
  // under it; the editor's own menu and selected PDF text keep the browser's. Capture phase, so it runs before the
  // element menus below.
  const inkContextMenu = e => {
    if (e.target.closest('.ProseMirror, .ink-text, .sel-bar, .annot-bar, .toolbar, .tools, .ctx')) return
    const sel = window.getSelection()
    if (e.target.closest('.textLayer') && sel && !sel.isCollapsed) return
    const pt = pagePoint(e)
    const hit = hitInkAt(layoutRef.current.elements, pos, pt.x, pt.y, 6 / zoomRef.current)
    if (!hit) return
    e.preventDefault(); e.stopPropagation()
    const el = hit.el
    setElMenu({ at: { x: e.clientX, y: e.clientY }, items: inkMenuItems({ el, inkCount: allInkIds().length, on: {
      recognise: () => recognise([el.id]), show: () => setInkText({ id: el.id }), copy: () => navigator.clipboard?.writeText(el.text || '').catch(() => { }),
      convert: () => convertInkToText(el.id), all: () => recognise(allInkIds()) } }) })
  }
  const insidePoly = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c } return c }
  const boxOf = keys => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const el of layoutRef.current.elements) {
      if (el.type !== 'ink') continue; const f = inkFrame(el); if (!f) continue
      for (const s of el.strokes) if (keys.has(el.id + ':' + s.id)) for (const p of s.points) { const x = p[0] * f.k + f.off.x, y = p[1] * f.k + f.off.y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
  }
  const selectByPolygon = poly => {
    if (poly.length < 3) return null
    const keys = new Set()
    for (const el of layoutRef.current.elements) {
      if (el.type !== 'ink' || el.hidden) continue; const f = inkFrame(el); if (!f) continue
      for (const s of el.strokes) { let inside = 0; for (const p of s.points) if (insidePoly(p[0] * f.k + f.off.x, p[1] * f.k + f.off.y, poly)) inside++; if (inside >= Math.max(1, s.points.length * 0.5)) keys.add(el.id + ':' + s.id) }
    }
    if (!keys.size) return null
    return { keys, box: boxOf(keys) }
  }
  // Apply fn(x, y) → [x, y] (page coordinates) to every selected point; fn.width scales the pen width.
  const transformSel = (fn, record) => {
    const cur = selRef.current; if (!cur) return
    if (record) commit()
    updateLayout(l => ({ ...l, elements: l.elements.map(el => {
      if (el.type !== 'ink') return el; const f = inkFrame(el); if (!f) return el
      let changed = false
      const strokes = el.strokes.map(s => {
        if (!cur.keys.has(el.id + ':' + s.id)) return s
        changed = true
        const points = s.points.map(p => { const [nx, ny] = fn(p[0] * f.k + f.off.x, p[1] * f.k + f.off.y); return [Math.round(((nx - f.off.x) / f.k) * 10) / 10, Math.round(((ny - f.off.y) / f.k) * 10) / 10, p[2], p[3]] })
        return { ...s, points, ...(fn.width ? { width: Math.round(s.width * fn.width * 100) / 100 } : {}), ...(fn.color ? { color: fn.color } : {}) }
      })
      return changed ? { ...el, strokes } : el
    }) }))
    scheduleLayout()
    setSel(c => (c ? { ...c, box: boxOf(c.keys) } : c))
  }
  const recolorSel = color => { const fn = (x, y) => [x, y]; fn.color = color; transformSel(fn, true) }
  const resizeSelBy = factor => { const b = selRef.current?.box; if (!b) return; const fn = (x, y) => [b.x + (x - b.x) * factor, b.y + (y - b.y) * factor]; fn.width = factor; transformSel(fn, true) }
  const deleteSelection = () => {
    const cur = selRef.current; if (!cur) return
    commit()
    updateLayout(l => ({ ...l, elements: l.elements.map(el => (el.type === 'ink' ? { ...el, strokes: el.strokes.filter(s => !cur.keys.has(el.id + ':' + s.id)) } : el)).filter(el => el.type !== 'ink' || el.strokes.length) }))
    scheduleLayout(); setSel(null)
  }
  const startSelMove = e => {
    if (e.target.closest('.sel-handle, .sel-bar')) return
    e.preventDefault(); e.stopPropagation()
    commit()
    let last = { x: e.clientX, y: e.clientY }
    const move = ev => { const z = zoomRef.current, dx = (ev.clientX - last.x) / z, dy = (ev.clientY - last.y) / z; last = { x: ev.clientX, y: ev.clientY }; if (dx || dy) transformSel((x, y) => [x + dx, y + dy], false) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const startSelScale = e => {
    e.preventDefault(); e.stopPropagation()
    const b0 = selRef.current?.box; if (!b0) return
    commit()
    const startX = e.clientX, origin = { x: b0.x, y: b0.y }, w0 = b0.w
    let prev = 1
    const move = ev => {
      const f = Math.max(0.1, (w0 + (ev.clientX - startX) / zoomRef.current) / w0), step = f / prev; prev = f
      const fn = (x, y) => [origin.x + (x - origin.x) * step, origin.y + (y - origin.y) * step]; fn.width = step
      transformSel(fn, false)
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  useEffect(() => { if (tool.mode !== 'lasso') setSel(null) }, [tool.mode])

  // ---- clip: a screenshot of part of a document, set down beside it as a picture you can drag ---------
  // What the rectangle covers is composed from pixels the page already has: pdf.js's page canvases,
  // images, PDF highlights and the ink over them. The PNG is saved like any upload ("Clip n.png" in
  // the page's assets) and the element records where it was taken from. SPEC.md §5.
  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
  const makeClip = async rect => {
    const root = pageRef.current, pr = root.getBoundingClientRect(), z = zoomRef.current
    const S = 2   // output pixels per page unit: crisp on a retina screen, files stay small
    const boxOfNode = n => { const r = n.getBoundingClientRect(); return { x: (r.left - pr.left) / z, y: (r.top - pr.top) / z, w: r.width / z, h: r.height / z } }
    const clipBox = b => { const x = Math.max(rect.x, b.x), y = Math.max(rect.y, b.y), ex = Math.min(rect.x + rect.w, b.x + b.w), ey = Math.min(rect.y + rect.h, b.y + b.h); return ex - x < 1 || ey - y < 1 ? null : { x, y, w: ex - x, h: ey - y } }
    const hosts = [...root.querySelectorAll('.el[data-kind="pdf"], .el[data-kind="image"]')].sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0))
    const sources = [], marks = []
    for (const host of hosts) {
      for (const node of host.querySelectorAll('.pdf-page canvas, img.el-img')) {
        const isCanvas = node.tagName === 'CANVAS', nw = isCanvas ? node.width : node.naturalWidth, nh = isCanvas ? node.height : node.naturalHeight
        const box = boxOfNode(node), hit = clipBox(box)
        if (!hit || !nw || !nh) continue
        sources.push({ id: host.dataset.id, node, box, hit, nw, nh, pageNo: isCanvas ? Number(node.parentElement.dataset.page) + 1 : null })
      }
      for (const node of host.querySelectorAll('.pdf-annot')) { const hit = clipBox(boxOfNode(node)); if (hit) marks.push({ hit, color: node.style.getPropertyValue('--c') || '#ffd60a', underline: node.classList.contains('underline') }) }
    }
    if (!sources.length) { setTool(t => ({ ...t, mode: 'select' })); dialog.alert({ title: 'Nothing to clip there', message: 'A clip captures part of a PDF page or an image. Drag the rectangle over one.' }); return }
    const out = document.createElement('canvas'); out.width = Math.round(rect.w * S); out.height = Math.round(rect.h * S)
    const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height)
    const place = b => [(b.x - rect.x) * S, (b.y - rect.y) * S, b.w * S, b.h * S]
    for (const s of sources) { const kx = s.nw / s.box.w, ky = s.nh / s.box.h; ctx.drawImage(s.node, (s.hit.x - s.box.x) * kx, (s.hit.y - s.box.y) * ky, s.hit.w * kx, s.hit.h * ky, ...place(s.hit)) }
    for (const m of marks) {
      const [x, y, w, h] = place(m.hit)
      ctx.save(); ctx.fillStyle = m.color
      if (m.underline) ctx.fillRect(x, y + h - 2.5 * S, w, 2.5 * S); else { ctx.globalAlpha = .45; ctx.globalCompositeOperation = 'multiply'; ctx.fillRect(x, y, w, h) }
      ctx.restore()
    }
    // Ink: the page's SVG, re-framed to the rectangle. The theme's white ink is written black on the white clip.
    const ink = root.querySelector('.ink-svg')
    if (ink && ink.querySelector('path')) {
      const svg = ink.cloneNode(true)
      svg.setAttribute('viewBox', `${rect.x} ${rect.y} ${rect.w} ${rect.h}`); svg.setAttribute('width', out.width); svg.setAttribute('height', out.height); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style'); style.textContent = 'path.highlighter{opacity:.45;mix-blend-mode:multiply}'; svg.prepend(style)
      const xml = new XMLSerializer().serializeToString(svg).replaceAll('#f2f2f7', '#1d1d1f')
      await new Promise(res => { const im = new Image(); im.onload = () => { ctx.drawImage(im, 0, 0); res() }; im.onerror = res; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml) })
    }
    // All white means the page had not finished rendering (or only margin was framed): no file for that.
    const px = ctx.getImageData(0, 0, out.width, out.height).data
    let blank = true; for (let i = 0; i < px.length && blank; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) blank = false
    if (blank) { setTool(t => ({ ...t, mode: 'select' })); dialog.alert({ title: 'That clip is empty', message: 'Only white was under the rectangle. If the page was still drawing, give it a second and clip again.' }); return }
    let blob = null
    try { blob = await new Promise(res => out.toBlob(res, 'image/png')) } catch (e) { console.error(e) }
    if (!blob) { onStatus('error'); setTool(t => ({ ...t, mode: 'select' })); return }
    // Beside the document that fills most of the rectangle, level with where the clip was taken. A
    // flowed document keeps its place: the clip stays clear of the flow column (SPEC §5), or it would
    // count as an obstacle and push its own source down the page.
    const main = sources.reduce((m, s) => (!m || s.hit.w * s.hit.h > m.hit.w * m.hit.h ? s : m), null)
    const from = layoutRef.current.elements.find(e => e.id === main.id), hp = pos.get(main.id), hs = sizes.get(main.id)
    // What was circled is not yet anything: it is offered as either (SPEC §20.31). Placing it puts the picture on
    // the page to drag and keep; asking sends it to Claude with the page's whole context, and leaves the page alone.
    let x = hp && hs ? Math.round(hp.x + hs.w + 24) : Math.round(rect.x + rect.w + 24)
    if (hp && !hp.pinned) x = Math.max(x, FLOW_X + MAX_AUTO_W + 8)
    const clipInfo = { of: from?.src, ...(main.pageNo ? { page: main.pageNo } : {}), x: Math.round(rect.x - (hp?.x || 0)), y: Math.round(rect.y - (hp?.y || 0)), w: Math.round(rect.w), h: Math.round(rect.h) }
    setClipped({ blob, url: URL.createObjectURL(blob), rect, x, y: Math.round(rect.y), clipInfo })
    setTool(t => ({ ...t, mode: 'select' }))
  }

  // Upload the clip once, whichever of the two is chosen; the file has to exist for Claude to read it either way.
  const saveClip = async c => {
    const n = layoutRef.current.elements.filter(e => e.clip).length + 1
    onStatus('uploading')
    const a = await api.upload(page.path, new File([c.blob], `Clip ${n}.png`, { type: 'image/png' }))
    onStatus('saved')
    return a
  }
  const placeClip = async c => {
    try {
      const a = await saveClip(c)
      commit()
      updateLayout(cur => ({ ...cur, elements: [...cur.elements, { id: newId(), type: 'image', src: a.src, size: a.size, x: c.x, y: c.y, w: Math.round(c.rect.w), h: Math.round(c.rect.h), z: maxZ(cur) + 1, clip: c.clipInfo }] }))
      scheduleLayout()
      try { await navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': c.blob })]) } catch { }
    } catch (err) { console.error(err); onStatus('error') }
    URL.revokeObjectURL(c.url); setClipped(null)
  }
  const askClip = async c => {
    try {
      const a = await saveClip(c)
      openAsk({ page: page.path, image: `${page.dir}/${a.src}` })   // a.src already carries `<Title>.assets/`; doubling it 404ed every clip
    } catch (err) { console.error(err); onStatus('error') }
    URL.revokeObjectURL(c.url); setClipped(null)
  }

  const swallowClickAfterInk = e => { if (e.target.closest('.sel-bar, .sel-box, .el-head, .ink-text')) return; if (toolRef.current.mode !== 'select' || Date.now() - inkEndedAt.current < 300) { e.stopPropagation(); e.preventDefault() } }

  // ---- drag / resize -------------------------------------------------------------------------
  const afterGeometryChange = () => {
    const { pos: np } = computeLayout(blocksRef.current, layoutRef.current, sizes, canvasW / zoomRef.current)
    const next = reorderBlocks(blocksRef.current, np)
    if (next !== blocksRef.current) {
      updateBlocks(next.map(b => { if (b.id) return b; const real = newId(); adoptFirstId(real); return { ...b, id: real } }))
      schedulePage()
    }
    scheduleLayout()
  }
  const startDrag = (e, id) => {
    e.preventDefault(); e.stopPropagation()
    const p = pos.get(id); if (!p) return
    const before = snapshot()
    const real = ensureElement(id, { x: p.x, y: p.y })
    dragRef.current = { id: real, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y, last: { x: p.x, y: p.y }, before, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    setDragPos({ id: real, x: p.x, y: p.y })
    if (focusedRef.current && focusedRef.current !== id) { setFocused(null); setEditor(null) }
    track('drag')
  }
  const onDragMove = e => {
    const d = dragRef.current; if (!d) return
    const z = zoomRef.current
    const dy = d.oy + (e.clientY - d.startY) / z
    const x = Math.max(0, Math.round(d.ox + (e.clientX - d.startX) / z)), y = Math.max(0, e.altKey ? Math.round(dy) : snapRule(dy))
    d.moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 2
    d.last = { x, y }; setDragPos({ id: d.id, x, y })
  }
  const endDrag = () => {
    const d = dragRef.current; if (!d) return
    dragRef.current = null; setDragPos(null)
    if (d.moved) { hist.current.undo.push(d.before); hist.current.redo = []; setHistN(n => n + 1) }
    updateLayout(cur => {
      const z = maxZ(cur) + 1
      return { ...cur, elements: cur.elements.map(el => {
        if (el.id !== d.id) return el
        const parent = el.parent ? pos.get(el.parent) : null
        const k = el.parentW && parent && typeof parent.w === 'number' ? parent.w / el.parentW : 1
        return { ...el, x: (d.last.x - (parent?.x || 0)) / k, y: (d.last.y - (parent?.y || 0)) / k, z }
      }) }
    })
    afterGeometryChange()
  }
  const startResize = (e, id, mode) => {
    e.preventDefault(); e.stopPropagation()
    const s = sizes.get(id); const p = pos.get(id); if (!s || !p) return
    const before = snapshot()
    const real = ensureElement(id, p.pinned ? { x: p.x, y: p.y } : {})
    resizeRef.current = { id: real, mode, startX: e.clientX, startY: e.clientY, w: s.w, h: s.h, ratio: s.h / Math.max(1, s.w), last: { w: s.w }, before }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    setResizing({ id: real, w: s.w })
    track('resize')
  }
  const onResizeMove = e => {
    const r = resizeRef.current; if (!r) return
    const w = Math.max(MIN_W, Math.round(r.w + (e.clientX - r.startX) / zoomRef.current))
    const h = r.mode === 'se' ? Math.round(w * r.ratio) : undefined
    r.last = { w, h }; setResizing({ id: r.id, w, h })
  }
  const endResize = () => {
    const r = resizeRef.current; if (!r) return
    resizeRef.current = null; setResizing(null)
    hist.current.undo.push(r.before); hist.current.redo = []; setHistN(n => n + 1)
    updateLayout(cur => ({ ...cur, elements: cur.elements.map(el => el.id === r.id ? { ...el, w: r.last.w, ...(r.last.h != null ? { h: r.last.h } : {}) } : el) }))
    afterGeometryChange()
  }

  // Moves and the release are tracked on the window through the latest handlers, so a drag
  // survives its grip re-rendering and the pointer leaving it.
  handlers.current = { onDragMove, endDrag, onResizeMove, endResize }
  const track = kind => {
    const move = ev => handlers.current[kind === 'drag' ? 'onDragMove' : 'onResizeMove'](ev)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); handlers.current[kind === 'drag' ? 'endDrag' : 'endResize']() }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }

  // ---- adding files: the + button (flowed) or a drop (pinned at the point) ------------------------
  // PDFs can be a printout (pages to write on) or a card; audio and video a player or a card.
  const isPdfFile = f => /\.pdf$/i.test(f.name), isMediaFile = f => /\.(mp4|mov|webm|m4a|mp3|wav)$/i.test(f.name)
  const askModes = async files => {
    const modes = {}
    if (files.some(isPdfFile)) {
      modes.pdf = await dialog.choose({ title: files.filter(isPdfFile).length > 1 ? 'How should the PDFs appear?' : 'How should the PDF appear?', options: [
        { value: 'printout', label: 'Printout', hint: 'The pages on the canvas: highlight, underline and write on them.', recommended: true },
        { value: 'card', label: 'File card', hint: 'A compact card that opens the file. Switch any time from the card.' }] })
      if (!modes.pdf) return null
    }
    if (files.some(isMediaFile)) {
      modes.media = await dialog.choose({ title: 'How should the audio or video appear?', options: [
        { value: 'player', label: 'Player', hint: 'Play it right on the page.', recommended: true },
        { value: 'card', label: 'File card', hint: 'A compact card that opens the file in its own app.' }] })
      if (!modes.media) return null
    }
    return modes
  }
  const addFiles = async (files, at) => {
    files = [...files]; if (!files.length) return
    const modes = await askModes(files); if (!modes) return
    let x = at ? Math.max(0, Math.round(at.x)) : 0, y = at ? Math.max(0, snapRule(at.y)) : 0
    commit()
    for (const f of files) {
      try {
        onStatus('uploading')
        const a = await api.upload(page.path, f)
        const card = isPdfFile(f) ? modes.pdf === 'card' : a.kind === 'media' ? modes.media === 'card' : false
        const el = { id: newId(), type: a.kind, src: a.src, size: a.size, ...(card ? { display: 'card' } : {}) }
        updateLayout(cur => ({ ...cur, elements: [...cur.elements, { ...el, ...(at ? { x, y, w: DEFAULT_W[elementKind(el)] || 360 } : {}), z: maxZ(cur) + 1 }] }))
        if (at) { x += 24; y += 24 }
      } catch (err) { console.error(err); onStatus('error') }
    }
    scheduleLayout(); onStatus('saved')
  }
  addFilesRef.current = addFiles
  const onDrop = e => {
    if (e.defaultPrevented) return
    e.preventDefault()
    const files = [...(e.dataTransfer?.files || [])]
    if (files.length) addFiles(files, pagePoint(e))
  }

  // ---- render ---------------------------------------------------------------------------------
  // Stacked by rank, not by the stored z (SPEC §20.32). Every drag and every "bring to front" stores max+1, so z only
  // grows, and `1000 + z·2` on a page worked on for a term climbs past the overlays that must stay on top — the ink
  // layer (4500), the lasso, the clip and its offer (5000) — and puts them under the PDF they were drawn on. The rank
  // keeps the same order and keeps every element below 4000: normal < focused (+1000) < dragged (+1000 more).
  const zRank = useMemo(() => {
    const zs = [...new Set([0, ...layout.elements.filter(e => !OVERLAY_TYPES.has(e.type)).map(e => e.z || 0)])].sort((a, b) => a - b)
    return new Map(zs.map((z, i) => [z, i]))
  }, [layout])
  const zOf = (p, id) => 1000 + Math.min(zRank.get(p.z || 0) ?? 0, 499) * 2 + (focused === id ? 1000 : 0) + (dragPos?.id === id ? 1000 : 0)
  const stop = e => e.stopPropagation()
  const grip = (id, onRemove) => (
    <div className="grip" title="Drag to move" onPointerDown={e => startDrag(e, id)}>
      {onRemove && <button className="grip-x" title="Delete this text box" onPointerDown={stop} onClick={e => { stop(e); onRemove() }}>×</button>}
    </div>
  )
  // Every document wears a small bar: its name, drag to move, printout/card or player/card, menu, remove.
  const docHead = (el, kind) => {
    const name = decodeURIComponent((el.src || '').split('/').pop()), inline = inlineKind(el)
    return (
      <div className="el-head" title="Drag to move" onPointerDown={e => startDrag(e, el.id)}>
        <span className="el-head-name">{name}</span>
        <span className="spacer" />
        {inline && !el.hidden && <button className="el-head-btn" title={el.display === 'card' ? `Show as ${inline === 'pdf' ? 'printout (pages)' : 'player'}` : 'Show as a file card'} onPointerDown={stop} onClick={() => patchElement(el.id, { display: el.display === 'card' ? undefined : 'card' }, true)}>{el.display === 'card' ? (inline === 'pdf' ? 'Printout' : 'Player') : 'Card'}</button>}
        <button className="el-head-btn" title="More" onPointerDown={stop} onClick={e => elementMenu(e, el, kind)}>···</button>
        <button className="el-head-btn" title="Remove from page (keeps the file)" onPointerDown={stop} onClick={() => removeElement(el.id)}>×</button>
      </div>
    )
  }
  const handle = (id, mode) => <div className={'handle handle-' + mode} onPointerDown={e => startResize(e, id, mode)} />
  const focusedPos = focused ? pos.get(focused) : null
  const hiddenIds = useMemo(() => new Set(layout.elements.filter(e => e.hidden).map(e => e.id)), [layout])   // collapsed documents take their notes and ink with them
  const focusedEl = focused ? layout.elements.find(e => e.id === focused) : null
  const drawing = tool.mode !== 'select'

  // Dictation (SPEC §20.28): every finished phrase is inserted at the cursor through the editor's own transaction,
  // so it undoes, autosaves and lands on the ruled line exactly like typing. With no cursor anywhere, the first
  // phrase opens a block at the end of the page and carries on from there.
  const [dictating, setDictating] = useState(false)
  const [dictState, setDictState] = useState('listening')   // listening | hearing | thinking | warming
  const [dictError, setDictError] = useState(null)
  const stopDict = useRef(null)
  const insertSpoken = phrase => {
    const ed = editorRef.current
    if (ed?.isEditable && !ed.isDestroyed) {
      const before = ed.state.doc.textBetween(Math.max(0, ed.state.selection.from - 2), ed.state.selection.from, ' ')
      ed.chain().focus().insertContent(joinPhrase(before, phrase)).run(); return
    }
    appendBlockRef.current(phrase, { below: true })
  }
  const toggleDictation = async () => {
    setDictError(null)
    if (stopDict.current) { stopDict.current(); stopDict.current = null; setDictating(false); return }
    // Ask the machine whether it can hear before asking the student to speak: a missing recogniser should say so now,
    // not after a sentence has been spoken into nothing.
    try {
      const st = await api.dictateStatus()
      if (!st.available) { setDictError(st.note || 'The recogniser is not installed. Run `uv tool install parakeet-mlx` once, then try again.'); return }
      if (st.error) { setDictError(st.error); return }
    } catch (e) {
      // A 404 here means the window is newer than the server behind it — Slate.app imports the server from the repo
      // at launch, so a route added since it opened does not exist until it is reopened. Say that, not "no such route".
      setDictError(e.status === 404 ? 'This window is running an older server. Quit slate and open it again.' : `Could not reach the recogniser: ${e.message}`)
      return
    }
    setDictating(true); setDictState('listening')
    stopDict.current = startDictation({
      onPhrase: insertSpoken,
      onState: setDictState,
      onEnd: why => { stopDict.current = null; setDictating(false); if (why) setDictError(why) },
    })
  }
  useEffect(() => () => { stopDict.current?.() }, [])
  useEffect(() => () => { if (clipped?.url) URL.revokeObjectURL(clipped.url) }, [clipped])
  useEffect(() => { setClipped(null) }, [page.path])

  // Everything else fades while you type, and comes back the moment you reach for the mouse (SPEC §20.28). One
  // attribute on the root; the shell's CSS does the rest, so no component has to know it is being faded.
  useEffect(() => {
    const on = e => { if (!e.metaKey && !e.ctrlKey && !e.altKey && isTyping()) document.documentElement.dataset.typing = 'on' }
    const off = () => { delete document.documentElement.dataset.typing }
    window.addEventListener('keydown', on); window.addEventListener('pointermove', off); window.addEventListener('pointerdown', off)
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('pointermove', off); window.removeEventListener('pointerdown', off); off() }
  }, [])

  // Ask about *this* (SPEC §20.28): select a passage and a small bar offers to ask about it alone, rather than
  // about the whole page. The quote goes to the rail as the question's subject.
  const [passage, setPassage] = useState(null)
  useEffect(() => {
    let t = null
    const check = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        const sel = window.getSelection()
        const node = sel && !sel.isCollapsed && sel.anchorNode
        const host = node && (node.nodeType === 1 ? node : node.parentNode)
        if (!host || !pageRef.current?.contains(host)) return setPassage(null)
        const text = sel.toString().replace(/\s+/g, ' ').trim()
        if (text.length < 4) return setPassage(null)
        const r = sel.getRangeAt(0).getBoundingClientRect(), c = canvasRef.current?.getBoundingClientRect()
        if (!c || !r.width) return setPassage(null)
        setPassage({ text, x: Math.min(Math.max(90, r.left + r.width / 2 - c.left), c.width - 90), y: Math.max(8, r.top - c.top - 6) })
      }, 90)
    }
    document.addEventListener('selectionchange', check)
    return () => { document.removeEventListener('selectionchange', check); clearTimeout(t) }
  }, [])

  return (
    <div className="canvas-wrap">
      {ED.ask && passage && (
        <div className="passage-bar" style={{ left: passage.x, top: passage.y }} onPointerDown={e => e.preventDefault()}>
          <button onClick={() => { openAsk({ page: page.path, quote: passage.text }); setPassage(null) }}>
            <Icon.ask width="13" height="13" />Ask about this
          </button>
        </div>)}
      <div className={'canvas' + (doc ? ' one-column' : '') + (className ? ' ' + className : '')} data-src={dataSrc || undefined} ref={canvasRef} onDragOver={e => e.preventDefault()} onDrop={onDrop}>
        {conflict && <ConflictBanner conflict={conflict} onReload={reloadFromDisk} onKeep={keepMine} />}
        <div className="page-scaler" style={{ width: extent.w * zoom, height: extent.h * zoom }}>
          <div className={'page' + (doc ? ' one-column' : '') + (drawing ? ' drawing ' + tool.mode : '')} ref={pageRef} style={{ width: extent.w, height: extent.h, transform: `scale(${zoom})` }} onClick={onCanvasClick} onContextMenuCapture={inkContextMenu}
            onPointerDownCapture={onInkDown} onPointerMove={onInkMove} onPointerUp={onInkUp} onPointerCancel={onInkUp} onPointerLeave={() => setEraserPos(null)} onClickCapture={swallowClickAfterInk}>
            {blocks.map(b => {
              const id = b.id || FIRST, p = pos.get(id); if (!p) return null
              const el = (b.id && layout.elements.find(e => e.id === b.id)) || {}
              if (el.parent && hiddenIds.has(el.parent)) return null
              const auto = p.w === 'auto'
              return (
                <div key={b.id === firstIdRef.current ? FIRST : id} data-id={id} data-kind="text" ref={observe} data-from={quoted.has(id) ? quoted.label : undefined}
                  className={'el el-text' + (focused === id ? ' focused' : '') + (p.pinned ? ' pinned' : ' flowed') + (quoted.has(id) ? ' el-quercus k-' + quoted.kind : '')}
                  onContextMenu={e => { if (!e.target.closest('.ProseMirror')) elementMenu(e, { id: b.id, key: id }, 'text') }}
                  style={{ left: p.x, top: p.y, zIndex: zOf(p, id), width: auto ? undefined : p.w, maxWidth: auto ? Math.max(MIN_W, Math.min(measure, canvasW / zoom - p.x - 48)) : undefined,
                    visibility: sizes.has(id) ? 'visible' : 'hidden', fontFamily: el.style?.font || undefined, fontSize: el.style?.size ? el.style.size + 'px' : undefined, color: el.style?.color || undefined }}>
                  {grip(id, () => removeBlock(id))}
                  <TextBlock id={id} md={b.md} focused={focused === id} focusPoint={focusPoint} extensions={extensions} renderer={renderer}
                    onChange={md => setBlockMd(id, md)} onFocus={focusBlock} onBlur={() => blurBlock(id)} onEditor={setEditor} onOpenTitle={onOpenTitle} onUpload={f => api.upload(page.path, f)} onDelete={() => removeBlock(id)} />
                  {handle(id, 'e')}
                </div>
              )
            })}
            {layout.elements.filter(e => e.type !== 'text' && !OVERLAY_TYPES.has(e.type)).map(el => {
              const p = pos.get(el.id); if (!p) return null
              const url = resolveSrc(el.src), kind = elementKind(el)
              return (
                <div key={el.id} data-id={el.id} data-kind={kind} ref={observe} className={'el el-' + kind + (p.pinned ? ' pinned' : ' flowed') + (el.hidden ? ' collapsed' : '')}
                  onContextMenu={e => {
                    if (e.target.closest('.annot-bar')) return
                    const sel = window.getSelection()   // selected text keeps the browser's menu (copy); anywhere else on the document opens ours
                    if (e.target.closest('.textLayer') && sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return
                    elementMenu(e, el, kind)
                  }}
                  style={{ left: p.x, top: p.y, zIndex: zOf(p, el.id), width: el.hidden ? undefined : p.w, visibility: sizes.has(el.id) ? 'visible' : 'hidden' }}>
                  {docHead(el, kind)}
                  {el.hidden ? <HiddenCard el={el} kind={kind} onShow={() => patchElement(el.id, { hidden: false }, true)} />
                    : kind === 'pdf' ? <PdfEl el={el} url={url} width={typeof p.w === 'number' ? p.w : DEFAULT_W.pdf} scrollRoot={canvasRef} locate={goTo?.kind === 'pdf' && goTo.el === el.id ? goTo : null}
                        annotations={layout.elements.filter(a => ANNOTATION_TYPES.has(a.type) && a.parent === el.id)} palette={highlights} onSetPalette={onSetHighlights}
                        onAnnotate={a => addAnnotation(el.id, a)} onAnnotationResolved={(id, patch) => patchElement(id, patch)} onRemoveAnnotation={removeElement} onNoteAt={(x, y) => addNote(el.id, x, y)} />
                    : kind === 'image' ? <ImageEl el={el} url={url} width="100%" /> : kind === 'media' ? <MediaEl el={el} url={url} width="100%" page={page.path} seek={goTo?.kind === 'transcript' && goTo.el === el.id ? goTo : null} /> : <FileCard el={el} url={url} />}
                  {!el.hidden && (kind === 'image' ? handle(el.id, 'se') : handle(el.id, 'e'))}
                </div>
              )
            })}
            <InkSvg elements={layout.elements} pos={pos} live={live} extent={extent} colorMap={colorMap} />
            {located && <div className="locate-box" style={{ left: located.x - 6, top: located.y - 6, width: located.w + 12, height: located.h + 12 }} />}
            {inkText && (() => {
              const el = layout.elements.find(e => e.id === inkText.id && e.type === 'ink'), f = el && inkFrame(el), b = el && f && penBox(el, f)
              if (!b) return null
              return <InkTextCard el={el} box={b} zoom={zoom} canvasW={canvasW} busy={inkText.busy} error={inkText.error} onRecognise={() => recognise([el.id])} onConvert={() => convertInkToText(el.id)} onClose={() => setInkText(null)} />
            })()}
            {lasso && lasso.length > 1 && <svg className="lasso-svg" width={extent.w} height={extent.h}><polygon points={lasso.map(p => p.join(',')).join(' ')} /></svg>}
            {clipped && (<>
              <div className="clip-shot" style={{ left: clipped.rect.x, top: clipped.rect.y, width: clipped.rect.w, height: clipped.rect.h }}>
                <img src={clipped.url} alt="" />
              </div>
              <div className="clip-ask" style={{ left: clipped.rect.x, top: Math.max(0, clipped.rect.y - 46), transform: `scale(${1 / zoom})`, transformOrigin: '0 100%' }} onPointerDown={e => e.stopPropagation()}>
                <button onClick={() => placeClip(clipped)}><Icon.image width="13" height="13" />Put it on the page</button>
                {ED.ask && <button onClick={() => askClip(clipped)}><Icon.ask width="13" height="13" />Ask Claude about it</button>}
                <button className="clip-ask-x" title="Never mind" onClick={() => { URL.revokeObjectURL(clipped.url); setClipped(null) }}><Icon.x width="12" height="12" /></button>
              </div>
            </>)}
            {clip && <div className="clip-box" style={{ left: clip.x, top: clip.y, width: clip.w, height: clip.h }}>{clip.w > 40 && <span className="clip-size" style={{ transform: `scale(${1 / zoom})` }}>{Math.round(clip.w)} × {Math.round(clip.h)}</span>}</div>}
            {sel && (
              <>
                <div className="sel-box" style={{ left: sel.box.x - 8, top: sel.box.y - 8, width: sel.box.w + 16, height: sel.box.h + 16 }} onPointerDown={startSelMove} title="Drag to move">
                  <div className="sel-handle" onPointerDown={startSelScale} title="Drag to resize" />
                </div>
                <div className="sel-bar" style={{ left: sel.box.x - 8, top: sel.box.y - 8, transform: `translateY(-100%) translateY(-8px) scale(${1 / zoom})`, transformOrigin: '0 100%' }} onPointerDown={e => e.stopPropagation()}>
                  <span className="dots colors">{INK_COLORS_UI.map(c => <button key={c} type="button" className="dot" title={c} onClick={() => recolorSel(c)}><span className="disc" style={{ background: c, width: 14, height: 14 }} /></button>)}</span>
                  <span className="tools-sep" />
                  <button type="button" className="tb" title="Smaller" onClick={() => resizeSelBy(0.8)}>A−</button>
                  <button type="button" className="tb" title="Bigger" onClick={() => resizeSelBy(1.25)}>A+</button>
                  <span className="tools-sep" />
                  <button type="button" className="tb" title="Recognise handwriting" onClick={() => recognise([...sel.keys].map(k => k.split(':')[0]))}>Text</button>
                  <span className="tools-sep" />
                  <button type="button" className="tb danger" title="Delete (⌫)" onClick={deleteSelection}>Delete</button>
                  <button type="button" className="tb" title="Done (Esc)" onClick={() => setSel(null)}>Done</button>
                </div>
              </>
            )}
            {tool.mode === 'eraser' && eraserPos && <div className="eraser-cursor" style={{ left: eraserPos.x - tool.eraserSize, top: eraserPos.y - tool.eraserSize, width: tool.eraserSize * 2, height: tool.eraserSize * 2 }} />}
            {focused && editor && focusedPos && !drawing && (
              <Toolbar editor={editor} blockStyle={focusedEl?.style} onBlockStyle={setBlockStyle}
                style={{ left: Math.max(4, Math.min(focusedPos.x, canvasW / zoom - 760)), top: focusedPos.y > 56 ? focusedPos.y - 48 : focusedPos.y + (sizes.get(focused)?.h || 0) + 8, transform: `scale(${1 / zoom})`, transformOrigin: '0 0' }} />
            )}
            {elMenu && <ContextMenu at={elMenu.at} items={elMenu.items} onClose={() => setElMenu(null)} />}
          </div>
        </div>
      </div>
      <Tools tool={tool} setTool={setTool} zoom={zoom} setZoom={setZoom} canUndo={hist.current.undo.length > 0} canRedo={hist.current.redo.length > 0} onUndo={undo} onRedo={redo} penInfo={penInfo}
        doc={doc} setDoc={setDoc} dictation={{ on: dictating, supported: dictationSupported, error: dictError, state: dictState, toggle: toggleDictation }} />
    </div>
  )
})
export default Canvas
