import { repaint } from './palette.js'
const enc = encodeURIComponent
// Every course colour a response carries is toned to the academic palette on the way in (src/palette.js, SPEC §20.60).
async function req(method, url, body, raw) {
  const r = await fetch(url, { method, headers: raw || !body ? {} : { 'content-type': 'application/json' }, body: raw ? body : body && JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; e.data = data; throw e }
  return repaint(data)
}
const bus = { es: null, subs: new Set() }
export const api = {
  tree: () => req('GET', '/api/tree'),
  pages: dir => req('GET', `/api/pages?dir=${enc(dir)}`),
  page: p => req('GET', `/api/page?path=${enc(p)}`),
  savePage: (path, blocks, baseHash) => req('PUT', '/api/page', { path, blocks, baseHash }),
  saveLayout: (path, layout, baseLayoutHash) => req('PUT', '/api/layout', { path, layout, baseLayoutHash }),
  createNotebook: name => req('POST', '/api/notebook', { name }),
  createSection: (notebook, name) => req('POST', '/api/section', { notebook, name }),
  createPage: ({ dir, parent, title }) => req('POST', '/api/page', { dir, parent, title }),
  rename: (path, name) => req('POST', '/api/rename', { path, name }),
  trash: path => req('POST', '/api/trash', { path }),
  reorder: (dir, order) => req('POST', '/api/reorder', { dir, order }),
  color: (dir, color) => req('POST', '/api/color', { dir, color }),
  meta: (dir, patch) => req('POST', '/api/meta', { dir, patch }),
  rootMeta: () => req('GET', '/api/meta?dir='),
  frontmatter: (path, patch) => req('PUT', '/api/frontmatter', { path, patch }),
  trashAsset: (page, src) => req('POST', '/api/trash-asset', { page, src }),
  reveal: path => req('POST', '/api/reveal', { path }),
  upload: (page, file) => req('POST', `/api/asset?page=${enc(page)}&name=${enc(file.name)}`, file, true),
  search: (q, kinds) => req('GET', `/api/search?q=${enc(q)}${kinds ? '&kinds=' + enc(Array.isArray(kinds) ? kinds.join(',') : kinds) : ''}`),
  searchStatus: () => req('GET', '/api/search/status'),
  reindex: () => req('POST', '/api/search/reindex'),
  titles: () => req('GET', '/api/titles'),
  snapshot: () => req('POST', '/api/snapshot'),
  hub: () => req('GET', '/api/hub'),
  brain: () => req('GET', '/api/brain'),
  sync: () => req('POST', '/api/sync'),
  syncStatus: () => req('GET', '/api/sync/status'),
  transcribe: (page, src) => req('POST', '/api/transcribe', { page, src }),
  transcribeStatus: () => req('GET', '/api/transcribe/status'),
  studyQueue: () => req('GET', '/api/study/queue'),
  confirmSheet: (key, confirmed = true) => req('POST', '/api/study/confirm', { key, confirmed }),
  // ---- v0.7 routes (SPEC §20), one wrapper each; the route modules land group by group ----
  plan: refresh => req('GET', '/api/plan' + (refresh ? '?refresh=1' : '')),
  planRebuild: () => req('POST', '/api/plan/rebuild'),
  problems: page => req('GET', '/api/problems' + (page ? `?page=${enc(page)}` : '')),
  problemsRefresh: () => req('POST', '/api/problems/refresh'),
  course: key => req('GET', `/api/course?key=${enc(key)}`),
  // his own marks and target for a course (SPEC §21.12): marks whole ({} forgets them), target a percent or null; → { course }
  saveMarks: (course, patch) => req('PUT', '/api/marks', { course, ...patch }),
  // a topic flagged for review (SPEC §21.13): { topic, note, id? } flags or changes one, { remove: true, id? } takes one (or
  // the week's every one) off; → { week } the week's flags as they stand
  review: (course, n, week, op) => req('PUT', '/api/review', { course, n, week, ...op }),
  term: (key, term) => req('GET', `/api/term?key=${enc(key)}&term=${enc(term)}`),
  week: path => req('GET', `/api/week?path=${enc(path)}`),
  library: () => req('GET', '/api/library'),
  calendar: () => req('GET', '/api/calendar'),
  // ---- Today's work (SPEC §23): the day, the student's acts on it, the day agent's draft, Send to Google Calendar, the timer, attendance
  day: date => req('GET', '/api/day' + (date ? `?date=${enc(date)}` : '')),
  dayAct: body => req('POST', '/api/day/act', body),
  dayDraft: body => req('POST', '/api/day/draft', body || {}),
  dayDraftStatus: () => req('GET', '/api/day/draft/status'),
  daySend: body => req('POST', '/api/day/send', body || {}),
  daySendStatus: () => req('GET', '/api/day/send/status'),
  dayPrefs: prefs => req('POST', '/api/day/prefs', { prefs }),
  work: body => req('POST', '/api/work', body),
  workStatus: () => req('GET', '/api/work'),
  attendance: body => req('POST', '/api/attendance', body),
  estimates: () => req('GET', '/api/estimates'),
  estimate: body => req('POST', '/api/estimate', body),
  attendanceAll: () => req('GET', '/api/attendance'),
  askContext: (page, opts = {}) => req('GET', `/api/ask/context?page=${enc(page)}${opts.preset ? '&preset=' + enc(opts.preset) : ''}${opts.block ? '&block=' + enc(opts.block) : ''}${opts.week === 'full' ? '&week=full' : ''}${opts.full ? '&full=1' : ''}`),
  askStatus: () => req('GET', '/api/ask/status'),
  hwr: (page, opts = {}) => req('POST', '/api/hwr', { page, ...opts }),
  hwrStatus: probe => req('GET', '/api/hwr/status' + (probe ? '?probe=1' : '')),
  exportStart: body => req('POST', '/api/export', body),
  exportStatus: () => req('GET', '/api/export/status'),
  exportCancel: () => req('POST', '/api/export/cancel'),
  exportOpen: (rel, reveal) => req('POST', '/api/export/open', { rel, reveal: !!reveal }),
  exportFile: body => req('POST', '/api/export/file', body),
  dictateStatus: () => req('GET', '/api/dictate/status'),
  dictate: (blob, signal) => fetch('/api/dictate', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob, signal })
    .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error || r.statusText); e.status = r.status; throw e } return d }),
  history: p => req('GET', `/api/history?path=${enc(p)}`),
  historyShow: (p, hash) => req('GET', `/api/history/show?path=${enc(p)}&hash=${enc(hash)}`),
  // One SSE connection per tab (SPEC §8, §20.1): a bus. Opened by the first subscriber, closed by the last,
  // reconnected by the browser on error. Returns the unsubscribe function.
  events(onEvent) {
    bus.subs.add(onEvent)
    if (!bus.es) {
      bus.es = new EventSource('/api/events')
      bus.es.onmessage = e => { let ev = null; try { ev = JSON.parse(e.data) } catch { return } for (const f of [...bus.subs]) { try { f(ev) } catch (err) { console.error(err) } } }
    }
    return () => { bus.subs.delete(onEvent); if (!bus.subs.size && bus.es) { bus.es.close(); bus.es = null } }
  },
  fileUrl: (dir, src) => '/files/' + `${dir}/${src}`.split('/').map(enc).join('/'),
}
export const dirname = p => p.split('/').slice(0, -1).join('/')
export const basename = p => p.split('/').pop().replace(/\.md$/, '')
