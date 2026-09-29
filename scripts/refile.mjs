#!/usr/bin/env node
// Re-file what the old rule put in the wrong folder (SPEC §20.21). Until scripts/lib/filing.mjs existed, every
// non-media course file went to Lectures, so problem sets and their solutions sat among the slides. This walks
// every week of every course, asks the classifier where each page belongs, and moves the ones that disagree.
//
// A page is up to four things sharing one name (SPEC §3) — `<name>.md`, `<name>.blocks.json`, `<name>.assets/`,
// and a subpage folder — so a move takes all four or none (scripts/lib/move.mjs, which checks every destination
// before the first rename). Dry run by default; `--apply` writes. With Claude as the brain (SPEC §20.37) this is a
// rule deciding, so it is only ever run by hand.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { guardFlags } from './lib/argv.mjs'
import { notesRoot } from './lib/root.mjs'
import { bucketFor, FOLDER, headingFor } from './lib/filing.mjs'
import { movePage, reorder, followHub, followSyncState } from './lib/move.mjs'

guardFlags(['--apply', '--root', '--json'])
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const JSON_OUT = args.includes('--json')
const ROOT = notesRoot(process.argv)
const SOURCES = ['Lectures', 'Problems', 'Recordings']   // Study sheets are slate's own output; never re-filed
const log = (...a) => { if (!JSON_OUT) console.log(...a) }

// The name the file actually carries, which is what the classifier reads — the page title loses the extension.
async function assetName(dir, title) {
  const assets = path.join(dir, `${title}.assets`)
  const names = await fs.readdir(assets).catch(() => [])
  return names.find(n => !n.startsWith('.') && !/\.(txt|json|srt|vtt)$/i.test(n)) || title
}

// The Quercus topic pages filed in a week, as one text: the heading above a file's link is where the professor posted it,
// which the classifier reads when the name is not decisive (SPEC §20.32). Each page starts with its own `# Title`, so a
// heading never reaches back into the page before it.
async function topicsOf(weekDir) {
  let out = ''
  for (const e of await fs.readdir(weekDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue
    const text = await fs.readFile(path.join(weekDir, e.name), 'utf8').catch(() => '')
    if (/^tags:.*"quercus".*"page"/m.test(text.slice(0, 400))) out += '\n' + text
  }
  return out
}

const moves = [], skipped = []
for (const nb of await fs.readdir(ROOT, { withFileTypes: true })) {
  if (!nb.isDirectory() || nb.name.startsWith('.') || nb.name.startsWith('_') || nb.name === 'Hub') continue
  for (const term of await fs.readdir(path.join(ROOT, nb.name), { withFileTypes: true })) {
    if (!term.isDirectory() || !/^(Fall|Winter|Summer|Spring)\b/.test(term.name)) continue
    for (const wk of await fs.readdir(path.join(ROOT, nb.name, term.name), { withFileTypes: true })) {
      if (!wk.isDirectory() || !/^Week /.test(wk.name)) continue
      const weekDir = path.join(ROOT, nb.name, term.name, wk.name)
      const topics = await topicsOf(weekDir)
      for (const src of SOURCES) {
        const dir = path.join(weekDir, src)
        for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue
          const title = e.name.slice(0, -3)
          const name = await assetName(dir, title)
          const want = FOLDER[bucketFor(name, { heading: headingFor(topics, `[${name}]`) })] || 'Lectures'
          if (want === src) continue
          const rel = path.relative(ROOT, path.join(dir, e.name)).split(path.sep).join('/'), to = path.relative(ROOT, path.join(weekDir, want, e.name)).split(path.sep).join('/')
          try {
            if (APPLY) { await movePage(ROOT, rel, to); await reorder(dir, title, null); await reorder(path.join(weekDir, want), null, title) }
            else await movePage(ROOT, rel, to, { dry: true })
            moves.push({ from: rel, to })
            log(`  ${src} → ${want}   ${nb.name} · ${wk.name} · ${title}`)
          } catch (err) { skipped.push({ page: rel, why: err.message }); log(`  SKIP ${rel}: ${err.message}`) }
        }
      }
    }
  }
}
// The hub remembers where each file was filed (`page`, `where`), and "New since the last check" on Today links straight to
// it; the sync remembers the same in Hub/_sync-state.json. Both follow the files (SPEC §20.24, §20.37).
const repaired = APPLY && moves.length ? await followHub(ROOT, moves) : 0
const records = APPLY && moves.length ? (await followSyncState(ROOT, moves)).length : 0
if (JSON_OUT) console.log(JSON.stringify({ ok: true, applied: APPLY, moved: moves.length, moves, skipped, hubRows: repaired, syncRecords: records }, null, 2))
else log(`\n${moves.length} page(s) ${APPLY ? 'moved' : 'would move'}${skipped.length ? `, ${skipped.length} skipped` : ''}${repaired ? `, ${repaired} hub row(s) followed` : ''}${records ? `, ${records} sync record(s) followed` : ''}.${APPLY ? '' : '  Re-run with --apply to do it.'}`)
