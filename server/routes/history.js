// Version history (SPEC §20.10): read-only git queries for one page — which snapshots touched its `.md` or
// `.blocks.json`, and what either held at a given commit, parsed into the page shape the client knows.
//
//   GET /api/history?path=<rel .md>
//     → { path, available, now: { md, layout } | null, snapshots: [{ hash, at, subject, md: { added, removed } | null, layout: { added, removed } | null }] }
//       `now` states: 'clean' | 'changed' | 'untracked' | 'missing' (from `git status --porcelain`); snapshots newest first, ≤ 300.
//   GET /api/history/show?path=&hash=
//     → { hash, at, md: null | { text, frontmatter, frontmatterRaw, blocks }, layout: null | { version, elements }, stats: { blocks, words, documents, strokes, annotations } }
//       a file absent at that commit is null, not an error; a bad hash is 400.
//
// No restore route on purpose: the restore is the editor's own save (History.jsx → canvasRef.replace), so the
// hash check, the conflict banner, the SSE rules and ⌘Z all apply unchanged and nothing outside the editor can
// overwrite a page.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePage, plainText } from '../format.js'
import { hasDevTools } from '../devtools.js'
import { enabled } from '../edition.js'

const run = promisify(execFile)
const DOC_TYPES = new Set(['image', 'file', 'media', 'pdf'])
const nameOf = src => { try { return decodeURIComponent(String(src || '').split('/').pop()) } catch { return String(src || '').split('/').pop() } }

