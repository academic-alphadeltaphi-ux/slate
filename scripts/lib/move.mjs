// Moving one page (SPEC §3, §20.37). A page is up to four things that share one name — `<name>.md`, `<name>.blocks.json`,
// `<name>.assets/` and a folder of subpages — so a move takes all four or none. Every destination is checked before the
// first rename, and a rename that fails part-way puts back what it had already moved: refile.mjs used to check one part at
// a time inside its loop and could leave a page half-moved. The records that name a page by its path follow it — both
// `_slate.json` orders, the hub's rows (SPEC §20.24) and the sync's memory of where it put each file and page, which is
// what lets a Quercus page that changes be rewritten where it lives now instead of where a rule first put it.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES } from './terms.mjs'
import { parsePage } from '../../server/format.js'
import { readJson, writeAtomic, patchFrontmatterRaw } from './problems.mjs'

export const PARTS = ['.md', '.blocks.json', '.assets', '']
// The kinds a page's frontmatter says it is, as the sync, Add files and the week pages write them.
export const KINDS = ['lecture', 'reading', 'problem-set', 'syllabus', 'admin', 'notes', 'exam', 'summary']
export const INBOX_PREFIX = 'Hub/Inbox/'
const relOf = (a, b) => path.relative(a, b).split(path.sep).join('/')   // the notebook's paths are written with /, on Windows too
const exists = p => fs.access(p).then(() => true, () => false)
const isDir = async p => (await fs.stat(p).catch(() => null))?.isDirectory() ?? false
const stem = rel => String(rel).replace(/\.md$/, '')
const json = v => JSON.stringify(v, null, 2) + '\n'

// 'ECO 206Y1/Fall 2026/Week 1 (Sep 7)/Lectures/Slides 1.md' → { courseKey: 'ECO 206Y1', section: 'Fall 2026/Week 1 (Sep 7)/Lectures', title: 'Slides 1' }
export function splitRel(rel) {
  const segs = stem(rel).split('/')
  return { courseKey: segs[0], section: segs.slice(1, -1).join('/'), title: segs[segs.length - 1] }
}
// Where the hub says a page is: 'Week 1 (Sep 7) · Lectures', 'General', or 'Inbox' for what nobody has placed yet.
export function whereOf(rel) {
  if (String(rel).startsWith(INBOX_PREFIX)) return 'Inbox'
  const segs = splitRel(rel).section.split('/').filter(Boolean)
  return (segs.length >= 2 && /^(Fall|Winter|Summer|Spring)\b/.test(segs[0]) ? segs.slice(1) : segs).join(' · ')
}

// movePage(root, fromRel, toRel) → [[from, to], …], the parts moved, relative to root. `recentMs` refuses a page whose text
// or layout changed that recently: it is probably open in the app, and moving it underneath the editor blanks the sheet and
// lets the next keystroke recreate it at the old path. `dry` checks everything and moves nothing.
export async function movePage(root, fromRel, toRel, { dry = false, recentMs = Number(process.env.SLATE_MOVE_RECENT_MS ?? 10_000) } = {}) {
  if (!/\.md$/.test(fromRel) || !/\.md$/.test(toRel)) throw new Error('a page path ends in .md')
  if (fromRel === toRel) throw new Error(`already there: ${toRel}`)
  const parts = []
  for (const s of PARTS) {
    const src = path.join(root, stem(fromRel) + s), dst = path.join(root, stem(toRel) + s)
    if (await exists(dst)) throw new Error(`something is already there: ${relOf(root, dst)}`)
    if (!(await exists(src)) || (s === '' && !(await isDir(src)))) continue
    parts.push([src, dst])
  }
  if (!parts.length || !parts[0][0].endsWith('.md')) throw new Error(`no such page: ${fromRel}`)
  if (recentMs > 0) for (const [src] of parts) {
    if (!/\.(md|blocks\.json)$/.test(src)) continue
    // A page under Hub/Inbox/ that carries no container of the student's own was written by the fetch, seconds before the
    // brain reads it; the guard is for pages someone may be typing on, and refusing every placement of a fresh inbox page
    // was what the light routine did on every morning (SPEC §21.5).
    const fetchOwn = /^Hub\/Inbox\//.test(fromRel) && !(await fs.readFile(src, 'utf8').catch(() => '')).includes('<!-- slate:block ')
    if (!fetchOwn && Date.now() - (await fs.stat(src)).mtimeMs < recentMs) throw new Error(`${relOf(root, src)} changed in the last ${Math.round(recentMs / 1000)} s, so it may be open in slate — try again in a moment`)
  }
  const moved = parts.map(([s, d]) => [relOf(root, s), relOf(root, d)])
  if (dry) return moved
  await fs.mkdir(path.dirname(path.join(root, toRel)), { recursive: true })
  const done = []
  try { for (const [s, d] of parts) { await fs.rename(s, d); done.push([s, d]) } }
  catch (e) { for (const [s, d] of done.reverse()) await fs.rename(d, s).catch(() => { }); throw e }
  // The page's assets folder is renamed with it, so every `src` inside still naming the old one now points at nothing:
  // a lecture's audio silently disappeared this way, and the page looked fine until something tried to play it. The
  // heading has the same problem, more visibly. Both follow the page, and a failure here rolls the renames back too.
  try { await followTitle(root, fromRel, toRel) }
  catch (e) { for (const [s, d] of done.reverse()) await fs.rename(d, s).catch(() => { }); throw e }
  return moved
}

