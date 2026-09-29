// MyMedia (play.library.utoronto.ca) video download.
//
// The watch page is a Next.js shell that asks for a UTORid and hands the media to the player only after
// login, so for a long time the sync recorded the link and gave up. That was one layer too shallow: the
// player pulls an ordinary Wowza HLS stream from stream.library.utoronto.ca, and **that host does not
// check the session at all** (verified 2026-09-18 against three FCS298 videos — 200 on every request with
// no cookie, no token, no referer). So the video is fetchable from a plain shell; only the page around it
// is gated. Nothing here needs the student's credentials or a browser.
//
//   watch/embed URL → 32-hex id → playlist.m3u8 → chunklist → N × .ts → concatenated → remuxed to .mp4
//
// The concatenation is a plain byte append: HLS segments from one Wowza stream are MPEG-TS sharing a
// PAT/PMT, so the joined file is already valid TS and plays. mp4 is still worth the remux — Quercus-facing
// tools, slate's media element and NotebookLM all take mp4 and NotebookLM rejects .ts with a 400. The
// remux is `-c copy`, so it costs seconds and loses nothing.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WIN, ROAMING_APP, LOCAL_BIN, exe } from './platform.mjs'
import { fetchSafe } from './net.mjs'

const run = promisify(execFile)
// SLATE_MYMEDIA_STREAM: the scenarios' mock Quercus serves the stream too, so no test reaches the library's host
const STREAM = process.env.SLATE_MYMEDIA_STREAM || 'https://stream.library.utoronto.ca:1935/MyMedia/play/mp4:1'

// The 32-hex id out of any MyMedia form: /watch/<id>, /embed/<id>, the stream's own mp4:1/<id>.mp4, or a bare id. → string | null
export function mymediaId(url) {
  const m = String(url || '').match(/\b([0-9a-f]{32})\b/i)
  return m ? m[1].toLowerCase() : null
}

export const isMyMedia = url => /(?:play|mymedia|stream)\.library\.utoronto\.ca/i.test(String(url || '')) && !!mymediaId(url)

