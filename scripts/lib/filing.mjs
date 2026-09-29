// Where a course file belongs (SPEC §20.21, §20.32).
//
// The sync used one rule — audio or video to Recordings, *everything else* to Lectures — so ECO206's
// "Problem_Set_1_Questions", "Problem_Set_1_Questions_and_Solutions" and "Tutorial_1_Questions" were all filed as
// lectures. A problem set is not a lecture, and a folder that mixes them is a folder you have to read twice.
//
// The name is the first evidence. Order matters: the first rule that matches wins, and the specific traps come before
// the general words. Nothing here guesses from a single loose word.
//
// §20.32 corrected two of the traps, both wrong the same way. "Problem Solving Steps" was sent to Lectures as a
// "study-skills handout"; it is the method for the problem sets, posted by the professor *under* "Ungraded problem set
// and application", and reading it among the slides is what the student objected to. It is a guide now, filed with the
// problems. And "study habits" was on the same trap list, which swept "Application 1: Study Habits" — a worksheet
// that ends in questions to answer — into Lectures too. An application is work to do.
//
// The second evidence is *where the professor put it*: the heading of the Quercus page that links the file ("Class
// slides", "Ungraded problem set and application", "Tutorial slot"). It decides only when the name does not.
export const BUCKETS = ['recordings', 'problems', 'solutions', 'guides', 'admin', 'lectures']

const norm = s => String(s || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

const MEDIA = /\.(mp4|mov|webm|m4a|mp3|wav|aac|flac|ogg)$/i
// How to work the problems, not problems: filed with them, drawn as a guide.
const GUIDE = /\b(problem solving (steps|guide|approach|process|strategies)|how to (solve|approach|attempt))\b/
// Traps: these contain a bucket word but are not that bucket.
const NOT_PROBLEMS = /\b(study skills|application coach)\b/
// A worked answer, whether or not the questions are with it.
const SOLUTIONS = /\b(solutions?|answers?|answer key|worked (solutions?|examples?)|marking scheme)\b/
// Something to attempt. `application 1`, `application w1`: ECO206's weekly applied worksheet.
const PROBLEMS = /\b(problem set|problemset|pset|homework \d*|hw ?\d+|tutorial \d*\s*(questions?|problems?|exercises?)?|tutorial|exercises?|practice (questions?|problems?|set)|questions?|worksheet|assignment \d*|application (w(eek)? ?)?\d+)\b/
// Course administration, which belongs in General rather than any week.
const ADMIN = /\b(syllabus|course outline|outline|academic integrity|policy|policies|grading scheme|office hours|accessibility|misconduct)\b/
// What a section heading on a course page says the files under it are.
const HEAD_PROBLEMS = /\b(problem sets?|problems|exercises|practice|tutorials?|applications?|homework|assignments?|worksheets?)\b/
const HEAD_LECTURES = /\b(class slides|lecture slides|slides|lecture notes|handouts?|readings?)\b/

// bucketFor('ECO206_Problem_Set_1_Questions.pdf') → 'problems'
// Pass `module` (the Quercus module the file sat in) and `heading` (the heading above its link on a course page, see
// headingFor) when you have them; they break ties the name cannot.
export function bucketFor(filename, { module: mod = '', heading = '' } = {}) {
  if (MEDIA.test(String(filename))) return 'recordings'
  const n = norm(filename), m = norm(mod), h = norm(heading)
  if (ADMIN.test(n) || (ADMIN.test(m) && !PROBLEMS.test(n))) return 'admin'
  if (GUIDE.test(n)) return 'guides'
  if (NOT_PROBLEMS.test(n)) return 'lectures'
  if (SOLUTIONS.test(n)) return 'solutions'
  if (PROBLEMS.test(n)) return 'problems'
  // The name is not decisive; where it was posted is.
  if (h && HEAD_PROBLEMS.test(h) && !HEAD_LECTURES.test(h)) return 'problems'
  if (h && HEAD_LECTURES.test(h)) return 'lectures'
  if (PROBLEMS.test(m)) return 'problems'
  return 'lectures'
}

// headingFor(md, needles) → the text of the nearest heading above the first line that mentions any needle (a file name, a
// `/files/<id>` URL), with the page's own numbering ("2  ·  ") stripped; '' when nothing matches. Pure.
export function headingFor(md, needles) {
  const want = (Array.isArray(needles) ? needles : [needles]).filter(Boolean).map(s => String(s).toLowerCase())
  if (!want.length) return ''
  const lines = String(md || '').split('\n')
  const i = lines.findIndex(l => { const t = l.toLowerCase(); return want.some(w => t.includes(w)) })
  for (let j = i; j >= 0; j--) {
    const hd = /^#{1,6}\s+(.+?)\s*$/.exec(lines[j])
    if (hd) return hd[1].replace(/\*\*/g, '').replace(/^[\d\s·.:–—-]+/, '').trim()
  }
  return ''
}

// ---- which week (SPEC §20.33) -------------------------------------------------------------------------------------
// pageWeek(title, module, weeks) → { week, lecture, title } | null — the week a synced Quercus page belongs to.
//   "1: Constrained Optimization", "Week 3 Reading"              → that week, titled without its number
//   "Lecture 2: Mythology, Hesiod 1" in module "Week 1 (Sept. 8-11)" → Week 1, `lecture: true` (filed under Lectures)
//   anything else ("Key Dates", "The Instructor + TAs")          → null: course-wide, General
export function pageWeek(title, module, weeksList) {
  const t = String(title || '')
  const own = /^(?:week\s*)?(\d{1,2})\s*[:.\-–—]?\s*/i.exec(t)
  const w = own ? weeksList[Number(own[1]) - 1] : null
  if (w) return { week: w, lecture: false, title: t.slice(own[0].length) || t }
  if (/^(lecture|slides|video|recording)\b/i.test(t)) {
    const m = /^week\s*(\d{1,2})\b/i.exec(String(module || ''))
    const mw = m ? weeksList[Number(m[1]) - 1] : null
    if (mw) return { week: mw, lecture: true, title: t }
  }
  return null
}
// fileWeek(posted, from, weeks) → the week a file belongs to: the week it was posted in, unless the page linking it is
// next week's reading, posted a week early on purpose (CLA204 links the Homeric Hymn from "Next Week's Reading").
export const fileWeek = (posted, from, weeksList) => (!posted ? null : /\bnext week/i.test(String(from || '')) ? weeksList.find(x => x.n === posted.n + 1) || posted : posted)

// The folder inside a week that a bucket lives in. Solutions and guides sit with the problems they belong to — a seventh
// folder per week would cost more than it explains — but they keep their own bucket so the app can label them.
export const FOLDER = { recordings: 'Recordings', problems: 'Problems', solutions: 'Problems', guides: 'Problems', lectures: 'Lectures' }
export const folderFor = (filename, opts) => FOLDER[bucketFor(filename, opts)] || 'Lectures'
export const isAdmin = (filename, opts) => bucketFor(filename, opts) === 'admin'
