#!/usr/bin/env node
// The daily Quercus sync, files only: new announcements into each course's Announcements page,
// new files into the week they belong to (one page each, PDFs as printouts), deadlines, tests and
// grades into the Hub (Notebooks/Hub/Today/*.md for reading, Hub/_hub.json for the Home screen).
// Reads the Canvas token from the Claude desktop config, like the quercus skill's sweep script.
//   node scripts/quercus-sync.mjs [--dry-run] [--json] [--root /path]
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { WIN, safeName as platformSafeName } from './lib/platform.mjs'
import os from 'node:os'
import { COURSES, TERMS, weeks, weekFor, short, todayIso, localStamp } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { SHEETS_DIR, isScratchDir } from './lib/sessions.mjs'
import { scoresFromAssignments } from '../src/grade.js'
import { readMarks, applyMarks } from './lib/marks.mjs'
import { newId } from '../server/format.js'
import { webassignDeadlines, webassignScores } from './lib/problems.mjs'
import { guardFlags } from './lib/argv.mjs'
import { requireQuercusAuth } from './lib/quercus-auth.mjs'
import { fetchSafe, NET_DOWN } from './lib/net.mjs'
import { acquireLock } from './lib/brain.mjs'
import { bucketFor, FOLDER, headingFor, pageWeek, fileWeek } from './lib/filing.mjs'
import { whereOf } from './lib/move.mjs'
import { VIDEO_RE } from '../src/plan.js'
import { isMyMedia, mymediaId, mymediaIn, download as fetchMyMedia, humanDuration } from './lib/mymedia.mjs'
import { createHash } from 'node:crypto'

guardFlags(['--dry-run', '--json', '--root'])

const args = process.argv.slice(2), DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json')
const ROOT = notesRoot(process.argv)
const HUB = path.join(ROOT, 'Hub'), TODAY = path.join(HUB, 'Today'), STATE = path.join(HUB, '_sync-state.json')
const log = (...a) => { if (!JSON_OUT) console.log(...a) }
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
// Atomic, like the app's own writes (SPEC §8): a fetch killed mid-write left a truncated `_sync-state.json`, which reads as
// "nothing seen yet" and refetches everything (review 2026-09-18). `.tmp-` so neither the watcher nor the snapshots see it.
const write = async (p, s) => { if (DRY) return; await fs.mkdir(path.dirname(p), { recursive: true }); const tmp = path.join(path.dirname(p), `.tmp-${path.basename(p)}-${process.pid}`); await fs.writeFile(tmp, s); await fs.rename(tmp, p) }
const writeJson = (p, v) => write(p, JSON.stringify(v, null, 2) + '\n')
const stamp = () => localStamp()
// Windows refuses * ? " < > | in a name and a name that ends in a dot or a space, and its paths are shorter (260
// characters unless the PC was told otherwise), so a title is kept to 80 there.
const safeName = s => platformSafeName(s)   // scripts/lib/platform.mjs: the one cleaner, so audit.mjs finds what this wrote
// Claude as the brain (SPEC §20.37, `brain: true` in Hub/_settings.json): this script only fetches. A new file, a new Quercus
// page and a file from the Desktop course folder wait as pages in Hub/Inbox/<course>/; a new announcement is written where
// announcements live, links no week, and waits in Hub/_inbox.json with every Quercus page that changed. No rule here picks a
// week, a folder or a kind — Claude does, through scripts/brain.mjs.
const BRAIN = !!(await readJson(path.join(HUB, '_settings.json'), {}))?.brain
const INBOX = path.join(HUB, '_inbox.json')

// ---- Canvas ------------------------------------------------------------------------------------
const { token: TOKEN, api: API } = requireQuercusAuth()   // env, then the keychain, then the Claude desktop config (SPEC §21)
const errors = []
// Canvas answers 401 for two different things: a key that is dead ("Invalid access token"), and a page the student may not
// see — an instructor who hid the Files tab, a module not yet published. Only the first ends the morning; the second is a
// line in the errors. A 401 whose body does not name the token is checked once against /users/self, which every key can read.
const TOKEN_ERROR = '401 Expired access token: make a new one at q.utoronto.ca → Account → Settings → + New Access Token (expiry blank), then store it with `node scripts/setup.mjs token <key>` (or in the Claude desktop config for the full edition)'
let tokenOk = null
async function tokenRefused(r) {
  let body = ''; try { body = await r.text() } catch { }
  if (/access token/i.test(body)) return true
  if (tokenOk === null) { try { const s = await fetchSafe(API + '/users/self', { headers: { Authorization: 'Bearer ' + TOKEN } }); tokenOk = s.ok } catch { tokenOk = true } }
  return !tokenOk
}
// Past the probe, two requests in a row that fail for the network itself (lib/net.mjs NET_DOWN) end the sync, with what it
// has written kept: a network that went away mid-sync cost up to 205 s a request, and the routine's timeout killed the sync
// somewhere in a course instead (review 2026-09-29).
let probed = false, netFails = 0
async function netDown(e) {
  if (!probed || !NET_DOWN.test(String(e?.message || '')) || ++netFails < 2) return
  await checkpoint().catch(() => { })
  console.error('Quercus could not be reached (the network went away during the sync): ' + e.message)
  process.exit(3)
}
// `quiet`: a 401 that is no news — a tab most courses hide, a link to a course the student is not in — is not a line in the
// errors every morning. A dead key still ends the sync, and a 5xx is still reported.
async function get(p, raw = false, quiet = false) {
  const url = p.startsWith('http') ? p : API + p
  try {
    const r = await fetchSafe(url, { headers: { Authorization: 'Bearer ' + TOKEN } })
    netFails = 0
    if (r.status === 401) { if (await tokenRefused(r)) throw new Error(TOKEN_ERROR); if (!quiet) errors.push(`${p}: not authorized (the instructor hid it)`); return null }
    // A 5xx or a 429 is Canvas failing, not "nothing there": unrecorded, an outage read as a quiet day and emptied the
    // deadlines for the day (review 2026-09-18). A 403/404 is a hidden tab or a page that is not there, as before.
    if (!r.ok) { if (r.status >= 500 || r.status === 429) errors.push(`${p}: HTTP ${r.status}`); return null }
    return raw ? Buffer.from(await r.arrayBuffer()) : await r.json()
  } catch (e) { if (/401/.test(e.message)) throw e; await netDown(e); errors.push(`${p}: ${e.message}`); return null }
}
// Every page of a list endpoint, following Canvas's `Link: <…>; rel="next"` header (announcements were one page of 50,
// modules and assignments one of 100, and the rest fell off in silence). → array | null when the first page failed.
async function getAll(p, quiet = false) {
  const out = []
  let url = p.startsWith('http') ? p : API + p
  for (let i = 0; url && i < 60; i++) {
    let r
    try { r = await fetchSafe(url, { headers: { Authorization: 'Bearer ' + TOKEN } }); netFails = 0 } catch (e) { await netDown(e); errors.push(`${p}: ${e.message}`); return out.length ? out : null }
    if (r.status === 401) { if (await tokenRefused(r)) throw new Error(TOKEN_ERROR); if (!quiet) errors.push(`${p}: not authorized (the instructor hid it)`); return out.length ? out : null }
    if (!r.ok) { if (r.status >= 500 || r.status === 429) errors.push(`${p}: HTTP ${r.status}`); return out.length ? out : null }
    const j = await r.json()
    if (!Array.isArray(j)) return out.length ? out : null
    out.push(...j)
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')
    url = m ? m[1] : null
  }
  return out
}
const hashOf = s => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
// Minimal HTML → markdown for announcement and page bodies.
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
function htmlToMd(html) {
  let s = html || ''
  s = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
  // an embedded player (MyMedia, YouTube, a Canvas upload) or form is a link on the page: stripped with the other tags, the
  // week's video left no trace in the notebook at all
  s = s.replace(/<iframe\b([^>]*)>[\s\S]*?<\/iframe>/gi, (m, at) => { const src = /\bsrc="([^"]+)"/i.exec(at)?.[1]; return src ? `\n[${/\btitle="([^"]+)"/i.exec(at)?.[1] || 'Embedded'}](${src.replace(/^\//, SITE + '/')})\n` : '' })
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/div>|<\/h[1-6]>|<\/li>|<\/tr>/gi, '\n')
  s = s.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(Math.min(6, Number(n) + 1)) + ' ')
  s = s.replace(/<li[^>]*>/gi, '- ').replace(/<(strong|b)>/gi, '**').replace(/<\/(strong|b)>/gi, '**').replace(/<(em|i)>/gi, '*').replace(/<\/(em|i)>/gi, '*')
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => `[${text.replace(/<[^>]+>/g, '').trim() || href}](${href})`)
  s = s.replace(/<[^>]+>/g, '')
  return decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
const fmtDate = iso => iso ? new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
const localIso = iso => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) : null
// What Quercus calls a test: "Test 1", "Term Test 2", "Midterm", "Final Exam", "Examination" — a word of its own. A bare
// /test|exam|midterm/ took "Academic Integrity Attestation", "Latest …" and "Pretest" for tests, and calendar.mjs then
// dropped the real class that day for them (review 2026-09-29).
const TEST_RE = /(?<!pre-?)\b(?:test|exam(?:ination)?|midterm)(?:s|\d+)?\b/i

