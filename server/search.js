// In-memory full-text index over every .md under ROOT. Rebuildable; never the truth. SPEC.md §10.
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './fs.js'
import { plainText } from './format.js'

export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const SKIP = new Set(['.trash', '.git', 'node_modules'])
// A week's `Plan.md` is the app's own storage for that week's ticks, not a document (SPEC §20.25). Every sentence on
// it was lifted from an announcement or a course outline, both of which are indexed, so indexing the plan too put
// the same task in the results twice — once on the page that said it and once on a scratch file nobody opens.
export const derived = rel => /\/Week [^/]*\/Plan\.md$/.test(String(rel || ''))
const docs = new Map()

function entry(rel, text) {
  const parts = rel.split('/')
  const body = plainText(text)
  const title = path.posix.basename(rel, '.md')
  return { path: rel, title, notebook: parts[0] || '', section: parts[1] || '', body, folded: fold(body), foldedTitle: fold(title) }
}

export async function build() {
  docs.clear()
  const walk = async relDir => {
    const ents = await fs.readdir(path.join(ROOT, relDir), { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      if (SKIP.has(e.name) || e.name.startsWith('.') || e.name.startsWith('_')) continue
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) { if (!e.name.endsWith('.assets')) await walk(rel) }
      else if (e.isFile() && e.name.endsWith('.md') && rel.split('/').length >= 3) await update(rel)   // pages live at notebook/section/page.md or deeper
    }
  }
  await walk('')
  return docs.size
}
export async function update(rel) {
  if (rel.split('/').length < 3) return
  if (rel.split('/').some(s => s.startsWith('.') || s.startsWith('_'))) return   // what the boot walk skips, the watcher skips: `_exports/x.md` was a phantom page
  if (derived(rel)) { docs.delete(rel); return }
  try { docs.set(rel, entry(rel, await fs.readFile(path.join(ROOT, rel), 'utf8'))) } catch { docs.delete(rel) }
}
export function remove(rel) { docs.delete(rel) }
export function removeDir(relDir) { for (const k of [...docs.keys()]) if (k === relDir || k.startsWith(relDir + '/')) docs.delete(k) }

export function titles() {
  return [...docs.values()].map(d => ({ path: d.path, title: d.title, notebook: d.notebook, section: d.section }))
}

export function search(q, limit = 50) {
  const needle = fold(q).trim()
  if (!needle) return []
  const out = []
  for (const d of docs.values()) {
    const snippets = []
    let i = -1, count = 0
    while ((i = d.folded.indexOf(needle, i + 1)) !== -1 && count < 200) {
      count++
      if (snippets.length < 3) {
        const a = Math.max(0, i - 60), b = Math.min(d.body.length, i + needle.length + 60)
        snippets.push({ text: (a > 0 ? '…' : '') + d.body.slice(a, b).replace(/\s+/g, ' ') + (b < d.body.length ? '…' : ''), at: i })
      }
    }
    const inTitle = d.foldedTitle.includes(needle)
    if (count || inTitle) out.push({ path: d.path, title: d.title, notebook: d.notebook, section: d.section, count, inTitle, snippets })
  }
  out.sort((a, b) => (b.inTitle - a.inTitle) || (b.count - a.count) || a.title.localeCompare(b.title))
  return out.slice(0, limit)
}
