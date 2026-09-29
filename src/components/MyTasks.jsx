import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { toggleMdTask } from '../tick.js'
import { MY_TASKS, parseMyTasks, renderMyTask, withTask, withoutTask } from '../mytasks.js'
import '../styles/mine.css'

// Your own tasks, on the screens (SPEC §20.32): the page's IO and the one-line form that adds to it. The rules — the
// line format, where a new line goes — are src/mytasks.js; the rows they become are src/todo.js myRow.

// The tasks as the page holds them now. Own writes are not echoed on the event stream, so a caller that writes calls
// `reload`; a write from anywhere else (Obsidian, a Claude session) arrives as an event.
export function useMyTasks(codes = []) {
  const [md, setMd] = useState('')
  const load = useCallback(() => api.page(MY_TASKS).then(p => setMd(p.blocks.map(b => b.md).join('\n\n'))).catch(() => setMd('')), [])
  useEffect(() => { load() }, [load])
  useEffect(() => api.events(ev => { if (ev.path === MY_TASKS) load() }), [load])
  const key = codes.join(',')
  const tasks = useMemo(() => parseMyTasks(md, codes), [md, key])
  return { tasks, reload: load }
}

// Read, rewrite, write with the base hash; one retry on a stale hash — the discipline every tick in slate follows.
async function rewrite(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await api.page(MY_TASKS)
    const blocks = fn(p.blocks)
    if (!blocks) return false
    try {
      await api.savePage(MY_TASKS, blocks, p.hash)
      if (!p.exists) await api.frontmatter(MY_TASKS, { kind: 'notes', tags: ['tasks'] }).catch(() => { })
      return true
    } catch (e) { if (e.status !== 409 || attempt) throw e }
  }
  return false
}
export const addMyTask = t => rewrite(blocks => withTask(blocks, renderMyTask(t)))
export const removeMyTask = raw => rewrite(blocks => withoutTask(blocks, raw))
export const toggleMyTask = (raw, to = null) => toggleMdTask(MY_TASKS, raw, to)

// One line: what, which course (or none), when (or whenever). Enter adds it; Esc clears it.
// props: { courses:[{key,code,color}], defaultCourse, autoFocus, onAdded(), onCancel() }
export function AddTask({ courses = [], defaultCourse = null, autoFocus = false, onAdded, onCancel }) {
  const [text, setText] = useState('')
  const [course, setCourse] = useState(defaultCourse)
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const submit = async e => {
    e.preventDefault()
    const what = text.trim()
    if (!what || busy) return
    setBusy(true); setError(null)
    try {
      await addMyTask({ text: what, course: courses.find(c => c.key === course)?.code || null, date: date || null })
      setText(''); setDate('')
      onAdded?.()
    } catch (x) { setError(`Could not add that: ${x.message}`) } finally { setBusy(false) }
  }
  const only = courses.length === 1
  return (
    <form className="mt-add" onSubmit={submit}>
      <span className="mt-add-ic"><Icon.plus width="14" height="14" /></span>
      <input className="mt-add-text" value={text} onChange={e => setText(e.target.value)} placeholder="Add a task of your own…" autoFocus={autoFocus}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (text) setText(''); else onCancel?.() } }} />
      {!only && courses.length > 0 && (
        <span className="mt-add-courses" role="group" aria-label="Course">
          <button type="button" className={'mt-chip' + (course === null ? ' on' : '')} style={{ '--c': 'var(--muted)' }} onClick={() => setCourse(null)}>No course</button>
          {courses.map(c => <button type="button" key={c.key} className={'mt-chip' + (course === c.key ? ' on' : '')} style={{ '--c': c.color || 'var(--accent)' }} onClick={() => setCourse(c.key)}>{c.code}</button>)}
        </span>)}
      <input type="date" className="mt-add-date" value={date} onChange={e => setDate(e.target.value)} title="When it is wanted — leave it empty for whenever" />
      <button className="btn small primary" disabled={!text.trim() || busy}>{busy ? 'Adding…' : 'Add'}</button>
      {error && <span className="mt-add-err">{error}</span>}
    </form>)
}
