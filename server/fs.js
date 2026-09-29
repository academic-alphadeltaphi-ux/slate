// Filesystem layer. Everything the app knows about notebooks lives on disk; this module is the
// only place that touches it. Paths are POSIX, relative to ROOT. See SPEC.md §3.
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { parsePage, joinPage, hashText, newId, isoNow } from './format.js'
import { notesRoot } from '../scripts/lib/root.mjs'
import { followTitle } from '../scripts/lib/move.mjs'
import { WIN, REAL_WIN, badNameChars } from '../scripts/lib/platform.mjs'

// Where the notebooks are: one answer for the server and every script (scripts/lib/root.mjs, SPEC §20.44).
export const ROOT = notesRoot([])
export const TRASH = path.join(ROOT, '.trash')

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra }
}

// ---- paths -------------------------------------------------------------------------------
const reserved = n => n.startsWith('.') || n.startsWith('_')
export function safeRel(rel) {
  const norm = path.posix.normalize(String(rel ?? '').replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '')
  if (norm === '.') return ''
  if (norm.split('/').some(seg => seg === '..' || seg === '')) throw new HttpError(400, `bad path: ${rel}`)
  return norm
}
export const abs = rel => path.join(ROOT, safeRel(rel))
// CON, PRN, AUX, NUL, COM1–9 and LPT1–9 are devices on Windows, with or without an extension: `Aux.md` cannot be made
// there. Refused on every machine, because a notebook moves between them (safeName in platform.mjs repairs the same
// names in titles it did not get from a person). `existing`: a page already on disk under such a name — a script named it
// on a Mac, where safeName leaves it be — can still be saved; only a new name or a rename is refused.
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i
export function assertTitle(t, { existing = false } = {}) {
  const s = String(t ?? '').trim()
  const device = !existing && DEVICE.test(s)
  if (!s || s.length > 200 || badNameChars(s) || device || reserved(s) || s.endsWith('.md') || s.endsWith('.assets') || s.endsWith('.blocks.json'))
    throw new HttpError(400, device ? `invalid name: ${t} — Windows keeps that name for a device, so a notebook with it could not open there`
      : WIN && /[<>"|?*]|[. ]$/.test(s) ? `invalid name: ${t} — Windows does not allow < > : " / \\ | ? * in a name, or a dot or space at the end` : `invalid name: ${t}`)
  return s
}
// A path a client may create, rename or trash: inside the root, and no `.`- or `_`-prefixed segment (`.trash`, `.git`,
// `_exports`, `Hub/_hub.json`). `reserved()` hid these from listings; nothing refused them as targets (review 2026-09-18).
export function assertContentPath(rel) {
  const norm = safeRel(rel)
  for (const seg of norm.split('/')) if (seg && reserved(seg)) throw new HttpError(400, `reserved name: ${seg}`)
  return norm
}
export const pageBase = relMd => relMd.replace(/\.md$/, '')
export const derived = relMd => {
  const b = pageBase(relMd)
  return { md: relMd, layout: b + '.blocks.json', assets: b + '.assets', children: b }
}
const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

// ---- atomic writes + own-write tracking (the watcher uses this to ignore echoes) ---------
export const recentWrites = new Map()   // file → Set of hashes written in the last few seconds
export const wroteRecently = (file, hash) => recentWrites.get(file)?.has(hash) || false
// On Windows a rename over a file OneDrive or Defender has open for a moment fails with EPERM, EBUSY or EACCES, and a
// page save came back 403. The holder lets go within a second: try again a few times (~1.5 s in all) before giving up.
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to) }
    catch (e) { if (!REAL_WIN || i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 50 * 2 ** i)) }
  }
}
export async function atomicWrite(file, content) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${crypto.randomBytes(4).toString('hex')}`)
  await fs.writeFile(tmp, content)
  await renameRetry(tmp, file)
  const h = hashText(typeof content === 'string' ? content : content.toString())
  if (!recentWrites.has(file)) recentWrites.set(file, new Set())
  recentWrites.get(file).add(h)
  setTimeout(() => { const set = recentWrites.get(file); if (set) { set.delete(h); if (!set.size) recentWrites.delete(file) } }, 8000).unref()
}

// ---- _slate.json ------------------------------------------------------------------------
export async function readMeta(relDir) {
  try { return JSON.parse(await fs.readFile(path.join(abs(relDir), '_slate.json'), 'utf8')) } catch { return {} }
}
export async function writeMeta(relDir, meta) {
  await atomicWrite(path.join(abs(relDir), '_slate.json'), JSON.stringify(meta, null, 2) + '\n')
}
function applyOrder(names, order) {
  const list = Array.isArray(order) ? order : []
  const set = new Set(names)
  const ordered = list.filter(n => set.has(n))
  const rest = names.filter(n => !list.includes(n)).sort(cmp)
  return [...ordered, ...rest]
}
async function listDirs(relDir) {
  const ents = await fs.readdir(abs(relDir), { withFileTypes: true }).catch(() => [])
  return ents.filter(e => e.isDirectory() && !reserved(e.name) && !e.name.endsWith('.assets')).map(e => e.name)
}
const isFolderLevel = relDir => relDir === '' || !relDir.includes('/')   // root or notebook: children are folders
async function appendOrder(relDir, name) {
  const meta = await readMeta(relDir)
  const names = isFolderLevel(relDir) ? await listDirs(relDir) : (await pages(relDir)).map(p => p.title)
  const order = applyOrder(names, meta.order)
  if (!order.includes(name)) order.push(name)
  await writeMeta(relDir, { ...meta, order })
}
async function dropFromOrder(relDir, name) {
  const meta = await readMeta(relDir)
  if (!Array.isArray(meta.order)) return
  await writeMeta(relDir, { ...meta, order: meta.order.filter(n => n !== name) })
}
async function renameInOrder(relDir, from, to) {
  const meta = await readMeta(relDir)
  if (!Array.isArray(meta.order)) return
  await writeMeta(relDir, { ...meta, order: meta.order.map(n => (n === from ? to : n)) })
}

// ---- tree --------------------------------------------------------------------------------
export async function tree() {
  const rootMeta = await readMeta('')
  const nbs = applyOrder(await listDirs(''), rootMeta.order)
  return Promise.all(nbs.map(async name => {
    const meta = await readMeta(name)
    const secs = applyOrder(await listDirs(name), meta.order)
    const sections = await Promise.all(secs.map(async s => {
      const m = await readMeta(`${name}/${s}`)
      return { name: s, path: `${name}/${s}`, color: m.color || null, icon: m.icon || null, label: m.label || null }
    }))
    return { name, path: name, color: meta.color || null, icon: meta.icon || null, label: meta.label || null, sections }
  }))
}

// Recursive page list for a section dir or a subpage dir.
export async function pages(relDir) {
  relDir = safeRel(relDir)
  const dir = abs(relDir)
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const mdTitles = ents.filter(e => e.isFile() && e.name.endsWith('.md') && !reserved(e.name)).map(e => e.name.slice(0, -3))
  const dirs = ents.filter(e => e.isDirectory() && !reserved(e.name) && !e.name.endsWith('.assets')).map(e => e.name)
  const titles = [...new Set([...mdTitles, ...dirs])]
  const meta = await readMeta(relDir)
  return Promise.all(applyOrder(titles, meta.order).map(async title => {
    const hasMd = mdTitles.includes(title)
    const st = hasMd ? await fs.stat(path.join(dir, title + '.md')).catch(() => null) : null
    let fm = {}
    if (hasMd) { try { const t = await fs.readFile(path.join(dir, title + '.md'), 'utf8'); if (t.startsWith('---')) fm = parsePage(t).frontmatter || {} } catch { } }
    return {
      title,
      path: relDir ? `${relDir}/${title}.md` : `${title}.md`,   // '' produced a leading slash
      virtual: !hasMd,
      modified: st ? st.mtimeMs : null,
      kind: typeof fm.kind === 'string' ? fm.kind : null,
      // Which class in its week a document belongs to: 'lecture' | 'tutorial' | 'both' (SPEC §20.38).
      for: typeof fm.for === 'string' ? fm.for : null,
      icon: typeof fm.icon === 'string' ? fm.icon : null,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      hasLayout: fss.existsSync(path.join(dir, title + '.blocks.json')),
      children: dirs.includes(title) ? await pages(`${relDir}/${title}`) : [],
    }
  }))
}

// One writer per file inside this process: writePage, writeLayout and patchFrontmatter read, check the hash and write, and
// two of them interleaving on the same file both passed the check (the pen's layout save beside the auto-recognition write).
const fileLocks = new Map()
export function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => { }).finally(() => { if (fileLocks.get(file) === tail) fileLocks.delete(file) })
  fileLocks.set(file, tail)
  return run
}

