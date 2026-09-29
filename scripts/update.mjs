#!/usr/bin/env node
// Update in place (SPEC §21.10). The copy asks GitHub for the newest release of its own edition and machine and swaps its
// code for that release's — in this same folder, so the notes (which live elsewhere), setup's state, the course file and
// the scheduled tasks bound to this folder all stay as they are. A brother says "update Slate"; their Claude runs
//   node scripts/update.mjs --check [--json]            is there a newer copy?
//   node scripts/update.mjs [--json]                    take it: download, swap, rebuild the app
//   node scripts/update.mjs --rollback [--json]         put back what the last update replaced
//   … [--repo <org>/<name>] [--tag <vYYYY.MM.DD>]      a copy that was not installed from GitHub; a release other than the latest
// Never touched: courses.json, slate.config.json, setup-state.json, Setup progress.md, setup-downloads/, node_modules/,
// dist/, and the two course files setup rendered (scripts/lib/terms.mjs, syllabus.mjs), which it renders again with the
// new code. A shipped file their Claude changed by hand is set aside in setup-downloads/, never lost, and named.
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { THIS as ED } from '../src/edition.js'
import { REAL_WIN, npmSpawn } from './lib/platform.mjs'
import { configuredRoot } from './lib/root.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const JSON_OUT = args.includes('--json'), CHECK = args.includes('--check'), ROLLBACK = args.includes('--rollback')
const KIT = path.join(REPO, 'kit.json'), ASIDE = path.join(REPO, 'setup-downloads')
// what setup, the course file or their Claude wrote into this folder — a release never carries them and never replaces them
const KEEP = [/^courses\.json$/, /^slate\.config\.json$/, /^setup-state\.json$/, /^Setup progress\.md$/, /^setup-downloads\//, /^node_modules\//, /^dist\//,
  /^\.claude\/settings\.local\.json$/, /^scripts\/lib\/(terms|syllabus)\.mjs$/, /^kit\.json$/]
const kept = rel => KEEP.some(re => re.test(rel))
// npm rewrites the lock on every install (the kit renames the package): replaced like any file, never called a hand edit
const byHand = (rel, here, shipped) => !!shipped && here !== shipped && rel !== 'package-lock.json'
class Stop extends Error { }
const stop = (text, extra = {}) => { throw Object.assign(new Stop(text), { extra }) }
const say = s => { if (!JSON_OUT) console.log(s) }
// The exit waits for stdout to drain: a pipe on a Mac is asynchronous and process.exit() cuts it (run.mjs, the same fix).
const end = (obj, text) => { process.stdout.write((JSON_OUT ? JSON.stringify(obj) : text) + '\n', () => process.exit(obj.ok === false ? 1 : 0)) }
const sha = p => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12)
const node = (script, a, o = {}) => spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...a], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20, ...o })
const readKit = () => { try { return JSON.parse(fs.readFileSync(KIT, 'utf8')) } catch { return null } }

// ---- where the updates live --------------------------------------------------------------------------------------------------
const kit = readKit() || {}
const REPO_NAME = opt('--repo', kit.repo || null)
// the zip this copy is: its edition and its machine, named as the release names them (scripts/publish.mjs)
const ASSET = kit.asset || `slate-adphi-${kit.edition === 'adphi-max' ? 'max' : 'pro'}-${kit.os || (REAL_WIN ? 'windows' : 'mac')}.zip`

