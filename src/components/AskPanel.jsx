// The Ask rail (SPEC.md §20.7): docked beside the active pane's canvas, opaque. Head with the context chips and the
// whole-week toggle, the thread (answers rendered through the page's own markdown renderer, so a note looks the same
// once saved), the suggestions, the compose box. Streams over one POST; Esc stops; "Save as note" (⌘↩) appends one
// block through Canvas's appendBlock (below the page's content); the `solution` preset saves itself as
// `### Solution · <label>`. Keys the box consumes stop there; everything else (⌘K, ⌘J, ⌘P, ⌘\) reaches the shell.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../styles/ask.css'
import { useAsk, thread, patch, toggleAsk, takePending, askStream, contextFor, noteMarkdown, footLine, chipLabel, clearQuote, PRESETS, SUGGESTIONS } from '../ask.js'
import { buildExtensions } from '../editor/extensions.js'
import { createRenderer, typesetMath } from '../editor/markdown.js'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'

const ls = { get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { } } }
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
const kb = s => Math.max(1, Math.round(s / 1000))

// props: { page: the active pane's page object (path, title, dir), onAppend(md, { below }) → blockId | undefined,
//          onReadInk(): recognise whatever ink on the open page is not read yet, awaited before a question is sent }
export default function AskPanel({ page, onAppend, onReadInk }) {
  const ask = useAsk()
  const path = page.path
  const t = thread(path)
  const input = useRef(null), list = useRef(null), abort = useRef(null), stick = useRef(true), raf = useRef(null)
  // Where the bubble sits and how big it is, remembered. `at` is null until it is moved, so it starts in the corner.
  const box = useRef(null)
  const [at, setAt] = useState(() => ls.get('slate.ask.at', null))
  const [size, setSize] = useState(() => ls.get('slate.ask.size', { w: 430, h: 560 }))
  useEffect(() => { ls.set('slate.ask.at', at) }, [at])
  useEffect(() => { ls.set('slate.ask.size', size) }, [size])
  const startMove = e => {
    if (e.target.closest('button, a, input, textarea')) return
    e.preventDefault()
    const host = box.current.parentElement.getBoundingClientRect(), b = box.current.getBoundingClientRect()
    const dx = e.clientX - b.left, dy = e.clientY - b.top
    const go = ev => setAt({
      x: Math.max(8, Math.min(host.width - b.width - 8, ev.clientX - host.left - dx)),
      y: Math.max(8, Math.min(host.height - b.height - 8, ev.clientY - host.top - dy)),
    })
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up)
  }
  const startSize = e => {
    e.preventDefault(); e.stopPropagation()
    const b = box.current.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, w0 = b.width, h0 = b.height
    const go = ev => setSize({ w: Math.max(320, Math.round(w0 + (ev.clientX - x0))), h: Math.max(280, Math.round(h0 + (ev.clientY - y0))) })
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up)
  }
  const resolveSrc = useMemo(() => src => (/^(https?:|data:|blob:|\/)/.test(src || '') ? src : api.fileUrl(page.dir, src)), [page.dir])
  const renderer = useMemo(() => createRenderer(buildExtensions({ resolveSrc })), [resolveSrc])
  useEffect(() => () => renderer.destroy(), [renderer])

  // Focus the box and read the page's context when the rail opens or the page changes.
  useEffect(() => { input.current?.focus(); if (!t.context) loadContext(path, t.week) }, [path])
  // A pending openAsk() for this page fires whether the rail was just mounted or already open (every store change looks).
  useEffect(() => {
    const p = takePending(path)
    if (p) send({ question: p.question || undefined, preset: p.preset || undefined, block: p.block || undefined, problem: p.problem || undefined })
  }, [path, ask.version])
  useEffect(() => () => { abort.current?.abort() }, [])   // leaving the app: no orphan stream (the thread stays)

  const loadContext = (p, week) => contextFor(p, { week }).then(c => patch(p, th => { th.context = c })).catch(e => patch(p, th => { th.context = { error: e.message, items: [] } }))
  const setWeek = week => { patch(path, th => { th.week = week; th.context = null }); loadContext(path, week) }

  const send = async ({ question, preset, block, problem } = {}) => {
    if (abort.current) return
    const th = thread(path)
    const asked = preset ? PRESETS[preset]?.label || preset : String(question ?? th.draft).trim()
    // A selected passage rides with the question rather than replacing it: "about this passage … <what you asked>".
    const q = !preset && th.quote ? `About this passage from the page:\n\n“${th.quote}”\n\n${asked}` : asked
    if (!asked) return
    const turn = { id: uid(), at: new Date().toISOString(), q, asked, quote: (!preset && th.quote) || null, image: (!preset && th.image) || null, preset: preset || null, block: block || null, problem: problem || null, a: '', sources: [], chars: 0, status: 'streaming', phase: 'reading', error: null, ms: null, model: null, usage: null, saved: null }
    const history = th.turns.filter(x => x.status === 'done' && x.a).slice(-6).map(x => ({ q: x.q, a: x.a }))
    patch(path, x => { x.turns.push(turn); x.quote = null; x.image = null; if (!question && !preset) x.draft = '' })
    stick.current = true
    abort.current = new AbortController()
    // Read the pen before reading the page (SPEC §20.51). The canvas recognises on its own a few seconds after the pen
    // stops, which covers writing then thinking then asking; this covers writing and asking in the same breath. It is
    // a no-op when every element is already read — unchanged ink is skipped by its hash — and a failure here must
    // never stop the question: the answer is then simply the one it would have given a moment ago.
    try { await onReadInk?.() } catch { }
    const flush = () => { raf.current = null; patch(path, () => { }) }
    const later = () => { if (!raf.current) raf.current = setTimeout(flush, 120) }
    try {
      await askStream({ page: path, question: preset ? undefined : q, preset, block, problem, history, week: th.week, image: (!preset && th.image) || undefined }, ev => {
        if (ev.type === 'context') { turn.sources = ev.items || []; turn.chars = ev.chars || 0; patch(path, x => { x.context = ev }) }
        else if (ev.type === 'status') { turn.phase = ev.phase; if (ev.model) turn.model = ev.model; later() }
        else if (ev.type === 'delta') { turn.a += ev.text; later() }
        else if (ev.type === 'done') { turn.status = 'done'; turn.ms = ev.ms; turn.model = ev.model || turn.model; turn.usage = ev.usage || null }
        else if (ev.type === 'error') { turn.status = 'error'; turn.error = { code: ev.code, message: ev.message } }
      }, abort.current.signal)
      if (turn.status === 'streaming') { if (turn.a) turn.status = 'stopped'; else { turn.status = 'error'; turn.error = { code: 'exit', message: 'The connection closed before an answer arrived.' } } }
    } catch (e) {
      if (e.name === 'AbortError') turn.status = turn.a ? 'stopped' : 'error'
      else turn.status = 'error'
      if (turn.status === 'error') turn.error = { code: e.status === 409 ? 'busy' : e.name === 'AbortError' ? 'stopped' : 'exit', message: e.status === 409 ? 'Another answer is still being written.' : e.name === 'AbortError' ? 'Stopped before an answer arrived.' : e.message }
    } finally {
      clearTimeout(raf.current); raf.current = null
      abort.current = null
      patch(path, () => { })
    }
    if (turn.status === 'done' && turn.preset && PRESETS[turn.preset]?.auto) save(turn)   // the solution lands on the page by itself
  }
  const stop = () => abort.current?.abort()
  const save = turn => { if (turn.saved || !turn.a.trim()) return; const id = onAppend?.(noteMarkdown(turn), { below: true }); if (id) patch(path, () => { turn.saved = id }) }
  const retry = turn => send({ question: turn.preset ? undefined : (turn.asked || turn.q), preset: turn.preset || undefined, block: turn.block || undefined, problem: turn.problem || undefined })
  const lastDone = [...t.turns].reverse().find(x => x.status === 'done' && !x.saved)
  const lastTurn = t.turns[t.turns.length - 1]

  const onKey = e => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Enter' && !e.shiftKey && !mod) { e.preventDefault(); e.stopPropagation(); send() }
    else if (e.key === 'Enter' && mod && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); if (lastDone) save(lastDone) }
    else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (abort.current) stop()
      else if (t.draft) patch(path, th => { th.draft = '' })
      else { toggleAsk(false); document.activeElement?.blur() }
    }
    else if (e.key === 'ArrowUp' && !t.draft && t.turns.length && !mod) { e.preventDefault(); e.stopPropagation(); patch(path, th => { const l = th.turns[th.turns.length - 1]; th.draft = l.asked || l.q }) }
    else if (e.key === 'Tab' && !e.shiftKey && !mod && lastTurn && lastTurn.status !== 'streaming') {
      const b = list.current?.querySelector('.ask-turn:last-child .ask-foot button'); if (b) { e.preventDefault(); e.stopPropagation(); b.focus() }
    }
  }
  useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight })

  const ctx = t.context, items = ctx?.items || []
  const hasWeek = items.some(i => i.tier >= 3) || ctx?.inWeek
  const courseName = items.find(i => i.kind === 'course')?.name
  return (
    <aside ref={box} className={'ask-panel ask' + (at ? ' placed' : '')} style={{ '--ask-w': size.w + 'px', '--ask-h': size.h + 'px', ...(at ? { left: at.x, top: at.y } : {}) }} aria-label="Ask Claude">
      <div className="ask-head" onPointerDown={startMove}>
        <span className="ask-grip"><Icon.grip width="11" height="11" /></span>
        <h2>Ask the page</h2>
        <span className="spacer" />
        {ctx && hasWeek && <button className="ask-link" title={t.week === 'full' ? 'Back to the brief week: transcripts, decks and sheets trimmed' : 'Read the whole week: every transcript, deck and sheet under the budget'} onClick={() => setWeek(t.week === 'full' ? 'brief' : 'full')}>{t.week === 'full' ? 'Read less' : 'Read the whole week'}</button>}
        <button className="icon-btn" title="Close ⌘J" onClick={() => toggleAsk(false)}><Icon.x width="16" height="16" /></button>
      </div>
      <div className="ask-src">
        {!ctx ? <span className="ask-note ask-pulse">Reading the page…</span>
          : ctx.error ? <span className="ask-note danger">Could not read the page: {ctx.error}</span>
          : ctx.empty ? <span className="ask-note">{ctx.course ? `This page is empty — Claude sees only the ${courseName} course plan.` : 'This page is empty — Claude sees only the page.'}</span>
          : <>
              {items.map((i, n) => <span key={n} className={'ask-chip' + (i.dropped ? ' dropped' : i.truncated ? ' cut' : '')} title={i.dropped ? `${i.name}: not read — over the ${kb(ctx.budget)} KB budget` : i.truncated ? `cut to ${kb(i.kept)} KB of ${kb(i.chars)}` : `${kb(i.chars)} KB`}>{chipLabel(i)}{i.kind === 'page' && ctx.pageEmpty ? ' (empty)' : ''}</span>)}
              {!ctx.course && <span className="ask-note">Not a course page — Claude sees only the page.</span>}
            </>}
      </div>
      <div className="ask-thread" ref={list} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40 }}>
        {t.turns.length === 0 && <div className="ask-presets">{SUGGESTIONS.map(s => <button key={s} className="chip" onClick={() => send({ question: s })}>{s}</button>)}</div>}
        {t.turns.map(turn => <Turn key={turn.id} turn={turn} renderer={renderer} onSave={() => save(turn)} onRetry={() => retry(turn)} />)}
      </div>
      <div className="ask-size" title="Drag to resize" onPointerDown={startSize} />
      <div className="ask-compose">
        {t.quote && (
          <div className="ask-quote">
            <span className="ask-quote-k">About this passage</span>
            <p>“{t.quote.length > 220 ? t.quote.slice(0, 220) + '…' : t.quote}”</p>
            <button className="ask-quote-x" title="Ask about the whole page instead" onClick={() => clearQuote(path)}><Icon.x width="12" height="12" /></button>
          </div>)}
        {t.image && (
          <div className="ask-quote ask-shot">
            <span className="ask-quote-k">About this part of the page</span>
            <img src={api.fileUrl(page.dir, t.image.startsWith(page.dir + '/') ? t.image.slice(page.dir.length + 1) : t.image)} alt="the region you circled" />
            <button className="ask-quote-x" title="Ask about the whole page instead" onClick={() => clearQuote(path)}><Icon.x width="12" height="12" /></button>
          </div>)}
        <textarea ref={input} className="ask-input" rows={1} value={t.draft} placeholder={t.quote || t.image ? 'What do you want to know about it? ↩ sends' : 'Ask about this page… ↩ sends, ⇧↩ new line'} onChange={e => patch(path, th => { th.draft = e.target.value })} onKeyDown={onKey} />
        {abort.current
          ? <button className="btn small" onClick={stop}>Stop <kbd>esc</kbd></button>
          : <button className="btn small primary" disabled={!t.draft.trim()} onClick={() => send()}>Ask <kbd>↩</kbd></button>}
      </div>
    </aside>
  )
}

