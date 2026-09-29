// The textbook, cut to the week (SPEC §20.67, §20.68).
//
// Two shapes of book. ECO227's is Wackerly, Mendenhall & Scheaffer behind WebAssign — a MindTap e-book, not a PDF: each
// chapter is one JSON document of sections, each section its HTML, with MathML for the mathematics and a figure as a
// `metadata` stub the reader turns into an image. ECO206's is Perloff, a book that arrives as one PDF with an outline
// (bookmarks) naming its chapters and numbered sections: there a section is a page range, and a cut is pages copied.
// `scripts/textbook.mjs import` keeps either under the course's `Textbook/` section, a chapter a page; the weekly
// pass reads what the course names for each week — the outline's `chapters` line (scripts/lib/syllabus.mjs) or, when
// the outline is published week by week on Quercus, the topic page's own "Read: Textbook 3.1–3.3" line — and puts
// just those sections onto the week's Textbook shelf.
//
// Everything here is pure: the outline's words → which sections, a chapter document → the HTML Chrome prints, a PDF's
// outline → chapters with page ranges → the ranges a week takes. Nothing reads a disk. The tests
// (scripts/test-textbook.mjs) drive these on fixtures.

// ---- what the outline asks for -------------------------------------------------------------------------------------
// parseChapters('2.1–2.3')            → Map { 2 → { sections: Set {1, 2, 3} } }
// parseChapters('Syllabus, Ch 1')     → Map { 1 → { all: true } }            (the syllabus is not in the book)
// parseChapters('7.5, 8.1–8.4')       → Map { 7 → { sections: {5} }, 8 → { sections: {1, 2, 3, 4} } }
// parseChapters('5.5–5.8, 5.10–5.11') → Map { 5 → { sections: {5, 6, 7, 8, 10, 11} } }   (5.9 is left out, as the outline leaves it)
// parseChapters('Chapters 1–3.4')     → Map { 1 → all, 2 → all, 3 → { sections: {1, 2, 3, 4} } }
// parseChapters('Review 5.1–5.3, 5.4') → Map { 5 → { sections: {1, 2, 3, 4} } }   (a review is still those sections)
// parseChapters('')                   → an empty Map
// parseChapters('Ch. 1 + Calculus Appendix') → Map { 1 → all, 'appendix:calculus' → { all: true, appendix: 'Calculus' } }
// parseChapters('3.4, 4.1, 5.4, 2.5')  → Map { 3 → {4}, 4 → {1}, 5 → {4}, 2 → {5} }   (in the order the professor listed them)
// Numbers before the first dot are chapters; a bare number is a whole chapter; `fromEnd: n` means section n and
// everything after it ("2.7–3.4" takes chapter 2 from 2.7 to its end). An appendix — "Calculus Appendix", "Appendix
// A", "Appendix 1" — is a string key `appendix:<name>` (the name lower-cased, '' when the outline just says
// "Appendix"), matched against the book's own appendices by title. Anything else that is not a number or a range is
// dropped, so "Syllabus", "Review" and "Textbook" never become a chapter. Chapters keep the outline's order: a week
// that reads 3.4, 4.1, 5.4 and then 2.5 is cut in that order, since the professor chose it.
export function parseChapters(text) {
  const out = new Map()
  let s = String(text || '')
  // An appendix becomes its own token, in place, so the word before "Appendix" is not read as a chapter and the
  // outline's order is kept ("Ch. 1 + Calculus Appendix" is chapter 1, then the appendix).
  s = s.replace(/\b(?:the\s+)?(?:([A-Za-z][A-Za-z-]*)\s+)?appendi(?:x|ces)(?:\s+([A-Z]|\d+))?\b\.?/gi, (m, before, after) => {
    const name = String(after || (before && !/^(and|the|plus|with|textbook|ch|chapters?)$/i.test(before) ? before : '') || '').trim()
    return `, @appendix:${name}, `
  })
  const want = (c, from, to) => {
    const cur = out.get(c) || { sections: new Set(), fromEnd: null, all: false }
    if (from == null) cur.all = true
    else if (to === Infinity) cur.fromEnd = cur.fromEnd == null ? from : Math.min(cur.fromEnd, from)
    else for (let k = from; k <= to; k++) cur.sections.add(k)
    out.set(c, cur)
  }
  s = s.replace(/\b(chapters?|ch|review|syllabus|textbook|sections?|in the|of the)\b\.?/gi, ' ').replace(/[–—]/g, '-').replace(/[&+]/g, ',')
  for (const tok of s.split(/[,;]|\band\b|\bplus\b/).map(t => t.trim()).filter(Boolean)) {
    const app = /^@appendix:(.*)$/.exec(tok)
    if (app) { const name = app[1].trim(); out.set(`appendix:${name.toLowerCase()}`, { all: true, appendix: name }); continue }
    const m = /^(\d+)(?:\.(\d+))?\s*(?:-\s*(\d+)(?:\.(\d+))?)?$/.exec(tok)
    if (!m) continue
    const c1 = +m[1], s1 = m[2] != null ? +m[2] : null, c2 = m[3] != null ? +m[3] : c1, s2 = m[4] != null ? +m[4] : null
    if (c2 < c1) continue
    for (let c = c1; c <= c2; c++) {
      const from = c === c1 ? s1 : null, to = c === c2 ? s2 : null
      if (from == null && to == null) want(c, null)                    // a whole chapter
      else if (c === c1 && c === c2) want(c, from, to ?? from)         // 2.1–2.3, or 7.5 alone
      else if (c === c1) want(c, from ?? 1, Infinity)                  // 2.7–3.4: chapter 2 from 2.7 to its end
      else if (c === c2) want(c, 1, to ?? Infinity)                    // … chapter 3 up to 3.4
      else want(c, null)                                               // the chapters between: whole
    }
  }
  for (const [c, v] of out) if (typeof c === 'number') out.set(c, v.all ? { all: true } : { sections: v.sections, fromEnd: v.fromEnd })
  return out
}

