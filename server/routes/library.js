// The library (SPEC §20.22): the *documents* in the courses — slides, handouts, problem sets, recordings, study
// sheets, the professor's announcements and the Quercus pages. Not every markdown file in the tree.
//
// The first version returned every page it walked, so 78 empty `Notes` scaffolds and 28 placeholder `Problems`
// index pages drowned the twenty things that are actually documents: "there are 50 problems for ECO227, and when
// you click on them it just says Read whatever, and there is no link". A row now has to *be* something — carry a
// file, or carry real words — and it carries where it came from and a link back to Quercus.
import fs from 'node:fs/promises'
import path from 'node:path'
import { COURSES, weeks } from '../../scripts/lib/terms.mjs'
import { pairSets } from '../../src/problems.js'

const MEMO_MS = 4000
let memo = { at: 0, promise: null }
const DOC = /\.(pdf|docx?|pptx?|xlsx?|csv)$/i
const IMG = /\.(png|jpe?g|gif|webp|heic|svg)$/i
const TRANSCRIPT = /\.(transcript\.json|srt|vtt)$/i
const AUDIO = /\.(m4a|mp3|wav|aac|flac|ogg)$/i
const VIDEO = /\.(mp4|mov|webm|m4v)$/i
// The six buckets the sync scaffolds, plus the shelves the brain files by name (SPEC §20.53): a week's Readings, Videos
// and Assignments are shelves on the week screen, so they are kinds here too — the Library holds everything a week
// shows, in the same words (SPEC §20.57). Any other folder is 'other', never dropped. `Submitted` is the one
// shelf the sync never writes: it holds what the student handed in, put there by hand when he submits (SPEC §20.58).
// `Textbook` is a section of the course, not of a week: the e-book a chapter a page (SPEC §20.67).
const BUCKET = { Notes: 'notes', Lectures: 'lectures', Recordings: 'recordings', 'Study sheets': 'sheets', Problems: 'problems', Plan: 'plan', Readings: 'readings', Videos: 'videos', Assignments: 'assignments', Submitted: 'submitted', Textbook: 'textbook' }
// A link in the page's own text wins; otherwise the file's Quercus id gives us one.
const CONTAINERS = new Set(['Notes', 'Lectures', 'Recordings', 'Study sheets', 'Problems', 'Plan', 'Announcements', 'General', 'Links', 'Readings', 'Videos', 'Assignments', 'Submitted', 'Textbook'])
const LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/

export function register(app, ctx) {
  const { store, ROOT, wrap } = ctx
  const hubJson = async (n, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, 'Hub', n), 'utf8')) } catch { return d } }
  app.get('/api/library', wrap(async (req, res) => {
    if (memo.promise && Date.now() - memo.at < MEMO_MS) return res.json(await memo.promise)
    memo = { at: Date.now(), promise: build(store, hubJson) }
    memo.promise.catch(() => { memo.promise = null })
    res.json(await memo.promise)
  }))
}

async function build(store, hubJson) {
  const hub = await hubJson('_hub.json', { courses: [] })
  const state = await hubJson('_sync-state.json', { files: {} })
  // name → Quercus file id, so a page filed from a download can link back to the file itself.
  const fileIds = new Map()
  for (const [id, f] of Object.entries(state.files || {})) if (f?.name) fileIds.set(String(f.name).toLowerCase(), id)

  const courses = (hub.courses || []).map(c => ({ key: c.key, code: c.code, name: c.name, color: c.color || null, url: c.url || null }))
  const rows = []
  const add = async (p, c, where, bucket) => {
    const r = await docRow(store, p, c, where, bucket, fileIds)
    if (r) rows.push(r)
  }
  for (const c of courses) {
    const terms = [...new Set(weeks(COURSES[c.key]?.term || 'Y').map(w => w.term))]
    for (const term of terms) {
      for (const wk of await store.pages(`${c.key}/${term}`)) {
        const where = { term, week: wk.title, weekN: Number(/^Week\s+(\d+)/.exec(wk.title)?.[1]) || null }
        for (const b of wk.children) {
          const bucket = BUCKET[b.title] || 'other'
          if (bucket === 'plan') continue                       // a to-do list is not a document
          if (!b.virtual) await add(b, c, where, bucket)        // the bucket's own page, when written on
          for (const kid of b.children) await add(kid, c, where, bucket)
        }
      }
    }
    for (const [sec, bucket] of [['General', 'course info'], ['Announcements', 'announcements']]) {
      for (const p of await store.pages(`${c.key}/${sec}`)) {
        if (!p.virtual) await add(p, c, {}, bucket)
        for (const kid of p.children) await add(kid, c, {}, bucket)
      }
    }
    // Any other section of the notebook — the course-level `Videos` the sync writes a MyMedia download into before it is
    // filed (SPEC §20.56), or a section the student made — is walked too: a document that exists is in the Library wherever it sits.
    const known = new Set([...terms, 'General', 'Announcements'])
    for (const sec of (await store.pages(c.key).catch(() => [])).filter(s => !known.has(s.title) && (s.children || []).length)) {
      const bucket = BUCKET[sec.title] || 'other'
      if (bucket === 'plan') continue
      for (const kid of sec.children) await add(kid, c, {}, bucket)
    }
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.modified || 0) - (a.modified || 0))
  return { updatedAt: new Date().toISOString(), courses, rows: pairRows(rows) }
}

