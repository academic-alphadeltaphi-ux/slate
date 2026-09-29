// Live dictation, locally (SPEC §20.29).
//
// The first attempt used the browser's `webkitSpeechRecognition`, which is Google's recogniser over the network —
// and Chromium builds that are not Chrome (Electron, this app's own shell) ship without the API key for it, so it
// fails with `network` however good the connection is. slate already turns lectures into words with parakeet-mlx on
// the M-series GPU; dictation is the same engine, fed one phrase at a time.
//
//   POST /api/dictate        the raw audio of one phrase (webm/opus or mp4/aac) → { text }
//   GET  /api/dictate/status → { available, ready, warming, error }
//
// The CLI loads the model on every call (~3 s), which is fine for an hour of lecture and useless for a phrase, so a
// worker (scripts/dictate-worker.py) holds it in memory and answers on stdin/stdout. It starts on the first clip,
// stops after ten idle minutes, and takes one clip at a time — the GPU is not shared with the lecture transcriber.
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { uvFfmpegDir, ensureUvFfmpeg } from '../../scripts/lib/mymedia.mjs'
import { findUv, WIN } from '../../scripts/lib/platform.mjs'
import { enabled } from '../edition.js'

const IDLE_MS = 10 * 60 * 1000
const MAX_BYTES = 8e6            // ~2 minutes of opus; a phrase is a few tens of kB
let FFDIR = uvFfmpegDir()   // null until static-ffmpeg's binaries are on disk (see register): then PATH's own ffmpeg, if any
const UV = findUv()

export function register(app, ctx) {
  const { wrap, HttpError, repo, env } = ctx
  const script = path.join(repo, 'scripts', 'dictate-worker.py')
  const w = { child: null, ready: false, warming: false, error: null, queue: [], pending: null, idle: null, buf: '' }

  const stop = () => { clearTimeout(w.idle); try { w.child?.kill() } catch { } w.child = null; w.ready = false; w.warming = false }
  const touch = () => { clearTimeout(w.idle); w.idle = setTimeout(stop, IDLE_MS) }
  const settle = (fn) => { const p = w.pending; w.pending = null; if (p) fn(p); pump() }

  const line = raw => {
    let m = null
    try { m = JSON.parse(raw) } catch { return }
    if (m.ready) { w.ready = true; w.warming = false; w.error = null; return pump() }
    if (m.fatal) { w.error = m.error; stop(); return settle(p => p.reject(new HttpError(503, m.error))) }
    if (m.ok) return settle(p => p.resolve(String(m.text || '')))
    settle(p => p.reject(new HttpError(500, m.error || 'the recogniser could not read that clip')))
  }

  const start = () => {
    if (w.child || !UV) return
    w.warming = true; w.error = null; w.buf = ''
    const e = { ...env, PATH: [FFDIR, env.PATH || ''].filter(Boolean).join(path.delimiter) }
    const child = spawn(UV, ['run', '--quiet', '--with', 'parakeet-mlx', '--python', '3.12', 'python', script], { cwd: repo, env: e, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    w.child = child
    child.stdin.on('error', () => { })   // an EPIPE on a worker that just died is not an uncaught exception
    child.stdout.on('data', d => { w.buf += d; const ls = w.buf.split('\n'); w.buf = ls.pop(); for (const l of ls) if (l.trim()) line(l) })
    child.stderr.on('data', d => { const s = String(d); if (/error|Traceback/i.test(s)) console.error('[dictate]', s.trim().split('\n').slice(-2).join(' ')) })
    child.on('error', err => { w.error = `the recogniser could not start: ${err.message}`; stop(); settle(p => p.reject(new HttpError(503, w.error))) })
    child.on('close', () => { const was = w.child; w.child = null; w.ready = false; w.warming = false; if (was) settle(p => p.reject(new HttpError(503, w.error || 'the recogniser stopped'))) })
  }

  const pump = () => {
    if (w.pending || !w.queue.length) return
    if (!w.child) start()
    if (!w.ready) return                       // the queue drains as soon as `ready` arrives
    w.pending = w.queue.shift()
    touch()
    try { w.child.stdin.write(w.pending.file + '\n') } catch (e) { settle(p => p.reject(new HttpError(503, e.message))) }
  }

  // Off where speech is (the Windows kit, a PC, an Intel Mac — SPEC §21.9): the mic never shows, and a window that asks
  // anyway hears why rather than being told to install a Mac tool.
  const SPEECH = enabled('speech') && !WIN && (process.arch === 'arm64' || process.env.SLATE_SPEECH === '1')
  const NOTE = !SPEECH ? (!enabled('speech') || WIN ? 'Dictation is Mac-only and is not part of this copy.' : 'Dictation needs a Mac with an Apple chip.') : null
  // static-ffmpeg downloads its binaries on first use and setup did not always use it (scripts/lib/mymedia.mjs): where
  // speech is on and they never came, fetch them now, in the background, rather than on the first phrase.
  if (SPEECH && UV && !FFDIR) ensureUvFfmpeg().then(d => { FFDIR = d }, () => { })
  app.get('/api/dictate/status', (req, res) => res.json({ available: SPEECH && !!UV && fss.existsSync(script), ready: w.ready, warming: w.warming, error: w.error, note: NOTE }))

  app.post('/api/dictate', wrap(async (req, res) => {
    if (!SPEECH) throw new HttpError(409, NOTE)   // as /api/transcribe: a window that posts anyway hears why
    if (!UV) throw new HttpError(503, 'uv is not installed — dictation runs parakeet-mlx through it')
    const chunks = []
    let n = 0
    for await (const c of req) { n += c.length; if (n > MAX_BYTES) throw new HttpError(413, 'that clip is too long'); chunks.push(c) }
    if (!n) throw new HttpError(400, 'no audio')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-dictate-'))
    const file = path.join(dir, 'clip.' + (String(req.headers['content-type'] || '').includes('mp4') ? 'mp4' : 'webm'))
    await fs.writeFile(file, Buffer.concat(chunks))
    try {
      const text = await new Promise((resolve, reject) => {
        w.queue.push({ file, resolve, reject })
        setTimeout(() => reject(new HttpError(504, 'the recogniser did not answer in time')), 60000)
        pump()
      })
      res.json({ text })
    } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => { }) }
  }))

  process.on('exit', stop)
}
