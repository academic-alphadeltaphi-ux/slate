# Anatomy — what a study guide and an exercise sheet are made of

Write body HTML only: no `<html>`, `<head>`, styles or scripts. The build wraps it in the house head,
which holds the styles for every class below, MathJax and the `toggleSolution` script. The models are
`models/guide-model.html` and `models/exercise-model.html`: copy their shape and voice.

**Maths** is MathJax: `\( … \)` inline, `\[ … \]` display, never `$…$` (the check flags it). Money in
running text is a plain `$10`; inside maths write `\$`. A display equation wider than the page is split
over lines (`\begin{aligned} … \end{aligned}`). Maths inside a figure follows figures.md.

## The block vocabulary

Every box is `<div class="<class>"><div class="box-title">…</div> … </div>`.

| class | title pattern | what goes in it |
|---|---|---|
| `definition-box` | `Definition — <Term>` · `Step-by-Step: <Method>` · `Type N — <Name>` | the definition in one bold sentence, then its parts; a procedure as `<ol class="spaced">` |
| `theorem-box` | `Theorem — <Name>` · `<Name> Test` · `<Name> Identity` | the statement, then its conditions as a list |
| `formula-box` | `Formula — <Name>` · `Master Formula — <Name>` | the display equation, then its Where list |
| `intuition-box` | `🔮 Intuition — <hook>` · `🔮 Why <X>` · `🔮 Analogy — Think of <thing>` | plain words, one everyday image with numbers; a case-by-case walk for a "why" |
| `example-box` | `Example — <Name>` · `Example (from Lecture N) — <Name>` | *We are given:* …, then **Step 1 —** … with the arithmetic, a bold answer, what it means |
| `warning-box` | `⚠️ Common Mistake — <X>` · `⚠️ Watch Out — <X>` | the trap, the test to apply, the right answer |
| `practice-box` | `📝 Practice 2.3 — <Name>` · `📝 Mock Question 4 — <Name> [Section 3]` · `Exercise 1.1 <source-tag>` | the question; data as a `<table>`; parts (a)(b)(c); then the collapsible solution |
| `solution-box` | `Solution` | inside the collapsible: **Step 1 —** the reasoning in words, the arithmetic, a bold answer, (why the tempting wrong answer is wrong) |
| `summary-box` | `📐 <N>. <Topic>` | the cheat-sheet compression: definitions, formulas with symbols named, causal chains |
| `lecture-banner` | `<div class="lecture-banner" id="s2"><h2>2. <Topic></h2><div class="tag">Lecture N · <one line></div></div>` | a numbered section header |
| `toc` | `<div class="toc"><h3>Table of Contents</h3><ol>…</ol></div>` | links to every h2 and h3; every `href="#id"` must hit an id |
| Where list | below | every symbol of the formula, one line each |
| `svg-container` | `<div class="svg-container">` one or more `<svg>`, side by side | the figure, then its caption under it (figures.md) |
| difficulty badge | `<span class="difficulty diff-easy">Easy</span>` · `diff-medium` Medium · `diff-hard` Hard · `diff-challenge` Challenge | at the end of a Level heading |
| `source-tag` | `<span class="source-tag">(Problem Set 2, Q4)</span>` | after a problem's title; `(original)` for your own |

Small helpers: `<strong class="hl">` (blue emphasis), `<ol class="spaced">`, `<table class="center">`,
`<table class="glossary">`, `<p class="end-note">`.

**The Where list**, inside the formula or definition box or right under it:

```html
<p><strong>Where:</strong></p>
<ul>
  <li>\(M\) (<em>money supply</em>): the stock of money held in the economy, dollars</li>
  <li>\(V\) (<em>velocity</em>): times an average dollar is spent in a year, per year</li>
</ul>
```

**The collapsible solution**, after every practice problem, in the guide and on the sheet:

