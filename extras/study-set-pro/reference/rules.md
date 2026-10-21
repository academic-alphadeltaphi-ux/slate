# Rules — how a study set teaches

One purpose decides every rule below: **the student learns the week from the study guide alone, knowing
nothing of it** — no lecture attended, no reading done, no one to ask, no prerequisite assumed. The
exercise sheet must be doable by someone who has read only the guide. Always write in English.

## The rules

1. **The reader knows nothing of the material.** Re-teach every tool the week uses (derivatives, logs,
   sums, probability rules, a reading method, a historical frame) in §0 or where it is first needed:
   compact, one worked line each, skippable by a student who knows it. A refresher, never pages of it.
2. **Explain why, everywhere.** Each section opens with the question it answers, in one to three plain
   sentences ("What happens if the central bank suddenly doubles the money supply?"). Each method is
   motivated before its mechanics: what it is for, and why the simpler way is not enough. Each result
   is followed by what it means. Transitions carry the week's thread ("the linear model predicts a
   corner, which real people do not choose, so we change one assumption").
3. **Name every symbol.** Every formula is followed by a `Where:` list, one line per symbol: the
   symbol, its name in brackets, its plain meaning, its units —
   `\(\alpha_p\)` (effectiveness of practice): points gained per hour of it.
   Every model opens by naming its pieces in words: choice variables, parameters, constraints, with
   units and, when the problem gives them, values (a parameter table when there are many). In a
   statistics course every random variable, parameter and estimator is named the same way. No symbol
   is used before its Where line; a symbol named long ago gets a few-word reminder when it returns.
4. **Every course formula is taught in the lesson, in its own box, before any problem uses it.** First
   build `formulas.json`: every formula, definition, named result and method the week uses, from the
   slides, the textbook, the problem sets **with their official solutions**, and the tutorial —
   anything a source says to remember goes in first. Each item gets a Definition, Formula or Theorem
   box in a numbered section, with its Where list, why it works and a worked example. A problem may
   practise a formula; it is never the only place the formula is taught. "Problem 2.1 proves it" is
   not teaching. The check flags any inventory item found only inside a problem or a solution.
5. **Define before use.** No term appears before the cell that teaches it: not in a title, an example,
   a problem or an intro. A later section may point back; an earlier one never leans on a later one.
6. **Build from a concrete case.** A new idea starts from a small case with numbers (one $10 bill that
   changes hands three times, before the velocity formula), then the general rule, then what it means.
7. **Every step shown.** Worked examples and solutions: a *We are given:* list, then one operation per
   line, the rule named where it is not obvious, the arithmetic written out, a **bold answer**, one
   sentence on what it means, and in parentheses why the tempting wrong answer is wrong. Never
   "clearly", "simply", "it follows".
