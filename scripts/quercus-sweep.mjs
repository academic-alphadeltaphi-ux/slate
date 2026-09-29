#!/usr/bin/env node
// Sweep every place a file can hide in a Quercus course, or walk a course's modules item by item (SPEC §21; the
// quercus skill's rationale). Node, not Python: on a Mac without Apple's developer tools `python3` is a shim that opens
// an install dialog (server/devtools.js), and every brother's Mac starts that way.
//   node scripts/quercus-sweep.mjs --list                          the account's active courses
//   node scripts/quercus-sweep.mjs [--course <id>]                 files found in every place (default: every course)
//   node scripts/quercus-sweep.mjs --modules --course <id>         every module item of every type, with ids, slugs, urls, due dates
//   node scripts/quercus-sweep.mjs --syllabus --course <id>        what setup's courses step reads: the Syllabus tab, the front page,
//                                                                  outline and grading pages as text, outline files, the teachers,
//                                                                  and the announcements that speak of tests or grading
//   node scripts/quercus-sweep.mjs --course <id> --download <dir>  download everything found into <dir>
//   --json prints one JSON object per course instead of the table.
// The key comes from scripts/lib/quercus-auth.mjs (env, keychain, Claude desktop config), never from a file read here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardFlags } from './lib/argv.mjs'
import { requireQuercusAuth } from './lib/quercus-auth.mjs'
import { fetchSafe } from './lib/net.mjs'
import { safeName } from './lib/platform.mjs'

guardFlags(['--list', '--modules', '--syllabus', '--course', '--download', '--json'], 'node scripts/quercus-sweep.mjs [--list | --modules | --syllabus] [--course <id>] [--download <dir>] [--json]')
const args = process.argv.slice(2), opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null)
const JSON_OUT = args.includes('--json')
const { token: TOKEN, api: API } = requireQuercusAuth()
const FILE_RE = /\/courses\/(\d+)\/files\/(\d+)/g
const SKIP = new Set([188930, 222195, 171480])   // admin shells the account is enrolled in, not courses

async function get(p, raw = false) {
  const url = p.startsWith('http') ? p : API + p
  const r = await fetchSafe(url, { headers: { Authorization: 'Bearer ' + TOKEN } }).catch(() => null)
  if (!r) return null
  // a hidden Files tab is a 401 too ("user not authorized"); only a dead key ends the sweep
  if (r.status === 401) { let body = ''; try { body = await r.text() } catch { }; if (/access token/i.test(body)) { console.error('401 Expired access token — make a new one at q.utoronto.ca → Account → Settings, then store it again (node scripts/setup.mjs token).'); process.exit(1) }; return null }
  if (!r.ok) return null
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json()
}
// Every page of a paginated listing (Canvas caps per_page at 100 and links the rest).
async function getAll(p) {
  const out = []; let url = API + p + (p.includes('?') ? '&' : '?') + 'per_page=100'
  while (url) {
    const r = await fetchSafe(url, { headers: { Authorization: 'Bearer ' + TOKEN } }).catch(() => null)
    if (!r || !r.ok) return out.length ? out : null
    const j = await r.json(); out.push(...(Array.isArray(j) ? j : [j]))
    const m = /<([^>]+)>; rel="next"/.exec(r.headers.get('link') || ''); url = m ? m[1] : null
  }
  return out
}
const safe = name => safeName(name)   // a `?` in a file name crashed this on Windows (a brother, PSY210, 2026-09-24)
// a file of another course (a department's shared course) answers only by its id alone
const fileMeta = async (course, fid) => (await get(`/courses/${course}/files/${fid}`)) || (await get(`/files/${fid}`))
const idsIn = html => [...String(html || '').matchAll(FILE_RE)].map(m => [m[1], m[2]])

