// The class sessions a course has produced, and whether one is finished enough to study from.
//
// A session reaches slate one of two ways (SPEC 18.1), and neither is privileged — a class that
// happened is a session whichever way its material landed:
//   · a Desktop folder, `~/Desktop/<Course>/Session <N> <MM:DD:YYYY>/` with `Files/`, `Audio
//     recording/` and `Notes/` inside — how the student hands over a class he has just recorded;
//   · a recording already filed in the notebook under `<Term>/<Week>/Recordings/` — how a class
//     arrives when he drops the audio into the app, or when the sync files it for him.
// Reading only the Desktop is what silently hid ECO206's 9 Sep lecture: the recording and its
// transcript were in the notebook, correctly filed, but no folder existed, so the queue reported it
// neither ready nor blocked — an empty queue that read as "nothing to do".
//
// The date is the calendar of record: it beats every file mtime and decides which week a session
// belongs to. When both places describe the same date it is one session, and the Desktop folder
// wins, because it also carries `Files/` and `Notes/`.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { weekFor, weeks, isoOf, todayIso } from './terms.mjs'

export const SHEETS_DIR = 'Study sheets'          // slate's output inside the Desktop course folder
// A skill's scratch folder beside what it hands in: the webassign skill writes `<Set> — answers (…).md` and keeps its
// screenshots, crops and measuring scripts in `<Set> — work/`. Walking into it sent 39 of those to the inbox as pages,
// each for Claude to ignore by hand (2026-09-25). A dash with a space before it, so `Homework/` is still a folder.
export const isScratchDir = name => /\s[—–-]\s*work$/i.test(name)
const AUDIO_RE = /\.(m4a|mp3|wav|aac|ogg|flac|aiff|caf|mp4|mov|webm)$/i
// What counts as material for a sheet: the documents themselves, never the caches slate writes
// beside them.
const DOC_RE = /\.(pdf|pptx?|docx?|key|pages|txt|md|csv|xlsx?|png|jpe?g|gif|webp|svg)$/i
const CACHE_RE = /(\.pdf\.txt|\.transcript\.json|\.srt|\.vtt)$/i
const SESSION_RE = /^Session\s+(\d+)\s+(\d{2}):(\d{2}):(\d{4})$/

const ls = async d => fs.readdir(d, { withFileTypes: true }).catch(() => [])
const filesIn = async d => (await ls(d)).filter(e => e.isFile() && !e.name.startsWith('.')).map(e => path.join(d, e.name))
export const deskDir = course => path.join(os.homedir(), 'Desktop', course)
export { notesRoot } from './root.mjs'

const asIso = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null
// The class date written into a name. ISO is what the app writes; `MM-DD-YYYY` is what the student's
// recorder produces (`ECO 206 09-09-2026.m4a`) and `MM:DD:YYYY` what his Desktop folders use, so
// month-first is the house convention — but a month over 12 is read the other way round rather than
// thrown away.
export function dateFromName(name) {
  const s = String(name || '')
  const ymd = /(20\d{2})[-.](\d{1,2})[-.](\d{1,2})/.exec(s)
  if (ymd) return asIso(+ymd[1], +ymd[2], +ymd[3])
  const mdy = /(\d{1,2})[-.:](\d{1,2})[-.:](20\d{2})/.exec(s)
  if (!mdy) return null
  let mo = +mdy[1], d = +mdy[2]
  if (mo > 12 && d <= 12) [mo, d] = [d, mo]
  return asIso(+mdy[3], mo, d)
}

// The Desktop session folders.
async function deskSessions(course, term) {
  const root = deskDir(course), out = []
  for (const e of await ls(root)) {
    if (!e.isDirectory()) continue
    const m = SESSION_RE.exec(e.name)
    if (!m) continue
    const dir = path.join(root, e.name)
    const date = `${m[4]}-${m[2]}-${m[3]}`                       // MM:DD:YYYY on disk → ISO
    const all = [...await filesIn(path.join(dir, 'Files')), ...await filesIn(dir)]
    out.push({
      origin: 'desk', n: Number(m[1]), name: e.name, dir, date, week: weekFor(term, date), recording: null,
      files: all.filter(f => !AUDIO_RE.test(f)),
      audio: [...await filesIn(path.join(dir, 'Audio recording')), ...all.filter(f => AUDIO_RE.test(f))],
      notes: await filesIn(path.join(dir, 'Notes')),
    })
  }
  return out
}

