# Brief — the exercise-sheet writer

Fill every `{{…}}` and send the rest as the agent's prompt (background, `model: "sonnet"`).

---

Write the {{COURSE}} Week {{N}} EXERCISE SHEET ({{TOPIC}}) for a university student who will study from it alone, then
check it and print it into Slate. A separate writer is doing the study guide at the same time; your sheet sits beside it.

Work folder: `{{WORK}}` (absolute). Run every command from the Slate folder `{{SLATE}}`.

READ, in this order, and nothing else unless a problem needs it:
1. `{{WORK}}/brief.md` — the week: topics, notation (use it exactly: no letter means two things), formulas, every course
   problem with its official answer, the numbers, the figures. It is your source; do not re-read the week's slides.
2. `{{SKILL}}/reference/rules.md`, `{{SKILL}}/reference/anatomy.md` (the exercise sheet part and the block vocabulary),
   `{{SKILL}}/reference/figures.md`.
3. The bar: `{{SKILL}}/models/exercise-model.html` — read its contents and its first Part only.
4. Only these source files, for the exact wording of the course problems: {{PROBLEM_FILES}}

THE SHEET: h1 `{{COURSE}} — Exercise Sheet: Week {{N}}, {{TOPIC}}`, a subtitle, a short symbol table (every symbol,
meaning, units), Contents, then one Part per topic of the week — {{PARTS}}. Each Part: `Level 1: Definitions and Basic
Calculations` (Easy) · `Level 2: Setting Up / Graphing` (Medium; where there is a graph, the answer is drawn as SVG) ·
`Level 3: Application` (Hard) · `Level 4: Mixed, Exam-Level` (Challenge; one long multi-part scenario) — as h3 headings
with their difficulty badge, 2–5 problems per level as the material allows (a thin topic gets fewer, never filler).
Every course problem of the week sits at its level, in full: {{COURSE_PROBLEMS}}. The rest are `(original)`, in plain
realistic scenarios with ordinary names. Every problem carries a `source-tag`. Every solution is collapsible and shows
every step: *We are given:*, one operation per line, the answer in bold, one sentence on what it means. Every symbol is
named in the problem or its solution. Someone who read only the guide must be able to do it. Recompute every number;
where an official solution is wrong, follow the slides and say so in one ⚠️ line in that solution.

WRITE the sheet as parts in `{{WORK}}/sheet/` (`01-front.html`, `02-part-1.html`, …), saving after each Part. Figures:
inline SVG, or `<!--fig:name-->` placeholders filled from `{{WORK}}/sheet/figs.mjs` (figures.md).

CHECK: `node scripts/study-set.mjs check {{WORK}} sheet` — fix every fault and run it again until `faults: none`.
PRINT: `node scripts/study-set.mjs print {{WORK}} sheet`.

Do not touch `{{WORK}}/guide/`, `glance.mjs`, `brief.md` or anything in the notes. No python, git or curl.

REPORT, under 120 words: problems per Part and level; where each course problem sits; the line `print` gave; anything in
the sources that did not add up.
