// The contract any Claude session reads before touching Notebooks/. SPEC.md §11.
// Study sheets are described only where the edition builds them: a brother's copy wrote this file into his notes with
// a Study sheets subpage in every week and a queue that flags sessions for them — instructions for a feature he has not
// got, read by a Claude that acts on what it reads (review 2026-09-29). server/edition.js has read the notes' settings.
import { enabled } from './edition.js'
const SHEETS = enabled('sheets')
export const CONTRACT_VERSION = 25   // v25: Hub/_marks.json holds the marks he entered himself and his target, Hub/_review.json the topics he flagged for review, and Claude may add to both (SPEC §21.12–13); v24: study sheets only where the edition has them; v23: the day is a draft Claude proposes and the student confirms; the day agent drafts it (SPEC §23); v22: what Quercus already has in (hand-ins, marks, his forum posts) or Claude marks `task done` is ticked by the plan pass, once, and his untick stands (SPEC §20.69); v21: a textbook can be a PDF (Perloff), and a week's sections come from the outline or the week's synced topic page (SPEC §20.68); v20: a course's `Textbook` section holds its e-book a chapter a page, and the week's sections stand on its Readings shelf (SPEC §20.67); v19: the day too is Claude's — `brain.mjs day set`, never Hub/_day.json by hand (SPEC §22); v18: a week's Readings, Videos and Assignments are shelves of their own (§20.53), not subpages of Lectures; v17: the week is one section per class, so `for` is where a document lives, not a label; v16: `for` says which class in its week a document belongs to; v15: when Claude is the brain, the inbox and every decision go through scripts/brain.mjs; v14: Problems/ holds guides and applications, a set's questions and solutions pair by name, Hub/Today/My tasks.md is the student's own list; v13: a transcript is named after the recording, and a Recordings page is what flags a session; v12: a Problems row's identity is its whole label (itemised sets); v11: the v0.7 rules (SPEC §20) in one text
export const CLAUDE_MD = `<!-- slate:contract v${CONTRACT_VERSION} — written by the app; edit slate/server/claude-md.js instead -->
# Notebooks — how to read and write these notes

This folder is the source of truth for slate, a local OneNote-style app. Everything is plain
files. Nothing here needs the app: edit with any tool, the app picks changes up live.

## Layout
- \`<Notebook>/\` folder → \`<Section>/\` folder → \`<Page>.md\` page. Subpages live in \`<Page>/\`,
  a folder named exactly like the page, to any depth.
- \`<Page>.blocks.json\` optional layout sidecar. \`<Page>.assets/\` attachments. Those four things
  share one name and are renamed, moved and trashed together.
- \`_slate.json\` in any folder: \`{ "order": [...child names], "color": "#rrggbb",
  "label": "Macro theory, year-long" }\`. All optional. Names missing from \`order\` sort
  alphabetically after the listed ones. \`label\` is a sentence about the notebook or section, written
  for you as much as for the student. The root \`_slate.json\` also holds \`highlights\`: what each highlight
  colour means, e.g. \`[{ "color": "#ffd60a", "label": "key point" }, { "color": "#34c759", "label": "exam" }]\`.
- \`.trash/\` holds soft-deleted items. Never write there. \`.git/\` holds automatic snapshots.
- \`<Notebook>/_exports/\` holds PDF binders the app exported (one PDF per section or notebook). Never
  content, never re-imported, ignored by snapshots — leave it alone.
- Names starting with \`.\` or \`_\` are never content.

## Page text (\`.md\`)
- Optional YAML frontmatter: \`created\`, \`kind\` (one of lecture, reading, syllabus, problem-set,
  exam, summary, notes, admin, other), \`for\` (which class in its week a document belongs to:
  \`lecture\`, \`tutorial\`, or \`both\` when it serves the week — the week screen has a tab per
  class, and a document with no \`for\` shows only on its All tab),
  \`tags\` (a flow list like \`["midterm", "chapter 3"]\`).
  The app edits these line by line; keep the rest of the header byte-identical unless you mean to
  change it.
- Text containers are separated by a line \`<!-- slate:block abc123 -->\` (6 chars, a-z 0-9,
  unique within the page). No anchors means one container. Text before the first anchor is a
  container with no id.
- Markdown is GitHub-flavoured plus: math \`$…$\` and \`$$…$$\`, highlight \`==text==\`,
  underline \`<u>text</u>\`, colour/size/font \`<span style="color: #e11d48; font-size: 18px">\`,
  wikilinks \`[[Page title]]\` or \`[[Page title|alias]]\`.
- Hard line break: end the line with a backslash \`\\\`.
- Links to attachments are relative to the page and percent-encoded:
  \`![](Lecture%203.assets/board.png)\`.

## Layout (\`.blocks.json\`)
\`{ "version": 1, "elements": [ { "id", "type", "src?", "x?", "y?", "w?", "h?", "z?", "parent?", "style?" } ] }\`
- Types: \`text\` (id = an anchor id), \`image\`, \`pdf\` (rendered as pages; older files say
  \`file\` for PDFs, which works too), \`file\`, \`media\` (audio/video). \`src\` is relative to the
  page folder, e.g. \`"Lecture 3.assets/slides.pdf"\`. \`display: "card"\` shows a PDF or a media file
  as a compact file card instead of its pages or player; leave it out for the printout or player.
- **You never need coordinates.** An element without \`x\`/\`y\` flows after the text column.
  Leave geometry out and the app lays it out.
- \`parent\`: coordinates relative to that element. \`style\` on a text element:
  \`{ "font", "size", "color" }\` for the whole container.
- **PDF annotations** are elements too: \`{ "id", "type": "highlight" | "underline",
  "parent": "<pdf element id>", "text": "the exact passage", "color": "#ffd60a", "label": "exam",
  "page": 3, "rects": [{ "page": 3, "x", "y", "w", "h" }] }\`. \`label\` is the meaning of the
  colour at the time of marking (see \`highlights\` above). Coordinates are PDF points at
  scale 1, origin top-left of the page. **To read what the student marked, read \`text\`.** To mark a
  passage yourself, add an element with only \`type\`, \`parent\` and \`text\` (and \`page\` if you
  know it): the app finds the passage when the page renders and fills in \`page\` and \`rects\`.
- **Notes on a document**: a text element with \`parent\` set to the PDF element and the matching
  anchor in the \`.md\`. Without \`x\`/\`y\` it sits at the document's top-left corner. \`parentW\` is
  the document's width when the note was placed, so it keeps its place if the document is resized.
- \`hidden: true\` on an element collapses it to a small pill in the app, and its notes and ink
  are hidden with it; the file and its annotations are untouched. \`z\` orders overlapping
  elements (higher on top).
- **Ink** is stroke data, never an image: \`{ "id", "type": "ink", "parent"?, "parentW"?,
  "strokes": [{ "id", "tool": "pen" | "highlighter", "color", "width", "pen": true,
  "points": [[x, y, pressure, ms], …] }] }\`. Coordinates are page pixels, or relative to the parent
  element. \`pen: false\` means a mouse drew it and pressure is meaningless. Handwriting recognition
  can read \`points\` directly. An ink element may also carry the handwriting as the app recognised
  it: \`text\` (the lines joined by newlines; \`""\` when the ink is marks, not writing), \`textAt\`,
  \`inkHash\` (of the stroke ids at recognition time — when it no longer matches, the text is out of
  date) and \`lines: [{ text, confidence }]\`. Read \`text\` as the student's own words: index it, quote it,
  never invent it, and never write these fields by hand — \`node scripts/hwr.mjs --page "<rel .md>"\`
  refreshes them.

## Course notebooks
Every course notebook has the same shape: sections \`General\` (syllabus, tests and exams, office
hours, links, textbook, checklists), \`Announcements\` (an index page plus one subpage per
announcement under \`Announcements/Announcements/\`, named \`YYYY-MM-DD Title\`; a file an
announcement carries sits on that subpage as a card; every week an announcement mentions links
back to it under "From announcements" on the week page), \`Fall 2026\` and \`Winter 2027\` (fall only for a half course). A term section holds
one page per week, \`Week 1 (Sep 7)\` … and every week page has ${SHEETS ? 'four' : 'three'} subpages: \`Notes\`,
\`Lectures\` (slides and handouts go under it as subpages, one per file), \`Recordings\` (audio
and video)${SHEETS ? ', `Study sheets`' : ''} — and, whenever the week has them, \`Readings\` (a chapter, an article, a reading
guide), \`Videos\` (a posted video, downloaded when it can be) and \`Assignments\` (a page per forum, quiz and
hand-in), plus any folder the brain names for what it holds (\`R\`, \`Listening\`). So a slide deck lives at
\`ECO 208Y1/Fall 2026/Week 3 (Sep 21)/Lectures/<deck>.md\`. File a thing in the week it belongs
to; if it is administrative, in \`General\`. Set \`kind\` to match. The calendar is in
\`slate/scripts/lib/terms.mjs\`. A course added in term (a Fall half course has only \`General\`, \`Announcements\`
and \`Fall 2026\`) gets its scaffold from \`slate/scripts/add-course.mjs\`, never by hand; a course with \`mirror: true\`
has a copy of its documents in \`~/Desktop/<course>/\` that \`slate/scripts/mirror-course.mjs\` keeps — the notebook is
the source. A notebook without an entry in terms.mjs (\`CLA 204H1\`, dropped) is an ordinary notebook, not a course.

A course whose textbook is in slate has a \`Textbook\` section (ECO227's WMS, the MindTap e-book behind WebAssign;
ECO206's Perloff, one PDF): one page per chapter carrying the chapter as a PDF — printed from the e-book's documents, or
the chapter's pages copied out of the book behind a cover — the source under \`Textbook/_source/\` (the chapter documents,
or \`book.pdf\`), an e-book's figures under \`Textbook/_images/\`, and \`Textbook/_textbook.json\`, the index (\`format\`:
\`mindtap\` or \`pdf\`) — all written by \`slate/scripts/textbook.mjs import\`, never by hand. Each morning
\`slate/scripts/textbook.mjs\` reads what each week names in the book — the outline's \`chapters\` line
(\`slate/scripts/lib/syllabus.mjs\`, ECO227) or, when the professor publishes the outline week by week on Quercus, the
synced topic page's own "Read: Textbook 3.1–3.3" line (ECO206) — and puts just those sections onto the week's own
\`Textbook\` shelf — a folder beside \`Readings\`, which stays for what the professor posts — as a page named for them:
\`WMS 2.1–2.3\`, \`Perloff 3.4, 4.1, 5.4, 2.5\`, kind \`reading\`, \`for: both\`, tagged \`textbook\`, its header naming
where the line came from. A task that reads "Read Perloff 3.1–3.3" links that page${SHEETS ? '; a study sheet reads it beside the\nslides' : ''}. A week's page that exists is never rewritten (it may carry ink); a wrong cut is fixed by fixing the outline in
syllabus.mjs — a \`chapters\` line there overrides the topic page — and running the script with \`--force --week N\`. A
course whose terms.mjs line names a textbook that is not in its notebook yet is only reported, with the weeks waiting.

A \`Recordings\` page keeps a one-line header; its transcript lives beside the recording in
\`<Title>.assets/\`, named after the **recording**: \`<audio>.transcript.json\` (paragraphs with start
seconds — what the app's panel reads) and \`<audio>.txt\` (\`[hh:mm:ss]\` paragraphs, for grep), plus
\`.srt\` and \`.vtt\`. Transcripts written before that rule carry the page's title and are still read.
\`slate/scripts/transcribe.mjs\` writes them; the app's search reads them.${SHEETS ? ` A recording filed under a
week's \`Recordings\` is also how slate knows a class happened and flags a study sheet for it, so put
a lecture recording there rather than on a section page. \`Study sheets\` is an
index page whose subpages are the sheets themselves, one per class session, named
\`Session <N> (YYYY-MM-DD)\`. Those are written for the student to work on — add to one, never silently
rewrite it. The same sheet also exists as standalone HTML in \`~/Desktop/<Course>/Study sheets/\`,
which is slate's output and is not a sync source.` : ''}