async function latest() {
  if (!REPO_NAME) stop('This copy was not installed from GitHub, so it does not know where its updates live. Ask whoever gave you Slate for the repository\'s name, then: node scripts/update.mjs --repo <org>/<name>', { reason: 'no-repo' })
  // SLATE_UPDATE_API: a stand-in GitHub for the scenarios, beside their stand-in Quercus (scripts/sim/quercus-mock.mjs)
  const tag = opt('--tag'), url = `${process.env.SLATE_UPDATE_API || 'https://api.github.com'}/repos/${REPO_NAME}/releases/${tag ? `tags/${tag}` : 'latest'}`
  let r = null
  try { r = await fetch(url, { headers: { 'User-Agent': 'slate-update', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) }) }
  catch (e) { stop(`GitHub could not be reached (${e.cause?.code || e.name}). Check the wifi and try again.`, { reason: 'offline' }) }
  if (r.status === 404) stop(`${REPO_NAME} has ${tag ? `no release ${tag}` : 'no release yet'}, or the repository is not public.`, { reason: 'no-release' })
  if (!r.ok) stop(`GitHub answered ${r.status}. Try again in a few minutes.`, { reason: 'github' })
  const rel = await r.json(), a = (rel.assets || []).find(x => x.name === ASSET)
  if (!a) stop(`Release ${rel.tag_name} has no ${ASSET}. Tell whoever looks after Slate.`, { reason: 'no-asset', tag: rel.tag_name })
  return { tag: rel.tag_name, url: a.browser_download_url, bytes: a.size, published: String(rel.published_at || '').slice(0, 10) }
}

// ---- what must be quiet first -----------------------------------------------------------------------------------------------
// The app open: its server holds this folder's code, and on Windows its program files are locked while it runs.
async function appOpen() {
  for (let p = ED.port || 5178, n = 0; n < 20; p++, n++) {
    try { const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) }); if (!r.ok) continue; const h = await r.json(); if (h.repo && path.resolve(h.repo) === REPO) return true } catch { }
  }
  return false
}
// A check running: the morning's lock in the notes (scripts/run.mjs) — swapping its code under it would mix two versions.
function checkRunning() {
  const root = (() => { try { return configuredRoot() } catch { return null } })(); if (!root) return false
  try { const l = JSON.parse(fs.readFileSync(path.join(root, 'Hub', '_runs.lock'), 'utf8')); if (!l?.pid) return false; process.kill(l.pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// ---- unpacking -------------------------------------------------------------------------------------------------------------
// Both tools come with the system: ditto on every Mac, and Windows' own tar.exe (bsdtar, which reads zip) — named by its full
// path, because Git for Windows puts a GNU tar first on the PATH, and GNU tar cannot open a zip.
function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const r = REAL_WIN ? spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest], { encoding: 'utf8', windowsHide: true })
    : spawnSync('/usr/bin/ditto', ['-x', '-k', zip, dest], { encoding: 'utf8' })
  if (r.status !== 0) stop(`The download could not be unpacked: ${String(r.stderr || r.error?.message || '').trim().slice(0, 200)}`, { reason: 'unzip' })
}

