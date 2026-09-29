// Where the Quercus access key comes from (SPEC §21) — one answer for every script and the server.
//   1. CANVAS_API_TOKEN in the environment: a test, a one-off, the brother simulation.
//   2. The macOS keychain, service "slate-quercus": the item setup writes (`node scripts/setup.mjs token`). A key in
//      the keychain is not in any file that gets backed up, zipped or shared, and `security` is part of macOS itself,
//      not the developer tools, so asking it never wakes a dialog (server/devtools.js).
//   3. The Claude desktop config's canvas MCP entry — where the student's own install has kept it since the first sync.
// Every script that talks to Quercus calls requireQuercusAuth() and never reads a config file itself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WIN, LOCAL_APP, powershell } from './platform.mjs'
import { fetchSafe } from './net.mjs'

export const SERVICE = process.env.SLATE_KEYCHAIN_SERVICE || 'slate-quercus'
export const DEFAULT_API = 'https://q.utoronto.ca/api/v1'
const desktopConfig = () => path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json')
const sec = (args, opts = {}) => execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts })

// Windows has no keychain the command line can read back from; the key is wrapped with DPAPI — the user's own Windows
// protection, what browsers use for saved passwords — into %LOCALAPPDATA%\Slate\<service>.dpapi. PowerShell does the
// wrapping; the key reaches it through the environment, never on a command line (SPEC §21.7).
const dpapiFile = () => path.join(LOCAL_APP, 'Slate', `${SERVICE}.dpapi`)
const PS_PROTECT = "Add-Type -AssemblyName System.Security; $b = [Text.Encoding]::UTF8.GetBytes($env:SLATE_SECRET); $p = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'); [IO.File]::WriteAllBytes($env:SLATE_SECRET_FILE, $p)"
const PS_UNPROTECT = "Add-Type -AssemblyName System.Security; $p = [IO.File]::ReadAllBytes($env:SLATE_SECRET_FILE); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($p, $null, 'CurrentUser')))"
export function keychainToken() {
  if (WIN) { const f = dpapiFile(); if (!fs.existsSync(f)) return null; try { return powershell(PS_UNPROTECT, { env: { ...process.env, SLATE_SECRET_FILE: f } }).trim() || null } catch { return null } }
  try { return sec(['find-generic-password', '-s', SERVICE, '-w']).trim() || null } catch { return null }
}
// -U updates an item that is already there instead of failing on it.
export function storeToken(token) {
  if (WIN) { const f = dpapiFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); powershell(PS_PROTECT, { env: { ...process.env, SLATE_SECRET: String(token), SLATE_SECRET_FILE: f } }); return }
  sec(['add-generic-password', '-a', os.userInfo().username, '-s', SERVICE, '-U', '-w', String(token)])
}
export function forgetToken() {
  if (WIN) { try { fs.rmSync(dpapiFile(), { force: true }) } catch { } return }
  try { sec(['delete-generic-password', '-s', SERVICE]) } catch { }
}
export function desktopToken() {
  try { const env = JSON.parse(fs.readFileSync(desktopConfig(), 'utf8')).mcpServers.canvas.env; return env.CANVAS_API_TOKEN ? { token: env.CANVAS_API_TOKEN, api: env.CANVAS_API_URL || DEFAULT_API } : null } catch { return null }
}
// → { token, api, from: 'env' | 'keychain' | 'claude-desktop' }, or null when nothing on this Mac holds a key.
export function quercusAuth() {
  if (process.env.CANVAS_API_TOKEN) return { token: process.env.CANVAS_API_TOKEN, api: process.env.CANVAS_API_URL || DEFAULT_API, from: 'env' }
  const k = keychainToken(); if (k) return { token: k, api: process.env.CANVAS_API_URL || DEFAULT_API, from: 'keychain' }
  const d = desktopToken(); if (d) return { ...d, from: 'claude-desktop' }
  return null
}
export const NO_TOKEN = 'No Quercus access key is stored on this computer. Setup stores one (`node scripts/setup.mjs token`): q.utoronto.ca → Account → Settings → + New Access Token, expiry left blank.'
export function requireQuercusAuth() { const a = quercusAuth(); if (!a) throw new Error(NO_TOKEN); return a }
// A quick check that a key works: → { ok, name, id } or { ok: false, status }.
export async function probeToken(token, api = DEFAULT_API) {
  const r = await fetchSafe(api + '/users/self', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null)
  if (!r) return { ok: false, status: 0 }
  if (!r.ok) return { ok: false, status: r.status }
  const j = await r.json().catch(() => ({}))
  return { ok: true, name: j.name || j.short_name || null, id: j.id || null }
}