// Every recording filed under a week's `Recordings/`: one session per recording page, because a week
// holds several meetings (ECO208: tutorial Tuesday, lecture Thursday) and each earns its own sheet.
// The session's documents are that week's `Lectures/` assets — the decks it was taught from — and its
// `Readings/` and `Textbook/` assets: the chapter or the textbook sections the week is on (SPEC §20.53, §20.67), which
// the sheet is built from beside the slides.
async function notebookSessions(course, term, root) {
  const out = []
  for (const w of weeks(term)) {
    const dir = path.join(root, course, w.dir, 'Recordings')
    const entries = await ls(dir)
    if (!entries.length) continue
    let docs = null                                              // the week's decks, read once and shared
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const title = e.name.slice(0, -3)
      const audio = (await filesIn(path.join(dir, `${title}.assets`))).filter(f => AUDIO_RE.test(f))
      if (!audio.length) continue                                // a header page whose recording is not there yet
      const date = dateFromName(title) || dateFromName(path.basename(audio[0]))
        || isoOf(await fs.stat(audio[0]).then(s => s.mtime).catch(() => new Date()))
      if (docs === null) {
        docs = []
        for (const shelf of ['Lectures', 'Readings', 'Textbook']) {
          const dir2 = path.join(root, course, w.dir, shelf)
          for (const d of await ls(dir2)) {
            if (!d.isDirectory() || !d.name.endsWith('.assets')) continue
            docs.push(...(await filesIn(path.join(dir2, d.name))).filter(f => DOC_RE.test(f) && !CACHE_RE.test(f) && !AUDIO_RE.test(f)))
          }
        }
      }
      out.push({
        origin: 'notebook', n: 0, name: title, dir, date, week: weekFor(term, date) || w,
        recording: path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'),
        files: docs, audio, notes: [],
      })
    }
  }
  return out
}

// Every session for a course, oldest first. `date` is ISO; `week` is null outside the term.
export async function sessionsFor(course, term, root = notesRoot()) {
  const byDate = new Map()
  for (const s of await deskSessions(course, term)) byDate.set(s.date, s)
  for (const s of await notebookSessions(course, term, root)) if (!byDate.has(s.date)) byDate.set(s.date, s)
  const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n)
  // A Desktop folder carries its own number and keeps it — renumbering would rename a sheet that may
  // already exist. One found in the notebook is numbered by where it falls in the course's own
  // order, so `Session 2 (…)` still means the second class.
  return all.map((s, i) => (s.origin === 'desk' ? s : { ...s, n: i + 1 }))
}

export const sessionKey = (course, s) => `sheet:${course}/${s.name}`
export const sheetTitle = s => `Session ${s.n} (${s.date})`
// The page in the notebook, and the standalone file in the Desktop course folder (SPEC 18.4).
export const sheetPage = (s) => `${s.week.dir}/Study sheets/${sheetTitle(s)}.md`
export const sheetHtml = (course, s) => path.join(deskDir(course), SHEETS_DIR, `${s.week.label} — ${sheetTitle(s)}.html`)

// Why a session is not ready yet, or null when it is (SPEC 18.2). `have` is the set of file names
// already somewhere in the notebook, lowercased, as quercus-sync builds it.
export function blockedBecause(s, { have, transcripts, today = todayIso() }) {
  if (!s.week) return 'outside the term calendar'
  if (s.date > today) return `dated ${s.date}, has not happened yet`
  // A Desktop folder with no `Files/` is an upload still in progress (SPEC 18.2). A session found in
  // the notebook is the other way round — the recording is the material, and the week's deck may not
  // be posted at all — so it needs only that something is there.
  if (s.origin === 'desk' ? !s.files.length : !s.files.length && !s.audio.length) return 'no files uploaded'
  const missing = s.files.map(f => path.basename(f)).filter(n => !have.has(n.toLowerCase()))
  if (missing.length) return `not synced into the notebook yet: ${missing.join(', ')}`
  const untranscribed = s.audio.filter(a => !transcripts.has(path.basename(a).replace(/\.[^.]+$/, '').replace(/[\/\\:]/g, '-')))
  if (untranscribed.length) return `recording not transcribed yet: ${untranscribed.map(a => path.basename(a)).join(', ')}`
  return null
}
