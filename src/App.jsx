import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, basename } from './api.js'
import Sidebar from './components/Sidebar.jsx'
import PageList from './components/PageList.jsx'
import Canvas from './components/Canvas.jsx'
import PageIndex from './components/PageIndex.jsx'
import SourceBanner, { sourceOf } from './components/SourceBanner.jsx'
import PageHeader, { placeOf } from './components/PageHeader.jsx'
import Search from './components/Search.jsx'
import InlineName from './components/InlineName.jsx'
import MetaPopover from './components/MetaPopover.jsx'
import ContextMenu from './components/ContextMenu.jsx'
import PrintView from './components/PrintView.jsx'
import Home from './components/Home.jsx'
import { DialogProvider, useDialog } from './components/Dialog.jsx'
import { Icon } from './components/Icons.jsx'
import { KINDS, kindIcon, kindLabel, DEFAULT_HIGHLIGHTS } from './kinds.js'
// v0.7 (SPEC §20): the screens, the ask rail, the right pane, history, export and the problems chip.
import CourseScreen from './components/CourseScreen.jsx'
import WeekScreen from './components/WeekScreen.jsx'
import Todo from './components/Todo.jsx'
import Work from './components/Work.jsx'
import WorkTimer from './components/WorkTimer.jsx'
import Library from './components/Library.jsx'
import AskPanel from './components/AskPanel.jsx'
import { useAsk, toggleAsk } from './ask.js'
import SidePane from './components/SidePane.jsx'
import History from './components/History.jsx'
import ExportDialog from './components/ExportDialog.jsx'
import Notes from './components/Notes.jsx'
import NotePicker from './components/NotePicker.jsx'
import { noteNameOf } from './notes.js'
import SaveAs from './components/SaveAs.jsx'
import AddFiles from './components/AddFiles.jsx'
import { THIS as ED } from './edition.js'

const ls = { get: (k, d) => { try { const raw = localStorage.getItem(k); return raw === null ? d : JSON.parse(raw) } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { } }, del: k => { try { localStorage.removeItem(k) } catch { } } }
const uniqueName = (base, taken) => { let t = base, n = 2; const set = new Set(taken); while (set.has(t)) t = `${base} ${n++}`; return t }
const sectionOf = p => p.split('/').slice(0, 2).join('/')
const STATUS = { saving: 'Saving…', saved: 'Saved', error: 'Save failed', conflict: 'Changed on disk', reloaded: 'Updated from disk', uploading: 'Uploading…', recognising: 'Recognising handwriting…', recognised: 'Handwriting recognised' }
// The screen enum: 'home' (Today) | 'todo' | 'notes' | 'library' | 'course:<key>' | 'week:<key>/<term>/<week>' | null (a page), persisted as
// slate.screen (SPEC §20.14). Three screens, not five: 'next' folded into Today and 'term:' into the course
// screen, so a stored value of either lands somewhere sensible instead of a blank pane.
const initialScreen = () => {
  const s = ls.get('slate.screen', undefined)
  if (s !== undefined) return s === 'next' ? 'home' : typeof s === 'string' && s.startsWith('term:') ? 'course:' + s.slice(5).split('/')[0] : s
  const home = ls.get('slate.home', true); ls.del('slate.home'); return home ? 'home' : null
}
const nonce = t => (t ? { ...t, nonce: Date.now() } : null)
// A course week is a screen, not a page (SPEC §20.24). `Course/Term/Week 3 (Sep 21).md` used to open in the editor as
// an index of the six folders under it — a second week view, showing less than the week screen and disagreeing with
// it. Every route to a week page (the page list, a wikilink, a search hit, a breadcrumb) now lands on the one screen;
// `openPageRaw` is the deliberate way past it, and the week screen offers that itself.
//   …and the same for `Plan.md` inside a week (SPEC §20.25). A Plan page is machine-written storage for the week's
// ticks — a heading, a date, and boxes with no context — and landing on one was landing on the app's own scratch
// file. Its list is drawn, tickable, on the week screen; that is where every link to it goes now.
//   …and `Problems.md` (SPEC §20.32). It is where a week's problem rows are stored, and opened in the editor it was a
// column of rows with two checkboxes each that did nothing until you clicked into the block to write. The week screen
// draws the same rows as one card per set, tickable in one click, so every route to the page lands on that tab.
//   …and the other containers, `Lectures`, `Recordings` and `Study sheets` (SPEC §20.33). Nobody writes on a folder of
// slides: "writing on the main pages" served no purpose, so a route to one opens that bucket on the week screen instead.
// `Notes.md` is not here — it is where a week's notes are written.
const WEEK_RE = /^([^/]+)\/((?:Fall|Winter|Summer|Spring)[^/]*)\/(Week [^/]*?)(?:\/(Plan|Problems|Lectures|Recordings|Study sheets))?\.md$/
const weekOf = (p, courseKeys) => { const m = WEEK_RE.exec(String(p || '')); return m && courseKeys.has(m[1]) ? `${m[1]}/${m[2]}/${m[3]}` : null }
const weekTabOf = p => ({ Plan: 'plan', Problems: 'problems', Lectures: 'lectures', Recordings: 'recordings', 'Study sheets': 'sheets' })[WEEK_RE.exec(String(p || ''))?.[4]] || null