// ---- announcements: subpages, index, week links ------------------------------------------------
const annTitle = (postedAt, title) => `${localIso(postedAt)} ${safeName(title.trim())}`.slice(0, 100).trim()
const MONTHS_RE = /\b(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi
const MONTH_N = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
// The term weeks an announcement talks about, from the dates it mentions ("Tuesday, September 15").
function weeksMentioned(term, text) {
  const out = new Map()
  for (const m of text.matchAll(MONTHS_RE)) {
    const mo = MONTH_N[m[1].toLowerCase()], d = Number(m[2]); if (!mo || d < 1 || d > 31) continue
    const iso = `${mo >= 8 ? TERMS.FALL.start.slice(0, 4) : TERMS.WINTER.start.slice(0, 4)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const w = weekFor(term, iso); if (w) out.set(w.n, w)
  }
  return [...out.values()].sort((a, b) => a.n - b.n)
}
// A line on the week's page pointing at the announcement, once.
async function linkWeek(nb, w, title) {
  const pagePath = path.join(nb, w.term, `${w.label}.md`)
  let md = (await exists(pagePath)) ? await fs.readFile(pagePath, 'utf8') : `---\ncreated: "${localStamp()}"\nkind: "notes"\n---\n# Week ${w.n} · ${w.span}\n`
  const line = `- [[${title}]]`
  if (md.includes(line)) return
  md = /^## From announcements/m.test(md) ? md.replace(/(^## From announcements\n)/m, `$1${line}\n`) : md.trimEnd() + `\n\n## From announcements\n${line}\n`
  await write(pagePath, md)
}
async function writeAnnouncementIndex(course, nb) {
  const subDir = path.join(nb, 'Announcements', 'Announcements')
  const titles = ((await exists(subDir)) ? (await fs.readdir(subDir)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) : []).sort().reverse()
  await writeJson(path.join(subDir, '_slate.json'), { order: titles })
  await writeJson(path.join(nb, 'Announcements', '_slate.json'), { order: ['Announcements'], label: 'One subpage per announcement, newest first. Synced every morning.' })
  await write(path.join(nb, 'Announcements', 'Announcements.md'), `---\nkind: "admin"\n---\n# ${course} — Announcements\n\n_Synced ${today}. One page per announcement, newest first; open them below or in the page list._\n\n${titles.length ? titles.map(t => `- [[${t}]]`).join('\n') : '- Nothing posted yet.'}\n`)
}
// One-time: the old single Announcements page (## blocks) becomes one subpage per announcement.
async function migrateAnnouncements(course, nb, info) {
  const annDir = path.join(nb, 'Announcements'), indexPath = path.join(annDir, 'Announcements.md'), subDir = path.join(annDir, 'Announcements')
  if (!(await exists(indexPath)) || (await exists(subDir))) return
  const md = await fs.readFile(indexPath, 'utf8')
  const parts = md.split(/^## /m).slice(1); if (!parts.length) return
  const sidecar = await readJson(path.join(annDir, 'Announcements.blocks.json'), { version: 1, elements: [] })
  const assets = (await exists(path.join(annDir, 'Announcements.assets'))) ? await fs.readdir(path.join(annDir, 'Announcements.assets')) : []
  for (const part of parts) {
    const [titleLine, ...rest] = part.split('\n')
    const meta = /^_(\d{4}-\d{2}-\d{2}) · (.*)_$/.exec((rest[0] || '').trim())
    const date = meta?.[1] || today, author = meta?.[2] || ''
    const body = rest.slice(meta ? 1 : 0).join('\n').replace(/\n---\s*$/, '').trim()
    const title = annTitle(date + 'T12:00:00', titleLine), wks = weeksMentioned(info.term, titleLine + '\n' + body)
    await write(path.join(subDir, title + '.md'), `---\ncreated: "${date}T12:00:00-04:00"\nkind: "admin"\ntags: ["announcement"]\n---\n# ${titleLine.trim()}\n\n_${date} · ${author}_${wks.length ? `\n\nConcerns ${wks.map(w => `[[${w.label}]]`).join(', ')}.` : ''}\n\n${body}\n`)
    for (const w of wks) await linkWeek(nb, w, title)
    for (const name of assets) if (body.includes(name)) {
      log(`  migrate: ${name} → Announcements/${title}`)
      if (DRY) continue
      await fs.mkdir(path.join(subDir, `${title}.assets`), { recursive: true })
      await fs.rename(path.join(annDir, 'Announcements.assets', name), path.join(subDir, `${title}.assets`, name))
      const el = sidecar.elements.find(e => e.src?.endsWith('/' + name)) || { id: newId(), type: 'file', size: null }
      sidecar.elements = sidecar.elements.filter(e => e !== el)
      await writeJson(path.join(subDir, `${title}.blocks.json`), { version: 1, elements: [{ ...el, src: `${title}.assets/${name}`, display: 'card' }] })
    }
  }
  log(`  migrated ${parts.length} announcement(s) into subpages`)
  if (DRY) return
  if (sidecar.elements.length) await writeJson(path.join(annDir, 'Announcements.blocks.json'), sidecar); else await fs.rm(path.join(annDir, 'Announcements.blocks.json'), { force: true })
  await fs.rmdir(path.join(annDir, 'Announcements.assets')).catch(() => { })
}

// ---- one sync at a time ------------------------------------------------------------------------
// The Sync button, the morning run and the team's coordinator each start one, and nothing kept two apart: both downloaded
// the same new file (an orphan "… (2).md", 2026-09-29) and each rewrote the memory the other had just written. The lock
// names its holder; one whose process is gone, or a lock older than two hours whatever its pid is now, no longer counts.
// A second sync waits half a minute for the first, then stops having changed nothing (exit 4, `reason: "busy"`).
const SYNC_LOCK = path.join(HUB, '.tmp-sync.lock')
if (!DRY) {
  const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  const until = Date.now() + (Number(process.env.SLATE_SYNC_WAIT_MS) || 30_000)
  fsSync.mkdirSync(HUB, { recursive: true })
  for (;;) {
    try { const fd = fsSync.openSync(SYNC_LOCK, 'wx'); fsSync.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fsSync.closeSync(fd); break }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      let held = null; try { held = JSON.parse(fsSync.readFileSync(SYNC_LOCK, 'utf8')) } catch { }
      const age = Date.now() - (held?.at ? new Date(held.at).getTime() : fsSync.statSync(SYNC_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? 0)
      // a lock with no holder in it yet is one being written this instant — unless it has stayed that way ten seconds
      if (held?.pid ? !alive(held.pid) || age > 2 * 3600_000 : age > 10_000) { fsSync.rmSync(SYNC_LOCK, { force: true }); continue }
      if (Date.now() >= until) {
        console.error(`Another Quercus sync is running (pid ${held?.pid ?? '?'} since ${held?.at ? localStamp(new Date(held.at)).slice(11, 16) : '?'}); this one stopped without changing anything.`)
        if (JSON_OUT) console.log(JSON.stringify({ ok: false, reason: 'busy', pid: held?.pid ?? null }))
        process.exit(4)
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  process.on('exit', () => { try { if (JSON.parse(fsSync.readFileSync(SYNC_LOCK, 'utf8')).pid === process.pid) fsSync.rmSync(SYNC_LOCK, { force: true }) } catch { } })
}

// ---- state -------------------------------------------------------------------------------------
const state = await readJson(STATE, { announcements: {}, files: {}, grades: {}, sheets: {}, videos: {}, lastRun: null })
// What this run read, record by record. brain.mjs moves a page's record (scripts/lib/move.mjs followSyncState) and
// study-sheets.mjs adds its sheets while this runs; a checkpoint used to write the memory whole from what it read at the
// start, and put a placed page's record back in the inbox (review 2026-09-29). It now writes what this run changed since
// and keeps what the other writer changed (merge3, below).
const clone = v => JSON.parse(JSON.stringify(v ?? null))
let stateBase = clone(state)
// Before anything: can Quercus be reached at all? A Mac without wifi used to fetch nothing, record every request as an
// error, and report a quiet morning (SPEC §21.5). One probe of /users/self — which every key can read — decides.
let ME = null   // who the key is: a forum post is found by its author (SPEC §20.69)
{
  const me = await get('/users/self')
  ME = me?.id ?? null
  const last = errors[errors.length - 1] || ''
  if (!me && NET_DOWN.test(last)) { console.error('Quercus could not be reached (no network?): ' + last); process.exit(3) }
  probed = true
}
state.videos ||= {}   // added 2026-09-18 with MyMedia downloads; absent from older state files
state.sheets ||= {}
state.pages ||= {}
const prevRun = state.lastRun
const prevHub = await readJson(path.join(HUB, '_hub.json'), null)
const hub = { updatedAt: stamp(), courses: [], deadlines: [], tests: [], grades: { current: [], recent: [] }, handedIn: [], news: [], files: [], sheets: [], pages: [], errors }
// The open tasks of the last plan, for the forums they point at: a post is looked for only where a task asks for one.
const prevPlan = await readJson(path.join(HUB, '_plan.json'), null)
const openLinks = courseKey => [...(prevPlan?.meetings || []).filter(m => m.courseKey === courseKey).flatMap(m => m.before || []), ...(prevPlan?.weeks || []).filter(w => w.courseKey === courseKey).flatMap(w => w.work || [])]
  .filter(t => t && !t.done && !t.stale).map(t => t.claude?.link || / → (https?:\/\/\S+)/.exec(String(t.text || ''))?.[1]).filter(Boolean)
const SITE = API.replace(/\/api\/v1\/?$/, '')
const today = todayIso()
// A hand-in stays a deadline after its day until Quercus says it is in (SPEC §20.54): back to the start of the term.
const SINCE = (() => { const starts = Object.values(TERMS).map(t => t.start).sort(); return starts.filter(s => s <= today).pop() || starts[0] })()
const inbox = await readJson(INBOX, { version: 1, items: {} }); inbox.items ||= {}
let inboxBase = clone(inbox.items)
// `again`: the page was written into the inbox anew because the place its record named is gone. Its item, decided long ago
// (placed or ignored, kept thirty days), waits again — else the page sat in Hub/Inbox where `brain.mjs inbox` never listed it.
const wait = (id, item, again = false) => { if (!inbox.items[id] || again) inbox.items[id] = { id, status: 'waiting', at: stamp(), ...item } }
// The sync's memory and the inbox are written after every course and when the process is told to stop, not only at the end:
// a fetch killed by the button's or the routine's timeout left downloaded pages in Hub/Inbox with no record, and the next run
// treated their names as already known — invisible for ever (review 2026-09-18). Both are read again before writing: brain.mjs
// may have decided on an item or moved a page meanwhile. merge3 against what this run last read: a record only this run
// changed is this run's, one only the disk changed is the disk's, and one both changed takes the other writer's fields — a
// decision's `status`, a move's `section`/`title`/`inbox` — over this run's. Unreadable on disk, this run's stand.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isBag = v => !!v && typeof v === 'object' && !Array.isArray(v)
function merge3(base, ours, disk) {
  base = isBag(base) ? base : {}; ours = isBag(ours) ? ours : {}; disk = isBag(disk) ? disk : base
  const out = { ...disk }
  for (const k of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    const b = base[k], o = ours[k], d = disk[k]
    if (same(o, b)) continue
    if (same(d, b) || !isBag(o) || !isBag(d)) { if (o === undefined) delete out[k]; else out[k] = o; continue }
    const m = { ...o }
    for (const f of new Set([...Object.keys(isBag(b) ? b : {}), ...Object.keys(d)])) if (!same(d[f], b?.[f])) { if (d[f] === undefined) delete m[f]; else m[f] = d[f] }
    out[k] = m
  }
  return out
}
// a decided item leaves after thirty days
const mergeInbox = disk => { inbox.items = merge3(inboxBase, inbox.items, disk?.items); const cutoff = localStamp(new Date(Date.now() - 30 * 86400000)); for (const [id, it] of Object.entries(inbox.items)) if (it?.status && it.status !== 'waiting' && String(it.decidedAt || '') < cutoff) delete inbox.items[id] }
const mergeState = disk => {
  const merged = {}
  for (const k of new Set([...Object.keys(stateBase || {}), ...Object.keys(state), ...Object.keys(isBag(disk) ? disk : {})])) {
    if (isBag(state[k]) || isBag(disk?.[k])) merged[k] = merge3(stateBase?.[k], state[k], isBag(disk) ? disk[k] : undefined)
    else merged[k] = isBag(disk) && k in disk && same(state[k], stateBase?.[k]) ? disk[k] : state[k]
  }
  Object.assign(state, merged)
}
// Under brain.mjs's own lock (scripts/lib/brain.mjs acquireLock), which every decision holds while it reads and rewrites
// these files: a merge must not land between its read and its write. `then` runs inside it, after the inbox is merged.
const checkpoint = async (then = null) => {
  if (DRY) return
  const release = await acquireLock(ROOT).catch(() => null)   // a lock held past a minute: merge without it rather than stop
  try {
    const keep = BRAIN || Object.keys(inbox.items).length
    if (keep) mergeInbox(await readJson(INBOX, null))
    if (then) await then()
    if (keep) { await writeJson(INBOX, inbox); inboxBase = clone(inbox.items) }
    mergeState(await readJson(STATE, null)); await writeJson(STATE, state); stateBase = clone(state)
  } finally { await release?.() }
}
// Told to stop (the routine's timeout): the same merge, synchronously, and temp-then-rename like `write` — a plain write
// cut short by the kill left `_sync-state.json` truncated, which reads as "nothing seen yet" and refetches everything.
process.on('SIGTERM', () => {
  try {
    if (!DRY) {
      const rd = f => { try { return JSON.parse(fsSync.readFileSync(f, 'utf8')) } catch { return null } }
      const put = (f, v) => { const tmp = path.join(path.dirname(f), `.tmp-${path.basename(f)}-${process.pid}`); fsSync.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n'); fsSync.renameSync(tmp, f) }
      if (BRAIN || Object.keys(inbox.items).length) { mergeInbox(rd(INBOX)); put(INBOX, inbox) }
      mergeState(rd(STATE)); put(STATE, state)
    }
  } catch { }
  process.exit(143)
})

for (const [course, info] of Object.entries(COURSES)) {
  const cid = info.id, nb = path.join(ROOT, course)
  log(`\n${course}`)
  const entry = { key: course, code: info.code, name: info.name, color: info.color, meets: info.meets, professor: info.professor || '', url: info.url || '', meetings: info.meetings || [], term: info.term, grade: null, nextDeadline: null, week: weekFor(info.term, today)?.label || null, weekPage: (w => (w ? `${course}/${w.dir}.md` : null))(weekFor(info.term, today)) }
  // Announcements: one subpage each under Announcements/Announcements/, an index page listing them
  // newest first, files that an announcement carries or links on that announcement's page, and a
  // link from every week the announcement talks about.
  const annDir = path.join(nb, 'Announcements'), subDir = path.join(annDir, 'Announcements'), indexPath = path.join(annDir, 'Announcements.md')
  await migrateAnnouncements(course, nb, info)
  const anns = (await getAll(`/courses/${cid}/discussion_topics?only_announcements=true&per_page=50`)) || []
  const existingSubs = (await exists(subDir)) ? (await fs.readdir(subDir)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) : []
  for (const a of anns) if (!state.announcements[a.id] && existingSubs.some(t => t.endsWith(' ' + safeName(a.title.trim())))) state.announcements[a.id] = { title: a.title, at: a.posted_at, seeded: true }
  const fresh = anns.filter(a => !state.announcements[a.id]).sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
  const annFiles = new Map()   // file id → announcement subpage title, so body links land on that page
  const bare = n => safeName(String(n || '').replace(/\.[^.]+$/, ''))
  for (const a of fresh) {
    const title = annTitle(a.posted_at, a.title), body = htmlToMd(a.message)
    // With Claude as the brain no date in the text decides a week: Claude links the announcement to its weeks, and a file it
    // carries waits in the inbox as a page of its own, named from here (SPEC §20.37).
    const wks = BRAIN ? [] : weeksMentioned(info.term, a.title + '\n' + body)
    const attached = BRAIN ? (a.attachments || []).map(at => bare(at.display_name)) : []
    await write(path.join(subDir, title + '.md'), `---\ncreated: "${localStamp(new Date(a.posted_at))}"\nkind: "admin"\ntags: ["announcement"]\n---\n# ${a.title.trim()}\n\n_${localIso(a.posted_at)} · ${a.user_name || a.author?.display_name || ''}_${wks.length ? `\n\nConcerns ${wks.map(w => `[[${w.label}]]`).join(', ')}.` : ''}\n\n${body}\n${attached.length ? `\nAttached: ${attached.map(t => `[[${t}]]`).join(', ')}\n` : ''}`)
    for (const w of wks) await linkWeek(nb, w, title)
    for (const at of a.attachments || []) {
      if (BRAIN) await addFile(course, nb, null, bare(at.display_name), at.id, at.display_name, at.url, at.size, { inbox: true, module: 'announcement', from: title, posted: localIso(a.posted_at) })
      else await addFile(course, nb, 'Announcements/Announcements', title, at.id, at.display_name, at.url, at.size, { card: true })
    }
    for (const m of (a.message || '').matchAll(/\/courses\/(\d+)\/files\/(\d+)/g)) if (m[1] === String(cid)) annFiles.set(Number(m[2]), title)
    state.announcements[a.id] = { title: a.title, at: a.posted_at }
    hub.news.push({ course: info.code, courseKey: course, title: a.title.trim(), at: a.posted_at, page: `${course}/Announcements/Announcements/${title}.md`, weeks: wks.map(w => w.label) })
    if (BRAIN) wait('a-' + a.id, { kind: 'announcement', courseKey: course, title: a.title.trim(), page: `${course}/Announcements/Announcements/${title}.md`, posted: localIso(a.posted_at), quercus: a.html_url || null })
  }
  for (const [fid, title] of annFiles) {
    if (state.files[fid]) continue
    const f = await get(`/courses/${cid}/files/${fid}`); if (!f) continue
    if (BRAIN) await addFile(course, nb, null, bare(f.display_name), f.id, f.display_name, f.url, f.size, { inbox: true, module: 'announcement', from: title, posted: localIso(f.updated_at || f.created_at) })
    else await addFile(course, nb, 'Announcements/Announcements', title, f.id, f.display_name, f.url, f.size, { card: true })
  }
  if (fresh.length) log(`  ${fresh.length} new announcement(s)`)
  await writeAnnouncementIndex(course, nb)
  // Files in modules → one page per file in the week the file was published; syllabus-like names → General.
  const mods = (await getAll(`/courses/${cid}/modules?include[]=items&per_page=100`)) || []
  // Canvas leaves `items` out of a module with more than it will inline; those are fetched on their own.
  for (const m of mods) if (!Array.isArray(m.items)) m.items = (await getAll(`/courses/${cid}/modules/${m.id}/items?per_page=100`)) || []
  // Files already in the notebook (imported earlier) count as seen: a Desktop file by its name, a Quercus file by its name
  // and its size. By name alone a professor's second "Slides.pdf" — next week's, another folder, another id — read as the
  // first one and was never fetched. `[\\/]`: on a PC the path says `.assets\`, and the Set stayed empty there.
  const have = new Map()   // file name, lower case → the sizes it has here
  const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const q = path.join(d, e.name); if (e.isDirectory()) await walk(q); else if (/\.assets[\\/]/.test(q)) { const n = e.name.toLowerCase(); have.set(n, (have.get(n) || new Set()).add((await fs.stat(q).catch(() => null))?.size ?? null)) } } }
  const haveSame = (name, size) => [String(name || ''), safeName(name || '')].some(n => { const s = have.get(n.toLowerCase()); return !!s && (size == null || s.has(size)) })
  await walk(nb)
  // what already waits in the inbox, or was set aside there, is not fetched again as a second page (SPEC §20.37)
  if (BRAIN) { await walk(path.join(HUB, 'Inbox', course)); await walk(path.join(HUB, 'Inbox', 'Ignored', course)) }
  // Files hide in more places than modules (see the quercus skill): module items, a module's link to a Quercus file, page
  // bodies, announcement bodies and attachments, the syllabus body, hand-in and quiz descriptions, forum bodies and
  // attachments, a video uploaded into a page, the Files tab. Collect every file id, then fetch each once.
  const FILE_RE = /\/courses\/(\d+)\/files\/(\d+)/g
  // a video uploaded through the page editor is an <iframe> on /media_attachments_iframe/<file id>: a file of this course
  const MEDIA_RE = /\/media_attachments_iframe\/(\d+)/g
  const found = new Map()   // id → { module, direct, heading, from, course when another course's, att when an attachment }
  // The heading above a file's link is where the professor posted it ("Class slides", "Ungraded problem set and
  // application"); the classifier reads it when the file's name is not decisive (SPEC §20.32).
  // `from` is the title of the page that links the file: a file linked from "Next Week's Reading" is next week's (below).
  // A link to another course's file (a department's shared course) keeps that course: it is asked for by id alone, below.
  // `weak`: a place read after the pages — an announcement, a hand-in's description — names a file only nothing else named.
  const noteIds = (html, module, from = null, weak = false) => {
    let md = null
    const ids = [...String(html || '').matchAll(FILE_RE)].map(m => [m[1], m[2]]).concat([...String(html || '').matchAll(MEDIA_RE)].map(m => [String(cid), m[1]]))
    for (const [c, fid] of ids) {
      const id = Number(fid), prior = found.get(id)
      if (weak && prior) continue
      md ??= htmlToMd(html)
      const heading = headingFor(md, [`/files/${id}?`, `/files/${id})`, `/files/${id}/`, `/files/${id}"`])
      // A file that is a module item of its own keeps that module — where the professor put it — even when a page in
      // another module links it too (a week's overview page linking next module's reading); the page still gives `from`.
      found.set(id, { module: prior?.direct ? prior.module : module, direct: !!prior?.direct, heading: heading || prior?.heading || '', from: from || prior?.from || null, ...(c !== String(cid) ? { course: c } : {}) })
    }
  }
  for (const m of Array.isArray(mods) ? mods : []) for (const it of m.items || []) {
    if (it.type === 'File' && it.content_id) found.set(Number(it.content_id), { module: m.name, direct: true, heading: found.get(Number(it.content_id))?.heading || '', from: found.get(Number(it.content_id))?.from || null })
    else if (it.type === 'Page' && it.page_url) { const pg = await get(`/courses/${cid}/pages/${it.page_url}`); noteIds(pg?.body, m.name, pg?.title || it.title) }
    // an "External URL" item that is a Quercus file's own address: a file item in all but its type
    else if (it.type === 'ExternalUrl') noteIds(it.external_url, m.name, it.title)
  }
  const details = await get(`/courses/${cid}?include[]=syllabus_body`); noteIds(details?.syllabus_body, 'syllabus')
  // Quercus pages → notebook pages. Sources: module Page items, the front page, and every page those link to (ECO206
  // keeps one topic page per week on its front page, in no module), below. A page stays
  // locked until its week arrives, so every run asks again; a page that changed is rewritten unless
  // the student has written containers on it, in which case it is left alone and logged.
  const pageUrls = new Map()
  // A page no module lists is reached by a link — from the front page, from another page ("the essay guidelines are here"),
  // the syllabus, an announcement, a module's External URL — or by the Pages index where a course leaves it on. The loop
  // below reads the pages every page it reads links to: a Map visits what is added while it is walked.
  const notePages = (html, module) => { for (const m of String(html || '').matchAll(new RegExp(`/courses/${cid}/(?:pages|wiki)/([a-z0-9._~%-]+)`, 'gi'))) if (!pageUrls.has(m[1])) pageUrls.set(m[1], { module }) }
  // MyMedia videos a page, the syllabus, an announcement or a description embeds (scripts/lib/mymedia.mjs mymediaIn): the
  // same download as a module's video item, done once the places are read. The tag's title names one, else where it sits.
  const videos = new Map()
  const noteVideos = (html, module, from) => { const vs = mymediaIn(html); vs.forEach((v, i) => { if (!videos.has(v.id)) videos.set(v.id, { url: v.url, title: v.title || `${from} video${vs.length > 1 ? ` ${i + 1}` : ''}`, module }) }) }
  for (const m of Array.isArray(mods) ? mods : []) for (const it of m.items || []) if (it.type === 'Page' && it.page_url) pageUrls.set(it.page_url, { module: m.name }); else if (it.type === 'ExternalUrl') notePages(it.external_url, m.name)
  const front = await get(`/courses/${cid}/front_page`)
  if (front?.url) pageUrls.set(front.url, { module: 'front page', front: true })
  notePages(front?.body, 'front page')
  // The Syllabus tab's own text, when it holds the syllabus and not only a link to the PDF: nothing kept it, and a course
  // whose outline lives only there (dates, weights, rules) had none in the notebook. No `updated_at`: a hash stands in.
  if (htmlToMd(details?.syllabus_body || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').length >= 200) pageUrls.set('item-syllabus', { module: 'Syllabus tab', item: { url: 'item-syllabus', title: 'Syllabus on Quercus', body: details.syllabus_body, updated_at: hashOf(details.syllabus_body), html_url: `${info.url}/assignments/syllabus` }, kind: 'syllabus' })
  notePages(details?.syllabus_body, 'syllabus'); noteVideos(details?.syllabus_body, 'syllabus', 'Syllabus')
  for (const a of anns) { notePages(a.message, 'announcement'); noteVideos(a.message, 'announcement', a.title.trim()) }
  // quiet: UofT turns the index off in most courses (404), and some hide it (401)
  for (const p of (await getAll(`/courses/${cid}/pages?per_page=100`, true)) || []) if (p?.url && !pageUrls.has(p.url)) pageUrls.set(p.url, { module: 'pages' })
  // The hand-ins, forums and quizzes, read once and here: a page only their descriptions link to ("the rubric is here")
  // is reached by the walk below like any other — it was not, for one in no module — and the places further down read
  // their files, attachments and videos from the same three lists.
  const asgRaw = await getAll(`/courses/${cid}/assignments?per_page=100&include[]=submission&order_by=due_at`)
  const discs = (await getAll(`/courses/${cid}/discussion_topics?per_page=100`, true)) || [], quizzes = (await getAll(`/courses/${cid}/quizzes?per_page=100`, true)) || []
  for (const a of asgRaw || []) notePages(a.description, 'assignment'); for (const d of discs) notePages(d.message, 'discussion'); for (const q of quizzes) notePages(q.description, 'quiz')
  // The rest of a module — its discussion forums, quizzes and hand-ins, and the videos it links — as pages too (SPEC §20.53),
  // so a week's shelf shows the whole module and not only its files. Each is read into the shape of a Quercus page and
  // takes the same road below: the inbox, then wherever Claude files it (Assignments, Videos), rewritten there when it
  // changes. A MyMedia video is fetched too (scripts/lib/mymedia.mjs): the watch page wants a UTORid but the Wowza
  // stream behind it does not, so the file lands in the course's Videos folder and its page carries both link and file.
  for (const m of Array.isArray(mods) ? mods : []) for (const it of m.items || []) {
    const what = it.type === 'Discussion' ? 'discussion' : it.type === 'Quiz' ? 'quiz' : it.type === 'Assignment' ? 'assignment' : it.type === 'ExternalUrl' && (VIDEO_RE.test(it.external_url || '') || isMyMedia(it.external_url)) ? 'video' : null
    if (!what) continue
    const item = await moduleItemPage(cid, what, it, { course, nb, module: m.name })
    if (item) pageUrls.set(item.url, { module: m.name, item, kind: what === 'quiz' ? 'exam' : what === 'video' ? 'notes' : 'problem-set', label: what === 'discussion' ? 'discussion forum' : what })
  }
  for (const [url, meta] of pageUrls) {
    const pg = meta.front ? front : meta.item ? meta.item : await get(`/courses/${cid}/pages/${url}`)
    if (!pg || !pg.body) { if (pg?.locked_for_user) log(`  page locked: ${pg.title || url}`); continue }
    noteIds(pg.body, meta.module, pg.title); notePages(pg.body, meta.module); noteVideos(pg.body, meta.module, pg.title)
    const key = `${cid}:${url}`, seen = state.pages[key]
    if (seen && seen.updated === pg.updated_at) continue
    if (BRAIN && !meta.front) {
      // Claude as the brain (SPEC §20.37): a new page waits in the inbox; a page that changed is rewritten where it lives now —
      // the inbox while it waits, else wherever Claude put it (scripts/lib/move.mjs keeps `section` and `title` in step) — and
      // waits to be read again. A page moved without a record is not recreated where a rule once put it: it waits again.
      let rel = seen?.inbox || (seen?.courseKey && seen.section != null ? `${seen.courseKey}/${seen.section}/${seen.title}.md` : null)
      if (!rel && seen) { const p = pageWeek(pg.title, meta.module, weeks(info.term)); rel = `${course}/${p ? (p.lecture ? `${p.week.dir}/Lectures` : p.week.dir) : 'General'}/${safeName(p ? p.title : pg.title || url)}.md` }
      if (rel && !(await exists(path.join(ROOT, rel)))) rel = null
      const isNew = !rel
      if (isNew) rel = `Hub/Inbox/${course}/${await freeTitle(path.join(HUB, 'Inbox', course), safeName(pg.title || url), '')}.md`
      const file = path.join(ROOT, rel), pageTitle = path.posix.basename(rel, '.md'), qUrl = pg.html_url || `${info.url}/pages/${url}`
      const old = await fs.readFile(file, 'utf8').catch(() => '')
      const itemId = isNew ? `p-${key}` : `u-${key}@${pg.updated_at}`
      // the student wrote here when the page has a second container, or when its body is no longer the one the sync wrote (the
      // first container carries no anchor, so typing into it left no `slate:block` to find — review 2026-09-18). Not a page
      // written anew: its "old" text is nothing, which read as notes of his and left the page unwritten (review 2026-09-29).
      // The record keeps its `title`: after a placement it is the page's name, and the Quercus title put there sent the
      // next update to a page that is not there.
      if (!isNew && (old.includes('<!-- slate:block ') || (seen?.bodyHash && bodyHashOf(old) !== seen.bodyHash))) {
        log(`  page changed on Quercus but has your notes, left alone: ${rel}`)
        state.pages[key] = { ...(seen || {}), updated: pg.updated_at, at: today }
        wait(itemId, { kind: 'page-update', courseKey: course, title: pg.title, page: rel, module: meta.module, note: 'changed on Quercus; not rewritten because it has your notes', quercus: qUrl })
        continue
      }
      log(`  page: ${pg.title} → ${isNew ? 'the inbox' : rel}${seen ? ' (updated)' : ''}`)
      state.pages[key] = isNew ? { title: pg.title, updated: pg.updated_at, courseKey: course, inbox: rel, module: meta.module, at: today } : { ...seen, updated: pg.updated_at, at: today }
      hub.pages.push({ course: info.code, courseKey: course, title: pageTitle, page: rel, where: whereOf(rel), updated: !!seen, module: meta.module })
      wait(itemId, { kind: isNew ? 'page' : 'page-update', courseKey: course, title: pg.title, page: rel, module: meta.module, posted: localIso(pg.updated_at), quercus: qUrl }, isNew)
      if (DRY) continue
      const created = /created:\s*"?([^"\n]+)"?/.exec(old)?.[1] || stamp(), kind = /^kind:\s*"?([^"\n]+)"?/m.exec(old)?.[1] || meta.kind || 'notes'
      const text = `---\ncreated: "${created}"\nkind: "${kind}"\ntags: ${keepTags(old)}${keepFor(old)}\n---\n# ${pg.title}\n\n_${quercusLine(meta, pg)} · [open on Quercus](${qUrl})_\n\n${htmlToMd(pg.body)}\n`
      state.pages[key].bodyHash = bodyHashOf(text)
      await write(file, text)
      const order = await readJson(path.join(path.dirname(file), '_slate.json'), { order: [] })
      if (!(order.order || []).includes(pageTitle)) { order.order = [...(order.order || []), pageTitle]; await writeJson(path.join(path.dirname(file), '_slate.json'), order) }
      continue
    }
    // "1: Constrained Optimization" / "Week 3 …" → that week's folder, beside Notes and Lectures; a lecture page inside a
    // week's module (CLA204's "Lecture 2: Mythology, Hesiod 1") → that week's Lectures; else General (filing.mjs pageWeek).
    const place = meta.front ? null : pageWeek(pg.title, meta.module, weeks(info.term))
    const section = meta.front ? 'General' : place ? (place.lecture ? `${place.week.dir}/Lectures` : place.week.dir) : 'General'
    const title = meta.front ? 'Home' : safeName(place ? place.title : pg.title || url)
    const md = path.join(nb, section, `${title}.md`)
    const old = await fs.readFile(md, 'utf8').catch(() => '')
    if (old.includes('<!-- slate:block ') || (seen?.bodyHash && bodyHashOf(old) !== seen.bodyHash)) { log(`  page changed on Quercus but has your notes, left alone: ${title}`); state.pages[key] = { ...(seen || {}), title: pg.title, updated: pg.updated_at, section, at: today }; continue }
    log(`  page: ${pg.title} → ${section}/${title}${seen ? ' (updated)' : ''}`)
    state.pages[key] = { title: pg.title, updated: pg.updated_at, section, at: today }
    hub.pages.push({ course: info.code, courseKey: course, title, page: `${course}/${section}/${title}.md`, where: section.split('/').pop(), updated: !!seen, module: meta.module })
    if (DRY) continue
    const created = /created:\s*"?([^"\n]+)"?/.exec(old)?.[1] || stamp()
    const text = `---\ncreated: "${created}"\nkind: "${meta.kind || (meta.front || section === 'General' ? 'admin' : place?.lecture ? 'lecture' : 'reading')}"\ntags: ${keepTags(old)}${keepFor(old)}\n---\n# ${pg.title}\n\n_${quercusLine(meta, pg)} · [open on Quercus](${pg.html_url || `${info.url}/pages/${url}`})_\n\n${htmlToMd(pg.body)}\n`
    state.pages[key].bodyHash = bodyHashOf(text)
    await write(md, text)
    const meta2 = await readJson(path.join(nb, section, '_slate.json'), { order: [] })
    if (!meta2.order.includes(title)) { meta2.order.push(title); await writeJson(path.join(nb, section, '_slate.json'), meta2) }
  }
  // External links in modules (WebAssign, Crowdmark, coach links) → one Links page per course.
  const links = []
  for (const m of Array.isArray(mods) ? mods : []) for (const it of m.items || []) if ((it.type === 'ExternalUrl' || it.type === 'ExternalTool') && (it.external_url || it.html_url)) links.push({ module: m.name, title: it.title, url: it.external_url || it.html_url })
  if (links.length && !DRY) {
    const md = path.join(nb, 'General', 'Links.md'), old = await fs.readFile(md, 'utf8').catch(() => '')
    if (!old.includes('<!-- slate:block ')) {
      await write(md, `---\ncreated: "${/created:\s*"?([^"\n]+)"?/.exec(old)?.[1] || stamp()}"\nkind: "admin"\ntags: ["quercus", "links"]\n---\n# Links\n\n_Every external link in the course modules, rewritten each sync._\n\n${links.map(l => `- [${l.title}](${l.url}) · ${l.module}`).join('\n')}\n`)
      const meta3 = await readJson(path.join(nb, 'General', '_slate.json'), { order: [] })
      if (!meta3.order.includes('Links')) { meta3.order.push('Links'); await writeJson(path.join(nb, 'General', '_slate.json'), meta3) }
    }
  }
  // The places no module holds, read every run (weak: each names only a file nothing above named): every announcement's
  // links and attachments — not only on the day it is posted, when a download that failed, or a link an edit added later,
  // was never looked for again — the hand-ins' descriptions, the forums' bodies and attachments, and the quizzes'
  // descriptions (a practice quiz is in no list but its own). The Files tab, hidden in most courses, cannot stand in.
  const attach = (list, module, from) => { for (const at of list || []) if (at?.id && !found.has(Number(at.id))) found.set(Number(at.id), { module, heading: '', from, att: at }) }
  for (const a of anns) { const t = annTitle(a.posted_at, a.title); noteIds(a.message, 'announcement', t, true); attach(a.attachments, 'announcement', t) }
  for (const a of asgRaw || []) { noteIds(a.description, 'assignment', a.name, true); noteVideos(a.description, 'assignment', a.name) }
  for (const d of discs) { noteIds(d.message, 'discussion', d.title, true); attach(d.attachments, 'discussion', d.title); noteVideos(d.message, 'discussion', d.title) }
  for (const q of quizzes) { noteIds(q.description, 'quiz', q.title, true); noteVideos(q.description, 'quiz', q.title) }
  for (const v of videos.values()) await addVideo(course, nb, v.title, v.url, { module: v.module })
  // The tab adds files nobody linked; it never overwrites the module a file was found in (it did, and every ECO208 file
  // reached the brain as `module: files` — review 2026-09-18).
  const tab = await getAll(`/courses/${cid}/files?per_page=100`); for (const f of Array.isArray(tab) ? tab : []) if (!found.has(Number(f.id))) found.set(Number(f.id), { module: 'files', heading: '', from: null })
  for (const [fid, { module, heading, from, course: other, att }] of found) {
    const seen = state.files[fid]
    if (seen?.decoration || seen?.seeded) continue
    // Another course's file is asked for by its id alone, quietly: a link left from last year's course answers 401 every
    // morning. An attachment carries its own url and name, used when the course's files endpoint will not describe it.
    const f = (await get(other ? `/files/${fid}` : `/courses/${cid}/files/${fid}`, false, !!(other || att))) || att; if (!f) continue
    if (seen) {
      // A professor who replaces a deck in place keeps the file's id and changes its bytes: nothing noticed (review 2026-09-18).
      // With Claude as the brain the new version waits in the inbox as its own page, named for the day, and the item says
      // which page it is a new version of; the record remembers what it saw so one change makes one item.
      const changed = (seen.updated && f.updated_at && seen.updated !== f.updated_at) || (seen.size != null && f.size != null && seen.size !== f.size)
      const was = seen.inbox || (seen.courseKey && seen.section != null ? `${seen.courseKey}/${seen.section}/${seen.title}.md` : seen.section != null && seen.title ? `${course}/${seen.section}/${seen.title}.md` : null)
      if (changed && BRAIN) await addFile(course, nb, null, `${safeName(f.display_name.replace(/\.[^.]+$/, ''))} (updated ${localIso(f.updated_at)})`, f.id, f.display_name, f.url, f.size, { inbox: true, module: seen.module || module, heading, from, posted: localIso(f.updated_at), updated: f.updated_at, stateKey: `${fid}@${f.updated_at}`, itemId: `f-${fid}@${f.updated_at}`, note: was ? `a new version of ${was}` : 'a new version of a file already filed' })
      seen.updated = f.updated_at; seen.size = f.size
      continue
    }
    // A banner or photo embedded in a page body is decoration, not a course document.
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f.display_name || '') && module !== 'files') { state.files[fid] = { name: f.display_name, decoration: true }; continue }
    const m = { name: module }
    if (haveSame(f.display_name, f.size)) { state.files[f.id] = { name: f.display_name, seeded: true, size: f.size ?? null }; continue }
    // The week a file was posted in — unless the page that links it is next week's reading, posted a week early on
    // purpose (CLA204's "Next Week's Reading" links the Homeric Hymn on the Thursday of Week 1): then the week after.
    if (BRAIN) { await addFile(course, nb, null, safeName(f.display_name.replace(/\.[^.]+$/, '')), f.id, f.display_name, f.url, f.size, { inbox: true, module: m.name, heading, from, posted: localIso(f.updated_at || f.created_at), updated: f.updated_at || f.created_at }); continue }
    const when = f.updated_at || f.created_at, w = fileWeek(weekFor(info.term, when), from, weeks(info.term))
    // One classifier decides where a file lives (scripts/lib/filing.mjs, SPEC §20.21): everything used to land in
    // Lectures, so a problem set and its solutions sat among the slides.
    const bucket = bucketFor(f.display_name, { module: m.name, heading })
    const admin = bucket === 'admin'
    const section = admin || !w ? 'General' : `${w.dir}/${FOLDER[bucket] || 'Lectures'}`
    const title = safeName(f.display_name.replace(/\.[^.]+$/, ''))
    const kind = bucket === 'guides' ? 'reading' : bucket === 'problems' || bucket === 'solutions' ? 'problem-set'
      : /reading|chapter|article/i.test(m.name + ' ' + f.display_name) ? 'reading' : admin ? 'syllabus' : 'lecture'
    await addFile(course, nb, section, title, f.id, f.display_name, f.url, f.size, { newPage: true, kind, module: m.name, updated: f.updated_at || f.created_at })
  }
  // The Desktop course folder (~/Desktop/<course>): recordings and files the student drops there by hand.
  // Copied, never moved; filed by scripts/lib/filing.mjs, the same classifier the Quercus files use.
  const desk = path.join(os.homedir(), 'Desktop', course)
  const deskFiles = []
  // `Study sheets/` in a Desktop course folder is slate's own output (SPEC 18.4). Walking into it
  // would copy every sheet back in as a Lectures page on the next run. A `<Set> — work/` folder is a skill's scratch.
  const walkDesk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { if (e.name.startsWith('.') || e.name === SHEETS_DIR || (e.isDirectory() && isScratchDir(e.name))) continue; const q = path.join(d, e.name); if (e.isDirectory()) await walkDesk(q); else if (!/\.md$/i.test(e.name)) deskFiles.push(q) } }
  await walkDesk(desk)
  for (const q of deskFiles) {
    const name = path.basename(q)
    if (have.has(name.toLowerCase()) || have.has(safeName(name).toLowerCase()) || state.files['desk:' + q]) continue
    const st = await fs.stat(q)
    const rel = path.relative(desk, q), dm = /(\d{2}):(\d{2}):(\d{4})/.exec(rel)
    if (BRAIN) {
      // Claude as the brain (SPEC §20.37): the copy waits in the inbox; Claude decides the week and the folder. A Desktop copy
      // of a document the Quercus fetch brought this very run is the same document, not a second page.
      if (Object.values(state.files).some(v => v?.courseKey === course && v.inbox && String(v.name || '').toLowerCase() === name.toLowerCase())) continue
      const media = /\.(mp4|mov|webm|m4a|mp3|wav|aac|ogg|flac|aiff|caf)$/i.test(name), dir = path.join(HUB, 'Inbox', course)
      const title = await freeTitle(dir, safeName(name.replace(/\.[^.]+$/, '')), name), pageRel = `Hub/Inbox/${course}/${title}.md`
      log(`  desktop: ${rel} → the inbox`)
      state.files['desk:' + q] = { name, courseKey: course, inbox: pageRel, from: rel, at: today }
      hub.files.push({ course: info.code, courseKey: course, name, page: pageRel, where: 'Inbox', module: 'Desktop folder' })
      wait('d-' + newId(), { kind: 'desktop', courseKey: course, title, page: pageRel, name, from: rel, posted: localIso(st.mtime) })
      if (DRY) continue
      const assets = path.join(dir, `${title}.assets`)
      await fs.mkdir(assets, { recursive: true }); await fs.copyFile(q, path.join(assets, safeName(name)))
      const md = path.join(dir, `${title}.md`)
      if (!(await exists(md))) await write(md, `---\ncreated: "${localStamp(st.mtime)}"\nkind: "notes"\ntags: ["desktop"]\n---\n# ${title}\n\n_From the Desktop folder · ${rel}_\n`)
      const sidecarPath = path.join(dir, `${title}.blocks.json`), sidecar = await readJson(sidecarPath, { version: 1, elements: [] })
      sidecar.elements.push({ id: newId(), type: media ? 'media' : /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? 'image' : 'file', src: `${title}.assets/${safeName(name)}`, size: st.size })
      await writeJson(sidecarPath, sidecar)
      const meta = await readJson(path.join(dir, '_slate.json'), { order: [] })
      if (!meta.order.includes(title)) { meta.order.push(title); await writeJson(path.join(dir, '_slate.json'), meta) }
      continue
    }
    const when = dm ? `${dm[3]}-${dm[1]}-${dm[2]}` : st.mtime
    const w = weekFor(info.term, when)
    const bucket = bucketFor(name)
    const media = /\.(mp4|mov|webm|m4a|mp3|wav|aac|ogg|flac|aiff|caf)$/i.test(name)   // a recording: a notes page with a player; anything else a lecture page
    const section = bucket === 'admin' ? 'General' : w ? `${w.dir}/${FOLDER[bucket] || 'Lectures'}` : 'General'
    const title = safeName(name.replace(/\.[^.]+$/, ''))
    log(`  desktop: ${rel} → ${section}/${title}`)
    state.files['desk:' + q] = { name, section, title, at: today }
    hub.files.push({ course: info.code, courseKey: course, name, page: `${course}/${section}/${title}.md`, where: section.split('/').slice(-2).join(' · '), module: 'Desktop folder' })
    if (DRY) continue
    const dir = path.join(nb, section), assets = path.join(dir, `${title}.assets`)
    await fs.mkdir(assets, { recursive: true }); await fs.copyFile(q, path.join(assets, safeName(name)))
    const md = path.join(dir, `${title}.md`)
    if (!(await exists(md))) await write(md, `---\ncreated: "${localStamp(st.mtime)}"\nkind: "${media ? 'notes' : 'lecture'}"\ntags: ["desktop"]\n---\n# ${title}\n\n_From the Desktop folder · ${rel}_\n`)
    const sidecarPath = path.join(dir, `${title}.blocks.json`), sidecar = await readJson(sidecarPath, { version: 1, elements: [] })
    sidecar.elements.push({ id: newId(), type: media ? 'media' : /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? 'image' : 'file', src: `${title}.assets/${safeName(name)}`, size: st.size })
    await writeJson(sidecarPath, sidecar)
    const meta = await readJson(path.join(dir, '_slate.json'), { order: [] })
    if (!meta.order.includes(title)) { meta.order.push(title); await writeJson(path.join(dir, '_slate.json'), meta) }
  }
  // Assignments → deadlines, tests, grades (asgRaw: read above, for the files their descriptions link).
  const asg = Array.isArray(asgRaw) ? asgRaw : []
  // The call failed: the course's deadlines and tests from the last run stand rather than vanishing for the day.
  if (asgRaw === null && prevHub) { for (const d of (prevHub.deadlines || []).filter(x => x.courseKey === course && x.source === 'quercus')) hub.deadlines.push(d); for (const t of (prevHub.tests || []).filter(x => x.courseKey === course && x.note === 'from Quercus')) hub.tests.push(t); for (const h of (prevHub.handedIn || []).filter(x => x.courseKey === course)) hub.handedIn.push(h); errors.push(`${info.code}: assignments could not be fetched; yesterday's deadlines kept`) }
  const graded = []   // every mark Quercus has returned, for the grade model
  const forums = new Map()   // topic id → { title, assignment }: the forums to look for the student's posts in
  for (const a of Array.isArray(asg) ? asg : []) {
    const sub = a.submission || {}
    if (sub.score != null && a.points_possible) graded.push({ name: a.name, score: sub.score, points: a.points_possible })
    const item = { course: info.code, courseKey: course, title: a.name, due: a.due_at, points: a.points_possible, url: a.html_url, source: 'quercus', submitted: !!sub.submitted_at || sub.workflow_state === 'graded', score: sub.score ?? null, gradedAt: sub.graded_at || null }
    // Days left in calendar days, counted from `today` in Toronto: elapsed hours made a hand-in due at 23:59 tonight read
    // "tomorrow" at 07:00 (review 2026-09-29). A test is a word of its own (TEST_RE).
    if (a.due_at && localIso(a.due_at) >= SINCE && !item.submitted) hub.deadlines.push({ ...item, daysLeft: Math.round((Date.parse(localIso(a.due_at)) - Date.parse(today)) / 86400000) })
    if (TEST_RE.test(a.name) && a.due_at && localIso(a.due_at) >= today) hub.tests.push({ course: info.code, courseKey: course, title: a.name, date: localIso(a.due_at), note: 'from Quercus', url: a.html_url })
    if (sub.graded_at && sub.score != null) {
      const key = `${cid}:${a.id}`
      if (!state.grades[key] || state.grades[key].score !== sub.score) { hub.grades.recent.push({ course: info.code, courseKey: course, item: a.name, score: sub.score, possible: a.points_possible, gradedAt: sub.graded_at, isNew: true }) }
      state.grades[key] = { score: sub.score, at: sub.graded_at }
    }
    // What is already in (SPEC §20.69), under every link a task may carry — the assignment, its quiz. Handed in, excused, or
    // marked without a hand-in (a checkpoint quiz sat in the tutorial); a zero Quercus gave for a missing hand-in is not
    // "done", and neither is any mark on a submission it calls missing. A forum is found by the post itself, below.
    if ((a.submission_types || []).includes('discussion_topic') && a.discussion_topic?.id) { forums.set(String(a.discussion_topic.id), { title: a.name, assignment: a.html_url }); continue }
    const missing = sub.missing === true || sub.late_policy_status === 'missing'
    const markedIn = !missing && sub.score != null && (sub.workflow_state === 'graded' || !!sub.graded_at) && (!!sub.submitted_at || sub.score > 0)
    if (sub.submitted_at || sub.excused || markedIn)
      hub.handedIn.push({ course: info.code, courseKey: course, kind: a.quiz_id ? 'quiz' : 'assignment', title: a.name, urls: [a.html_url, a.quiz_id ? `${SITE}/courses/${cid}/quizzes/${a.quiz_id}` : null].filter(Boolean),
        submittedAt: sub.submitted_at || null, excused: !!sub.excused, score: markedIn ? sub.score : null, points: a.points_possible ?? null, gradedAt: markedIn ? sub.graded_at || null : null })
  }
  // Forums: the graded ones above, and every one an open task points at. the student's own entries, at the top (his post) or under
  // someone else's (a reply) — the tree `/view` returns, one call a forum, only for the forums that are asked about.
  for (const l of openLinks(course)) { const m = /\/courses\/(\d+)\/discussion_topics\/(\d+)/.exec(l); if (m && Number(m[1]) === Number(cid) && !forums.has(m[2])) forums.set(m[2], { title: null, assignment: null }) }
  for (const [tid, f] of ME == null ? [] : forums) {
    const v = await get(`/courses/${cid}/discussion_topics/${tid}/view`); if (!v) continue
    const posted = { initial: null, reply: null }
    const walk = (entries, depth) => { for (const e of entries || []) { if (e?.user_id === ME && !e.deleted) { const k = depth ? 'reply' : 'initial'; if (!posted[k] || e.created_at < posted[k]) posted[k] = e.created_at } walk(e?.replies, depth + 1) } }
    walk(v.view, 0)
    if (posted.initial || posted.reply) hub.handedIn.push({ course: info.code, courseKey: course, kind: 'discussion', title: f.title, urls: [`${SITE}/courses/${cid}/discussion_topics/${tid}`, f.assignment].filter(Boolean), posted })
  }
  for (const [date, title] of info.tests) if (date >= today) hub.tests.push({ course: info.code, courseKey: course, title, date, note: 'from the syllabus' })
  // WebAssign sets from the course outline (SPEC §20.4): source 'syllabus', live from the Monday of their week until due, gone once the row is ticked; Quercus wins when it lists the same set.
  // …with the tool's own link from the course's modules, so the row opens WebAssign itself and not a page about it (SPEC §20.38).
  const waUrl = links.find(l => /webassign/i.test(`${l.title} ${l.url}`))?.url || null
  for (const d of await webassignDeadlines(course, ROOT, today)) if (!hub.deadlines.some(x => x.courseKey === course && x.source === 'quercus' && String(x.title).toLowerCase().includes(d.set.toLowerCase()))) hub.deadlines.push(waUrl && !d.url ? { ...d, url: waUrl } : d)
  entry._graded = graded
  hub.courses.push(entry)
  await checkpoint()
}
// Where he stands under each course's own rules (src/grade.js), from the marks Quercus returned and the ones he entered
// himself (Hub/_marks.json, SPEC §21.12 — read here, never written). `match` regexes do not survive JSON, so the Home
// screen gets the model without them.
const MARKS = await readMarks(ROOT)
for (const c of hub.courses) {
  const info = COURSES[c.key]; if (!info?.grading) continue
  const scores = scoresFromAssignments(info.grading, c._graded || [])
  if (!scores.webassign && info.grading.components.some(x => x.key === 'webassign')) { const wa = await webassignScores(c.key, ROOT); if (wa?.avg != null) scores.webassign = { avg: wa.avg } }
  c.grading = { components: info.grading.components.map(({ match, ...rest }) => rest), schemes: info.grading.schemes }
  Object.assign(c, applyMarks({ ...c, quercusScores: scores }, MARKS.courses[c.key]))
  delete c._graded
}
// Current grades from the enrollment totals.
const mine = (await getAll('/users/self/courses?include[]=total_scores&enrollment_state=active&per_page=50')) || []
for (const c of Array.isArray(mine) ? mine : []) {
  const entry = hub.courses.find(x => COURSES[x.key].id === c.id); if (!entry) continue
  const en = (c.enrollments || [])[0] || {}
  entry.grade = en.computed_current_score != null ? { score: en.computed_current_score, letter: en.computed_current_grade || null } : null
  hub.grades.current.push({ course: entry.code, courseKey: entry.key, score: entry.grade?.score ?? null, letter: entry.grade?.letter ?? null })
}
hub.schedule = Object.entries(COURSES).flatMap(([key, c]) => (c.meetings || []).map(m => ({ courseKey: key, course: c.code, color: c.color, ...m })))
hub.deadlines.sort((a, b) => new Date(a.due) - new Date(b.due))
hub.tests.sort((a, b) => a.date.localeCompare(b.date))
for (const c of hub.courses) c.nextDeadline = hub.deadlines.find(d => d.courseKey === c.key) || null
hub.grades.recent.sort((a, b) => new Date(b.gradedAt) - new Date(a.gradedAt))

// A page name free in a folder: "Lecture 1" for Lecture 1.pdf, "Lecture 1 (2)" when a different file already has that page.
// The line under a Quercus page's title: what it is, the module it sat in, and when it changed — unless what stands in
// for "when" is a hash of a forum or quiz that carries no date of its own.
// What a rewrite must carry over from the page as it stands: the class the brain gave it (`for:`), and any tag beyond the
// two the sync writes. Dropping `for:` sent a document back to the All tab every time its Quercus page changed.
function keepFor(old) { const m = /^for:\s*"?([^"\n]+)"?\s*$/m.exec(old); return m ? `\nfor: "${m[1].trim()}"` : '' }
function keepTags(old) { const m = /^tags:\s*\[([^\]]*)\]/m.exec(old); const extra = m ? m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(t => t && t !== 'quercus' && t !== 'page') : []; return JSON.stringify(['quercus', 'page', ...extra]) }
// The body as the sync wrote it, so the next run can tell its own words from the student's: everything after the frontmatter.
function bodyHashOf(text) { return hashOf(String(text).replace(/^---\n[\s\S]*?\n---\n/, '')) }
function quercusLine(meta, pg) { return `Quercus ${meta.label || 'page'} · ${meta.module}${/^\d{4}-\d{2}-\d{2}/.test(String(pg.updated_at || '')) ? ` · updated ${localIso(pg.updated_at)}` : ''}` }
// A module's discussion forum, quiz, hand-in or video, read into the shape of a Quercus page (SPEC §20.53): a first line of
// facts — due, opens, points, time limit — then the description as posted. → { url, title, body, updated_at, html_url } | null
async function moduleItemPage(cid, what, it, ctx = {}) {
  const when = iso => (iso ? `${localIso(iso)} ${new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Toronto' })}` : null)
  const facts = parts => { const p = parts.filter(Boolean); return p.length ? `<p>${p.map(x => `<strong>${x}</strong>`).join(' · ')}</p>` : '' }
  const hash = s => createHash('sha1').update(String(s)).digest('hex').slice(0, 12)
  if (what === 'video') {
    const url = it.external_url
    // MyMedia is downloadable after all — only the watch page is gated (SPEC §20.56). A MyMedia video becomes a page
    // of its own on the Videos shelf with the file *in* it, so it plays in slate; addVideo writes that and we make no
    // generic page for it. Anything else (YouTube, Zoom) is still only a link.
    if (isMyMedia(url) && ctx.nb) { await addVideo(ctx.course, ctx.nb, it.title, url, { module: ctx.module }); return null }
    return { url: `item-video-${hash(url)}`, title: it.title, body: `<p><a href="${url}">${it.title}</a></p><p>A video — open it in the browser.</p>`, updated_at: hash(url + it.title), html_url: url }
  }
  const id = it.content_id
  const d = what === 'discussion' ? await get(`/courses/${cid}/discussion_topics/${id}`) : what === 'quiz' ? await get(`/courses/${cid}/quizzes/${id}`) : await get(`/courses/${cid}/assignments/${id}`)
  if (!d || d.errors) return null
  const due = d.due_at || d.assignment?.due_at || null, points = d.points_possible ?? d.assignment?.points_possible ?? null, desc = d.message || d.description || ''
  const body = facts([due && `Due ${when(due)}`, !due && d.unlock_at && `Opens ${when(d.unlock_at)}`, !due && d.lock_at && `Locks ${when(d.lock_at)}`, points != null && `${points} points`, d.time_limit && `${d.time_limit} min`, d.question_count && `${d.question_count} question${d.question_count === 1 ? '' : 's'}`]) + desc
  return { url: `item-${what}-${id}`, title: d.title || d.name || it.title, body, updated_at: d.updated_at || hash(`${due}|${points}|${desc}`), html_url: d.html_url || it.html_url }
}
async function freeTitle(dir, title, name) {
  for (let i = 1; ; i++) {
    const t = i === 1 ? title : `${title} (${i})`
    const els = (await readJson(path.join(dir, `${t}.blocks.json`), null))?.elements || null
    if (!els && !(await exists(path.join(dir, `${t}.md`)))) return t
    if (name && els?.some(e => String(e.src || '').endsWith('/' + safeName(name)))) return t   // the same file again
  }
}