function Turn({ turn, renderer, onSave, onRetry }) {
  const ref = useRef(null)
  const html = useMemo(() => renderer.html(turn.a), [turn.a, renderer])
  const inner = useMemo(() => ({ __html: html }), [html])   // stable identity, or React 19 re-sets innerHTML and drops the typeset math
  useLayoutEffect(() => { if (ref.current) typesetMath(ref.current) }, [html])
  const streaming = turn.status === 'streaming'
  const copy = () => { try { navigator.clipboard?.writeText(turn.a) } catch { } }
  return (
    <div className={'ask-turn ' + turn.status}>
      <div className="ask-q">{turn.asked || turn.q}{turn.quote ? <span className="ask-q-sub"> · about a passage</span> : turn.image ? <span className="ask-q-sub"> · about a clipped region</span> : null}{turn.preset === 'solution' && turn.problem?.label ? <span className="ask-q-sub"> · {turn.problem.label}</span> : null}</div>
      {turn.status === 'error'
        ? <div className="ask-err">{turn.error?.message}{turn.error?.code === 'login' && <span className="ask-hint">Same fix as the Sync button.</span>}</div>
        : turn.a
          ? <div className="ask-a prose ask-md" ref={ref} dangerouslySetInnerHTML={inner} />
          : streaming ? <div className="ask-wait ask-pulse">{turn.phase === 'thinking' ? 'Thinking…' : turn.phase === 'writing' ? 'Writing…' : 'Reading the page…'}</div> : null}
      {streaming && turn.a && <span className="ask-caret" />}
      {(turn.status === 'done' || turn.status === 'stopped') && (
        <div className="ask-foot">
          <span className="ask-meta">{turn.status === 'stopped' ? 'stopped · ' : ''}{footLine(turn)}</span>
          {turn.saved
            ? <span className="ask-saved">{turn.preset === 'solution' ? 'Written at the end of the page' : 'Saved on the page'} · ⌘Z undoes</span>
            : <><button className="ask-link" onClick={onSave}>Save as note <kbd>⌘↩</kbd></button><button className="ask-link" onClick={copy}>Copy</button></>}
          <button className="ask-link" onClick={onRetry}>Retry</button>
        </div>)}
      {turn.status === 'error' && <div className="ask-foot"><button className="ask-link" onClick={onRetry}>Retry</button></div>}
    </div>
  )
}
