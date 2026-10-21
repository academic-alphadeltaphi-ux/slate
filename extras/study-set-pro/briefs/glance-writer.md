# Brief — the glance writer

Fill every `{{…}}` and send the rest as the agent's prompt (background, `model: "sonnet"`).

---

Build the {{COURSE}} Week {{N}} WEEK AT A GLANCE ({{TOPIC}}): 1–3 US Letter infographic sheets that show every key idea
of the week visually, then check it and print it into Slate. A study guide and an exercise sheet are being written
beside it; this is the quick-review layer, not a guide.

Work folder: `{{WORK}}` (absolute). Run every command from the Slate folder `{{SLATE}}`.

READ, in this order, and nothing else unless a figure needs it:
1. `{{WORK}}/brief.md` — the week: topics in slide order, notation (use it exactly), formulas, the course problems, the
   numbers, the figures. It is your source.
2. `{{SKILL}}/reference/glance.md` (the rules and the spec format) and `{{SKILL}}/reference/rules.md` (the parts on
   symbols, numbers and never inventing).
3. The bar: Read `{{SKILL}}/models/glance-1.png` (one approved sheet), then `{{SKILL}}/examples/week-at-a-glance.mjs`
   — the spec that drew it: copy its structure (a numbers block with `check`s at the top, one function per figure, one
   per sheet), its card patterns, masthead, footers and tone.
4. Only for a graph that must match the deck: the page images {{FIGURE_PAGES}} — render them with
   `node scripts/study-set.mjs pages {{WORK}} "<pdf>" <pages>` and Read the PNGs.

WRITE `{{WORK}}/glance.mjs` (the format is in glance.md): every slide topic of the brief on a card; every formula with
its symbols named; the key graphs drawn from the real functions; a Remember card and a Traps card; 1–3 sheets — fewer
when the week is light, never a fourth. Every number on a sheet is computed in the numbers block and `check`ed.

CHECK: `node scripts/study-set.mjs check {{WORK}} glance` — fix every fault (an overflowing card, maths wider than its
card, the footer pushed off the page). Then Read every `out/glance-preview-*.png` it wrote and fix every label that
collides with a line or another label, every figure that disagrees with its numbers. Run it again until `faults: none`
and the previews are clean.
PRINT: `node scripts/study-set.mjs print {{WORK}} glance`.

Do not touch `{{WORK}}/guide/`, `{{WORK}}/sheet/`, `brief.md` or anything in the notes. No python, git or curl.

REPORT, under 100 words: sheets and what each covers; the line `print` gave; any number you could not check against an
official answer; anything in the brief that did not add up.
