#!/usr/bin/env node
// support-report.mjs — runs on a BROTHER's machine, inside his Slate folder, as scripts/support-report.mjs.
// Writes one markdown file that tells the maintainer (and his Claude) everything needed to reproduce a bug from afar:
// which kit he runs, which files differ from what was shipped, which fixes are applied, his setup state, his course
// file, the doctor / status / last-run log output, and the shape (names only) of his notes folder.
//
//   node scripts/support-report.mjs [--issue "what went wrong, in his words"] [--snapshot]
//
// --snapshot also zips this Slate folder (his code, courses.json, kit.json — no node_modules, no downloaded course files,
// no notes) beside the report, so the maintainer's copy of this install can match it file for file.
//
// Never included: the Quercus key (it lives in DPAPI / the keychain, not in a file — and anything token-shaped is
// redacted anyway), the content of his notes, emails, his home folder path. Node ≥ 20, no dependencies, Mac or Windows.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPORT_VERSION = 2
// its own fingerprint, line endings normalised: the prompt that installs it names the value it should have
const SELF_SHA = crypto.createHash('sha1').update(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n').digest('hex').slice(0, 12)
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2), opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null)
const HOME = os.homedir()
const MAX = 60_000   // per included file

// The home folder in every spelling a report can hold it: as it is, JSON-escaped — setup-state.json and slate.config.json
// on Windows say "C:\\Users\\<name>\\…", which the plain form never matched, so his name went out in every report — and
// with forward slashes. The longest first, so the escaped form is not half-replaced by the plain one.
const HOMES = [...new Set([HOME.replace(/\\/g, '\\\\'), HOME, HOME.replace(/\\/g, '/')])].filter(h => h.length > 3)
const redact = s => HOMES.reduce((t, h) => t.split(h).join('~'), String(s)
  .replace(/\b\d{4,5}~[A-Za-z0-9]{20,}/g, '[QUERCUS-KEY REDACTED]')
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED]')
  .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, '[ANTHROPIC-KEY REDACTED]')
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]'))
const read = p => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const json = p => { try { return JSON.parse(read(p)) } catch { return null } }
const sha = p => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12)
const run = (script, a, timeout = 90_000) => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...a], { cwd: REPO, encoding: 'utf8', timeout, env: { ...process.env, NO_COLOR: '1' } })
  const outp = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim()
  return `$ node scripts/${script} ${a.join(' ')}\n[exit ${r.status ?? (r.error ? r.error.code : 'killed')}]\n${outp.slice(-12_000)}`
}
const fence = (body, lang = '') => { const t = redact(body ?? '(missing)'); const f = t.includes('```') ? '~~~~' : '```'; return `${f}${lang}\n${t.length > MAX ? t.slice(0, MAX) + `\n… (${t.length - MAX} more characters cut)` : t}\n${f}` }
const block = (label, text, lang = 'json') => `<!-- file: ${label} -->\n#### ${label}\n${fence(text, lang)}\n`
const file = (label, p, lang = 'json') => block(label, read(p), lang)

const kit = json(path.join(REPO, 'kit.json')) || {}
const config = json(path.join(REPO, 'slate.config.json')) || {}
const rootRaw = config.root || null
const ROOT = rootRaw ? (rootRaw.startsWith('~') ? path.join(HOME, rootRaw.slice(1)) : rootRaw) : null
const HUB = ROOT ? path.join(ROOT, 'Hub') : null