```html
<div class="solution-toggle" onclick="toggleSolution('sol2-3')">Show Solution</div><div class="solution-content" id="sol2-3"><div class="solution-box"><div class="box-title">Solution</div> … </div></div>
```

Every id is unique (`sol2-3`, `ex1-2`, `mock4`) and every toggle's id exists: the check flags
duplicates and orphans. Print opens every solution. A mock question's toggle reads `Show Grading
Feedback`; its content is `<p><strong>Correct Answer: …</strong></p><p><em>Analysis:</em> …</p>`.

## Titles and emoji, exactly

- A spaced em dash between a box's kind and its name: `Definition — Real GDP`. 🔮 opens every
  intuition, why or analogy title; ⚠️ every warning; 📝 every practice problem in the guide; 📐 every
  cheat-sheet box. Nothing else carries an emoji (not the model's assorted cheat-sheet emoji, not
  exercise-sheet titles).
- Numbering: sections `1.3`; problems in a section `📝 Practice 2.3 — <Name>`; mock
  `📝 Mock Question 4 — <Name> [Section 3]`; exercise sheet `Exercise 1.2` (Part 1, second problem).

## The session guide

```
h1          <Course> — <Topic> Study Guide
p.subtitle  Covers <Lecture N / Chapter X> · <Tutorial N>
toc
[optional components, only when the week needs them: rules.md 16]
h2  0. Prerequisites                  every tool the week uses, compact, one worked line each
h2  1. <Topic 1>                      a lecture-banner, tag "Lecture N · <one line>"
    p   the question this section answers, one to three plain sentences
    h3  1.1 <concept>                 a concept cell (below)
    h3  1.N Cumulative Problem Set: <topic>   course problems in full, then original; basic to exam-level
h2  2. <Topic 2> …
h2  N. Full Mock                      about 5 questions in the course's real test format
h2  N+1. One-Page Master Cheat Sheet  a 📐 summary-box per section
```

The check requires: every h2 numbered from 1 (before the mock) holds an h3 containing "Cumulative
Problem Set" (the model's §1 lacks one: here every section has one); an h2 containing "Mock"; an h2
containing "Cheat Sheet".

## The concept cell (one h3)

```
h3  1.3 <Concept>
p               the question it answers, or where it sits in the week's thread
intuition-box   🔮 Intuition — <a concrete case with numbers>
definition-box  Definition — <Term>: one bold sentence, then the parts
formula-box / theorem-box   the display equation, then the Where list: every symbol, one line each
p               why it works, what it means; a case-by-case walk when useful
example-box     Example — <Name>: We are given … Step 1 … bold answer, what it means
svg-container   the figure, then "Figure 1.3: <what to see>"
warning-box     ⚠️ <the trap>: the test to apply, the right answer
```

Use the blocks the concept needs, in this order; a model opens with its pieces named (rules.md 3).

## The exercise sheet

```
h1          <Course> — Exercise Sheet: <Week topic>
p.subtitle  <what it covers> · Lecture N & Tutorial N
toc         Contents
h2  Part 1 — <Topic>
    h3  Level 1: Definitions and Basic Calculations <badge Easy>
    h3  Level 2: Setting Up / Graphing <badge Medium>      answers drawn as SVG where there is a graph
    h3  Level 3: Application <badge Hard>
    h3  Level 4: Mixed, Exam-Level <badge Challenge>       one long multi-part scenario
h2  Part 2 — <Topic> …
```

- One Part per topic of the week. A Level heading may add the topic: `Level 2: Graphing the Investment
  Line`. The check requires every Part to hold Levels 1 to 4.
- 3–5 problems per level (the model is lighter, 1–2). Every course problem of the week sits at its
  level, in full even when the guide also works it; the rest are `(original)`, in plain realistic
  scenarios with ordinary names.
- Every problem `source-tag`ged; every solution step by step, behind the toggle; every symbol named
  in the problem or its solution. Someone who has read only the guide can do every problem.