async function addFile(course, nb, section, title, fileId, name, url, size, opts = {}) {
  // A file not open yet — its module unlocks on a date or behind a prerequisite, or Canvas opens it a quarter of an hour
  // late — answers its metadata with an empty `url` (the quercus skill: ask the metadata, not /download). Nothing is
  // recorded, so the next run asks again; it used to download the API's root and report "download failed" every morning.
  if (!url) { log(`  not open yet, asked again next run: ${name}`); return }
  // With Claude as the brain a file waits in Hub/Inbox/<course>/ as a page of its own (SPEC §20.37): nothing here chooses its
  // week or its folder.
  const inbox = !!opts.inbox
  if (inbox) { title = await freeTitle(path.join(HUB, 'Inbox', course), title, name); opts = { ...opts, newPage: true } }
  const dir = inbox ? path.join(HUB, 'Inbox', course) : path.join(nb, section), assets = path.join(dir, `${title}.assets`)
  const rel = inbox ? `Hub/Inbox/${course}/${title}.md` : `${course}/${section}/${title}.md`
  const dst = path.join(assets, safeName(name))
  log(`  file: ${name} → ${inbox ? 'the inbox' : `${section}/${title}${opts.newPage ? '.md (new page)' : ''}`}`)
  const row = { course: COURSES[course].code, courseKey: course, name, page: rel, where: inbox ? 'Inbox' : section.split('/').slice(-2).join(' · '), module: opts.module || null }
  if (DRY) { hub.files.push(row); return }
  // Remembered once the bytes are here: a failed download used to be recorded as known first, and was never tried again.
  const bytes = await get(url, true); if (!bytes) { errors.push(`download failed, tried again next run: ${name}`); return }
  state.files[opts.stateKey || fileId] = { ...(inbox ? { name, courseKey: course, inbox: rel, module: opts.module || null, heading: opts.heading || null, from: opts.from || null, at: today } : { name, section, title, at: today }), ...(opts.updated ? { updated: opts.updated } : {}), ...(size != null ? { size } : {}) }
  hub.files.push(row)
  if (inbox) wait(opts.itemId || 'f-' + fileId, { kind: 'file', courseKey: course, title, page: rel, name, module: opts.module || null, heading: opts.heading || null, from: opts.from || null, posted: opts.posted || null, quercus: `${COURSES[course].url}/files/${fileId}`, ...(opts.note ? { note: opts.note } : {}) })
  await fs.mkdir(assets, { recursive: true }); await fs.writeFile(dst, bytes)
  const md = path.join(dir, `${title}.md`)
  if (!(await exists(md))) await write(md, `---\ncreated: "${stamp()}"\nkind: "${opts.kind || 'notes'}"\ntags: ["quercus"]\n---\n${opts.newPage ? `# ${title}\n\n_From Quercus${opts.module ? ` · ${opts.module}` : ''} · ${today}_\n` : ''}`)
  const sidecarPath = path.join(dir, `${title}.blocks.json`), sidecar = await readJson(sidecarPath, { version: 1, elements: [] })
  const ext = name.toLowerCase().split('.').pop()
  const type = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext) ? 'image' : ['mp4', 'mov', 'webm', 'm4a', 'mp3', 'wav'].includes(ext) ? 'media' : 'file'
  sidecar.elements.push({ id: newId(), type, src: `${title}.assets/${safeName(name)}`, size, ...(opts.card ? { display: 'card' } : {}) })
  await writeJson(sidecarPath, sidecar)
  const meta = await readJson(path.join(dir, '_slate.json'), { order: [] })
  if (!meta.order.includes(title)) { meta.order.push(title); await writeJson(path.join(dir, '_slate.json'), meta) }
}

