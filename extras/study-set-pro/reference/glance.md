# Week at a glance

**What it is:** a compact visual review layer, not a guide. One to three US Letter sheets that show
**every key concept of the week visually**: the core definitions, the formulas with every symbol
named, the key graphs, and the one or two results or traps worth remembering. Dense but readable at a
glance; **no prose paragraphs** — short lines, bullets, equations, figures, tables.

The bar: `models/glance-1.png … glance-3.png`, an approved real week, and its spec
`examples/week-at-a-glance.mjs`. Look at both before writing; copy the card patterns, masthead,
footers, tags and tone.

## The sheets

- **1–3 sheets**: fewer when the week is light, never a fourth (the check refuses it).
- **Masthead.** Kicker: `<COURSE> · Week N · <dates> · <Lecture Wed 9 Sep> · <Tutorial 1 Mon 14 Sep>`,
  the lecture and tutorial only when known (confirm the tutorial exists and its date; none that week,
  leave it out). Title: the week's topic. Right: `Week at a glance · i of n` over a three-part
  subtitle naming what that sheet holds (`the problem · the tools · the corner`).
- **Cards** are numbered per sheet. Each card's `src` names its sources: printed slide numbers,
  problem-set questions, textbook sections (`slides 9–13 · PS1 Q11 · Textbook A.7`). Say once, in a
  footer, that slide numbers are as printed on the deck.
- **A gilt Remember card and a red Traps card** somewhere in the week (the model: a full-width
  Remember strip ending sheet 1, a Remember card on sheet 2, Traps on sheet 3).
- **Footers**: left, the sources (`Sources: W1 slides · Problem Set 1 · Tutorial 1 · Textbook Ch. 1`);
  right, the legend (`<span class="tag b">book</span> = textbook only, not on the slides · slide
  numbers as printed`, or `every number recomputed`).

## What goes on them

- **The slides are the syllabus**: every slide topic appears, motivating papers, polls and admin
  slides (test format, quizzes) included.
- **Graphs match the deck**: the same variables on the same axes, the same labels, the same sign
  conventions (taken from this week's deck). Units on every axis and every multiplier.
- **Every symbol is named on its sheet** (a Where list, a caption, or inline) before or where it is
  used. One symbol = one meaning per sheet.
- **Every number recomputed** in the spec and `check`ed against the value the sheet prints; geometry
  from the real functions (a tangency: check the slopes). A number no official answer covers is
  marked `worked here` (`no posted solutions: worked here`).
- **Say exactly what the maths says**, never what no source supports. Do not overclaim a theorem
  (a first-order condition does not find a corner maximum).
- **The `book` tag** (`<span class="tag b">book</span>`) marks textbook-only material, never assigned
  course work. Anything taken from the study guide rather than the course is labelled (`the guide's`).
- **Maths**: `\( … \)` in HTML, never `$…$`; never MathJax inside a figure; Greek in a figure label
  goes inside a `$…$` maths run (figures.md).

## The spec: `glance.mjs`

```js
export default function build(G) {
  const { C, Fig, card, where, page, bisect, toolGrid, g, check } = G
  // 1. the numbers, each checked:  const L = 6 * 13; check(L === 78, 'L = 78')
  // 2. one function per figure (Fig, figures.md)   3. one function per sheet:
  return { title, pages: [page(kicker, title, rightBig, rightSmall, bodyHtml, footLeft, footRight), …] }
}
```

- `card(cls, num, title, inner, src)`: `cls` is the card's span on a 12-column grid, `s1`…`s12`
  (a row's spans add to 12), plus `rem` (Remember) or `trap`
  (Traps): `card('s7 trap', '', 'Traps', …)`. `num` is the blue number, `''` for none.
- `where(rows, head)`: rows = `[[symbolHtml, meaning], …]`; `head` defaults to "Where".
- `toolGrid(cells, cols)`: cells = `[[title, html], …]`, `cols` a grid-template-columns value
  (`'1fr 1fr 1fr'`); the model's toolkit card.
- CSS helpers: `row`, `col`, `f1` (flex fill), `q` (the opening question, italic), `mute`, `big`,
  `ul.t` (tight list), `eq` (centred equation), `eqbox` (boxed result), `step` with `.i` (a numbered
  step), `tag` and `tag b`, `num` (tabular numbers), `res` (a result line under a rule), `fig`, `cap`
  (a caption), `table.tb`, `tg`/`tc`/`tt`/`sub` (tool grid parts), `mono`.

## Done when

The check's report shows, for every sheet: no overflowing card, no maths or figure wider than its
card, raw TeX 0, the footer on the page (not pushed below 1030 px), at most three sheets. Then
**look at every preview PNG** and fix every label that collides with a line or another label.
