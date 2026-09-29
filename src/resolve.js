// Where a task actually lives (SPEC §20.19, widened §20.39). Every task in slate is a sentence lifted from an
// announcement or an outline — "Read WMS Syllabus, Ch 1", "WebAssign Fall-Ex1 → Problems", "Review [[Study sheets/Session 1]]" —
// and a sentence you cannot act on is a sentence you skip. This turns one into a destination: a page in slate, or a
// URL out to Quercus, WebAssign or Crowdmark. First rule that matches wins, most specific first; null means the
// task names something genuinely off-screen (a chapter of a paper book), and the row says so instead.
//
// The rules used to stop at an exact wikilink, which left most rows with no button at all: "Read the topic page:
// Preferences and Budget Constraints" names a page that is filed in that very week, and "Hand in Problem Set 1" names
// a Quercus assignment whose own URL is in the hub. So two rules were added (SPEC §20.39): a task is matched against
// the *deadlines* by name — giving the assignment's own link, never the course's front page — and against the page
// titles in its week and its course. Both are deliberately hard to satisfy: a button that opens the wrong thing is
// worse than no button, so a match needs the whole name said, or most of a name's distinctive words.
//   ctx = { titles:[{title,path,notebook}], links:[{label,url}], general:[{title,path}], deadlines:[{title,url,page}], courseUrl }
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A wikilink resolves the way the editor resolves one: by path suffix when it has a '/', else by title, own course first.
export function findTitle(titles, want, courseKey) {
  const w = String(want).toLowerCase()
  const hits = (titles || []).filter(x => (w.includes('/') ? ('/' + x.path.toLowerCase()).endsWith('/' + w + '.md') : x.title.toLowerCase() === w))
  return hits.find(x => x.notebook === courseKey) || hits[0] || null
}

// ---- naming something by its words ---------------------------------------------------------------------------------
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const undate = s => String(s || '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').trim()
// Words that carry no identity: every course page is "about" something, and matching on them would point any task at
// any page. Numbers stay in — "Problem Set 2" is not "Problem Set 1".
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'this', 'that', 'into', 'about', 'before', 'after',
  'read', 'watch', 'review', 'revise', 'bring', 'week', 'weeks', 'class', 'classes', 'page', 'pages', 'slides', 'file',
  'files', 'work', 'done', 'first', 'next', 'chapter', 'chapters', 'part', 'section', 'please', 'also'])
const sig = s => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w))
const nums = s => fold(s).match(/\d+/g) || []
// The six folders every week has. They are containers, never the thing a task asks for: "do the problems" must not
// open the week's checkbox list (SPEC §20.38) and "take notes" must not open the Notes shell.
const CONTAINER = new Set(['problems', 'plan', 'notes', 'lectures', 'recordings', 'study sheets', 'announcements', 'general', 'links'])

// How strongly `text` names something called `name`. 0 = not at all; higher is a better match.
// A week's own page, a term's page and a section shell are containers too: "Read Perloff 3.4, 4.1, 5.4 and 2.5" said
// the number 5 and was offered Week 5's page for it (SPEC §20.52) — a paper textbook has nothing to open, and the row
// must say so rather than open a week.
const SHELL = /^(week \d+|fall \d{4}|winter \d{4}|summer \d{4}|spring \d{4})$/
export function namesIt(text, name) {
  const clean = undate(name)
  if (!clean || CONTAINER.has(fold(clean)) || SHELL.test(fold(clean).replace(/\s*\(.*\)\s*$/, ''))) return 0
  // A number in a name *is* the name: "Problem Set 2" and "Problem Set 1" share every other word, and offering one
  // for the other is exactly the button that lies. Every number the name carries has to be said.
  const said0 = new Set(nums(text))
  if (!nums(clean).every(n => said0.has(n))) return 0
  const t = fold(text), full = fold(clean)
  if (full.length >= 6 && t.includes(full)) return 3                     // said in full, word for word
  const want = sig(clean)
  if (want.length < 2) return 0                                          // a one-word name is too easy to hit by accident
  const said = new Set(sig(text))
  const hit = want.filter(w => said.has(w)).length
  return hit >= 2 && hit / want.length >= 0.6 ? 2 : 0
}