// The short name a course's textbook goes by — the parenthesised initials when the terms.mjs line gives them
// ("… (WMS) · WebAssign" → WMS), else the first author (the text before the first comma: "Perloff, Microeconomics …"
// → Perloff). The same rule as src/plan.js textbookName, which names the To do rows ("Read Perloff 3.1–3.3").
export const shortBookName = (text, fallback = 'Textbook') => { const t = String(text || '').replace(/\s*·.*$/, ''); const a = /\(([A-Z]{2,6})\)/.exec(t); return a ? a[1] : (t.split(',')[0].trim() || fallback) }

// What a week's synced Quercus topic page says to read in the book — ECO206's pages carry one line each,
// "- **Read:** Textbook 3.4, 4.1, 5.4, 2.5" or "**Read:** Textbook Ch. 1 + Calculus Appendix" — as the outline's
// words: 'Ch. 1 + Calculus Appendix', '3.1–3.3'. The word "Textbook" and the book's own name are stripped so that the
// page is titled like a syllabus cut ("Perloff 3.1–3.3"). A line naming no chapter of the book — "Read the case
// study", a reading with a URL — is not a textbook line: null. The first textbook line on the page wins.
export function readLineChapters(markdown, { book = '' } = {}) {
  const names = ['textbook', 'the text', 'the book', book].filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  for (const line of String(markdown || '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:\*\*)?\s*Read(?:ing)?s?\s*:?\s*(?:\*\*)?\s*:?\s*(.+?)\s*$/i.exec(line)
    if (!m) continue
    let rest = m[1].replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
    if (/https?:\/\//i.test(rest)) continue
    const named = new RegExp(`\\b(?:in\\s+)?(?:the\\s+)?(?:${names.join('|')})\\b[,:]?`, 'i')
    if (!named.test(rest)) continue
    rest = rest.replace(new RegExp(named.source, 'gi'), ' ').replace(/\s+/g, ' ').replace(/^[\s,:;·-]+|[\s,:;·.-]+$/g, '').trim()
    if (!parseChapters(rest).size) continue
    return rest
  }
  return null
}

// The outline's words as a page title: 'WMS 2.1–2.3', 'WMS Ch 1' — the syllabus stripped, since it is not in the
// book, so that a task reading "Read WMS Syllabus, Ch 1" still names the page (src/resolve.js needs the numbers said
// and most of the words). `book` is the short name terms.mjs gives the textbook ("WMS").
export const readingTitle = (book, chapters) => `${book} ${String(chapters || '').replace(/^\s*syllabus\s*,?\s*/i, '').replace(/\s+/g, ' ').trim()}`.trim()

// ---- a book that is one PDF ----------------------------------------------------------------------------------------
// The PDF's own outline (its bookmarks, as PyMuPDF's get_toc gives them: [level, title, page] with page 1-based, or
// as a hand-written list [{ level, title, page }]) → the chapters of the index, each a page range with its numbered
// sections as page ranges: { n, type: 'chapter' | 'appendix', title, from, to, sections: [{ label, title, kind, from, to }] }.
// A top-level entry "Chapter 3 A Consumer's Constrained Choice" (or just "3 …") opens chapter 3; "Calculus Appendix",
// "Appendix A" open an appendix; an entry "3.1 Preferences" under it is section 3.1; "Summary", "Exercises", anything
// unnumbered after the last numbered section is the chapter's review (kind 'review'); anything unnumbered before the
// first — Perloff's opening "Challenge" — is the chapter's own opening (kind 'intro'), taken with the first section.
// A section runs from its page to the page its successor starts on, inclusive — a section rarely starts at the top
// of a page, so the boundary page belongs to both and a cut takes the union. A chapter runs to the page before the
// next top-level entry. Entries before the first chapter (the preface, the contents) are not in the index.
export function tocToChapters(toc, { pageCount = null, labels = null } = {}) {
  const rows = (toc || []).map(e => Array.isArray(e) ? { level: +e[0], title: String(e[1] || '').trim(), page: +e[2] } : { level: +e.level || 1, title: String(e.title || '').trim(), page: +e.page })
    .filter(r => r.title && Number.isFinite(r.page) && r.page >= 1)
  const isChapter = t => /^(?:chapter\s+)?(\d+)(?!\.\d)\b[\s:.—–-]*(.*)$/i.exec(t.replace(/\s+/g, ' '))   // "1 …" or "Chapter 1 …", never "1.1 …"
  const isAppendix = t => /\bappendi(?:x|ces)\b/i.test(t)
  // The level the chapters live at: the one with the most chapter-looking entries (a book whose outline has Parts
  // above its chapters keeps the chapters one level down; the Parts are then skipped).
  const counts = new Map()
  for (const r of rows) if (isChapter(r.title)) counts.set(r.level, (counts.get(r.level) || 0) + 1)
  const chLevel = counts.size ? [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : (rows.length ? Math.min(...rows.map(r => r.level)) : 1)
  const chapters = []
  let cur = null
  const close = page => { if (cur) cur.to = Math.max(cur.from, page - 1); cur = null }
  for (const r of rows) {
    const t = r.title.replace(/\s+/g, ' ')
    if (r.level < chLevel) continue                                 // a Part: its chapters follow
    if (r.level === chLevel) {
      const ch = isChapter(t)
      close(r.page)
      if (ch) cur = { n: +ch[1], type: 'chapter', title: `Chapter ${ch[1]}${ch[2] ? ' — ' + ch[2].trim() : ''}`, from: r.page, to: r.page, sections: [] }
      else if (isAppendix(t)) cur = { n: null, type: 'appendix', title: t, from: r.page, to: r.page, sections: [] }
      if (cur) chapters.push(cur)                                    // else: the preface, the index, the glossary — not in the book proper
      continue
    }
    if (!cur || r.level !== chLevel + 1) continue                    // deeper entries (3.1's sub-heads) are inside their section already
    const sec = cur.type === 'chapter' ? new RegExp(`^${cur.n}\\.(\\d+)\\b[\\s:.—–-]*(.*)$`).exec(t) : null
    if (sec) cur.sections.push({ label: `${cur.n}.${sec[1]}`, title: sec[2].trim() || t, kind: 'section', from: r.page, to: r.page })
    else cur.sections.push({ label: null, title: t, kind: cur.sections.some(x => x.kind === 'section') ? 'review' : 'intro', from: r.page, to: r.page })
  }
  if (cur) cur.to = Math.max(cur.from, (pageCount || cur.from))
  for (const c of chapters) {
    for (let i = 0; i < c.sections.length; i++) {
      const s = c.sections[i], next = c.sections[i + 1]
      s.to = next ? Math.max(s.from, next.from) : c.to
    }
    if (labels) c.pages = pageSpan([[c.from, c.to]], labels)
  }
  return chapters
}

// The page ranges of a chapter a want ({ all } | { sections, fromEnd }) asks for — cutChapter for a PDF book: the
// whole chapter, or the numbered sections in the want, the chapter's opening pages (its first page up to the first
// section, bookmarked as "Challenge" or not bookmarked at all) with the first section and the review with the last,
// merged into as few ranges as possible. → [[from, to], …], or [] when the chapter has none of them.
export function cutPdfRanges(chapter, want) {
  if (!chapter || !want) return []
  if (want.all) return [[chapter.from, chapter.to]]
  const numberedSecs = chapter.sections.filter(s => s.kind === 'section')
  const numbered = numberedSecs.map(s => Number(String(s.label).split('.')[1]))
  const first = numbered.length ? Math.min(...numbered) : 0, last = numbered.length ? Math.max(...numbered) : 0
  const has = k => want.sections?.has(k) || (want.fromEnd != null && k >= want.fromEnd)
  const take = chapter.sections.filter(s => (s.kind === 'section' && has(Number(String(s.label).split('.')[1]))) || (s.kind === 'review' && last > 0 && has(last)))
  const ranges = take.map(s => [s.from, s.to])
  if (first > 0 && has(first)) ranges.push([chapter.from, numberedSecs.find(s => Number(String(s.label).split('.')[1]) === first).from])
  return mergeRanges(ranges)
}

// Overlapping or touching ranges folded into one, sorted.
export function mergeRanges(ranges) {
  const out = []
  for (const [a, b] of [...ranges].filter(r => r && Number.isFinite(r[0]) && Number.isFinite(r[1])).map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

// The book's own page numbers a set of ranges covers — 'pp. 61–75', or 'pp. 81–95, 106–110, 159–176, 30–41' for a
// week that reads four sections from four chapters, in the order given (the professor's) — from the PDF's page labels
// when it has them (labels[i] is the label of PDF page i+1: '61', 'xiv', or null), else from the PDF page numbers
// themselves. Ranges that touch or overlap in sequence fold into one; a range out of order stays where it was said.
export function pageSpan(ranges, labels = null) {
  const seq = []
  for (const r of ranges || []) {
    if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue
    const [a, b] = [Math.min(r[0], r[1]), Math.max(r[0], r[1])]
    const last = seq[seq.length - 1]
    if (last && a <= last[1] + 1 && b >= last[0] - 1) { last[0] = Math.min(last[0], a); last[1] = Math.max(last[1], b) }
    else seq.push([a, b])
  }
  if (!seq.length) return null
  const lab = p => { const l = labels && labels[p - 1]; return l != null && String(l).trim() ? String(l).trim() : String(p) }
  const parts = seq.map(([a, b]) => (lab(a) === lab(b) ? lab(a) : `${lab(a)}–${lab(b)}`))
  return seq.length === 1 && seq[0][0] === seq[0][1] ? `p. ${parts[0]}` : `pp. ${parts.join(', ')}`
}

// ---- a chapter document, grouped ------------------------------------------------------------------------------------
// A MindTap chapter is a flat list of sections: the chapter contents (CHTOC), then for each numbered section an AHEAD
// followed by its BHEADs (Exercises, "… Using R"), then a `Chapter Review` AHEAD whose BHEADs are the summary, the
// references and the supplementary exercises. groupSections folds that into groups, one per AHEAD, each carrying its
// number when it has one: { label: '2.3' | null, title, kind: 'contents' | 'section' | 'review' | 'other', sections }.
export function groupSections(doc) {
  const groups = []
  let cur = null
  for (const s of doc?.sections || []) {
    const type = String(s.sectionType || '')
    if (type === 'CHTOC') { groups.push({ label: null, title: s.sectionTitle || 'Chapter Contents', kind: 'contents', sections: [s] }); cur = null; continue }
    if (type === 'AHEAD' || !cur) {
      const label = /^\d+\.\d+$/.test(String(s.sectionLabel || '').trim()) ? String(s.sectionLabel).trim() : null
      const review = /^chapter review$/i.test(String(s.sectionTitle || '').trim())
      cur = { label, title: s.sectionTitle || '', kind: label ? 'section' : review ? 'review' : 'other', sections: [] }
      groups.push(cur)
    }
    cur.sections.push(s)
  }
  return groups
}
const sectionNo = label => Number(String(label).split('.')[1])

// The groups of a chapter that a want ({ all } | { sections, fromEnd }) asks for. Whole chapter: everything. A set
// of sections: the numbered groups in it — and the chapter review when the set reaches the chapter's last numbered
// section, since the summary and the supplementary exercises belong to whoever read to the end.
export function cutChapter(doc, want) {
  const groups = groupSections(doc)
  if (!want) return []
  if (want.all) return groups
  const numbered = groups.filter(g => g.kind === 'section').map(g => sectionNo(g.label))
  const last = numbered.length ? Math.max(...numbered) : 0
  const has = k => want.sections?.has(k) || (want.fromEnd != null && k >= want.fromEnd)
  return groups.filter(g => (g.kind === 'section' && has(sectionNo(g.label))) || (g.kind === 'review' && last > 0 && has(last)))
}

// ---- the HTML Chrome prints -----------------------------------------------------------------------------------------
// MindTap's markup with the reader's needs taken out: `<m:math>` becomes `<math>` (Chrome renders MathML Core itself,
// but the HTML parser does not know a prefixed tag), a figure's `metadata` stub and empty `imageContainer` become one
// `<img>` served from `imagesUrl`, the reader's `javascript://` cross-references become plain text, and the book's
// own page breaks (`PageEnd_23`) become small margin marks so an exercise can be found by the printed page number.
export function cleanHtml(html, { imagesUrl = '_images' } = {}) {
  let h = String(html || '')
  h = h.replace(/<m:([a-zA-Z]+)/g, '<$1').replace(/<\/m:([a-zA-Z]+)>/g, '</$1>')
  h = h.replace(/ id-sequence="\d+"/g, '').replace(/ clrenderdata="[^"]*"/g, '')
  // A figure: the stubs come first (enlarged, then inline), the empty container after the caption. Keep the sharper
  // file at the inline size.
  let pending = null, enlarged = null
  h = h.replace(/<div class="metadata (inlineImage|enlargedImage)"([^>]*?)\/?>(?:<\/div>)?|<div class="imageContainer"[^>]*?\/?>(?:<\/div>)?/g, (m, kind, attrs) => {
    if (kind) {
      const at = k => { const r = new RegExp(` data-${k}="([^"]*)"`).exec(attrs); return r ? r[1] : '' }
      if (kind === 'enlargedImage') enlarged = at('filename')
      else pending = { file: at('filename'), w: at('width'), h: at('height'), alt: at('alt') }
      return ''
    }
    if (!pending) return ''
    const src = `${imagesUrl}/${encodeURIComponent(enlarged || pending.file)}`
    const img = `<img src="${src}"${pending.w ? ` width="${pending.w}"` : ''} alt="${esc(pending.alt)}">`
    pending = null; enlarged = null
    return img
  })
  h = h.replace(/<a data-type="pageEnd" name="PageEnd_(\d+)"[^>]*?\/?>(?:<\/a>)?/g, '<span class="pageEnd" data-page="$1">$1</span>')
  h = h.replace(/<a\b[^>]*href="javascript:\/\/"[^>]*>([\s\S]*?)<\/a>/g, '<span class="xref">$1</span>')
  h = h.replace(/<a\b[^>]*class="pageSection"[^>]*\/>/g, '')
  h = h.replace(/<span class="sectionLabel"\s*\/>/g, '<span class="sectionLabel"></span>')
  h = h.replace(/<(div|span|p|a)\b([^>]*)\/>/g, '<$1$2></$1>')               // HTML has no self-closing div
  h = h.replace(/<div id="breadcrumb">[\s\S]*?<\/div>/g, '')
  return h
}
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// The printed pages of the book a cut spans, from the page-end marks inside it: 'pp. 20–35', or null.
export function bookPages(groups) {
  const pages = []
  for (const g of groups) for (const s of g.sections) for (const m of String(s.content || '').matchAll(/name="PageEnd_(\d+)"/g)) pages.push(+m[1])
  if (!pages.length) return null
  const lo = Math.min(...pages), hi = Math.max(...pages)
  return lo === hi ? `p. ${lo}` : `pp. ${lo}–${hi}`
}

// One printable document. `head` is the title block Chrome prints first; `groups` are what cutChapter returned.
export function documentHtml({ title, subtitle = '', book = '', groups, imagesUrl = '_images', note = '' }) {
  const body = groups.map(g => `<section class="tb-group tb-${g.kind}">${g.sections.map(s => cleanHtml(s.content, { imagesUrl })).join('\n')}</section>`).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>
<body>
<header class="tb-head"><div class="tb-book">${esc(book)}</div><h1 class="tb-title">${esc(title)}</h1>${subtitle ? `<div class="tb-sub">${esc(subtitle)}</div>` : ''}${note ? `<div class="tb-note">${esc(note)}</div>` : ''}</header>
${body}
</body></html>
`
}

// Set in the house serif, Letter with wide margins so there is room to ink beside the text; a section starts a
// page; figures and exercises do not split across one; the book's page numbers sit in the right margin in grey.
const CSS = `
@page { size: Letter; margin: 16mm 18mm 18mm 16mm; }
html { -webkit-print-color-adjust: exact; }
body { font: 10.5pt/1.5 Georgia, 'Times New Roman', serif; color: #14120f; margin: 0; }
.tb-head { border-bottom: 1.5px solid #14120f; padding-bottom: 8pt; margin-bottom: 14pt; }
.tb-book { font-size: 8.5pt; letter-spacing: .06em; text-transform: uppercase; color: #6b5a44; }
.tb-title { font-size: 22pt; line-height: 1.15; margin: 4pt 0 2pt; font-weight: normal; }
.tb-sub { font-size: 10pt; color: #6b5a44; }
.tb-note { font-size: 9pt; color: #6b5a44; margin-top: 4pt; font-style: italic; }
.tb-group { break-before: page; }
.tb-head + .tb-group { break-before: auto; }
h1, h2, h3, h4 { font-weight: normal; line-height: 1.2; break-after: avoid; }
h1 { font-size: 18pt; margin: 0 0 10pt; }
h2 { font-size: 13.5pt; margin: 16pt 0 6pt; }
h3 { font-size: 11.5pt; margin: 12pt 0 4pt; font-weight: bold; }
h4 { font-size: 10.5pt; margin: 10pt 0 3pt; font-weight: bold; }
.sectionLabel { color: #8a5a2b; margin-right: 5pt; }
#header { margin-bottom: 8pt; }
#chapHead { display: flex; align-items: baseline; gap: 6pt; color: #8a5a2b; }
.chapLabel { font-size: 9pt; text-transform: uppercase; letter-spacing: .08em; }
.chapNum { font-size: 30pt; line-height: 1; display: inline-block; }
#chapterOutline ul { list-style: none; padding-left: 0; } #chapterOutline ul ul { padding-left: 24pt; font-size: 9.5pt; color: #55493a; }
#chapterOutline li { margin: 2pt 0; } .moduleLabelOrdinal { display: inline-block; min-width: 26pt; color: #8a5a2b; }
p { margin: 0 0 6pt; text-align: justify; hyphens: auto; }
.math { margin: 6pt 0 8pt; text-align: center; break-inside: avoid; }
math { font-size: 1.04em; }
.equation { display: inline-block; }
.xref { color: #8a5a2b; }
.pageEnd { float: right; clear: right; font: 7pt/1 Georgia, serif; color: #a89b8a; margin: 2pt -10mm 0 0; }
.media { margin: 10pt auto 12pt; text-align: center; break-inside: avoid; }
.media img { max-width: 100%; height: auto; }
.mediaTitle { font-size: 9pt; text-align: left; margin: 0 0 4pt; color: #3d3428; }
.mediaFigureLabel { font-weight: bold; margin-right: 4pt; }
.nb_media { display: inline-block; max-width: 100%; }
.table { margin: 8pt 0 10pt; break-inside: avoid; }
.containerHeading { font-size: 9pt; margin-bottom: 3pt; } .containerHeading .label { font-weight: bold; } .containerHeading h3 { display: inline; font-size: 9.5pt; margin: 0 0 0 4pt; font-weight: bold; }
table { border-collapse: collapse; font-size: 9pt; margin: 0 auto; max-width: 100%; }
th, td { padding: 1.5pt 5pt; vertical-align: top; text-align: left; }
th p, td p { margin: 0; text-align: inherit; }
.frametopbot { border-top: 1.5px solid #14120f; border-bottom: 1.5px solid #14120f; }
.underscore { border-bottom: 1px solid #14120f; } .aligncenter { text-align: center; } .alignright { text-align: right; }
.quiz ul, ul.unformatted { list-style: none; padding-left: 0; margin: 0; }
.quiz li { margin: 5pt 0 5pt 30pt; position: relative; }
.questionnumber { position: absolute; left: -30pt; width: 28pt; font-weight: bold; text-align: right; }
ol.latin, .latin { list-style: lower-alpha; }
ul, ol { margin: 2pt 0 6pt; padding-left: 22pt; } li { margin: 2pt 0; }
.answerHeading { font-weight: bold; font-size: 8.5pt; margin: 4pt 0 0; text-align: left; color: #8a5a2b; text-transform: uppercase; letter-spacing: .06em; }
.answer { font-size: 9.5pt; color: #3d3428; margin-bottom: 4pt; }
.footnotes { font-size: 8.5pt; color: #3d3428; border-top: 1px solid #c9bfae; margin-top: 12pt; padding-top: 4pt; }
.example, .theorem, .definition, .box, .note { border-left: 2.5px solid #8a5a2b; padding: 4pt 10pt; margin: 8pt 0; break-inside: avoid; }
.example h3, .theorem h3, .definition h3 { margin-top: 0; }
pre, code { font: 9pt/1.4 Menlo, Consolas, monospace; } pre { background: #f4f0e8; padding: 6pt 8pt; overflow: hidden; white-space: pre-wrap; }
img { break-inside: avoid; }
`
