// Ask the page — the client side that is not UI (SPEC.md §20.7): the per-session store (open flag, one thread per
// page, mirrored into sessionStorage so a reload keeps the threads and nothing else), the streaming fetch, the presets
// registry, `openAsk()` — the one entry point other features use — and the note formatter.
import { useSyncExternalStore } from 'react'
import { identityText } from './problems.js'

// A preset is a fixed question in scripts/ask-presets/<name>.md (the server fills {{block}}, {{problem}}, {{page}}).
// `title` is the bold first line of the saved note; `auto` saves the answer on the page as soon as it finishes.
export const PRESETS = { solution: { label: 'Write the solution under my attempt', title: 'Solution', auto: true } }
export const SUGGESTIONS = ['Explain this page', 'Why would this be on the test?', 'Quiz me on this page']
const KEY = 'slate.ask.threads', MAX_PAGES = 24, MAX_BYTES = 1.5e6

const state = { open: false, threads: new Map(), version: 0 }
const subs = new Set()
let persistTimer = null
const persist = () => {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      const pages = [...state.threads.entries()].filter(([, t]) => t.turns.length || t.draft).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_PAGES)
      let json = JSON.stringify(Object.fromEntries(pages.map(([p, t]) => [p, { turns: t.turns, draft: t.draft, week: t.week, at: t.at }])))
      while (json.length > MAX_BYTES && pages.length > 1) { pages.pop(); json = JSON.stringify(Object.fromEntries(pages.map(([p, t]) => [p, { turns: t.turns, draft: t.draft, week: t.week, at: t.at }]))) }
      sessionStorage.setItem(KEY, json)
    } catch { }
  }, 250)
}
try {
  const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null')
  if (saved && typeof saved === 'object') for (const [p, t] of Object.entries(saved)) {
    const turns = (Array.isArray(t.turns) ? t.turns : []).map(x => (x.status === 'streaming' ? { ...x, status: x.a ? 'stopped' : 'error', error: x.a ? null : { code: 'exit', message: 'The page was reloaded before an answer arrived.' } } : x))
    state.threads.set(p, { turns, draft: typeof t.draft === 'string' ? t.draft : '', week: t.week === 'full' ? 'full' : 'brief', context: null, at: t.at || 0 })
  }
} catch { }
const emit = () => { state.version++; subs.forEach(f => f()); persist() }
const subscribe = f => { subs.add(f); return () => subs.delete(f) }
// Re-renders the caller on every store change; returns the store (read `open`, `threads`).
export const useAsk = () => { useSyncExternalStore(subscribe, () => state.version, () => state.version); return state }
export const thread = page => { if (!state.threads.has(page)) state.threads.set(page, { turns: [], draft: '', week: 'brief', context: null, at: 0 }); return state.threads.get(page) }
export const toggleAsk = open => { state.open = typeof open === 'boolean' ? open : !state.open; emit() }
export const patch = (page, fn) => { const t = thread(page); fn(t); t.at = Date.now(); emit() }

// The entry point other features use — the Problems page's "Write the solution…" calls
// openAsk({ page, preset: 'solution', block, problem: { key, label, source, heading } }); a plain question is
// openAsk({ page, question }). The rail opens; the panel for that page sends the pending request when it mounts or
// when the page is already in front (30 s grace, then it is dropped rather than fired on a page the student left).
let pending = null
export function openAsk({ page, preset, block, problem, question, quote, image } = {}) {
  state.open = true
  // A passage selected on the page (SPEC §20.28): the rail opens with it as the subject, so the next question is
  // about those words rather than about the whole page. Nothing is sent until the student says what he wants to know.
  if (page && quote) { const t = thread(page); t.quote = quote; t.image = null; t.at = Date.now() }
  // A region clipped off the page: the picture is the subject, and the page's whole context still goes with it.
  if (page && image) { const t = thread(page); t.image = image; t.quote = null; t.at = Date.now() }
  if (page && (preset || question)) pending = { page, preset: preset || null, block: block || null, problem: problem || null, question: question || null, at: Date.now() }
  emit()
}
export const clearQuote = page => { const t = state.threads.get(page); if (t?.quote || t?.image) { t.quote = null; t.image = null; emit() } }
export function takePending(page) {
  if (!pending) return null
  if (Date.now() - pending.at > 30000) { pending = null; return null }
  if (pending.page !== page) return null
  const p = pending; pending = null; return p
}

