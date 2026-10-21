#!/usr/bin/env node
// Turn every un-transcribed recording in the notebooks into words (SPEC 18.3).
//   node scripts/transcribe.mjs [--root /path] [--course "ECO 208Y1"] [--page "<rel path>"] [--dry-run]
//                               [--engine parakeet|whisper] [--model <hf repo>]
//
// The unit is the recording, not the page: outputs are named after the audio file and land beside it,
// in its `.assets/`, and the same recording filed on two pages is transcribed once, not once per page —
// the second copy gets the first one's transcript. Transcripts written before that rule carry the page's
// name and still count.
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { COURSES, localStamp } from './lib/terms.mjs'
import { notesRoot } from './lib/root.mjs'
import { ensureUvFfmpeg } from './lib/mymedia.mjs'
import { guardFlags } from './lib/argv.mjs'

guardFlags(['--course', '--dry-run', '--engine', '--language', '--model', '--output-dir', '--output-format', '--page', '--root', '--verbose'])

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }
const DRY = args.includes('--dry-run')
const ROOT = notesRoot(process.argv)
// Parakeet TDT on the M-series GPU: ~12x real time, and — unlike whisper — it does not fall into
// repetition loops on long lectures (whisper-turbo lost a whole passage of ECO208 Session 1 to one).
// `--engine whisper` keeps mlx-whisper large-v3-turbo available as a second opinion.
const ENGINE = flag('--engine', 'parakeet')
const MODEL = flag('--model', ENGINE === 'whisper' ? 'mlx-community/whisper-large-v3-turbo' : null)
const ONLY = flag('--course', null)
const ONLY_PAGE = flag('--page', null)
const MEDIA_RE = /\.(m4a|mp3|wav|aac|ogg|flac|aiff|caf|mp4|mov|webm)$/i

const BIN = path.join(os.homedir(), '.local', 'bin', ENGINE === 'whisper' ? 'mlx_whisper' : 'parakeet-mlx')
// parakeet decodes the audio with ffmpeg from PATH: static-ffmpeg's folder, fetched before the first recording when setup
// never did (scripts/lib/mymedia.mjs); without it, whatever PATH already has. The folder this used to fall back to was
// the one that had just been looked for and not found.
let FFDIR
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

const hms = sec => [sec / 3600, (sec % 3600) / 60, sec % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':')

// Speech-to-text emits one short segment per sentence or breath. Glue them into paragraphs at real
// pauses (>1.4 s) or once a paragraph gets long, so the page reads like prose, not subtitles.
// Parakeet transcribes disfluencies faithfully; strip the bare fillers, keep everything else.
const FILLER = /\b(?:uh|um|erm|uhh|umm)\b[ ,]*/gi
const tidy = t => t.replace(FILLER, '').replace(/\s{2,}/g, ' ').replace(/^([a-z])/, (m, c) => c.toUpperCase()).trim()
function paragraphs(segments) {
  const out = []
  let cur = null
  for (const s of segments) {
    const text = tidy(s.text || '')
    if (!text) continue
    const gap = cur ? s.start - cur.end : 0
    if (!cur || gap > 1.4 || cur.text.length > 700) { cur = { start: s.start, end: s.end, text }; out.push(cur) }
    else { cur.text += ' ' + text; cur.end = s.end }
  }
  return out
}

// Every recording under the notebooks: one entry per media element, not per page. A page can show
// two recordings (a tutorial and the lecture that followed it), and the same recording can appear on
// two pages — the week's `Recordings` page and, say, the section page it was first dropped on.
async function recordingPages(root) {
  const out = []
  const walk = async dir => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.name.endsWith('.md')) continue
      const base = p.slice(0, -3)
      const sidecar = await readJson(base + '.blocks.json', null)
      for (const media of (sidecar?.elements || []).filter(el => el.type === 'media' || (el.src && MEDIA_RE.test(el.src))))
        out.push({ md: p, base, title: path.basename(base), sidecar, sidecarPath: base + '.blocks.json', media })
    }
  }
  await walk(root)
  return out
}