// The MyMedia videos an HTML body embeds or links — the player's <iframe>, a watch link, a bare stream url in the text —
// with the title the tag gives (an iframe's `title`, a link's words), '' when it gives none. A professor who embeds the
// week's video in the week's page never makes it a module item, and the fetch only knew the module item.
// → [{ id, url, title }]
export function mymediaIn(html) {
  const out = new Map(), s = String(html || ''), words = t => t.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  for (const m of s.matchAll(/<(a|iframe)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const url = (/\b(?:href|src)="([^"]+)"/i.exec(m[2])?.[1] || '').replace(/&amp;/g, '&'); if (!isMyMedia(url)) continue
    const t = words(/\btitle="([^"]*)"/i.exec(m[2])?.[1] || m[3])
    if (!out.has(mymediaId(url))) out.set(mymediaId(url), { id: mymediaId(url), url, title: /^https?:/i.test(t) ? '' : t })
  }
  for (const m of s.matchAll(/https?:\/\/(?:play|mymedia|stream)\.library\.utoronto\.ca[^\s"'<>]*/gi)) if (isMyMedia(m[0]) && !out.has(mymediaId(m[0]))) out.set(mymediaId(m[0]), { id: mymediaId(m[0]), url: m[0], title: '' })
  return [...out.values()]
}

// ffmpeg, if this machine has one. Checked in PATH order, then Homebrew's two prefixes, then the copy
// `bin/install-ffmpeg.sh` puts in ~/.local/share/slate (a pip `imageio-ffmpeg` wheel — no Homebrew needed).
// → absolute path | null
// The folder uv's `static-ffmpeg` tool puts its binaries in, whichever Python uv chose — the path used to name python3.12
// and missed every install where uv picked another (review 2026-09-18). Under it the binaries sit in a folder named for
// the machine (static_ffmpeg/bin/darwin_arm64 on an Apple chip, darwin on an Intel Mac, win32 on a PC), so that folder
// is listed, not named: naming darwin_arm64 found nothing on an Intel Mac. → absolute path | null
export function uvFfmpegDir() {
  const ls = d => { try { return fsSync.readdirSync(d) } catch { return [] } }
  // uv keeps its tools in %APPDATA%\uv\tools on Windows, where a venv's packages are under Lib\site-packages
  const tool = WIN ? path.join(ROAMING_APP, 'uv', 'tools', 'static-ffmpeg') : path.join(os.homedir(), '.local/share/uv/tools/static-ffmpeg')
  const sites = WIN ? [path.join(tool, 'Lib', 'site-packages')]
    : ls(path.join(tool, 'lib')).filter(n => /^python3\.\d+$/.test(n)).sort((a, b) => Number(b.slice(8)) - Number(a.slice(8))).map(py => path.join(tool, 'lib', py, 'site-packages'))
  for (const site of sites) {
    const bin = path.join(site, 'static_ffmpeg', 'bin')
    for (const d of ls(bin).map(n => path.join(bin, n))) if (fsSync.existsSync(path.join(d, exe('ffmpeg')))) return d
  }
  return null
}
// static-ffmpeg's wheel carries no ffmpeg: the binaries are downloaded the first time one of its commands runs, and
// `uv tool install` runs none — so on a fresh machine the folder above stayed empty and every remux and transcription
// went without. Setup's speech step and bin/install-ffmpeg.sh now run `static_ffmpeg_paths` once; this runs it for an
// install that predates them, and takes the folder from what it prints (`FFMPEG=<path>`). → absolute path | null
export async function ensureUvFfmpeg() {
  const have = uvFfmpegDir()
  if (have) return have
  const cmd = path.join(LOCAL_BIN, exe('static_ffmpeg_paths'))   // uv's tool commands, beside uv itself
  if (!fsSync.existsSync(cmd)) return null
  try {
    const { stdout } = await run(cmd, [], { timeout: 600000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    const ff = /^FFMPEG=(.+)$/m.exec(String(stdout))?.[1]?.trim()
    if (ff && fsSync.existsSync(ff)) return path.dirname(ff)
  } catch { }
  return uvFfmpegDir()
}
export async function findFfmpeg() {
  const uvDir = uvFfmpegDir()
  const candidates = [
    process.env.SLATE_FFMPEG,
    uvDir && path.join(uvDir, WIN ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(os.homedir(), '.local/share/slate/ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean)
  for (const c of candidates) { try { await fs.access(c, (await import('node:fs')).constants.X_OK); return c } catch {} }
  try { const { stdout } = await run(WIN ? 'where' : 'which', ['ffmpeg'], { windowsHide: true }); const p = stdout.trim().split(/\r?\n/)[0]; if (p) return p } catch { }
  // Last, static-ffmpeg's own download, for an install that never ran one of its commands (ensureUvFfmpeg above).
  const late = await ensureUvFfmpeg()
  return late ? path.join(late, exe('ffmpeg')) : null
}

const text = async url => { const r = await fetchSafe(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text() }

// Every .ts segment URL of a video, in play order, plus the stream's duration in seconds.
// → { base, segments: string[], seconds } — throws if the id resolves to no playlist.
export async function probe(idOrUrl) {
  const id = mymediaId(idOrUrl)
  if (!id) throw new Error(`not a MyMedia url: ${idOrUrl}`)
  const base = `${STREAM}/${id}.mp4`
  const master = await text(`${base}/playlist.m3u8`)
  const chunkName = master.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))
  if (!chunkName) throw new Error(`no chunklist in playlist for ${id}`)
  const chunk = await text(`${base}/${chunkName}`)
  const lines = chunk.split('\n').map(l => l.trim())
  const segments = lines.filter(l => l && !l.startsWith('#')).map(s => `${base}/${s}`)
  const seconds = lines.filter(l => l.startsWith('#EXTINF')).reduce((t, l) => t + (parseFloat(l.slice(8)) || 0), 0)
  return { id, base, segments, seconds }
}

// Download one MyMedia video to `dest` (an .mp4 path). Falls back to writing `dest` with a .ts extension
// when the machine has no ffmpeg — still playable, just not accepted by NotebookLM.
// → { path, bytes, seconds, container, segments } — throws on a failed segment, having written nothing.
export async function download(idOrUrl, dest, { onProgress } = {}) {
  const { id, segments, seconds } = await probe(idOrUrl)
  const parts = []
  for (const [i, url] of segments.entries()) {
    const r = await fetchSafe(url)
    if (!r.ok) throw new Error(`segment ${i + 1}/${segments.length} failed: ${r.status}`)
    parts.push(Buffer.from(await r.arrayBuffer()))
    onProgress?.(i + 1, segments.length)
  }
  const ts = Buffer.concat(parts)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const ff = await findFfmpeg()
  if (!ff) {
    const alt = dest.replace(/\.mp4$/i, '') + '.ts'
    await fs.writeFile(alt, ts)
    return { path: alt, bytes: ts.length, seconds, container: 'ts', segments: segments.length, id }
  }
  const tmp = path.join(os.tmpdir(), `mymedia-${id}-${process.pid}.ts`)
  await fs.writeFile(tmp, ts)
  try {
    // -bsf:a aac_adtstoasc rewrites the ADTS audio headers TS carries into the ASC form mp4 wants; without
    // it the remux writes a file whose audio most players refuse.
    await run(ff, ['-y', '-loglevel', 'error', '-i', tmp, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', dest], { windowsHide: true })
  } finally { await fs.rm(tmp, { force: true }) }
  const { size } = await fs.stat(dest)
  return { path: dest, bytes: size, seconds, container: 'mp4', segments: segments.length, id }
}

export const humanDuration = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