// ---- integrity: what differs from the kit as shipped (plus fixes applied since) ------------------------------------
const modified = [], missing = []
const HIS = new Set(['scripts/lib/terms.mjs', 'scripts/lib/syllabus.mjs'])   // rewritten by `setup.mjs courses write` from his courses: expected to differ
for (const [rel, h] of Object.entries(kit.files || {})) {
  if (HIS.has(rel)) continue
  const p = path.join(REPO, ...rel.split('/'))
  if (!fs.existsSync(p)) { missing.push(rel); continue }
  try { const now = sha(p); if (now !== h) modified.push(`${rel}  (kit ${h} → now ${now})`) } catch { }
}
const extra = []
for (const top of ['server', 'src', 'scripts', 'desktop', 'bin']) {
  const walk = (d, base) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) { const rel = `${base}/${e.name}`; if (e.name === 'node_modules' || e.name === '__pycache__') continue
      if (e.isDirectory()) walk(path.join(d, e.name), rel); else if (!(rel in (kit.files || {})) && rel !== 'scripts/support-report.mjs') extra.push(rel) } }
  walk(path.join(REPO, top), top)
}

// ---- the notes folder: names and counts only -------------------------------------------------------------------------
const tree = []
if (ROOT && fs.existsSync(ROOT)) {
  const walk = (d, depth, indent) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }).filter(e => !e.name.startsWith('.')) } catch { return }
    const dirs = es.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)), files = es.filter(e => e.isFile())
    if (depth >= 4) { if (files.length) tree.push(`${indent}(${files.length} file(s))`); return }
    for (const f of files.slice(0, 25)) tree.push(`${indent}${f.name}`)
    if (files.length > 25) tree.push(`${indent}… ${files.length - 25} more file(s)`)
    for (const e of dirs) { if (tree.length > 700) return; tree.push(`${indent}${e.name}/`); walk(path.join(d, e.name), depth + 1, indent + '  ') }
  }
  walk(ROOT, 0, '')
}

// ---- scheduled tasks (the app runner) and the background road (the cli runner) ----------------------------------------
const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
let tasks = []; try { tasks = fs.readdirSync(path.join(cfgDir, 'scheduled-tasks')).filter(n => /slate/i.test(n)) } catch { }
let schtasks = null
if (process.platform === 'win32') { const r = spawnSync('schtasks', ['/Query', '/FO', 'LIST'], { encoding: 'utf8', timeout: 20_000 }); schtasks = (r.stdout || '').split(/\r?\n\r?\n/).filter(b => /slate/i.test(b)).join('\n\n') || '(no Slate task in Task Scheduler)' }

// ---- write ----------------------------------------------------------------------------------------------------------
const now = new Date(), stamp = now.toISOString().slice(0, 16).replace('T', ' ')
const who = kit.for || 'unknown'
const hubFiles = HUB && fs.existsSync(HUB) ? fs.readdirSync(HUB).filter(n => n.endsWith('.json')).map(n => `${n} · ${(fs.statSync(path.join(HUB, n)).size / 1024).toFixed(1)} KB`) : []
const md = [
  `# Slate report — ${who} — ${stamp}`,
  '',
  `<!-- slate-report v${REPORT_VERSION} -->`,
  '## What went wrong (in his words)', '', opt('--issue') || '(not given)', '',
  '## Kit', '',
  `- edition: \`${kit.edition}\` · os: \`${kit.os}\` · model: \`${kit.model}\` · every ${kit.cadenceDays} day(s)`,
  `- built: ${kit.builtAt} · for: ${kit.for}`,
  `- fixes applied: ${(kit.fixes || []).map(f => `${f.id} (${f.appliedAt?.slice(0, 10)})`).join(', ') || 'none'}`,
  `- machine: ${process.platform} ${os.release()} ${os.arch()} · node ${process.versions.node} · report v${REPORT_VERSION} (${SELF_SHA})`,
  `- notes root: ${redact(ROOT || '(slate.config.json missing)')}`,
  '',
  '## Drift from the shipped kit', '',
  `<!-- drift: modified=${modified.length} missing=${missing.length} extra=${extra.length} -->`,
  modified.length ? '**Modified** (his Claude or he edited these):\n' + modified.map(m => `- ${m}`).join('\n') : 'Modified: none',
  missing.length ? '\n**Missing:**\n' + missing.map(m => `- ${m}`).join('\n') : '',
  extra.length ? '\n**Not in the kit:**\n' + extra.slice(0, 80).map(m => `- ${m}`).join('\n') : '',
  '',
  '## Checks', '',
  fence(run('setup.mjs', ['doctor'])), '',
  fence(run('run.mjs', ['status'])), '',
  fence(run('setup.mjs', ['status'])), '',
  fence(run('brain.mjs', ['log', '--run', 'last', '--limit', '60'])), '',
  `Claude app scheduled tasks: ${tasks.join(', ') || 'none found'} (in ${redact(cfgDir)}${path.sep}scheduled-tasks)`,
  schtasks ? '\nTask Scheduler:\n' + fence(schtasks) : '',
  '',
  '## Files', '',
  block('kit.json', JSON.stringify(kit, null, 1)),
  file('setup-state.json', path.join(REPO, 'setup-state.json')),
  file('Setup progress.md', path.join(REPO, 'Setup progress.md'), 'md'),
  file('slate.config.json', path.join(REPO, 'slate.config.json')),
  file('courses.json', path.join(REPO, 'courses.json')),
  ...(HUB ? ['_settings.json', '_slate.json', '_runs.json', '_courses.json'].map(n => file(`Hub/${n}`, path.join(HUB, n))) : []),
  `Other Hub files: ${hubFiles.join(' · ') || 'none'}`,
  '',
  '## Notes folder (names only)', '',
  fence(tree.join('\n') || '(empty or missing)'),
  '',
].join('\n')

