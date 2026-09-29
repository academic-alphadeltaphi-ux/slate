// Your own tasks (SPEC §20.32). Every row on To do was something Quercus had posted or the morning pass had worked
// out; there was nowhere to put "email the TA about the tutorial swap". They live in one page of plain markdown,
// `Hub/Today/My tasks.md`, because the files are the truth (principle 3): it opens in Obsidian, a Claude session can
// add to it, and a tick is the same PUT /api/page as every other tick.
//
// One task per line, under `## My tasks`:
//   - [ ] Email the TA about the tutorial swap · ECO206 · 2026-09-14
// The course code and the date are optional and only read from the *end* of the line, so a task whose own words
// contain ` · ` keeps them. Pure and browser-safe; the page IO is src/components/MyTasks.jsx.
export const MY_TASKS = 'Hub/Today/My tasks.md'
export const MY_HEADING = '## My tasks'
export const MY_HEADER = '# My tasks\n\n_Your own things to do, beside what the courses ask. One per line: `- [ ] what · ECO206 · 2026-09-14` — the course and the date are optional._'

const LINE = /^- \[( |x|X)\] (.+?)\s*$/
const ISO = /^\d{4}-\d{2}-\d{2}$/

// parseMyTasks(md, codes) → [{ raw, done, text, course, date }] in file order. `codes` are the course codes a trailing
// segment may name ('ECO206'); anything else stays part of the text.
export function parseMyTasks(md, codes = []) {
  const known = new Set((codes || []).map(c => String(c).toUpperCase()))
  const out = []
  for (const l of String(md || '').split('\n')) {
    const m = LINE.exec(l)
    if (!m) continue
    const parts = m[2].split(' · ')
    let date = null, course = null
    while (parts.length > 1) {
      const last = parts[parts.length - 1].trim()
      if (!date && ISO.test(last)) { date = last; parts.pop(); continue }
      if (!course && known.has(last.toUpperCase())) { course = last.toUpperCase(); parts.pop(); continue }
      break
    }
    out.push({ raw: l, done: m[1] !== ' ', text: parts.join(' · ').trim(), course, date })
  }
  return out
}

// The line a new task is written as.
export const renderMyTask = ({ text, course = null, date = null }) =>
  `- [ ] ${[String(text || '').replace(/\s+/g, ' ').trim(), course, date].filter(Boolean).join(' · ')}`

// withTask(blocks, line) → the page's blocks with `line` appended under `## My tasks` (the page and the heading are
// created when missing). Every other block is kept byte for byte.
export function withTask(blocks, line) {
  const out = (blocks || []).map(b => ({ id: b.id ?? null, md: String(b.md ?? '') }))
  if (!out.some(b => b.md.trim())) return [{ id: null, md: MY_HEADER }, { id: null, md: `${MY_HEADING}\n\n${line}` }]
  let i = out.findIndex(b => b.md.trimStart().startsWith(MY_HEADING))
  if (i < 0) { out.push({ id: null, md: MY_HEADING }); i = out.length - 1 }
  const body = out[i].md.replace(/\s+$/, '')
  out[i] = { ...out[i], md: `${body}${/\n- \[/.test(body) ? '\n' : '\n\n'}${line}` }
  return out
}

// withoutTask(blocks, raw) → the blocks with the first line that stands exactly as `raw` removed, or null when it is gone.
export function withoutTask(blocks, raw) {
  const out = (blocks || []).map(b => ({ id: b.id ?? null, md: String(b.md ?? '') }))
  for (const b of out) {
    const lines = b.md.split('\n'), j = lines.indexOf(raw)
    if (j < 0) continue
    lines.splice(j, 1)
    b.md = lines.join('\n')
    return out
  }
  return null
}