// A problem set and its solutions are one document with two views (SPEC §20.32). Within a week's problems they are one
// row, named for the set — `Problem Set 1 (questions + solutions)` — with the solutions riding on it; a guide says it is one.
function pairRows(rows) {
  const weeks = new Map()
  for (const r of rows) {
    if (r.bucket !== 'problems') continue
    const k = `${r.courseKey}|${r.term}|${r.week}`
    if (!weeks.has(k)) weeks.set(k, [])
    weeks.get(k).push(r)
  }
  const drop = new Set(), patch = new Map()
  for (const list of weeks.values()) {
    for (const s of pairSets(list)) {
      const solutions = s.questions && s.solutions ? { path: s.solutions.path, title: s.solutions.title, url: s.solutions.url || null } : null
      patch.set(s.main, { title: s.label, setName: s.name, role: s.role === 'guide' ? 'guide' : solutions ? 'set' : s.solutions ? 'solutions' : 'questions', solutions })
      if (solutions) drop.add(s.solutions)
    }
  }
  return rows.filter(r => !drop.has(r)).map(r => (patch.has(r) ? { ...r, ...patch.get(r) } : r))
}

// A row only exists if the page is a document: it carries a file, it carries words someone wrote, or it is the page for
// something that lives elsewhere — a video on MyMedia, a forum, a quiz — and says so with a link (SPEC §20.57).
async function docRow(store, p, c, where, bucket, fileIds) {
  const pg = await store.readPage(p.path).catch(() => null)
  if (!pg) return null
  const assets = pg.assets || [], els = pg.layout?.elements || []
  const body = (pg.blocks || []).map(b => b.md).join('\n')
  const words = body.replace(/^---[\s\S]*?---/, '').replace(/^#.*$/gm, '').replace(/^_.*_$/gm, '').trim().split(/\s+/).filter(Boolean).length
  const files = assets.filter(a => !TRANSCRIPT.test(a) && !/\.(txt|json)$/i.test(a))   // a transcript is not the document
  const pdfs = files.filter(a => DOC.test(a)).length + els.filter(e => e.type === 'pdf').length
  const audio = files.filter(a => AUDIO.test(a)).length
  const video = files.filter(a => VIDEO.test(a)).length
  const images = files.filter(a => IMG.test(a)).length
  const hasFile = pdfs + audio + video + images > 0
  const tags = Array.isArray(pg.frontmatter?.tags) ? pg.frontmatter.tags.map(String) : []
  // The three videos of FCS298's Module 1 were pages of a link and one line each — under the forty-word bar, so the
  // week showed them and the Library did not. A page whose text points somewhere is the document for that thing.
  const link = LINK_RE.exec(body)?.[1] || null
  const hasLink = !!link
  // A video is a video wherever it was filed: the welcome video the sync put under General belongs with the module's.
  if ((bucket === 'course info' || bucket === 'other') && (video > 0 || tags.includes('video'))) bucket = 'videos'
  // A started note is a note (SPEC §20.26): `startNote` writes `# ECO208 Week 1 note` into the week's sheet the
  // moment the student opens it to write, so a heading of its own — anything but the bare bucket name the importer left —
  // counts, and a note he has begun turns up on My notes before the first paragraph is finished.
  // A note added beside a week's sheet (`Notes/ECO206 Week 1 note 2.md`, SPEC §20.33) is named by the same heading as its
  // file, and is a note from the moment it exists — it was created on purpose, not scaffolded.
  const heading = (body.match(/^#\s+(.+?)\s*$/m)?.[1] || '').trim()
  const named = bucket === 'notes' && !!heading && (heading.toLowerCase() !== p.title.toLowerCase() || /\/Notes\//.test(p.path))
  // A container is a folder wearing a page's clothes — `Study sheets`, `Announcements`, `Notes` with nothing in
  // them. 79 of those passed the first draft of this filter, which is the same noise in a different shape.
  if (CONTAINERS.has(p.title) && !hasFile && !named) return null
  // The bar: carry a file, be a note someone started, point at something, or carry enough writing to be worth opening.
  const MIN = bucket === 'announcements' ? 15 : bucket === 'notes' ? 1 : 40
  if (!hasFile && !named && !hasLink && words < MIN) return null

  const fileName = files[0] || null
  const url = link
    || (fileName && fileIds.has(fileName.toLowerCase()) && c.url ? `${c.url}/files/${fileIds.get(fileName.toLowerCase())}` : null)
    || null
  return {
    title: p.title, path: p.path, bucket, kind: p.kind || null, modified: p.modified || null,
    courseKey: c.key, course: c.code, color: c.color, courseUrl: c.url,
    term: where.term || null, week: where.week || null, weekN: where.weekN ?? null,
    date: /\((\d{4}-\d{2}-\d{2})\)/.exec(p.title)?.[1] || /^(\d{4}-\d{2}-\d{2})/.exec(p.title)?.[1] || null,
    file: fileName, ext: fileName ? (fileName.split('.').pop() || '').toUpperCase() : null,
    pdfs, audio, video, images, words,
    transcribed: assets.some(a => TRANSCRIPT.test(a)),
    fromQuercus: tags.includes('quercus') || bucket === 'announcements',
    url,
  }
}
