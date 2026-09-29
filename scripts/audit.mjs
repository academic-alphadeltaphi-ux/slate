#!/usr/bin/env node
// Quercus ↔ slate, reconciled (SPEC §20.53). Read-only. Every item the Quercus API exposes for each course in terms.mjs, in
// every place the morning fetch (quercus-sync.mjs) looks — module items of every type, every page it reaches (module, front
// page, linked from a page, the syllabus, an announcement or a module item, the Pages index), the syllabus body and its text,
// announcements and their attachments, hand-ins, quizzes and forums in a module or not with their descriptions and
// attachments, another course's file linked by id, a video uploaded into a page, MyMedia videos, embeds, the files tab —
// matched to where slate holds it: the notebooks, Hub/_sync-state.json, Hub/_inbox.json, Hub/_hub.json and Claude's tasks.
// Writes one Markdown report with a table per kind and the flags at the end.
//   node scripts/audit.mjs [--root <notes root>] [--out <folder>] [--json]
// The key is found the way every script finds it (lib/quercus-auth.mjs: the environment, the keychain or the Windows file,
// then the Claude desktop config). Flags: NOT IN SLATE, PAGE MISSING, STALE RECORD, LOCKED, EMBED NOT ON PAGE,
// WAITING, LINK NOT LISTED, VIDEO NO PAGE, ITEM NO PAGE, NO TASK, DUE MISMATCH, DISCUSSION NO TASK, TASK LINK MISSING,
// TASK SOURCE MISSING, LOOSE IN WEEK, NO KIND, NO CLASS.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { COURSES, weeks } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { requireQuercusAuth } from './lib/quercus-auth.mjs'
import { safeName as platformSafeName } from './lib/platform.mjs'
import { isMyMedia, mymediaId, mymediaIn } from './lib/mymedia.mjs'
guardFlags(['--root', '--out', '--json'], 'node scripts/audit.mjs [--root <notes root>] [--out <folder>] [--json]')
const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
const JSON_OUT = argv.includes('--json')
const ROOT = notesRoot(process.argv)
// Reports go beside the notes unless the audit folder of the original install exists on this Mac. os.homedir(), not
// $HOME: Windows has no HOME, and path.join(undefined, …) threw before the audit began on a PC.
const OUT_DIR = opt('--out') || [path.join(os.homedir(), 'Desktop', 'Claude OS', 'Slate audit')].find(p => fs.existsSync(p)) || path.join(ROOT, 'Hub', 'Audit')
const OUT = path.join(OUT_DIR, `${new Date().toLocaleDateString('en-CA')} Quercus audit.md`)
const { token, api: base } = requireQuercusAuth()
async function get(p, { list = true } = {}) {
  const out = []; let url = base + p + (p.includes('?') ? '&' : '?') + 'per_page=100'
  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    if (!r.ok) return { error: r.status }
    const j = await r.json(); if (!list) return j
    out.push(...(Array.isArray(j) ? j : [j]))
    const m = /<([^>]+)>; rel="next"/.exec(r.headers.get('link') || ''); url = m ? m[1] : null
  }
  return out
}
const rj = (rel, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) } catch { return d } }
const state = rj('Hub/_sync-state.json', {}), inbox = rj('Hub/_inbox.json', { items: {} }), hub = rj('Hub/_hub.json', {}), brain = rj('Hub/_brain.json', { tasks: {}, decisions: [] })
const exists = rel => fs.existsSync(path.join(ROOT, rel))
const FILE_RE = /\/courses\/(\d+)\/files\/(\d+)/g
// a video uploaded through the page editor is an <iframe> on /media_attachments_iframe/<file id> (quercus-sync MEDIA_RE)
const MEDIA_RE = /\/media_attachments_iframe\/(\d+)/g
const ids = html => [...String(html || '').matchAll(FILE_RE)].map(m => m[2]).concat([...String(html || '').matchAll(MEDIA_RE)].map(m => m[1]))
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
// the words of an HTML body: never more characters than quercus-sync's htmlToMd keeps of it, so a syllabus the fetch left
// under its 200 is never asked for here
const plain = html => decode(String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
const hashOf = s => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)   // quercus-sync's, for the syllabus text's `updated`
// the players and forms a body embeds: the fetch keeps each as a link on its page (quercus-sync htmlToMd), src decoded as it writes it
const embeds = html => [...String(html || '').matchAll(/<iframe\b([^>]*)>[\s\S]*?<\/iframe>/gi)].map(m => /\bsrc="([^"]+)"/i.exec(m[1])?.[1]).filter(Boolean).map(decode)
const local = iso => iso ? new Date(iso).toLocaleDateString('en-CA') : null
const localTime = iso => iso ? new Date(iso).toTimeString().slice(0, 5) : null
const where = rel => { if (!rel) return '—'; if (rel.startsWith('Hub/Inbox/Ignored/')) return 'Ignored'; if (rel.startsWith('Hub/Inbox/')) return 'Inbox · waiting'; const segs = rel.split('/').slice(1, -1); const wk = /^Week (\d+)/.exec(segs[1] || ''); return wk ? `Week ${wk[1]}${segs[2] ? ' · ' + segs.slice(2).join('/') : ' (root)'}` : segs.join('/') || 'notebook root' }
const safeName = n => platformSafeName(n)   // the same cleaner quercus-sync wrote the names with — on Windows they differed
const allPages = new Map()   // courseKey → [rel]
const pagesOf = k => { if (!allPages.has(k)) allPages.set(k, exists(k) ? walk(path.join(ROOT, k)) : []); return allPages.get(k) }
const byTitle = (k, title) => { const want = new Set([safeName(title), safeName(String(title).replace(/^\d+:\s*/, '')), String(title)].map(x => x.toLowerCase())); return pagesOf(k).find(r => want.has(path.basename(r, '.md').toLowerCase())) || null }
const assetsOf = (k, acc = []) => { const w = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (/\.assets\//.test(p.split(path.sep).join('/'))) acc.push(path.relative(ROOT, p).split(path.sep).join('/')) } }; if (exists(k)) w(path.join(ROOT, k)); return acc }
// a page holding the file itself, where the fetch looks before it downloads (quercus-sync `have`): the notebook and the inbox,
// by name either way it is written, and by size too when the record kept one — a name alone is not a document
const byAsset = (k, name, size = null) => { const want = new Set([String(name), safeName(name)].map(x => x.toLowerCase())); return [k, `Hub/Inbox/${k}`, `Hub/Inbox/Ignored/${k}`].flatMap(d => assetsOf(d)).filter(a => want.has(path.basename(a).toLowerCase()) && (size == null || fs.statSync(path.join(ROOT, a)).size === size)).map(a => a.replace(/\.assets\/.*$/, '.md')).find(exists) || null }
const walk = (dir, acc = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name.endsWith('.assets')) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, acc); else if (e.name.endsWith('.md')) acc.push(path.relative(ROOT, p).split(path.sep).join('/')) } return acc }
const front = rel => { const t = fs.readFileSync(path.join(ROOT, rel), 'utf8'); const m = /^---\n([\s\S]*?)\n---/.exec(t); const f = {}; if (m) for (const l of m[1].split('\n')) { const k = /^(\w+):\s*"?([^"\n]*)"?/.exec(l); if (k) f[k[1]] = k[2] } return f }
const tasks = Object.values(brain.tasks).filter(t => !t.withdrawn)
const linkedAnn = new Set(brain.decisions.filter(d => d.type === 'link' && !d.undone).map(d => d.summary.split(' → ')[0]))
const R = [], flags = []
const line = s => R.push(s)
const flag = (course, kind, text) => { flags.push({ course, kind, text }); return `**${kind}**` }
line(`# Quercus ↔ slate audit · ${new Date().toLocaleDateString('en-CA')} ${new Date().toTimeString().slice(0, 5)} Toronto\n`)
line(`Every item the Quercus API exposes for each course, matched to where slate holds it. Flags are collected at the end.\n`)
const inboxStatus = id => inbox.items[id]?.status || null
const VIDEO_RE = /https?:\/\/(?:play\.library\.utoronto\.ca|mymedia\.library\.utoronto\.ca|(?:www\.)?youtube\.com|youtu\.be|vimeo\.com|[\w.-]*zoom\.us\/rec)\S*/i
// where the page the fetch wrote for a module item lives (SPEC §20.53), by its state key; null when the fetch has not written one
const itemPage = (courseKey, cid, key) => { const st = state.pages?.[`${cid}:${key}`]; if (!st) return null; const rel = st.inbox || (st.section != null ? `${st.courseKey || courseKey}/${st.section}/${safeName(st.title)}.md` : null); return rel && exists(rel) ? rel : (st.title && byTitle(courseKey, st.title)) || null }
// the fetch keys a video's page by a hash of its URL (quercus-sync moduleItemPage), so a retitled page is still found
const videoPage = (courseKey, cid, url) => itemPage(courseKey, cid, `item-video-${createHash('sha1').update(String(url)).digest('hex').slice(0, 12)}`)
for (const [courseKey, c] of Object.entries(COURSES)) {
  const cid = c.id
  line(`\n## ${c.code} · ${c.name} (${cid})\n`)
  const [mods, anns, discs, asg, quizzes, course, filesTab, index] = await Promise.all([
    get(`/courses/${cid}/modules?include[]=items`), get(`/courses/${cid}/discussion_topics?only_announcements=true`), get(`/courses/${cid}/discussion_topics`),
    get(`/courses/${cid}/assignments?include[]=submission`), get(`/courses/${cid}/quizzes`), get(`/courses/${cid}?include[]=syllabus_body`, { list: false }), get(`/courses/${cid}/files`), get(`/courses/${cid}/pages`)])
  const fp = await get(`/courses/${cid}/front_page`, { list: false })
  // Canvas leaves `items` out of a module with more than it will inline: the fetch asks for them on their own, and so does this
  for (const m of Array.isArray(mods) ? mods : []) if (!Array.isArray(m.items)) { const its = await get(`/courses/${cid}/modules/${m.id}/items`); m.items = Array.isArray(its) ? its : [] }
  const asgs = Array.isArray(asg) ? asg : [], qzs = Array.isArray(quizzes) ? quizzes : [], dscs = Array.isArray(discs) ? discs : []
  // --- files: every place the fetch looks for one. A link into another course's files counts: the fetch asks for it by id.
  const files = new Map()   // id → { name, size, sources:[] }
  const addF = (id, name, src, size) => { const f = files.get(String(id)) || { name: null, sources: [] }; if (name && !f.name) f.name = name; if (size != null) f.size ??= size; f.sources.push(src); files.set(String(id), f) }
  const noteF = (html, src) => { for (const id of ids(html)) addF(id, null, src) }
  // --- pages, reached the ways the fetch reaches them: module Page items, the front page, a module's External URL, and the
  // links of the syllabus, the announcements, the module items' descriptions and every page read, then the Pages index where
  // a course leaves it on. A Map: a page linked from a page the walk reads is walked too.
  const pages = new Map()   // slug → { slug, title, module, body, updated, front, item, locked }
  const notePages = (html, module) => { for (const m of String(html || '').matchAll(new RegExp(`/courses/${cid}/(?:pages|wiki)/([a-z0-9._~%-]+)`, 'gi'))) if (!pages.has(m[1])) pages.set(m[1], { slug: m[1], module }) }
  // --- MyMedia videos: a module's link to one, or one a page, the syllabus, an announcement or a description embeds or links
  // (lib/mymedia.mjs mymediaIn, the fetch's own reader)
  const videos = new Map()   // MyMedia id → { url, where }
  const noteVideos = (html, where) => { for (const v of mymediaIn(html)) if (!videos.has(v.id)) videos.set(v.id, { url: v.url, where }) }
  const inModule = new Set()   // the Assignment, Quiz and Discussion items a module lists: only those get a page of their own
  const links = []
  for (const m of Array.isArray(mods) ? mods : []) for (const it of m.items || []) {
    if (it.type === 'Assignment' || it.type === 'Quiz' || it.type === 'Discussion') inModule.add(`${it.type}:${it.content_id}`)
    if (it.type === 'File') addF(it.content_id, it.title, `module “${m.name}”`)
    else if (it.type === 'Page') pages.set(it.page_url, { slug: it.page_url, title: it.title, module: m.name })
    else if (it.type === 'ExternalUrl' || it.type === 'ExternalTool') links.push({ title: it.title, url: it.external_url || it.html_url, module: m.name })
    // an External URL that is a Quercus file's or page's own address is that file or page; one to MyMedia is that video
    if (it.type === 'ExternalUrl') { noteF(it.external_url, `module link “${it.title}”`); notePages(it.external_url, m.name); noteVideos(it.external_url, `module “${m.name}”`) }
  }
  // the front page is the fetch's even when a module lists it too: kept as General/Home (below)
  if (fp && !fp.error && fp.url) pages.set(fp.url, { slug: fp.url, title: fp.title, module: 'front page', body: fp.body || '', updated: fp.updated_at, front: true })
  const syl = course?.syllabus_body || ''
  noteF(syl, 'syllabus body'); notePages(syl, 'syllabus'); noteVideos(syl, 'syllabus')
  // the Syllabus tab's own text is a page once it holds 200 characters (quercus-sync), its `updated` a hash of the body
  if (state.pages?.[`${cid}:item-syllabus`] || plain(syl).length >= 200) pages.set('item-syllabus', { slug: 'item-syllabus', title: 'Syllabus on Quercus', module: 'Syllabus tab', body: syl, updated: hashOf(syl), item: true })
  for (const a of Array.isArray(anns) ? anns : []) { noteF(a.message, `announcement “${a.title}”`); notePages(a.message, 'announcement'); noteVideos(a.message, `announcement “${a.title}”`); for (const at of a.attachments || []) addF(at.id, at.display_name, `attachment of “${a.title}”`, at.size) }
  // hand-ins, quizzes and forums, in a module or not: the files, videos and pages their descriptions link, a forum's
  // attachments — the fetch reads every one of them before its page walk (quercus-sync.mjs, since 2026-09-29)
  for (const [type, list] of [['Assignment', asgs], ['Quiz', qzs], ['Discussion', dscs]]) for (const x of list) {
    const text = x.description ?? x.message, src = `${type.toLowerCase()} “${x.name || x.title}”`
    noteF(text, src); noteVideos(text, src); notePages(text, inModule.has(`${type}:${x.id}`) ? 'module item' : type.toLowerCase())
    for (const at of x.attachments || []) addF(at.id, at.display_name, `attachment of forum “${x.title}”`, at.size)
  }
  for (const p of Array.isArray(index) ? index : []) if (p?.url && !pages.has(p.url)) pages.set(p.url, { slug: p.url, title: p.title, module: 'pages' })
  // the walk: a page that will not open (locked, gone) or has no body is one the fetch skips too
  for (const p of pages.values()) {
    if (!p.front && !p.item) { const pg = await get(`/courses/${cid}/pages/${p.slug}`, { list: false }); p.title = pg?.title || p.title || p.slug; p.body = pg?.body || ''; p.updated = pg?.updated_at; p.locked = pg?.error || (!pg?.body && pg?.locked_for_user ? 'locked' : null) }
    noteF(p.body, `page “${p.title}”`); notePages(p.body, p.module); noteVideos(p.body, `page “${p.title}”`)
  }
  if (Array.isArray(filesTab)) for (const f of filesTab) addF(f.id, f.display_name, 'files tab', f.size)
  // A file slate has no record of is asked about: its name, and whether it is open — an empty `url` is a file whose module has
  // not opened yet, which the fetch asks for again every run and records nothing of: LOCKED, not missing. `/files/<id>` answers
  // for another course's file too.
  for (const [id, f] of files) if (!f.name || !state.files?.[id]) { const meta = await get(`/files/${id}`, { list: false }); f.name = meta?.display_name || f.name || `(file ${id}${meta?.error ? ', ' + meta.error : ''})`; f.size ??= meta?.size; f.locked = !!meta && !meta.error && !meta.url }
  // --- reconcile files
  line(`### Files (${files.size})\n\n| Quercus file | seen in | slate | status |\n|---|---|---|---|`)
  for (const [id, f] of [...files].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const st = state.files?.[id]
    let rel = st ? (st.inbox || (st.section != null ? `${st.courseKey || courseKey}/${st.section}/${safeName(st.title)}.md` : null)) : null
    let on = rel && exists(rel), moved = null
    // one the fetch took for already here (`seeded`) is matched as it was: by name, and by the size the record kept
    if (st && !on) { const found = (st.title && byTitle(courseKey, st.title)) || byAsset(courseKey, st.name || f.name, st.seeded ? st.size : null); if (found) { moved = rel; rel = found; on = true } }
    let status = ''
    if (st?.decoration) status = 'decoration (banner), skipped on purpose'
    else if (!st && f.locked) status = flag(c.code, 'LOCKED', `file ${id} “${f.name}” (${f.sources[0]}) is not open yet: the fetch asks again every run`)
    else if (!st) status = flag(c.code, 'NOT IN SLATE', `file ${id} “${f.name}” (${f.sources[0]})`)
    else if (!on) status = flag(c.code, 'PAGE MISSING', `file ${id} “${f.name}” recorded at ${rel || 'no path (seeded)'} but no page holds it`)
    else if (moved) status = flag(c.code, 'STALE RECORD', `file ${id} “${f.name}” is at ${rel} but the sync's memory says ${moved}`)
    else if (rel.startsWith('Hub/Inbox/Ignored/')) status = 'ignored'
    else if (rel.startsWith('Hub/Inbox/')) status = flag(c.code, 'WAITING', `file ${id} “${f.name}” waits in the inbox`)
    else status = 'filed'
    line(`| ${f.name} | ${[...new Set(f.sources)].join('; ')} | ${rel ? `${where(rel)} · ${path.basename(rel, '.md')}` : '—'} | ${status} |`)
  }
  // --- pages
  line(`\n### Pages (${pages.size})\n\n| Quercus page | module | slate | status |\n|---|---|---|---|`)
  for (const p of pages.values()) {
    const st = state.pages?.[`${cid}:${p.slug}`]
    let rel = st ? (st.inbox || (st.section != null ? `${st.courseKey || courseKey}/${st.section}/${safeName(st.title)}.md` : null)) : null
    // the front page is written as General/Home, and its record keeps the Quercus title (quercus-sync)
    if (p.front && st && !st.inbox && exists(`${courseKey}/General/Home.md`)) rel = `${courseKey}/General/Home.md`
    let on = rel && exists(rel), moved = null
    if (st && !on) { const found = byTitle(courseKey, st.title) || byTitle(courseKey, p.title); if (found) { moved = rel; rel = found; on = true } }
    let status = ''
    if (p.locked) status = 'locked on Quercus'
    else if (!p.body) status = 'empty on Quercus: nothing to keep'
    else if (!st) status = flag(c.code, 'NOT IN SLATE', `page “${p.title}” (${p.module})`)
    else if (!on) status = flag(c.code, 'PAGE MISSING', `page “${p.title}” recorded at ${rel} but no page there`)
    else if (moved && st.courseKey) status = flag(c.code, 'STALE RECORD', `page “${p.title}” is at ${rel} but the sync's memory says ${moved}`)
    else if (rel.startsWith('Hub/Inbox/')) status = flag(c.code, 'WAITING', `page “${p.title}” waits in the inbox`)
    // a date says which is newer; the syllabus text's `updated` is a hash, which only says whether it changed
    else if (st.updated && p.updated && (/^\d{4}-/.test(p.updated) ? st.updated < p.updated : st.updated !== p.updated)) status = flag(c.code, 'STALE', `page “${p.title}” changed on Quercus ${p.updated} after slate's copy ${st.updated}`)
    else {
      // an embedded player or form is a link on the page; a page written before the fetch kept them has none until Quercus changes it
      const md = fs.readFileSync(path.join(ROOT, rel), 'utf8'), gone = embeds(p.body).filter(s => !md.includes(s))
      status = gone.length ? flag(c.code, 'EMBED NOT ON PAGE', `page “${p.title}” at ${rel} lacks ${gone.join(', ')}`) : 'filed'
    }
    line(`| ${p.title} | ${p.module} | ${rel ? `${where(rel)} · ${path.basename(rel, '.md')}` : '—'} | ${status} |`)
  }
  // --- links
  const linksMd = exists(`${courseKey}/General/Links.md`) ? fs.readFileSync(path.join(ROOT, `${courseKey}/General/Links.md`), 'utf8') : ''
  line(`\n### External links (${links.length})\n\n| Quercus link | module | on the Links page | video page |\n|---|---|---|---|`)
  for (const l of links) {
    const vid = VIDEO_RE.test(l.url) ? videoPage(courseKey, cid, l.url) : null
    // a MyMedia video is downloaded into a page of its own, not given a link page: the MyMedia table below
    line(`| ${l.title} | ${l.module} | ${linksMd.includes(l.url) ? 'yes' : flag(c.code, 'LINK NOT LISTED', `“${l.title}” ${l.url}`)} | ${isMyMedia(l.url) ? 'MyMedia (below)' : VIDEO_RE.test(l.url) ? (vid ? `${where(vid)} · ${path.basename(vid, '.md')}` : flag(c.code, 'VIDEO NO PAGE', l.title)) : '—'} |`)
  }
  // --- MyMedia videos: each in a page of its own with the file in it, remembered by its MyMedia id (quercus-sync addVideo)
  line(`\n### MyMedia videos (${videos.size})\n\n| video | seen in | slate | status |\n|---|---|---|---|`)
  for (const [vid, v] of videos) {
    const sv = state.videos?.[vid]
    // written in the Videos folder of the course whose run found it first; placed since, found by its title or its file
    const rel = sv ? Object.keys(COURSES).sort((a, b) => (b === courseKey) - (a === courseKey)).map(k => `${k}/${sv.where || 'Videos'}/${sv.title}.md`).find(exists) || byTitle(courseKey, sv.title) || byAsset(courseKey, `${sv.title}.mp4`) || byAsset(courseKey, `${sv.title}.ts`) : null
    const status = !sv ? flag(c.code, 'NOT IN SLATE', `MyMedia video ${vid} (${v.where}) ${v.url}`) : !rel ? flag(c.code, 'PAGE MISSING', `MyMedia video “${sv.title}” (${vid}) recorded but no page holds it`) : 'filed'
    line(`| ${sv?.title || v.url} | ${v.where} | ${rel ? `${where(rel)} · ${path.basename(rel, '.md')}` : '—'} | ${status} |`)
  }
  // --- assignments, quizzes, discussions
  line(`\n### Assignments (${asgs.length}) · quizzes (${Array.isArray(quizzes) ? quizzes.length : quizzes?.error}) · discussions (${Array.isArray(discs) ? discs.length : discs?.error})\n\n| Quercus | due (Toronto) | hub deadline | Claude's task | page in slate | status |\n|---|---|---|---|---|---|`)
  const horizon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)
  // A graded quiz or forum IS an assignment on Canvas: a task that opens the quiz or the forum is that assignment's task (the
  // light prompt links "the waiting quiz's page"), and it counted for nothing — the flag came back each morning (walk 2).
  const addr = u => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  const asAssignment = id => [...qzs.filter(q => String(q.assignment_id) === String(id)), ...dscs.filter(x => String(x.assignment?.id) === String(id))].map(x => addr(x.html_url))
  for (const a of asgs) {
    const urls = [addr(a.html_url), ...asAssignment(a.id)]
    const due = local(a.due_at), t = tasks.find(t => urls.includes(addr(t.link))), d = (hub.deadlines || []).find(x => x.url === a.html_url)
    let status = []
    if (!a.published) status.push('unpublished')
    if (due && due >= '2026-09-16' && due <= horizon && !t) status.push(flag(c.code, 'NO TASK', `assignment “${a.name}” due ${due} has no task — ${a.html_url}`))
    if (t && due && t.due !== due) status.push(flag(c.code, 'DUE MISMATCH', `task ${t.id} says ${t.due}, Quercus says ${due} for “${a.name}”`))
    if (a.submission?.workflow_state === 'submitted' || a.submission?.workflow_state === 'graded') status.push(`submitted (${a.submission.workflow_state})`)
    const pg = itemPage(courseKey, cid, `item-assignment-${a.id}`) || (a.quiz_id ? itemPage(courseKey, cid, `item-quiz-${a.quiz_id}`) : null)
    const listed = inModule.has(`Assignment:${a.id}`) || (a.quiz_id && inModule.has(`Quiz:${a.quiz_id}`))
    if (!pg && a.published && listed) status.push(flag(c.code, 'ITEM NO PAGE', `assignment “${a.name}”`))
    else if (!pg && !listed) status.push('not in a module')
    line(`| ${a.name}${a.is_quiz_assignment ? ' (quiz)' : ''} | ${due ? `${due} ${localTime(a.due_at)}` : '—'} | ${d ? 'yes' : '—'} | ${t ? `${t.id} · ${t.what}` : '—'} | ${pg ? `${where(pg)} · ${path.basename(pg, '.md')}` : '—'} | ${status.join(', ') || 'ok'} |`)
  }
  // A quiz or forum a module lists has a page of its own (quercus-sync moduleItemPage); one in no module is read for the files
  // and videos its description links, and has none. A practice quiz is not an assignment by nature.
  for (const q of qzs) if (!asgs.some(a => a.quiz_id === q.id)) {
    const qpg = itemPage(courseKey, cid, `item-quiz-${q.id}`), listed = inModule.has(`Quiz:${q.id}`)
    const status = [!qpg && listed && q.published !== false ? flag(c.code, 'ITEM NO PAGE', `quiz “${q.title}”`) : !qpg && !listed ? 'not in a module' : '', q.quiz_type === 'practice_quiz' ? 'practice' : q.published ? flag(c.code, 'QUIZ NOT AN ASSIGNMENT', q.title) : 'unpublished'].filter(Boolean)
    line(`| quiz “${q.title}” | ${q.due_at ? local(q.due_at) : '—'} | — | — | ${qpg || '—'} | ${status.join(', ')} |`)
  }
  // A forum is work to do when a mark or a date hangs on it (graded, or "post by Friday"); an open Q&A board is not, and asking
  // a task of it raised a flag no morning could clear. The task may open the forum on Quercus, in any spelling of its address,
  // or its page in the notebook — and the flag names the address, which neither the sweep nor the report used to print.
  const bare = u => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  for (const dsc of dscs) {
    const dpg = itemPage(courseKey, cid, `item-discussion-${dsc.id}`)
    const t = tasks.find(t => bare(t.link) === bare(dsc.html_url) || (dpg && (t.link === dpg || t.source === dpg)))
    const due = local(dsc.assignment?.due_at) || (dsc.lock_at ? `locks ${local(dsc.lock_at)}` : '—'), work = !!dsc.assignment || !!dsc.lock_at
    line(`| discussion “${dsc.title}” | ${due} | ${dsc.assignment ? 'graded' : 'ungraded'} | ${t ? `${t.id} · ${t.what}` : '—'} | ${dpg ? `${where(dpg)} · ${path.basename(dpg, '.md')}` : !inModule.has(`Discussion:${dsc.id}`) ? 'not in a module' : dsc.published === false ? '—' : flag(c.code, 'ITEM NO PAGE', `discussion “${dsc.title}”`)} | ${t ? 'ok' : dsc.published === false ? 'unpublished' : !work ? 'no mark, no date: no task needed' : flag(c.code, 'DISCUSSION NO TASK', `“${dsc.title}” ${dsc.html_url}`)} |`)
  }
  // --- announcements
  const annPages = exists(`${courseKey}/Announcements/Announcements`) ? fs.readdirSync(path.join(ROOT, `${courseKey}/Announcements/Announcements`)).filter(f => f.endsWith('.md')) : []
  line(`\n### Announcements (${Array.isArray(anns) ? anns.length : anns?.error})\n\n| posted | title | page | attachments | inbox | linked to weeks |\n|---|---|---|---|---|---|`)
  for (const a of (Array.isArray(anns) ? anns : []).sort((x, y) => String(x.posted_at).localeCompare(String(y.posted_at)))) {
    const day = local(a.posted_at), st = state.announcements?.[a.id]
    const page = annPages.find(f => f.startsWith(day + ' ') && f.slice(11, 31).toLowerCase() === String(a.title).replace(/[/:\x00]/g, '-').replace(/\s+/g, ' ').slice(0, 20).toLowerCase()) || annPages.find(f => f.startsWith(day + ' '))
    // an attachment with an empty `url` is not open yet: LOCKED in the files above, not missing
    const att = (a.attachments || []).map(x => `${x.display_name}${state.files?.[x.id] ? ' ✓' : x.url === '' ? ' (not open yet)' : ' ' + flag(c.code, 'ATTACHMENT NOT IN SLATE', `${x.display_name} on “${a.title}”`)}`).join(', ') || '—'
    const ib = inboxStatus('a-' + a.id) || (st?.seeded ? 'before the brain' : '—')
    const linked = page ? (linkedAnn.has(page.replace(/\.md$/, '')) ? 'yes' : 'no') : '—'
    line(`| ${day} | ${a.title} | ${page ? page.replace(/\.md$/, '') : flag(c.code, 'ANNOUNCEMENT NOT IN SLATE', a.title)} | ${att} | ${ib} | ${linked} |`)
  }
  // --- what the notebook holds, by category
  const all = walk(path.join(ROOT, courseKey)).filter(r => !/\/(Announcements|General)\/?/.test(r) || /^[^/]+\/General\//.test(r))
  const scaffold = new Set(['Plan', 'Problems', 'Notes', 'Lectures', 'Recordings', 'Study sheets'])
  const hasMeetings = (c.meetings || []).length > 0
  line(`\n### The notebook, by category\n\n| where | page | kind | for | note |\n|---|---|---|---|---|`)
  for (const rel of all.sort()) {
    const segs = rel.split('/'), title = path.basename(rel, '.md')
    if (segs[1] === 'Announcements' || segs.length === 2 || (segs.length === 3 && (/^Week /.test(title) || title === segs[1]))) continue   // notebook/section/week pages
    if (scaffold.has(title) && segs.length === 4) { const body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); if (!body.includes('- [')) continue }   // empty scaffolding
    const f = front(rel), notes = []
    if (segs[1] !== 'General' && segs.length === 4 && !scaffold.has(title) && !['reading', 'notes', 'admin'].includes(f.kind) && !/Reading|Overview|checklist/i.test(title)) notes.push(flag(c.code, 'LOOSE IN WEEK', `${rel} (kind ${f.kind || '—'})`))
    if (!f.kind && !scaffold.has(title)) notes.push(flag(c.code, 'NO KIND', rel))
    if (hasMeetings && segs[1] !== 'General' && !scaffold.has(title) && !f.for && !/^Plan$/.test(title)) notes.push(flag(c.code, 'NO CLASS', `${rel} says no class it is for`))
    line(`| ${where(rel)} | ${title} | ${f.kind || '—'} | ${f.for || '—'} | ${notes.join(', ')} |`)
  }
}
// --- Claude's tasks
line(`\n## Claude's tasks (${tasks.length} open)\n\n| id | course | where | due | what | link | status |\n|---|---|---|---|---|---|---|`)
for (const t of tasks.sort((a, b) => (a.due || '').localeCompare(b.due || '') || a.courseKey.localeCompare(b.courseKey))) {
  const notes = []
  if (t.link && !/^https?:/.test(t.link) && !exists(t.link)) notes.push(flag(COURSES[t.courseKey].code, 'TASK LINK MISSING', `${t.id} → ${t.link}`))
  if (t.source && !exists(t.source)) notes.push(flag(COURSES[t.courseKey].code, 'TASK SOURCE MISSING', `${t.id} → ${t.source}`))
  if (!t.link && !/\b(WMS|Williamson|Perloff|Layers|Persepolis|Pyongyang|Ch\b|Chapter)\b/i.test(t.what)) notes.push('no link (not a textbook)')
  line(`| ${t.id} | ${COURSES[t.courseKey].code} | ${t.attach.class ? `${t.attach.class.kind} ${t.attach.class.date}` : `week ${t.attach.week}`} | ${t.due || '—'} | ${t.what} | ${t.link ? (t.link.startsWith('http') ? t.link.replace(/^https?:\/\//, '').slice(0, 50) : where(t.link) + ' · ' + path.basename(t.link, '.md')) : '—'} | ${notes.join(', ') || 'ok'} |`)
}
line(`\n## Open questions (${Object.values(brain.questions || {}).filter(q => !q.answered).length})\n`)
for (const q of Object.values(brain.questions || {}).filter(q => !q.answered)) line(`- ${q.courseKey ? COURSES[q.courseKey]?.code + ' · ' : ''}${q.text}`)
line(`\n## Flags (${flags.length})\n`)
const by = {}; for (const f of flags) (by[f.kind] ||= []).push(f)
for (const [k, fs_] of Object.entries(by)) { line(`\n**${k}** (${fs_.length})`); for (const f of fs_) line(`- ${f.course}: ${f.text}`) }
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(OUT, R.join('\n') + '\n')
const counts = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]))
// --json carries the flags themselves: the morning check acts on each one (the quercus skill), not on a count
if (JSON_OUT) console.log(JSON.stringify({ report: OUT, flags: flags.length, counts, list: flags.slice(0, 300) }))
else { console.log(`wrote ${OUT}`); console.log(`FLAGS ${flags.length}`); for (const [k, n] of Object.entries(counts)) console.log(`  ${k}: ${n}`) }