// The transcript belongs to the recording, so it is named after the recording — `<audio>.srt` beside
// the audio, which is also the only place the app looks for one (transcriptUrls in Elements.jsx,
// server/doc-index.js). Keyed off the page instead, as it once was, a lecture was transcribed again for
// every extra page it appeared on: on 2026-09-10 both ECO206's and ECO208's Session 1 were re-run from
// the section page they had also been dropped on, five minutes of GPU to write files byte-identical to
// the ones already beside them. Keyed off the file name alone, as it was next, two different recordings
// with one name shared one transcript and the second never got its own: MyMedia names every embedded
// video `embedded content.mp4`, so ECO206's Week 5 and Week 6 videos counted as done by Week 2's, and
// FCS298's re-upload of a mini-lecture by the copy it replaced (2026-10-14 run, F1) — while the page of
// a true second copy showed no transcript either, there being none beside its audio. So a recording is
// done when its own folder holds `<stem>.srt`; failing that, a transcript of the same file elsewhere —
// same name, same size, same bytes — is copied beside it, with no GPU. Older transcripts carry the
// page's name, so those still count.
const transcribed = new Set()            // `<folder>/<stem>`: a .srt beside the recording
const byStem = new Map()                 // stem → folders holding `<stem>.transcript.json`, the copyable kind
const keep = (dir, stem, copyable) => {
  transcribed.add(path.join(dir, stem))
  if (copyable) (byStem.get(stem) || byStem.set(stem, new Set()).get(stem)).add(dir)
}
async function indexTranscripts(root) {
  const walk = async dir => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      if (e.isDirectory()) { await walk(path.join(dir, e.name)); continue }
      if (e.name.endsWith('.srt')) keep(dir, e.name.slice(0, -4), false)
      else if (e.name.endsWith('.transcript.json')) keep(dir, e.name.slice(0, -16), true)
    }
  }
  await walk(root)
}

// Hashed only when a name and a size already match, which is rare: two PCM files of one duration are the
// same size and not the same recording.
const digests = new Map()
const digest = p => digests.get(p) || digests.set(p, new Promise((res, rej) => {
  const h = crypto.createHash('sha1')
  createReadStream(p).on('error', rej).on('data', d => h.update(d)).on('end', () => res(h.digest('hex')))
})).get(p)
// The folder of another copy of this very file that has its transcript, or null.
async function sameRecording(audio, stem) {
  const size = (await fs.stat(audio)).size
  for (const dir of byStem.get(stem) || []) {
    if (dir === path.dirname(audio)) continue
    for (const n of await fs.readdir(dir).catch(() => [])) {
      if (!MEDIA_RE.test(n) || n.replace(/\.[^.]+$/, '') !== stem) continue
      const other = path.join(dir, n)
      if ((await fs.stat(other).catch(() => null))?.size !== size) continue
      const [a, b] = await Promise.all([digest(audio), digest(other)].map(d => d.catch(() => null)))
      if (a && a === b) return dir
    }
  }
  return null
}

