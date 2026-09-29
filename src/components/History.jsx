import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { buildExtensions } from '../editor/extensions.js'
import { createRenderer } from '../editor/markdown.js'
import TextBlock from './TextBlock.jsx'
import { useDialog } from './Dialog.jsx'
import { Icon } from './Icons.jsx'
import '../styles/history.css'

// The version-history sheet (SPEC §20.10): the snapshots that touched this page (left), the selected version
// rendered as the page renders it, a line diff against what is on disk now, a layout summary (right), and
// Restore… — which never writes on the server: it hands the old blocks and layout to the open Canvas
// (`replace`), whose autosave carries the hash check, the conflict banner and ⌘Z. A snapshot is taken after the
// pre-restore flush and before `replace` — so what was on the page is a commit, not only in-memory ⌘Z — and again after.
// The restore stops short of `replace` when that flush ends in the conflict banner or that snapshot fails: the promise
// the dialog makes ("saved and snapshotted first") holds, or nothing on the page changes.
// props: { page: <the left pane's page>, canvasRef: <its Canvas handle>, onClose, onRestored? }
const DOC_TYPES = new Set(['image', 'file', 'media', 'pdf'])
const when = s => (s ? new Date(s * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '…')
const nameOf = src => { try { return decodeURIComponent(String(src || '').split('/').pop()) } catch { return String(src || '').split('/').pop() } }
const bodyOf = blocks => (blocks || []).map(b => b.md || '').join('\n\n')

// Line diff: common prefix and suffix are trimmed first (most edits), the middle goes through an LCS on lines;
// a middle too large for O(n·m) (n·m > 4e6 — pages are hundreds of lines) is reported as replaced wholesale.
// Returns [{ t: ' ' | '+' | '-', s }].
export function lineDiff(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n')
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++
  const out = A.slice(0, pre).map(s => ({ t: ' ', s }))
  const X = A.slice(pre, A.length - suf), Y = B.slice(pre, B.length - suf), n = X.length, m = Y.length
  if (n * m > 4e6) { out.push(...X.map(s => ({ t: '-', s })), ...Y.map(s => ({ t: '+', s }))) }
  else if (n || m) {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = X[i] === Y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    let i = 0, j = 0
    while (i < n && j < m) { if (X[i] === Y[j]) { out.push({ t: ' ', s: X[i] }); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: X[i++] }); else out.push({ t: '+', s: Y[j++] }) }
    while (i < n) out.push({ t: '-', s: X[i++] })
    while (j < m) out.push({ t: '+', s: Y[j++] })
  }
  out.push(...A.slice(A.length - suf).map(s => ({ t: ' ', s })))
  return out
}
const layoutSummary = layout => {
  const els = layout?.elements || []
  return {
    docs: els.filter(e => DOC_TYPES.has(e.type)).map(e => nameOf(e.src)),
    strokes: els.filter(e => e.type === 'ink').reduce((n, e) => n + (Array.isArray(e.strokes) ? e.strokes.length : 0), 0),
    annotations: els.filter(e => e.type === 'highlight' || e.type === 'underline').length,
    pinned: els.filter(e => e.type === 'text' && e.x != null).length,
  }
}