export default function App() {
  const printPath = new URLSearchParams(window.location.search).get('print')
  if (printPath) return <PrintView path={printPath} />
  return <DialogProvider><Shell /></DialogProvider>
}

function Shell() {
  const dialog = useDialog()
  const [tree, setTree] = useState([])
  const [section, setSection] = useState(() => ls.get('slate.section', null))
  const [pages, setPages] = useState([])
  const [pagePath, setPagePath] = useState(() => ls.get('slate.page', null))
  const [page, setPage] = useState(null)
  const [theme, setTheme] = useState(() => ls.get('slate.theme', 'system'))
  const [paper, setPaper] = useState(() => ls.get('slate.paper', 'ruled'))   // ruled | plain
  const [search, setSearch] = useState(null)   // 'quick' | 'full' | 'quick-right'
  const [status, setStatus] = useState('')
  const [external, setExternal] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [titleEdit, setTitleEdit] = useState(false)
  const [widths, setWidths] = useState(() => ({ sidebar: 224, list: 248, right: 560, ...ls.get('slate.widths', {}) }))
  const [sidebarOpen, setSidebarOpen] = useState(() => ls.get('slate.sidebar', true))
  const [rootMeta, setRootMeta] = useState({})
  const [pageMeta, setPageMeta] = useState(null)
  const [pageMenu, setPageMenu] = useState(null)
  const [printing, setPrinting] = useState(false)   // a page path, or false
  const [screen, setScreen] = useState(initialScreen)
  const [adaptInk, setAdaptInk] = useState(() => ls.get('slate.adaptInk', true))
  const [sysDark, setSysDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  // Two panes (SPEC §20.10): the page list drives the left pane; `split` is the right pane's path; `pane` owns the keyboard, ⌘P and search hits.
  const [split, setSplit] = useState(() => ls.get('slate.split', null))
  const [pane, setPane] = useState('left')
  const [rightPage, setRightPage] = useState(null)
  const [goTo, setGoTo] = useState(null), [goToRight, setGoToRight] = useState(null)
  const [history, setHistory] = useState(false)
  // Where you have been (SPEC §20.38): every screen, section and page opened is one step, and Back walks them. Getting back
  // used to mean finding the way again — Home, the course, the week, the page — for something you had just left.
  const nav = useRef({ list: [], i: -1, jumping: false })
  const [navN, setNavN] = useState(0)
  const [exporting, setExporting] = useState(null)
  const ask = useAsk()   // the Ask rail's store: `ask.open`; toggleAsk() from src/ask.js
  const [courseKeys, setCourseKeys] = useState(() => new Set())
  const [courseTerm, setCourseTerm] = useState(null)   // the term the course screen opens on, when the sidebar named one
  const [weekTab, setWeekTab] = useState(null)         // the bucket the week screen opens on, when a link named one
  const [todoDay, setTodoDay] = useState(null)         // the day To do is narrowed to, when the week's load strip sent you there (SPEC §20.63)
  const [todoCourse, setTodoCourse] = useState(null)   // and the course, when a course's own strip did (SPEC §20.64)
  const todoOn = useRef(null)                          // the date the strip was clicked on
  // Taking notes is an action, not a place (SPEC §20.26): the picker opens over whatever is on screen, from the
  // sidebar, Today, a course, a week, or ⌘⇧N, and hands the editor the week's sheet.
  const [taking, setTaking] = useState(false)
  const [saving, setSaving] = useState(false)          // the Save a copy sheet
  const [adding, setAdding] = useState(false)          // the Add files sheet: your own documents into a week
  // Focus mode (SPEC §20.28): the page and nothing else — no sidebar, no page list, no top bar. Esc leaves it.
  const [focusMode, setFocusMode] = useState(false)
  const [courseList, setCourseList] = useState([])
  useEffect(() => { ls.set('slate.adaptInk', adaptInk) }, [adaptInk])
  useEffect(() => { const m = window.matchMedia?.('(prefers-color-scheme: dark)'); const h = e => setSysDark(e.matches); m?.addEventListener('change', h); return () => m?.removeEventListener('change', h) }, [])
  const dark = theme === 'dark' || (theme === 'system' && sysDark)
  useEffect(() => { ls.set('slate.screen', screen) }, [screen])
  useEffect(() => { ls.set('slate.split', split); if (!split) { setPane('left'); setRightPage(null) } }, [split])
  const fileInput = useRef(null)
  const canvasRef = useRef(null), rightCanvasRef = useRef(null)
  // The desktop window asks for this before it closes (desktop/main.cjs): every pending save in either pane, written first.
  useEffect(() => { window.__slateFlush = async () => { await Promise.all([canvasRef.current?.flush?.(), rightCanvasRef.current?.flush?.()]); return true }; return () => { delete window.__slateFlush } }, [])
  const sectionRef = useRef(section), pageRef = useRef(pagePath), splitRef = useRef(split)
  sectionRef.current = section; pageRef.current = pagePath; splitRef.current = split

  const loadTree = useCallback(() => api.tree().then(setTree).catch(console.error), [])
  const loadPages = useCallback(sec => (sec ? api.pages(sec).then(setPages).catch(() => setPages([])) : Promise.resolve(setPages([]))), [])
  const loadPage = useCallback(p => (p ? api.page(p).then(setPage).catch(() => { setPage(null); setPagePath(null) }) : setPage(null)), [])
  const loadRootMeta = useCallback(() => api.rootMeta().then(setRootMeta).catch(() => { }), [])
  const loadCourses = useCallback(() => api.hub().then(h => {
    const cs = (h.courses || []).map(c => ({ key: c.key, code: c.code, name: c.name, color: c.color || null }))
    setCourseList(cs); setCourseKeys(new Set(cs.map(c => c.key)))
  }).catch(() => { }), [])
  useEffect(() => { loadTree(); loadRootMeta(); loadCourses() }, [])
  // A week page restored from the last session opens as the week screen too — once, on the first list of courses,
  // so "Open the week's own page" is not bounced straight back out of the editor (SPEC §20.24).
  const bootRedirect = useRef(false)
  useEffect(() => {
    if (bootRedirect.current || !courseKeys.size) return
    bootRedirect.current = true
    const w = !screen && pagePath ? weekOf(pagePath, courseKeys) : null
    if (w) openWeek(w, weekTabOf(pagePath))
  }, [courseKeys])
  useEffect(() => { loadPages(section); ls.set('slate.section', section) }, [section])
  useEffect(() => { loadPage(pagePath); ls.set('slate.page', pagePath); setTitleEdit(false) }, [pagePath])
  useEffect(() => { document.documentElement.dataset.theme = theme; ls.set('slate.theme', theme) }, [theme])
  useEffect(() => { document.documentElement.dataset.paper = paper; ls.set('slate.paper', paper) }, [paper])
  useEffect(() => { ls.set('slate.widths', widths) }, [widths])
  useEffect(() => { ls.set('slate.sidebar', sidebarOpen) }, [sidebarOpen])
  useEffect(() => { if (status && status !== 'conflict') { const t = setTimeout(() => setStatus(''), 2500); return () => clearTimeout(t) } }, [status])

  useEffect(() => api.events(ev => {
    if (ev.kind === 'md' || ev.kind === 'layout') {
      const p = ev.kind === 'md' ? ev.path : ev.path.replace(/\.blocks\.json$/, '.md')
      if (p === pageRef.current) setExternal(ev)
      if (ev.kind === 'md') loadPages(sectionRef.current)
    } else { loadTree(); loadPages(sectionRef.current); if (ev.path === '_slate.json') loadRootMeta(); if (ev.path === 'Hub/_hub.json' || ev.path === 'Hub/_marks.json') loadCourses() }
  }), [])

  const allTitles = useMemo(() => { const out = []; const walk = l => l.forEach(p => { out.push(p.title); walk(p.children) }); walk(pages); return out }, [pages])
  const closeSplit = () => { setSplit(null); setPane('left') }
  const actions = {
    createNotebook: async () => { const r = await api.createNotebook(uniqueName('Notebook', tree.map(n => n.name))); await loadTree(); setRenaming(r.path) },
    createSection: async nb => { const n = tree.find(x => x.path === nb); const r = await api.createSection(nb, uniqueName('Section', n?.sections.map(s => s.name) || [])); await loadTree(); setSection(r.path); setRenaming(r.path) },
    createPage: async (dir, parent) => {
      const r = await api.createPage({ dir: dir || undefined, parent: parent || undefined, title: uniqueName('Untitled', allTitles) })
      await loadPages(section); setPagePath(r.path); setPane('left'); setRenaming(r.path)
    },
    rename: async (path, name) => {
      setRenaming(null)
      try {
        const r = await api.rename(path, name)
        const oldBase = path.replace(/\.md$/, ''), newBase = r.path.replace(/\.md$/, '')
        if (path.endsWith('.md')) {
          await loadPages(section)
          if (pagePath === path) setPagePath(r.path); else if (pagePath?.startsWith(oldBase + '/')) setPagePath(newBase + pagePath.slice(oldBase.length))
          if (split === path) setSplit(r.path); else if (split?.startsWith(oldBase + '/')) setSplit(newBase + split.slice(oldBase.length))
        } else {
          await loadTree()
          if (section === path) setSection(r.path); else if (section?.startsWith(path + '/')) setSection(r.path + section.slice(path.length))
          if (pagePath?.startsWith(path + '/')) setPagePath(r.path + pagePath.slice(path.length))
          if (split?.startsWith(path + '/')) setSplit(r.path + split.slice(path.length))
        }
      } catch (e) { dialog.alert({ title: 'Cannot rename', message: e.message }) }
    },
    trash: async path => {
      if (!(await dialog.confirm({ title: `Move “${basename(path)}” to the trash?`, message: 'It stays in Notebooks/.trash until you empty it by hand.', confirmLabel: 'Move to Trash', danger: true }))) return
      await api.trash(path)
      const base = path.replace(/\.md$/, '')
      if (pagePath === path || pagePath?.startsWith(base + '/')) setPagePath(null)
      if (split === path || split?.startsWith(base + '/') || split?.startsWith(path + '/')) closeSplit()
      if (section === path || section?.startsWith(path + '/')) setSection(null)
      await loadTree(); await loadPages(sectionRef.current)
    },
    reorder: async (dir, order) => { await api.reorder(dir, order); await loadPages(section) },
    color: async (dir, c) => { await api.color(dir, c); await loadTree() },
    meta: async (dir, patch) => { await api.meta(dir, patch); await loadTree() },
    setHighlights: async list => { await api.meta('', { highlights: list }); await loadRootMeta() },
    pageMeta: async patch => { const r = await canvasRef.current?.patchFrontmatter(patch); if (r) setPage(p => (p ? { ...p, frontmatter: r.frontmatter } : p)); await loadPages(sectionRef.current) },
    history: p => { if (p !== pagePath) { setSection(sectionOf(p)); setPagePath(p) } setScreen(null); setPane('left'); setHistory(true) },
    exportPdf: target => setExporting(target),
  }
  // ---- navigation (SPEC §20.1, §20.10): one openPage that knows which pane it opens in and carries a search target ----
  const openPageRaw = (p, target) => {
    setSearch(null); setScreen(null)
    if (p === split) { setPane('right'); setGoToRight(nonce(target)); return }            // already on the right: activate it
    if (pane === 'right' && split) { setSplit(p); setGoToRight(nonce(target)); return }  // the right pane is active: it takes the page
    setSection(sectionOf(p)); setPagePath(p); setPane('left'); setGoTo(nonce(target))
  }
  // A bare title is not a path. The week screen and the morning note handed wikilink titles straight to this, which set
  // the section to `ECO206_Problem_Set_1_Questions`, found no page, and showed "Pick a section to start" — the empty page
  // behind "sometimes the right page, sometimes an empty one" (SPEC §20.32). Anything that is not a page path is a title.
  const openPage = (p, target) => { if (p && !/\.md$/i.test(p)) return openTitle(p); const w = weekOf(p, courseKeys); if (w) return openWeek(w, weekTabOf(p)); openPageRaw(p, target) }
  const openRight = (p, target) => {
    setSearch(null); setScreen(null)
    if (p === pagePath) { setPane('left'); setGoTo(nonce(target)); return }              // a page is open in one pane at most
    setSection(s => s || sectionOf(p)); setSplit(p); setPane('right'); setGoToRight(nonce(target))
  }
  const swapPanes = () => { const l = pagePath, r = split; if (!r) return; setSection(sectionOf(r)); setPagePath(r); setSplit(l); setPane('left') }
  const openSection = s => { setSection(s); setPagePath(null); setSearch(null); setScreen(null); setPane('left') }
  const openCourse = k => { setCourseTerm(null); setScreen('course:' + k); setSearch(null) }
  // A term section of a course notebook opens the course screen at that term, and a week opens the week screen
  // (SPEC §20.13, §20.24): both are screens, so the page list steps aside and the notebook gets the whole width.
  const openTerm = p => { const [key, term] = p.split('/'); setCourseTerm(term || null); setScreen('course:' + key); setSearch(null) }
  const openWeek = (p, tab = null) => { setWeekTab(tab); setScreen('week:' + p.replace(/\.md$/, '')); setSearch(null) }
  // To do from the sidebar or an "All" is every day: a strip's narrowing lasted until its ×, on every later visit.
  const openScreen = s => { if (s === 'todo') { setTodoDay(null); setTodoCourse(null) } setScreen(s); setSearch(null) }
  const openTodoDay = (d, course = null) => { setTodoDay(d); setTodoCourse(course); todoOn.current = new Date().toLocaleDateString('en-CA'); setScreen('todo'); setSearch(null) }
  // A past day stands only on the date it was clicked (a look back at Monday); once that day has gone too, it goes.
  const todoNarrow = todoDay && (todoDay >= new Date().toLocaleDateString('en-CA') || todoOn.current === new Date().toLocaleDateString('en-CA')) ? todoDay : null
  // One step per place you land on, and a step the buttons themselves took is not pushed again.
  useEffect(() => {
    const here = JSON.stringify({ screen, pagePath, section })
    const cur = nav.current
    if (cur.jumping) { cur.jumping = false; setNavN(n => n + 1); return }
    if (cur.list[cur.i] === here) return
    cur.list = [...cur.list.slice(0, cur.i + 1), here].slice(-60)
    cur.i = cur.list.length - 1
    setNavN(n => n + 1)
  }, [screen, pagePath, section])
  const jump = step => {
    const cur = nav.current, i = cur.i + step
    if (i < 0 || i >= cur.list.length) return
    const s = JSON.parse(cur.list[i])
    cur.i = i; cur.jumping = true
    setSearch(null); setPane('left'); setGoTo(null)
    setScreen(s.screen); setSection(s.section); setPagePath(s.pagePath)
  }
  const canBack = navN >= 0 && nav.current.i > 0, canFwd = nav.current.i < nav.current.list.length - 1
  useEffect(() => {
    const onKey = e => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === '[') { e.preventDefault(); jump(-1) } else if (e.key === ']') { e.preventDefault(); jump(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const navBtns = (<>
    <button className="icon-btn nav-btn" title="Back ⌘[" aria-label="Back" disabled={!canBack} onClick={() => jump(-1)}>‹</button>
    <button className="icon-btn nav-btn" title="Forward ⌘]" aria-label="Forward" disabled={!canFwd} onClick={() => jump(1)}>›</button>
  </>)
  // Two pages side by side — a problem set's questions on the left, its solutions on the right (SPEC §20.32). The left
  // pane keeps the keyboard: the questions are what you are working on.
  const openPair = (left, right) => { setSearch(null); setScreen(null); setSection(sectionOf(left)); setPagePath(left); setSplit(right === left ? null : right); setPane('left') }
  // Wikilinks: a title containing '/' matches by path suffix ([[Week 2 (Sep 14)/Problems]]); the same notebook is preferred.
  const openTitle = async title => {
    const want = title.toLowerCase()
    const t = (await api.titles()).filter(x => (want.includes('/') ? ('/' + x.path.toLowerCase()).endsWith('/' + want + '.md') : x.title.toLowerCase() === want))
    const nb = (pane === 'right' && split ? split : pagePath)?.split('/')[0]
    const hit = t.find(x => x.notebook === nb) || t[0]
    // "Save failed" was the status for a link to nothing, and on a screen there is no status line to show it at all.
    if (hit) openPage(hit.path); else dialog.alert({ title: 'No page by that name', message: `Nothing in the notebooks is called “${title}”.` })
  }

  // The active pane's page and canvas (SPEC §20.7, §20.10): the Ask rail, ⌘J and Save as note follow the pane that was
  // last clicked, so with the split open and the right pane active the rail docks beside the right canvas.
  const activePage = pane === 'right' && split ? rightPage : page
  const askRight = ED.ask && ask.open && pane === 'right' && !!split
  // The window says which slate this is, and an edition with its own colour paints it over the accent tokens rather
  // than forking the stylesheet — one rule, both themes, everything that reads --accent follows (SPEC §20.41).
  useEffect(() => {
    document.title = ED.name
    if (!ED.accent) return
    const el = document.documentElement
    el.style.setProperty('--accent', dark ? ED.accent.dark : ED.accent.light)
    el.style.setProperty('--accent-2', dark ? (ED.accent.goldDark || ED.accent.gold) : ED.accent.gold)
  }, [dark])
  // Esc leaves full screen, unless a field, a dialog or the ink tools want it first.
  useEffect(() => {
    if (!focusMode) return
    const h = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const a = document.activeElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName || '') || a?.isContentEditable || document.querySelector('.cs-scrim, .modal-backdrop')) return
      setFocusMode(false)
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [focusMode])
  useEffect(() => {
    const h = e => {
      const mod = e.metaKey || e.ctrlKey; if (!mod) return
      if (e.key === 'k' && !e.shiftKey) { e.preventDefault(); setSearch('quick') }
      else if (e.key.toLowerCase() === 'f' && e.shiftKey) { e.preventDefault(); setSearch('full') }
      else if (e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); setTaking(true) }
      else if (e.key === 'n' && !e.shiftKey && section) { e.preventDefault(); actions.createPage(section) }
      else if (e.key === '\\') { e.preventDefault(); setSidebarOpen(o => !o) }
      else if (e.key === 'p' && !e.shiftKey) { if (page && !screen) { e.preventDefault(); setSaving(true) } }
      else if (ED.ask && e.key.toLowerCase() === 'j' && !e.shiftKey && activePage && !screen) { e.preventDefault(); toggleAsk() }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [section, allTitles, tree, page, activePage, pane, split, screen])

  const courseKey = typeof screen === 'string' && screen.startsWith('course:') ? screen.slice(7) : null
  const weekPath = typeof screen === 'string' && screen.startsWith('week:') ? screen.slice(5) : null
  const screenNb = courseKey || (weekPath || '').split('/')[0] || null
  const accent = useMemo(() => {
    if (screenNb) return tree.find(n => n.path === screenNb)?.color || null
    if (!section) return null
    const nb = tree.find(n => n.path === section.split('/')[0])
    return nb?.sections.find(s => s.path === section)?.color || nb?.color || null
  }, [tree, section, screenNb])

  const startDivider = (key, e, sign = 1) => {
    e.preventDefault()
    const startX = e.clientX, startW = widths[key]
    // The right pane may grow until the measured left pane is 400 px wide (SPEC §20.10 critique), not until the window minus a constant.
    const main = key === 'right' ? e.currentTarget.parentElement : null, room = main ? main.clientWidth - 400 : window.innerWidth - 600
    const clamp = key === 'right' ? w => Math.max(320, Math.min(Math.max(320, room), w)) : w => Math.max(160, Math.min(480, w))
    const move = ev => setWidths(w => ({ ...w, [key]: clamp(startW + sign * (ev.clientX - startX)) }))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const crumb = page ? page.path.split('/') : []
  // A week's notes sheet lives at `…/Week 3 (Sep 21)/Notes.md` because every screen reads it there, but it is
  // *called* `ECO208 Week 3 note` — the name written into the file itself (SPEC §20.26). The file cannot be
  // renamed without moving it out of the bucket, so the title bar shows the name and does not offer a rename.
  const noteName = page ? noteNameOf(page.path, courseList.find(c => c.key === crumb[0])?.code) : null
  // The open page's own children, from the list already loaded for this section.
  const kidsOf = path => { let out = []; const walk = l => l.forEach(x => { if (x.path === path) out = x.children; else if (x.children.length) walk(x.children) }); walk(pages); return out }
  const pageKids = page ? kidsOf(page.path) : []
  // A page that holds other pages opens as an index of them (SPEC §20.16), with no way to write on it (SPEC §20.33) —
  // except a note: a week's sheet with a second note beside it is still the sheet you write on.
  const asIndex = !!page && pageKids.length > 0 && !placeOf(page.path).isNotes
  const highlights = Array.isArray(rootMeta.highlights) && rootMeta.highlights.length ? rootMeta.highlights : DEFAULT_HIGHLIGHTS
  const themeBtn = <button className="icon-btn" title={`Theme: ${theme}`} onClick={() => setTheme(t => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))}>{theme === 'dark' ? <Icon.moon /> : theme === 'light' ? <Icon.sun /> : <Icon.auto />}</button>
  // The ··· page menu (SPEC §20.10): history, the split and export live here and in the context menus, not as new buttons.
  const openPageMenu = e => setPageMenu({ at: { x: e.clientX - 210, y: e.clientY + 14 }, items: [
    { label: 'Save a copy… (PDF, Word, Markdown)', onClick: () => setSaving(true) },
    { label: 'Full screen', onClick: () => setFocusMode(true) },
    { label: 'Version history…', onClick: () => actions.history(page.path) },
    split ? { label: 'Close the right pane', onClick: closeSplit } : { label: 'Open a page on the right…', onClick: () => setSearch('quick-right') },
    { label: 'Export this section to PDF…', onClick: () => actions.exportPdf({ path: sectionOf(page.path), name: sectionOf(page.path).split('/').pop(), kind: 'section' }) },
    '-',
    { label: paper === 'ruled' ? 'Plain page' : 'Ruled paper', onClick: () => setPaper(p => (p === 'ruled' ? 'plain' : 'ruled')) },
    { label: adaptInk ? 'Keep ink colours as written' : 'Ink follows the theme', onClick: () => setAdaptInk(a => !a) },
    '-',
    { label: 'Move this page to Trash', danger: true, onClick: () => actions.trash(page.path) },
  ] })

  return (<>
    <div className={'app' + (sidebarOpen && !focusMode ? '' : ' no-sidebar') + (focusMode ? ' focus-mode' : '')} style={{ '--w-sidebar': widths.sidebar + 'px', '--w-list': widths.list + 'px', '--w-right': widths.right + 'px', gridTemplateColumns: focusMode ? '1fr' : screen ? (sidebarOpen ? 'var(--w-sidebar) auto 1fr' : '1fr') : sidebarOpen ? 'var(--w-sidebar) auto var(--w-list) auto 1fr' : 'var(--w-list) auto 1fr', ...(accent ? { '--accent': accent } : {}) }}>
      {ED.work !== false && <WorkTimer />}
      {sidebarOpen && !focusMode && <Sidebar tree={tree} selected={screen ? null : section} onSelectSection={openSection} actions={actions} renaming={renaming} setRenaming={setRenaming} screen={screen} onScreen={openScreen} courses={courseKeys} onOpenCourse={openCourse} onOpenTerm={openTerm} onTake={() => setTaking(true)} />}
      {sidebarOpen && !focusMode && <div className="divider" onPointerDown={e => startDivider('sidebar', e)} />}
      {!screen && !focusMode && <PageList section={section} pages={pages} selected={pagePath} onSelect={p => { const w = weekOf(p, courseKeys); if (w) return openWeek(w, weekTabOf(p)); setScreen(null); setGoTo(null); if (p === split) { setPane('right'); return } setPagePath(p); setPane('left') }} actions={actions} renaming={renaming} setRenaming={setRenaming} onOpenRight={openRight} onHistory={actions.history} />}
      {!screen && !focusMode && <div className="divider" onPointerDown={e => startDivider('list', e)} />}
      {screen ? (
        <main className="main home-main">
          <header className="topbar">
            <button className="icon-btn" title="Toggle sidebar ⌘\\" onClick={() => setSidebarOpen(o => !o)}><Icon.sidebar /></button>
            {navBtns}
            <span className="crumb">{screen === 'home' ? 'Home' : screen === 'todo' ? 'To do' : screen === 'work' ? "Today's work" : screen === 'notes' ? 'My notes' : screen === 'library' ? 'Library' : (
              <><span className="crumb-home" onClick={() => setScreen('home')}>Home</span>
                {courseKey && <> › {courseKey}</>}
                {weekPath && <> › <span className="crumb-home" onClick={() => openCourse(weekPath.split('/')[0])}>{weekPath.split('/')[0]}</span> › {weekPath.split('/')[2]}</>}
              </>)}</span>
            <span className="spacer" />
            <button className="btn small take-note" title="Take notes ⌘⇧N" onClick={() => setTaking(true)}><Icon.pencil width="13" height="13" />Take notes</button>
            <button className="icon-btn" title="Jump to page ⌘K · Search ⌘⇧F" onClick={() => setSearch('quick')}><Icon.search /></button>
            {themeBtn}
          </header>
          {screen === 'home' ? <Home onOpen={openPage} onOpenTitle={openTitle} onOpenSection={openSection} onOpenCourse={openCourse} onOpenTerm={openTerm} onScreen={openScreen} onTake={setTaking} onDay={openTodoDay} />
            : screen === 'todo' ? <Todo onOpen={openPage} onOpenCourse={openCourse} day={todoNarrow} course={todoNarrow ? todoCourse : null} onDay={setTodoDay} />
            : screen === 'work' && ED.work !== false ? <Work onOpen={openPage} onOpenCourse={openCourse} />
            : screen === 'notes' ? <Notes onOpen={openPageRaw} onOpenCourse={openCourse} onTake={() => setTaking(true)} />
            : screen === 'library' ? <Library onOpen={openPage} onOpenCourse={openCourse} onOpenWeek={openWeek} onOpenPair={openPair} onAdd={k => setAdding(k || true)} />
            : weekPath ? <WeekScreen key={weekPath} path={weekPath} initialTab={weekTab} onOpen={openPage} onOpenTitle={openTitle} onOpenPair={openPair} onOpenTerm={openTerm} onOpenCourse={openCourse} onOpenWeek={openWeek} />
            : <CourseScreen key={courseKey} courseKey={courseKey} onDay={d => openTodoDay(d, courseKey)} initialTerm={courseTerm} onOpen={openPage} onOpenSection={openSection} onOpenTerm={openTerm} onOpenWeek={openWeek} onHome={() => setScreen('home')} onTake={() => setTaking(courseKey)} />}
        </main>
      ) : (
        <main className={'main' + (split ? ' split' : '')}>
          <div className={'pane pane-left' + (!split || pane === 'left' ? ' active' : '')} onPointerDownCapture={() => setPane('left')}>
            <header className="topbar">
              <button className="icon-btn" title="Toggle sidebar ⌘\\" onClick={() => setSidebarOpen(o => !o)}><Icon.sidebar /></button>
              {navBtns}
              {page && <span className="crumb">
                {courseKeys.has(crumb[0])
                  ? <><span className="crumb-home" onClick={() => openCourse(crumb[0])}>{crumb[0]}</span>
                      {crumb.length > 2 && <> › <span className="crumb-home" onClick={() => openWeek(`${crumb[0]}/${crumb[1]}/${crumb[2]}`)}>{crumb[2]}</span></>}
                      {crumb.length > 3 && <> › …</>}</>
                  : <>{crumb[0]} › {crumb[1]}{crumb.length > 3 ? ' › …' : ''}</>}
              </span>}
              {page && (titleEdit && !noteName
                ? <InlineName className="title-edit" value={page.title} onCommit={n => { setTitleEdit(false); actions.rename(page.path, n) }} onCancel={() => setTitleEdit(false)} />
                : <h1 className="title" title={noteName ? 'Your notes for this week' : 'Click to rename'} onClick={() => !noteName && setTitleEdit(true)}><span className="pl-icon title-icon">{(Icon[kindIcon(page.frontmatter?.kind)] || Icon.file)({ width: 15, height: 15 })}</span>{noteName || page.title}</h1>)}
              {/* The Problems chip went with the Problems page (SPEC §20.33): its rows are ticked on the week screen. */}
              {page && <button className={'chip' + (page.frontmatter?.kind ? '' : ' ghost')} title="Document kind and tags. Stored in the page's frontmatter." onClick={e => setPageMeta({ at: { x: e.clientX, y: e.clientY + 12 } })}>
                {page.frontmatter?.kind ? kindLabel(page.frontmatter.kind) : '+ kind'}{Array.isArray(page.frontmatter?.tags) && page.frontmatter.tags.length ? ' · ' + page.frontmatter.tags.join(', ') : ''}
              </button>}
              <span className="spacer" />
              <span className={'status ' + status}>{STATUS[status] || ''}</span>
              {/* Ask is the thing on this bar most worth reaching for; it was an unlabelled icon between two others. */}
              {ED.ask && activePage && <button className={'btn small ask-btn' + (ask.open ? ' on' : '')} title="Ask Claude about this page ⌘J — or select a passage and ask about that" onClick={() => toggleAsk()}><Icon.ask width="13" height="13" />Ask Claude</button>}
              <button className="btn small take-note" title="Take notes ⌘⇧N" onClick={() => setTaking(true)}><Icon.pencil width="13" height="13" />Take notes</button>
              <button className="icon-btn" title="Jump to page ⌘K · Search ⌘⇧F" onClick={() => setSearch('quick')}><Icon.search /></button>
              {page && <button className="icon-btn" title="Add files: PDFs, audio, video, images, anything" onClick={() => fileInput.current?.click()}><Icon.plus /></button>}
              <input ref={fileInput} type="file" multiple hidden onChange={e => { const fs = [...e.target.files]; e.target.value = ''; canvasRef.current?.addFiles(fs) }} />
              {page && <button className="icon-btn" title="Full screen — the page and nothing else (Esc leaves)" onClick={() => setFocusMode(true)}><Icon.expand /></button>}
              {page && <button className="icon-btn" title="Save a copy: PDF, Word or Markdown" onClick={() => setSaving(true)}><Icon.download /></button>}
              {themeBtn}
              {page && <button className="icon-btn" title="More: history, the right pane, export, paper, ink" onClick={openPageMenu}><Icon.more /></button>}
            </header>
            {page && !asIndex && <PageHeader page={page} onPrint={setPrinting} split={split} onOpenPair={openPair} onCloseRight={closeSplit} />}
            <div className="ask-dock">
              {page && asIndex ? <PageIndex key={page.path} page={page} children={pageKids} onOpen={openPage} />
                : page ? <Canvas key={page.path} ref={canvasRef} className={placeOf(page.path).isNotes ? '' : 'doc'} page={page} active={!split || pane === 'left'} goTo={goTo} external={external} onStatus={setStatus} onOpenTitle={openTitle} dark={dark} adaptInk={adaptInk} highlights={highlights} onSetHighlights={actions.setHighlights} />
                : <div className="canvas empty-canvas"><div className="empty big">{section ? 'Pick a page, or press ⌘N.' : 'Pick a section to start.'}</div></div>}
              {ED.ask && ask.open && !askRight && page && <AskPanel page={page} onAppend={(md, o) => canvasRef.current?.appendBlock(md, o)} onReadInk={() => canvasRef.current?.recogniseInk?.()} />}
            </div>
          </div>
          {split && <>
            <div className="divider pane-divider" onPointerDown={e => startDivider('right', e, -1)} />
            <SidePane path={split} goTo={goToRight} active={pane === 'right'} onActivate={() => setPane('right')} onClose={closeSplit} onSwap={swapPanes} onOpen={p => (p === pagePath ? setPane('left') : setSplit(p))} onPrint={setPrinting} onCanvasRef={r => { rightCanvasRef.current = r }} onPage={setRightPage} askOpen={askRight} onAppend={(md, o) => rightCanvasRef.current?.appendBlock(md, o)} dark={dark} adaptInk={adaptInk} highlights={highlights} onSetHighlights={actions.setHighlights} />
          </>}
        </main>
      )}
      {search && <Search mode={search === 'quick-right' ? 'quick' : search} onClose={() => setSearch(null)} onOpen={search === 'quick-right' ? openRight : openPage} />}
      {pageMeta && page && <MetaPopover at={pageMeta.at} title={page.title} values={{ kind: page.frontmatter?.kind || null, tags: page.frontmatter?.tags || [] }} onClose={() => setPageMeta(null)}
        fields={[{ key: 'kind', label: 'Kind', type: 'select', options: KINDS }, { key: 'tags', label: 'Tags', type: 'tags' }]}
        onSave={v => actions.pageMeta({ kind: v.kind || null, tags: v.tags || [] })} />}
      {pageMenu && <ContextMenu at={pageMenu.at} items={pageMenu.items} onClose={() => setPageMenu(null)} />}
      {saving && page && <SaveAs page={page} onClose={() => setSaving(false)} />}
      {adding && <AddFiles courses={courseList} today={new Date().toLocaleDateString('en-CA')} defaultCourse={typeof adding === 'string' ? adding : null}
        onClose={() => setAdding(false)} onDone={() => loadTree()} />}
      {taking && <NotePicker courses={courseList} today={new Date().toLocaleDateString('en-CA')} defaultCourse={typeof taking === 'string' ? taking : null}
        onClose={() => setTaking(false)} onOpen={p => { setTaking(false); openPageRaw(p) }} />}
    </div>
    {printing && <div className="print-layer"><PrintView path={printing} onClose={() => setPrinting(false)} /></div>}
    {history && page && <History page={page} canvasRef={canvasRef} onClose={() => setHistory(false)} onRestored={() => loadPages(sectionRef.current)} />}
    {exporting && <ExportDialog target={exporting} onClose={() => setExporting(null)} />}
  </>)
}
