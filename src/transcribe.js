import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { has, THIS } from './edition.js'

// Speech is Mac-only (parakeet on Apple Silicon): the Windows kit ships `speech: false` (SPEC §21.9), and every screen
// that would offer a Transcribe button asks this first and offers nothing. The edition alone said yes on an Intel Mac
// with the Mac kit, where the button showed and the server answered 409; the server knows the machine, so where the
// edition allows speech /api/health decides, once, before the first paint (this module is awaited by every screen that
// imports it). A server that does not answer within two seconds leaves the edition's word standing.
const machineSpeech = () => Promise.race([
  fetch('/api/health').then(r => r.json()).then(h => h.speech !== false),
  new Promise(r => setTimeout(r, 2000, true)),
]).catch(() => true)
export const SPEECH = has(THIS, 'speech') && await machineSpeech()

// Transcribing a recording from wherever it shows (SPEC 18.3, from anywhere §20.36). The Transcribe button lived only
// under the player on a recording's own page, so a recording filed with Add files, or seen in a week or the Library,
// had to be opened first. Any of them now asks for the page and polls until it has left the queue on the server
// (server/index.js): one recording runs at a time on this computer, the rest wait their turn.
// phase: idle | queued | running | done | error
const stateOf = (s, page) => {
  if (!s || !page) return null
  if (s.running && s.page === page) return { phase: 'running', since: s.startedAt || null }
  const i = (s.queue || []).indexOf(page)
  return i >= 0 ? { phase: 'queued', ahead: i + (s.running ? 1 : 0) } : null
}

export function useTranscribe(page, { onDone } = {}) {
  // hooks run in the same order every render; the off state is returned after them
  const [st, setSt] = useState({ phase: 'idle' })
  const done = useRef(onDone); done.current = onDone
  const timer = useRef(null)
  const stop = () => { clearInterval(timer.current); timer.current = null }
  const poll = async () => {
    const s = await api.transcribeStatus().catch(() => null)
    if (!s) return
    const now = stateOf(s, page)
    if (now) { setSt(now); return }
    stop()
    const r = s.done?.[page]
    if (r && r.ok === false) setSt({ phase: 'error', note: r.note || 'The transcriber stopped.' })
    else { setSt({ phase: 'done' }); done.current?.() }
  }
  const watch = () => { stop(); timer.current = setInterval(poll, 2500) }
  const start = async e => {
    e?.stopPropagation?.()
    if (!page) return
    setSt({ phase: 'running', since: null })
    const r = await api.transcribe(page).catch(err => ({ error: err.message }))
    if (r?.error) { setSt({ phase: 'error', note: r.error }); return }
    setSt(r.queued ? { phase: 'queued', ahead: r.ahead || 1 } : { phase: 'running', since: null })
    watch()
  }
  // A page opened again while its recording is being transcribed picks the job back up.
  useEffect(() => {
    let alive = true
    setSt({ phase: 'idle' })
    if (page) api.transcribeStatus().then(s => { if (!alive) return; const now = stateOf(s, page); if (now) { setSt(now); watch() } }).catch(() => { })
    return () => { alive = false; stop() }
  }, [page])
  const busy = st.phase === 'running' || st.phase === 'queued'
  const say = st.phase === 'queued' ? `Waiting — ${st.ahead} recording${st.ahead === 1 ? '' : 's'} ahead` : st.phase === 'running' ? 'Transcribing on this computer…' : st.phase === 'error' ? st.note : null
  return { off: !SPEECH, ...st, busy, say, start }
}

// Several at once, in order (Add files): each joins the queue behind the one before. → [{ page, queued, ahead } | { page, error }]
export async function transcribeAll(pages) {
  if (!SPEECH) return []
  const out = []
  for (const page of pages) out.push(await api.transcribe(page).then(r => ({ ...r, page })).catch(e => ({ page, error: e.message })))
  return out
}