// ---- pages -------------------------------------------------------------------------------
export async function readPage(relMd) {
  relMd = safeRel(relMd)
  if (!relMd.endsWith('.md')) throw new HttpError(400, 'not a page')
  const d = derived(relMd)
  let text = null
  try { text = await fs.readFile(abs(relMd), 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const parsed = parsePage(text ?? '')
  let layout = null, layoutText = null
  try { layoutText = await fs.readFile(abs(d.layout), 'utf8'); layout = JSON.parse(layoutText) } catch { layout = null }
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.elements)) layout = { version: 1, elements: [] }
  const assets = (await fs.readdir(abs(d.assets)).catch(() => [])).filter(n => !reserved(n) && !/\.pdf\.txt$/i.test(n)).sort(cmp)   // <name>.pdf.txt is the search cache, not an asset (SPEC §20.6)
  return {
    path: relMd,
    title: path.posix.basename(relMd, '.md'),
    dir: path.posix.dirname(relMd),
    exists: text !== null,
    frontmatter: parsed.frontmatter,
    frontmatterRaw: parsed.frontmatterRaw,
    blocks: parsed.blocks,
    hash: text === null ? null : hashText(text),
    layout,
    layoutHash: layoutText === null ? null : hashText(layoutText),
    assets,
  }
}