// What inside a page names the page itself: `<Title>.assets/…` in every element's src, and the `# Title` heading when it
// still says what the page used to be called. Nothing else is touched — a heading the student rewrote stays his.
export async function followTitle(root, fromRel, toRel) {
  const from = splitRel(fromRel).title, to = splitRel(toRel).title
  if (from === to) return
  const dec = v => { try { return decodeURIComponent(v) } catch { return v } }
  const bf = path.join(root, stem(toRel) + '.blocks.json')
  const layout = await readJson(bf, null)
  if (layout?.elements?.length) {
    let hit = false
    for (const el of layout.elements) {
      if (typeof el.src !== 'string') continue
      const i = el.src.indexOf('/')
      if (i < 0) continue
      const seg = el.src.slice(0, i)
      if (dec(seg) !== `${from}.assets`) continue
      // In the form the page had it. The sync and the app write the folder raw and the client encodes each segment
      // on the way out (api.fileUrl), so writing it encoded here meant `%20` became `%2520` and every retitled
      // page's PDF answered 404 (SPEC §20.53); a `src` that was encoded stays encoded.
      el.src = `${seg === dec(seg) ? to : encodeURIComponent(to)}.assets${el.src.slice(i)}`
      hit = true
    }
    if (hit) await writeAtomic(bf, json(layout))
  }
  const mf = path.join(root, toRel)
  const md = await fs.readFile(mf, 'utf8').catch(() => null)
  if (md == null) return
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let next = md.replace(new RegExp(`^#\\s+${esc}\\s*$`, 'm'), `# ${to}`)
  // Markdown image and file links into the page's own folder follow too, raw and percent-encoded (`![](Old.assets/x.png)`).
  next = next.split(`${from}.assets/`).join(`${to}.assets/`).split(`${encodeURIComponent(from)}.assets/`).join(`${encodeURIComponent(to)}.assets/`)
  if (next !== md) await writeAtomic(mf, next)
}

// A folder's `order` in _slate.json loses `drop` and gains `add` (at index `at` when given, else last). → the index `drop`
// had, so an undo can put it back where it was.
export async function reorder(dir, drop, add, at = null) {
  const f = path.join(dir, '_slate.json')
  const meta = await readJson(f, {})
  const order = Array.isArray(meta.order) ? [...meta.order] : []
  const was = drop ? order.indexOf(drop) : -1
  if (was < 0 && !add) return was
  if (was >= 0) order.splice(was, 1)
  if (add && !order.includes(add)) { if (Number.isInteger(at) && at >= 0 && at <= order.length) order.splice(at, 0, add); else order.push(add) }
  if (!order.length && !Object.keys(meta).length) return was
  await writeAtomic(f, json({ ...meta, order }))
  return was
}