A week's \`Problems\` page (kind problem-set) lists what was assigned that week: a header block, then
one container starting \`## Problems\` holding a task list — \`- [ ] <problem> — [[source]]\` (ticked =
the student attempted it) with \`  - [ ] reviewed\` nested under each (ticked = he reviewed it); a row may
end in a score like \`17/20\`. A row is named by its whole label minus the score and the \` · WebAssign\`
marker, so \`Problem Set 1 · Q3\` and \`Problem Set 1 · Q4\` are two rows beside the set's own \`Problem Set 1\` row. Never rewrite that container or a tick: add rows with
\`echo '[{"label":"…","src":"[[…]]"}]' | node scripts/problems.mjs --add "<page>"\`. A worked
solution is its own container appended at the end of the page whose first line is
\`### Solution · <problem>\`; that is what marks the row solved.

A week's \`Problems/\` folder holds the documents to work through, one page per file: problem sets,
tutorial questions, weekly applications, worked solutions, and guides on how to solve them. A set's
questions and its solutions are two pages named alike — \`ECO206_Problem_Set_1_Questions\` and
\`ECO206_Problem_Set_1_Questions_and_Solutions\` — and the app shows them as one set by that name, so
keep the shape. Decide where a course file goes with \`bucketFor(name, { module, heading })\` from
\`slate/scripts/lib/filing.mjs\`, where \`heading\` is the heading above the file's link on its Quercus page —
unless Claude is the brain (below): then no classifier decides, Claude does.

A week's \`Plan\` page (kind notes) exists only when the week carries tasks: its header block is
owned by \`slate/scripts/plan.mjs\` and rebuilt from the calendar and announcements; its one
\`## Before class\` container is only appended to — tick tasks (\`- [x]\`) and add your own lines
there freely, they are kept; do not rewrite that container yourself, add later containers instead.

Beside every PDF a page shows, the app keeps \`<name>.pdf.txt\`: its words, one \`[page N]\` block
per page, under a first line naming the PDF's mtime and size. It is the app's text cache — read it
when you only need a deck's words (cheaper than the PDF); never edit it and never attach it to a
page. Scripts ignore \`*.pdf.txt\`.

## When Claude is the brain
When \`Hub/_settings.json\` says \`"brain": true\`, no rule in slate decides where anything goes or what
there is to do. The morning fetch only downloads: a new file, a new Quercus page or a file from the Desktop course
folder waits as a page under \`Hub/Inbox/<course>/\`, and every new announcement and every Quercus page that changed
waits as an item in \`Hub/_inbox.json\`. Claude decides, and only through \`node slate/scripts/brain.mjs\` — never by
moving, writing or deleting a course page itself: \`place\` a page into a week's folder or General (with its kind and a
reason, and \`--for lecture|tutorial|both\`: which class in that week it belongs to), \`part\` to say that about a page already
filed, \`ignore\` what is not a course document, \`reviewed\` an announcement once its tasks and links are made, \`link\`
an announcement to the weeks it is about, \`task add | edit | withdraw\` the tasks the Plan pages show (each before one
class or in one week, with a level — crucial, important, normal, optional — and a reason), \`task done\` for one the
evidence says is already done (a mark, his post, an answer note — never because its day went by), \`class\` to cancel a class or
give its topic, \`ask\` when a decision is the student's, and \`day set\` for a *draft* of the day's work — which task, when, how long
and why, checked against the classes, the calendar and what the student already put on the day; he confirms it on the screen, and
what he confirmed, placed or took off is never touched (\`day brief\` is what to read first; the day agent
\`scripts/day-agent.mjs\` does this in a session of its own; SPEC §23). Each is recorded with its
reason in \`Hub/_brain.json\` and can be undone (\`brain.mjs undo <id>\`); \`brain.mjs --help\` lists every command. \`plan.mjs --pages\` then writes Claude's tasks
onto the Plan pages, where the student ticks them — and ticks, once, a task Quercus already has in (\`Hub/_hub.json\` →
\`handedIn\`) or Claude marked done; a line the student unticks after that stays unticked. Never tick or untick a line yourself. Never edit \`_brain.json\`, \`_inbox.json\` or \`_settings.json\` by hand, and
do not decide with \`bucketFor\` or the announcement grammar: those are the rules this replaces. A task's \`link\` is the thing
itself — an assignment's own Quercus URL (\`Hub/_hub.json\` → \`deadlines[].url\`), a tool's URL from the course's
\`General/Links\` page, or a page's path — never a course's Quercus page and never a week's \`Problems\` page.

## The Hub
\`Hub/Today/\` (Overview, Schedule, Next 7 days, Calendar, Deadlines, Tests, Grades) and
\`Hub/_hub.json\` are rewritten by the morning pass (\`scripts/quercus-sync.mjs\`, then
\`plan.mjs\` and the calendar step) and shown as the app's Home and What's next screens. Read them
for what is due and what is new; do not edit them, they are overwritten. The one exception is
\`Hub/Today/My tasks.md\`, which nothing rewrites: it is the student's own to-do list, one task per line under
\`## My tasks\` — \`- [ ] what · ECO206 · 2026-09-14\`, the course code and the date optional and last.
Add a line there when he asks you to remember something to do; never reorder or rewrite his lines.
\`Hub/_marks.json\` is his too: the marks he entered in the calculator for what never reaches Quercus (a publisher's
homework, participation) and his own target, per course, in the shape of \`scores\` in \`src/grade.js\` (percent of the item;
component and item keys from the course's \`grading\` in \`Hub/_hub.json\`). Quercus wins wherever it has a mark. When he
tells you a mark, add it there; never change one he typed unless he asks. \`Hub/_review.json\` holds the topics he flagged
for review, per course and week number (\`{ week, topics: [{ id, topic, note, at }] }\`, a note one line): they show on the
tests that cover those weeks, and the morning turns a week of them into one review task before its test. They are his:
flag, change or clear one only when he asks, with \`node scripts/brain.mjs review set <CODE> <week n> --topic "…" --note "…"\`
(the same topic words change it) or \`review clear <CODE> <week n> [--topic "…"]\` (\`review\` lists them). Read-only Hub files:
\`_hub.json\`, \`_plan.json\` (the next 14 days: meetings, tasks, tests, coverage, issues),
\`_plan-state.json\`, \`_problems.json\` (problem counts per week, the WebAssign calendar and bonus),
\`_calendar*.json\` (the Google calendar sync and its readback),${SHEETS ? ' `_study-queue.json`,' : ''}
\`Today/Next 7 days.md\`, \`Today/Calendar.md\`. \`Hub/_sync-state.json\` is the sync's memory of
what it has seen. \`Hub/Review/Sunday review · <YYYY-MM-DD>.md\` is the Sunday review, written by
\`scripts/review.mjs\` at 18:00 on Sundays; only its Plan paragraph is Claude's, the rest is computed
and overwritten — write your own notes elsewhere.

## Search
The app's full-text search (⌘⇧F) covers page text, the text of every PDF a page shows, transcripts,
and recognised ink. The \`.pdf.txt\` caches above are what it reads for PDFs;
\`node slate/scripts/pdf-text.mjs\` makes one for any PDF that lacks it.

## Recipes
- **Create a page**: write \`Section/Title.md\`. Optionally start it with
  \`---\\ncreated: "2026-09-08T16:02:11-04:00"\\n---\\n\`. It appears last in the section.
- **Add text to a page**: append to the \`.md\`. Put a fresh anchor line first to make it its own
  container.
- **Attach a file**: copy it into \`Title.assets/\`, then add
  \`{ "id": "k3f9x2", "type": "file", "src": "Title.assets/name.pdf" }\` to \`elements\` in
  \`Title.blocks.json\`, creating it as \`{"version":1,"elements":[]}\` if absent.
- **Highlight text in a note**: wrap with \`==\`. **Highlight in a PDF**: see annotations above.
- **Delete**: move to \`.trash/\`, never \`rm\`.
- **Write safely**: write to a temp file in the same folder, then rename over the target. The app
  does the same, and refuses to overwrite a page that changed under it.
`