// → { found: { fileId: { course, name, source } }, notes: [] } across every place, and the ones found since: a module's
// External URL that is a file's address, the front page and the pages pages link to, forum attachments, hand-in and quiz
// descriptions, a video uploaded into a page (/media_attachments_iframe/<file id>).
async function sweep(cid) {
  const found = {}, notes = []
  const note = (html, source) => { for (const [c2, fid] of idsIn(html)) found[fid] ||= { course: c2, name: null, source }; for (const m of String(html || '').matchAll(/\/media_attachments_iframe\/(\d+)/g)) found[m[1]] ||= { course: String(cid), name: null, source } }
  const attached = (list, source) => { for (const at of list || []) found[String(at.id)] ||= { course: String(cid), name: at.display_name, source } }
  // a page, and every page of this course it links to, once each: a page in no module is reached only by a link
  const read = new Set()
  const readPage = async (slug, source) => { if (read.has(slug)) return; read.add(slug); const pg = await get(`/courses/${cid}/pages/${slug}`); if (!pg) return; note(pg.body, source); for (const m of String(pg.body || '').matchAll(new RegExp(`/courses/${cid}/(?:pages|wiki)/([a-z0-9._~%-]+)`, 'gi'))) await readPage(m[1], `page:${m[1]}`) }
  const files = await getAll(`/courses/${cid}/files`)                                   // 1. the Files tab
  if (files) for (const f of files) found[String(f.id)] = { course: String(cid), name: f.display_name, source: 'files-tab' }
  else notes.push('Files tab: unauthorized (the instructor hid it) — normal')
  const mods = await getAll(`/courses/${cid}/modules?include[]=items`)                  // 2. module items, 3. links in page bodies
  if (mods) {
    // Canvas leaves `items` out of a module with more than it will inline: asked for on their own, or its files were missed
    for (const m of mods) for (const it of m.items || await getAll(`/courses/${cid}/modules/${m.id}/items`) || []) {
      if (it.type === 'File' && it.content_id) found[String(it.content_id)] ||= { course: String(cid), name: it.title, source: 'module-item' }
      else if (it.type === 'Page' && it.page_url) await readPage(it.page_url, `page:${it.page_url}`)
      else if (it.type === 'ExternalUrl') note(it.external_url, `module-link:${String(it.title || '').slice(0, 40)}`)
    }
  } else notes.push('no modules')
  const front = await get(`/courses/${cid}/front_page`); if (front?.url) await readPage(front.url, 'front-page')
  for (const pg of await getAll(`/courses/${cid}/pages`) || []) if (pg?.url) await readPage(pg.url, `page:${pg.url}`)   // the Pages index, where a course leaves it on
  const anns = await getAll(`/courses/${cid}/discussion_topics?only_announcements=true`) || []   // 4. announcement bodies, 6. attachments
  for (const a of anns) { note(a.message, `announcement:${String(a.title || '').slice(0, 40)}`); attached(a.attachments, 'announcement-attachment') }
  const disc = await getAll(`/courses/${cid}/discussion_topics`) || []
  for (const d of disc) { note(d.message, `discussion:${String(d.title || '').slice(0, 40)}`); attached(d.attachments, 'discussion-attachment') }
  for (const a of await getAll(`/courses/${cid}/assignments`) || []) note(a.description, `assignment:${String(a.name || '').slice(0, 40)}`)
  for (const q of await getAll(`/courses/${cid}/quizzes`) || []) note(q.description, `quiz:${String(q.title || '').slice(0, 40)}`)
  const c = await get(`/courses/${cid}?include[]=syllabus_body`) || {}                  // 5. the syllabus body
  note(c.syllabus_body, 'syllabus_body')
  for (const [fid, f] of Object.entries(found)) if (f.name === null) { const meta = await fileMeta(f.course, fid); f.name = meta ? meta.display_name : `file_${fid}` }
  return { found, notes }
}