// The hub's rows that name a moved page point at where it is now (SPEC §20.24): "New since the last check" links straight to
// them, and a stale one opened a blank sheet. → how many rows followed.
export async function followHub(root, moves) {
  const f = path.join(root, 'Hub', '_hub.json')
  const hub = await readJson(f, null); if (!hub) return 0
  const by = new Map(moves.map(m => [m.from, m.to]))
  let n = 0
  const follow = row => {
    const to = row?.page && by.get(row.page); if (!to) return row
    n++
    return { ...row, page: to, ...(row.where !== undefined ? { where: whereOf(to) } : {}) }
  }
  for (const key of ['files', 'news', 'pages', 'sheets']) if (Array.isArray(hub[key])) hub[key] = hub[key].map(follow)
  if (n) await writeAtomic(f, json(hub))
  return n
}

// The sync's memory (`files`, `pages` in Hub/_sync-state.json) follows a move, so a Quercus page that changes is rewritten
// where it lives now. An entry the fetch left in the inbox is found by its `inbox` path; an older one by section and title
// (a page's key carries its course id; a file entry from before SPEC §20.37 carries no course, so the same section and title
// in two notebooks is ambiguous and neither is touched). → [{ bag, key, before }] for an exact undo.
export async function followSyncState(root, moves) {
  const f = path.join(root, 'Hub', '_sync-state.json')
  const st = await readJson(f, null)
  const changed = []
  if (!st) return changed
  for (const { from, to } of moves) {
    const a = splitRel(from), b = splitRel(to), cid = String(COURSES[a.courseKey]?.id ?? '')
    for (const bag of ['files', 'pages']) {
      const entries = Object.entries(st[bag] || {}).filter(([, v]) => v && typeof v === 'object')
      const hits = entries.filter(([k, v]) => (v.inbox ? v.inbox === from
        : v.title === a.title && v.section === a.section && (v.courseKey ? v.courseKey === a.courseKey : bag === 'pages' ? k.startsWith(cid + ':') : true)))
      const loose = hits.filter(([, v]) => !v.courseKey && !v.inbox).length
      for (const [k, v] of hits) {
        if (bag === 'files' && !v.courseKey && !v.inbox && loose > 1) continue
        changed.push({ bag, key: k, before: v })
        if (to.startsWith(INBOX_PREFIX)) { st[bag][k] = { ...v, inbox: to }; continue }
        const { inbox, ...rest } = v
        st[bag][k] = { ...rest, courseKey: b.courseKey, section: b.section, title: b.title }
      }
    }
  }
  if (changed.length) await writeAtomic(f, json(st))
  return changed
}
export async function restoreSyncState(root, changed) {
  if (!changed?.length) return 0
  const f = path.join(root, 'Hub', '_sync-state.json')
  const st = await readJson(f, null); if (!st) return 0
  for (const c of changed) { st[c.bag] ||= {}; st[c.bag][c.key] = c.before }
  await writeAtomic(f, json(st))
  return changed.length
}

// Which class in the week a document belongs to (SPEC §20.38): the lecture, the tutorial, or both when it serves the week —
// a study sheet, the week's own reading. Frontmatter `for`.
export const WHICH_CLASS = ['lecture', 'tutorial', 'both']

// setField(root, rel, key, value) → the value it had (null when none). Only the frontmatter is rewritten; the body keeps its
// bytes. `null` removes the key.
export async function setField(root, rel, key, value) {
  const file = path.join(root, rel)
  const text = await fs.readFile(file, 'utf8')
  const page = parsePage(text)
  const before = typeof page.frontmatter?.[key] === 'string' ? page.frontmatter[key] : null
  if (before === value) return before
  const body = page.frontmatterRaw ? text.slice(page.frontmatterRaw.length) : text
  await writeAtomic(file, patchFrontmatterRaw(page.frontmatterRaw, { [key]: value }) + body)
  return before
}
export const setKind = (root, rel, kind) => setField(root, rel, 'kind', kind)
export const setPart = (root, rel, part) => setField(root, rel, 'for', part)
