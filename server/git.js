// Automatic snapshots of the text layer. Safety net, not a workflow. SPEC.md §9.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './fs.js'
import { hasDevTools } from './devtools.js'
import { enabled } from './edition.js'
const run = promisify(execFile)
const git = (...args) => run('git', args, { cwd: ROOT, windowsHide: true })
let available = true

export async function ensureRepo() {
  // Never wake Apple's install dialog: without the developer tools `git` is a shim, and an edition without History has
  // no use for snapshots at all (SPEC §21).
  if (!enabled('history')) { available = false; console.log('[git] snapshots are off in this edition'); return }
  if (!hasDevTools()) { available = false; console.warn('[git] no developer tools on this Mac, snapshots disabled'); return }
  try { await run('git', ['--version'], { windowsHide: true }) } catch { available = false; console.warn('[git] not found, snapshots disabled'); return }
  try { await git('rev-parse', '--is-inside-work-tree') }
  catch {
    await git('init', '-q')
    await fs.writeFile(path.join(ROOT, '.gitignore'), '*.assets/\n.DS_Store\n.tmp-*\n_exports/\n')   // _exports/: exported binders, never content (SPEC §20.10)
    console.log('[git] initialised snapshot repo in', ROOT)
  }
}
export async function snapshot() {
  if (!available) return { skipped: true }
  const { stdout } = await git('status', '--porcelain')
  if (!stdout.trim()) return { clean: true }
  await git('add', '-A')
  await git('-c', 'user.name=slate', '-c', 'user.email=slate@localhost', 'commit', '-q', '-m', `snapshot ${new Date().toISOString()}`)
  return { committed: true }
}
export function schedule(minutes = 5) {
  const t = setInterval(() => snapshot().catch(e => console.error('[git]', e.message)), minutes * 60 * 1000)
  t.unref()
}
