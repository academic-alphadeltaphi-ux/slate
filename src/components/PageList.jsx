import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import ContextMenu from './ContextMenu.jsx'
import InlineName from './InlineName.jsx'
import { kindIcon } from '../kinds.js'
import { Icon } from './Icons.jsx'
import { ProblemsMeta } from './ProblemsChip.jsx'

// The pages of a section, as a table of contents (SPEC §20.65). It was a file tree — chevrons, indent, a hairline down
// each nest — taken out in §20.27 for a stack of cards: a tinted tile, "6 inside · Sep 8", and the week's pages as
// chips in whatever order the folder had them, two hundred and fifty pixels a week, so a term was three screens of
// scrolling that never said where you were. the student could not navigate with it.
//
// A contents page instead. A week is one numbered line — the numeral in the serif, the week's name in small capitals
// with its dates, its topic under them — and the pages it holds are a strip of icons in the shelves' order (notes,
// lectures, recordings, sheets, problems, the reading), each opening that page, the one holding the open page filled
// in the course's colour. The current week's line is gilt; the week holding the open page wears the colour's bar. A
// week with nothing filed yet is one thin line. Nothing unfolds and nothing moves. Pages that are not weeks are plain
// rows under the weeks. The topics and which week is now come from the call the course screen makes for its term.
// props: + onOpenRight(path) (SPEC §20.10, hidden for the page already on the left), onHistory(path).
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
// `Plan.md` is where a week's ticks are stored (and it still works in Obsidian), but it is not a page anyone
// means to open — a bare checkbox with no context reads as noise (SPEC §20.23).
const HIDDEN = new Set(['Plan'])
const visible = list => list.filter(p => !(HIDDEN.has(p.title) && /\/Week [^/]*$/.test(p.path.replace(/\/[^/]*$/, ''))))
const WEEK = /^Week (\d+)\b/
// The shelves in the week screen's order, wearing the icons they wear there and in the Library.
const SHELF = ['Notes', 'Lectures', 'Recordings', 'Study sheets', 'Problems', 'Readings', 'Textbook', 'Videos', 'Assignments']
const SHELF_ICON = { Notes: 'notes', Lectures: 'board', Recordings: 'headphones', 'Study sheets': 'bookmark', Problems: 'pencil', Readings: 'bookOpen', Textbook: 'book', Videos: 'video', Assignments: 'checkSquare' }
const BUCKET = new Set(['Notes', 'Lectures', 'Recordings', 'Study sheets', 'Problems'])   // made with every week; empty, they say nothing
const iconOf = p => SHELF_ICON[p.title] || kindIcon(p.kind) || 'file'
const shelfOrder = list => [...list].sort((a, b) => { const ia = SHELF.indexOf(a.title), ib = SHELF.indexOf(b.title); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) })
const shortSpan = s => String(s || '').replace(/^(\w+) (\d+) – \1 (\d+)$/, '$1 $2 – $3')
const I = (n, s = 13) => (Icon[n] || Icon.file)({ width: s, height: s })