// The page keeps a one-line header; the words live beside the recording.
// the student's own words on the page are anything beyond the heading and the italic lines a script writes. The first container
// carries no `slate:block` anchor, so the old anchor test let a page of typed notes be replaced by a two-line header
// (review 2026-09-18). Such a page keeps its body; only the two transcript lines are refreshed or added.
async function writeHeader(page, rel, lines) {
  const old = await fs.readFile(page.md, 'utf8')
  const fmMatch = /^---\n[\s\S]*?\n---\n/.exec(old)
  const fm = fmMatch?.[0] || `---\ncreated: "${localStamp()}"\nkind: "notes"\n---\n`
  const body = fmMatch ? old.slice(fmMatch[0].length) : old
  const own = body.split('\n').some(l => l.trim() && !/^#\s/.test(l) && !/^_.*_\s*$/.test(l) && !/^<!-- slate:block/.test(l))
  const tmpMd = page.md + '.tmp-transcribe'
  if (own) {
    const kept = body.split('\n').filter(l => !/^_(?:Transcribed · |The transcript is under the player)/.test(l)).join('\n').replace(/\s+$/, '')
    await fs.writeFile(tmpMd, `${fm}${kept}\n\n${lines.join('\n')}\n`); await fs.rename(tmpMd, page.md)
    console.log(`  · ${rel}: has your notes; kept them, added the transcript lines`)
  } else {
    await fs.writeFile(tmpMd, `${fm}\n# ${page.title}\n\n${lines.join('\n')}\n`); await fs.rename(tmpMd, page.md)
  }
}

const run = async (cmd, argv) => {
  if (FFDIR === undefined) FFDIR = await ensureUvFfmpeg()
  return new Promise((res, rej) => {
    const env = { ...process.env, PATH: [FFDIR, process.env.PATH || ''].filter(Boolean).join(path.delimiter) }
    const p = spawn(cmd, argv, { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    p.on('error', rej)
    p.on('close', c => c === 0 ? res() : rej(new Error(`${path.basename(cmd)} exited ${c}`)))
  })
}

const done = [], copied = []
await indexTranscripts(ROOT)
for (const page of await recordingPages(ROOT)) {
  const rel = path.relative(ROOT, page.md)
  if (ONLY && !rel.startsWith(ONLY)) continue
  if (ONLY_PAGE && rel !== ONLY_PAGE && page.md !== ONLY_PAGE) continue
  const assets = page.base + '.assets'
  const audio = path.join(path.dirname(page.md), page.media.src)
  if (!(await exists(audio))) { console.log(`  skip ${rel}: audio missing`); continue }
  const stem = path.basename(audio).replace(/\.[^.]+$/, '')
  const home = path.dirname(audio)       // the recording's own folder: where its transcript goes and is read from
  const txtRel = path.relative(path.dirname(page.md), path.join(home, stem + '.txt'))
  // Already done — beside this recording, or under the page's own name from before transcripts were
  // named after the recording.
  if (transcribed.has(path.join(home, stem)) || await exists(path.join(assets, page.title + '.srt'))) continue

  // The same file, transcribed where it was filed first: its words are copied, not heard again.
  const twin = await sameRecording(audio, stem)
  if (twin) {
    const from = path.relative(ROOT, twin)
    console.log(`  copying ${rel} — ${path.basename(audio)}: the same recording is transcribed in ${from}`)
    if (DRY) { copied.push(rel); keep(home, stem, true); continue }
    for (const ext of ['srt', 'json', 'vtt', 'transcript.json', 'txt']) {
      const src = path.join(twin, stem + '.' + ext)
      if (await exists(src)) await fs.copyFile(src, path.join(home, stem + '.' + ext))
    }
    const tr = await readJson(path.join(home, stem + '.transcript.json'), {})
    const n = tr.paragraphs?.length || 0
    await writeHeader(page, rel, [`_Transcribed · ${n} paragraphs · ${tr.minutes ?? '?'} min · ${tr.engine || ENGINE}${tr.model ? ' ' + tr.model.split('/').pop() : ''}, copied from \`${from}\`._`,
      `_The transcript is under the player; the text is also in \`${txtRel}\`._`])
    keep(home, stem, true)
    console.log(`  ✓ ${rel} — ${n} paragraphs, the transcript of the same recording`)
    copied.push(rel)
    continue
  }

  console.log(`  transcribing ${rel} — ${path.basename(audio)}`)
  if (DRY) { done.push(rel); keep(home, stem, true); continue }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-stt-'))
  const argv = ENGINE === 'whisper'
    ? ['--model', MODEL, '--language', 'en', '--output-format', 'json', '--output-dir', tmp, '--verbose', 'False', audio]
    : [...(MODEL ? ['--model', MODEL] : []), '--output-format', 'all', '--output-dir', tmp, audio]
  const t0 = Date.now()
  await run(BIN, argv)

  const data = await readJson(path.join(tmp, stem + '.json'), null)
  const segments = data?.sentences || data?.segments || []
  if (!segments.length) { console.log(`  ! ${rel}: ${ENGINE} produced nothing`); continue }
  const paras = paragraphs(segments)
  const took = Math.round((Date.now() - t0) / 1000)

  await fs.mkdir(home, { recursive: true })
  for (const ext of ['srt', 'json', 'vtt']) {
    const from = path.join(tmp, stem + '.' + ext)
    if (await exists(from)) await fs.copyFile(from, path.join(home, stem + '.' + ext))
  }

  // The transcript belongs to the recording, not to the page body: the app renders it in a panel
  // directly under the player (SPEC 18.3), so writing 88 paragraphs into the .md as well would show
  // the whole thing twice. The page keeps a one-line header; the words live beside the recording
  // as .transcript.json (what the panel reads), .txt (grep and Obsidian) and .srt/.vtt.
  const mins = Math.round(segments.at(-1).end / 60)
  await writeHeader(page, rel, [`_Transcribed · ${paras.length} paragraphs · ${mins} min · ${ENGINE}${MODEL ? ' ' + MODEL.split('/').pop() : ''}, ${took}s._`,
    `_The transcript is under the player; the text is also in \`${txtRel}\`._`])

  // The normalised transcript the player panel reads, and a plain-text copy so ripgrep and Obsidian
  // can still find a phrase across every lecture.
  await fs.writeFile(path.join(home, stem + '.transcript.json'),
    JSON.stringify({ engine: ENGINE, model: MODEL, minutes: mins, seconds: took, paragraphs: paras }, null, 2) + '\n')
  await fs.writeFile(path.join(home, stem + '.txt'),
    paras.map(p => `[${hms(p.start)}] ${p.text}`).join('\n\n') + '\n')

  await fs.rm(tmp, { recursive: true, force: true })
  keep(home, stem, true)
  console.log(`  ✓ ${rel} — ${paras.length} paragraphs, ${mins} min of audio in ${took}s`)
  done.push(rel)
}
const said = [done.length && `Transcribed ${done.length}`, copied.length && `copied ${copied.length} from the same recording elsewhere`].filter(Boolean).join('; ')
console.log(said ? said.charAt(0).toUpperCase() + said.slice(1) + '.' : 'Nothing to transcribe.')
