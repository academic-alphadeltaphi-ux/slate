import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'
import { useTranscribe, SPEECH } from '../transcribe.js'

const fmtSize = n => (n == null ? '' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B')
const nameOf = src => decodeURIComponent((src || '').split('/').pop())
const extOf = src => (nameOf(src).split('.').pop() || '').toUpperCase().slice(0, 4)

export function FileCard({ el, url }) {
  return (
    <div className="file-card" onClick={e => e.stopPropagation()}>
      <div className="file-icon">{extOf(el.src)}</div>
      <div className="file-body"><div className="file-name" title={nameOf(el.src)}>{nameOf(el.src)}</div><div className="file-meta">{fmtSize(el.size)}</div></div>
      <a className="btn small" href={url} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}>Open</a>
    </div>
  )
}
export function ImageEl({ el, url, width }) {
  return <img className="el-img" src={url} alt={nameOf(el.src)} draggable={false} style={{ width, height: typeof el.h === 'number' ? el.h : 'auto' }} onClick={e => e.stopPropagation()} onError={e => e.currentTarget.classList.add('broken')} />
}
export const hms = sec => [sec / 3600, (sec % 3600) / 60, sec % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':').replace(/^00:/, '')

// Where a recording's transcript may be, nearest first. A transcript is named after the recording, so a page showing two
// of them keeps two; the ones written before that rule carry the page's title instead. `url` is the recording's own URL.
export function transcriptUrls(el, url) {
  const dir = (el?.src || '').split('/')[0]                    // "<Title>.assets"
  const title = dir.replace(/\.assets$/, '')
  const stem = decodeURIComponent((el?.src || '').split('/').pop() || '').replace(/\.[^.]+$/, '')
  return dir && url ? [...new Set([stem, title].filter(Boolean))].map(n => url.replace(/[^/]+$/, '') + encodeURIComponent(n + '.transcript.json')) : []
}
// The transcript ({ paragraphs: [{ start, text }], minutes, engine }) or null. The player's panel and every export read it
// through this (SPEC §20.33), so a copy of a page carries the same words the page shows.
export async function fetchTranscript(el, url) {
  for (const u of transcriptUrls(el, url)) {
    const got = await fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null)
    if (got) return got
  }
  return null
}

// A recording carries its transcript with it: `<Title>.assets/<Title>.transcript.json`, written by
// scripts/transcribe.mjs. The panel sits directly under the player (SPEC 18.3) — click a paragraph
// and the audio jumps to the moment it was said.
// `seek` ({ t, nonce } | null) is a search hit (SPEC §20.6): the playhead is set to the paragraph's start — not played,
// nothing should start talking because you searched — the panel opens with a clear filter and the paragraph is centred.
export function MediaEl({ el, url, width, page, onTranscribed, seek = null }) {
  const video = /\.(mp4|mov|webm)$/i.test(el.src)
  const media = useRef(null), panel = useRef(null)
  const [tr, setTr] = useState(null)
  const [open, setOpen] = useState(true)
  const [at, setAt] = useState(0)
  const [q, setQ] = useState('')

  const trKey = transcriptUrls(el, url).join('|')
  const load = async () => setTr(await fetchTranscript(el, url))
  useEffect(() => { load() }, [trKey])

  // Transcription runs on this computer, one recording at a time, queued on the server (src/transcribe.js, SPEC §20.36);
  // when this page's turn is over the transcript is picked up.
  const stt = useTranscribe(page, { onDone: () => { load(); onTranscribed?.() } })
  const start = e => stt.start(e)
  const jump = t => { const m = media.current; if (!m) return; m.currentTime = t; m.play?.() }
  useEffect(() => {
    if (!seek || typeof seek.t !== 'number') return
    const m = media.current; if (!m) return
    let done = false
    const go = () => {
      if (done) return; done = true
      try { m.currentTime = seek.t } catch { }
      setAt(seek.t); setOpen(true); setQ('')
      requestAnimationFrame(() => { const p = panel.current, now = p?.querySelector('.tr-p.now'); if (p && now) p.scrollTop = Math.max(0, now.offsetTop - p.clientHeight / 2) })
    }
    if (m.readyState >= 1) go(); else m.addEventListener('loadedmetadata', go, { once: true })
    return () => { done = true; m.removeEventListener('loadedmetadata', go) }
  }, [seek?.nonce, tr])   // `tr` too: a seek that arrives before the transcript loads runs once it has

  const paras = tr?.paragraphs || []
  const hit = q.trim().toLowerCase()
  const shown = hit ? paras.filter(p => p.text.toLowerCase().includes(hit)) : paras
  const current = paras.findLastIndex?.(p => p.start <= at) ?? -1

  const player = video
    ? <video ref={media} className="el-media" src={url} controls preload="metadata" style={{ width }} onTimeUpdate={e => setAt(e.currentTarget.currentTime)} onClick={e => e.stopPropagation()} />
    : <audio ref={media} src={url} controls preload="metadata" style={{ width: '100%' }} onTimeUpdate={e => setAt(e.currentTarget.currentTime)} />

  return (
    <div className="el-audio" style={{ width }} onClick={e => e.stopPropagation()}>
      <div className="file-name">{nameOf(el.src)}</div>
      {player}
      <div className="tr-bar">
        {tr ? (
          <>
            <button className="btn small" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show'} transcript</button>
            <span className="tr-meta">{paras.length} paragraphs · {tr.minutes} min · {tr.engine}</span>
            {open && <input className="tr-search" value={q} placeholder="Search the transcript…" onChange={e => setQ(e.target.value)} />}
          </>
        ) : !SPEECH ? (
          <span className="tr-meta">Transcription is Mac-only and not part of this copy.</span>
        ) : stt.busy ? (
          <span className="tr-meta">{stt.phase === 'queued' ? stt.say : "Transcribing on this computer… about a twentieth of the recording's length."}</span>
        ) : (
          <>
            <button className="btn small" onClick={start}>Transcribe</button>
            {stt.phase === 'error' && <span className="tr-meta tr-err">{stt.note}</span>}
          </>
        )}
      </div>
      {tr && open && (
        <div className="tr-panel" ref={panel}>
          {shown.length === 0 && <p className="tr-meta">Nothing matches “{q}”.</p>}
          {shown.map((p, i) => (
            <p key={i} className={'tr-p' + (paras[current] === p ? ' now' : '')} onClick={() => jump(p.start)} title="Jump to this moment">
              <button className="tr-t" onClick={e => { e.stopPropagation(); jump(p.start) }}>{hms(p.start)}</button>
              {p.text}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// A document collapsed to a pill. Its file and annotations stay; only the page shows less.
export function HiddenCard({ el, kind, onShow }) {
  const Ic = kind === 'pdf' ? Icon.file : kind === 'image' ? Icon.image : kind === 'media' ? Icon.headphones : Icon.clip
  return (
    <div className="hidden-card" onClick={e => e.stopPropagation()} onDoubleClick={onShow} title="Double-click or press Show to expand">
      <span className="hc-icon"><Ic width="15" height="15" /></span><span className="file-name">{nameOf(el.src)}</span><span className="file-meta">{fmtSize(el.size)}</span>
      <button className="btn small" onClick={onShow}>Show</button>
    </div>
  )
}
