// fetch() that cannot hang. A request that is open when the Mac goes to sleep comes back on a dead socket, and a plain
// fetch waits on it forever: the 07:00 run of 2026-09-26 sat 95 minutes in quercus-sync.mjs with 0.46 s of CPU and one
// socket in lsof, and the sweep hung the same way an hour later. A total timeout would also kill a long, healthy
// download (a recording on a slow network), so this aborts only when nothing arrives for `stallMs` — no headers yet, or
// no new bytes of the body — and then tries again, twice, a little later (the network is often not back the second a
// Mac wakes: ENOTFOUND on 2026-09-26 at 17:05).
//
// It reads the whole body before it returns, and returns a real Response built from it, so a caller keeps `.ok`,
// `.status`, `.headers`, `.json()`, `.text()` and `.arrayBuffer()` as they were. It rejects only when every try failed;
// an HTTP error status is a Response like any other.
const NULL_BODY = new Set([101, 204, 205, 304])
// What a failure reads like when the network itself is down, not Quercus: undici's own words, and this file's stall
// ("no data for 60 s from q.utoronto.ca") — which the sync's probe did not know, so a half-up network cost every request
// 205 s and the morning ended on "The Quercus fetch failed: <a random line>" (review 2026-09-29).
export const NET_DOWN = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|no data for \d+ s\b/i
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function once(url, init, stallMs) {
  const ac = new AbortController()
  let timer
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error(`no data for ${Math.round(stallMs / 1000)} s from ${new URL(url).host}`)), stallMs) }
  arm()
  try {
    const r = await fetch(url, { ...init, signal: ac.signal })
    arm()
    const chunks = []
    if (r.body) {
      const reader = r.body.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); arm() }
    }
    return new Response(NULL_BODY.has(r.status) ? null : Buffer.concat(chunks), { status: r.status, statusText: r.statusText, headers: r.headers })
  } finally { clearTimeout(timer) }
}

export async function fetchSafe(url, init = {}, { stallMs = Number(process.env.SLATE_FETCH_STALL_MS) || 60_000, waits = [5_000, 20_000] } = {}) {
  for (let i = 0; ; i++) {
    try { return await once(url, init, stallMs) }
    catch (e) { if (i >= waits.length) throw e; await sleep(waits[i]) }
  }
}