// A page must live in a section and be a legal name — the same rules createPage applies. Without this, PUT could
// write the root's CLAUDE.md, a reserved `_name`, a dotfile, or invent a four-deep tree (SPEC §20.20).
export function assertPagePath(relMd) {
  const rel = safeRel(relMd)
  if (!rel.endsWith('.md')) throw new HttpError(400, 'not a page')
  const parts = rel.slice(0, -3).split('/')
  if (parts.length < 3) throw new HttpError(400, 'a page lives in a notebook and a section')
  for (const seg of parts) { if (!seg || seg.startsWith('_') || seg.startsWith('.')) throw new HttpError(400, `bad name: ${seg}`) }
  assertTitle(parts[parts.length - 1], { existing: true })
  return rel
}
export async function writePage(relMd, { frontmatter, frontmatterRaw, blocks }, baseHash) {
  assertPagePath(relMd)
  relMd = safeRel(relMd)
  if (!relMd.endsWith('.md')) throw new HttpError(400, 'not a page')
  const file = abs(relMd)
  return withFileLock(file, () => writePageLocked(relMd, file, { frontmatter, frontmatterRaw, blocks }, baseHash))
}
async function writePageLocked(relMd, file, { frontmatter, frontmatterRaw, blocks }, baseHash) {
  let current = null
  try { current = await fs.readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const currentHash = current === null ? null : hashText(current)
  if (baseHash !== undefined && baseHash !== currentHash) throw new HttpError(409, 'page changed on disk', { current: await readPage(relMd) })
  if (!Array.isArray(blocks)) throw new HttpError(400, 'blocks must be an array')
  const seen = new Set()
  const fixed = blocks.map((b, i) => {
    let id = b.id && /^[a-z0-9]{6}$/.test(b.id) && !seen.has(b.id) ? b.id : null
    if (!id && i !== 0) { do id = newId(); while (seen.has(id)) }
    if (id) seen.add(id)
    return { id, md: String(b.md ?? '') }
  })
  const header = frontmatterRaw !== undefined ? frontmatterRaw : (current === null ? null : parsePage(current).frontmatterRaw)
  const text = joinPage({ frontmatter, frontmatterRaw: header, blocks: fixed })
  if (text === current) return { hash: currentHash, unchanged: true, blocks: fixed }
  await atomicWrite(file, text)
  return { hash: hashText(text), blocks: fixed }
}

// Pretty JSON puts every number of every ink point on its own line (a 60-stroke page was 680 KB).
// Keep the file readable but put each stroke's points on one line.
export function compactPoints(json) {
  return json.replace(/"points": \[\s*((?:\[[^\[\]]*\]\s*,?\s*)*)\]/g, (m, inner) => {
    const pts = inner.match(/\[[^\[\]]*\]/g) || []
    return '"points": [' + pts.map(a => '[' + a.slice(1, -1).split(',').map(x => x.trim()).join(', ') + ']').join(', ') + ']'
  })
}

export async function writeLayout(relMd, layout, baseLayoutHash) {
  relMd = assertPagePath(relMd)   // the same guard as writePage: no sidecar for the root's CLAUDE.md, a `_name` or a dotfile
  const d = derived(relMd)
  const file = abs(d.layout)
  return withFileLock(file, () => writeLayoutLocked(relMd, file, layout, baseLayoutHash))
}
async function writeLayoutLocked(relMd, file, layout, baseLayoutHash) {
  let current = null
  try { current = await fs.readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const currentHash = current === null ? null : hashText(current)
  if (baseLayoutHash !== undefined && baseLayoutHash !== currentHash) throw new HttpError(409, 'layout changed on disk', { current: await readPage(relMd) })
  if (!layout || !Array.isArray(layout.elements)) throw new HttpError(400, 'layout.elements must be an array')
  const clean = { version: 1, ...layout, elements: layout.elements.filter(e => e && typeof e === 'object' && e.id && e.type) }
  const text = compactPoints(JSON.stringify(clean, null, 2)) + '\n'
  if (text === current) return { layoutHash: currentHash, unchanged: true }
  // A page with nothing pinned has no sidecar to write — unless it carries a mode, which is the one piece of layout
  // a page of plain markdown can still have (SPEC §20.28). Without this, switching a text-only page to Document
  // looked right until it was reopened.
  if (current === null && clean.elements.length === 0 && !clean.mode) return { layoutHash: null, unchanged: true }
  await atomicWrite(file, text)
  return { layoutHash: hashText(text) }
}

// ---- create / rename / trash / reorder --------------------------------------------------
async function exists(p) { try { await fs.access(p); return true } catch { return false } }

export async function createNotebook(name) {
  name = assertTitle(name)
  if (await exists(abs(name))) throw new HttpError(409, 'notebook exists')
  await fs.mkdir(abs(name))
  await appendOrder('', name)
  return { path: name }
}
export async function createSection(notebook, name) {
  notebook = safeRel(notebook); name = assertTitle(name)
  if (!notebook || notebook.includes('/')) throw new HttpError(400, 'notebook path must be a top-level folder')
  const rel = `${notebook}/${name}`
  if (await exists(abs(rel))) throw new HttpError(409, 'section exists')
  await fs.mkdir(abs(rel), { recursive: true })
  await appendOrder(notebook, name)
  return { path: rel }
}
// dir = section dir, or a parent page's children dir (pageBase of the parent .md)
export async function createPage(dir, title) {
  dir = assertContentPath(dir); title = assertTitle(title)
  if (dir.split('/').length < 2) throw new HttpError(400, 'pages live inside sections')
  const rel = `${dir}/${title}.md`
  if (await exists(abs(rel))) throw new HttpError(409, 'page exists')
  await atomicWrite(abs(rel), `---\ncreated: "${isoNow()}"\n---\n`)
  await appendOrder(dir, title)
  return { path: rel }
}

export async function rename(rel, newName) {
  rel = assertContentPath(rel); newName = assertTitle(newName)
  const parent = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
  if (rel.endsWith('.md')) {
    const from = derived(rel), to = derived(`${parent ? parent + '/' : ''}${newName}.md`)
    // All four parts, or none (SPEC §3). Checking only the page and its subpage folder let a stale `<new>.blocks.json` or
    // `<new>.assets/` be overwritten in silence, and a rename that failed on its third part left the page split between two
    // names; scripts/lib/move.mjs already did this right.
    const parts = ['md', 'layout', 'assets', 'children']
    for (const k of parts) if (await exists(abs(to[k]))) throw new HttpError(409, `a page with that name exists (${path.posix.basename(to[k])})`)
    const done = []
    try { for (const k of parts) if (await exists(abs(from[k]))) { await fs.rename(abs(from[k]), abs(to[k])); done.push(k) } }
    catch (e) { for (const k of done.reverse()) await fs.rename(abs(to[k]), abs(from[k])).catch(() => { }); throw e }
    // The assets folder moved with the page, so every element `src` and image link still naming `<Old>.assets/` would 404:
    // every PDF, image and recording on a renamed page went dark until it was renamed back (review 2026-09-18).
    try { await followTitle(ROOT, from.md, to.md) }
    catch (e) { for (const k of done.reverse()) await fs.rename(abs(to[k]), abs(from[k])).catch(() => { }); throw e }
    await renameInOrder(parent, path.posix.basename(rel, '.md'), newName)
    return { path: to.md }
  }
  const to = `${parent ? parent + '/' : ''}${newName}`
  if (await exists(abs(to))) throw new HttpError(409, 'a folder with that name exists')
  await fs.rename(abs(rel), abs(to))
  await renameInOrder(parent, path.posix.basename(rel), newName)
  return { path: to }
}

export async function trash(rel) {
  rel = assertContentPath(rel)
  if (!rel) throw new HttpError(400, 'cannot trash the root')
  const parent = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const moveOne = async r => {
    if (!(await exists(abs(r)))) return
    let target = path.join(TRASH, r)
    if (await exists(target)) target = path.join(TRASH, `${r}.${stamp}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(abs(r), target)
  }
  if (rel.endsWith('.md')) {
    const d = derived(rel)
    for (const k of ['md', 'layout', 'assets', 'children']) await moveOne(d[k])
    await dropFromOrder(parent, path.posix.basename(rel, '.md'))
  } else {
    await moveOne(rel)
    await dropFromOrder(parent, path.posix.basename(rel))
  }
  return { trashed: rel }
}

export async function reorder(relDir, order) {
  relDir = safeRel(relDir)
  if (!Array.isArray(order) || !order.every(n => typeof n === 'string')) throw new HttpError(400, 'order must be a string array')
  const meta = await readMeta(relDir)
  await writeMeta(relDir, { ...meta, order })
  return { ok: true }
}
const META_KEYS = new Set(['color', 'icon', 'label', 'highlights'])
export async function setMeta(relDir, patch) {
  relDir = safeRel(relDir)
  const meta = await readMeta(relDir)
  for (const [k, v] of Object.entries(patch || {})) {
    if (!META_KEYS.has(k)) throw new HttpError(400, `unknown meta key: ${k}`)
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) { delete meta[k]; continue }
    if (k === 'color' && !/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, 'color must be #rrggbb')
    if (k === 'highlights' && !(Array.isArray(v) && v.every(h => h && /^#[0-9a-fA-F]{6}$/.test(h.color) && typeof h.label === 'string'))) throw new HttpError(400, 'highlights must be [{ color, label }]')
    meta[k] = typeof v === 'string' ? v.slice(0, 200) : v
  }
  await writeMeta(relDir, meta)
  return meta
}

// Edit YAML frontmatter keys line by line so every other byte of the header survives.
export async function patchFrontmatter(relMd, patch) {
  relMd = assertPagePath(relMd)   // a PUT naming `CLAUDE.md` used to prepend YAML to the contract file at the root
  const file = abs(relMd)
  return withFileLock(file, () => patchFrontmatterLocked(file, patch))
}
async function patchFrontmatterLocked(file, patch) {
  let text = ''
  try { text = await fs.readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  const body = m ? text.slice(m[0].length) : text
  const lines = m && m[1].trim() ? m[1].split(/\r?\n/) : []
  const yaml = v => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(String(x))).join(', ')}]` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)))
  for (const [k, v] of Object.entries(patch || {})) {
    if (!/^[A-Za-z_][\w-]*$/.test(k)) throw new HttpError(400, `bad frontmatter key: ${k}`)
    const idx = lines.findIndex(l => l.startsWith(k + ':'))
    if (idx >= 0) { let n = 1; while (idx + n < lines.length && /^\s/.test(lines[idx + n])) n++; lines.splice(idx, n) }
    const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
    if (!empty) lines.splice(idx >= 0 ? idx : lines.length, 0, `${k}: ${yaml(v)}`)
  }
  const next = (lines.length ? `---\n${lines.join('\n')}\n---\n` : '') + body
  if (next !== text) await atomicWrite(file, next)
  const parsed = parsePage(next)
  return { hash: hashText(next), frontmatter: parsed.frontmatter, frontmatterRaw: parsed.frontmatterRaw }
}

export async function setColor(relDir, color) {
  relDir = safeRel(relDir)
  if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'color must be #rrggbb or null')
  const meta = await readMeta(relDir)
  if (color === null) delete meta.color; else meta.color = color
  await writeMeta(relDir, meta)
  return { ok: true }
}

