import { useEffect, useState } from 'react'
import ContextMenu from './ContextMenu.jsx'
import InlineName from './InlineName.jsx'
import MetaPopover from './MetaPopover.jsx'
import { Icon } from './Icons.jsx'
import { api } from '../api.js'
import { THIS as ED } from '../edition.js'
import { relDay } from '../plan.js'
import { nextMeetingOf, todayIso, nowHM } from './plan/PlanBits.jsx'

// Sections start hidden: a course is one row until you ask for its insides (SPEC §20.14).
const load = () => { try { const v = JSON.parse(localStorage.getItem('slate.collapsed') || 'null'); return v || {} } catch { return {} } }

// Screen rows (Home, To do, My notes, Library), then the notebooks. A course notebook (SPEC §20.4) folds on its name like every
// other; its course screen opens from the hover icon at the row's right or from 'Course dashboard' in its menu.
// A term section of a course ('Fall 2026', 'Winter 2027') opens the term grid instead of the page list (SPEC §20.13) —
// the grid is the fast way to a week; 'Page list' in its menu, and the button on the grid itself, still give the old
// three-pane view. Every other section is unchanged.
// props: { …, onOpenTerm(path) }
const TERM_RE = /^(Fall|Winter|Summer|Spring)\b/i
export default function Sidebar({ tree, selected, onSelectSection, actions, renaming, setRenaming, screen, onScreen, courses, onOpenCourse, onOpenTerm, onTake }) {
  const [collapsed, setCollapsed] = useState(load)
  const [menu, setMenu] = useState(null)
  const [meta, setMeta] = useState(null)
  const toggle = name => setCollapsed(c => { const n = { ...c, [name]: !c[name] }; localStorage.setItem('slate.collapsed', JSON.stringify(n)); return n })
  const isCourse = nb => !!courses?.has(nb.path)
  const courseNbs = tree.filter(nb => nb.name !== 'Hub' && isCourse(nb))
  const otherNbs = tree.filter(nb => nb.name !== 'Hub' && !isCourse(nb))
  // One live line per course row, so the tree says something rather than just naming folders.
  const [status, setStatus] = useState({})
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const [hub, plan] = await Promise.all([api.hub().catch(() => null), api.plan(false).catch(() => null)])
        if (!alive || !hub) return
        const today = todayIso(), now = nowHM()
        const out = {}
        for (const c of hub.courses || []) {
          // The next class that has not ended — a lecture over at 15:00 no longer says "Lecture today" at 20:00.
          const m = nextMeetingOf(plan, c.key, today, now)
          out[c.key] = { code: c.code, line: m ? `${m.kind} ${relDay(m.date, today)}` : c.name }
        }
        setStatus(out)
      } catch { }
    }
    read(); const off = api.events(ev => { if (ev.path === 'Hub/_hub.json' || ev.path === 'Hub/_plan.json') read() })
    return () => { alive = false; off() }
  }, [courses])

  const nbMenu = (e, nb) => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, items: [
    ...(isCourse(nb) ? [{ label: 'Course dashboard', onClick: () => onOpenCourse(nb.path) }] : []),
    { label: 'New section', onClick: () => actions.createSection(nb.path) },
    { label: 'Rename notebook', onClick: () => setRenaming(nb.path) },
    { label: 'Label & colour…', onClick: () => setMeta({ at: { x: e.clientX, y: e.clientY }, path: nb.path, title: nb.name, values: { label: nb.label, color: nb.color } }) },
    { swatches: true, onPick: c => actions.color(nb.path, c) },
    '-', { label: 'Export notebook to PDF…', onClick: () => actions.exportPdf({ path: nb.path, name: nb.name, kind: 'notebook' }) },
    { label: 'Move notebook to Trash', danger: true, onClick: () => actions.trash(nb.path) },
  ] }) }
  const isTerm = (nb, sec) => isCourse(nb) && TERM_RE.test(sec.name)
  const secMenu = (e, nb, sec) => { e.preventDefault(); e.stopPropagation(); setMenu({ at: { x: e.clientX, y: e.clientY }, items: [
    ...(isTerm(nb, sec) ? [{ label: 'Term grid', onClick: () => onOpenTerm(sec.path) }, { label: 'Page list', onClick: () => onSelectSection(sec.path) }] : []),
    { label: 'New page', onClick: () => actions.createPage(sec.path) },
    { label: 'Rename section', onClick: () => setRenaming(sec.path) },
    { label: 'Label & colour…', onClick: () => setMeta({ at: { x: e.clientX, y: e.clientY }, path: sec.path, title: sec.name, values: { label: sec.label, color: sec.color } }) },
    { swatches: true, onPick: c => actions.color(sec.path, c) },
    '-', { label: 'Export to PDF…', onClick: () => actions.exportPdf({ path: sec.path, name: sec.name, kind: 'section' }) },
    { label: 'Move section to Trash', danger: true, onClick: () => actions.trash(sec.path) },
  ] }) }

  return (
    <nav className="sidebar">
      <div className="pane-head"><span className="wordmark" title={ED.name}>{ED.crest ? <img className="wordmark-crest" src={ED.crest} alt="" /> : <span className="wordmark-cap"><Icon.cap width="19" height="19" /></span>}{ED.short || ED.name}</span><button className="icon-btn" title="New notebook" onClick={actions.createNotebook}>+</button></div>
      {/* Writing is the first thing in the app, not something buried under a notebook (SPEC §20.26). */}
      <button className="sb-take" onClick={onTake} title="Take notes ⌘⇧N"><Icon.pencil width="15" height="15" /><span>Take notes</span><kbd>⌘⇧N</kbd></button>
      <div className="tree">
        <div className={'row home-row' + (screen === 'home' ? ' selected' : '')} onClick={() => onScreen('home')} title="Your courses, this week, and everything to do">
          <span className="pl-icon"><Icon.home width="15" height="15" /></span><span className="label">Home</span>
        </div>

        <div className={'row home-row' + (screen === 'todo' ? ' selected' : '')} onClick={() => onScreen('todo')} title="Everything you have to do, with where each thing came from">
          <span className="pl-icon"><Icon.checklist width="15" height="15" /></span><span className="label">To do</span>
        </div>

        {ED.work !== false && <div className={'row home-row' + (screen === 'work' ? ' selected' : '')} onClick={() => onScreen('work')} title="Your day, packed into hours by Claude: what to do, when, and why">
          <span className="pl-icon"><Icon.clock width="15" height="15" /></span><span className="label">Today's work</span>
        </div>}
        <div className={'row home-row' + (screen === 'notes' ? ' selected' : '')} onClick={() => onScreen('notes')} title="Everything you have written, newest first">
          <span className="pl-icon"><Icon.notes width="15" height="15" /></span><span className="label">My notes</span>
        </div>

        <div className={'row home-row' + (screen === 'library' ? ' selected' : '')} onClick={() => onScreen('library')} title={ED.sheets ? 'Every lecture, recording, problem set and study sheet you were given' : 'Every lecture, recording and problem set you were given'}>
          <span className="pl-icon"><Icon.bookmark width="15" height="15" /></span><span className="label">Library</span>
        </div>

        {courseNbs.length > 0 && <div className="tree-group">Courses</div>}
        {courseNbs.map(nb => {
          const open = collapsed['open:' + nb.name] === true
          const on = screen === 'course:' + nb.path || String(screen || '').startsWith('week:' + nb.path + '/') || String(screen || '').startsWith('term:' + nb.path + '/') || selected?.startsWith(nb.path + '/')
          return (
            <div key={nb.path} className="nb">
              <div className={'row course-row' + (on ? ' selected' : '')} style={{ '--c': nb.color || 'var(--muted-2)' }}
                onContextMenu={e => nbMenu(e, nb)} onClick={() => onOpenCourse(nb.path)} title={`Open ${nb.name}`}>
                {/* The number, not the letters: three courses all starting ECO made three identical badges. */}
                <span className="course-badge">{(/(\d{2,4})/.exec(status[nb.path]?.code || nb.name)?.[1] || (status[nb.path]?.code || nb.name).slice(0, 3))}</span>
                {renaming === nb.path
                  ? <InlineName value={nb.name} onCommit={n => actions.rename(nb.path, n)} onCancel={() => setRenaming(null)} />
                  : <span className="course-row-text"><b>{status[nb.path]?.code || nb.name}</b><small>{status[nb.path]?.line || nb.label || ''}</small></span>}
                <button className={'fold' + (open ? ' open' : '')} title={open ? 'Hide its sections' : 'Show its sections'} onClick={e => { e.stopPropagation(); toggle('open:' + nb.name) }}><Icon.chevron width="12" height="12" /></button>
              </div>
              {open && nb.sections.map(sec => (
                <div key={sec.path} className={'row sec-row' + (selected === sec.path || screen === 'term:' + sec.path ? ' selected' : '')}
                  onClick={() => (isTerm(nb, sec) ? onOpenTerm(sec.path) : onSelectSection(sec.path))} onContextMenu={e => secMenu(e, nb, sec)}>
                  <span className="colorbar" style={{ background: sec.color || nb.color || 'var(--muted-2)' }} />
                  {renaming === sec.path ? <InlineName value={sec.name} onCommit={n => actions.rename(sec.path, n)} onCancel={() => setRenaming(null)} /> : <span className="label" title={sec.label || sec.name}>{sec.name}</span>}
                </div>))}
            </div>)
        })}

        {otherNbs.length > 0 && <div className="tree-group">Notebooks</div>}
        {otherNbs.map(nb => (
          <div key={nb.path} className="nb">
            <div className="row nb-row" onContextMenu={e => nbMenu(e, nb)} onClick={() => toggle(nb.name)}>
              <span className={'disclosure' + (collapsed[nb.name] ? '' : ' open')}>▸</span>
              <span className="colorbar" style={{ background: nb.color || 'var(--muted-2)' }} />
              {renaming === nb.path ? <InlineName value={nb.name} onCommit={n => actions.rename(nb.path, n)} onCancel={() => setRenaming(null)} /> : <span className="label" title={nb.label || nb.name}>{nb.name}</span>}
              <button className="icon-btn hover-only" title="New section" onClick={e => { e.stopPropagation(); actions.createSection(nb.path) }}>+</button>
            </div>
            {!collapsed[nb.name] && nb.sections.map(sec => (
              <div key={sec.path} className={'row sec-row' + (selected === sec.path ? ' selected' : '')} onClick={() => onSelectSection(sec.path)} onContextMenu={e => secMenu(e, nb, sec)}>
                <span className="colorbar" style={{ background: sec.color || nb.color || 'var(--muted-2)' }} />
                {renaming === sec.path ? <InlineName value={sec.name} onCommit={n => actions.rename(sec.path, n)} onCancel={() => setRenaming(null)} /> : <span className="label" title={sec.label || sec.name}>{sec.name}</span>}
              </div>))}
            {!collapsed[nb.name] && nb.sections.length === 0 && <div className="row empty-row">No sections</div>}
          </div>))}
        {tree.length === 0 && <div className="empty">No notebooks yet.<br />Click + to create one.</div>}
      </div>
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {meta && <MetaPopover at={meta.at} title={meta.title} values={meta.values} onClose={() => setMeta(null)}
        fields={[{ key: 'label', label: 'Label', placeholder: 'what this is, for you and for Claude' }, { key: 'color', label: 'Colour', type: 'color' }]}
        onSave={v => actions.meta(meta.path, { label: v.label || null, color: v.color || null })} />}
    </nav>
  )
}