// Every module and every item in it, whatever its type — the walk the MCP's get_course_structure stopped answering.
async function modules(cid) {
  const mods = await getAll(`/courses/${cid}/modules?include[]=items`)
  if (!mods) return null
  const out = []
  for (const m of mods) {
    const items = m.items || await getAll(`/courses/${cid}/modules/${m.id}/items`) || []
    const rows = []
    for (const it of items) {
      const t = it.type
      const row = { type: t, title: it.title, indent: it.indent || 0, published: it.published !== false, ref: t === 'File' ? `file ${it.content_id}` : t === 'Page' ? `page ${it.page_url}` : t === 'ExternalUrl' || t === 'ExternalTool' ? (it.external_url || it.html_url || '') : t === 'Discussion' ? `discussion ${it.content_id}` : t === 'Quiz' ? `quiz ${it.content_id}` : t === 'Assignment' ? `assignment ${it.content_id}` : '' }
      if (t === 'Assignment' && it.content_id) { const a = await get(`/courses/${cid}/assignments/${it.content_id}`) || {}; row.due = a.due_at || null; row.points = a.points_possible ?? null }
      else if (t === 'Quiz' && it.content_id) { const q = await get(`/courses/${cid}/quizzes/${it.content_id}`) || {}; row.due = q.due_at || null; row.points = q.points_possible ?? null; row.assignment = q.assignment_id || null }
      else if (t === 'Discussion' && it.content_id) { const d = await get(`/courses/${cid}/discussion_topics/${it.content_id}`) || {}; row.graded = !!d.assignment; row.due = d.assignment?.due_at || null; row.locks = d.lock_at || null }
      rows.push(row)
    }
    out.push({ id: m.id, name: m.name, published: m.published !== false, unlocks: m.unlock_at || null, items: rows })
  }
  return out
}