// A MyMedia video as a page on the course's Videos shelf, with the mp4 inside it as a media element so slate plays
// it rather than linking out (SPEC §20.56). Skipped when the file is already there, so a re-run costs one HEAD-less
// check and no bytes. The download itself needs no UTORid — see scripts/lib/mymedia.mjs.
async function addVideo(course, nb, rawTitle, url, opts = {}) {
  const title = safeName(rawTitle.replace(/^[A-Z]+\s*•\s*/, '').replace(/:/g, '-'))
  const dir = path.join(nb, 'Videos'), assets = path.join(dir, `${title}.assets`)
  const name = `${title}.mp4`, dst = path.join(assets, name)
  // Keyed by the MyMedia id, not by this path: once a video is here it may be filed anywhere in the course — the
  // week's Videos shelf, General — and a path check would fetch a second copy on the next run.
  const vid = mymediaId(url)
  if (vid && state.videos[vid]) return
  if (await exists(dst)) { state.videos[vid] = { title, where: 'Videos', at: today }; return }
  if (DRY) { log(`  video: ${rawTitle} → Videos/${title} (would fetch)`); return }
  let got
  try { got = await fetchMyMedia(url, dst) }
  catch (e) { errors.push(`video download failed, tried again next run: ${rawTitle} — ${e.message}`); return }
  log(`  video: ${rawTitle} → Videos/${title} (${humanDuration(got.seconds)}, ${(got.bytes / 1e6).toFixed(1)} MB)`)
  if (vid) state.videos[vid] = { title, where: 'Videos', at: today }
  const md = path.join(dir, `${title}.md`)
  if (!(await exists(md))) await write(md, `---\ncreated: "${stamp()}"\nkind: "lecture"\ntags: ["quercus", "video"]\n---\n# ${title}\n\n_From MyMedia${opts.module ? ` · ${opts.module}` : ''} · ${today}_\n`)
  const sidecarPath = path.join(dir, `${title}.blocks.json`), sidecar = await readJson(sidecarPath, { version: 1, elements: [] })
  if (!sidecar.elements.some(e => e.type === 'media' && e.src === `${title}.assets/${path.basename(got.path)}`))
    sidecar.elements.push({ id: newId(), type: 'media', src: `${title}.assets/${path.basename(got.path)}`, size: got.bytes })
  await writeJson(sidecarPath, sidecar)
  const meta = await readJson(path.join(dir, '_slate.json'), { order: [] })
  if (!meta.order.includes(title)) { meta.order.push(title); await writeJson(path.join(dir, '_slate.json'), meta) }
  hub.files.push({ course: COURSES[course].code, courseKey: course, name, page: `${course}/Videos/${title}.md`, where: 'Videos', module: opts.module || null })
}

