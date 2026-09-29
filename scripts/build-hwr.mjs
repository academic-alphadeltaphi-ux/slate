#!/usr/bin/env node
// `npm run build:hwr` — compile desktop/hwr/hwr.swift to desktop/hwr/bin/hwr with an SDK the compiler accepts,
// probe the result, and record which SDK worked (SPEC §20.9).
//   node scripts/build-hwr.mjs [--check] [--quiet] [--force]
//
// The toolchain surprise this papers over: Command Line Tools 16.4 ships Swift 6.1.2 with a MacOSX26.2 SDK built
// for Swift 6.2, and the compiler refuses it outright ("this SDK is not supported by the compiler"). So the
// candidates are: $SLATE_SDK, then the SDK xcrun selects, then every real MacOSX*.sdk directory in the Command
// Line Tools newest first (15.5 builds in about a second here). A compile error that is not about the SDK stops
// the search. Also called by server/hwr.js (lazy build on first use, --quiet) and by scripts/build-app.mjs
// (non-fatal). `--check` prints { built, bin, sdk, builtAt } and never builds.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(REPO, 'desktop', 'hwr', 'hwr.swift')
const BIN = path.join(REPO, 'desktop', 'hwr', 'bin', 'hwr')
const RECORD = BIN + '.build.json'
const CLT = '/Library/Developer/CommandLineTools'
const args = process.argv.slice(2), quiet = args.includes('--quiet')
const log = (...a) => { if (!quiet) console.log(...a) }

const NOTE_NO_CLT = 'Handwriting recognition needs Apple\'s command-line tools: run `xcode-select --install` once, then `npm run build:hwr`. Until then the server uses the Python path if uv is installed.'
const NOTE_MISMATCH = 'Your Command Line Tools ship an SDK newer than their compiler. Update them (System Settings → General → Software Update, or `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`), or point SLATE_SDK at one that works, e.g. SLATE_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk. Until then the server uses the Python path if uv is installed.'

const stat = p => { try { return fs.statSync(p) } catch { return null } }
const upToDate = () => { const b = stat(BIN), s = stat(SRC); return !!(b && s && b.mtimeMs >= s.mtimeMs) }
const record = () => { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')) } catch { return null } }

if (args.includes('--check')) {
  const r = record()
  console.log(JSON.stringify({ built: upToDate(), bin: BIN, sdk: r?.sdk || null, builtAt: r?.builtAt || null }))
  process.exit(0)
}
if (upToDate() && !args.includes('--force')) {
  const r = record()
  log(`hwr helper is up to date${r?.sdk ? ` (built with ${path.basename(r.sdk)})` : ''}: ${BIN}`)
  process.exit(0)
}
if (!fs.existsSync(SRC)) { console.error(`missing ${SRC}`); process.exit(1) }

// The compiler: what xcrun finds, else the Command Line Tools' own.
let swiftc = null
try { swiftc = execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { }
if (!swiftc && fs.existsSync(path.join(CLT, 'usr', 'bin', 'swiftc'))) swiftc = path.join(CLT, 'usr', 'bin', 'swiftc')
if (!swiftc) { console.error(NOTE_NO_CLT); process.exit(1) }

// SDK candidates, deduplicated by real path, in the order they are tried.
const real = p => { try { return fs.realpathSync(p) } catch { return null } }
const defaultSdk = () => { try { return execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { return null } }
const ver = n => { const m = /MacOSX(\d+)(?:\.(\d+))?\.sdk$/.exec(n); return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0] }
const sdkDir = path.join(CLT, 'SDKs')
const cltSdks = fs.existsSync(sdkDir)
  ? fs.readdirSync(sdkDir).filter(n => /^MacOSX\d+(\.\d+)?\.sdk$/.test(n)).map(n => path.join(sdkDir, n)).filter(p => { try { return !fs.lstatSync(p).isSymbolicLink() && fs.statSync(p).isDirectory() } catch { return false } })
    .sort((a, b) => { const [am, an] = ver(a), [bm, bn] = ver(b); return bm - am || bn - an })
  : []
const candidates = [], seen = new Set()
for (const p of [process.env.SLATE_SDK, defaultSdk(), ...cltSdks]) {
  if (!p) continue
  const r = real(p); if (!r || seen.has(r)) continue
  seen.add(r); candidates.push(p)
}
if (!candidates.length) { console.error('no macOS SDK found under ' + sdkDir + '\n' + NOTE_NO_CLT); process.exit(1) }

fs.mkdirSync(path.dirname(BIN), { recursive: true })
let lastErr = ''
const sdkError = s => /not supported by the compiler|failed to build module|unable to load standard library|SDK/i.test(s)
for (const sdk of candidates) {
  log(`swiftc -O -sdk ${path.basename(sdk)} …`)
  const t0 = Date.now()
  const r = spawnSync(swiftc, ['-O', '-sdk', sdk, '-o', BIN, SRC], { encoding: 'utf8', cwd: REPO })
  if (r.status === 0) {
    const p = spawnSync(BIN, ['--probe'], { encoding: 'utf8', cwd: REPO })
    let engine = null
    try { engine = JSON.parse((p.stdout || '').trim().split('\n').pop()).engine } catch { }
    if (p.status === 0 && engine) {
      fs.writeFileSync(RECORD, JSON.stringify({ sdk, swiftc, builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, engine }, null, 2) + '\n')
      log(`built ${BIN} with ${path.basename(sdk)} in ${Math.round((Date.now() - t0) / 100) / 10}s; Vision languages: ${(engine.languages || []).join(', ')}`)
      process.exit(0)
    }
    lastErr = (p.stderr || p.stdout || `probe exited ${p.status}`).trim()
    try { fs.unlinkSync(BIN) } catch { }   // never leave a binary that cannot answer --probe
    continue
  }
  lastErr = (r.stderr || r.stdout || `swiftc exited ${r.status}`).trim()
  if (!sdkError(lastErr)) break   // a real compile error: no other SDK will fix it
  log(`  ${path.basename(sdk)} refused: ${lastErr.split('\n').find(l => /error:/.test(l))?.slice(0, 160) || lastErr.split('\n')[0].slice(0, 160)}`)
}
console.error(`could not build the handwriting helper.\n${lastErr.split('\n').slice(-3).join('\n')}\n${sdkError(lastErr) ? NOTE_MISMATCH : 'Fix the compile error above, then `npm run build:hwr` again.'}`)
process.exit(1)
