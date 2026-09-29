// Watch ROOT, ignore our own writes, keep the search index fresh, fan events out over SSE. SPEC.md §8.
import chokidar from 'chokidar'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT, recentWrites, wroteRecently } from './fs.js'
import { hashText } from './format.js'
import * as search from './search.js'
// The document index (SPEC §20.6) is the search group's module; until it lands, events simply do not reach it.
const docIndex = await import('./doc-index.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e })

const clients = new Set()
export function subscribe(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(': connected\n\n')
  clients.add(res)
  res.on('close', () => clients.delete(res))
}
export function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const c of clients) c.write(data)
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 25000).unref()

const ignored = p => /(^|\/)(\.git|\.trash|node_modules|_exports)(\/|$)/.test(p) || /\/\.tmp-/.test(p) || /\.DS_Store$/.test(p)

function classify(rel) {
  const base = path.posix.basename(rel)
  if (base === '_slate.json') return 'meta'
  if (rel.endsWith('.blocks.json')) return 'layout'
  if (rel.endsWith('.md')) return 'md'
  if (rel.includes('.assets/')) return 'asset'
  return 'other'
}

export function start() {
  const watcher = chokidar.watch(ROOT, { ignored, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 } })
  watcher.on('all', async (type, absPath) => {
    const rel = path.relative(ROOT, absPath).split(path.sep).join('/')
    if (!rel) return
    // Our own writes still refresh the index, but clients are not told: they already have that content.
    let mine = false
    if ((type === 'change' || type === 'add') && recentWrites.has(absPath)) {
      try { mine = wroteRecently(absPath, hashText(await fs.readFile(absPath, 'utf8'))) } catch { }
    }
    const kind = classify(rel)
    if (kind === 'md') { if (type === 'unlink') search.remove(rel); else await search.update(rel) }
    if (type === 'unlinkDir') search.removeDir(rel)
    if (docIndex?.onEvent) { try { await docIndex.onEvent(type, rel, kind) } catch (e) { console.error('[doc-index]', e.message) } }   // own writes included, like the md index
    // The PDF-text cache (<name>.pdf.txt) is never news to a client.
    if (!mine && !/\.pdf\.txt$/i.test(rel)) broadcast({ type, path: rel, kind, at: Date.now() })
  })
  watcher.on('error', e => console.error('[watch]', e.message))
  return watcher
}