// POST /api/ask as NDJSON: every parsed line goes to onEvent; resolves when the stream ends. Throws { status, data }
// on a plain-JSON refusal (400/404/409) before anything streams.
export async function askStream(body, onEvent, signal) {
  const r = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!r.ok || !(r.headers.get('content-type') || '').includes('ndjson')) { const data = await r.json().catch(() => ({})); const e = new Error(data.error || r.statusText); e.status = r.status; e.data = data; throw e }
  const rd = r.body.getReader(), td = new TextDecoder(); let buf = ''
  const feed = l => { if (!l.trim()) return; try { onEvent(JSON.parse(l)) } catch { } }
  for (;;) { const { value, done } = await rd.read(); if (done) break; buf += td.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(feed) }
  feed(buf)
}
export const contextFor = (page, { week } = {}) => fetch(`/api/ask/context?page=${encodeURIComponent(page)}${week === 'full' ? '&week=full' : ''}`).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json() })

// ---- what the rail says about a turn ------------------------------------------------------------------------------------
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const when = d => `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`   // Wed 9 Sep 2026, 14:02
export const chipLabel = i => (
  i.kind === 'page' ? `this page${i.handwriting ? ` · ${i.handwriting} handwritten line${i.handwriting === 1 ? '' : 's'}` : ''}` : i.kind === 'course' ? `${i.name} plan` : i.kind === 'week' ? i.name : i.kind === 'problems' ? 'Problems'
    : i.kind === 'transcript' ? `recording${i.minutes ? ` ${i.minutes} min` : ''}${i.tier > 1 ? ` · ${i.name}` : ''}` : i.kind === 'sheet' ? `sheet ${i.name}` : i.kind === 'pdf' ? `${i.name}${i.pages ? ` ${i.pages} p` : ''}` : i.name)
export function sourcesPhrase(items = []) {
  const names = []
  for (const i of items) {
    if (i.dropped) continue
    if (i.kind === 'page') names.push('this page'); else if (i.kind === 'pdf') names.push(i.name); else if (i.kind === 'transcript') names.push('the recording')
    else if (i.kind === 'sheet') names.push('the study sheet'); else if (i.kind === 'course') names.push('the course plan'); else if (i.kind === 'week') names.push('the week page'); else if (i.kind === 'problems') names.push('the problems')
  }
  const u = [...new Set(names)]
  if (!u.length) return 'nothing'
  return u.length <= 4 ? u.join(', ').replace(/, ([^,]*)$/, ' and $1') : u.slice(0, 3).join(', ') + ' and more'
}
// ≈ words the model read: tokens × 0.75 when the CLI reported usage, else the context's characters ÷ 6.
export const wordsRead = turn => { const u = turn.usage; const n = u ? Math.round(((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)) * 0.75) : Math.round((turn.chars || 0) / 6); return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n) }
export const footLine = turn => `Claude${turn.ms ? ` · ${Math.max(1, Math.round(turn.ms / 1000))} s` : ''}${turn.usage || turn.chars ? ` · ≈ ${wordsRead(turn)} words read` : ''}${turn.sources?.length ? ` · from ${sourcesPhrase(turn.sources)}` : ''}`

// What lands on the page: one block, Obsidian renders it, untouched it stays byte-for-byte what Claude wrote. A
// solution's first line is `### Solution · <label>` — what src/problems.js counts as solved (SPEC §20.2).
export const solutionHeading = problem => (problem?.heading && /^### Solution · /.test(problem.heading) ? problem.heading : problem?.label ? `### Solution · ${identityText(problem.label)}` : '**Solution**')
export function noteMarkdown(turn) {
  const head = turn.preset === 'solution' ? solutionHeading(turn.problem) : turn.preset ? `**${PRESETS[turn.preset]?.title || 'Answer'}**` : `**Q · ${turn.q.replace(/\s+/g, ' ').trim()}**`
  return `${head}\n\n${turn.a.trim()}\n\n_Claude · ${when(new Date(turn.at))} · from ${sourcesPhrase(turn.sources)}_`
}
