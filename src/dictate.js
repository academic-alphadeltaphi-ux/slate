// Speak and it is typed (SPEC §20.29).
//
// The first version used the browser's `webkitSpeechRecognition`. That is Google's recogniser, over the network, and
// Chromium builds that are not Chrome — Electron, this app's own shell — ship without the key for it, so it fails
// with `network` however good the connection is. It is gone. Dictation now runs on the same parakeet-mlx model that
// turns lectures into words, on the M-series GPU, offline: nothing spoken leaves the machine.
//
// The microphone is recorded continuously and cut at pauses rather than on a timer, so every clip sent is a whole
// phrase — a clip chopped mid-word transcribes as a mangled one. A meter watches the level; when it has been quiet
// for `HUSH` and there was speech before it, the segment closes, goes to POST /api/dictate, and the next begins.
import { api } from './api.js'

const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) || ''
export const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && !!MIME

const HUSH = 700          // ms of quiet that ends a phrase
const MIN_MS = 900        // never cut a clip shorter than this
const MAX_MS = 14000      // ...nor let one run longer
const FLOOR = 0.012       // RMS below this is silence in a normal room

const SAY = {
  NotAllowedError: 'The microphone is blocked. Allow it for slate in System Settings › Privacy, then try again.',
  NotFoundError: 'No microphone was found.',
  NotReadableError: 'Something else is using the microphone.',
}

// start({ onPhrase(text), onState(s), onEnd(errorOrNull) }) → stop()
// `onState` reports what the user should see: 'listening' | 'hearing' | 'thinking' | 'warming'.
// The level meter runs on the audio thread, not on animation frames: a hidden or background window stops painting,
// and with it `requestAnimationFrame` — which would have left dictation listening for ever without cutting a single
// phrase the moment the student switched app mid-lecture.
const METER = `class M extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c){let s=0;for(let k=0;k<c.length;k++)s+=c[k]*c[k];this.port.postMessage(Math.sqrt(s/c.length))}return true}}registerProcessor('slate-meter',M)`

export function start({ onPhrase, onState, onEnd } = {}) {
  if (!supported) { onEnd?.('This browser cannot record audio.'); return () => { } }
  let stream = null, rec = null, ctx = null, timer = 0, stopped = false
  let chunks = [], spoke = false, quietFrom = 0, startedAt = 0, inFlight = 0

  const finish = err => { if (stopped) return; stopped = true; cleanup(); onEnd?.(err || null) }
  const cleanup = () => {
    clearInterval(timer)
    try { rec && rec.state !== 'inactive' && rec.stop() } catch { }
    try { stream?.getTracks().forEach(t => t.stop()) } catch { }
    ctx?.close?.().catch?.(() => { })
  }

  const send = async blob => {
    if (!blob.size) return
    inFlight++
    onState?.('thinking')
    try {
      const { text } = await api.dictate(blob)
      if (text?.trim()) onPhrase?.(text.trim())
    } catch (e) {
      // A warming model is not a failure — the first phrase of a session waits for it and arrives late.
      if (e.status === 503 || e.status === 504) onState?.('warming')
      else { finish(e.message); return }
    } finally { inFlight--; if (!stopped) onState?.(inFlight ? 'thinking' : 'listening') }
  }

  // One segment: record until the phrase ends, hand the blob over, begin the next.
  const segment = () => {
    if (stopped) return
    chunks = []; spoke = false; quietFrom = 0; startedAt = performance.now()
    rec = new MediaRecorder(stream, { mimeType: MIME })
    rec.ondataavailable = e => e.data.size && chunks.push(e.data)
    rec.onstop = () => { const blob = new Blob(chunks, { type: MIME }); if (spoke) send(blob); segment() }
    rec.onerror = e => finish(`The recorder stopped: ${e.error?.message || 'unknown error'}`)
    try { rec.start() } catch (e) { finish(`The recorder could not start: ${e.message}`) }
  }
  const cut = () => { try { rec?.state === 'recording' && rec.stop() } catch { } }

  // One level reading decides whether the phrase is still going. Called from the worklet, or from a timer where
  // there is no worklet to be had.
  const level = rms => {
    if (stopped) return
    const now = performance.now(), age = now - startedAt
    if (rms > FLOOR) { spoke = true; quietFrom = 0; if (!inFlight) onState?.('hearing') }
    else if (spoke && !quietFrom) quietFrom = now
    if (age > MAX_MS || (spoke && quietFrom && now - quietFrom > HUSH && age > MIN_MS)) cut()
  }

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(async s => {
      if (stopped) { s.getTracks().forEach(t => t.stop()); return }
      stream = s
      ctx = new (window.AudioContext || window.webkitAudioContext)()
      const src = ctx.createMediaStreamSource(s)
      let onAudioThread = false
      try {
        const url = URL.createObjectURL(new Blob([METER], { type: 'application/javascript' }))
        await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url)
        if (stopped) return
        const node = new AudioWorkletNode(ctx, 'slate-meter')
        node.port.onmessage = e => level(e.data)
        src.connect(node); node.connect(ctx.destination)   // a sink the worklet can pull through; it emits nothing
        onAudioThread = true
      } catch { /* no worklet: a timer is coarser but keeps working */ }
      if (!onAudioThread) {
        const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an)
        const buf = new Float32Array(an.fftSize)
        timer = setInterval(() => { an.getFloatTimeDomainData(buf); let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]; level(Math.sqrt(sum / buf.length)) }, 60)
      }
      onState?.('listening')
      segment()
    })
    .catch(e => finish(SAY[e.name] || `The microphone could not be opened: ${e.message}`))

  return () => { if (!stopped) { stopped = true; cleanup(); onEnd?.(null) } }
}

// A phrase, punctuated the way a person would expect after the last thing on the line.
export function joinPhrase(before, phrase) {
  const tail = String(before || '').slice(-2)
  const needsSpace = tail && !/\s$/.test(tail)
  const capitalise = !tail.trim() || /[.!?]\s*$/.test(tail)
  const body = capitalise ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase
  return (needsSpace ? ' ' : '') + body
}
