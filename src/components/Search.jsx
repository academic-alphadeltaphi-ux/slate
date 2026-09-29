// The ⌘K / ⌘⇧F modal (SPEC.md §10, §20.6). Quick mode: fuzzy titles, client side. Full mode: /api/search over the
// .md index and the document index — one row per page, every snippet stamped with where the words are (page text,
// `lucas.pdf · p. 2`, `12:41`, handwriting) and filterable by source. ↑/↓ moves per page, Tab / ← → cycles the
// highlighted page's hits, Enter opens the highlighted hit; clicking a snippet opens exactly that hit, clicking a
// title opens the page at its first hit. `onOpen(path, target)` hands the shell a goTo target the canvas lands on.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import '../styles/search.css'

const KINDS = [['all', 'All', null], ['text', 'Notes', 'text'], ['pdf', 'PDFs', 'pdf'], ['transcript', 'Transcripts', 'transcript'], ['ink', 'Ink', 'ink']]
const labelOf = k => KINDS.find(x => x[0] === k)?.[1] || 'All'
const hms = s => { s = Math.max(0, Math.floor(+s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0') }
const CHIP = {
  pdf: s => [Icon.file, `${s.name || 'PDF'} · p. ${s.page}`, `${s.name || 'PDF'}, page ${s.page}`],
  transcript: s => [Icon.headphones, hms(s.t), `Transcript at ${hms(s.t)}`],
  ink: () => [Icon.pen, 'handwriting', 'Recognised handwriting'],
}
// The goTo target a snippet carries into the canvas (App adds the nonce).
const targetOf = (s, q) => !s ? null
  : s.kind === 'text' ? { kind: 'text', block: s.block || null }
  : s.kind === 'pdf' ? { kind: 'pdf', el: s.el, page: s.page, text: q }
  : s.kind === 'transcript' ? { kind: 'transcript', el: s.el, t: s.t }
  : s.kind === 'ink' ? { kind: 'ink', el: s.el } : null

function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase()
  if (!q) return 1
  if (s.includes(q)) return 100 - s.indexOf(q)
  let qi = 0, score = 0, streak = 0
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { qi++; streak++; score += streak } else streak = 0
  }
  return qi === q.length ? score : 0
}

export default function Search({ mode, onClose, onOpen }) {
  const [q, setQ] = useState('')
  const [m, setM] = useState(mode)
  const [kind, setKind] = useState('all')
  const [titles, setTitles] = useState([])
  const [results, setResults] = useState([])
  const [status, setStatus] = useState(null)
  const [row, setRow] = useState(0)          // the highlighted page
  const [hit, setHit] = useState(0)          // the highlighted snippet inside it
  const inputRef = useRef(null), listRef = useRef(null), seq = useRef(0)
  useEffect(() => { inputRef.current?.focus(); api.titles().then(setTitles).catch(() => { }) }, [])

  // Full text: debounced query, out-of-order replies dropped. Also re-run when the document index finishes indexing.
  const kindParam = KINDS.find(k => k[0] === kind)?.[2] || null
  const indexing = !!status?.indexing
  useEffect(() => {
    if (m !== 'full') return
    if (!q.trim()) { setResults([]); return }
    const n = ++seq.current
    const t = setTimeout(() => api.search(q, kindParam).then(r => { if (n === seq.current) setResults(Array.isArray(r) ? r : []) }).catch(() => { if (n === seq.current) setResults([]) }), 120)
    return () => clearTimeout(t)
  }, [q, m, kindParam, indexing])
  // The document index's progress: fetched on entering full mode, polled every 2 s while it is still working.
  const indexingRef = useRef(false); indexingRef.current = indexing
  useEffect(() => {
    if (m !== 'full') return
    let alive = true
    const tick = () => api.searchStatus().then(s => { if (alive) setStatus(s) }).catch(() => { if (alive) setStatus(null) })
    tick()
    const t = setInterval(() => { if (indexingRef.current) tick() }, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [m])

  const quick = useMemo(() => titles.map(t => ({ ...t, score: fuzzy(q, t.title) })).filter(t => t.score > 0).sort((a, b) => b.score - a.score).slice(0, 40), [q, titles])
  const rows = m === 'quick' ? quick : results
  useEffect(() => { setRow(0); setHit(0) }, [q, m, kind, rows])
  useEffect(() => { listRef.current?.querySelector('.search-row.active .snippet.hit.active, .search-row.active')?.scrollIntoView?.({ block: 'nearest' }) }, [row, hit])

  const hitsOf = r => (m === 'full' ? r?.snippets || [] : [])
  const open = (r, s) => { if (!r) return; onOpen(r.path, m === 'full' ? targetOf(s === undefined ? r.snippets?.[0] : s, q) : undefined) }
  const cycle = d => { const n = hitsOf(rows[row]).length; if (n) setHit(h => (h + d + n) % n) }
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setRow(r => Math.min(r + 1, Math.max(0, rows.length - 1))); setHit(0); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setRow(r => Math.max(r - 1, 0)); setHit(0); return }
    if (e.key === 'Enter') { e.preventDefault(); const r = rows[row]; if (r) open(r, hitsOf(r)[hit]); return }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (m === 'quick') { setM('full'); return }                          // Tab from titles: full text
      cycle(e.shiftKey ? -1 : 1)                                           // in full text: the next hit on this page
      return
    }
    if (m === 'full' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && hitsOf(rows[row]).length > 1) {
      const inp = inputRef.current
      if (inp && inp.selectionStart === inp.selectionEnd && (e.key === 'ArrowRight' ? inp.selectionEnd === inp.value.length : inp.selectionStart === 0)) { e.preventDefault(); cycle(e.key === 'ArrowRight' ? 1 : -1) }
    }
  }
  const emptyText = !q
    ? (m === 'quick' ? 'Type a page title. Tab switches to full text.' : 'Type to search every note, PDF text and transcript. Accents are ignored.')
    : (m === 'full' && kind !== 'all' ? `Nothing in ${kind === 'pdf' ? 'PDFs' : labelOf(kind).toLowerCase()}.` : 'Nothing found.')
  const pendingPdfs = status?.pendingPdfs || 0, pending = status?.pending || 0
  const foot = indexing ? (pendingPdfs ? `Indexing ${pendingPdfs} PDF${pendingPdfs === 1 ? '' : 's'}… their hits appear as they finish.` : `Indexing ${pending} page${pending === 1 ? '' : 's'}… hits appear as they finish.`) : null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal search" onMouseDown={e => e.stopPropagation()}>
        <div className="search-head">
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder={m === 'quick' ? 'Jump to page…' : 'Search notes, PDFs and transcripts…'} spellCheck={false} />
          <div className="seg"><button type="button" className={m === 'quick' ? 'on' : ''} onClick={() => setM('quick')}>Titles</button><button type="button" className={m === 'full' ? 'on' : ''} onClick={() => setM('full')}>Full text</button></div>
        </div>
        {m === 'full' && (
          <div className="search-kinds">
            <div className="seg">{KINDS.map(([k, label]) => <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => { setKind(k); inputRef.current?.focus() }}>{label}</button>)}</div>
            {status && !indexing && status.pdfs + status.transcripts + status.ink > 0 && <span className="kinds-note">{status.pdfs} PDF{status.pdfs === 1 ? '' : 's'} · {status.transcripts} transcript{status.transcripts === 1 ? '' : 's'}{status.ink ? ` · ${status.ink} ink` : ''}</span>}
          </div>
        )}
        <div className="search-list" ref={listRef}>
          {rows.map((r, ri) => (
            <div key={r.path} className={'search-row' + (ri === row ? ' active' : '')} onMouseEnter={() => { if (ri !== row) { setRow(ri); setHit(0) } }}>
              <div className="search-title" onClick={() => open(r)} title={r.path}>{r.title}<span className="crumb">{r.notebook} › {r.section}</span>{r.count ? <span className="count">{r.count}</span> : null}</div>
              {hitsOf(r).map((s, si) => {
                const chip = CHIP[s.kind]?.(s)
                const Ic = chip?.[0]
                return (
                  <div key={si} className={'snippet hit' + (ri === row && si === hit ? ' active' : '')} onMouseEnter={() => { setRow(ri); setHit(si) }} onClick={e => { e.stopPropagation(); open(r, s) }} title={chip ? chip[2] : 'In the page text'}>
                    {chip && <span className="hit-kind"><Ic width="12" height="12" />{chip[1]}</span>}
                    <span className="hit-text">{s.text}</span>
                  </div>
                )
              })}
            </div>
          ))}
          {rows.length === 0 && <div className="empty">{emptyText}</div>}
        </div>
        {m === 'full' && foot && <div className="search-foot"><span className="spinner" />{foot}</div>}
      </div>
    </div>
  )
}
