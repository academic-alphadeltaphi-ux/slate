// Render scripts/lib/terms.mjs and scripts/lib/syllabus.mjs from a courses document (SPEC §21). Shared by
// scripts/courses.mjs (a brother's install) and scripts/kit.mjs (the kit ships a rendered, empty course file).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TEMPLATE = path.join(REPO, 'scripts', 'lib', 'terms.template.mjs')
export const MARK = '// Rendered by scripts/courses.mjs from'
export const DEFAULT_CALENDAR = {
  fall: { name: 'Fall 2026', start: '2026-09-07', end: '2026-12-07', reading: ['2026-10-26'] },
  winter: { name: 'Winter 2027', start: '2027-01-04', end: '2027-04-05', reading: ['2027-02-15'] },
  noClass: ['2026-09-07', '2026-10-12', '2027-03-26'],
}

class Raw { constructor(s) { this.s = s } }
const js = (v, ind = '  ') => {
  if (v instanceof Raw) return v.s
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(x => js(x, ind)).join(', ') + ']'
  const keys = Object.keys(v)
  if (!keys.length) return '{}'
  const inner = keys.map(k => `${/^[a-z_$][\w$]*$/i.test(k) ? k : JSON.stringify(k)}: ${js(v[k], ind + '  ')}`)
  const flat = '{ ' + inner.join(', ') + ' }'
  return flat.length < 110 ? flat : '{\n' + ind + inner.join(',\n' + ind) + '\n' + ind.slice(2) + '}'
}
const h12 = t => { const [h, m] = t.split(':').map(Number); const hh = h % 12 || 12; return m ? `${hh}:${String(m).padStart(2, '0')}` : String(hh) }
const ampm = t => (Number(t.split(':')[0]) < 12 ? 'am' : 'pm')
const range = (a, b) => `${h12(a)}–${h12(b)} ${ampm(b)}`
// "Lecture Wed 3–5 pm (OI 2212) · tutorial Mon 5–7 pm (FE 230)" — the one-line summary the course card shows.
export function meetsOf(c) {
  if (c.meets) return c.meets
  if (!c.meetings?.length) return 'Online · no class meetings'
  return c.meetings.map((m, i) => `${i ? m.kind.toLowerCase() : m.kind} ${m.day} ${range(m.start, m.end)}${m.where ? ` (${m.where})` : ''}`).join(' · ')
}
const courseCode = c => {
  const o = { id: c.id, code: c.code, name: c.name, term: c.term, color: c.color, meets: meetsOf(c) }
  if (c.professor) o.professor = c.professor
  o.url = c.url || `https://q.utoronto.ca/courses/${c.id}`
  if (c.mirror) o.mirror = true
  if (c.tutorialLag) o.tutorialLag = 1
  if (c.weekly) o.weekly = c.weekly
  o.meetings = c.meetings || []
  o.tests = (c.tests || []).map(t => [t.date, t.label])
  if (c.textbook) o.textbook = c.textbook
  if (c.grading) o.grading = { components: c.grading.components.map(comp => ({ ...comp, match: new Raw(`new RegExp(${JSON.stringify(comp.match)}, 'i')`) })), schemes: c.grading.schemes }
  return o
}
const stamp = source => `${MARK} ${source} on ${new Date().toISOString()} — edit the JSON and run \`node scripts/courses.mjs write\`, never this file.\n`
export function renderTerms(doc, source) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8')
  const courses = Object.fromEntries(Object.entries(doc.courses || {}).map(([k, c]) => [k, courseCode(c)]))
  const cal = doc.calendar || {}
  const fall = { ...DEFAULT_CALENDAR.fall, ...(cal.fall || {}) }, winter = { ...DEFAULT_CALENDAR.winter, ...(cal.winter || {}) }
  const calendar = `const FALL = ${js({ ...fall, reading: fall.reading || [] })}\nconst WINTER = ${js({ ...winter, reading: winter.reading || [] })}\nexport const NO_CLASS = ${js(cal.noClass || DEFAULT_CALENDAR.noClass)}`
  let text = tpl.replace(/\/\*COURSES\*\/[\s\S]*?\/\*\/COURSES\*\//, () => js(courses))
  text = text.replace(/\/\*CALENDAR\*\/[\s\S]*?\/\*\/CALENDAR\*\//, () => calendar)
  return stamp(source) + text
}
export function renderSyllabus(doc, source) {
  return stamp(source) + `// What each course covers week by week, as the syllabus published it. A reading is { kind: 'READ' | 'LISTEN' | 'WATCH' | 'REVIEW', title, url, required }.\nexport const SYLLABUS = ${js(doc.syllabus || {})}\n`
}
export const renderedFrom = f => { try { const first = fs.readFileSync(f, 'utf8').split('\n')[0]; return first.startsWith(MARK) ? first.slice(MARK.length + 1) : null } catch { return null } }