// git's porcelain quotes a path with unusual bytes as a C string: undo that for the comparison.
const unquote = s => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(["\\]|n|t|[0-7]{3})/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : /^[0-7]{3}$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : c)) : s)
const stateOf = (porcelain, rel) => {
  for (const raw of porcelain.split('\n')) {
    if (!raw) continue
    const xy = raw.slice(0, 2), rest = raw.slice(3)
    const p = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest
    if (unquote(p) !== rel) continue
    if (xy === '??') return 'untracked'
    if (xy.includes('D')) return 'missing'
    return 'changed'
  }
  return 'clean'
}

export function register(app, ctx) {
  const { store, ROOT, HttpError, wrap, q } = ctx
  const git = (...a) => run('git', ['-c', 'core.quotepath=off', ...a], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  // The root must be the repository itself (not a folder inside some other repo).
  let repoState = null   // cached: true | false
  const available = async () => {
    if (repoState !== null) return repoState
    // Without the developer tools `git` is a dialog, not a command (server/devtools.js); without History it is not wanted.
    if (!enabled('history') || !hasDevTools()) return (repoState = false)
    try {
      const { stdout } = await git('rev-parse', '--show-toplevel')
      repoState = path.resolve(await fs.realpath(stdout.trim())) === path.resolve(await fs.realpath(ROOT).catch(() => ROOT))
    } catch { repoState = false }
    return repoState
  }

  // → Map(hash → { hash, at, subject, added, removed, pathAt }) for one path, following renames. `pathAt` is the
  // file's name at that commit — a numstat line spells a rename as `dir/{old => new}.md` or `old => new` — so a
  // version from before a rename (the 2026-09-08 restructuring moved every page) can still be shown.
  const resolveRename = p => { const b = /^(.*?)\{(.*?) => (.*?)\}(.*)$/.exec(p); if (b) return b[1] + b[3] + b[4]; const w = /^(.*) => (.*)$/.exec(p); return w ? w[2] : p }
  async function logFor(rel) {
    const out = new Map()
    let stdout = ''
    try { ({ stdout } = await git('log', '--follow', '--format=%x01%H%x1f%ct%x1f%s', '--numstat', '--', rel)) } catch { return out }
    let cur = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('\x01')) { const [hash, at, subject] = line.slice(1).split('\x1f'); cur = { hash, at: Number(at), subject: subject || '', added: 0, removed: 0, pathAt: rel }; out.set(hash, cur); continue }
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      if (m && cur) { cur.added += m[1] === '-' ? 0 : Number(m[1]); cur.removed += m[2] === '-' ? 0 : Number(m[2]); cur.pathAt = resolveRename(m[3]) }
    }
    return out
  }

  app.get('/api/history', wrap(async (req, res) => {
    const rel = store.safeRel(q(req, 'path'))
    if (!rel.endsWith('.md')) throw new HttpError(400, 'a page path ends in .md')
    const d = store.derived(rel)
    if (!(await available())) return res.json({ path: rel, available: false, now: null, snapshots: [] })
    const [md, layout] = await Promise.all([logFor(d.md), logFor(d.layout)])
    // Two snapshots inside one second tie on %ct (a restore commits before and after the replace): git's walk order
    // over both files decides, so the newest row is the post-restore one. Pre-rename commits fall back to the hash.
    let seq = new Map()
    try { seq = new Map((await git('log', '--format=%H', '--', d.md, d.layout)).stdout.split('\n').filter(Boolean).map((h, i) => [h, i])) } catch { }
    const snapshots = [...new Set([...md.keys(), ...layout.keys()])].map(h => {
      const a = md.get(h), b = layout.get(h), any = a || b
      return { hash: h, at: any.at, subject: any.subject, md: a ? { added: a.added, removed: a.removed } : null, layout: b ? { added: b.added, removed: b.removed } : null }
    }).sort((x, y) => y.at - x.at || (seq.get(x.hash) ?? 1e9) - (seq.get(y.hash) ?? 1e9) || (x.hash < y.hash ? 1 : -1)).slice(0, 300)
    let porcelain = ''
    try { ({ stdout: porcelain } = await git('status', '--porcelain', '--untracked-files=all', '--', d.md, d.layout)) } catch { }
    res.json({ path: rel, available: true, now: { md: stateOf(porcelain, d.md), layout: stateOf(porcelain, d.layout) }, snapshots })
  }))

  app.get('/api/history/show', wrap(async (req, res) => {
    const rel = store.safeRel(q(req, 'path')), hash = String(q(req, 'hash') || '')
    if (!rel.endsWith('.md')) throw new HttpError(400, 'a page path ends in .md')
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new HttpError(400, 'bad hash')
    if (!(await available())) throw new HttpError(404, 'no snapshot repository in this root')
    const d = store.derived(rel)
    const show = async p => { try { return (await git('show', `${hash}:${p}`)).stdout } catch { return null } }
    // The file's name at that commit (renames followed); a short hash is matched by prefix.
    const [mdLog, layoutLog] = await Promise.all([logFor(d.md), logFor(d.layout)])
    const at_ = log => [...log.values()].find(e => e.hash.startsWith(hash))
    const mdPath = at_(mdLog)?.pathAt || d.md, layoutPath = at_(layoutLog)?.pathAt || d.layout
    const [mdText, layoutText, at] = await Promise.all([show(mdPath), show(layoutPath), git('show', '-s', '--format=%ct', hash).then(r => Number(r.stdout.trim()) || null).catch(() => null)])
    if (at === null && mdText === null && layoutText === null) throw new HttpError(404, 'no such snapshot')
    const md = mdText === null ? null : { text: mdText, ...parsePage(mdText) }
    let layout = null
    if (layoutText !== null) { try { layout = JSON.parse(layoutText); if (!layout || !Array.isArray(layout.elements)) layout = { version: 1, elements: [], corrupt: true } } catch { layout = { version: 1, elements: [], corrupt: true } } }
    const els = layout?.elements || []
    const stats = {
      blocks: md ? md.blocks.length : 0,
      words: md ? plainText(mdText).split(/\s+/).filter(Boolean).length : 0,
      documents: els.filter(e => DOC_TYPES.has(e.type)).map(e => nameOf(e.src)),
      strokes: els.filter(e => e.type === 'ink').reduce((n, e) => n + (Array.isArray(e.strokes) ? e.strokes.length : 0), 0),
      annotations: els.filter(e => e.type === 'highlight' || e.type === 'underline').length,
    }
    res.json({ hash, at, md, layout, stats })
  }))
}
