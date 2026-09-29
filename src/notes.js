// Where a note goes, and what it is called (SPEC §20.26).
//
// slate grew outwards from the courses and forgot it is a notebook: everything on screen was something Quercus had
// posted or the morning pass had worked out, and the one thing the student writes himself was a page called `Notes` that
// nothing pointed at. Taking a note is now an action on every screen, and it lands somewhere predictable — the
// week's own notes sheet, the file every screen already reads.
//
// The sheet is *named*. The importer writes an empty `Notes.md` into every week, which is scaffolding, not a note;
// the first time you open one to write in, it gets `# ECO208 Week 1 note` and is called that everywhere it is
// listed. Nothing is ever called Untitled, and a week you never wrote in stays empty rather than filling the app
// with blank pages.
import { COURSES, weeks, weekFor } from '../scripts/lib/terms.mjs'

export const shortWeek = label => String(label || '').replace(/\s*\(.*\)$/, '')      // 'Week 1 (Sep 7)' → 'Week 1'
export const noteTitle = (code, weekLabel) => `${code} ${shortWeek(weekLabel)} note`
export const notePath = (courseKey, weekDir) => `${courseKey}/${weekDir}/Notes.md`
// A week Notes page → the note's name, from the path alone: 'ECO 206Y1/Fall 2026/Week 3 (Sep 21)/Notes.md'.
const NOTE_RE = /^([^/]+)\/((?:Fall|Winter|Summer|Spring)[^/]*)\/(Week [^/]*)\/Notes\.md$/
export function noteNameOf(path, code) {
  const m = NOTE_RE.exec(String(path || ''))
  return m ? noteTitle(code || COURSES[m[1]]?.code || m[1], m[3]) : null
}
export const isWeekNote = path => NOTE_RE.test(String(path || ''))

export const termsOf = courseKey => [...new Set(weeks(COURSES[courseKey]?.term || 'Y').map(w => w.term))]
export const weeksOf = (courseKey, term) => weeks(COURSES[courseKey]?.term || 'Y').filter(w => !term || w.term === term)
export const currentWeekOf = (courseKey, today) => weekFor(COURSES[courseKey]?.term || 'Y', today)

// The notes a week holds beyond its sheet live under it: `…/Week 1 (Sep 7)/Notes/ECO206 Week 1 note 2.md` (SPEC §20.33).
export const notesDir = (courseKey, weekDir) => `${courseKey}/${weekDir}/Notes`
export const nthNoteTitle = (code, weekLabel, n) => (n <= 1 ? noteTitle(code, weekLabel) : `${noteTitle(code, weekLabel)} ${n}`)

// A new note for a week that already has one (SPEC §20.33). Once a week held a note, *Continue* was the only door,
// so a tutorial and a lecture in the same week shared one sheet. The new note is a page under the sheet — the place
// every screen already counts as the week's notes — named `ECO206 Week 1 note 2`, then 3. A week with nothing written
// yet gets its sheet instead: the first note of a week is always the sheet. Returns the path to open.
export async function startNewNote(api, { courseKey, code, week }) {
  const sheet = notePath(courseKey, week.dir)
  const pg = await api.page(sheet).catch(() => null)
  if (!(pg?.blocks || []).some(b => b.md.trim())) return startNote(api, { courseKey, code, week })
  const taken = new Set((await api.pages(notesDir(courseKey, week.dir)).catch(() => [])).map(p => p.title))
  let n = 2, title = nthNoteTitle(code, week.label, n)
  while (taken.has(title)) title = nthNoteTitle(code, week.label, ++n)
  const { path } = await api.createPage({ parent: sheet, title })
  const fresh = await api.page(path)
  await api.savePage(path, [{ id: null, md: `# ${title}` }], fresh.hash)
  await api.frontmatter(path, { kind: 'notes' }).catch(() => { })
  return path
}

// Open a week's note, creating it on the way in. Returns the path to open in the editor.
// The heading is written only when the sheet is empty, so re-entering a note never touches what is there.
export async function startNote(api, { courseKey, code, week }) {
  const path = notePath(courseKey, week.dir)
  const pg = await api.page(path).catch(() => null)
  const written = (pg?.blocks || []).some(b => b.md.trim())
  if (!written) {
    await api.savePage(path, [{ id: null, md: `# ${noteTitle(code, week.label)}` }], pg?.hash ?? null)
    await api.frontmatter(path, { kind: 'notes' }).catch(() => { })
  }
  return path
}