// ---- Hub pages ---------------------------------------------------------------------------------
const dl = d => `${d.confirmed === false ? short(new Date(d.due)) : fmtDate(d.due)} (${d.daysLeft === 0 ? 'today' : d.daysLeft === 1 ? 'tomorrow' : `in ${d.daysLeft} days`})`
// his own target (SPEC §21.12), beside the A-: Infinity is out of reach, 0 is already his
const targetLine = t => (!t ? '' : !Number.isFinite(t.need) ? ` · your ${t.pct}% is out of reach` : t.need <= 0 ? ` · your ${t.pct}% is locked in` : ` · need ${t.need.toFixed(0)} on the rest for your ${t.pct}%`)
const courseLine = c => `| ${c.code} | ${c.name} | ${c.meets} | ${c.week || '—'} | ${c.grade ? `${c.grade.score}%${c.grade.letter ? ' ' + c.grade.letter : ''}` : 'no grade yet'} | ${c.nextDeadline ? `${c.nextDeadline.title}, ${dl(c.nextDeadline)}` : '—'} |`
const overview = `---
kind: "summary"
---
# Academic hub

_Updated ${fmtDate(hub.updatedAt)} · synced from Quercus every morning. This page is rewritten each time; write your own notes elsewhere._

## Courses

| Course | Name | Meets | This week | Grade | Next deadline |
|---|---|---|---|---|---|
${hub.courses.map(courseLine).join('\n')}

## Next deadlines

${hub.deadlines.length ? hub.deadlines.slice(0, 8).map(d => `- **${d.course}** ${d.title} — ${dl(d)}${d.points ? ` · ${d.points} pts` : ''}`).join('\n') : '- Nothing due. Enjoy it.'}

## Next tests

${hub.tests.length ? hub.tests.slice(0, 6).map(t => `- **${t.course}** ${t.title} — ${t.date}`).join('\n') : '- No test dates known yet.'}

## Standing

${hub.courses.map(c => `- **${c.code}** — ${c.standing ? `${c.standing.grade.toFixed(1)}% (${c.standing.letter}) with ${c.standing.weightKnown}% of the course written · ${c.standing.scheme}` + (Number.isFinite(c.standing.need['A-']) ? ` · ${c.standing.need['A-'] <= 0 ? 'A- is locked in' : `need ${c.standing.need['A-'].toFixed(0)} on the rest for A-`}` : ' · A- no longer reachable') + targetLine(c.standing.target) + (Object.keys(c.fromMe || {}).length ? ' · counts marks you entered' : '') : 'nothing graded yet'}`).join('\n')}

## New since the last sync

${hub.news.length || hub.files.length || hub.grades.recent.length || hub.sheets.length || hub.pages.length ? [
  ...hub.news.map(n => `- **${n.course}** announcement: [[${n.page.split('/').pop().replace(/\.md$/, '')}]] (${localIso(n.at)})${n.weeks?.length ? ' · ' + n.weeks.join(', ') : ''}`),
  ...hub.files.map(f => `- **${f.course}** file: ${f.name} → ${f.where}`),
  ...hub.grades.recent.filter(g => g.isNew).map(g => `- **${g.course}** graded: ${g.item} — ${g.score}/${g.possible}`),
  ...hub.pages.map(p => `- **${p.course}** ${p.updated ? 'page updated' : 'new page'}: [[${p.title}]] → ${p.where}`),
  ...hub.sheets.map(s => `- **${s.course}** study sheet ready: [[${s.page.split('/').pop().replace(/\.md$/, '')}]] · ${s.week}`)].join('\n') : '- Nothing new.'}

See also [[Deadlines]], [[Tests]], [[Grades]].
`
const deadlines = `---
kind: "summary"
---
# Deadlines

_Updated ${fmtDate(hub.updatedAt).replace(/\.$/, '')}. Unsubmitted work with a due date, all courses, soonest first._

| When | Course | What | Points | Source | Link |
|---|---|---|---|---|---|
${hub.deadlines.length ? hub.deadlines.map(d => `| ${dl(d)} | ${d.course} | ${d.title} | ${d.points ?? ''} | ${d.source === 'syllabus' ? 'syllabus' : 'Quercus'} | ${d.url ? `[open](${d.url})` : ''} |`).join('\n') : '| — | — | Nothing due | | | |'}
`
const tests = `---
kind: "exam"
---
# Tests and exams

_Updated ${fmtDate(hub.updatedAt).replace(/\.$/, '')}. Syllabus dates plus anything Quercus calls a test, midterm or exam._

| Date | Course | What | Source |
|---|---|---|---|
${hub.tests.length ? hub.tests.map(t => `| ${t.date} | ${t.course} | ${t.title} | ${t.note} |`).join('\n') : '| — | — | No dates yet | |'}
`
const grades = `---
kind: "summary"
---
# Grades

_Updated ${fmtDate(hub.updatedAt).replace(/\.$/, '')}._

## Current standing

| Course | Current grade |
|---|---|
${hub.grades.current.map(g => `| ${g.course} | ${g.score != null ? `${g.score}%${g.letter ? ' ' + g.letter : ''}` : 'no grade yet'} |`).join('\n')}

## Recently graded

${hub.grades.recent.length ? hub.grades.recent.map(g => `- ${localIso(g.gradedAt)} **${g.course}** ${g.item}: ${g.score}/${g.possible}${g.isNew ? ' · new' : ''}`).join('\n') : '- Nothing graded yet.'}
`
await write(path.join(TODAY, 'Overview.md'), overview)
await write(path.join(TODAY, 'Deadlines.md'), deadlines)
await write(path.join(TODAY, 'Tests.md'), tests)
await write(path.join(TODAY, 'Grades.md'), grades)
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const schedule = `---
kind: "summary"
---
# Weekly schedule

_From the syllabi and announcements; the calendar lives in slate/scripts/lib/terms.mjs. Blank times are still to confirm._

| Day | Time | Course | What | Where |
|---|---|---|---|---|
${DAYS.flatMap(d => hub.schedule.filter(m => m.day === d).sort((a, b) => a.start.localeCompare(b.start)).map(m => `| ${d} | ${m.start ? `${m.start}–${m.end}` : 'tbc'} | ${m.course} | ${m.kind} | ${m.where || ''} |`)).join('\n')}
`
await write(path.join(TODAY, 'Schedule.md'), schedule)
await writeJson(path.join(TODAY, '_slate.json'), { order: ['Overview', 'Schedule', 'Next 7 days', 'Calendar', 'Deadlines', 'Tests', 'Grades'], label: 'Rewritten by the morning pass every day. Read, do not edit.' })
await writeJson(path.join(HUB, '_slate.json'), { order: ['Today', 'Review'], color: '#2f6bff', label: 'The academic hub: courses, deadlines, tests, grades, all courses at once. Shown as the Home screen. Review holds the Sunday reviews.' })
hub.sheets = Object.values(state.sheets).filter(x => !prevRun || (x.at || '') > prevRun)
// The inbox (SPEC §20.37). Read again before writing: brain.mjs may have decided on an item while this ran, and its status on
// disk wins; what this run found is added. What waits stays until Claude decides; a decided item leaves after thirty days.
state.lastRun = hub.updatedAt
// The hub goes with them, under the same lock. A page placed while this ran had its row followed in the _hub.json this
// replaces (scripts/lib/move.mjs followHub); the row this run wrote for it still names the inbox, and follows here.
await checkpoint(async () => {
  const waitingAt = new Set(Object.values(inbox.items).filter(it => (it?.status || 'waiting') === 'waiting').map(it => it.page))
  const moved = new Map(Object.values(inbox.items).filter(it => it?.to && it.page && it.status !== 'waiting' && String(it.decidedAt || '') >= hub.updatedAt && !waitingAt.has(it.page)).map(it => [it.page, it.to]))
  for (const k of ['files', 'news', 'pages', 'sheets']) hub[k] = hub[k].map(r => (moved.has(r?.page) ? { ...r, page: moved.get(r.page), ...(r.where !== undefined ? { where: whereOf(moved.get(r.page)) } : {}) } : r))
  await writeJson(path.join(HUB, '_hub.json'), hub)
})
const summary = { updatedAt: hub.updatedAt, courses: hub.courses.length, deadlines: hub.deadlines.length, tests: hub.tests.length, newAnnouncements: hub.news.length, newFiles: hub.files.length, newGrades: hub.grades.recent.filter(g => g.isNew).length, newSheets: hub.sheets.length, newPages: hub.pages.length, errors }
summary.brain = BRAIN
summary.waiting = Object.values(inbox.items).filter(i => (i?.status || 'waiting') === 'waiting').length
if (JSON_OUT) console.log(JSON.stringify(summary)); else log('\n' + JSON.stringify(summary, null, 2) + (DRY ? '\n(dry run, nothing written)' : ''))