const name = `Slate report — ${who} — ${now.toISOString().slice(0, 10)}.md`
const out = path.join(REPO, name)
fs.writeFileSync(out, md)
const deskDir = [path.join(HOME, 'OneDrive', 'Desktop'), path.join(HOME, 'Desktop')].find(d => fs.existsSync(d)) || null
let desk = null
if (deskDir) { try { fs.copyFileSync(out, path.join(deskDir, name)); desk = path.join(deskDir, name) } catch { } }

// ---- snapshot -------------------------------------------------------------------------------------------------------
let snapshot = null, snapErr = null
if (args.includes('--snapshot')) {
  const SKIP = new Set(['node_modules', 'dist', 'setup-downloads', '.slate-fixes', '.git', '__pycache__', '.venv', 'venv', '.DS_Store'])
  const base = `Slate snapshot — ${who} — ${now.toISOString().slice(0, 10)}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-snap-')), dir = path.join(tmp, base)
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(e.name) || /^Slate (report|snapshot) — /.test(e.name) || /^slate-fix-\d+/.test(e.name)) continue
      const a = path.join(from, e.name), b = path.join(to, e.name)
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copy(a, b) }
      else if (e.isFile() && fs.statSync(a).size < 20 * 1024 * 1024) fs.copyFileSync(a, b)
    }
  }
  fs.mkdirSync(dir, { recursive: true }); copy(REPO, dir); fs.copyFileSync(out, path.join(dir, name))
  const zip = path.join(deskDir || REPO, `${base}.zip`); fs.rmSync(zip, { force: true })
  const q = s => `'${s.replace(/'/g, "''")}'`
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${q(dir)} -DestinationPath ${q(zip)} -Force`], { encoding: 'utf8', timeout: 180_000 })
    : spawnSync('zip', ['-q', '-r', zip, base], { cwd: tmp, encoding: 'utf8', timeout: 180_000 })
  if (r.status === 0 && fs.existsSync(zip)) snapshot = zip; else snapErr = (r.stderr || r.error?.message || 'zip failed').trim().slice(0, 300)
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, script: SELF_SHA, version: REPORT_VERSION, report: out, desktopCopy: desk, snapshot, ...(snapErr ? { snapshotError: snapErr } : {}), kb: +(md.length / 1024).toFixed(1), modified: modified.length, missing: missing.length }))
