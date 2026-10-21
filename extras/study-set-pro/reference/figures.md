# Figures — inline SVG

Every figure is an inline `<svg>` (no images, no chart libraries), drawn to make the point, its numbers
from the real functions. Draw a graph for every relationship the course draws.

## Conventions

- **Canvas** 450×300, `viewBox` equal to the size. A lettered pair: each `viewBox="0 0 350 250"`
  shown at `width="310" height="221"`, so the two sit side by side in print.
- **Axes** from the bottom left, `#566573`, 2 px, arrowheads from a `<marker>` whose id is unique in the
  document (`url(#id)` resolves to the first element with that id on the page, so a duplicate
  silently borrows another figure's marker). **Units on every axis**: `Quantity (units/week)`.
- **The data origin is the axis pixel**: data x = 0 lands on the vertical axis, y = 0 on the horizontal
  one. A real failure: data 0 mapped to px 60, axes drawn at px 50, every intercept 10 px off its
  axis. Check one point on each axis sits on the line (`Fig` does this by construction).
- **Colour by role** (hand-written SVG uses the house hex; `Fig` uses its palette `C`):

  | role | house | `C` |
  |---|---|---|
  | first curve | blue `#2E86C1`, 3 px | `C.blue` |
  | shifted or second curve | purple `#8E44AD` | `C.violet` |
  | points of interest, intercepts | orange `#E67E22`, `r` 4–5 | `C.gilt` (the default) |
  | construction lines, drops, triangles | red `#E74C3C`, 2 px, dash `4,4` | `C.grey` via `drop()` |
  | a filled area | the curve's colour, `fill-opacity=".18"` | `poly(pts, color, .14)` |

- **Shift vs movement along** are always two drawings, a. and b.: a shift draws the old curve blue,
  the new one purple, and an arrow between them; a movement draws one curve, two points and an arrow
  along it.
- **A caption under each figure**, outside the SVG: `<p><em>Figure 2.2: <what to see></em></p>`.
- Hand-written SVG has a bold 14 px title (`a. Increase in Wealth` in a pair) and comments its
  mapping (`<!-- Y=0 -> C=50 -> SVG (50,200) -->`) so the next edit keeps the geometry honest.

## Labels — Unicode, never MathJax

MathJax does not render inside an SVG `<text>`: the label silently loses that part (`Income (\(Y\))`
prints "Income ()"). The check flags it.

- Plain characters carry almost every label: λ α β ε Δ, − (U+2212, not a hyphen), ≤ ≥ × · √ ∞ → ′,
  a bar with the combining macron U+0304 (C̄). Avoid the fraction slash ⁄: write `6/√x`.
- Sub- and superscripts in a `<tspan>`: `p<tspan baseline-shift="sub" font-size="75%">x</tspan>`,
  `x<tspan baseline-shift="super" font-size="75%">*</tspan>`; not the Unicode ₁ ₂, which print tiny.
- A typeset formula only when a label truly needs one: a `<foreignObject>` holding
  `<div xmlns="http://www.w3.org/1999/xhtml">\( … \)</div>`, sized generously (it clips silently).

## Two ways to make a figure

1. **Hand-written SVG** in the HTML part.
2. **`figs.mjs`** in the document's folder, beside its HTML parts (a glance spec draws its figures the
   same way, inside `glance.mjs`):

```js
export default function figs(G) {
  const { Fig, C, g, check } = G
  const f = new Fig('a1', 450, 300, [0, 10], [0, 10], { l: 50, b: 40 })
  f.axes('$x$ quantity', '$p$ price', { xt: [0, 5, 10], yt: [0, 5, 10] })
  f.line(0, 10, 10, 0, C.blue, { w: 2.4 })
  f.point(5, 5)
  f.text(5, 5, 'E', null, 'start', 11, { dx: 6, dy: -6 })
  return { demand: f.svg() }
}
```

In an HTML part, the placeholder `<!--fig:demand-->` (inside a `svg-container`, caption under it) is
replaced by that SVG at build; a name `figs` does not return stops the build. `new Fig(id, w, h, [x0, x1], [y0, y1], { l, r, t, b })`:
the id names the figure's arrowheads and clip path, so it is unique in the document; `l r t b` are
the margins in px (defaults 40, 12, 18, 30), and the axes sit on the left and bottom margins.

| method (data coordinates) | draws |
|---|---|
| `axes(xl, yl, { xt, yt, xtl, ytl, ybreak })` | both axes; ticks at `xt`/`yt`, labelled `xtl`/`ytl` or the numbers; `ybreak` marks a y axis not starting at zero |
| `path(pts, color, { w, dash, clip, op })` | a polyline through `[[x, y], …]`, clipped to the plot |
| `curve(f, x0, x1, color, { w, dash, n, op })` | `f` sampled `n + 1` times (240); non-finite values skipped |
| `line(x0, y0, x1, y1, color, { w, dash, clip, op })` | a segment |
| `arrow(x0, y0, x1, y1, color, { w, px })` | an arrow; `px: true` takes pixel coordinates |
| `drop(x, y, color, { toX, toY })` | dashed lines from the point to the axes |
| `point(x, y, color, { r, hollow })` | a dot; `hollow` for an old or excluded point |
| `text(x, y, t, color, anchor, size, { dx, dy, px, halo, weight, italic })` | a label, white halo by default so it reads over lines |
| `poly(pts, color, op)` | a filled area |
| `svg(width)` | the SVG markup, scaled to `width` |

In a label, `$…$` marks a maths run: letters italic, `_x` / `_{xy}` subscript, `^x` / `^{xy}`
superscript (`'$MB_p$ = 6'`); Greek is set in a maths font. Two `$` in one label always pair up, so
money in a label is "10 dollars". Palette `C`: `ink`, `muted`, `muted2`, `hair`, `grid`, `grey`, and
`blue`, `violet`, `gilt`, `red`, each with a pale tint `blue_t` … `red_t` for fills. `G` also gives
`g(v)` (a number as printed: six significant digits, trailing zeros dropped) and `bisect(f, a, b)`.

**Numbers drawn come from the real functions**, and `check(cond, msg)` asserts them against what the
text prints: `check(Math.abs(xStar - 5) < 1e-9, 'x* = 5')`. A tangency is a tangency: check that the
slopes are equal at the point. A failed check stops the build.

**Before printing**, look at the rendered page: every label shows, inside the viewBox, and none is
struck through by a curve or another label.
