// Handwriting recognition: the engine module, no Express (SPEC §20.9). Runner resolution (the built Swift
// helper → build it once → PyObjC through uv → unavailable), one helper process per call, a per-page lock, and
// recognizePage, which recognises the stale ink elements of a page and writes { text, textAt, inkHash, lines }
// onto them through store.writeLayout without ever rewriting a stroke. Imported by server/routes/hwr.js and by
// scripts/hwr.mjs (which sets SLATE_ROOT before importing, since server/fs.js reads it at import time).
import { spawn, execFile } from 'node:child_process'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './fs.js'
import { ROOT, HttpError } from './fs.js'
import { isoNow } from './format.js'
import { inkHashOf } from '../src/inkhash.js'
import { hasDevTools } from './devtools.js'
import { enabled } from './edition.js'

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = path.join(REPO, 'desktop', 'hwr', 'bin', 'hwr')
export const SRC = path.join(REPO, 'desktop', 'hwr', 'hwr.swift')
export const PY = path.join(REPO, 'desktop', 'hwr', 'hwr.py')
// The Python path: uv resolves the interpreter and fetches the three PyObjC wheels into ~/.cache/uv once (~3 s,
// needs the network the first time), then starts in well under a second.
export const UV_ARGS = ['run', '--python', '3.12', '--with', 'pyobjc-framework-Vision', '--with', 'pyobjc-framework-Quartz', PY]
export const NOTE = 'Handwriting recognition needs Apple\'s Vision framework: run `xcode-select --install` then `npm run build:hwr`, or install uv (`curl -LsSf https://astral.sh/uv/install.sh | sh`) for the Python path.'
const LANGS = () => process.env.SLATE_HWR_LANGS || 'en-US,fr-FR'
const RETRY_MS = 60_000            // an unavailable verdict is kept this long before a call probes again
const BUILD_RETRY_MS = 10 * 60_000 // a failed lazy build is not retried sooner than this (a probe=1 forces it)
const HELPER_MS = 60_000           // one helper call, plus a little per element

// The child environment. server/index.js exports the one every route's children use (SLATE_ROOT, the ~/.local/bin
// PATH prefix so uv and swiftc resolve, ELECTRON_RUN_AS_NODE=1 so process.execPath is Node inside Slate.app) and
// routes/hwr.js hands it over through configure(); scripts/hwr.mjs never goes through index.js, so the same shape
// is built here as the default.
const cfg = { env: null, repo: REPO }
const defaultEnv = () => ({ ...process.env, SLATE_ROOT: ROOT, ELECTRON_RUN_AS_NODE: '1', PATH: [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || ''].join(path.delimiter) })
const childEnv = () => cfg.env || defaultEnv()
export function configure({ env, repo } = {}) { if (env) cfg.env = env; if (repo) cfg.repo = repo }

export class HwrUnavailable extends HttpError {
  constructor(note) { super(503, 'Handwriting recognition is not available on this machine', { note: note || NOTE }) }
}

// ---- runner state (in memory, disposable) -----------------------------------------------------------------
const freshState = () => ({ runner: null, cmd: null, args: [], engine: null, note: null, building: false, probedAt: null })
let state = freshState(), resolving = null, buildTriedAt = 0
export const status = () => ({ available: state.probedAt ? !!state.runner : null, runner: state.runner, engine: state.engine, note: state.note, building: state.building })
export function resetRunner() { state = freshState(); resolving = null; buildTriedAt = 0 }
const swiftFresh = () => { try { return fsSync.statSync(BIN).mtimeMs >= fsSync.statSync(SRC).mtimeMs } catch { return false } }

// Spawn a helper, feed stdin, collect stdout/stderr, enforce a timeout. Resolves the JSON of the last stdout line
// when it says ok; rejects with HttpError(500, <error | last stderr line>) on a crash, a bad exit or a timeout.
function run(cmd, args, stdin, ms = HELPER_MS) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(cmd, args, { cwd: cfg.repo, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) } catch (e) { return reject(e) }
    let out = '', err = '', done = false
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { } finish(reject, new HttpError(500, 'helper timed out')) }, ms)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => finish(reject, e))
    child.on('close', code => {
      let j = null
      try { j = JSON.parse(out.trim().split('\n').pop() || '') } catch { }
      if (j && j.ok) return finish(resolve, j)
      finish(reject, new HttpError(500, (j && j.error) || err.trim().split('\n').pop() || `helper exited ${code}`))
    })
    child.stdin.on('error', () => { })
    child.stdin.end(stdin ?? '')
  })
}
// `<cmd> <args> --probe` → the engine object, or null when the runner cannot answer.
const probe = (cmd, args, ms = 120_000) => run(cmd, [...args, '--probe'], '', ms).then(j => j.engine || null).catch(() => null)