// ---- assets ------------------------------------------------------------------------------
const KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'heic'],
  media: ['mp4', 'mov', 'webm', 'm4a', 'mp3', 'wav', 'ogg', 'aac', 'flac'],
  pdf: ['pdf'],
}
export function kindOf(name) {
  const ext = name.toLowerCase().split('.').pop()
  for (const [k, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return k
  return 'file'
}
export function safeAssetName(name) {
  let s = path.basename(String(name || 'file')).replace(WIN ? /[\x00-\x1f\/\\:*?"<>|]/g : /[\x00-\x1f\/\\:]/g, '').trim()
  if (WIN) s = s.replace(/[. ]+$/, '')
  if (!s || reserved(s)) s = 'file-' + s.replace(/^[._]+/, '')
  return s.slice(0, 180)
}
export async function saveAsset(relMd, name, stream) {
  relMd = assertPagePath(relMd)   // an upload names a real page, never `Hub/_hub.md` or a path outside a section
  const d = derived(relMd)
  const dir = abs(d.assets)
  await fs.mkdir(dir, { recursive: true })
  let base = safeAssetName(name)
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length)
  let n = 1
  while (await exists(path.join(dir, base))) base = `${stem} (${++n})${ext}`
  const tmp = path.join(dir, `.tmp-${base}-${crypto.randomBytes(4).toString('hex')}`)
  await new Promise((res, rej) => {
    const ws = fss.createWriteStream(tmp)
    stream.on('error', rej); ws.on('error', rej); ws.on('finish', res)
    stream.pipe(ws)
  })
  await renameRetry(tmp, path.join(dir, base))   // Defender scans a file it has just seen written
  const st = await fs.stat(path.join(dir, base))
  return { name: base, src: `${path.posix.basename(d.assets)}/${base}`, kind: kindOf(base), size: st.size }
}

// Move one attachment to .trash (mirrored path). The element is removed by the client.
export async function trashAsset(relMd, src) {
  relMd = safeRel(relMd)
  const d = derived(relMd)
  const rel = safeRel(`${path.posix.dirname(relMd)}/${src}`)
  if (!rel.startsWith(d.assets + '/')) throw new HttpError(400, 'not an asset of this page')
  if (!(await exists(abs(rel)))) throw new HttpError(404, 'asset not found')
  let target = path.join(TRASH, rel)
  if (await exists(target)) target = path.join(TRASH, `${rel}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(abs(rel), target)
  return { trashed: rel }
}
export const absPathOf = rel => abs(rel)
// Show a file in Finder or Explorer (`reveal`), or open it in its own app. `open` does nothing on a PC. Explorer wants
// `/select,"<path>"` as written (Node would quote the switch with the path), so the line is passed verbatim — a Windows
// path cannot hold a `"` — and it exits 1 even when it worked, so its code is no error. No windowsHide: Explorer has no
// console to hide, and hiding its first window is the one thing that could go wrong.
export function openInShell(file, { reveal = false } = {}) {
  if (REAL_WIN) return execFile('explorer.exe', [reveal ? `/select,"${file}"` : `"${file}"`], { windowsVerbatimArguments: true }, () => { })
  execFile('open', [...(reveal ? ['-R'] : []), file], err => { if (err) console.error('[open]', err.message) })
}

export async function ensureRoot() {
  await fs.mkdir(ROOT, { recursive: true })
  await fs.mkdir(TRASH, { recursive: true })
}
