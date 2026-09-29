#!/usr/bin/env node
// Download MyMedia videos from the command line — one link, or every video a course has posted.
//
//   node scripts/mymedia.mjs <watch-or-embed-url|id> [--out DIR] [--name NAME]
//   node scripts/mymedia.mjs --course FCS298 [--out DIR] [--dry-run]
//
// --course walks the course's modules for ExternalUrl items that point at MyMedia and fetches each one it
// has not already got. Default --out is the course's own folder under the notes root; a bare URL defaults
// to the current directory. See scripts/lib/mymedia.mjs for why this works without a UTORid.
import fs from 'node:fs/promises'
import path from 'node:path'
import { download, isMyMedia, mymediaId, humanDuration, findFfmpeg } from './lib/mymedia.mjs'
import { COURSES } from './lib/terms.mjs'
import { requireQuercusAuth } from './lib/quercus-auth.mjs'
import { notesRoot } from './lib/root.mjs'
import { guardFlags } from './lib/argv.mjs'
import { fetchSafe } from './lib/net.mjs'
import { safeName } from './lib/platform.mjs'

guardFlags(['--out', '--name', '--course', '--dry-run', '--root'])
const args = process.argv.slice(2)
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const DRY = args.includes('--dry-run')
const safe = s => safeName(s)

async function one(url, dir, name) {
  const dest = path.join(dir, `${safe(name)}.mp4`)
  if (await fs.access(dest).then(() => true, () => false)) { console.log(`  have it: ${path.basename(dest)}`); return null }
  if (DRY) { console.log(`  would fetch: ${name}`); return null }
  process.stdout.write(`  ${name} … `)
  const r = await download(url, dest, { onProgress: (i, n) => { if (i % 10 === 0 || i === n) process.stdout.write(`${i}/${n} `) } })
  console.log(`→ ${path.basename(r.path)} (${humanDuration(r.seconds)}, ${(r.bytes / 1e6).toFixed(1)} MB${r.container === 'ts' ? ', no ffmpeg — .ts' : ''})`)
  return r
}

const course = flag('--course')
if (!(await findFfmpeg())) console.warn('! no ffmpeg — videos land as .ts (playable, but NotebookLM rejects them). Run bin/install-ffmpeg.sh')

if (course) {
  // COURSES is keyed by the Quercus code ("FCS 298H1"); the student types the short one ("FCS298"). Accept either,
  // and compare with the spaces squeezed out so "fcs 298" works too.
  const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase()
  const entry = Object.entries(COURSES).find(([k, c]) => norm(k) === norm(course) || norm(c.code) === norm(course) || norm(c.id) === norm(course))
  const [courseKey, info] = entry || [null, null]
  if (!info) { console.error(`unknown course: ${course} (have ${Object.values(COURSES).map(c => c.code).join(', ')})`); process.exit(1) }
  const { token, api } = requireQuercusAuth()
  const get = async q => { const r = await fetchSafe(api + q, { headers: { Authorization: 'Bearer ' + token } }); return r.ok ? r.json() : null }
  // The notebook folder is the COURSES *key* ("FCS 298H1"), not the short code — a course's notes live there.
  const dir = flag('--out') || path.join(notesRoot(process.argv), courseKey, 'Videos')
  const mods = await get(`/courses/${info.id}/modules?include[]=items&per_page=100`)
  const vids = []
  for (const m of Array.isArray(mods) ? mods : []) for (const it of m.items || []) if (it.type === 'ExternalUrl' && isMyMedia(it.external_url)) vids.push({ ...it, module: m.name })
  console.log(`${info.code}: ${vids.length} MyMedia video${vids.length === 1 ? '' : 's'} → ${dir}`)
  await fs.mkdir(dir, { recursive: true })
  for (const v of vids) { try { await one(v.external_url, dir, v.title) } catch (e) { console.error(`  FAILED ${v.title}: ${e.message}`) } }
} else {
  const url = args.find(a => !a.startsWith('--') && (isMyMedia(a) || mymediaId(a)))
  if (!url) { console.error('usage: node scripts/mymedia.mjs <url|id> [--out DIR] [--name NAME]  |  --course <CODE>'); process.exit(1) }
  const dir = flag('--out') || process.cwd()
  await fs.mkdir(dir, { recursive: true })
  await one(url, dir, flag('--name') || `MyMedia ${mymediaId(url).slice(0, 8)}`)
}
