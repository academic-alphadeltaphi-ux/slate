#!/usr/bin/env node
// Keep a course's documents on the computer as plain files (SPEC §20.33): `~/Desktop/<course>/`, laid out like the
// notebook — `General/`, `Announcements/`, `Fall 2026/Week 1 (Sep 7)/Lectures/` — so the course is in Finder without
// the app. Only courses marked `mirror: true` in scripts/lib/terms.mjs: the ECO folders were arranged by hand, and the
// quercus skill's rule is to add to those, never to restructure them.
//
// Copies; never moves, renames or deletes. A file is copied under the name it has in the notebook's `.assets/`, which
// is the name the sync reads back when it walks the Desktop folder, so a mirrored file is recognised and never filed
// a second time. A file whose name already exists anywhere under the Desktop folder is skipped — the student may have moved
// it, and then where it is is his decision. Quercus pages and announcements come across as markdown.
//   node scripts/mirror-course.mjs [--course "CLA 204H1"] [--root /path] [--desk ~/Desktop] [--dry-run] [--json]
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { COURSES } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { parsePage } from '../server/format.js'
import { guardFlags } from './lib/argv.mjs'

guardFlags(['--course', '--root', '--desk', '--dry-run', '--json'])
const args = process.argv.slice(2), opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const DRY = args.includes('--dry-run'), JSON_OUT = args.includes('--json'), ONLY = opt('--course')
const ROOT = notesRoot(process.argv)
const DESK = path.resolve(opt('--desk') || path.join(os.homedir(), 'Desktop'))
if (ONLY && !COURSES[ONLY]) { console.error(`not a course in scripts/lib/terms.mjs: ${ONLY}`); process.exit(2) }

// slate's own caches beside a document are not documents.
const CACHE = /(\.pdf\.txt|\.transcript\.json|\.srt|\.vtt|\.txt|\.json)$/i
const ls = d => fs.readdir(d, { withFileTypes: true }).catch(() => [])
const exists = p => fs.access(p).then(() => true, () => false)
async function namesUnder(dir, out = new Set()) {
  for (const e of await ls(dir)) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await namesUnder(p, out); else out.add(e.name.toLowerCase())
  }
  return out
}
// `Announcements/Announcements` (the index page's subpages) is one folder on the Desktop.
const deskRel = rel => { const s = rel.split('/').filter(Boolean); return (s.length >= 2 && s[s.length - 1] === s[s.length - 2] ? s.slice(0, -1) : s).join('/') }

const report = []
for (const [key, info] of Object.entries(COURSES)) {
  if (ONLY ? key !== ONLY : !info.mirror) continue
  const nb = path.join(ROOT, key), desk = path.join(DESK, key)
  if (!(await exists(nb))) { report.push({ course: key, desk, copied: [], note: 'no notebook yet — run scripts/add-course.mjs and the sync first' }); continue }
  const have = await namesUnder(desk)
  const copied = []
  const copy = async (from, relDir, name, text = null) => {
    if (have.has(name.toLowerCase())) return
    have.add(name.toLowerCase())
    copied.push(path.posix.join(relDir, name))
    if (DRY) return
    const dir = path.join(desk, relDir)
    await fs.mkdir(dir, { recursive: true })
    if (text != null) await fs.writeFile(path.join(dir, name), text)
    else await fs.copyFile(from, path.join(dir, name))
  }
  const walk = async (dir, rel) => {
    for (const e of await ls(dir)) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { if (!e.name.endsWith('.assets')) await walk(abs, rel ? `${rel}/${e.name}` : e.name); continue }
      if (!e.name.endsWith('.md')) continue
      const title = e.name.slice(0, -3), relDir = deskRel(rel)
      for (const a of await ls(path.join(dir, `${title}.assets`))) {
        if (a.isFile() && !a.name.startsWith('.') && !CACHE.test(a.name)) await copy(path.join(dir, `${title}.assets`, a.name), relDir, a.name)
      }
      // The professor's own words: a synced Quercus page or an announcement, as the text the notebook holds.
      const { frontmatter, blocks } = parsePage(await fs.readFile(abs, 'utf8'))
      const tags = Array.isArray(frontmatter?.tags) ? frontmatter.tags.map(String) : []
      if (tags.includes('announcement') || (tags.includes('quercus') && tags.includes('page'))) {
        const body = blocks.map(b => b.md).join('\n\n').trim()
        if (body) await copy(null, relDir, `${title}.md`, body + '\n')
      }
    }
  }
  await walk(nb, '')
  report.push({ course: key, desk, copied })
}
if (JSON_OUT) console.log(JSON.stringify({ dry: DRY, courses: report.map(r => ({ course: r.course, desk: r.desk, copied: r.copied.length, note: r.note || null })) }))
else for (const r of report) console.log(`${r.course} → ${r.desk}: ${r.note || `${r.copied.length} file(s) ${DRY ? 'would be copied' : 'copied'}`}${r.copied.length ? '\n  ' + r.copied.join('\n  ') : ''}`)
