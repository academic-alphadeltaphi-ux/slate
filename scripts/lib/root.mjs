// Where the notebooks are — one answer, for every script and the server (SPEC §20.44).
//
// This existed eighteen times, once per script, each with `~/Desktop/Claude OS/Notebooks` written into it as the
// fallback. That was harmless while the only install was the student's, and wrong the moment there was a second one: an
// install that says where its notes live in `slate.config.json` was obeyed by the server and ignored by every script,
// so `add-course.mjs` built a term's worth of folders in a place the app would never look, and the app opened empty.
//
// The order, which is also `server/fs.js`'s order:
//   1. `--root <path>` on the command line — a test, a clone, a dry run.
//   2. `SLATE_ROOT` in the environment.
//   3. `slate.config.json` at the repo root — `{ "root": "~/Documents/Slate" }`. This is what an installer writes.
//   4. `~/Desktop/Claude OS/Notebooks`, which is where it was before any of this.
//
// `~` is expanded, because a config file written by a person or by Claude will contain one.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not url.pathname: a repo under a folder with a space in it arrives percent-encoded, and the config
// is then silently missed — which is the same bug, one level down.
export const REPO = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const CONFIG = path.join(REPO, 'slate.config.json')
export const DEFAULT_ROOT = path.join(os.homedir(), 'Desktop', 'Claude OS', 'Notebooks')

export const expandHome = p => (typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

export function configuredRoot() {
  try { return expandHome(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).root) || null }
  catch { return null }
}

// notesRoot(argv) → the absolute notes root. Pass `process.argv` (or any array) and `--root` in it wins.
export function notesRoot(argv = process.argv) {
  const i = Array.isArray(argv) ? argv.indexOf('--root') : -1
  const flag = i >= 0 ? argv[i + 1] : null
  return path.resolve(expandHome(flag || process.env.SLATE_ROOT || configuredRoot() || DEFAULT_ROOT))
}