// The page a task names, out of everything slate holds. A page in the task's own week wins over the same match
// elsewhere in the course, and a page in another course is never offered.
function namedPage(text, m, titles) {
  const key = m?.courseKey, weekDir = m?.week?.dir ? `${key}/${m.week.dir}/` : null
  let best = null
  for (const p of titles || []) {
    if (key && p.notebook !== key) continue
    const score = namesIt(text, p.title)
    if (!score) continue
    const rank = score * 10 + (weekDir && p.path.startsWith(weekDir) ? 2 : 0) + (/\/(Problems|Lectures|Readings?|Textbook)\//.test(p.path) ? 1 : 0)
    if (!best || rank > best.rank) best = { rank, page: p }
  }
  return best?.page || null
}

export function resolveTask(task, m, ctx = {}) {
  const text = String(task?.text || '')

  const url = /(https?:\/\/[^\s)\]]+)/.exec(text)?.[1]
  if (url) return { label: 'Open it', url }

  const wl = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(text)?.[1]
  if (wl) { const hit = findTitle(ctx.titles, wl, m?.courseKey); if (hit) return { label: 'Open it', path: hit.path } }

  // The assignment's own Quercus page, by name. This is the exact link the student asked for — "do the WebAssign questions"
  // goes to that assignment, not to the course's front page and not to a list of checkboxes.
  let bestDue = null
  for (const d of ctx.deadlines || []) {
    const score = namesIt(text, d.title)
    if (score && (!bestDue || score > bestDue.score)) bestDue = { score, d }
  }
  if (bestDue?.d?.url) return { label: 'Open the assignment', url: bestDue.d.url }

  // A named external tool the course's Links page knows about — WebAssign, Crowdmark, anything the sync found.
  for (const l of ctx.links || []) {
    const word = String(l.label || '').split(/[\s·—-]/)[0]
    if (word.length > 3 && new RegExp('\\b' + esc(word), 'i').test(text)) return { label: `Open ${word}`, url: l.url }
  }

  if (/\bsyllabus\b|\bcourse outline\b|\boutline\b/i.test(text)) {
    const g = (ctx.general || []).find(p => /syllabus|outline/i.test(p.title))
    if (g) return { label: 'Open the syllabus', path: g.path }
  }
  if (bestDue?.d?.page) return { label: 'Open it', path: bestDue.d.page }

  // The document it is talking about, filed in its own week. A week's Problems, Plan and Notes shells are excluded
  // above, so this only ever opens a real thing: the slides, the reading, the problem set, the topic page.
  const page = namedPage(text, m, ctx.titles)
  if (page) return { label: 'Open it', path: page.path }

  if (m?.sources?.length) return { label: 'Read where it came from', path: m.sources[0] }
  return null
}

// ---- a stored link, still there? ---------------------------------------------------------------------------------------
// A week's own page and its containers are routes the app opens as the week screen, file or not (App.jsx WEEK_RE).
const WEEK_ROUTE = /^[^/]+\/(?:Fall|Winter|Summer|Spring)[^/]*\/Week [^/]*?(?:\/(?:Plan|Problems|Lectures|Recordings|Study sheets))?\.md$/
// Whether a slate path leads nowhere now. Known only once the titles are read: until then the link stands.
export const pageGone = (titles, p) => !!titles?.length && !WEEK_ROUTE.test(String(p)) && !titles.some(x => x.path === p)
// Claude's link as the row's button (SPEC §20.37), kept honest. brain.mjs follows the moves it makes itself; a page moved or
// renamed any other way — a rename in the app, a refile — left the link pointing at nothing and the button opening an
// empty pane. So: the page by its own name elsewhere in the course, else the page the task was read in, else its week —
// never nothing (SPEC §21.11). `stand` marks a button that opens something near the thing rather than the thing.
export function linkAction(link, { courseKey = null, week = null, source = null } = {}, ctx = {}) {
  if (/^https?:\/\//.test(link)) return { label: 'Open it', url: link }
  if (!pageGone(ctx.titles, link)) return { label: 'Open it', path: link }
  const moved = findTitle(ctx.titles, String(link).split('/').pop().replace(/\.md$/, ''), courseKey)
  if (moved && (!courseKey || moved.notebook === courseKey)) return { label: 'Open it', path: moved.path }
  if (source && !pageGone(ctx.titles, source)) return { label: 'Read where it came from', path: source, stand: true }
  if (courseKey && week?.dir) return { label: 'Open its week', path: `${courseKey}/${week.dir}.md`, stand: true }
  return null
}

// The same question for a deadline or a test: Quercus if it has a link, else its page in slate.
export function resolveItem(d, ctx = {}) {
  if (d?.url) return { label: 'Open in Quercus', url: d.url }
  if (d?.page) return { label: 'Open the page', path: d.page }
  if (ctx.courseUrl) return { label: 'Open the course in Quercus', url: ctx.courseUrl, fallback: true }
  return null
}