// ---- the swap ----------------------------------------------------------------------------------------------------------------
// Every file this replaces or removes is copied first into setup-downloads/update-<from>-<when>/before/, with a manifest, so
// --rollback puts the folder back exactly. A shipped file whose hash is not the one the old release shipped was changed here
// by hand: it is replaced too (the new code expects its own), and named, so their Claude can carry the change over.
async function swap(next, nextKit) {
  const when = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(ASIDE, `update-${kit.tag || 'untagged'}-${when}`), before = path.join(dir, 'before')
  const had = kit.files || {}, want = nextKit.files || {}
  const log = { from: kit.tag || null, to: nextKit.tag || null, at: new Date().toISOString(), replaced: [], added: [], removed: [], edited: [] }
  const aside = async rel => { const to = path.join(before, rel); await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.copyFile(path.join(REPO, rel), to) }
  for (const rel of Object.keys(want)) {
    if (kept(rel)) continue
    const here = path.join(REPO, rel), src = path.join(next, rel)
    if (fs.existsSync(here)) {
      const h = sha(here); if (h === want[rel]) continue
      if (byHand(rel, h, had[rel])) log.edited.push(rel)
      await aside(rel); log.replaced.push(rel)
    } else log.added.push(rel)
    await fsp.mkdir(path.dirname(here), { recursive: true }); await fsp.copyFile(src, here)
  }
  for (const rel of Object.keys(had)) {
    if (kept(rel) || want[rel] || !fs.existsSync(path.join(REPO, rel))) continue
    if (byHand(rel, sha(path.join(REPO, rel)), had[rel])) log.edited.push(rel)
    await aside(rel); await fsp.rm(path.join(REPO, rel), { force: true }); log.removed.push(rel)
  }
  await fsp.mkdir(dir, { recursive: true }); await fsp.copyFile(KIT, path.join(dir, 'kit.json'))
  await fsp.writeFile(path.join(dir, 'update.json'), JSON.stringify(log, null, 2) + '\n')
  // the new stamp carries where it came from, so the next update needs no --repo
  await fsp.writeFile(KIT, JSON.stringify({ ...nextKit, repo: nextKit.repo || REPO_NAME, asset: nextKit.asset || ASSET }, null, 2) + '\n')
  return { dir, log }
}
async function rollback() {
  const dirs = fs.existsSync(ASIDE) ? fs.readdirSync(ASIDE).filter(d => d.startsWith('update-') && fs.existsSync(path.join(ASIDE, d, 'update.json'))).sort() : []
  if (!dirs.length) stop('There is no earlier update to go back from.', { reason: 'nothing' })
  const dir = path.join(ASIDE, dirs[dirs.length - 1]), log = JSON.parse(fs.readFileSync(path.join(dir, 'update.json'), 'utf8'))
  for (const rel of log.added) await fsp.rm(path.join(REPO, rel), { force: true })
  for (const rel of [...log.replaced, ...log.removed]) { const to = path.join(REPO, rel); await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.copyFile(path.join(dir, 'before', rel), to) }
  await fsp.copyFile(path.join(dir, 'kit.json'), KIT)
  await fsp.rename(dir, dir + '-rolled-back')
  return log
}