export default function History({ page, canvasRef, onClose, onRestored }) {
  const dialog = useDialog()
  const [list, setList] = useState(null)      // GET /api/history
  const [sel, setSel] = useState('now')
  const [ver, setVer] = useState(null)        // GET /api/history/show for `sel`
  const [verErr, setVerErr] = useState(null)
  const [now, setNow] = useState(null)        // api.page: the on-disk text and layout the diff runs against
  const [tab, setTab] = useState('preview')
  const [busy, setBusy] = useState(false)
  const [snapping, setSnapping] = useState(false)
  const load = () => api.history(page.path).then(setList).catch(e => setList({ path: page.path, available: false, error: e.message, now: null, snapshots: [] }))
  useEffect(() => { setSel('now'); setTab('preview'); load(); api.page(page.path).then(setNow).catch(() => setNow(null)) }, [page.path])
  useEffect(() => {
    if (sel === 'now') { setVer(null); setVerErr(null); return }
    let alive = true; setVer(null); setVerErr(null)
    api.historyShow(page.path, sel).then(v => { if (alive) setVer(v) }).catch(e => { if (alive) setVerErr(e.message) })
    return () => { alive = false }
  }, [sel, page.path])
  useEffect(() => { const h = e => { if (e.key === 'Escape' && !busy) onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose, busy])
  const renderer = useMemo(() => createRenderer(buildExtensions({ resolveSrc: src => (/^(https?:|data:|blob:|\/)/.test(src || '') ? src : api.fileUrl(page.dir, src)) })), [page.dir])
  useEffect(() => () => renderer.destroy(), [renderer])

  const shown = sel === 'now' ? (now ? { md: now.exists ? { blocks: now.blocks } : null, layout: now.layout } : null) : ver
  const summary = useMemo(() => (shown ? layoutSummary(shown.layout) : null), [shown])
  const missing = useMemo(() => {
    if (!shown?.layout || !now) return []
    const have = new Set(now.assets || [])
    return [...new Set((shown.layout.elements || []).filter(e => e.src && DOC_TYPES.has(e.type)).map(e => nameOf(e.src)).filter(n => !have.has(n)))]
  }, [shown, now])
  const diff = useMemo(() => (tab === 'changes' && ver?.md && now ? lineDiff(bodyOf(ver.md.blocks), bodyOf(now.blocks)) : null), [tab, ver, now])
  const changed = diff ? diff.filter(l => l.t !== ' ').length : 0
  const dirty = list?.now && (list.now.md !== 'clean' || list.now.layout !== 'clean')

  const restore = async () => {
    if (!ver || !canvasRef?.current) return
    const options = [
      ...(ver.md ? [{ value: 'both', label: 'Text and layout', hint: 'Blocks, documents, highlights and ink as they were.', recommended: true }, { value: 'text', label: 'Text only', hint: 'Keeps today\'s layout and ink.' }] : []),
      { value: 'layout', label: 'Layout and ink only', hint: ver.layout ? 'Keeps today\'s text.' : 'This snapshot had no sidecar: clears the layout and ink.', recommended: !ver.md },
    ]
    const what = await dialog.choose({ title: `Restore this page as of ${when(ver.at)}?`, message: 'What is on the page now is saved and snapshotted first, so ⌘Z or this list brings it back. Kind, tags and the created date are kept.', options })
    if (!what) return
    setBusy(true)
    try {
      const c = canvasRef.current
      // `flush` resolves false when a save hit the conflict banner (Canvas returns undefined before that change: no guard
      // then): the page's edits are not on disk, so nothing is replaced until the banner is settled.
      if (await c.flush() === false) { await dialog.alert({ title: 'Not restored', message: 'This page conflicts with its file on disk, so what is on it now could not be saved. Settle the banner (Keep mine or Reload), then restore again.' }); return }
      // The pre-restore text and sidecar become a commit before they are overwritten: server/git.js only snapshots on a
      // five-minute timer and ⌘Z lives in memory, so without this a restore over today's ink left it recoverable nowhere.
      // A snapshot that fails (git error, an index.lock held by the timer's own commit) stops the restore here rather
      // than going on unprotected; `{ skipped: true }` from a root without git is not a failure.
      try { await api.snapshot() } catch (e) { await dialog.alert({ title: 'Not restored', message: `The page could not be snapshotted before restoring, so nothing was changed. ${e.message || ''}`.trim() }); return }
      c.replace({ blocks: what !== 'layout' && ver.md ? ver.md.blocks : undefined, layout: what !== 'text' ? (ver.layout && Array.isArray(ver.layout.elements) ? { version: 1, elements: ver.layout.elements } : { version: 1, elements: [] }) : undefined })
      await c.flush()
      await api.snapshot().catch(() => { })
      onRestored?.()
      onClose()
    } finally { setBusy(false) }
  }
  const snapNow = async () => { setSnapping(true); try { await api.snapshot(); await load() } finally { setSnapping(false) } }

  return (
    <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="dialog history-sheet" role="dialog" aria-label="Version history" onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); e.stopPropagation() }}>
        <aside className="hist-side">
          <div className="hist-head"><span className="hist-kicker">Versions</span><strong className="hist-title" title={page.path}>{page.title}</strong></div>
          <div className="hist-list">
            <button className={'hist-row' + (sel === 'now' ? ' selected' : '')} onClick={() => setSel('now')}>
              <span className="hist-when">Now — on disk</span>
              <span className="hist-sub">{!list ? '…' : !list.available ? 'no repository' : dirty ? 'not yet snapshotted' : 'same as the last snapshot'}</span>
            </button>
            {list?.snapshots.map(s => (
              <button key={s.hash} className={'hist-row' + (sel === s.hash ? ' selected' : '')} onClick={() => setSel(s.hash)} title={s.subject}>
                <span className="hist-when">{when(s.at)}</span>
                <span className="hist-sub">{s.md && <span className="hist-chip">+{s.md.added} −{s.md.removed} text</span>}{s.layout && <span className="hist-chip">layout</span>}</span>
              </button>
            ))}
            {list && !list.available && <div className="hist-empty">No snapshot repository in this root.{list.error ? ` (${list.error})` : ''}</div>}
            {list?.available && list.snapshots.length === 0 && <div className="hist-empty">No snapshot has recorded this page yet. Snapshots run every five minutes.</div>}
          </div>
          {list?.available && <button className="link hist-snap" disabled={snapping} onClick={snapNow}>{snapping ? 'Snapshotting…' : 'Snapshot now'}</button>}
        </aside>
        <section className="hist-main">
          <header className="hist-bar">
            <strong className="hist-date">{sel === 'now' ? 'Now' : when(ver?.at || list?.snapshots.find(s => s.hash === sel)?.at)}</strong>
            <span className="seg text">
              <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>Preview</button>
              <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')} disabled={sel === 'now'} title={sel === 'now' ? 'Pick a version to compare with the page on disk' : 'This version against the page on disk'}>Changes</button>
              <button className={tab === 'layout' ? 'on' : ''} onClick={() => setTab('layout')}>Layout</button>
            </span>
            <span className="spacer" />
            <button className="btn primary" disabled={sel === 'now' || !ver || busy} onClick={restore}>{busy ? 'Restoring…' : 'Restore…'}</button>
            <button className="icon-btn" title="Close (Esc)" onClick={onClose}><Icon.x /></button>
          </header>
          <div className={'hist-body' + (tab === 'preview' ? ' paper' : '')}>
            {sel !== 'now' && !ver && !verErr && <div className="hist-empty">Loading the version…</div>}
            {verErr && <div className="hist-empty">Could not read this version: {verErr}</div>}
            {tab === 'preview' && shown?.md && <div className="hist-preview">{shown.md.blocks.map((b, i) => <div key={b.id || 'first-' + i} className="hist-block"><TextBlock id={b.id || '__first'} md={b.md} focused={false} renderer={renderer} onFocus={() => { }} onOpenTitle={() => { }} /></div>)}</div>}
            {tab === 'preview' && shown && !shown.md && <div className="hist-empty">{sel === 'now' ? 'This page has no file on disk.' : 'The page text did not exist at this snapshot.'}</div>}
            {tab === 'changes' && diff && <>
              <div className="hist-diff-head">{changed ? `${diff.filter(l => l.t === '-').length} lines only in this version (−), ${diff.filter(l => l.t === '+').length} only on disk now (+)` : 'The text is identical to the page on disk.'}</div>
              <pre className="hist-diff">{diff.map((l, i) => <span key={i} className={'d' + (l.t === '+' ? ' add' : l.t === '-' ? ' del' : '')}>{l.t === ' ' ? '  ' : l.t + ' '}{l.s}{'\n'}</span>)}</pre>
            </>}
            {tab === 'changes' && ver && !ver.md && <div className="hist-empty">The page text did not exist at this snapshot; there is nothing to compare.</div>}
            {tab === 'layout' && shown && summary && <dl className="hist-layout">
              <dt>Documents</dt><dd>{summary.docs.length ? summary.docs.join(', ') : 'none'}</dd>
              <dt>Ink</dt><dd>{summary.strokes} stroke{summary.strokes === 1 ? '' : 's'}</dd>
              <dt>Highlights</dt><dd>{summary.annotations}</dd>
              <dt>Pinned text</dt><dd>{summary.pinned} block{summary.pinned === 1 ? '' : 's'}</dd>
              {shown.layout?.corrupt && <><dt>Warning</dt><dd className="danger">The sidecar at this snapshot could not be parsed; restoring it clears the layout.</dd></>}
              {missing.length > 0 && <><dt>Missing files</dt><dd className="danger">{missing.join(', ')} — no longer in this page's assets, so {missing.length === 1 ? 'it' : 'they'} would show as broken. Assets are never snapshotted.</dd></>}
            </dl>}
          </div>
          <div className="hist-foot">Restoring writes through the editor, so it is saved, snapshotted and undoable like any edit. Frontmatter (kind, tags, created) is never touched; files in the page's assets are not versioned.</div>
        </section>
      </div>
    </div>
  )
}