export default function PageList({ section, pages, selected, onSelect, actions, renaming, setRenaming, onOpenRight, onHistory }) {
  const [menu, setMenu] = useState(null)
  const [drag, setDrag] = useState(null)
  const [q, setQ] = useState('')
  const [term, setTerm] = useState(null)

  const top = useMemo(() => visible(pages), [pages])
  const weeks = useMemo(() => top.filter(p => WEEK.test(p.title)), [top])
  const others = useMemo(() => top.filter(p => !WEEK.test(p.title)), [top])
  // A course's term: the same reading the course screen makes, for the topics, the dates and which week is now.
  const isTerm = !!section && section.split('/').length === 2 && weeks.length > 0
  useEffect(() => {
    if (!isTerm) return
    const [key, t] = section.split('/')
    let alive = true
    const id = setTimeout(() => api.term(key, t).then(d => { if (alive) setTerm(d) }).catch(() => { if (alive) setTerm(null) }), 150)
    return () => { alive = false; clearTimeout(id) }
  }, [section, isTerm, pages])
  const termOk = !!term && `${term.key}/${term.term}` === section
  const byLabel = useMemo(() => Object.fromEntries((termOk ? term.weeks : []).map(w => [w.label, w])), [term, termOk])

  // Filtering flattens: when you are hunting a page you do not care which week it sits in.
  const needle = fold(q.trim())
  const hits = useMemo(() => {
    if (!needle) return null
    const out = []
    const walk = (list, trail) => visible(list).forEach(p => {
      if (fold(p.title).includes(needle)) out.push({ ...p, trail })
      if (p.children.length) walk(p.children, [...trail, p.title])
    })
    walk(pages, [])
    return out.slice(0, 60)
  }, [pages, needle])

  const pageMenu = (e, p) => { e.preventDefault(); e.stopPropagation(); setMenu({ at: { x: e.clientX, y: e.clientY }, items: [
    { label: 'New subpage', onClick: () => actions.createPage(null, p.path) },
    { label: 'Rename', onClick: () => setRenaming(p.path) },
    ...(onOpenRight && selected !== p.path ? [{ label: 'Open to the right', onClick: () => onOpenRight(p.path) }] : []),
    ...(onHistory ? [{ label: 'Version history…', onClick: () => onHistory(p.path) }] : []),
    '-', { label: 'Move page to Trash', danger: true, onClick: () => actions.trash(p.path) },
  ] }) }
  const onDrop = (e, target) => {
    e.preventDefault()
    if (!drag || drag.path === target.path) { setDrag(null); return }
    const names = top.map(s => s.title)
    const from = names.indexOf(drag.title), to = names.indexOf(target.title)
    if (from < 0 || to < 0) { setDrag(null); return }
    names.splice(from, 1); names.splice(to, 0, drag.title)
    actions.reorder(section, names)
    setDrag(null)
  }
  const dragProps = (p, top = true) => ({ draggable: top && renaming !== p.path, onDragStart: () => setDrag(p), onDragOver: e => { if (drag && top) e.preventDefault() }, onDrop: e => onDrop(e, p), onDragEnd: () => setDrag(null) })

  // The open page may be a grandchild — `…/Week 1/Lectures/Handout.md`. The week knows it is the branch, and the icon
  // that holds it fills, so the column still says where you are without unfolding anything.
  const holds = path => !!selected && (selected === path || selected.startsWith(path.replace(/\.md$/, '') + '/'))
  const enter = fn => e => { if (e.key === 'Enter' && e.target === e.currentTarget) fn() }

  // One week: the numeral, the name and dates, the topic, then the strip of what it holds.
  const Week = ({ p }) => {
    const wk = byLabel[p.title] || null
    const kids = shelfOrder(visible(p.children))
    const n = WEEK.exec(p.title)?.[1]
    const filed = kids.some(k => k.children.length > 0 || !BUCKET.has(k.title))
    const future = !!wk && !wk.elapsed && !wk.current
    const thin = wk ? future && !filed : !filed
    const topic = wk?.topic || (wk?.readingWeek ? 'Reading week' : null)
    const dates = wk ? shortSpan(wk.span) : (p.title.match(/\((.*)\)$/)?.[1] || '')
    return (
      <div className={'pl-week' + (holds(p.path) ? ' branch' : '') + (wk?.current ? ' now' : '') + (future ? ' future' : '') + (drag?.path === p.path ? ' dragging' : '')} {...dragProps(p)}>
        <div className="pl-week-row" role="button" tabIndex={0} title={`Open ${p.title.replace(/\s*\(.*\)$/, '')} — everything in it on one page`}
          onClick={() => onSelect(p.path)} onKeyDown={enter(() => onSelect(p.path))} onContextMenu={e => pageMenu(e, p)}>
          <span className="pl-week-n">{n}</span>
          <span className="pl-week-main">
            <span className="pl-week-name"><span>week {n}</span><i>{dates}</i></span>
            {renaming === p.path ? <InlineName value={p.title} onCommit={v => actions.rename(p.path, v)} onCancel={() => setRenaming(null)} />
              : topic ? <span className="pl-week-topic" title={topic}>{topic}</span> : null}
          </span>
        </div>
        {!thin && kids.length > 0 && (
          <div className="pl-shelf">
            {kids.map(k => {
              const c = visible(k.children).length, empty = c === 0 && BUCKET.has(k.title) && k.title !== 'Notes'
              return (
                <button key={k.path} className={'pl-it' + (holds(k.path) ? ' on' : '') + (empty ? ' empty' : '')} title={k.title + (c ? ` · ${c}` : empty ? ' · nothing yet' : '')}
                  onClick={() => onSelect(k.path)} onContextMenu={e => pageMenu(e, k)}>{I(iconOf(k))}{c > 0 && <b>{c}</b>}</button>)
            })}
          </div>)}
      </div>)
  }

  // A page that is not a week — and a page the filter found, with the trail that leads to it.
  const Row = ({ p, trail }) => {
    const kids = visible(p.children), c = kids.length, sel = selected === p.path
    return (
      <div className={'pl-item' + (drag?.path === p.path ? ' dragging' : '')} {...dragProps(p, !trail)}>
        <div className={'pl-row' + (sel ? ' selected' : holds(p.path) ? ' branch' : '')} role="button" tabIndex={0}
          onClick={() => onSelect(p.path)} onKeyDown={enter(() => onSelect(p.path))} onContextMenu={e => pageMenu(e, p)}>
          <span className="pl-row-ic">{I(iconOf(p), 15)}</span>
          <span className="pl-row-main">
            {renaming === p.path ? <InlineName value={p.title} onCommit={v => actions.rename(p.path, v)} onCancel={() => setRenaming(null)} />
              : <span className="pl-row-name" title={p.title}>{p.title}</span>}
            {trail?.length ? <span className="pl-row-sub">{trail.join(' · ')}</span> : null}
          </span>
          {p.kind === 'problem-set' && <ProblemsMeta path={p.path} />}
          {c > 0 && <span className="pl-row-n">{c}</span>}
        </div>
        {c > 0 && !trail && (
          <div className="pl-kids">
            {kids.map(k => (
              <button key={k.path} className={'pl-kid' + (holds(k.path) ? ' on' : '')} title={`Open ${k.title}`} onClick={() => onSelect(k.path)} onContextMenu={e => pageMenu(e, k)}>
                {I(iconOf(k), 12)}{k.title}{visible(k.children).length > 0 && <b>{visible(k.children).length}</b>}
              </button>))}
          </div>)}
      </div>)
  }

  const count = top.length === 0 ? 'empty'
    : weeks.length ? `${weeks.length} week${weeks.length === 1 ? '' : 's'}${others.length ? ` · ${others.length} page${others.length === 1 ? '' : 's'}` : ''}`
    : `${top.length} page${top.length === 1 ? '' : 's'}`

  return (
    <section className="pagelist">
      <header className="pl-head">
        <div className="pl-head-main">
          <span className="pl-head-name">{section ? section.split('/').pop() : 'Pages'}</span>
          {section && <span className="pl-head-sub">{count}</span>}
        </div>
        {section && <button className="icon-btn" title="New page ⌘N" onClick={() => actions.createPage(section)}><Icon.plus width="15" height="15" /></button>}
      </header>

      {section && top.length > 4 && (
        <div className="pl-find">
          <Icon.search width="13" height="13" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a page in this section…" spellCheck={false} />
          {q && <button className="pl-find-x" title="Clear" onClick={() => setQ('')}><Icon.x width="12" height="12" /></button>}
        </div>)}

      <div className="pl-list">
        {hits
          ? (hits.length ? hits.map(p => (p.trail.length === 0 && WEEK.test(p.title) ? <Week key={p.path} p={p} /> : <Row key={p.path} p={p} trail={p.trail} />))
            : <div className="pl-blank">Nothing matches “{q}”.</div>)
          : <>
              {weeks.length > 0 && <div className="pl-weeks">{weeks.map(p => <Week key={p.path} p={p} />)}</div>}
              {others.length > 0 && <div className={'pl-rows' + (weeks.length ? ' after-weeks' : '')}>{others.map(p => <Row key={p.path} p={p} />)}</div>}
            </>}
        {section && !hits && top.length === 0 && <div className="pl-blank">Nothing here yet.<br />⌘N starts a page.</div>}
        {!section && <div className="pl-blank">Pick a section.</div>}
      </div>
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  )
}