// Which runner answers on this machine: the built binary, else build it once, else PyObjC through uv, else none.
// Memoised; an unavailable verdict is re-probed after RETRY_MS (or at once with { force }), so a fix the student makes
// (a build, a uv install) is picked up without a restart. SLATE_HWR_RUNNER=swift|pyobjc|none pins the choice (tests).
export function ensureRunner({ force = false } = {}) {
  if (resolving) return resolving
  if (!force && state.probedAt && (state.runner || Date.now() - state.probedAt < RETRY_MS)) return Promise.resolve(state)
  resolving = (async () => {
    const want = process.env.SLATE_HWR_RUNNER || ''
    const next = freshState()
    if (!enabled('hwr')) { next.note = 'Handwriting recognition is off in this edition.'; next.probedAt = Date.now(); state = next; return state }
    if (want !== 'pyobjc' && want !== 'none') {
      // The Swift helper is compiled with the developer tools; without them `xcrun` is an install dialog
      // (server/devtools.js), so the build is never attempted and the uv path below answers instead.
      if (!swiftFresh() && hasDevTools() && (force || Date.now() - buildTriedAt > BUILD_RETRY_MS)) {
        buildTriedAt = Date.now(); state.building = true
        await new Promise(res => execFile(process.execPath, [path.join(cfg.repo, 'scripts', 'build-hwr.mjs'), '--quiet'], { cwd: cfg.repo, env: childEnv(), timeout: 240_000, windowsHide: true }, (e, so, se) => {
          if (e) console.log('[hwr] helper not built: ' + String(se || e.message).trim().split('\n').slice(-1)[0])
          res()
        }))
        state.building = false
      }
      if (swiftFresh()) { const e = await probe(BIN, []); if (e) Object.assign(next, { runner: 'swift', cmd: BIN, args: [], engine: e }) }
    }
    if (!next.runner && want !== 'swift' && want !== 'none') {
      const e = await probe('uv', UV_ARGS)
      if (e) Object.assign(next, { runner: 'pyobjc', cmd: 'uv', args: UV_ARGS, engine: e })
    }
    if (!next.runner) next.note = NOTE
    next.probedAt = Date.now()
    state = next
    return state
  })().finally(() => { resolving = null })
  return resolving
}

// items: [{ id, strokes: [{ tool, width, points }] }] → the helper's reply { ok, engine, items }.
export async function recognizeItems(items) {
  const s = await ensureRunner()
  if (!s.runner) throw new HwrUnavailable(s.note)
  return run(s.cmd, [...s.args, '--lang', LANGS()], JSON.stringify({ items }), HELPER_MS + 5_000 * items.length)
}

// ---- the per-page lock ----------------------------------------------------------------------------------------
const locks = new Map()
function withPageLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => { }).then(() => { if (locks.get(key) === tail) locks.delete(key) })
  locks.set(key, tail)
  return next
}

const penStrokes = el => (el.strokes || []).filter(s => s && s.tool !== 'highlighter' && Array.isArray(s.points) && s.points.length)

// The core. Reads the page, recognises the wanted ink elements outside the lock (seconds), then re-reads under the
// lock and writes only the elements whose stroke ids are still what was recognised; an element that changed
// meanwhile is reported `skipped: 'changed'`, one whose inkHash already matches `skipped: 'unchanged'` (unless
// force). An element that is only marks (no pen strokes, or no words found) is still stamped with text "" so a
// batch run never revisits it. `lines[].box` from the helper is not kept (Convert uses the live stroke bbox).
export async function recognizePage(relMd, { elementId, elementIds, force = false } = {}) {
  const page = await store.readPage(relMd)
  if (!page.exists && page.layoutHash === null) throw new HttpError(404, 'no such page')
  const wanted = Array.isArray(elementIds) ? elementIds : elementId ? [elementId] : null
  let els = page.layout.elements.filter(e => e.type === 'ink')
  if (wanted) {
    els = wanted.map(id => {
      const e = page.layout.elements.find(x => x.id === id)
      if (!e) throw new HttpError(404, `no such element: ${id}`)
      if (e.type !== 'ink') throw new HttpError(400, 'not an ink element')
      return e
    })
  }
  const skipped = [], items = [], hashes = new Map()
  for (const el of els) {
    if (hashes.has(el.id)) continue
    const h = inkHashOf(el); hashes.set(el.id, h)
    if (el.inkHash === h && !force) { skipped.push({ id: el.id, skipped: 'unchanged' }); continue }
    const pen = penStrokes(el)
    items.push(pen.length ? { id: el.id, strokes: pen.map(s => ({ tool: s.tool, width: s.width, points: s.points })) } : { id: el.id, empty: true })
  }
  const s = await ensureRunner()
  if (!s.runner) throw new HwrUnavailable(s.note)
  const toRun = items.filter(i => !i.empty)
  const recognised = toRun.length ? (await recognizeItems(toRun)).items || [] : []
  for (const i of items) if (i.empty) recognised.push({ id: i.id, text: '', lines: [], ms: 0 })
  const byId = new Map(recognised.filter(r => r && hashes.has(r.id)).map(r => [r.id, r]))
  let written = [], layoutHash = page.layoutHash
  if (byId.size) {
    layoutHash = await withPageLock(relMd, async () => {
      for (let attempt = 0; ; attempt++) {
        const fresh = await store.readPage(relMd), at = isoNow(), out = [], pending = new Map(byId)
        const elements = fresh.layout.elements.map(e => {
          const r = pending.get(e.id); if (!r || e.type !== 'ink') return e
          pending.delete(e.id)
          if (inkHashOf(e) !== hashes.get(e.id)) { out.push({ id: e.id, skipped: 'changed' }); return e }
          const lines = (r.lines || []).map(l => ({ text: String(l.text ?? ''), confidence: Math.round(Number(l.confidence ?? 0) * 100) / 100 }))
          const text = lines.map(l => l.text).join('\n')
          out.push({ id: e.id, text, textAt: at, inkHash: hashes.get(e.id), lines, ms: r.ms ?? 0 })
          return { ...e, text, textAt: at, inkHash: hashes.get(e.id), lines }
        })
        for (const id of pending.keys()) out.push({ id, skipped: 'changed' })   // erased meanwhile
        written = out
        if (!out.some(x => !x.skipped)) return fresh.layoutHash
        try { return (await store.writeLayout(relMd, { ...fresh.layout, elements }, fresh.layoutHash)).layoutHash }
        catch (e) { if (e.status !== 409 || attempt >= 2) throw e }   // the app saved in between: read again
      }
    })
  }
  return { ok: true, page: relMd, layoutHash, engine: state.engine, results: [...skipped, ...written] }
}
