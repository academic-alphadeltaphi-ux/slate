---
name: study-set-pro
description: Build a study set for one week of one course in Slate — a study guide that teaches the week from zero, an exercise sheet in four levels, and a one-to-three-page week at a glance — and put it in that week's Study set folder. Use when the student asks for one ("do the study set for week 3 of ECO206", "make me a study guide for week 5", "redo the glance for week 2"). Pro version, built to fit a Claude Pro plan. Never start one on your own and never from a scheduled task; you may suggest it once when the student is studying a week or a test is close, and build only after they say yes.
---

# Study set (Pro)

One request = one week of one course = three documents, printed onto pages in Slate under
`<Course> › <Term> › Week N › Study set`:

| Page | What it is | Who writes it |
|---|---|---|
| `Week N — study guide` | the week taught from zero: every idea explained, every formula with its symbols named, a problem set after each section, a short mock, a one-page cheat sheet | you |
| `Week N — exercise sheet` | practice per topic in four levels (Easy → Challenge), every course problem at its level, full solutions | one agent |
| `Week N — at a glance` | 1–3 US Letter infographic sheets: definitions, formulas, key graphs, what to remember, the traps | one agent |

This folder (`.claude/skills/study-set-pro/`) holds the rules (`reference/rules.md`), the HTML vocabulary
(`reference/anatomy.md`), figures (`reference/figures.md`), the glance rules (`reference/glance.md`), the two agent briefs
(`briefs/`), and models of the quality to reach (`models/`, `examples/`). Every command below runs from the Slate folder.

## When

- **Only when asked.** "Do the study set for week 3 of ECO206" (or a guide, a sheet or a glance alone: build only that).
- **You may suggest it** — once in a conversation, in one line — when the student is revising a week or a test is
  within about ten days and its weeks have no set: *"Want me to build the study set for week 4? It takes a while and
  uses a good share of your plan's allowance."* Build only after a yes. Never from the morning check or any scheduled task.
- One week per request. Asked for several: build one, say so, ask before the next.

## The budget — a Pro plan's allowance is small

- **Three writers, no more**: you write the guide; one agent writes the sheet; one the glance. No reviewer or reader
  agents, no extra rounds. Start both agents with `model: "sonnet"`, in the background, in one message.
- **Read each source once.** Text first: a PDF's `.pdf.txt`, a recording's `.txt`. Look at a page as an image only when
  it carries a formula or a graph the text cache garbles or lacks (`start` lists the pages with ink and figures):
  `node scripts/study-set.mjs pages <work> "<pdf>" 9,11,29-32` (110 dpi) and Read the PNGs. Never Read a whole PDF.
- **The agents never re-read the week.** You write `brief.md` once — topics, notation, formulas, every course problem
  with its answer, the numbers, the figures — and they work from it plus the few files their brief names.
- **Length follows the material.** A light week gets a short guide; a dense one a long guide. Nothing is padded:
  no repetition, no filler, no quotations standing in for explanations. Size is never a goal.
- Before writing, tell the student in one line what is coming, then go on without waiting:
  *"Week 3: a 65-page deck, a 14-question problem set and a tutorial — guide about 40 pages, sheet about 25, glance 3
  sheets. Starting."*
- **If the allowance runs out midway**, everything written is on disk in the work folder. Say what is done and what
  is left, and that saying *"continue the study set"* after the limit resets picks it up (read `brief.md` and the
  parts already written; do not start again).

## The steps

1. **Start.** `node scripts/study-set.mjs start <course> <week>` — prints the course, its tests, every file of the week
   (and of the next week, where a tutorial on this week's lecture may sit) with its size, and makes the work folder
   `study-set-work/<CODE>-week-<N>/`. Paths in the listing are relative to the week folder it names.
2. **Read** `reference/rules.md`. Then the sources, in this order of trust: the current lecture deck (the marked-up /
   after-class build, never a pre-class handout when both exist, never `Earlier versions/`), the problem set with its
   official solutions, the tutorial, the application or assignment, the textbook sections the problems use (skim for
   definitions and worked examples), then transcripts and course videos only for what was stressed — they are machine
   transcription and often wrong. A `claude-solution.md` in the notes is Claude-made: check against it, never trust it
   over an official answer. Recompute every number you will use.
3. **Write `brief.md`** in the work folder (its template is already there) **and `formulas.json`**: every formula,
   definition, named result and method the week uses — `[{"name": "Cobb-Douglas demand", "match": "x\\s*=.*I.*p"}]`,
   where `match` is a pattern the box teaching it must contain. Both agents read the brief; the check reads the list.
4. **Start the two agents** in one message, background, `model: "sonnet"`: fill `briefs/exercise-writer.md` and
   `briefs/glance-writer.md` and send each as the agent's prompt: `{{WORK}}`, `{{SLATE}}` and `{{SKILL}}` are the
   absolute paths of the work folder, the Slate folder and this skill's folder; the rest (course, week, topic, its
   Parts, the course problems, the few files or page images each needs) come from your brief. They write, check and
   print their own document, and report in a few lines.
5. **Write the guide** — `reference/anatomy.md` for the shape and the HTML, `reference/figures.md` for graphs. Look at
   the bar before the first word: `models/guide-model.html` (read its contents list and its first numbered section,
   not the whole file). Write it as parts in `<work>/guide/`, saved one at a time: `01-front.html` (h1, subtitle,
   table of contents), `02-prerequisites.html`, `03-…html` one numbered section each, then the mock and the cheat
   sheet. Figures: inline SVG, or `<!--fig:name-->` placeholders filled from `<work>/guide/figs.mjs`.
6. **Check** `node scripts/study-set.mjs check <work> guide` — fix every fault it lists (a formula of `formulas.json`
   with no lesson box, a section without its problem set, MathJax that did not typeset, a broken solution toggle, a too
   wide equation) and run it again until it says `faults: none`.
7. **Print** `node scripts/study-set.mjs print <work> guide` — the PDF goes onto the page in Slate (solutions open).
8. **Close.** When the agents report, run `node scripts/study-set.mjs status` to see the three pages exist. Tell the
   student in three or four lines: where the set is in Slate, how long each piece is, and anything a source got wrong
   (an official solution that does not add up, a slide that contradicts the book).

**A rebuild** ("redo the exercise sheet for week 3") rebuilds that piece only, in the same work folder; `print` puts
it on the same page in place, and the student's ink and highlights on it stay. Never delete a Study set page.

## Never

- Never invent a number, a definition the course did not give, or an exam question. Practice you write is `(original)`.
- Never trust a transcript over a slide, the textbook or an official solution.
- Never write into the notes except through `print`; never edit a page the student has written on.
- Never run python, git or curl, and never install anything: `node scripts/study-set.mjs` does all of it.
- Never leave a piece half done without saying so.