8. **Own words; quotes rare and corrected.** The guide explains. A quote only adds something (a slide's
   or the book's exact definition, a test warning). A transcript quote is corrected — mis-hearings
   fixed, filler cut — or not used. No quote stands in for an explanation; no stitched fragments.
9. **Transcripts are for understanding.** They are machine transcription and often wrong. They say
   what was taught and stressed; they are never trusted over a slide, the book or an official
   solution. What cannot be made sense of is left out.
10. **Slides are the syllabus.** Every slide topic is taught and gets at least one exercise. Cut
    duplication, never a slide topic; never down-weight content as "slides only". Only book-only
    material may be marked lower priority.
11. **No padding.** An idea is explained once, well. No repetition, filler, lists of sources,
    citation clutter or timestamps in running text. Source marks live only in a `source-tag` after a
    problem's title: `(Problem Set 1, Q7)`, `(Tutorial 2, Q3)`, `(Textbook Exercise 5.4)`, `(original)`.
12. **Never invent course facts.** No number, definition, exam question or test format the sources do
    not give. Practice you write is tagged `(original)`. Your explanations, examples, analogies and
    practice are not invention: they are the job.
13. **One warning line where a source is genuinely missing or wrong** (an official answer with an
    arithmetic slip: say so and give the corrected value). Never a box about what is missing.
14. **Scope.** Assigned textbook sections that a course problem uses are taught, lectured or not; one
    that leans on a later week's idea is taught up to that idea and names what comes next.
    End-of-chapter exercises are optional practice, tagged with their number. Pages outside the
    assigned sections are skipped.
15. **One notation.** Sign conventions come from this week's slides; a good or variable keeps the
    course problem's letter; one symbol = one meaning per document. When two course problems clash,
    rename in the later one with a bracketed note.
16. **Components by need.** The outline in anatomy.md is the backbone. Add a story opening, a table of
    every course problem and where it is solved, a parameter table or a glossary only when this week
    needs it, and say to yourself what it is for first.

**A course that is not quantitative** keeps the same shape: concepts, readings, people and arguments
in place of formulas; the Where list becomes "who / what is this" lines; a worked example is a worked
analysis (claim, evidence, why it holds); a term in the course's own language is given where it matters.

## Read it as the student, before printing

Read only the lesson, skipping every solution, and try each problem with what the lesson gave. Then
read front to back. Fix every place where:
(a) a section or method has no stated reason to exist; (b) a symbol appears before it is named;
(c) a term appears before it is taught; (d) a step cannot be reproduced from the line before;
(e) a quotation is garbled or confusing; (f) a figure is mentioned but not shown; (g) something is
explained twice or is padding; (h) a problem needs a formula the lesson never gave.

## Worked failure — recognise it

One cell of a real guide (do not write like this): it opened with a 70-word transcript quote; its
intuition box was five stitched transcript fragments with four timestamps; it gave the textbook's
definition with its page number; it used a formula in \(g, h, z\) whose symbols were never listed; and
nowhere did it say **why anyone would want this method** when substitution had already solved the
problem. Rules 2, 3, 6 and 7 all fail in that one cell.

## Failures that made the rules

- **The formula that lived only in a solution.** A problem set's first question *was* the derivation
  of a formula used all year. The writer let that problem's solution teach it, and the lesson said
  only "Problem 0.1 proves it". The student searched the lesson, could not find the formula, and
  wrote it in the margin by hand. Hence rule 4.
- **Long, and nowhere a parameter named.** Early guides ran 30,000–60,000 words carrying hundreds of
  transcript quotes and timestamps, while their symbols went unexplained. The student's verdict: long,
  but nowhere does it list the parameters or say what they mean. Length was not the fault; what filled
  it was. Hence rules 3, 8 and 11.
- **Pages on a tool the student knew.** A sample spent three pages on what a derivative is. Assuming
  nothing does not mean teaching everything at length: hence rule 1's one worked line.

## Length

No word floors. Length = every concept of the week explained once, from zero + every course problem
of the week worked in full + enough practice to master it. A light week gives a short guide. What
never adds length: quotations, timestamps, citations, repetition, filler, boxes about sources or gaps.
For scale only: the model guide (`models/guide-model.html`) teaches seven topics in about 8,000 words,
with 17 section problems and a 6-question mock.

The shape of a good session guide (block by block in anatomy.md):

- `h1`, subtitle, table of contents.
- **§0 Prerequisites**: every tool the week uses, compact.
- **Numbered sections**, one per topic: the opening question, concept cells, and last a
  **Cumulative Problem Set**: the section's course problems in full, then original ones filling the
  gaps, basic to exam-level; multiple choice only where the course's own tests use it.
- **Full Mock**: about 5 questions in the course's real test format (from the syllabus or the
  course's test information; where length or marks are unpublished, say so and invent neither), each
  with *Correct Answer* and *Analysis*.
- **One-Page Master Cheat Sheet**: a box per section — definitions, every formula with its symbols
  named, the causal chains.

The exercise sheet: per topic, four levels of 3–5 problems, every course problem at its level, full
solutions (anatomy.md).