const courses = ((await getAll('/courses?enrollment_state=active')) || []).filter(c => !SKIP.has(c.id))
if (args.includes('--list')) {
  if (JSON_OUT) console.log(JSON.stringify(courses.map(c => ({ id: c.id, code: String(c.course_code || '').trim(), name: c.name }))))
  else for (const c of courses) console.log(`${String(c.id).padStart(8)}  ${String(c.course_code || '').trim()}  ${c.name || ''}`)
  process.exit(0)
}
const targets = opt('--course') ? [Number(opt('--course'))] : courses.map(c => c.id)
for (const cid of targets) {
  const name = (courses.find(c => c.id === cid)?.course_code || String(cid)).trim()
  // --syllabus: a course's outline wherever it lives — the Syllabus tab, the front page, a page, a file, an announcement —
  // as text setup's courses step can read (it had only files to download, and a course whose grading lived on the Syllabus
  // tab reached courses.json without it: the walkthrough of 2026-09-29). The teachers name the professor.
  if (args.includes('--syllabus')) {
    const OUTLINE = /syllab|outline|course info|grading|evaluation|assessment|marking scheme|weights?\b/i, TESTS = /\b(test|midterm|exam|quiz|grading|weights?|syllab|outline)\b/i
    const text = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<td[^>]*>/gi, ' | ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
    const c = await get(`/courses/${cid}?include[]=syllabus_body`), front = await get(`/courses/${cid}/front_page`)
    const teachers = ((await getAll(`/courses/${cid}/users?enrollment_type[]=teacher`)) || []).map(u => u.name).filter(Boolean)
    const mods = await modules(cid), slugs = new Map()
    for (const m of mods || []) for (const r of m.items) if (r.type === 'Page' && OUTLINE.test(r.title)) slugs.set(r.ref.replace(/^page /, ''), r.title)   // ref: "page <slug>"
    for (const p of (await getAll(`/courses/${cid}/pages?per_page=100`)) || []) if (p?.url && OUTLINE.test(`${p.title} ${p.url}`)) slugs.set(p.url, p.title)
    const pages = []; for (const [slug, title] of slugs) { const p = await get(`/courses/${cid}/pages/${slug}`); if (p?.body) pages.push({ title: p.title || title, text: text(p.body) }) }
    const files = ((await getAll(`/courses/${cid}/files?per_page=100`)) || []).filter(x => OUTLINE.test(x.display_name || '')).map(x => ({ id: x.id, name: x.display_name }))
    for (const m of mods || []) for (const r of m.items) if (r.type === 'File' && OUTLINE.test(r.title) && !files.some(x => String(x.id) === r.ref.replace(/^file /, ''))) files.push({ id: r.ref.replace(/^file /, ''), name: r.title })
    const anns = ((await getAll(`/courses/${cid}/discussion_topics?only_announcements=true&per_page=50`)) || []).filter(a => TESTS.test(`${a.title} ${text(a.message)}`)).map(a => ({ title: a.title, posted: String(a.posted_at || '').slice(0, 10), author: a.author?.display_name || a.user_name || null, text: text(a.message) }))
    const out = { course: cid, name, teachers, syllabusTab: text(c?.syllabus_body) || null, frontPage: front?.body ? text(front.body) : null, pages, files, announcements: anns }
    if (JSON_OUT) { console.log(JSON.stringify(out)); continue }
    console.log(`\n=== ${name} (${cid}) ===`)
    console.log(`Teachers: ${teachers.join(', ') || 'none listed'}`)
    console.log(`\n--- Syllabus tab ---\n${out.syllabusTab || '(empty)'}`)
    if (out.frontPage) console.log(`\n--- Front page ---\n${out.frontPage}`)
    for (const p of pages) console.log(`\n--- Page: ${p.title} ---\n${p.text}`)
    console.log(`\n--- Outline files ---\n${files.length ? files.map(x => `${x.name} (file ${x.id}): node scripts/quercus-sweep.mjs --course ${cid} --download <folder>, then read it`).join('\n') : '(none by name)'}`)
    for (const a of anns) console.log(`\n--- Announcement ${a.posted}${a.author ? ` by ${a.author}` : ''}: ${a.title} ---\n${a.text}`)   // the author is often the professor
    continue
  }
  if (args.includes('--modules')) {
    const mods = await modules(cid)
    if (JSON_OUT) { console.log(JSON.stringify({ course: cid, name, modules: mods })); continue }
    console.log(`\n=== ${name} (${cid}) ===`)
    if (!mods) { console.log('  modules: unreadable'); continue }
    for (const m of mods) {
      const flags = [...(m.published ? [] : ['UNPUBLISHED']), ...(m.unlocks ? [`unlocks ${m.unlocks}`] : [])]
      console.log(`  ## [${m.id}] ${m.name}  (${m.items.length} items${flags.length ? ', ' + flags.join(', ') : ''})`)
      for (const r of m.items) {
        const extra = r.type === 'Assignment' ? `  due ${r.due} · ${r.points} pts` : r.type === 'Quiz' ? `  due ${r.due} · ${r.points} pts · assignment ${r.assignment}` : r.type === 'Discussion' ? `  ${r.graded ? 'graded, due ' + r.due : 'ungraded'} · locks ${r.locks}` : ''
        console.log(`     ${'  '.repeat(r.indent)}${r.type.padEnd(12)} ${r.title}  <- ${r.ref}${extra}${r.published ? '' : '  [UNPUBLISHED]'}`)
      }
    }
    continue
  }
  const { found, notes } = await sweep(cid)
  if (JSON_OUT) { console.log(JSON.stringify({ course: cid, name, notes, files: Object.entries(found).map(([id, f]) => ({ id, ...f })) })); continue }
  console.log(`\n=== ${name} (${cid}) ===`)
  for (const n of notes) console.log(`  · ${n}`)
  const rows = Object.entries(found).sort((a, b) => a[1].source.localeCompare(b[1].source))
  if (!rows.length) console.log('  no files found in any of the six locations')
  for (const [fid, f] of rows) console.log(`  [${f.source.padEnd(28)}] ${fid.padStart(9)}  ${f.name}`)
  if (opt('--download') && rows.length) {
    const dest = opt('--download').replace(/^~(?=$|[\\/])/, os.homedir()); fs.mkdirSync(dest, { recursive: true })   // os.homedir(): HOME is unset on a PC without Git Bash, and `~` became "undefined"
    for (const [fid, f] of rows) {
      const meta = await fileMeta(f.course, fid); if (!meta) { console.log(`  ! ${fid} unreadable`); continue }
      const out = path.join(dest, safe(meta.display_name))
      if (fs.existsSync(out) && fs.statSync(out).size === meta.size) continue
      const data = await get(meta.url, true); if (data) { fs.writeFileSync(out, data); console.log(`  + ${path.basename(out)} (${(data.length / 1e6).toFixed(2)} MB)`) }
    }
  }
}