// ---- after the swap: what the new code needs --------------------------------------------------------------------------------
function rebuild(log) {
  const steps = []
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'setup-state.json'), 'utf8')) } catch { return { done: {} } } })()
  // a new package-lock is new dependencies: npm installs what changed (and Electron, if its version did, on the app step)
  if (log.replaced.includes('package-lock.json') || log.added.includes('package-lock.json')) {
    say('Installing the new dependencies…')
    const r = npmSpawn('npm', ['install', '--no-fund', '--no-audit'], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 })
    if (r.status !== 0) stop(`npm install failed — usually the network. Run node scripts/update.mjs again, or node scripts/update.mjs --rollback.\n${String(r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n')}`, { reason: 'deps', ...log })
    steps.push('dependencies')
  }
  // the course files, rendered again by the new renderer from the same courses.json
  if (state.done?.courses && fs.existsSync(path.join(REPO, 'courses.json'))) {
    const r = node('setup.mjs', ['courses', 'write']); if (r.status !== 0) stop(`The course file could not be written again:\n${(r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n')}`, { reason: 'courses', ...log })
    steps.push('course file')
  }
  // the app itself: the client built again and the bundle (or the Windows program) replaced
  if (state.done?.app) {
    say('Rebuilding the app…')
    const r = node('setup.mjs', ['app']); if (r.status !== 0) stop(`The app could not be rebuilt:\n${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}\nnode scripts/update.mjs --rollback puts the old version back.`, { reason: 'app', ...log })
    steps.push('app')
  }
  // the schedule is bound to this folder, which has not moved; say so if a task has gone missing all the same
  let schedule = null
  if (state.done?.schedule) { const r = node('setup.mjs', ['schedule', '--check']); schedule = r.status === 0 ? 'in place' : (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') }
  return { steps, schedule }
}

// ---- the commands ------------------------------------------------------------------------------------------------------------
try {
  if (!kit.edition) stop('This folder has no kit.json, so it is not an installed copy of Slate (the development repository updates with git).', { reason: 'no-kit' })
  if (ROLLBACK) {
    if (await appOpen()) stop(`Close ${ED.app} first (it is open and uses these files), then say "go back" again.`, { reason: 'app-open' })
    const log = await rollback(); const after = rebuild(log)   // the same files, the other way: a lock the update brought is undone too
    end({ ok: true, kind: 'rollback', from: log.to, to: log.from, ...after }, `Back to ${log.from || 'the version before'}: ${log.replaced.length + log.removed.length} file(s) restored, ${log.added.length} removed${after.steps.length ? `; rebuilt: ${after.steps.join(', ')}` : ''}. Open ${ED.app} again.`)
  } else {
    const rel = await latest()
    if (rel.tag === kit.tag) end({ ok: true, kind: 'check', current: kit.tag, latest: rel.tag, update: false }, `Slate is up to date (${kit.tag}).`)
    else if (CHECK) end({ ok: true, kind: 'check', current: kit.tag || null, latest: rel.tag, published: rel.published, update: true }, `A newer Slate is out: ${rel.tag} (published ${rel.published}); this copy is ${kit.tag || 'from before the releases had names'}. Updating takes a few minutes and keeps every note and setting: node scripts/update.mjs`)
    else {
      if (await appOpen()) stop(`Close ${ED.app} first (it is open and uses these files), then say "update Slate" again.`, { reason: 'app-open' })
      if (checkRunning()) stop('The Quercus check is running right now. Try again when it has finished (a few minutes).', { reason: 'check-running' })
      say(`Downloading ${ASSET} (${rel.tag}, ${(rel.bytes / 1048576).toFixed(1)} MB)…`)
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'slate-update-')), zip = path.join(work, ASSET)
      let r = null
      try { r = await fetch(rel.url, { headers: { 'User-Agent': 'slate-update' }, signal: AbortSignal.timeout(300_000) }) } catch (e) { stop(`The download failed (${e.cause?.code || e.name}). Check the wifi and try again.`, { reason: 'offline' }) }
      if (!r.ok) stop(`The download failed: GitHub answered ${r.status}.`, { reason: 'download' })
      await fsp.writeFile(zip, Buffer.from(await r.arrayBuffer()))
      unzip(zip, path.join(work, 'x'))
      const next = path.join(work, 'x', 'Slate'), nextKit = (() => { try { return JSON.parse(fs.readFileSync(path.join(next, 'kit.json'), 'utf8')) } catch { return null } })()
      // the right copy, or nothing: another edition or another machine's zip would swap in the wrong words and the wrong tools
      if (!nextKit?.files) stop(`${ASSET} is not a Slate copy (no kit.json inside). Nothing was changed.`, { reason: 'bad-zip' })
      if (nextKit.edition !== kit.edition || (nextKit.os || 'mac') !== (kit.os || 'mac')) stop(`${ASSET} is the ${nextKit.edition} copy for ${nextKit.os}, and this is ${kit.edition} for ${kit.os}. Nothing was changed.`, { reason: 'wrong-copy' })
      const { dir, log } = await swap(next, { ...nextKit, tag: nextKit.tag || rel.tag })
      await fsp.rm(work, { recursive: true, force: true })
      const after = rebuild(log)
      const edited = log.edited.length ? `\n${log.edited.length} file(s) had been changed here by hand and now have the new version: ${log.edited.join(', ')} — the old ones are in ${path.relative(REPO, dir)}/before/.` : ''
      end({ ok: true, kind: 'update', from: log.from, to: log.to, replaced: log.replaced.length, added: log.added.length, removed: log.removed.length, edited: log.edited, aside: path.relative(REPO, dir), ...after },
        `Updated from ${log.from || 'the first version'} to ${log.to}: ${log.replaced.length} file(s) replaced, ${log.added.length} added, ${log.removed.length} removed${after.steps.length ? `; rebuilt: ${after.steps.join(', ')}` : ''}.${after.schedule && after.schedule !== 'in place' ? `\nThe schedule: ${after.schedule}` : ''}${edited}\nOpen ${ED.app} again. If anything is wrong: node scripts/update.mjs --rollback`)
    }
  }
} catch (e) {
  if (!(e instanceof Stop)) throw e
  end({ ok: false, error: e.message, ...e.extra }, e.message)
}
