# slate — SPEC (the constitution)

> **This is the Slate for Alpha Delta Phi build.** It is the same codebase as the full app with study sheets and Ask turned off (SPEC §21). Sections below still describe those features where they were part of a larger design — read those as history, not as something to look for on a screen. The routine this copy runs is §21's light budget: scripts/run.mjs and scripts/light-prompt.md, not the heavy morning pass of §20.37.

OneNote replacement. Local, files on disk, Claude-native. Read this before touching code.
Decisions here were settled in the 2026-09-08 brainstorm. Change them here first, in code second.

## 1. Purpose

the student takes lecture notes in OneNote. OneNote's files are opaque, so Claude cannot read them.
slate is a OneNote-style app whose every byte is plain text or a plain asset on disk, so that
Claude, Obsidian, grep and a future the student can all read and write the same notes.

## 2. Principles, in priority order

1. **Files on disk are the truth.** Markdown for text, JSON for layout and ink, assets beside them.
   Any index is rebuildable and deleting it loses nothing.
2. **Claude never needs geometry.** Anything Claude writes with zero layout information is a valid
   page. The app lays it out.
3. **The format outlives the editor.** Every formatting feature must serialize to markdown or inline
   HTML that Obsidian renders and grep can find. If it cannot, it does not exist.
4. **Linear first, canvas-ready.** Flow-or-pin: an element without coordinates flows, with
   coordinates it is pinned. A plain markdown file is a page.
5. **Ink is stroke data**, never a flattened image. Deferred, but the schema reserves it.
6. **Looks like a daily driver.** Apple Notes bones, OneNote's coloured sections, light and dark.

## 3. On-disk format

Root: `~/Desktop/Claude OS/Notebooks/` (override with `SLATE_ROOT`). The root sits inside the student's
Obsidian vault, so Obsidian is a free second client. Keep everything Obsidian-compatible.

```
Notebooks/
  CLAUDE.md                      contract for any Claude session (section 11)
  _slate.json                    order of notebooks
  .trash/                        soft-deleted items, mirrored paths
  .git/                          snapshots (section 9)
  <Notebook>/                    notebook = folder
    _slate.json                  { "order": [...sections], "color": "#hex" }
    <Section>/                   section = folder
      _slate.json                { "order": [...pages], "color": "#hex" }
      <Page>.md                  page text (section 4)
      <Page>.blocks.json         page layout, optional (section 5)
      <Page>.assets/             attachments, optional
      <Page>/                    subpages, optional, unlimited depth
        _slate.json
        <Subpage>.md ...
```

Rules:
- A page is up to four things sharing one name: `.md`, `.blocks.json`, `.assets/`, subpage folder.
  Rename, move and trash act on all four. Nothing can be orphaned.
- Names starting with `_` or `.` are never content.
- Titles: the filename without `.md`. Forbidden characters `/ \ :`. Trimmed. Max 200 chars.
- `_slate.json` `order` lists child names. Missing names are appended alphabetically. Unknown
  names are ignored. `color`, `icon` (emoji) and `label` (a sentence for the student and Claude) are
  optional. The root file also holds `highlights`, the meaning of each highlight colour. File is
  optional.
- Delete = move to `.trash/<mirrored path>`. Emptying the trash is manual, never automatic.
- The app writes atomically: write `.tmp-<name>` in the same folder, then rename.

## 4. Page text: `<Page>.md`

```markdown
---
created: 2026-09-08T16:02:11-04:00
---
# Lecture 3

Text before the first anchor is a block with no id.

<!-- slate:block k3f9x2 -->
A second container. Anchor ids are 6 chars, base36, unique within the page.

<!-- slate:block p0q1r2 -->
Third container.
```

- Frontmatter is optional YAML: `created`, `kind` (lecture, reading, syllabus, problem-set, exam,
  summary, notes, admin, other), `tags`, `icon`. The app edits keys line by line so the rest of
  the header stays byte-identical. Kinds show as emoji in the page list and top bar.
- Blocks are separated by `<!-- slate:block <id> -->` on its own line. No anchors = one block.
- The app only inserts an anchor when it needs an id, i.e. the moment a block gets pinned or a
  second block is created. A page Claude wrote and the student never rearranged stays byte-identical.
- Obsidian hides HTML comments in reading view. grep sees clean text.
- On save after a move or pin, pinned blocks are reordered by (y, x) then flowed blocks in file
  order, so reading order equals spatial order. Saves without a layout change never reorder.
- Per-block dirty tracking: a block the student did not click into is written back byte for byte from the
  original file. Only edited blocks pass through the editor's serializer.

Formatting (principle 3):

| Feature | Stored as | Obsidian |
|---|---|---|
| bold, italic, strike, code | markdown | yes |
| headings, lists, task lists, quotes, code blocks, tables, links, images | GFM | yes |
| math inline / block | `$…$` / `$$…$$` | yes |
| underline | `<u>…</u>` | yes |
| highlight | `==…==` | yes |
| colour, size, font family (per span) | `<span style="color:…;font-size:…;font-family:…">` | yes |
| whole-container font, size, colour | sidecar `style` on the block, not in markdown | n/a |

Block-level style covers the common case so the markdown stays clean. Only per-span deviations
become inline HTML.

Serializer conventions, settled by the spike in `spike/` (14 fixtures, `npm run spike`):
- Hard break is a trailing backslash `\`, never two spaces. It survives whitespace trimming.
- Asset paths in links and images are percent-encoded: `Lecture%203.assets/board.png`. Spaces
  are the only characters a title can carry that CommonMark rejects in a destination.
- Tables are written column-aligned.
- Escaping is minimal and never uses HTML entities: `\` `` ` `` `~` `$` always; `*` unless spaced on
  both sides; `_` only at word edges; `<` only before a letter, `/`, `!` or `?`; `&` only before
  something entity-shaped; `[` only when `](` or `][` follows; block starters `#` `>` `-` `1.`
  `***` only at line start.
- Edited blocks are normalized to `-` bullets, `1.` numbering and `**` `*` emphasis. Untouched
  blocks are never rewritten, see dirty tracking above.

## 5. Page layout: `<Page>.blocks.json`

```json
{
  "version": 1,
  "elements": [
    { "id": "k3f9x2", "type": "text",  "x": 48, "y": 48,  "w": "auto", "z": 1,
      "style": { "font": "system", "size": 16, "color": null } },
    { "id": "f1a2b3", "type": "file",  "src": "Lecture 3.assets/slides.pdf",
      "x": 48, "y": 600, "w": 480, "h": 96, "z": 2 },
    { "id": "i9z8y7", "type": "image", "src": "Lecture 3.assets/board.png",
      "x": 560, "y": 48, "w": 400, "h": 300, "z": 3 },
    { "id": "m4n5o6", "type": "media", "src": "Lecture 3.assets/lecture.m4a" },
    { "id": "t7u8v9", "type": "text",  "parent": "i9z8y7", "x": 20, "y": 20, "w": 200, "z": 4 }
  ]
}
```

- Units: CSS px at zoom 1. Origin: top-left of the page, or of the parent when `parent` is set.
  Coordinates are never negative. The page has no edges and grows right and down.
- `x`/`y` absent = **flowed**. Present = **pinned**. Flowed elements stack top to bottom from
  y=48 at x=48 with a 48 px gap (room for the document header bars), in this order: text blocks in `.md` order, then non-text in sidecar order.
  **Both are multiples of the 24 px baseline** (`--lh`), and a text block carries no vertical
  padding, so every flowed line of text lands exactly on a rule of the ruled page (§12). Change the
  baseline and these change with it. A flowed
  element skips past any pinned element it would collide with inside the flow column (x from 48 to
  693), the way text wraps around a float. A box pinned to the right of the text, or below it,
  never moves the text. Checked by `spike/layout-test.mjs`.
- Text blocks never store `h`; it derives from content. Other types store `w` and `h`.
- `w: "auto"` reproduces OneNote: the container widens as you type up to 645 px then wraps, and it
  shrinks or expands to fit the window until the first manual resize, which converts `w` to a number
  that the window never touches again.
- `z`: integer, higher on top, ties broken by array order. Last touched gets max+1.
- `parent`: the element's coordinates are relative to that element. Move the parent, children move.
  This is how notes written on an imported document stay on it, and how ink and PDF highlights
  will attach later. OneNote does not do this and users complain.
- Types: `text`, `image`, `file` (card with name, size, open button), `media` (native audio or
  video player), `pdf` (pages rendered by pdf.js, stacked vertically, lazily; a `file` whose src
  ends in `.pdf` is treated as `pdf`), `ink`. `display: "card"` on a pdf or media element shows it
  as a file card instead; the header bar on every document and its menu toggle it. Adding files
  (the `+` button, a drop, a paste) asks once per batch: printout or card for PDFs, player or card
  for audio and video. Images are always inline.
- Ink: `{ id, type: "ink", parent?, parentW?, strokes: [{ id, tool: "pen" | "highlighter", color,
  width, pen, points: [[x, y, pressure, ms], …] }] }`. One ink element per scope: the page, or a
  document it was drawn on (then coordinates are relative to it and scale with `parentW`).
  Capture: a pen pointer always draws; the mouse draws when a drawing tool is chosen (`P` pen,
  `H` highlighter, `E` eraser, `V` or `Esc` back to select). Coalesced pointer events are used, so
  the stored points are the tablet's full sample rate; points closer than 0.6 px are dropped.
  Pens render as pressure-shaped outlines (perfect-freehand); the highlighter is a flat marker:
  constant width, square ends. The eraser has two modes: whole stroke, or partial, which splits a
  stroke around the erased part (pieces get new ids), with four sizes and a circle cursor. The
  pen's back button erases. The tool pill shows pointer type, pressure and tilt live.
- Lasso (`L`): draw a loop around handwriting to select the strokes mostly inside it; then drag
  the box to move them, pull its corner to resize (points and pen width scale together), pick a
  colour, `A−` / `A+`, delete with `⌫`, `Esc` to drop the selection. Each operation is one history
  step. Ink follows the theme: with the top-bar toggle on (default), the neutral ink (`#1d1d1f` on
  light paper, `#f2f2f7` on dark) is displayed in the other theme's neutral; the file keeps the
  colour as written.
- History: every canvas action except typing (strokes, erasing, moves, resizes, deletions, hide,
  z-order, notes, drops) is undoable with `⌘Z` / `⌘⇧Z` or the pill's arrows, as whole snapshots.
  Text editing keeps TipTap's own undo while a block is focused.
- Zoom: `⌘+`, `⌘−`, `⌘0` and pinch zoom the page only, from 50% to 300%, around the cursor. The
  sidebar and bars never scale. Zoom is a view setting, not stored in files.
- Element menu (right-click): open in a new tab, hide to a pill / show, bring to front, send to
  back, reveal in Finder, remove from page (file stays), delete file (to `.trash`). `hidden` and
  `z` are stored on the element. A hidden document takes its notes and ink with it; selected text
  in a PDF keeps the browser's own menu so copy still works.
- PDF annotations are elements with `parent` = the pdf element:
  `{ id, type: "highlight" | "underline", parent, text, color, page, rects: [{ page, x, y, w, h }] }`.
  Rects are PDF points at scale 1, origin top-left of the page, one per line. `text` is always
  stored so the file says what was marked. An annotation with only `text` (Claude-written) is
  resolved against the page's text layer when that page renders, and `page`/`rects` are written
  back. Unresolved ones are listed at the top of the document.
- Clip (`C`): drag a rectangle over a PDF page or an image and that part becomes a picture, set
  down 24 px to the right of the document it came from (clear of the flow column when that
  document is flowed, so it never pushes its own source down), level with where it was taken; drag and
  resize it like any image, and it is also on the clipboard. The PNG is composed from what the
  page already has (pdf.js's page canvas, the image, PDF highlights, the ink over them) at 2 px
  per page unit, saved to `.assets/` as `Clip n.png`, and the element records its source:
  `clip: { of: "<src of the source element>", page?: <PDF page number>, x, y, w, h }` with `x`,
  `y` relative to that element's top-left, in page units. The tool returns to select after one clip;
  an all-white rectangle (a page still drawing, or bare margin) makes no file and says so.
- Notes on a document are ordinary text blocks with `parent` = the pdf element; clicking on a page
  creates one there. Selecting text in a PDF shows a bar with highlight colours, underline, copy.
- Text entries reference anchor ids. A block with no anchor has no entry and always flows.
- Sidecar text entries whose anchor no longer exists are dropped on next save. Elements whose
  `src` is missing render as a broken-file card, never dropped.
- Unlimited elements per page.
- Typing math: the editor turns `$$x^2$$` into an inline math node (serialized as `$x^2$`) and
  `$$$…$$$` into block math. A lone `$x$` typed as text stays text and is escaped as `\$x\$`, so a
  file never changes meaning on reload. Markdown written by hand or by Claude uses plain `$…$`.

## 6. Attachments

- `<Page>.assets/` beside the page. Filenames kept as uploaded, deduplicated with ` (2)`.
- Image pasted or dropped **into a text block**: inline markdown `![](Page.assets/x.png)`.
- Anything dropped **on empty canvas**: a floating element, pinned at the drop point.
- Kinds: image (png, jpg, jpeg, gif, webp, svg), media (mp4, mov, webm, m4a, mp3, wav), file
  (everything else: pdf, docx, pptx, …). Kind is decided by extension.
- No size limit. Assets are excluded from git snapshots.

## 7. Editing model

- One TipTap instance per text block, created on focus, destroyed on blur. Rendered markdown
  (same renderer, read-only) when not focused, so a page with 40 blocks does not hold 40 editors.
- Extensions: StarterKit, Highlight, TextStyle + Color + FontFamily + FontSize, Link, Image,
  TaskList, TaskItem, TableKit, Mathematics, Placeholder, `@tiptap/markdown`, plus the spike's
  overrides: `TextStyleMd`, `UnderlineMd`, `ImageMd`, `HardBreakMd`, `WikiLink`, and the
  minimal escaper patched onto `MarkdownManager`.
- Toolbar floats above the focused block. Shortcuts: Cmd+B/I/U, Cmd+Shift+X strike,
  Cmd+Shift+H highlight, Cmd+E inline code, Cmd+K link, Cmd+1/2/3 headings, Cmd+Shift+L task.
- Font family: curated list (System, Serif, Mono, Rounded, Handwriting, Condensed) plus a free text
  field for any installed font. Size: 10 to 48.
- Tables: TipTap table UI (add row/column, delete) in v0. Serialized as GFM. No merged cells.
- Click on empty canvas creates a pinned auto-width block at that point and focuses it.
- Drag by the block's grip. Resize width by the right edge. Esc blurs.
- Autosave: 500 ms after the last change, plus on blur and Cmd+S. Undo is per block, per focus.

## 8. Concurrency: two writers

Claude and the app both write the same files. Mechanism:

- Server watches the root with chokidar (`awaitWriteFinish`) and pushes events over SSE
  `/api/events`. It ignores events whose content hash equals what it just wrote. One SSE connection
  per tab: `api.events` is a bus every card and pane subscribes through (§20.1).
- Every save carries the hash of the content it was based on. Mismatch → HTTP 409 with the current
  disk content. Client: if the editor is clean, reload silently. If dirty, banner with
  "keep mine" / "take disk". No merging in v0.
- Tree changes (new page, rename, trash) refresh the sidebar and page list live.

## 9. Snapshots

- Server runs `git init` in the root if absent, with `.gitignore` containing `*.assets/`.
- Every 5 minutes, if `git status --porcelain` is non-empty: `git add -A && git commit -m "snapshot <ISO>"`.
- Nothing else. No branches, no remote. History is a safety net, not a workflow.
- First thing to cut if v0 runs long.

## 10. Search

- Server holds every `.md` in memory: path, title, body with frontmatter and anchors stripped,
  and a folded copy (NFD, combining marks removed, lowercased) so `economie` finds `économie`.
  Rebuilt on boot, patched by the watcher. No SQLite.
- Cmd+K: fuzzy quick-open on titles and paths, client side.
- Cmd+Shift+F: `/api/search?q=` substring on folded text, returns path and snippets, grouped by
  notebook. Click opens the page and scrolls to the block.
- A second in-memory index, the document index, holds the words inside what a page shows (PDF text
  cached as `<name>.pdf.txt`, transcripts, recognised ink); §20.6 amends this section.

## 11. The Claude contract: `Notebooks/CLAUDE.md`

Written by the app on first run and by the import script; the app rewrites it when its version
(`server/claude-md.js`; v18 as of 2026-09-18, v11 at v0.7) is newer than the marker in the file. Content, in brief:

- Everything is plain files. `.md` is text, anchors separate containers, `.blocks.json` is layout,
  `_slate.json` is order and colour, `*.assets/` holds attachments.
- Create a page: write `Title.md` in a section folder. It appears last in that section.
- Add text: append to the `.md`. Prefix with a fresh `<!-- slate:block id -->` line to make it a
  separate container. No geometry needed, ever.
- Attach a file: copy it into `Title.assets/`, then add `{ "id", "type", "src" }` to `elements`
  in `Title.blocks.json`, creating the file as `{"version":1,"elements":[]}` if absent.
- Highlight `==text==`, underline `<u>`, colour `<span style="color:…">`. Math `$…$`.
- Links to assets: percent-encode spaces, `![](Lecture%203.assets/board.png)`. Hard break: trailing `\`.
- Ids: 6 chars base36, unique within the page. Write atomically if you can. Never touch `.trash/`.

## 12. UI

- Three panes: sidebar (collapsible tree of notebooks and sections, coloured dot per section),
  page list (ordered, subpages indented, drag to reorder and to nest), canvas.
- Every document on the canvas wears a header bar above it: name, drag to move, printout/card or
  player/card toggle, menu, remove. Text boxes show a grip on hover with a delete button; an empty
  box is removed the moment it loses focus, Backspace in an empty box deletes it, right-click any
  box (the first one too) to delete it. The ink layer sits above every element.
- Print is an overlay inside the app (`⌘P` or the print button): every PDF page rendered first,
  fit to Letter or one sheet, `Back` or `Esc` returns to the notes. The `/?print=` route still
  exists for a plain browser and has the same Back button.
- Glass: translucent panels (`backdrop-filter` blur and saturation) over a soft colour wash, the
  top bar floats over the scrolling page, tools live in a floating pill. SF system font stack, HIG
  spacing, icon buttons with tooltips and single-key shortcuts. No browser dialogs anywhere:
  confirm, prompt and alert are in-app. Accent colour per section drives selection and tints.
- **Dialogs and popovers are opaque, not glass.** A frosted panel over the Home grid is unreadable —
  the student said so of the course card. Anything you are meant to *read* sits on `--glass-solid` with a
  dimmed, blurred scrim behind it; glass is for chrome you look past, never for content.
- **No emoji in the chrome.** Every icon is a line icon from `Icons.jsx` — 24-grid, 1.8 stroke,
  `currentColor` — so a column of them reads as one family. Page kinds map to an icon name in
  `kinds.js`; nothing writes an `icon` emoji into `_slate.json` or frontmatter any more. The format
  still permits the field; the app no longer renders it.
- **The page is ruled paper, and the text sits on the rules.** The canvas is the desk, the page is
  an opaque sheet with a rule every `--lh` (24 px) that scales with zoom; it replaced a dot grid.
  The first version ruled at 28 px while prose ran at 23.25 px, so every line drifted and the rules
  appeared to move as the student typed — the whole `.prose` scale, the flow origin and the flow gap are
  now locked to `--lh`, and one rule sits under each line box. Headings take two rules, paragraph
  gaps take one. Content that cannot be gridded (tables, PDFs, images) breaks the rhythm after
  itself; that is accepted. A toolbar switch (`data-paper="ruled" | "plain"`, persisted) turns the
  ruling off entirely.
- **Drift, 2026-09-09.** the student reported the rules moving again, "whenever I write or move". Two causes,
  both measured before and after. *Writing:* a `taskItem` is a flex row, and its `<label>` carried
  its own 24px line box plus `margin-top: .2em`, making the row **27px** — so every line under a
  checkbox slid 3px further off the rules, and the drift changed as he typed. The label is now
  exactly one rule tall and centres its box inside it. A fenced block drifted the same way
  (`.7em` padding = 18.5px, a UA `margin-bottom: 1em`, and `.9em` code inside `.88em` `pre` making
  each line box 24.5px); it is now whole-rule padding, no margin, and `font-size: inherit` so the
  strut and the inline box agree. *Moving:* only `appendBlock` snapped to the baseline — a box
  clicked into existence, dragged, or dropped kept whatever pixel it landed on. `snapRule` in
  `layout.js` is now the one helper and all four paths use it. x is never snapped (the rules are
  horizontal); **Alt while dragging** places a box off the baseline on purpose.
  The invariant to test after any change to `.prose`: every block's `top` and `height` inside
  `.el-text` is a whole multiple of `--lh`.
- Density: rows are 29 px with a 13 px label; the disclosure is a chevron, not a filled badge; child
  counts and modified dates are muted and appear on hover, so titles get the width instead of
  truncating to "Week …". Notebook names are small-caps; sections hang off one hairline.
- Light and dark: follow system, manual override in the toolbar, persisted.
- Dividers resizable and persisted. Single open page, restored on reload.
- Export: a dedicated print view (`/?print=<page>`) renders the page read-only with every PDF
  page drawn up front and ink included, then prints. Two modes: fit to Letter width (paginated,
  scaled with CSS `zoom`) or one sheet at actual size (`@page` sized to the content). Absolutely
  positioned boxes can still be cut at a page break in fit mode.

## 13. Stack and repo

- Vite + React, plain `.jsx`. Express server for the filesystem. No TypeScript in v0.
- Vite on 5173 proxies `/api` to Express on 5174. `npm run dev` starts both.
- Desktop app: `npm run app` builds `/Applications/Slate.app` (`scripts/build-app.mjs`): `vite build`
  to `dist/`, an icon from `desktop/icon.svg`, Electron's bundle renamed and pointed at this repo.
  The app (`desktop/main.cjs`) starts the same Express server on port 5177, which serves `dist/`,
  and opens one window with the traffic lights over the sidebar. It is a launcher tied to the repo:
  rebuild after client changes; server changes need only a relaunch. Rust was not installed, so
  Electron rather than Tauri; macOS asks once for Desktop access, since the notes live there.

```
slate/
  SPEC.md
  package.json
  server/        index.js  fs.js  format.js  watch.js  search.js  git.js  claude-md.js
    routes/      <name>.js, each exporting register(app, ctx)   (§20.1)
  shared/        page-format.js   anchor split/join, frontmatter, ids (used by both sides)
  src/           main.jsx App.jsx api.js grade.js calendar.js
    components/  Sidebar PageList Canvas Block Toolbar Search ConflictBanner
    editor/      extensions.js markdown.js
    styles/      <group>.css, imported by the component that owns it
  scripts/       import-courses.mjs quercus-sync.mjs … test.mjs (npm test)
  spike/         round-trip fixtures and runner
```

## 14. Scope

**v0, definition of done**
- Sidebar tree, page list, canvas. Create, rename, trash, reorder notebooks, sections, pages,
  subpages. Section and notebook colours.
- Flow-or-pin canvas: click to create, drag, auto and fixed width, z-order.
- TipTap per block with the full formatting table, block-level style, toolbar and shortcuts.
- Attachments: image inline and floating, file cards, audio and video players, drag-drop and
  paste, unlimited per page.
- Autosave with hash check, watcher, conflict banner.
- Cmd+K and Cmd+Shift+F, accent-insensitive.
- PDF export via print. Git snapshots. Root `CLAUDE.md`.
- Import of ECO 206Y1, ECO 208Y1, ECO 227Y1, POL 106H1 from `~/Desktop` by script (section 15).
- Light and dark. Looks like Apple Notes had a child with OneNote.
- `npm run dev` works. Demonstrated in the browser, not claimed.

**Status 2026-09-08**: v0 built and exercised in the browser. Verified: three panes with the four
imported courses; create, rename, trash, reorder, colours; click-to-create pinned blocks; typing,
Cmd+B, autosave to disk with the expected markdown; external edit from a terminal appearing live;
drag pins and persists; quick-open and full-text search; light and dark. Not exercised by hand yet:
PDF export via print, image paste into a block, table editing polish. Test scripts:
`npm run spike` (15 fixtures), `node scripts/smoke.mjs` (43 API checks), `node spike/layout-test.mjs`.
Known: imported folder names may contain `:` (from the Desktop); new names cannot, for Obsidian's sake.

**Build order** (foundations first, so the tail slips if anything does)
1. Spike: TipTap ↔ markdown round trip against fixtures. Go/no-go for section 7.
2. Server: format, fs, atomic writes, hashes, watcher, SSE, search, git.
3. Root `CLAUDE.md` and the import script. This is the acceptance test for principle 1.
4. Shell: panes, tree, page list, CRUD.
5. Canvas: flow-or-pin, drag, width.
6. Editor: TipTap, toolbar, block style.
7. Attachments. 8. Search UI. 9. Theme, export, shortcuts.

**v0.3, done 2026-09-08**: glass redesign with icon tools; page-only zoom; undo/redo history for
every canvas action; partial eraser with sizes and cursor; flat highlighter; paper grows with ink;
document right-click menu (open, hide, front/back, reveal in Finder, remove, delete to trash);
print view that renders every PDF page first; in-app dialogs; sidebar collapse fixed.
Verified in the browser the same evening, every item, against a throwaway copy of the notes
(`SLATE_ROOT` plus `SLATE_PORT`, so the live app was untouched). Fixed on the way: pinch zoom
drifted vertically by the top bar's spacer; context menus were positioned inside the zoomed page;
right-click on a PDF page never opened the document menu; the first drag of a page's anonymous
block stalled (the element remounted mid-drag); the tool pill's buttons remounted on every render;
a collapsed document left its notes and ink floating; the print view printed empty placeholders
and never became ready while a document was hidden. Not exercised: typing (the driving browser
never holds focus) and the Huion pen (driver not installed).

**v0.2, done 2026-09-08**: ink capture with pen or mouse, highlighter and eraser, live device
readout; document kinds, tags and icons in frontmatter; notebook and section icons and labels;
named highlight colours stored on each annotation. Still open: verifying pressure with the Huion
tablet (install the driver if the readout says "mouse"), handwriting recognition.

**v0.1, done 2026-09-08**: `pdf` element rendered by pdf.js with lazy page rendering, text
selection, highlight and underline annotations that store the quoted text, Claude-written
annotations resolved by quote, notes pinned on the document via `parent`, right-click removal of
any element, scrolling past the content in both directions. Still open: table editing polish,
keyboard polish.

**v0.4, 2026-09-08 (evening)**: ink layer above documents (strokes were drawn behind PDFs);
document header bars with move, printout/card, menu, remove; add-files flow with the printout or
card, player or card choice; text boxes deletable (grip ×, menu, Backspace, empty boxes vanish);
print as an in-app overlay with Back; luminous-glass redesign; the desktop app; course notebooks
reorganised into seven sections by `scripts/reorganize-courses.mjs` (old folders in `.trash/`).
Not re-verified by hand: typing in the driving browser (no focus), the Huion pen.

**v0.5, 2026-09-08 (night)**: course notebooks reshaped to General, Announcements, Fall 2026,
Winter 2027 → one page per week → subpages Notes, Lectures (files as subpages), Recordings, Study
sheets (`scripts/restructure-weeks.mjs` then `scripts/restructure-terms.mjs`, calendar in
`scripts/lib/terms.mjs`); the page list folds subpages; the Hub: `Hub/Today/*.md`
and `Hub/_hub.json` written by `scripts/quercus-sync.mjs` (announcements into the Announcements
page, files into their week as pages, deadlines, tests, grades), a Home screen that reads it
(`/api/hub`) with a Sync button (`/api/sync`), a 07:10 scheduled task (`slate-quercus-sync`) that
runs the sync and writes a morning note. The Hub notebook is hidden from the tree; Home is its face.

**v0.6, 2026-09-08 (late)**: lasso for handwriting (move, resize, recolour, delete); ink follows the
theme with a toggle; Home shows the weekly schedule and a course panel (professor, meetings,
grade, due, tests, new posts, Quercus link) on click; announcements as one subpage each, linked
from the weeks they mention; the sync also reads the Desktop course folders (recordings) and the
Sync button runs the deterministic script then the Claude pass (`claude -p`).

**v0.7, 2026-09-09 (in progress)**: the academic loop (§20) — Wave 0 landed the shared ground:
`src/calendar.js`, the route convention and child env in `server/index.js`, the SSE bus and every
route wrapper in `src/api.js`, `fold`/`foldKey`/`parseTasks`, the screen enum, `openPage(path,
target)`, two panes and the ask dock in the shell, the Canvas handle, CLAUDE.md v11, the
twelve-step morning prompt, `npm test`.

**Deferred, unchanged**: mobile, collaboration, audio recording synced to notes, importing OneNote
content.

**Parked**: verifying Obsidian renders real pages; Tauri. The Desktop course folders are no longer
synced; `Notebooks/` is the target now.

## 15. Import

Source: `~/Desktop/ECO 206Y1`, `ECO 208Y1`, `ECO 227Y1`, `POL 106H1`. About 2 MB total.
Copy, never move; the Desktop folders remain the Quercus sync target for now.

Mapping: course folder → notebook. Each top-level subfolder → section (`Session 1 09:08:2026` →
section `Session 1 09:08:2026`, kept verbatim). Each section → one page named after the folder,
with every `.md` inside becoming a text block in file order and every other file copied to
`<Page>.assets/` and listed as a flowed element. Files at the notebook's top level go to a
section named `General`.

## 16. Risks

- TipTap round trip. **Resolved 2026-09-08.** `npm run spike` passes 14 fixtures; see `spike/README.md`.
- Math serialization back to `$…$`. **Resolved**, byte-identical out of the box.
- Very large PDFs. v0.1 problem, solved by rendering only visible pages.
- Obsidian rendering of `<span style>`: believed yes, verify once real files exist.

## 17. The hub: what comes next

slate is meant to hold everything academic. Candidates, roughly in the order they pay off:

1. **Recording synced to notes.** Record the lecture from the page; every stroke and paragraph
   remembers its timestamp; tap a line to hear what was said then. Files: `<Page>.assets/rec.m4a`
   plus a `t` on strokes and a `<!-- slate:t 00:12:41 -->` marker on paragraphs.
2. **Transcripts and summaries.** Whisper on the recording, the transcript as a page beside the
   lecture, Claude's summary and key terms at the top. Everything stays grep-able.
3. **Quercus sync into `Notebooks/`.** The scheduled sync writes straight into the seven sections:
   announcements newest first, files into `Readings` or `Lectures`, assignments with due dates.
4. **Home page.** Today's classes, what is due this week across courses (from syllabi and
   Quercus), pages touched recently, open task items. The first thing the app shows.
5. **Highlights across courses.** The colour palette already names meanings (`exam`, `definition`);
   a view that lists every `exam` highlight per course is a review sheet for free. Flashcards
   from `definition` highlights with spaced repetition.
6. **Handwriting recognition.** Stroke points are stored; recognise them lazily, store the text
   beside the stroke, search it, convert a paragraph on demand.
7. **PDF text in search.** Index each PDF's text server-side (pdf.js in Node) so `⌘⇧F` finds
   passages inside slides and readings, not only notes.
8. **Templates.** New lecture page: date, slides placeholder, notes column, summary box. New
   problem set page: questions, my work, marks.
9. **Two pages side by side.** Reading on the left, notes on the right, ink on both.
10. **Backlinks and a course graph.** Wikilinks already exist; show who links here.
11. **Version history.** The git snapshots exist; a "restore this page as of Tuesday" panel.
12. **Ink tools.** Lasso to move ink, straight-line and shape snapping, a ruler.
13. **Web clipper.** A URL becomes a page with the article archived beside it.
14. **Export a course.** One PDF of a whole section or notebook, in order, for exam week.
15. **iPad.** Only once the desktop app is the daily driver.

## 19. The grade model and the course plan

### 19.1 Every course graded by its own rules
`scripts/lib/terms.mjs` carries each course's **grading** block, transcribed from its syllabus:
components (tests, writing, quizzes, final, bonuses), the items in each with their dates, and one or
more **schemes** with weights and best-of rules. ECO206 has two schemes and the registrar applies
whichever is higher; ECO208 counts the best two of three midterms at 27% each; ECO227 adds a bonus
worth 10% of the WebAssign total; POL106 mirrors the weights Canvas itself publishes (18 / 25 / 20 /
35 / 2, lowest three quizzes dropped). Canvas's own "current score" ignores all of that, so slate
never shows it.

`src/grade.js` is the model — pure functions shared by the app and the scripts, so the number on
the Home screen is the number in the morning email. `standing` evaluates every scheme and picks the
best; `neededFor` bisects on a uniform fill for the unwritten items to find what is needed for a
target, which best-of rules make non-linear. `scoresFromAssignments` maps Quercus assignments onto
items by each component's `match` regex ("Test 2" → `t2`). The morning sync computes standing for
each course and writes it into `Hub/_hub.json` and the *Standing* section of `Hub/Today/Overview.md`.

### 19.2 The simulator
On Home, a course's panel carries **GradeSim**: one field per graded item (Quercus marks filled in
and flagged), a slider for "if the rest comes in at", the live grade under the winning scheme, and
what is needed on everything left for A-, A, A+ — *locked in* and *out of reach* when that is the
truth. It is the same model, run in the browser on whatever he types.

### 19.3 Pages from Quercus, and the plan for the weeks
The sync pulls **pages**: every module `Page` item, the **front page** (`General/Home`), and every
page the front page links to — ECO206 keeps one topic page per week there, in no module, each
locked until its week arrives, so the sync asks again every morning and files it under that week
when it opens. External-tool and URL items become `General/Links`. A page that changed on Quercus is
rewritten unless the student has written containers on it. Images embedded in page bodies are decoration
and never become pages.

Where Quercus has no weekly structure, `scripts/lib/syllabus.mjs` holds the plan the professor
published elsewhere — ECO227's chapters and WebAssign set from the course outline; a course with
`readings` gets them week by week with links — and `scripts/seed-syllabus.mjs` writes them as a
`Readings` or `Problems` page under each week. POL 106H1 was dropped on 2026-09-09: its notebook is
in `.trash/`, its Desktop folder in the macOS Trash, and it is gone from `terms.mjs`.

## 20. v0.7: the academic loop

Decided 2026-09-09 from nine designs and three critiques, landed as one release. The premise is
ROADMAP §0: the student does not sit in lectures, so the app must make the material arrive, get understood,
get drilled and get tested without him in the room. Everything below is judged by that.

### 20.1 Shared ground

- **One calendar model.** `src/calendar.js` (pure, browser-safe, the `grade.js` pattern) is the only
  place `COURSES[].meetings` is expanded: every meeting on every date, cancelled on `NO_CLASS`
  days, in reading weeks, between terms, before a course's published start, or when the outline
  says so; the next meeting, the next graded item, its coverage window. `terms.mjs` exports
  `TERMS`, `READING`, `NO_CLASS`, `inReadingWeek`, `isClassDay` once. The plan, the Google calendar,
  the course screen and the Sunday review all import it; a day is a class in every screen or none.
- **One route convention.** `server/routes/<name>.js` exports `register(app, ctx)` with
  `ctx = { store, ROOT, HttpError, wrap, q, git, watch, search, PORT, repo, env }`; `env` carries
  `SLATE_ROOT`, the `~/.local/bin` PATH prefix and `ELECTRON_RUN_AS_NODE=1`, so a script spawned
  with `process.execPath` runs as Node inside Slate.app too. Only the export printer deletes that key.
- **One SSE connection per tab** (§8 amended): `api.events` is a bus; cards subscribe through it.
- **One screen enum** in the shell: `'home' | 'next' | 'course:<key>' | null`, persisted as
  `slate.screen`. `openPage(path, target)` carries a search target and knows which pane it opens in.
- **One text-parsing rule set** in `server/format.js`: `fold`, `foldKey`, and `parseTasks` — depth-0
  GFM task items only, so a nested `reviewed` line never inflates a count.
- **One contract bump.** `CLAUDE.md` v11 carries every rule below in one text; the stale transcript
  paragraph is corrected (transcripts live in `.assets/`, §18.3).
- **Nothing is written by navigation.** Opening a screen reads; pages and Hub files are written by
  the morning pass, the 10:00 build, an explicit button, or a tick that goes through `PUT /api/page`.
- **Derived data lives under `Hub/`, `.assets/` or an `_` folder.** Pages in the course tree are
  written only when they are the student's to work on: the week's `Problems` page and, when a week carries
  tasks, its `Plan` page. Scripts never move or delete a line he typed.

### 20.2 Problems

Three professors said the tutorial problems and the weekly sets are the exam, so every assigned
problem is a row on one page per week per course: `<Course>/<Term>/<Week>/Problems.md`, kind
`problem-set`. Its header block belongs to `scripts/problems.mjs` only while its hash matches the
one recorded in `Hub/_problems.json`; its one container starting `## Problems` is merged
**append-only**: a row whose key is missing is added at the end, nothing existing is rewritten,
reordered or removed. The row is `- [ ] Ch 1 #3 — [[announcement]]` (the box is *attempted*) with
`  - [ ] reviewed` nested under it; a trailing `17/20` is a score. This shape was run through the
editor's own extension set and comes back byte-identical (`spike/fixtures/13-problems.md`). A row's
identity is its whole label, folded, minus a trailing score and minus ` · WebAssign` with whatever
follows it (`ch 1 #3`, `problem set 1 · q3`, `fall-ex1`): itemising a set adds one row per problem
beside the set's row. A header is adopted on first sight only when it is made of lines the script (or
the pre-v0.7 seed) writes; anything the student typed in an anchorless page is his block 0, and an edited
header records no hash and is never rewritten. A worked solution is its own container appended
at the end of the page whose first line is `### Solution · <label>`; that is what marks a row
*solved*.

Rows come from the announcement subpages ("Ch 1 #3, 4 and Ch 2 #2, 8"), from the ECO227 outline's
WebAssign sets, and from the ECO206 topic pages' problem-set links; a whole set stays one row until
the morning pass itemises its PDF through `problems.mjs --add`, never by editing the page. A
problems lead-in that yields nothing is an *issue*, surfaced to the plan (§20.3), never dropped.
`Hub/_problems.json` is the derived summary — attempted, reviewed, solved per week; the WebAssign
calendar and bonus — and `GET /api/problems` computes it live. It is the only source of problem
counts anywhere in the app. WebAssign sets join `hub.deadlines` with `source: "syllabus"` beside the
unchanged Quercus rows (`source: "quercus"`); until the cadence is observed they carry a week and no
time, and the calendar leaves them alone. The Problems page wears no chrome: its counts sit in the
top bar's kind chip and in the page list; "Write the solution…" is a preset in the Ask rail.

### 20.3 The plan: What's next, Plan pages, coverage

`scripts/plan.mjs` runs after `problems.mjs` in the 07:10 pass, after the 10:00 build, and behind an
explicit rebuild; it writes `Hub/_plan.json` (14 days), `Hub/Today/Next 7 days.md`, and its memory
`Hub/_plan-state.json`. Nothing is rewritten when the content is unchanged. Its logic is
`src/plan.js`, imported by the script, the server and the client. Announcements are parsed with a
deterministic grammar: a line starting with a weekday and a date is an anchor whose scope runs to
the next; readings, bring, due, no-class and topic phrases become tasks or cancellations; problem
phrases are handed to `src/problems.js`. Anything that cannot be placed on a meeting or read is an
*issue*, listed in `_plan.json`, shown on What's next, and named in the morning email.

A week gets a `Plan.md` page only when it carries at least one task; its header block is the
script's, its `## Before class` container is append-only with tasks grouped by meeting, ticks matched
by a stable key, a task no longer generated marked rather than removed. `spike/fixtures/14-plan.md`
keeps the shape honest. The plan reads `Hub/_calendar.json` so the student's own events sit in the timeline
between classes (ROADMAP §5).

**What's next** is the second sidebar row: today (classes, deadlines, his own events), a card per
course for the next test with days left and **coverage** — sheets over weeks with material,
problems attempted over assigned, plan tasks ticked over total — then seven days of timeline with the
Plan tasks tickable in place (through `PUT /api/page` with the base hash), and the issues card. The
Schedule, Deadlines and Next tests cards move here from Home; one screen answers "what is next".
Coverage is three counts, one function in `src/plan.js`, labelled Coverage: no percentage until
cards and mocks exist (ROADMAP 4, 5), and never a number a non-attender cannot move.

### 20.4 The course screen

One screen per course in the Home slot, opened from the Home card, a hover icon on the notebook row,
or its right-click menu; the notebook name keeps folding, as every notebook does. `GET /api/course?key=`
assembles it on request from files that exist — `_hub.json`, `_plan.json` (next class, tests,
coverage), `_problems.json`, `_study-queue.json`, `_sync-state.json` and the notebook tree — memoised
two seconds, reloaded on watcher events under the notebook or those files. Cards: This week (next
class from the plan, then Notes, Lectures, Recordings, Study sheets, Problems with what each holds),
Next test (the week strip, the coverage counts, the next two tests, this course's deadlines),
Standing (GradeSim unchanged), Study sheets with Confirm/Undo, Problems per week with a score
field, Announcements, Links & admin. The CourseDetail popover is gone.

### 20.5 The Sunday review

`slate-sunday-review` (cron `0 18 * * 0`) follows `scripts/review-prompt.md`: run `plan.mjs` and the
gate, then `scripts/review.mjs` writes `Hub/Review/Sunday review · <date>.md` (kind summary,
`since`/`until` so reviews tile the calendar) — a Plan placeholder, next week from `_plan.json`,
standing recomputed with `grade.js`, next tests, and per course what landed (pages count as new
only with a body, scaffold pages never) and what is unreviewed (sessions without a sheet and why,
weeks with material but no session folder, open problems and plan tasks from the two JSON files, a
line when a course has been quiet two weeks). The Claude pass replaces the one placeholder line with
a plan and emails the page under the morning's quiet-day rule. Home's head links to the last review.

### 20.6 Search inside documents (§10 amended)

A second in-memory index, the **document index**, holds the words inside what a page shows: every
PDF's text, every recording's transcript, and the `text` of every ink element once handwriting is
recognised. PDF text is extracted in Node with pdf.js's legacy build — serially, in the background,
never before the port opens — and cached beside the PDF as `<name>.pdf.txt` keyed by mtime and size;
it moves with the page, is never snapshotted, is grep-able, and is filtered out of a page's asset
list. `scripts/pdf-text.mjs` makes the caches in the morning pass. `⌘⇧F` returns one row per page
with every snippet stamped by source and filterable by kind; ↑/↓ moves per page, Tab cycles a page's
hits, Enter lands on it: the container, the PDF page with the phrase flashed, the player set to the
moment, or the strokes. Ask reads the same `textFor()`; there is one extractor.

### 20.7 Ask the page

`⌘J` docks an opaque rail beside the canvas of the active pane. Node assembles the context in tiers
under a 360 000-character budget — the page, its PDFs, its transcript; the course block from
`terms.mjs`, `syllabus.mjs` and `_hub.json`, never cut; the week's page, Problems, transcripts, decks
and sheets — and one `claude -p` per question answers with no tools, streaming over one POST. Presets
are fixed questions in `scripts/ask-presets/`; `openAsk({ page, preset, block, problem, question })`
is the one entry point. "Save as note" appends one anchored block pinned under the page's content
through the editor's own save; the `solution` preset writes `### Solution · <label>` at the end of a
Problems page, which is what marks the row solved. Threads survive a reload in `sessionStorage`
and nothing else; the foot says what was read and how long it took.

### 20.8 The calendar as the spine

The primary Google calendar (the connector cannot create a calendar, and a second one would not show on his phone by default); a dedicated `slate` calendar can be named in `terms.mjs` later. `scripts/calendar-events.mjs --plan`
turns `expandMeetings` and `hub.deadlines` into one event per occurrence — tests, deadlines and
tutorials by default, lectures behind a switch — each tagged on the description's last line
`slate:<code>:<date>:<kind>[:<id>]#<hash>`; the Claude pass lists the calendar, node computes the
diff (create, update, delete only when tag, summary and start agree; foreign events untouched; an
event the student deleted stays deleted), the pass applies it and commits after each batch, then reads the
next seven days of every calendar into `Hub/_calendar.json`. This step runs from the 07:10 cron
only; the Sync button never reaches a connector. `GET /api/calendar` serves the readback and the
sync's health; the plan and the review consume it.

### 20.9 Handwriting to text

Ink stays stroke data (§2.5). Apple Vision reads a bitmap of an element's pen strokes and the words
land on the element: `text`, `textAt`, `inkHash` (of the stroke ids: a move keeps it fresh, a new
stroke or an erase makes it stale) and `lines[{ text, confidence }]`. The helper is
`desktop/hwr/hwr.swift`, built by `npm run build:hwr` with an SDK the compiler accepts (the build script tries the default SDK, then every older one under CommandLineTools/SDKs), and the same contract as `hwr.py` through
PyObjC when no compiler is usable; the server takes the first runner whose `--probe` answers.
`POST /api/hwr` writes through `writeLayout` under a per-page lock and the open page adopts the new
hash. Right-click on handwriting recognises; an opaque card shows the lines; *Convert to text* is
ink-to-text in one undo step. The document index reads `text`; `scripts/hwr.mjs` recognises stale
elements each morning, skipping pages touched in the last ten minutes.

### 20.10 Export, history, two panes

**Export** prints every page of a section or notebook through the print view in a hidden Electron
window that waits for the page's own readiness flag (headless Chrome prints "Loading PDF…" —
verified), merges with pypdf under `uv run`, and lands the binder in `<Notebook>/_exports/`:
reserved, ignored by snapshots, never re-imported. Inside Slate.app the window is in-process.
**Version history** lists the snapshots that touched a page, previews and diffs a version, and
restores through the editor's own `replace` — saved, snapshotted, undoable, frontmatter kept; the
server only reads git. **Two panes**: the page list drives the left pane; the right pane opens from
"Open to the right" or `⌘K`; the active pane owns the keyboard, the tool pill, `⌘P` and search hits;
a page is open in one pane at most. History, the split and export live in the top bar's `···` menu
and the context menus, not as new buttons.

### 20.11 The morning pass and the button

`scripts/sync-prompt.md` is twelve numbered steps in run order: sync, sweep, transcribe, handwriting,
PDF text, problems, plan, gate, calendar, note, email, reply. The morning note is at most ten lines;
the email has fixed sections (note, Standing, Today, Problems, Ready to build, Waiting on, Not
placed, Calendar, Health) and one quiet-day rule. The Sync button runs the same file with a skip
injected for the three connector steps and a hundred turns; the cron runs all twelve. Tests:
`npm test` runs every suite serially on the test ports; nothing here ever touches :5173, :5174 or
:5177.

### 20.12 Decisions taken by default (2026-09-09)

The design pass asked nine questions; these were answered with defaults so the build could start,
and each is one line to change: lectures are not pushed to the calendar (tests, deadlines,
tutorials are), and there is no midday readback; ECO208's midterms are assumed non-cumulative and
ECO227's tests assumed to cover the weeks since the previous test, marked `assumed` in
`terms.mjs` until the coverage pages say otherwise; WebAssign rows carry a week and no time until
the cadence is observed; the Ask model is the CLI default, `SLATE_ASK_MODEL` overrides; the
solution preset works without textbooks on disk; binders land in `<Notebook>/_exports/` with a PDF
outline only; the Sunday review stays at 18:00 (it runs on next launch if the app was closed) with
the quiet-day rule; Home keeps its schedule grid.

### 20.13 The screens redrawn (2026-09-09)

the student's verdict on the first cut: the screens left a third of a wide window empty, Home led with a
wall of prose instead of the courses, the seven days were confusing, and a week cost too many
clicks. Four decisions, taken with him, and the shape they take in code.

**Width is fluid, and the column count follows the screen's own width.** The `max-width: 1100px`
cap is gone; `--screen-max` is 1880px and the grids reflow with **container queries** on
`.home` (`container-name: screen`), never media queries — the sidebar's width is not the page's
business, so the same rule is right whether the sidebar is open, closed or resized. `.home-grid`
runs two columns, three past 1180px of screen and four past 1580px. Every screen (`Home`,
`What's next`, a course, a term, a week) shares `src/styles/screens.css`: the width rule, the
markdown rule and the small primitives (`.pill`, `.chiprow`, `.blank`).

**Home leads with the courses; the day moved to a right rail.** `.hub-body` is
`minmax(0,1fr) 350px`, collapsing to one column under 1040px. The left column is the courses
first and largest, then the Monday-to-Friday timetable, the study-sheet queue and what arrived; the
right rail carries today's classes, the morning note, what is due, the test countdowns and the
standing. A course card is now the biggest object on the screen: code, standing, name, when it
meets, the next class with its room, the next deadline, the coverage line, and a chip per term that
opens the term grid — so a week is two clicks from Home.

**The next seven days are a board, not a list.** `WhatsNext` draws one column per day across the
width (`src/styles/board.css`), today first and tinted, each event a card carrying its Plan tasks
with the boxes tickable in place. A quiet day is a quiet column with a dash, not a screenful of
"Nothing scheduled". The separate "Today" card went with the vertical timeline it duplicated, and
`PlanBits`' `MeetingRow` / `DueRow` / `TestRow` / `CalRow` went with it.

**A term is a grid and a week is one page.** Two screens and one route module,
`server/routes/week.js`, which writes nothing:

- `GET /api/term?key=&term=` — every week of the term as a row, from the same `weekRow` the course
  screen already builds (now exported from `routes/course.js`), plus a `columns` array reduced to
  what the grid prints: a state (`done` / `partial` / `todo` / `empty`), a line, and the path the
  cell opens. Weeks come from `terms.mjs` when it knows the course, so a week whose folder does not
  exist yet still has a row; for any other notebook the rows are the folders on disk. The Plan
  column's counts are the plan's own (`Hub/_plan.json`, summed per Plan page), never a re-parse.
- `GET /api/week?path=<Course>/<Term>/<Week>` — the six buckets: the text of Notes, Problems and
  Plan, the child pages of Lectures, Recordings and Study sheets with their assets counted, and the
  week's classes from `Hub/_plan.json`.

`TermScreen` is a table: weeks down, the six things across, one click to any of them, the current
week tinted. `WeekScreen` stacks all six on one scroll with a jump bar and the week's classes in a
rail. The screen enum gains `'term:<key>/<term>'` and `'week:<key>/<term>/<week>'`; a **term section
of a course notebook** in the sidebar now opens the grid instead of the page list — 'Page list' in
its context menu, and the button on the grid itself, still give the old three-pane view, and every
other section is unchanged.

**Reading a page without the editor.** `src/components/MdLite.jsx` draws markdown for the screens:
headings, paragraphs, lists, GFM task items, tables, quotes, rules, fences, and `**bold**`,
`*italic*`, `` `code` ``, `==highlight==`, `~~strike~~`, links and `[[wikilinks]]` inline. Anything
it does not know is printed as written, never swallowed. It is a *reader*: the editor is still the
only place a page is written. A box ticked on a screen goes through `src/tick.js`
(`toggleMdTask`) — read the page, flip the one line that stands exactly as it was drawn, `PUT
/api/page` with the base hash, one retry on a stale hash — the same path the editor and the board
use, so nothing else in the file is touched and a concurrent write never loses. Two identical lines
in one page flip the first; that is the only ambiguity.

**What was deliberately not done.** The week screen does not mount a live editor per section.
`Canvas` owns a scroll, an ink layer, a tools pill and the keyboard; six of them stacked in one
scroll would fight each other, and the SPEC has one editor for a reason (§7). Reading, ticking and
one click to the real page is the trade. If typing directly into the week is wanted, that is a
separate change and a bigger one.

### 20.14 Three screens (2026-09-09)

the student, on the §20.13 build: *"this is way too complicated, make it super intuitive."* Measured first, so the
cut had a target: five screens, the same facts on several of them (his classes in **five** places,
deadlines in three, tests in three, study sheets in four), **nineteen** sidebar rows for three courses,
eight cards on Home, and two competing ways to reach any page. He named the symptoms: the same thing in
many places, each screen too full, and not knowing where to click.

**Three screens.** `Today`, a course, a week. `'next'` folded into Today and `'term:'` into the course
screen; `initialScreen` maps a stored value of either onto its replacement, so an old `slate.screen`
never lands on a blank pane.

- **Today** (`Home.jsx`, still the `'home'` enum) answers four questions in order: what is happening
  right now, what the week looks like, which course you want, what is coming. `Right now` / `Next class`
  is one line. `This week` is the board from §20.13, full width above the two columns because it was
  being squeezed to 460px beside the rail. `Coming up` is **one** chronological list — deadlines and
  tests together, soonest first — replacing a Deadlines card and a Tests card that never agreed on
  order. The rail keeps the morning note (§20.13's decision) and what arrived since the last check.
- **A course** owns its own weeks: the term grid is a panel with Fall/Winter tabs (`TermGrid.jsx`), not
  a screen. A term is not a place you navigate to; it is how the course is shaped.
- **A week** is unchanged.

**One row per course.** The sidebar is `Today`, a **Courses** group of one row each — colour, code, and a
live line (`Lecture today`, `Lecture in 5 days`) so the tree says something instead of naming folders —
then **Notebooks** for everything else. A course's sections are opened deliberately by its chevron and
are closed by default, keyed `open:<name>`. Nineteen rows became about seven.

**One More per screen** (`More.jsx`). Everything a screen can show but rarely needs — the Sunday review,
calendar status, blocked sheets, sentences the grammar could not file, sync errors, the full Hub lists,
the grade simulator, links and admin — sits behind a single closed disclosure, so the default view is
short and "where do I click" has an obvious answer. Nothing was deleted; it stopped being in the way.

**Plainer words** where they were free: "What's next" → Today, "Sync Quercus" → "Check Quercus",
"prepared" → "done", "Standing" → "Where your mark stands", "not placed" → "Sentences I could not file",
"(assumed)" → "(best guess)".

### 20.15 The course page and the week, redrawn (2026-09-09)

Four things the student named, two of which were bugs rather than taste.

**The course header answers "what is this course".** Before, only the code, the name and one line of
times. Now a `cd-about` strip: taught by, meets, textbook (from `terms.mjs`, merged into the payload),
what it is marked on, and every way out — Quercus, whatever `Links.md` holds, Syllabus & admin,
Announcements. The facts about the course come before anything time-based.

**This week is the next class, then counts.** The old card was a tinted line and six sparse rows that
mostly read "empty / nothing yet / none" — a list of absences. Now the next class is one solid block
(how far away, day, kind, room, time, topic, what to do before it, and it opens the To do page), and
under it `cd-holds`: one tile per thing the week holds, showing the count, lit when there is something
and quiet when there is not. A week with nothing in it says so once.

**Next test leads with the countdown.** `42 days` at 42px, then the title, the date, what it covers.
Two bugs fixed: the title and the detail both carried the same words (`Test 1 · Problem solving ·
problem solving · Mon 5–7 pm`) — `testsWithCoverage` now drops from the detail anything the title
already says; and `CoverageBars` drew a full-width empty track and a dash for a signal with no data,
which reads as broken. A signal with nothing in it now gets no bar at all, and when none of them has
anything the card says what is actually true ("nothing to measure yet — 1 of these weeks has happened
and none has a study sheet yet").

**A week shows what is in it, not what is not.** Six cards each saying "No X yet" made a young week look
dead. `WeekScreen` now renders a card only for a section with something in it; the empty ones collapse
into one quiet `wk-empties` row of dashed chips, and a week with nothing at all gets a single card that
says so and offers the six pages. An intro that is only a heading no longer renders an empty card.

**The mark simulator was rewritten.** `.sim-stats` was a three-column strip (`.9fr 1.1fr 1.5fr`) that
collided with itself as soon as the card was narrow — and inside §20.14's `More` grid the column is
320px, so "No marks yet" broke over three lines and the projection overlapped the weights. It now reads
as three sentences that wrap at any width: where you stand, where you land if the rest averages *n*
(one slider), and what each of A−/A/A+ needs from here. The marks themselves moved into a closed
`<details>`. `src/grade.js` is untouched — the model, and so the number, is the same.

### 20.16 Motion, and a container is not a page (2026-09-09)

**A page that holds pages opens as an index of them.** `Lectures`, `Recordings` and `Study sheets` are
containers the sync fills; the real thing is always a child. Offering a blank writing surface on the
container invited notes into a page nobody opens again — the student: *"you can write in the recording main
category, same goes for the others, makes it confusing."* `PageIndex.jsx` draws the children as cards;
the container's own text, if it has any, shows under them, and *Write on this page too* reveals the
editor for the rare case where that is wanted. The file is untouched either way — §3 is unchanged, this
is a rendering decision, and nothing already written is hidden.

**Two cards fill the row.** `.cd-pair` (`auto-fit, minmax(380px, 1fr)`) replaced `.home-grid` for the
course screen's pairs: two cards in a three-column grid left a third of the row empty.

**The board is sized by what is in it.** A day with nothing gets `.5fr`, a day with one thing `1fr`, a
busy day `1.35fr`, set inline from the day's own event count — seven equal columns wasted the width on
empty weekends. A narrow column drops its "in N days" label rather than wrapping it over three lines.

**Today opens with a hero, not a status bar.** Three slots across the width: the class that is on (or
next), the things to do before it with the boxes tickable in place, and what else today holds. The old
single line left four-fifths of the row empty.

**One motion layer**, `src/styles/motion.css`, imported last so it can lift everything:
- One easing (`--ease`) and one duration scale (`--t-fast` / `--t` / `--t-slow`).
- Screens **assemble**: `rise` on every card with a stagger down each column, `pop` on board cards,
  `fade` down list rows and grid rows, `slideIn` across the sidebar and page list.
- Things you touch respond: lift on hover for every card, `scale(.94)` on press, a checkbox that
  springs (`--ease-back`) when ticked, a glow under the primary button.
- State is legible: the class happening now carries a pulsing ring, the live dot beside "on now"
  breathes.
- **Only transform and opacity are animated**, so nothing reflows; colour transitions stay at
  `--t-fast`. The whole file is disabled under `prefers-reduced-motion`.

### 20.17 The icon, and Today as the courses (2026-09-09)

**The white border round the app icon was a build bug.** `scripts/build-app.mjs` rasterised
`desktop/icon.svg` with `qlmanage -t` — Quick Look's *thumbnail* generator, which composites onto white
and frames the result. `scripts/render-icon.cjs` renders it under Electron in a transparent offscreen
window instead; the corners come out `rgba(0,0,0,0)` and the installed `.icns` keeps its alpha. The mark
itself is new: a dark slate tile with three faint rules and one bright stroke written across them, with
the ~10% breathing room macOS expects so nothing is clipped by the shape mask. No white page rectangle —
that is what made the old one read as a generic document.

**Today, third attempt — this time the structure changed, not the arrangement.** The first two were a
stack of glass cards with uppercase headings; rearranging them was never going to fix "neither good
looking, intuitive nor engaging". The courses are now *the page*:

- **One sentence** at 20px says what is happening: *"You are in ECO206 lecture until 17:00 · OI 2212."*
  It carries the course's colour. It replaces a card that spent four-fifths of its row on nothing.
- **Three large panels**, one per course, colour-washed with that course's own colour and lifting on
  hover; the one you are in right now carries a ring. Each panel holds that course's whole near future —
  the next class with the things to do before it tickable in place, the next thing that is marked with a
  day countdown, and a nudge when a session is ready to become a study sheet.
- Because each course carries its own deadlines and tests, the global **Coming up** list is gone. That
  was the last place the same fact appeared twice.
- Under them the week board, then the morning note and what arrived, then one More.

The two-column `hub-body`/`hub-rail` shell went with it: the panels want the full width, and the note
reads better as one of two blocks at the end than as a tall grey column beside them.

### 20.18 A schedule that is a schedule, and To do as a place (2026-09-09)

**The week is a timetable, not a stack of cards.** The board placed a day's events in a column in order, so an
11–1 class and a 3–5 class sat touching with two dead hours invisible between them, and no time could be read off
the screen. `Timetable.jsx` makes the hours an axis: every class is placed and sized by its real start and end, the
window is computed from what the week actually uses (never a fixed 8-to-9 with dead space at both ends), and a red
line marks now. Google's "Week 38 of 2026" / "Numéros de semaine" all-day entries are filtered — a calendar week
number is not a fact a student needs.

**A schedule that also carries a task list is not a schedule.** Only things that happen at a time are on it. What
is due, what to revise and what to prepare moved to **To do** (`Todo.jsx`), its own screen beside Today. One row per
thing, grouped Today / Tomorrow / This week / Later, filterable by course, and every row states four things: what it
is, which course, when it is wanted, and **where it came from** — the week's list, the announcement it was lifted
from, or `Open in Quercus`. A task with no source is a task you cannot check.

**Clicking a class answers a question.** `ClassSheet` opens over the timetable in glass: the class, its room, its
topic, the things to do before it with the boxes tickable in place, and the links out — the week's list, that
week's notes, and the announcement the tasks came from.

**Today is shorter.** The course panels say four things (which course, when it next meets, what is next marked, a
count of what is open) — the to-dos and the topic left, because they are on the timetable and the To do page. The
morning note shows its first two sentences with *all of it* one click away; it is written as prose and was read as
a wall.

**Your mark is not a footnote.** `GradeSim` came out of the course screen's `More` and takes the full width, in the
order the student asked for: This week and the next test, then what there is to do, then the mark, then every week.

### 20.19 Everything is a destination (2026-09-09)

the student: *"What I really want is clickable things that take me to the task I need to get done."* A task in slate is a
sentence lifted from an announcement — *"Read WMS Syllabus, Ch 1"*, *"WebAssign Fall-Ex1 → Problems"* — and a
sentence you cannot act on is a sentence you skip.

**`src/resolve.js` turns a task into a destination.** First rule that matches wins, most specific first: an explicit
URL; a `[[wikilink]]`, resolved the way the editor resolves one; a tool the course's Links page knows about
(WebAssign, Crowdmark); `→ Problems` or the word *problems* → that week's Problems page; *syllabus* or *outline* →
the General page that carries it; *quiz / test / assignment / submit* → the course in Quercus; *lecture / slides* →
that week's Lectures. `null` means the task names something off-screen (a textbook chapter) and the caller offers
the week's list instead. `resolveItem` does the same for a deadline or a test. Every to-do everywhere now carries
the resulting button.

**One task, on its own.** `TaskSheet.jsx` opens over whatever you were looking at: what the task is, which course,
when it is wanted, where it came from, a button that *does* it, and one that ticks it. Clicking a to-do on Today
opens this rather than navigating to the whole list.

**To do is cards, across the width.** A tall narrow column of grey rows reads as a chore in itself; it is now a
grid of cards, each with a tick circle, the course, what it is, when, and its action.

**The count discrepancy.** The course page counted only `nextClass.before`, while Today summed every future
meeting — so ECO206 read "nothing to do" on one screen and "1 to do" on the other. Both now read the same plan.

**Your mark, wide and short.** Three statements across the top (where you stand, where you land if the rest
averages *n*, what each of A−/A/A+ needs) and then every mark as a wrapping grid of fields — no disclosure, no
tall table.

**Getting back out.** The page topbar's breadcrumb is clickable inside a course: the course name opens its screen
and the week name opens the week, so a page reached from a week is one click from the week again.

**The library** (`server/routes/library.js`, `Library.jsx`): every page in every course flattened into rows that
say where they sit and what they hold — PDFs, audio, whether a recording is transcribed, how many words — with
filters for course, kind and term and a title search. An empty page looks empty from here.

### 20.20 The audit, and what it broke (2026-09-09)

Three agents audited the API, the scripts and the client while the student was away. They found real defects; one of them
also caused real damage, which is the more important lesson.

**An unknown flag ran the full live write pass.** The scripts parse argv with bare `args.includes('--dry-run')` and
had no unknown-flag branch, so `node scripts/plan.mjs --help` left every boolean false and wrote to the real
notebook — as would a mistyped `--dry-runn`. An audit ran that across ten scripts, including three one-off
migrations, which scaffolded 78 empty week folders at the wrong level in all three courses and rewrote their
`_slate.json` orders. Nothing was deleted and no `.md` or asset of the student's changed; the damage was repaired from the
`b108ca7` snapshot and the duplicate imports moved to `.trash`. `scripts/lib/argv.mjs` now makes an unknown flag an
error (`exit 2`, "nothing was written"), `--help` print usage and exit, and a one-off migration refuse without
`--yes-migrate`. This is the fix that matters: the others are bugs, this was a loaded gun.

**A request could hang the whole server.** `/api/course?now=2026-13-45` passes the shape regex but is not a real
date; `isoOf` returns the string `"NaN-NaN-NaN"`, `addDays` cannot advance past it, and `expandMeetings`'
`for (let date = from; date <= to; …)` never terminates — 100% CPU, every route dead including `/api/health`.
Fixed at both ends: the routes reject a date that is not real (`Number.isNaN` on the parsed value, not just the
regex), and `expandMeetings` refuses a non-ISO bound and clamps the span to `MAX_SPAN_DAYS` (800). A 9999 end
date went from 2.5 million rows in 6 s to 687 rows in 12 ms.

**One error contract.** `PUT /api/page` enforced none of the name rules `POST` does and could write the root's
`CLAUDE.md`, a dotfile or a page outside any section — `assertPagePath` now applies the same rules. `/api/reveal`
with no path resolved to the root and opened Finder on the whole notebook. Filesystem errors returned 500 with the
absolute path in the message; they now map to 404/400/403 and the root is redacted. body-parser's own 400 on
malformed JSON was being turned into a 500. An unknown `/api/*` returned Express's HTML page to a client calling
`res.json()`. `/api/term` invented a twelve-week grid for a notebook that does not exist.

**The test runner hid four suites.** It stopped at the first failing suite, and the one that failed was the only
suite that asserts against the student's *live* notes — exact git-diff counts and a binder page number — so editing his
own notes made `npm test` red and silently skipped plan, course, calendar and review. The runner now carries on,
and those two assertions test the property (a real diff; the sheet is under the right trail) instead of the
snapshot. **All twelve suites pass.**

**Two data bugs.** `dateIn()` matched `(mar)[a-z]*` and `(may)[a-z]*`, so "Mark 3 of the questions" filed four
problem rows onto the week of 3 March; month names are now the abbreviation or the full word only, `Feb 31` is
rejected, and the two that are also English verbs need their capital. `neededFor` dereferenced `.best.grade` on a
course with no schemes and returned `Infinity`, which `JSON.stringify` writes as `null` — the same value that
means "nothing marked yet"; `neededForJson` returns `'out-of-reach'` instead.

**Client.** The timetable tested `ev.type === 'cal'` where the plan emits `'calendar'`, so no personal calendar
event ever drew. The task sheet's tick button rendered without an `onToggle` on the course screen and had an
`onToggle` without `canTick` on To do — done nothing in one place, absent in the other. `MorningNote` wrapped
block-level markdown in a `<p>`. Two buttons had no CSS rule at all and rendered as native OS chrome.

**Still open, deliberately.** ECO227's winter syllabus puts "Test 3 · Mon 22 Feb" on week 19 (Feb 8); week 20 is
Feb 22. The authoritative date in `terms.mjs` is right, so only the topic rows for weeks 19–25 are a week early.
Correcting the shift means knowing what week 19 actually covers, which is a question for the outline, not a guess.

### 20.21 Filing, and what a task actually is (2026-09-09)

**A problem set is not a lecture.** The sync had one rule — media to `Recordings`, everything else to `Lectures` —
so ECO206's `Problem_Set_1_Questions`, `..._and_Solutions` and `Tutorial_1_Questions` sat among the slides.
`scripts/lib/filing.mjs` is now the one classifier: `bucketFor(name, { module })` → `recordings | problems |
solutions | admin | lectures`, first rule wins, and the traps come before the general words because
"Problem **Solving** Steps" is a study-skills handout and "Application Coach" is a lecture stream. Solutions file
with the problems they answer rather than earning a seventh folder per week. `quercus-sync.mjs` uses it at both
filing sites, `sync-prompt.md` tells the Claude sweep to use it rather than deciding by hand, and
`scripts/refile.mjs` re-files what the old rule misplaced — dry run by default, moving all four parts of a page
(`.md`, `.blocks.json`, `.assets/`, subpages) or none, and fixing both `_slate.json` orders.

**A task carries what kind of thing it is, in its own sentence.** The Plan page is the truth and stores plain
markdown (principle 3), so this cannot live in a side table: `(optional) ` is written into the text, and
`taskNature(text)` reads back `{ optional, inClass, notOpen }` for every screen. Three consequences the student asked
for: a checkpoint quiz that *happens in* the tutorial is no longer counted as something to do beforehand; an item
that is not open yet says so instead of inviting a click; and optional work is marked rather than sitting at the
same weight as required work.

**A test three months out is not a to-do.** The To do page carries a test only inside `TEST_HORIZON` (14 days) —
before that the course screen's countdown is the right place, and listing it twice made a long list feel longer.

**An announcement posted after a class cannot ask you to prepare for it.** `placeItems`' dated branch attached an
item to whatever meeting matched its date, with no reference to when the announcement went up. It now refuses and
records the reason ("the class had already happened when this was posted"), which surfaces under *Sentences I
could not file* rather than as homework for a lecture that is over.

**"3 to do" opens that course's to-do, not the whole list.** `CourseTodoSheet` answers the question that was
asked; *Everything, all courses* is one button inside it.

**Whose words these are.** An announcement or an imported Quercus page rendered on the same ruled sheet, in the
same type, as the student's own notes — so "Academic Integrity" read as something he had written. The frontmatter always
knew (`tags: ["quercus"]`, a kind, a path under `Announcements/`); nothing showed it. `SourceBanner` puts a band
over the page saying what it is, who posted it and when, with a link back to Quercus, and tints the sheet's edge.
It carries the 50px spacer the floating topbar needs, and the canvas drops its own when the band is present.

**Order on the course screen**: this week and the next test, what there is to do, **every week**, then your mark.

### 20.22 A library of documents, and paper that says whose it is (2026-09-09)

**A library holds documents.** The first version returned every page the walker touched: 144 rows, of which 78
were empty `Notes` scaffolds and 28 were placeholder `Problems` index pages. the student: *"there are 50 problems for
ECO227, and when you click on them it just says Read whatever, and there is no link. What am I going to do with
this?"* A row now has to **be** something — carry a file, or carry enough words to be worth opening — and a
container page (`Notes`, `Study sheets`, `Announcements`, a bucket wearing a page's clothes) never qualifies on
its own. 144 → **30**, every one a thing you can open.

Each row carries its way back to Quercus: the link in the page's own text if it has one, otherwise
`<course>/files/<id>` reconstructed from the file id `Hub/_sync-state.json` recorded when it was downloaded, and
failing both, the course itself, marked as the weaker link. 25 of the 30 resolve to the exact file.

The screen groups by course in the same colour-washed glass as Today — the student asked for that look explicitly —
then by what the thing is, with a type badge (PDF, M4A, PNG) rather than a generic icon, the week it belongs to as
a link into that week, and *transcribed* / *not transcribed* on a recording.

**Paper says whose it is.** Ruled paper is where *you* write. Something the professor wrote now arrives as a
quoted card: the rules are switched off, the ground is tinted, the left edge is coloured, and the band above it
names what it is and when it was posted. The same metaphor the app already had, pointed the other way — and it
answers the complaint that "Academic Integrity" read as something the student had written himself.

### 20.23 Three levels, a header, and a card for the professor's words (2026-09-09)

**The bug behind "three problems show in the tree but not in the main version."** `refile.mjs` moved ECO206's
problem sets into `Problems/`, a folder with no `Problems.md` — a *virtual* page. `/api/week` treated each bucket
as either text or a list, and `problems` was text, so it read the empty page and reported nothing while the tree
listed all three. A bucket is now a page **and** a folder: every section returns both `md` and `items`, and the
week screen draws whichever it has.

**The library drills down.** Three courses side by side, each showing what it holds; a course opens its kinds;
a kind opens its documents. One long scrolling page put everything on screen at once and read as a pile. Search
cuts through all three levels, because when you are hunting a document you do not care where it lives.

**Ruled paper is only where you write.** Lines belong to `Notes`. A lecture handout, a recording, a study sheet
or a Quercus page is a document you read, so it loses the rules and gains a header instead (`PageHeader`): where
it sits (course · week · kind), its title, where it came from and when, and the way out — *Quercus*, *Print*.
Notes keep the ruled sheet and no chrome at all.

**The professor's words are a card, not a whole page.** The previous attempt tinted the entire sheet, which was
not what was asked: the imported *text* now sits in its own bordered block with a `FROM QUERCUS` strip along the
top — an inbox card on the page — and anything typed afterwards is a new block outside it, on the page proper.
Amber for an announcement, blue for a Quercus page.

**Plan pages leave the tree.** `Plan.md` stays on disk — it is where a week's ticks live, and it still works in
Obsidian — but it no longer appears as a page in the page list. A bare checkbox with no context, no link and no
source read as noise, and "what to do before class" already has two better homes: the To do screen and the week.

**The course header is a bubble.** Same glass, same colour wash, same gradient as Today's course panels: the code,
the name, the term and week, what it is marked on, and every link out, in one object rather than loose text above
the page. The next-test countdown drops from 42px to 30px — a fact, not a billboard.

### 20.24 One week, one to-do, and a header that actually holds the header (2026-09-09)

**A week is one place.** There were two: the week screen, and the week's own `.md` opened in the editor, which drew
an index of the same six folders and showed less. Every route to a week page — the page list, a wikilink, a search
hit, a breadcrumb, a restored session — now lands on the week screen (`App.jsx` `weekOf`), and the screen absorbed
what the index had that it lacked: **Also in this week**, the pages filed in the week that are not one of the six
(a topic page, anything the sync could not place). `openPageRaw` is the deliberate way past it, offered once, quietly,
from the week screen itself. The primary button is **Write notes** — the ruled sheet is where writing happens; the
week's own file was never it.

**Every week, as cards, not a spreadsheet.** The term grid was thirteen rows by six columns with a click per cell.
A week is one page now, so the per-cell click was a second route to the same place, and a 13×6 table is the tree in
another costume. One card per week: its name, its dates, and what it holds. A week strip (1…13) rides at the top of
the week screen, so moving through a term never goes back up a level first.

**The bug behind "0 problem sets when there are three."** `/api/week` learned in §20.23 that a bucket is a page *and*
a folder; `/api/course` did not. `weekRow` dropped `problems` whenever `Problems.md` was missing, which is exactly
the shape `refile.mjs` leaves behind — so This week counted `—` and the Problems card said "No problems page for this
course yet" over three problem sets sitting in the folder. Buckets now carry their `items` everywhere, the Problems
card lists a week's filed documents under its row, and the term cards count them.

**One model for a thing to do.** To do, Today and the course screen each built their own rows and disagreed: a
checkpoint quiz that happens in a tutorial room offered *Open in Quercus* on the course screen while To do, from the
same task, said *Happens in the class*. `src/todo.js` builds a row once — what it is, how crucial, when it is wanted,
and what to do about it or why there is nothing — and all three draw it. A task that happens in the room has no
action at all; the course's Quercus page is offered only as a marked `fallback`, and says so.

**How crucial, as a word.** Four levels from two facts — whether it is marked, and how many days are left. `crucial`
(marked and within a week, or wanted within a day), `important`, `optional`, and nothing at all for the rest, because
a badge on every row is a badge on none. The course's to-do moved to the top of its screen, above This week: it is
what the course wants from you, and it was under a countdown.

**The header holds the header.** §20.23 wrote the glass bubble and left *Taught by*, *Meets*, *Textbook*, *Marked on*
and every link outside it, which is what the bubble was for. They are in it. The next-test countdown drops again,
to 24px, and the two lists it carried leave: later tests to *Everything else*, what to hand in to the to-do.

**A move takes the links with it.** `refile.mjs` moved pages and left `Hub/_hub.json` pointing at where they were, so
"New since the last check" on Today linked three problem sets to pages that no longer existed. The hub's records now
follow the files.

### 20.25 A Plan page is storage, not a place (2026-09-09)

§20.23 took Plan pages out of the page list and stopped there, so they were still one click away from six other
places — the next-class card on a course, *To do* on a week's class row, *The full list* on a class sheet, *This
week's list* under a task, two dead helpers in `PlanBits`, and ⌘K. Landing on one meant landing on the app's own
scratch file: a heading, an italic line saying it was rebuilt by the morning pass, and boxes with no context.

`Plan.md` stays on disk, unchanged. It is where a week's ticks live, it is what `toggleTask` writes through, and it
still works in Obsidian. What goes away is **arriving** at it:

- `App.jsx` treats `…/Week N/Plan.md` the way it treats a week page (§20.24): any route to it — a link, a wikilink,
  a search hit, a restored session — lands on the week screen, which draws the same list with the same boxes,
  tickable in place. One regex covers both.
- The week screen stops offering it: no *open* link on the To do card, not in the "nothing here yet" chips, and a
  class row's *To do* button scrolls to the list further down the page instead of opening the file.
- A course's next-class card opens the week the class is in; a class sheet's button says *Open the week*; a task's
  *where this came from* is the announcement that said it, or the week it belongs to.
- `server/search.js` stops indexing them. Every sentence on a Plan page was lifted from an announcement or a course
  outline, both of which are indexed, so indexing the plan too put the same task in the results twice — once on the
  page that said it, once on a file nobody opens.
- `PlanButton` and `TaskList` are deleted. Nothing imported them; both existed only to open the file.

### 20.26 It is a notebook again (2026-09-09)

slate grew outwards from the courses and forgot what it is for. Everything on screen was something Quercus had
posted or the morning pass had worked out; the one thing the student writes himself was a page called `Notes` that nothing
pointed at, sitting in a file tree that looked like a file tree.

**Take notes is an action, on every screen.** The sidebar carries it above everything else, Today carries it as its
primary button and once per course panel, the course screen carries it in the header, the week screen offers it as
*Take notes* or *Continue your notes*, and ⌘⇧N opens it from anywhere. The picker asks two questions and answers
both before it opens — the course you have next, the week you are in — so the common case is *Take notes*, Enter.

**A note lands in the week's own sheet, and the sheet is named.** `…/Week 1 (Sep 7)/Notes.md` is where every screen
already looks, so a note turns up on the week, on the course and in the Library without a new place to put things.
The importer writes an empty one into every week, which is scaffolding, not a note: it becomes a note the moment it
is opened *to write in*, and it is named then — `# ECO208 Week 1 note`, written into the file, shown in the title
bar in place of the filename, and used everywhere it is listed. Nothing is ever called Untitled, and a week you
never wrote in stays empty. A week that already holds a note says so in the picker and the button reads *Continue*,
because a second sheet for one week is how a notebook turns into a pile.

**My notes is a place.** Next to Today, To do and Library: one card per note, newest first, with the first lines of
it on the card, filterable by course. The Library holds what the student was *given*; this holds what he wrote.

**The week shows one thing at a time.** The six buckets became a strip across the top with their counts, and the one
you pick fills the width. The stack of six cards was a scroll of headings — you read the whole week to find the one
file you wanted, and nothing was ever big enough to look at. The classes moved above it as the week's spine, one
line each, and an empty bucket says what would fill it instead of sitting there as another heading.

**The course screen is four bands, not nine cards.** The content did not change — the student was right that it was the
presentation. *Right now*, *The term*, *How you stand*, *What has been posted*, each naming itself in the left
margin as you scroll past it, cards close together inside a band and bands far apart, headings in sentence case at
reading size rather than a ninth row of small caps.

**The page list stopped looking like a file tree.** A header that says where you are and how much is in it, rows
that are objects with a tinted icon when selected, one hairline down a nest instead of raw indent, counts as quiet
pills — the same furniture as the sidebar and the screens.

Two things this fixed on the way past: `Row as="div"` had no layout of its own and took it from `.list li`, so a
week's problems row stacked into four lines outside a list; and the Library's bar for a note ("enough words to be
worth opening") hid a note the moment it was started, before the first sentence was finished.

### 20.27 The page is one column, and the tree is gone (2026-09-09)

Two things §20.26 got wrong, both of them the same mistake: I changed the arrangement and left the shape alone.

**Bands in the margin made the page narrower.** Putting each band's name in a 132px left column pushed every card
into a narrow right-hand strip — the opposite of the ask, which was for the information to take *more* space and be
scrolled through. The band's name is a heading across the full width now, with a square of the course's colour
beside it and a line of its own saying what the band answers; everything under it gets the whole page. Nothing sits
two-up any more: This week and Next test each fill the width, the six tiles under This week are 120px minimum
rather than 84, the countdown goes back to 34px, and the way through the screen is to scroll.

Contrast, not just space: the cards under *Right now* are washed in the course's colour and carry a coloured edge
and a soft shadow; the reference bands underneath stay plain. The eye lands on the top of the page, which is where
what you have to do actually is. Card headings are 15px sentence case with 20px of padding, so a card reads as a
thing rather than a row of small caps. And the two buttons in the header had no gap at all between them —
`.cd-hero-actions` never had a `gap` rule.

**The page list is not a tree.** Chevrons, indent and a hairline down each nest were the last shape in the app that
belonged to a different one, and restyling the rows did not change that. It is a stack of cards: a page is its
kind's icon in a tinted tile, its name, and a line saying what it holds and when it was touched. A page with
children does not unfold — they are chips along the bottom of its card, each opening that page directly, so
`Lectures` is one click from here instead of two and the list never slides around under the pointer. The chip
holding the open page lights up, so the list still says where you are. A filter box across the top flattens the
section and cuts through it, which is what unfolding was really being used for.

The sidebar's courses wear their colour instead of standing next to it: the course number in a tinted tile, the
tile filling with the colour when that course is open.

### 20.28 The writing surface (2026-09-10)

Nine complaints about the one screen slate exists for, all of them fair.

**A click no longer opens a box.** A single click on the paper created an empty text box — so every click to dismiss
a menu, to stop drawing, or to put the cursor down left one behind. It takes a **double** click now, and in document
mode nothing does.

**Canvas or Document, per page.** The freeform surface — drag anything anywhere, write by hand, draw — is one of two
modes, not the only one. Document lays every block in one column at an 860px measure on a centred sheet with edges,
hides the ink tools, and pins nothing. The mode lives in the page's layout sidecar, so a page reads the same way
every time it is opened, and switching back is lossless: nothing on disk moves, the pinned coordinates are simply
ignored while it is a document. (A page of plain markdown had no sidecar to write the mode into; `writeLayout`
skipped writing one when there were no elements, so the switch looked right until the page was reopened.)

**The tool pill moves.** It sat centred over the top of the page, covering the first two lines of every note, with
no way to move it. It has a grip: drag it anywhere in the canvas, and where you put it is remembered; double-click
the grip to send it back. Its default is the top right, out of the reading column.

**Dictation.** A microphone in the pill. Every finished phrase is inserted at the cursor through the editor's own
transaction, so it undoes, autosaves, and lands on the ruled line exactly like typing; with no cursor anywhere the
first phrase opens a block at the end. It is the browser's recogniser (`webkitSpeechRecognition`) — online, Chromium
only — and the button says so rather than pretending, naming the actual fix for blocked, offline or unsupported.

**Everything fades while you type.** One attribute on the root, set on a keystroke and cleared the moment the mouse
moves; the sidebar, the page list, the top bar and the tools drop to 22% and come back on hover.

**Full screen.** The page and nothing else — no sidebar, no page list, the top bar only on hover. Esc leaves.

**Ask is a button that says Ask Claude**, not an unlabelled icon between two others. And a passage can be asked
about on its own: select text on the page and a small bar offers *Ask about this*; the rail opens with the passage
above the box as the subject, and the question goes as "about this passage … what you asked". Selection itself was
also fixed — the page is `user-select: none` except the text inside blocks, so a drag across two blocks cannot run
away and tint the whole screen.

**Save a copy, not print.** ⌘P and the toolbar used to open the browser's print dialog, which is a printer with a
Save button hidden in it. Three formats, all real files in `<Notebook>/_exports/` with Open and Reveal beside them:
PDF through the same hidden-Electron printer the section binders use (so ink, PDFs and images print as they look),
Word as an HTML `.doc` rendered by the page's own markdown renderer (Word, Pages and Google Docs all open it and
keep headings, lists, tables and links), and Markdown, which is the page itself. **Move this page to Trash** is in
the same menu, because deleting a note should not require finding it in a list first.

### 20.29 Dictation, on this machine (2026-09-10)

"Dictation needs a network connection — the recogniser runs online." The connection was fine. `network` is what
Chromium's `webkitSpeechRecognition` returns when it has no Google Speech API key, and Chromium builds that are not
Chrome — Electron, this app's own shell — ship without one. The Web Speech API can never work here, so the message
was true about the API and false about the student, which is the worst kind of error text.

slate already has a recogniser: `parakeet-mlx` on the M-series GPU, which turns an hour of lecture into words at
about twelve times real time. Dictation is the same model, fed one phrase at a time, and it never leaves the
machine.

**A worker holds the model.** The CLI loads it on every invocation — 3.2 s measured, nearly all of it load — which
is nothing across an hour of audio and useless for a phrase. `scripts/dictate-worker.py` loads it once and answers
paths on stdin; `POST /api/dictate` writes the clip to a temp file, hands over the path, and returns the text.
Measured through the route: **160–200 ms** per phrase once warm. The worker starts on the first clip, stops after
ten idle minutes, and takes one clip at a time so it never contends with the lecture transcriber.

**Phrases, not slices.** The microphone is cut at pauses rather than on a timer: a clip chopped mid-word transcribes
as a mangled one. A level meter closes the segment after 700 ms of quiet — provided something was said and the clip
is at least 900 ms — or at 14 s, whichever comes first. Silence is never sent.

**The meter runs on the audio thread.** It was written on `requestAnimationFrame`, which stops when the window
stops painting: switching app mid-lecture would have left dictation listening for ever without cutting a single
phrase. It is an `AudioWorklet` now, with a timer as the fallback where there is no worklet.

The button asks the machine whether it can hear *before* asking the student to speak, so a missing `parakeet-mlx` says so
with the one command that fixes it rather than after a sentence has gone into nothing.

### 20.30 Home, files by hand, and a PDF you could not scroll to (2026-09-10)

**The PDF bug was a class name.** `.canvas.doc` has meant "this page is a document rather than ruled notes" since
§20.23, and App.jsx puts it on every lecture, PDF, study sheet and announcement. Document mode (§20.28) reused the
name, so all of those got `display: flex; justify-content: center` — and flex-centring an item wider than its
scroller pushes the overflow off the *left*, where scrolling cannot reach it. A 966px PDF page inside an 808px
canvas sat 79px behind the sidebar with `scrollLeft` pinned at 0, and full screen did not help because the sheet
grew with the window. Document mode's class is `one-column` now and centres with `margin-inline: auto`, which
collapses to zero when there is no room. Measured before: canvas left 472, scaler left 393. After: both 472.
Selecting on a PDF is fine once the page is where it should be — the runaway selection was fixed in §20.28.

**Today is Home**, and the page is four bands in the order the questions are asked: what is next, in one sentence;
**My courses**; **This week**; **To do**.

**To do is a board.** It was four rows under the timetable — the smallest object on a page whose whole point is what
has to be done. One card per thing now, grouped by when it is wanted, each carrying how crucial it is, the course in
the course's own colour, the deadline, and the button that does it. It reads as three courses before it reads as a
list.

**Notes are manageable from My notes**: a ··· on every card — open, save a copy as PDF, Word or Markdown, or move it
to the trash.

**Ask about what you circled.** The clip tool already cropped a region off a PDF or an image. It now offers *Ask
about this* beside the clip, and `/api/ask` takes an `image`. Claude gets the picture **and** the page's whole
context: the system prompt is unchanged and the one Read tool is allowed for that question so the file can be
opened. (Verified with a one-turn probe that `claude -p --allowedTools Read` describes an image given its path.)

**Files by hand, into the right week.** Everything in the Library arrived through the sync; a handout from a friend,
a photo of the board, a recording made on a phone had nowhere to go. *Add files* takes a drop, asks which course,
week and category, and writes each file as a page in that week's folder with the file on it — the same shape the
sync writes, so the week, the course and the Library pick them up with no special case.

**Categories are not a fixed six.** The category field is free: typing a name that does not exist makes it, and the
week screen shows *any* folder it finds as a section of its own beside Notes, Lectures, Recordings, Study sheets,
Problems and To do. Loose pages that are not folders stay under "Also in this week".

### 20.31 A bubble, a smaller pill, and one choice after a clip (2026-09-10)

**Ask is a bubble over the page, not a column beside it.** Docked, it took 400 px off the width of whatever was
being read — and an image in the thread narrowed the document further, which is the exact opposite of what asking
about a picture is for. It floats now, bottom right by default, dragged by its head and sized by its corner, both
remembered. Measured: the canvas is 928 px wide with the rail closed and 928 px with it open.

**One region, two things it can become.** The clip tool used to place the picture and then offer to ask about it —
the choice arrived after the decision had been made. Drawing the rectangle now holds the picture in place and offers
both: *Put it on the page* keeps it as a picture to drag; *Ask Claude about it* sends it, with the page's whole
context, and leaves the page alone. Whichever is chosen, the file is written once, because Claude has to be able to
open it.

**The pill is half the size.** Eleven controls across the top of a document are eleven things in the way of reading
it. Six: move it, the mode (two icons, not two words), the tools, the microphone, and a chevron for undo, redo and
zoom — which are used a hundred times less and have keys anyway.

**Print is gone from the page header.** Save a copy in the top bar writes a real PDF, Word or Markdown file
(§20.28), so a second button that opened the print dialog was both redundant and stranded beside the source line.

**"Written" is a number.** The notes tile on a course said *Written* or *—*; every tile beside it says how many.
It counts the week's sheet plus any note pages filed with it.

**"From From Quercus."** The author of an imported page is found by looking for a name in its meta line, excluding
segments that *start* with "Quercus" — but the line begins "From Quercus · Topics · …", and "From Quercus" matches
`[A-Z][a-z]+ [A-Z]` without starting with Quercus. Nobody is called Quercus.

### 20.32 A pill behind the bar, problems as sets, and tasks of your own (2026-09-10)

**The pill was on every note — behind the top bar.** "The bubble works on lectures, not on notes." The tool pill's
position is saved once for every page (`slate.toolsAt`), relative to the page area. Under a document's header the
page area starts below the top bar; on a note, which keeps the bare ruled sheet, it starts *behind* the bar, which
floats over the sheet at z-index 50 against the pill's 40. The pill had been dragged to the top of a lecture —
`{"x":596,"y":8}`, read out of Slate.app's own storage — so on every note it sat at y=8: rendered, and invisible.
Reproduced on a clone of the notebooks: `elementFromPoint` at the pill's centre hit the top bar on the note and the
pill on the lecture. The drag clamped only to the page area and nothing clamped on render, so the same spot also hung
42px off the right edge of a 1480px window. The pill is clamped on every render, resize and change of its own size
now: inside the page area, and below the pane's top bar wherever the bar overlaps it.

**Overlays under the PDF.** "When I circle something in a PDF, Ask Claude and the rest go under it." The offer after
a clip was `z-index: 45`, and every element on the page is `1000+`. Raising it to 5000 was right, and it had never
reached the app: Slate.app serves `dist/`, built before the fix. Two more of the same shape: the eraser's ring was
950, under every PDF; and elements were stacked at `1000 + z·2` on a `z` that only grows — every drag and every
*bring to front* stores max+1 — so a page worked on for a term would climb past the ink layer (4500) and the clip
offer (5000). Elements are stacked by the *rank* of their `z` now: the same order, never above 3998.

**The empty page was a title passed as a path.** The week screen and the morning note handed a wikilink's title,
`ECO206_Problem_Set_1_Questions`, to `openPage`, which takes a path: the section became the title, no page was found,
and the pane said "Pick a section to start". Slate.app's storage held exactly that state. `openPage` resolves
anything that is not a `.md` path as a title, and a link to nothing says so in a dialog — it used to set the status
to "Save failed", which a screen does not even show.

**A Problems page is storage, not a place** (after §20.25). What the to-dos opened was the week's `## Problems` list
in the editor: thirteen `Problem Set 1 · Qn` rows, each with a second box under it, whose boxes did nothing until
you clicked into the block to write, and whose links led to the empty page above. The course screen's Problems tile
opened that page when the list had rows and the week screen when it did not — one tile, two behaviours. Every route to
`…/Week N/Problems.md` now lands on the week screen's Problems tab (the raw page stays one quiet link away, where the
chip's *Write the solution…* lives), and the tab is redrawn:

- **One card per set.** `ECO206_Problem_Set_1_Questions` and `…_Questions_and_Solutions` are *Problem Set 1 —
  questions + solutions*. `pairSets` (src/problems.js) matches by name, because the name is all two uploads share:
  the course prefix and the role words (questions, and solutions, answers, answer key) are stripped and what remains
  is the set. Different names stay different sets; nothing is guessed.
- **The questions are chips.** One click: tried. Again: checked against the solutions — the nested `reviewed` box.
  Again: clear. `withRowState` sets one row's two boxes and leaves every other byte alone; `toggleMdTask` could not,
  because every row's nested line is the same text.
- **Show solutions** puts the questions on the left and the solutions in the right pane. The document's own header
  carries the same button, and *Hide the solutions* while they are open.
- What no document claims — the topic page's own line, an announcement's `Ch 1 #3`, a WebAssign set — is a short list
  under the cards with the same one-click box. A guide is a card of its own beside the sets.

The Library shows a set as one row, *Problem Set 1 (questions + solutions)*, with *Solutions* on it; the course
screen's Problems tile and rows always open the tab.

**Filing reads where the professor put it.** §20.21 sent "Problem Solving Steps" to Lectures as a study-skills
handout, and "study habits" sat on the same trap list, which swept "Application 1: Study Habits" — a worksheet that
ends in questions — in with it. Both were posted under *Ungraded problem set and application*. The first is a guide
now (`bucketFor` → `guides`, filed in `Problems/`) and an application is problems. The classifier also reads a second
piece of evidence: the heading above the file's link on its Quercus page (`headingFor`), which the sync now records
for every file it finds in a page body and `refile.mjs` reads from the week's topic pages. It decides only when the
name does not: *Class slides* → lectures; *problem set*, *tutorial*, *application* → problems. On a clone of the
notebooks `refile.mjs` moves exactly those two pages, and nothing in ECO208 or ECO227.

**Tasks of your own.** `Hub/Today/My tasks.md`: one GFM task per line under `## My tasks`,
`- [ ] what · ECO206 · 2026-09-14`, the course and the date optional and read only from the end of the line. One
line adds one — on To do, on Home's board, on a course's to-do — and it ticks, opens (when its words name a link) and
deletes like any other row. It is plain markdown, so Obsidian and a Claude session can add to it too (contract v14).
To do gained *Overdue* and *Whenever*: nothing the plan builds is ever past or undated, but your own tasks can be.

### 20.33 Nothing writes on a container, a second note, the next class first, transcripts on paper (2026-09-10)

**Nothing writes on a container.** "Remove the list as a page and writing on the main pages — it doesn't serve any
purpose." Four doors led to a writing surface on a week's scaffolding — *the list as a page* on Problems, *open the
page* on every bucket, *Open the week's own page* under the week, *Open the page anyway* on an empty bucket — plus
*Write on this page too* on any page with subpages. All five are gone. `Lectures.md`, `Recordings.md` and
`Study sheets.md` now route to the week screen on their own tab, like the week page, `Plan.md` and `Problems.md`
already did; a page with subpages is an index with no editor. The Problems chip went with the Problems page. The one
exception is notes: a week's sheet stays a sheet you write on even when another note sits under it.

**A second note for the same week.** Once a week had a note, the picker offered *Continue* and nothing else, so a
tutorial and a lecture shared one sheet. *New note* — in the picker, in the week screen's header and on its Notes tab —
writes `Week N/Notes/ECO206 Week 1 note 2.md`: a page under the sheet, which the week, the course's notes count and My
notes already read as that week's notes. The picker lists the week's other notes under *Also this week*. A new note
shows on My notes the moment it exists; the Library's rule for a named note compared the heading with the file name,
and a note under `Notes/` is named exactly like its file.

**The course page asks three questions.** "Right now" said what had to be done and nothing about the rest. The
course's to-do is three groups: *Before the tutorial · in 4 days · Mon, Sep 14 · 17:00 · FE 230* (flagged
important), *Also to do*, and *When you have time — practice · optional · not urgent*. The first holds the next class's
tasks and, when that class is a tutorial, the week's tutorial questions ("try them before you come and bring your
work"). The last holds what the list used to leave out entirely, because a problem set nobody marks was not "to do":
ungraded problem sets with how many questions have been tried, applications, guides, anything marked optional
(`practiceRows` in src/todo.js, built from the week's sets; a set drops out once every question is checked against
the solutions). "Preparing for the next class should be important" holds on every screen, not just this one:
`rowsFor` finds each course's next class (`nextClasses`; a class that ended earlier today is no longer next) and
raises its normal tasks to important on Home's board, on To do and on the course alike.

**A recording prints as its transcript.** Saving a recording page as a PDF, or a binder that contains one, printed a
file card: a name and 91 MB. The transcript lives beside the audio (`<audio>.transcript.json`), not in the page text, so
nothing that exported the page could see it. The print view now prints a recording as every paragraph with the moment
it was said, and waits for the transcript before telling the printer the page is ready; *Word* gets a *Transcript*
section and *Markdown* gets it appended. The player's panel and all three exports read the transcript through one
helper (`fetchTranscript`, Elements.jsx), so a copy carries the words the page shows.

**A course added in term: CLA204.** the student enrolled in CLA204H1F, Introduction to Classical Mythology (Quercus 100005),
on 2026-09-10, the day after dropping POL106. Four things stood between a Quercus course and a slate notebook, and each
was fixed rather than worked around:

- The notebook shape was left by one-off migrations that refuse a second run. `scripts/add-course.mjs` writes the same
  scaffold for one course — `_slate.json`, General, a page per week with Notes, Lectures, Recordings and Study sheets —
  and never overwrites a file.
- `weeks('F')` stopped a Fall half course at Week 12, on a cutoff at Dec 1; CLA204 runs to Week 13 (Dec 7), like the
  Fall half of every Y course.
- The morning pass swept three hard-coded course ids. It sweeps every course in `terms.mjs` now.
- A synced page with no week in its title went to General even inside a module named "Week 1 (Sept. 8-11)", so the
  lecture pages landed among the admin. `pageWeek` (filing.mjs) files a lecture page under its module's week, and
  `fileWeek` files a reading linked from "Next Week's Reading" in the week it is for rather than the week it was posted.

The facts are the syllabus's: online and asynchronous, so no meetings; Midterm 1 (Oct 5) and Midterm 2 (Nov 16) at 25%
each, online and non-cumulative in a 24-hour window with a 1 h 50 min limit; a three-hour, in-person, cumulative final
at 40% in the Dec 10–22 exam period; participation 10%, marked on completion. The syllabus says participation is due on
Mondays and the Key Dates page says Sundays at 11:59 pm; the due dates Quercus attaches decide.

**A dedicated folder on the computer.** `scripts/mirror-course.mjs` copies a course's documents, Quercus pages and
announcements into `~/Desktop/<course>/`, laid out like the notebook, for courses marked `mirror: true` — CLA204 alone,
because the ECO folders were arranged by hand and are only ever added to. It copies under the names the files have in
the notebook's `.assets/`, which are the names the sync reads back when it walks the Desktop folder, so a mirrored file is
never filed twice; it skips any name already present anywhere in the folder, and it never moves or deletes. The
morning pass runs it right after the sync.

### 20.34 Clear and solid: contrast, one label, and a different shape for each kind of fact (2026-09-10)

"Make everything more simple and more understandable — more contrast, and vary the way the data is presented from one
tile to another." Two things made the app hard to read, and both were in the foundations rather than on any one screen.
The glass of §12 stacked three near-white surfaces on a mesh wash, and `--muted-2` (#c3c7d1, about 1.7:1 on white) was
used as *text* in some fifty rules — "NEXT CLASS", "COURSES", the page list's dates, the grade simulator's labels, the
hours of the timetable. And one card — a gradient tinted with the course colour, a tinted border, a lift on hover — was
copied ten times (Home's course panels and its board, To do, My notes, the Library, problem sets, the course header,
the lead band, the selected page, Take notes), so every screen read as the same grid of pastel tiles.

**Tokens.** A flat grey desk (`--canvas`), white cards with real edges (`--edge` .13, `--edge-2` .24), `--text` #0f1419,
`--muted` #4a5163 for secondary text (8:1) and `--muted-2` #6b7284 for the quietest text still meant to be read (4.7:1);
dark mirrors it. The glass tokens keep their names, so every rule that used them turned solid at once, and `--blur` is
`none`. A course colour set as text is mixed toward `--ink-mix` (black on light, white on dark), so green and orange
stay readable; a filled control mixes it toward black by `--btn-c` / `--btn-course`, so white type on it does too.
Buttons are solid, not gradients.

**One heading, one link, one tab control.** A card's heading is a heading — 15px in ink — not a 13px grey capital.
`.link` is reset once, globally: outside a card it had no rule, so "+ add a task", "all of it" and the week's course
and term drew as native OS buttons. A course tag that is a button lost the same native frame. The course filters on To
do and My notes are the segmented `.tabs` the course screen already used. The priority word is readable (11px, sentence
case), and a row no longer repeats its group's word: no *important* on every row of the next class, no *optional* on
every row of *When you have time*.

**A different shape for each kind of fact.**

- *Home.* Course panels with a solid edge along the top; the week as a timetable, today tinted and outlined instead of
  flooded blue; what to do as an agenda — the date as a calendar page on the left, that day's things beside it, things
  more than a week off under *Later*; what arrived grouped by course, a count line and the first three.
- *The course.* A header banded in the course colour with its facts in ink; the to-do as rows; the next class as a
  calendar date beside its line; what the week holds as one strip of numbers instead of five boxes; the next test as a
  countdown over a strip of weeks; practice sets and each week's problems with a progress bar instead of "0 of 12
  tried"; announcements as a dated feed.
- *The Library.* Each course's kinds as a short bar chart with their counts, instead of a heap of identical pills.
- *The week.* Documents as rows you read down, rather than small cards scattered across an empty panel; problem sets
  stay cards, because each is a thing you work through and tick.

**What the next class wants, on every screen.** The course page's first group (§20.33) is now on each course's panel on
Home as *Before it* — ticked in place, a done task struck through rather than vanishing — and first on To do as
*Before your next class*, on its own band.

**Smaller things.** The morning note no longer stretches to the height of the list beside it. The sidebar said "Lecture
today" for a lecture that had ended hours before: it compared dates and not times, and reads `nextMeetingOf` now.
"Sit" says *Test* and "Yours" says *Your task*. The Ask bubble's dark shadow followed the OS setting even with slate
forced light. Dead rules went with the rewrite: the old course cards and schedule grid, the board's cards, the
duplicated to-do rows in course.css.

### 20.35 The course page as a dashboard, and an online course's week as a list of work (2026-09-10)

"The course page is still very messy and hard to understand — present the data differently, like the Library. Be
smarter: in one course the readings were posted like an announcement and never reached the to-do list. And put
preparing for my next class on the course page itself."

**Why the readings never became tasks.** Every task slate generates hangs on a class. The grammar reads announcements
for dated lines and places each item on a meeting (`placeItems`), `tasksFor` writes a meeting's tasks, a Plan page's
groups are meetings, and the rows read `plan.meetings`. CLA204 is online and asynchronous — `meetings: []` — so it had
nothing to hang a task on. Its readings sat on Quercus pages that nothing read as tasks ("Week 1 Reading": *please read
Hesiod's Theogony from lines 1-453*; "Next Week's Reading": a numbered list), and its lectures were videos filed under
`Lectures/`, counted only as material.

**A week's own work.** A course with no classes now gets tasks that belong to a week (`weekWorkFor`, src/plan.js):

- the readings its week pages ask for — `readingsIn` takes the rest of a "please read …" sentence or the items under a
  "please read:" line, drops emphasis and links, reads "from lines 1-453" as "lines 1–453", and ignores "you can read
  the translation", which asks for nothing;
- the readings a rolling General page about next week lists, filed in the week after Quercus last updated it, linked to
  the filed document when one matches (*the Homeric Hymn to Apollo* → its PDF under Week 2 Lectures);
- the recorded lectures to watch: a lecture page whose body is a video link (`VIDEO_RE`);
- weekly work terms.mjs declares (`weekly`): CLA204's participation assignment, due Sunday 11:59 pm from Week 2 —
  the earlier of the syllabus's Monday and the Key Dates page's Sunday — and left out of any week where Quercus lists a
  participation deadline.

They are written to the week's Plan page under `### Week N · the week's work`, merged append-only like a class's group
and ticked in place. A task the group generated once is kept on later runs, because the rolling page moves on to the
following week without withdrawing last week's readings; they never turn "no longer listed". A course with no
notebook folder gets no page. `plan.weeks` carries them and `weekRow` (src/todo.js) makes them rows, due at the end of
their week or on their own date, the current week's raised to important like the next class's. They are the first card
on the course page ("This week's work"), the panel line on Home, and on To do they stand with "Before your next class".

**The course page is a dashboard.** It was one column of big cards — a header of facts, then bands of lists — that all
looked alike and asked to be scrolled rather than read. Now:

- *The head* is one line — code, name, term and week, professor — over the term as a row of thirteen week cells
  (`Track`, src/components/Viz.jsx): each cell's fill says what the week holds (a study sheet, material, nothing filed,
  still ahead), the current week is ringed, a flag marks a week with a test (T1, MT2), and a cell opens its week. It
  replaced "Every week", a grid of thirteen cards.
- *The left column is what to do.* "Prepare for your next class" comes first and biggest: the date as a calendar page,
  the class, room, time and topic, a ring of how much of its list is done (`Ring`), and the checklist. For a course with
  no classes the same card is "This week's work". Then "Also on your list" as rows with the date on the left, what the
  week holds as a grid of counts, practice sets each with a meter of questions tried and checked (`Meter`), and the
  announcements as a dated feed.
- *The right column is where you are.* The next test as a countdown over the weeks it covers and how ready you are;
  "Coming up" as a timeline of every dated thing ahead (`Timeline`) — tests, hand-ins, marked work outside the tests
  (ECO208's writing assignments were shown nowhere), reading week; "Your mark" as one stacked bar of what the mark is made
  of, each part filled as far as it has been marked (`Stack`), with the calculator one button away in a sheet; and
  "About this course" — the facts the old header led with, read once a term.
- Everything rarer — every problem set with its score fields, study sheets, links and admin, the later tests — is
  under Everything else.

### 20.36 Transcribe from wherever a recording shows (2026-09-10)

"When you upload an audio, click transcribe, so you can do it from the computer already." Recordings were transcribed
on this computer already (Parakeet on the GPU, SPEC 18.3), but the Transcribe button lived only under the player on the
recording's own page, and the server refused a second request while one ran — filing three recordings meant opening
three pages and coming back twice. Now:

- **A queue.** `POST /api/transcribe` adds the page to a queue instead of refusing it; one recording runs at a time and
  the next starts when it ends. The answer says how many run ahead; `GET /api/transcribe/status` names the page running,
  the pages waiting, and how the last run of each page ended (`done`), so every screen that asked can tell its own
  result from someone else's. "Nothing to transcribe" counts as a success: the recording already has its words.
- **One way to ask** (`useTranscribe`, src/transcribe.js): start, poll every 2.5 s until the page has left the queue, then
  pick the transcript up; a page opened again mid-run picks its job back up.
- **Everywhere a recording is.** Add files offers *Transcribe the recordings once filed*, ticked by default, and queues
  them in order (a sheet of only recordings files them under Recordings); the week's documents and the Library carry a
  Transcribe button on any recording without a transcript, with "Waiting — 1 recording ahead" or "Transcribing…" in its
  place while it runs; the player's own button uses the same queue. The screens reload on the transcript's file event.
- **A week counted no recordings.** `/api/week` counted elements of type `audio` or `video`, but the canvas stores a
  recording as `media`, so every recording in a week read "empty page" and no button could be offered; it counts
  `media` now.

### 20.37 Claude is the brain (2026-09-11)

"I want Claude to make every decision on what goes where — Claude is the brain, and the only one." The morning had it the
other way round. `sync-prompt.md` told Claude to file with `bucketFor` "never by hand" and never to resolve a sentence the
grammar could not place, so Claude ran scripts and wrote a note while rules decided — and the fixes of §20.21, §20.33 and
§20.35 were each a rule missing a case: a worksheet filed as a lecture by its name, CLA204's lecture pages in General because
their titles carried no week, its readings never tasks because a task needed a class.

**One switch.** `Hub/_settings.json` → `brain: true`. Off, nothing changes: every suite that existed passes unchanged. On:

- **The fetch only downloads.** `quercus-sync.mjs` writes a new file, a new Quercus page and a Desktop course-folder file as a
  page under `Hub/Inbox/<course>/`, writes an announcement where announcements live without linking a week (a file it carries
  waits in the inbox and is named on it, `Attached: [[…]]`), and lists each in `Hub/_inbox.json` with every Quercus page that
  changed. A changed page is rewritten where it lives now — the sync record follows moves — and one moved without a record
  waits again rather than coming back where a rule once put it. Two bugs went with it: a failed download was recorded as
  known before the bytes arrived and never retried, and a changed page went back to its rule-given place whatever had moved
  it. The inbox is read again before it is written, so a decision made while the fetch ran is kept.
- **The plan reads Claude.** `buildPlan` skips the announcement grammar, the outline's readings and WebAssign sets, the
  review-last-week tasks and the weekly work of `terms.mjs`. A class's tasks and a week's work are Claude's (`claudeTasks`,
  from `Hub/_brain.json`), written through the same append-only merge, so a tick is kept and a withdrawn task is marked
  "no longer listed" only while unticked. Every course has the week group now, not only one without classes. Claude's word
  on a class — cancelled, or its topic — lands on the meeting. `problems.mjs` generates no rows; Claude adds them with `--add`.
- **Rows carry Claude's word.** `prepRow` and `weekRow` take Claude's level as the priority — nothing raises it, Claude
  already weighed the next class — its link as the button, its reason on the row, and its source.

**Claude's hands: `scripts/brain.mjs`** — `place`, `ignore`, `reviewed`, `link`, `task add | edit | withdraw`, `tasks`,
`class`, `ask`, `answered`, `run start | done`, `log`, `undo`, `settings`. Each checks its input and changes nothing when a
check fails; each change is a decision in `Hub/_brain.json` with its reason, its run and what undoing it needs. A task is one
line of plain words before one class or in one week (or, by its due date, in the week the date falls in), with a level,
kind, due, link, source and reason. The same words twice in one week are refused, because `flipTask` flips the first match
on a page; a ticked task's words and place cannot change. Only a page waiting in the inbox can be ignored; announcements and
study sheets never move; an announcement is `reviewed` once read.

`scripts/lib/move.mjs` is the one move: all four parts or none, every destination checked before the first rename and the
renames put back on a failure (refile.mjs checked one part at a time and could half-move a page), both orders, the kind, the
hub row and the sync record following, and a page touched in the last ten seconds refused because it is probably open in the
editor. An undo puts every byte back. refile.mjs uses it.

**The morning.** `scripts/brain-prompt.md`: start a run; fetch; read every waiting thing in full with its course around it;
place; read and link announcements; decide the tasks and their levels for the next fourteen days; list the questions of new
problem sets; ask what is the student's to answer; write it through; calendar and email as before; a note with a `Decided:` line; end
the run. It is heavy on purpose — subagents may read, only the main pass writes. `sync-prompt.md` sends a run there when the
switch is on, and the Sync button reads it directly, with four hundred turns and `Agent` allowed. On the first run Claude
adopts the old rules' tasks it agrees with by writing the same words, so they keep their lines and their ticks.

**Home.** `GET /api/brain` (read-only) and a card beside the morning note: the last run's decisions with their reasons, the
questions, what still waits. **Contract v15**: `Notebooks/CLAUDE.md` gains "When Claude is the brain" — decide only through
`brain.mjs`, never by moving or writing pages, never with the classifier or the grammar.

`npm test`: the new `brain` suite runs every command against a throwaway root.

### 20.38 Two classes in a week, notes from elsewhere, the way back, and a link that is the thing (2026-09-13)

**A week is a lecture and a tutorial.** "They have different audios, different files, different problems, and some stuff is
for both." A document now says which: frontmatter `for: "lecture" | "tutorial" | "both"`, read by `server/fs.js`, carried by
`/api/week`, and grouped on the week screen — *For the lecture*, *For the tutorial*, *For the week*, and *Not said which
class* for what nobody has said yet, shown as itself rather than guessed at. Problem sets group the same way, by the part of
the documents in the set. Claude says which when it files something (`brain.mjs place … --for tutorial`) and can say it about
a page already filed (`brain.mjs part "<page>" --for lecture --reason "…"`); the answer only means something inside a week, so
General refuses it. The headings appear only when a bucket holds more than one kind, so a week with everything in one class
reads exactly as it did.

**Notes from elsewhere.** Add files brings in documents; a note written in Obsidian, exported from another app or handed over
by someone else had no way in. *Import notes* on My notes takes `.md` or `.txt`, asks for the course and the week, and writes
each one as a page under that week's `Notes/` — the text **as the page**, not a file attached to one — so it is searchable,
tickable and editable like anything written here. A name already taken in that week gets the next one along.

**The way back.** Every screen, section and page opened is a step; Back and Forward walk them (⌘[ and ⌘]), in both top bars.
Sixty steps, in memory, never persisted: it is the way back, not a log. A jump the buttons themselves make is not pushed again.

**A link is the thing itself.** "One of the assignments says do the WebAssign questions. When I say open, it opens another
page with just a checkbox. That is useless." `resolve.js` guessed three things: a week's `Problems` page for any task with the
word *problems* in it, the course's Quercus page for anything marked, and `Lectures.md` for anything about slides — three
buttons that promised the thing and opened a list. All three are gone. A task opens what it names: the link Claude gave it (an
assignment's own Quercus URL from `Hub/_hub.json` → `deadlines[].url`, a tool's URL from the course's Links page, a page's
path), a wikilink, a tool the Links page knows, the syllabus, or the announcement it came from — and when there is nothing to
open it says so instead. `quercus-sync.mjs` puts the WebAssign link from the course's modules onto the syllabus-made deadline
rows, so that row opens WebAssign itself.

**The week is read by class.** Grouping documents inside a bucket was not the difference asked for. The week screen carries a
row of its classes — *Everything · Lecture · Tutorial*, from the course's timetable (`/api/week` → `classes`, because a week
that has already happened has no meetings left in the plan) — and picking one shows that class's material in every bucket, with
what serves the whole week beside it and a line offering the ones nobody has assigned yet. In *Everything* the buckets still
group under their headings.

**A page anywhere in the week.** Every bucket's panel has *new page*, and the tab strip ends with *Category* for a kind of
thing the week does not have yet (Readings, Labs). A page made while the week is showing one class belongs to that class —
you are looking at the tutorial, so what you add is the tutorial's — and its `kind` follows the folder it lands in.

**Somewhere to actually do the problems.** A set's card has *Work on it*: `<set> — my work` under the week's `Problems`,
made the first time and opened beside the questions from then on, with the questions named on it. The questions stay a
document; the work is the student's page.

**A row says where the work is.** A task with nothing to open used to say "nothing to open". When the words name the course's
textbook, or name chapters, exercises or problems, the row says *In your textbook — WMS* (`textbookName` in `src/plan.js`).

**The review is a list you can work through.** Its *Next week* section wrote one paragraph per class ("Tue Tutorial · prepare:
…"): nothing to tick. Each thing to prepare is now its own `- [ ]` line under its class, seeded from the Plan page's state, and
a box ticked on the review survives the page being computed again. A task marked "no longer listed" is not listed at all.

**The morning.** `brain-prompt.md` and the 07:00 task say it in order: no subagents, one pass reads everything; every document
placed in a week says which class it is for; every task done on Quercus carries that assignment's own link, and work done in a
textbook says so in its own words. Contract v16.

### 20.39 Three tabs, a shelf per category, and a button on everything a row mentions (2026-09-13)

the student, three times in one evening: *"it's not very easily navigable and understandable"*, then *"everything is super
confusing, it should be way simpler, less info at the same time"*, then what he actually wanted — *"it should basically
be like a book where you can access pages, create new ones, remove ones, and it's just a way to be able to access them
week by week."*

**The week screen has one job:** hold the week's pages so you can get at them. It had been a stack of cards, then six
buckets as tabs with one open at a time, then a class filter above that strip, then — briefly — a scrolling page of
class sections carrying what to do and what was not filed yet. Each version added a way to *arrange* the week and
pushed the week itself further down.

**Three tabs, then a shelf per category.** The tabs are the lecture, the tutorial, and all of it. Under the one you
pick stand the week's categories, always the same five in always the same order — **Lectures, Notes, Recordings,
Problems, Study sheets** — then any category of your own, then the pages loose in the week. The five are there whether
or not they hold anything: an empty Recordings shelf says the week has no recording yet, which is worth knowing, and it
means the shelf you reach for is in the same place in every week of every course. Each is a **shelf**: a box with its name, its count and
its own *New page* on the head, and nothing inside but the pages it holds. Click a page to open it; × on a row sends it
to the trash (`/api/trash`, so it can be put back). Where one category ends and the next begins is a border, not a
guess. A class's tab is its material plus whatever serves the week (`for: both`); *All* is every page the week holds,
the ones nobody has assigned to a class included, each tagged with whose it is. A week with two lectures is one Lecture
tab with both days named under it, because `for` says "the tutorial", never "Tuesday's tutorial". A shelf's count is
always what is drawn inside it.

**Notes is a shelf like the rest.** The week's own sheet used to have its text quoted onto the screen as you scrolled
past. It is a page now: it stands on the Notes shelf under its own name, *New page* there starts another note beside
it, and the sheet is the one page a week never loses.

**What there is to do is not on this screen.** It is on Home, on To do and on the course screen, built once by
`src/todo.js`; a fourth copy of it on the screen you open in order to *read* the week was noise, and quoting the Plan
page's `## Before class` containers — the scaffolding a tick is stored in — was the worst of it. `/api/week` builds no
task rows at all.

**Problems is the one thing you do here, so it is plain.** One card per set: the card opens the questions, and the
questions are chips you tick as you work — once when you have tried one, again once you have checked it. *Work on it*,
which made a `— my work` page of your own first, is gone: the questions are already here, and that is what you work on.
The solutions stay one button away. A row on the week's Problems page that no document claims shows on *All* only,
since it belongs to the week rather than to either class.

Two attempts at *somewhere to work* were built and then taken back out, which is the record worth keeping: first a
**Work on it** button that made a `<set> — my work` page beside the questions, then a **Work them out** button on the
loose rows that asked which questions the student was about to do and either paired him with the teacher's page or seeded a
blank one. Both were the app deciding where his writing should go. The shelf's own *New page* already does the whole
job — he makes the page he wants, on the shelf he wants, and opens it next to whatever he is working from — so that is
all there is, and the assigned questions are a list of checkboxes and nothing more.

**One button, everywhere a row names something.** `resolve.js` stopped at an exact wikilink, so most rows on To do and
Home had no button. Two rules were added, both deliberately hard to satisfy, because a button that opens the wrong
thing is worse than none:
- **the assignment itself** — a task is matched by name against `Hub/_hub.json` → `deadlines[]` and takes that row's own
  Quercus URL, never the course's front page;
- **the document it is talking about** — matched against the page titles of its week, then its course. A name counts as
  said when the words contain it in full, or when two thirds of its distinctive words are there; every number in the
  name must be said, so *Problem Set 1* never opens *Problem Set 2*, and the six container names (Problems, Plan,
  Notes, …) never match at all.

16 of 20 live rows now have one. The four that do not are two textbook chapters — which say *In your textbook — WMS* —
and two participation assignments Quercus gave no URL for.

**Filing follows the same rule.** ECO206 had Problem Set 2 and Application W2 sitting in Week 1, because that is the
module they were posted in. A document belongs to the week it is *for*: they were moved into Week 2, where the week's
own Problems rows then attached to them, turning thirteen loose checkboxes into one card you can work through.

**The morning.** `brain-prompt.md` and the 07:00 task say it plainly: `for` is where a document lives, not a label, and
one left unsaid shows only on *All* — missing from the tab the student opens to get ready for that class; everything in a week
is a thing that week is *for*; a task sits under the class it is for; a task without a link is the exception (a paper
textbook, his own revision), not the rule. Contract v17.

### 20.40 A page you can type on (2026-09-14)

the student: *"when I click on the… option there, it goes either like infinity or you can make it as like an A4 rectangle page
— then when I double click it doesn't start typing."*

The note editor has two modes (SPEC §20.28): the freeform canvas, where a double-click opens a box wherever you point,
and *Document* — one column, wide measure, a sheet with edges. `onCanvasClick` in `Canvas.jsx` bailed out on `doc`
outright, on the theory that in a column you never need to click for a box: ⏎ at the end of a block makes the next one.

That holds only while there is a block to be at the end of. A sheet just switched to Document, a note whose writing
stops above where you clicked, an empty page — all of them swallowed the double-click and left you with nowhere to
type, and no hint that ⏎ was the gesture you were supposed to know.

A double-click on the page in Document mode now carries on where the writing left off: the column's last box if it is
still empty (so clicking twice never stacks empty boxes), otherwise a new one appended under it, focused. It never
pins a box where the pointer happened to be — that is what the canvas is for, and the two modes still round-trip
without moving a byte on disk.

### 20.41 Two editions, one codebase (2026-09-14)

slate is going to the student's fraternity brothers, and the copy they install is not quite the one he runs: no *Ask Claude*
(it spends a Claude allowance they need for the morning pass), no study sheets, its own name and its own colour.

The wrong way to do that is a second branch. Every fix would then have to be made twice, and the one that was
forgotten would be the one a stranger hit. So there is **one codebase and one test suite**, and a single switch:
`src/edition.js`. It names each edition and what it has — `full` (everything, the default) and `adphi`
(*Slate for Alpha Delta Phi*: no Ask, no sheets, emerald). `scripts/make-kit.mjs` rewrites `DEFAULT_EDITION` when it
packages the kit, so the client knows at first paint and a feature that is off is never drawn and then taken away.
The server reads `Hub/_settings.json` → `"edition"` on top of that, which lets an install be flipped without a build.

What an edition actually changes:
- **Ask** — the route is never registered (`server/index.js` filters `ROUTES`), so `/api/ask/*` is a 404 rather than a
  hidden button; ⌘J, the toolbar button, the passage bar, the clip bar and the Problems chip's *Write the solution* all
  go with it.
- **Study sheets** — the shelf, the term-grid column, the library filter, the course card and Home's queue nudge are
  not drawn, and `WEEK_PAGES` stops scaffolding the folder, so a new week does not carry an empty one for ever. The
  `sheets` bucket stays in the server's `BUCKETS`: a week that already has the folder keeps it, and the on-disk format
  is the same in both editions. The build pipeline is still in the repo; nothing in the kit ever runs it.
- **The name and the colour** — the window title, the sidebar wordmark, and `--accent` / `--accent-2` painted over the
  tokens in both themes, so everything that already reads the accent follows without a second stylesheet.

Alpha Delta Phi's colours are emerald green and white; their brand standards publish no hex values, so the emerald
(`#046a38`, `#3fbf87` on the dark theme) is chosen to stay legible as UI, with their gold as the second accent. No
crest and no letters beyond ΑΔΦ as a wordmark: their marks are licensed, and this is a private tool for the chapter.

The `full` edition is byte-for-byte what it was — all 14 suites pass unchanged.

### 20.44 One place that knows where the notes are (2026-09-14)

The dry run reached step 9 — *build the notebooks* — and reported that they already existed while the folder stood
empty. The cause was worth the whole exercise.

`slate.config.json` was added in §20.42 so an install could say where its notes went. It was read by `server/fs.js`
and by nothing else. **Eighteen scripts each resolved the notes root independently**, every one of them with
`~/Desktop/Claude OS/Notebooks` written in as the fallback — the student's own path. On his machine that is right by
accident, so nothing looked wrong. On a brother's Mac the app would read the configured root while `add-course.mjs`,
`quercus-sync.mjs` and `brain.mjs` — steps 9 and every pass after it — built and filed everything somewhere else.
They would have opened the app to a term's worth of empty weeks, with the real folders sitting in a directory that
does not exist on their computer.

`scripts/lib/root.mjs` is now the only thing that knows: `--root`, then `SLATE_ROOT`, then `slate.config.json`, then
the old default, with `~` expanded because a config written by hand or by Claude will contain one. Every script and
`server/fs.js` call it. The smoke suite fails if any file but that one names the default path again, so the eighteen
copies cannot quietly come back.

**And the kit now refuses to build from a dirty tree.** Building from `git ls-files` is what keeps a kit honest — only
committed work ships — but it is also the one way it can ship a broken app: a file written and never added is simply
absent, and shows up on someone else's Mac as a module that cannot be found. That happened twice in one afternoon,
first with the Quercus skill and then with this very helper. An untracked file now stops the build and names itself.

### 20.47 A window onto someone else's slate (2026-09-14)

the student opened the ΑΔΦ app and it was his own slate: his notebook, his name, Ask Claude still on the bar. Nothing about
the edition had failed. The app had simply never started.

`desktop/main.cjs` hard-coded port 5177, imported the server, waited for *anything* to answer `/api/health` on it, and
loaded that. His own `Slate.app` was already there. The second app's server could not bind, the health check was
answered by the first one, and the window opened onto it. Two installs on one Mac could never coexist, and the failure
looked exactly like success — the worst shape a bug can take, because a dry run that hits it concludes the edition
does not work.

Three changes. Each edition names its own port (`full` 5177, `adphi` 5178), baked into the bundle by `build-app.mjs`
beside the repo path. The launcher takes the first free port from there rather than insisting on one, so a second copy
opens beside the first instead of onto it. And `/api/health` now says which `repo` answered, which the launcher checks
against its own: a server that is not ours — including one too old to say — is refused with the path it is serving,
rather than trusted because it replied.

**And a rename left the page's own name behind.** `brain.mjs place --title` renames `Title.md`, `Title.blocks.json`
and `Title.assets/` together, but every element's `src` inside the layout begins `<Title>.assets/…`, and the heading
says `# Title`. Both kept pointing at a name nothing was called any more, so a lecture's audio vanished and the page
looked perfectly normal until something tried to play it. `movePage` now carries them across — the `src` prefix on
every element, and the `# ` heading when it still says what the page used to be called, so one the student rewrote stays his
— and rolls the renames back if that fails. The undo path restored the broken page cleanly, which is the only reason
nothing was lost.

## 20.50 The week that holds the class says what the class covers

ECO206's tutorial meets on the Monday and works through the *previous* week's lecture — `tutorialLag: 1` on the
course. The week page is built from one folder, so Week 2 showed a tutorial whose topic line read *Constrained
Optimization* and not one of the pages that phrase refers to: the topic page, Tutorial 1 and Problem Set 1 are all
filed in Week 1, where the lecture that produced them is. Meanwhile the to-do for that same Monday — *Try Tutorial 1
questions 1 and 2* — opened Week 1. The same course, the same Monday, two screens that did not agree, and the one
the student called the main view was the one missing the work.

The files do not move. Week 1's lecture is where they came from, and a past week that empties itself as the term goes
on is worse than the problem. Instead the week that *holds the class* carries a shelf of what that class works
through: `covers` on `/api/week`, one entry per class whose `syllabusWeekN` is not this week's, holding that week's
documents filed `for` it, paired into sets with their tick rows attached, plus the page the class's topic names —
that one is usually `for: both`, being the lecture's as well, so it is found by the topic rather than by the tag.
It draws as a shelf like any other, the course colour down its edge, its head saying **from Week 1** and opening
there. Ticking a question on it writes to the page's own week. There is no remove button: they are not this week's to
throw away. They count towards the tab's number, because a heading that disagrees with its list is the thing the week
screen was rebuilt to remove (§20.39).

**The first version read the meetings from `Hub/_plan.json`, and the test caught it.** The plan holds the near
future, so a week that has already happened has no meetings left in it — the shelf would have been correct all the
way up to the current week and then quietly absent from every week behind it, which is the same material missing
from the same page for a second reason. `src/calendar.js` is the one place a meeting is expanded (§20.1), and that is
what decides the shelf now; the plan is still read on top of it for an announced topic or a cancellation.

## 20.51 Recognition runs itself

the student asked Ask about a page he had been writing on and was told *"I still see one ink element on this page, and it
arrives as stroke data only"*, with a guess that it might not be text at all. The guess was wrong, and the mechanism
was the whole story: recognition only ever ran **when asked** — the ink menu, the toolbar button, or the batch in the
every-three-days pass. So the words on a page existed only if someone had thought to ask for them, and anything
written since the last pass was invisible to the one thing that reads pages.

The page in question held **950 pen strokes, 40,470 points**, written that afternoon. Forced through the recogniser
it came back in **841 ms** as thirty-four lines of constrained-optimisation work. It had simply never been read.

So it reads itself now, in three places, each covering a way of working:

- **Four seconds after the pen stops**, on the page you are writing on. Unchanged ink is skipped by its hash, so a
  pass over a page you have not touched costs one request and no recognition at all. It is quiet: no ink card opens
  under the pen, and a failure does not put an error in front of someone mid-sentence — it turns the idle pass off
  for that page instead of retrying every few seconds, and the menu item still runs and still says why.
- **Before an Ask question is sent**, because writing and asking in the same breath leaves no idle gap. A failure
  there never blocks the question.
- **On leaving the page**, when a pass was pending — writing and then closing is the ordinary way to leave a lecture,
  and it must not be the one case where the words are never read. The server does that one, after the layout save it
  waits for, so there is no component left to update.

**What this is not.** Two theories were wrong on the way, and the checks are worth keeping. That the hash was caching
a *failure* as a negative result: it is not — the runner throws before anything is written, and the elements that
come back empty are highlighter strokes and single ticks, where empty is the honest answer. And that the batch was
skipping new ink because `isStale` means *"read once, changed since"* and answers false for ink never read: it is
not, `hwr.mjs` compares the hashes directly. But nothing tested that distinction, and a selector written the obvious
way would skip every new page for ever, so `test-hwr.mjs` now asserts both halves: that such ink is not stale, and
that the batch picks it up regardless.

## 20.52 The week says its module, and a hand-in is one row (2026-09-16)

"For the new courses I just enrolled in, week one has absolutely nothing, whereas on Quercus module one has a lot of
things — everything has been put in week two. Do a global review: everything in the right place, every to-do accurate,
every row taking me to the right link."

**Module 1 is Week 2, and Quercus is the one saying so.** FCS298's modules are named by the calendar week: *BEGIN HERE:
COURSE ORIENTATION - Week 1 (September 8-11)* and *Week 2 (September 14-18) - Module 1*, and the syllabus schedule has the
same two rows — *Course Orientation, week of Sept. 7* and *Module 1, week of Sept. 14*. The brain filed Module 1 in Week 2
because that is the week it is for (§20.37, step 4). The orientation module holds six things: a welcome video, which is a
link and sits on the course's Links page, and five files, four of them byte-for-byte duplicates of the syllabus, course
guide, forum guidelines and instructor contact that also sit under their own modules, and the netiquette guidelines — all
course-wide, so all in General. Week 1 is empty because the course put nothing in it that belongs to a week. The placement
stands. What was wrong is that nothing in slate said any of this: a week page called *Week 2 · Sep 14 – Sep 20* over a
shelf of *Module 1* files reads as a filing mistake, and the only way to find out was to open Quercus.

So every week row now carries the outline's name for it. `scripts/lib/syllabus.mjs` has an FCS298 entry — one topic per
term week, *Course orientation*, *Module 1 · Introduction to Autobiographical Comics*, …, *Course conclusion*, with the
assessment that falls in the week — and `weekRow` (routes/course.js) puts `topic` on the row it already builds for the
course screen, the term grid and the week screen. The week screen draws it as one line under the title; the term card
under its dates. CLA204's entry, written for §20.35, shows the same way. The course page's *This week's work* heading
was already reading it.

**The app the student was looking at was two days old.** `dist/` was built on Sep 14 at 17:59; FCS298 was added to `terms.mjs`
on Sep 16 at 17:28, and the app had imported the server at 17:21. The client bundle held no `FCS 298H1` at all — the
course's colour, its weeks, its textbook and its grading came from a `COURSES` that did not know it — and the server was
running an entry whose midterm still wore the wrong key. Nothing in the code fixes that; a rebuild and a relaunch do
(the memory that a reported bug may be a stale build was right again). The check is one line: `grep -c 'FCS 298H1'
dist/assets/*.js`.

**One hand-in, two rows, on two days.** The To do list carried *Participation assignment · due Mon Sep 21 at 23:59* and,
under it, *Week 2 Participation Quiz · due Tue Sep 22*, one *important* and the other *crucial*, both opening the same
Quercus assignment. Two causes. `dueRow` (src/todo.js) sliced the first ten characters off the hub's stamp,
`2026-09-22T03:59:59Z` — the UTC date of a Monday 23:59 in Toronto — where `buildPlan` had read the same stamp through
`localParts` all along; the raw hub rows the screens hand `rowsFor` never went through the plan. And with Claude as the
brain every Quercus hand-in is a task of his, carrying the assignment's own URL (§20.38), *and* still a deadline row from
`Hub/_hub.json`. The rule now: a deadline whose course, URL and Toronto day match a task Claude made is not a second row —
the task is the row, tickable, at his level and with his reason, and it is lent the points the Quercus row knows. A
deadline no task covers is still shown, so nothing disappears. *Coming up* on the course page reads the stamp the same
way. ECO227's *WebAssign Fall-Ex1* was the same pair, with the syllabus row still saying *date unconfirmed* under a task
the Sep 15 announcement had confirmed.

**A Plan line follows Claude's word.** This afternoon's run moved CLA204's *Next Week's Reading* into Week 2 as *Week 2
Reading*. The Week 2 Plan page kept its line *Read the rest of Hesiod's Theogony → [[Next Week's Reading]]*, a wikilink
to nothing, and *Participation assignment — due Sun Sep 20, 11:59 pm*, a date Quercus had corrected to Monday. §20.37
says the words before the arrow are the task's key "so a link can change without the line losing its tick" — but
`mergeContainer` never rewrote the arrow; append-only meant the line stayed as first written. Now a line Claude generated
whose text differs from Claude's current line is rewritten to it, tick and key kept; a line the rules wrote, or one of
the student's, is left exactly as it is. And a move follows Claude's own records: `followTasks` (scripts/lib/brain.mjs)
rewrites every task's `link` and `source` that named the moved page or anything under it, is recorded in the decision's
undo, and `restoreTasks` puts the paths back — *Where Claude read it* on the Lecture 4 task had been opening the old
General path.

**Two things put right in the notes, one left for the student.** CLA204's Week 1 reading page was written as `Reading.md` on
Sep 10 while the sync's memory has always called it *Week 1 Reading*, so a change to it on Quercus would not have found
the file; it is retitled to match its siblings. FCS298's Module 1 learning check, filed under Problems with its answer
key, had no rows, so the week's Problems shelf and the course page's practice meter had nothing to count; its twelve
questions are rows now. CLA204's *Course Info + Resources* in General is superseded on Quercus by *Course Info + Office
Hours* (filed today) and still gives the office hours the Sep 15 announcement moved — a course page the brain does not
delete; it is the student's to trash.

Tests: the merge follows a Claude line and leaves a rules line (test-plan); a hand-in on its Toronto day, and one row
when Claude has the task (test-plan); a move follows every task's link and source and undo restores them (test-brain).

**Found by the audit that followed (same evening).** Reconciling every item the Quercus API exposes against the notebooks
(the script and its report are in `~/Desktop/Claude OS/Slate audit/`) turned up two more things. Five ECO206 Week 1 file
records in `Hub/_sync-state.json` still named `Lectures`, the folder `refile.mjs` had moved the problem sets out of before
the sync's memory learned to follow a move (§20.37): harmless until the day one of those files changed on Quercus, when
the sync would not have found the page — repaired in place. And a textbook task written for Week 3, *Read Perloff 3.4,
4.1, 5.4 and 2.5*, was given a button to Week 5's own page: `namesIt` (src/resolve.js) takes the numbers in a name as its
identity, and the week page *Week 5 (Oct 5)* is nothing but the number 5. A week's page, a term's page and a section shell
are containers like Problems and Notes, and are never a task's destination now; the row says *In your textbook — Perloff*.

## 20.53 The whole module on the shelf (2026-09-16)

"For all the files of many courses, this is the error." — a PDF card reading *Could not open this PDF: Unexpected server
response (404)*, with `%2520` in the URL. Then: delete the duplicates nothing links to; a Readings shelf whenever a week
has readings; videos in a shelf of their own; the week's shelf must show the whole module; the API and the token reach
everything, so no browser sweep.

**`%2520`.** `followTitle` (scripts/lib/move.mjs, §20.47) rewrote a retitled page's asset paths with the new title
URL-encoded, while the sync and the app write the folder raw and the client encodes each segment on the way out
(`api.fileUrl`). Encoded twice, `Reading guide- Kunka Chapter 1.assets` became `Reading%2520guide-…` and every page
placed with `--title` — all of FCS298's, CLA204's Lecture 4 slides, ECO227's Wald talk, fifteen in all — answered 404
for its file. A `src` now keeps the form it had: raw stays raw, encoded stays encoded; the fifteen were repaired in
place, and the test that covered retitling asserts both forms.

**The duplicates.** Four section pages carried copies from the first import (§20.23 split the notebooks into weeks but
left the section pages as they were): ECO208's *Fall 2026* held Chapter 1, the Lucas essay, the Sep 8 recording with its
transcript and the study sheet; ECO206's *Fall 2026* a 95 MB copy of the Sep 9 recording; both *General* pages the
syllabus. Nothing linked to them. Their layouts and assets are in `.trash/` under their own paths, the pages are their
frontmatter again. CLA204's superseded *Course Info + Resources* went through the app's trash, and the Desktop mirror's
stale copies (the mirror copies and never deletes, §20.33) to the Finder's.

**Three shelves the brain files by name.** `Readings` for anything to be read — a chapter, an article, a reading guide,
the page that lists the week's readings — so a reading never stands among the slides; `Videos` for a video the course
posts to watch; `Assignments` for the pages the fetch now writes for a module's discussion forum, quiz or hand-in. They
are folders like *R* or *Listening* (§20.30), shown only when a week has them, but they draw with their own icons and in
one order: readings beside the lectures, videos next, assignments after the problems. The brain's rules say so
(scripts/brain-prompt.md, step 4). FCS298's Kunka chapter and its guide, CLA204's Hymn to Apollo and its four *Week N
Reading* pages moved there; every task naming them followed (§20.52).

**The whole module.** A module on Quercus is files, pages, links, and also its forums, quizzes, hand-ins and videos —
and a week's shelf showed only the first three. The fetch now reads each Discussion, Quiz and Assignment item, and each
external link that is a video, into the shape of a Quercus page (`moduleItemPage`): a first line of facts — due, opens,
points, time limit, questions — then the description as posted, keyed `item-<kind>-<id>` in the sync's memory, so it
takes the road every page takes: the inbox, then wherever Claude files it, rewritten there when it changes. CLA204's
three participation quizzes and FCS298's forum are on Assignments; FCS298's three MyMedia videos on Videos.

**What the token cannot do.** ~~MyMedia~~ — corrected 2026-09-18, see §20.56: the watch page needs a UTORid, but the
Wowza HLS stream the player pulls does not, so the video downloads from a bare shell and its page carries the file.
FCS298's *Additional Course Resources* module (1415680) answered 404 all afternoon and was listed at 23:24 with its
one file, the extended comics vocabulary guide, now in General: a module can be announced before it is published, and
a 404 means not yet. Everything the audit
(`scripts/audit.mjs`, report in `~/Desktop/Claude OS/Slate audit/`) reconciles is reachable with the token, and after
this evening's fixes it finds no item unaccounted for. The Quercus skill (`.claude/skills/quercus/SKILL.md`) records all
of this — the module item types and how each is read, the UTC due stamps, the twin file ids, a module announced before it
is published, MyMedia's login, and that `get_course_structure` answers empty modules while the token's own call does not —
and `quercus_sweep.py --modules` prints the walk the MCP stopped giving.

## 20.54 What was missed stays, what is marked says so, and the week is one page (2026-09-16)

"On To do I need to know what's past due — what I needed to do and didn't — going back as long as I haven't done the
thing, with the severity. I should see what's graded, what's mandatory, and what's not. And the week view: I work week
by week, I need to see everything that is week by week and what I missed. I don't like it, it's not easy to understand."

**What was missed stays.** The plan was the next fourteen days, and a class that had met was gone from it with its
unticked tasks; a hand-in was dropped by the fetch the day after it was due. Nothing said *you did not do this*. The
plan now looks back to the start of the current term (`since` in `buildPlan`, the meetings and the weeks' work; the
days board and Next 7 days keep their fourteen days), and the fetch keeps an unsubmitted hand-in as a deadline until
Quercus says it is in. `rowsFor` reads the past at two settings: `'open'` — what To do and Home want — keeps only what
was not done, never what happens in the room and never the optional; `'all'` keeps the done ones too, for the week
page. A row past its day and unticked is `overdue`, its `when` says *was before the tutorial*, and it stands in a
**Missed** group at the top of To do, red, at Claude's own level — the severity he gave it, unchanged — until it is
ticked or Quercus has it. Home's agenda already had an Overdue band that nothing ever reached; it fills now.

**Graded, required, optional.** A task now says whether a mark depends on it. Claude sets `graded` on a task when the
course says (brain-prompt step 6; `checkTask` takes true or false); when he did not, `natureOf` (src/todo.js) reads the
kind and the link — a hand-in, participation, a quiz, or a link to a Quercus assignment, quiz or forum is marked work.
A hand-in row and a test are always graded, your own tasks carry no tag. Every card on To do wears *graded* (with the
points when Quercus gave them), *required* or *optional*, and a filter under the course tabs shows one kind at a time.

**The week is one page.** The three tabs of §20.39 hid half the week behind a click and said nothing about what there
was to do in it — the one thing the student opens a week to find out. Now: the week's classes as one line each, then **To do
this week** — the same rows To do draws, kept to this week by the class's week, the week's own work, or the day a
hand-in or test falls on, ticked in place, each with its nature and its level, *missed* in red once its day has passed,
done ones struck through so a past week reads as what was done beside what was not — and then every file in the week,
a shelf per category as before, the class a document is for as a small word on its row. No tabs, no jump bar; one
scroll is the whole week. The memory that the week screen must carry no to-do (§20.39) is superseded by this ask.

## 21. Slate for Alpha Delta Phi, second attempt (2026-09-17)

The first kit (§20.41–20.49) went to one brother on 2026-09-14 and came back with problems nobody wrote down. the student asked
for the sharing to be designed again from zero, and this section is that design. The app is the same app; what is new
is everything around it: how a copy is built, how it is set up on a stranger's Mac, what Claude costs there, and how
each of those is proved before a zip leaves this machine.

### 21.1 What was wrong, measured

Four things, each found by looking rather than by being told.

**The morning run could not be paid for.** One of the student's morning runs on his own Max plan is Opus, about 195 messages,
36 million tokens read from cache and 150 thousand written, in nineteen minutes — roughly seventy dollars of
API-equivalent usage. A Claude Pro plan is twenty dollars a month, shared with the brother's own chatting, and Opus
burns several times what Sonnet does. The old kit ran that prompt every three days. No cadence fixes that; the run had
to change shape.

**The button could not run.** The Check Quercus button spawns the `claude` command line tool. The Claude desktop app
does not install it, the two do not share a login, and setup never installed it: on every brother's Mac the button
fetched Quercus and then said Claude could not be found.

**A fresh Mac opens a dialog nobody asked for.** Without Apple's Command Line Tools, `/usr/bin/git`, `/usr/bin/python3`,
`xcrun` and `swiftc` are shims that offer to install the tools and fail. The server called `git --version` at boot, the
cron step called `python3` for the sweep, and the handwriting helper called `xcrun`. A non-technical person sees a
system dialog the first time the app opens.

**His courses shipped.** `terms.mjs` carried the student's five courses, professors and test dates as the worked example; the
app bundle carried his name; the calendar library's fixture was named after him.

### 21.2 The shape

- **One codebase, one switch** (`src/edition.js`), as before, but the switch now decides everything that differs:
  `ask`, `sheets`, `history` (git snapshots and the History pane, off where `git` may be a dialog), `hwr`, the brand
  (the Fraternity's published palette and its crest), the bundle's name, identifier and copyright line, its port, and
  two words that did not exist before: `budget` and `cadenceDays`.
- **Courses are data.** A brother's Claude never writes JavaScript. It writes `courses.json` in the shape of
  `courses.example.json`; `scripts/lib/courses-schema.mjs` says in plain words what is wrong with it;
  `scripts/courses.mjs write` renders `scripts/lib/terms.mjs` and `syllabus.mjs` from it through
  `scripts/lib/terms.template.mjs`, whose helpers must match the live file's byte for byte (`template-check`, run by the
  kit builder). The kit ships a rendered, empty course file that loads. A hand-written file — the student's own — is never
  overwritten without `--force`.
- **Setup is a program** (`scripts/setup.mjs`). `status` says what is done, what to say to the person, and the one
  command to run next; every step that touches the machine — `npm install`, the keychain, the CLI installer, `uv`, the
  app bundle, launchd — is code, idempotent, recorded in `setup-state.json` and rendered into `Setup progress.md`, so a
  run that stops on a usage limit carries on from the first unfinished step. Claude's own work is the conversation: the
  Quercus key, the ACORN screenshot, the syllabuses, the four confirmations, and `courses.json`. The kit's
  `.claude/settings.json` therefore allows a dozen `node scripts/…` commands and denies `git`, `python3`, `xcrun`,
  `curl`, `sudo` and `rm -rf` outright.
- **The key lives in the keychain** (`scripts/lib/quercus-auth.mjs`): `CANVAS_API_TOKEN` in the environment, then the
  keychain item `slate-quercus`, then the Claude desktop config where the student's own install keeps it. Nothing else reads a
  config file, and `security` is part of macOS, not the developer tools.
- **Nothing wakes the developer tools** (`server/devtools.js`). The check is on the file system — the tools' own `git`
  binary exists or not — never on a shim. Snapshots and the History pane are off without them or without `history`; the
  Swift helper is never built without them (the uv path answers); the sweep is Node (`scripts/quercus-sweep.mjs`), the
  Python one is gone from the repo's skill.
- **Slate runs its own routine** (`scripts/schedule.mjs`): two launchd agents in `~/Library/LaunchAgents`, a daily
  morning job and a Sunday review, both running `scripts/run.mjs`. launchd fires whenever the Mac is awake at the hour
  and runs a job it slept through once on waking, so a laptop shut at 07:30 catches up when it opens. The morning job
  runs every day and `run.mjs --scheduled` decides whether it is due from `Hub/_runs.json` and the install's cadence.
  The Claude desktop app's scheduled tasks were the first kit's answer; they run only while that app is open, and
  their model can only be set by hand in its editor.
- **The light budget** (`scripts/run.mjs`, `scripts/lib/brief.mjs`, `scripts/light-prompt.md`). The fetch downloads;
  `pdf-text.mjs` makes the words; the brief builder writes, per course, what one short session needs — the weeks with
  their topics, the classes of the next fortnight, what is due, the open tasks, and each waiting item with the words
  the fetch could read from it and a *proposal* (the rules in `scripts/lib/filing.mjs`, the module's name, the posting
  date) with its reason. Then one `claude -p` session per course: Sonnet, a turn cap, a dollar cap, no MCP servers, no
  subagents, only `brain.mjs` and `problems.mjs` allowed, and the brief in the prompt. Claude confirms or corrects and
  writes the tasks; every decision still goes through `brain.mjs` with a reason and an undo (§20.37). The morning
  note is written by the runner from what happened, not by a session. `Hub/_runs.json` records each run with its
  cost, and `run.mjs status` reads it back. The Check Quercus button runs the same routine when the budget is light;
  the student's own install keeps the heavy pass.
- **The kit** (`scripts/kit.mjs`) is built from the working tree by an explicit manifest, staged, transformed for the
  edition (the default edition, the rendered course file, the three documents, the settings, the derived SPEC), and
  then checked by a guard that fails the build on a home directory path, an email address, a Canvas token, the student's name,
  his professors' names, his course ids, a feature this edition has not got named in anything a machine acts on, or
  `python` in anything that ships. His course ids become synthetic ones consistently; the one identifier that was his
  name is renamed. It is stamped with a hash per file and zipped with `Read me first.html` beside the `Slate` folder.
- **The brother simulation** (`scripts/sim/brother.mjs`) is the test the first kit never had: unpack the kit into a
  throwaway folder with a throwaway home, hide the developer tools (and shim `git`, `python3`, `xcrun`, `swiftc` so any
  call is logged), run the setup engine step by step with scripted answers and this Mac's Quercus key read-only, build
  the app bundle into a throwaway Applications, write the launchd plists without loading them, start the shipped
  server on a free port and check it from outside, then scan everything for the student. `--claude` runs the real Sonnet
  sessions and reports what they cost.

### 21.3 Decisions the student took

Start again rather than rework the first kit. The official crest as the app's icon and the guide's masthead, with ΑΔΦ
as the wordmark, the colours as the Fraternity publishes them (emerald PMS 357, gold PMS 113 C, sage, cream, tan). Slate
runs its own schedule, with one login in Terminal as the price. Delivery by WeTransfer, because Gmail refuses a zip that
holds `.js` files however it is packed (§20.49).

### 21.4 What it costs, measured

Measured on 2026-09-17 in the brother simulation, on this Mac's own Quercus account (four courses, a first fetch of
38 files, 12 announcements and 19 pages — 69 items waiting), Sonnet, a 40-turn and $1.50 cap per session:

| session | items | placed · ignored · linked · tasks | turns | time | cost |
|---|---|---|---|---|---|
| ECO208 | 4 + 3 announcements | 4 · 0 · 3 · 0 | 9 | 69 s | $0.30 |
| ECO227 | 8 + 2 | 8 · 0 · 1 · 3 | 21 | 125 s | $0.41 |
| CLA204 | 22 + 4 | 22 · 0 · 2 · 2 | 35 | 202 s | $0.53 |
| FCS298 | 23 + 3 | 19 · 4 · 3 · 3 | 19 | 213 s | $0.68 |
| a tasks-only pass, nothing waiting | 0 | — | 1 | 19 s | $0.05 |

The whole first run — everything a new install has to file — came to **$1.93 of API-equivalent usage in eleven
minutes**, against roughly seventy dollars for one heavy morning on Opus (§21.1). A routine morning every two days,
with a handful of new things, is a fraction of a dollar. The decisions were checkable: FCS298's four byte-identical
duplicates ignored for that reason, CLA204's administrative pages sent to General against the rules' proposal, the
WebAssign set and the participation quizzes written as tasks with their own Quercus links and due dates.

Two things the first sessions taught. A session may file everything and write no task unless the prompt makes the
task pass its third, mandatory part — so it does now, and a course whose next class within a week has no task gets a
tasks-only session even when nothing is waiting. And a tasks-only session has nothing to go on once the announcements
are marked reviewed and the items filed, so the brief carries the last fortnight's announcements and what already sits
in the weeks around today, each with which class it is for.

### 21.5 The scenarios (2026-09-22)

The first kit's dry runs were done by hand, one at a time, on the student's own account; every fault it shipped with was
found by a person after the zip had left. Before the second kit went out the sharing layer got the test the first
never had: the kit installed again and again for students who do not exist, on a Quercus that does not exist, with a
Claude that does not think — so that every path a brother's Mac can take is walked before a zip leaves, offline, in a
minute, for nothing. Everything lives under `scripts/sim/` and ships in no kit.

- **`quercus-mock.mjs`** is the Canvas API on 127.0.0.1, serving one persona: courses with their modules, files with
  real bytes, pages, announcements with attachments, forums, quizzes, hand-ins with due dates, grades. It pages long
  lists with the `Link` header Canvas uses (`persona.perPageMax` makes every list long), hides a Files tab, expires a
  token, logs every request. A field the kit's scripts do not read is not modelled.
- **`personas.mjs`** holds the students. Marcus Chen has five courses and every kind of posting: a syllabus and its
  duplicate, slides posted on a Sunday for Monday, slides posted a week early in next week's module, a problem set
  with its solutions and its hints attached to an announcement, a chapter linked from a reading page, a YouTube
  lecture, participation quizzes, a forum, a recording, a course whose Files tab is hidden, a banner that is not a
  document, WebAssign and Crowdmark links — and a `later()` that posts new things, replaces a file in place, edits a
  page and cancels a tutorial for the second morning. Priya Nair has a winter-only course already visible in
  September, last year's course still listed as active, and two administrative shells. Jordan Okafor has six courses
  and a hundred and twenty files in modules Canvas will not inline. Dana Whitfield's one course has nothing posted.
  Nobody Yet is enrolled in nothing. The PDFs are two paragraphs of Helvetica that pdf.js reads like any other.
- **`fake-claude.mjs`** is the command line tool as `run.mjs` and `setup.mjs` see it. Given the light prompt it reads
  the brief, confirms every proposal through `brain.mjs` exactly as a Sonnet session would, writes one task per class
  and deadline the brief says needs one, and answers the `DONE` line in the CLI's own result shape. Asked, it hits the
  usage limit (on the Nth session), is logged out, answers garbage, runs out of turns or budget, crashes, hangs,
  refuses, or reports the review paragraph written.
- **`scenarios.mjs`** stages the kit once, borrows `node_modules` from the newest installed kit on the machine, builds
  the client once, and runs each scenario in a throwaway home where `git`, `python3`, `xcrun`, `curl` and `brew` are
  shims that log and fail, `uv` is a stand-in, the keychain is this Mac's under a service name of its own, and the
  developer tools are declared absent. Twenty-three scenarios: the five students; the token wrong, right, expired
  mid-term; no network; the CLI absent, logged out, out of usage after the first course, and every bad ending of a
  session; the lock and the cadence; setup stopped and resumed, steps run twice, the update to a new folder; an Intel
  Mac; fifteen wrong course files and a hand-written one; six leaks planted in the tree for the guard to refuse;
  nineteen filing cases for the proposals; and the shipped documents held against the code. Two hundred and twenty-six checks, in fifty-seven seconds, and `node scripts/sim/scenarios.mjs` is now the first thing run before a kit.
- **`compare.mjs`** holds a real-account simulation (`brother.mjs --claude --keep`) against the student's own notebooks,
  document by document, matched by Quercus id: the same week, the same folder, the same class — and lists every
  difference with both destinations, so a judgment call can be told from a mistake.

What the scenarios found on their first afternoon, none of it visible from the code alone:

- **A hidden Files tab killed the morning.** Canvas answers 401 both for a dead key and for a tab the instructor hid;
  the fetch treated every 401 as an expired token and stopped with the "make a new key" sentence. It now reads the
  body, asks `/users/self` once when in doubt, and a hidden tab is a line in the errors (the sweep the same).
- **Every placement of a fresh inbox page was refused.** The move guard refuses a page touched in the last ten seconds
  because it may be open in the app; the fetch writes the inbox seconds before the session reads it, so a session that
  acts quickly — a stand-in, or a real one on a small brief — filed nothing. A page under `Hub/Inbox/` with no
  container of the student's own is the fetch's, and is exempt.
- **A file both linked from a page and listed in a module took the page's module**, because the page loop ran last;
  Mills' reading, linked from Week 1's overview and listed in Week 2's module, went to Week 1. A module item is where
  the professor put it, and keeps its module now; the page still gives `from`.
- **The two installers called the system `python3`** — the exact fresh-Mac dialog of §21.1, in shell this time. They
  go through uv now, which the speech step installs on every Mac, and touch the system Python only where the developer
  tools exist; the guard reads shell scripts and JavaScript spawns line by line.
- **The course listing read one page.** Setup asked `/courses` once and never followed the next-page link; a listing
  longer than a page lost courses, and `courses write` then refused their ids as unknown.
- **`courses.mjs example` looked under `kit/`**, which no brother has, though `CLAUDE.md` tells their Claude to run it.
- **A Mac without wifi had a quiet morning.** Every request failed, every failure was recorded, and the note said
  nothing was new. The fetch now probes `/users/self` first and stops with "Quercus could not be reached"; the runner
  reports `network`, not a quiet day.
- Smaller: "Homework" was not a problem-set word; a page that changed on Quercus was offered as a placement instead of
  something to read; the day planner's `student` identifier shipped in code the guard did not read; Home asked for
  `/api/attendance`, a route the edition does not mount; the guide and the settings did not know the installers.

launchd itself was proven once, outside the scenarios: a simulated install's plist bootstrapped into this Mac's
`gui` domain, kickstarted, the log reading "not due" from the runner, then booted out.

**Against the student's own notebooks.** The same day the kit was installed once more on his real account with Sonnet
(`brother.mjs --claude`): 74 files, 15 announcements and 17 pages — 100 items — in 19 minutes for $3.47, and
`compare.mjs` held the result against what his heavy brain had done with the same documents over two weeks. Of the
72 documents both installs hold, 69 sit in the same week, 59 in the same week and folder, 54 under the same class.
The differences were of three kinds and two of them were the prompt's: the class of a problem set (Sonnet says
*tutorial*, the student said *both* — a judgment call, left alone); folders of the student's own — `R` for the econometrics scripts,
`Listening` for an audio essay — which the light prompt had never said exist, and a module's overview page, which the
heavy prompt puts in the week itself; both are in the prompt now. And FCS298, with 37 items, ran out of its 40 turns
after filing 19 of 21 in the right place: the caps now grow with the brief (two turns and four cents an item over the
floor), and the prompt asks for several commands per call. The Claude command line tool, it turned out, runs `git` on
its own in every session; where the developer tools are absent the runner now puts a git that is not git first on the
session's PATH (`bin/no-git`), so the call fails quietly instead of opening Apple's dialog at seven in the morning.

**The Desktop (2026-09-23).** the student asked that setup end with the app on their Desktop, where a double-click opens it,
rather than in an Applications folder they would have to find. The edition now says where its bundle goes (`appDir`:
`'Desktop'` for the brothers, `'Applications'` for the student); `scripts/build-app.mjs`, the setup's `app` step, its doctor
and its closing words read the same field, and a real build onto the Desktop removes an earlier copy of the same app
from an Applications folder, so there are never two of it pointing at two kits. The guide's warning about the
"unidentified developer" dialog was wrong and is gone: the bundle is put together on their own Mac from files node
wrote — Electron's from npm, the launcher by `copyFileSync`, which drops the quarantine flag that `cp` keeps — so it
carries no quarantine flag and Gatekeeper never looks at it. The brother simulation now stamps the unpacked kit the way
Archive Utility stamps a download, checks that the flag reaches neither the bundle nor its executable, verifies the
signature, and with `--open` launches the bundle as a double-click would and waits for its server to answer from the
kit on the edition's port; Marcus builds the bundle too, onto the throwaway Desktop, and reads the step's words back.
`codesign`, `plutil`, `sips` and `iconutil` are macOS's own, not the developer tools' (none links `libxcselect`), so
the build wakes no dialog either.

The first `--open` run found the one thing a terminal cannot see. The app, opened by LaunchServices, ran under this
Mac's own home rather than the throwaway one — the notes root in `slate.config.json` goes through `~` on purpose — and
so reached for `~/Documents/Slate`, a dry-run folder from the first kit (2026-09-14). It stood there for twenty
minutes with its event loop blocked, no server, ignoring SIGTERM: macOS's own question, *may Slate ADPhi access files
in your Documents folder* — `tccd` logs the authorization request for `org.alphadeltaphi.toronto.slate` the moment the
app reaches the folder — which a process started from a terminal never sees because it inherits the terminal's grant. A brother's first double-click gets that question too, for the folder the notes live in; the guide,
the app step's words and the email now say *click Allow*, and where to turn it on if they clicked the other button.
The harness now hands the app the throwaway home through `open --env`, captures its output, and quits it by pid with
a SIGKILL fallback so a stuck launch can no longer outlive the simulation. A copy of the bundle opened from this Mac's
real Desktop raised no question about the Desktop folder: the app may read its own bundle where it sits.

**The Max edition (2026-09-23).** a brother is on a Max plan, so his copy is the same kit with three numbers changed and
nothing else: `adphi-max` in `src/edition.js` spreads `adphi` and sets `model: 'fable'`, `cadenceDays: 1` and
`morningAt: '07:00'`, with `plan: 'Max'` for the words and `costScale: 5` for the caps. The light routine is untouched:
the code still proposes and one short session per course still decides; only the model answering is Fable, every
morning at seven. Three things had to follow. The dollar caps in `scripts/run.mjs` were Sonnet's (a dollar and a half
to four per session) and would have stopped a Fable session at the first big course, so they scale with the edition's
price; the words in the guide, CLAUDE.md, the README and setup said "every 2 days" and "Pro is enough" with the number
filled in, so the kit builder now fills `{{EVERY}}`, `{{PLAN}}` and the plan's own sentence instead; and a Max copy
opened on a plan that has not got the model would have failed every session, so the runner reads the CLI's own words
for that case ("There's an issue with the selected model … you may not have access to it"), decides the course on
Sonnet instead, keeps Sonnet for the rest of the run, and writes `model: "sonnet"` with the reason into the settings
so the next morning never asks again. `scripts/kit.mjs --edition adphi-max --for <name>` builds it, and the zip
carries his name. The scenario suite runs on either edition (`--edition`), reads what the kit ships and expects
from the edition, and the Max run has one scenario more: the stand-in CLI refusing Fable, the fallback happening once,
and the settings remembering it. The Claude CLI resolves `--model fable` to `claude-fable-5-1`; a one-word prompt
through it cost $0.78 of allowance, which is the price of its system prompt and tools at Fable's rate, and the reason
the caps had to grow.
Measured once, inside the brother simulation of a brother's zip: ECO 227Y1's sixteen items decided by Fable in nine turns
and 110 seconds for $1.55 (Sonnet took $0.41 for the same course on the 22nd), the R scripts filed into the course's own
`R` folder without being told twice; a full first run on Fable should come to $12–15 of a Max allowance, and a quiet
morning to under a dollar.

### 21.7 Windows, for a brother (2026-09-23)

a brother's PC runs Windows, so his copy is the first slate that is not a Mac program. The rule of the port: one codebase,
no fork, and every place the code had assumed a Mac now asks `scripts/lib/platform.mjs` instead. That module keeps two
truths apart: `WIN`, the platform the install is *for* (which folders, which credential store, which scheduler, which
words), and `REAL_WIN`, the platform the process runs on (only the mechanics of spawning: npm is a `.cmd` file on
Windows and needs a shell). The scenario harness sets `SLATE_SIM_PLATFORM=win32` on a Mac and walks the Windows road
with stand-ins, which is how the port was tested without a PC.

What differs, and where it lives:
- **The credential store.** Windows has no keychain a command line can read back from, so the Quercus key is wrapped with
  DPAPI — the user's own Windows protection, what browsers use for saved passwords — into
  `%LOCALAPPDATA%\Slate\slate-quercus.dpapi`. PowerShell does the wrapping and the key travels in the environment, never
  on a command line (`scripts/lib/quercus-auth.mjs`).
- **The scheduler.** Two Task Scheduler tasks instead of two launchd agents (`scripts/schedule.mjs`): a daily one for the
  morning (`run.mjs --scheduled` still decides whether it is due) and a Sunday one for the review, defined in XML with
  `StartWhenAvailable` (launchd's catch-up after sleep), the battery settings off, and `wscript` + `bin/run-hidden.vbs`
  so no console window flashes at seven; the output goes to `%LOCALAPPDATA%\SlateADPhi\Logs`. `SLATE_LAUNCHCTL=0`
  writes and lints the XML without registering it, as on a Mac.
- **The app.** Electron's win32 folder copied to `%LOCALAPPDATA%\Programs\Slate ADPhi`, `electron.exe` renamed, the
  launcher and a `.ico` of the crest inside (`public/brand/adphi-crest.ico`, made from the same SVG), and a shortcut
  with the crest on the Desktop — which PowerShell resolves, because Windows may keep the Desktop and Documents inside
  OneDrive. The window and the taskbar wear the crest through `icon` and `setAppUserModelId` in `desktop/main.cjs`.
  No code signing: the exe is written by npm, carries no mark of the web, and SmartScreen has nothing to say.
- **Names Windows can hold.** The fetch already turned `/ \ :` into dashes; on Windows it also turns `* ? " < > |` into
  dashes, drops a trailing dot or space, and keeps a title to 80 characters because a path over 260 fails unless the PC
  was told otherwise. Every relative path the notebook writes uses forward slashes, on Windows too.
- **What is left out.** Transcription and dictation (Apple Silicon only) and handwriting recognition (a Swift helper, or a
  uv path never tried on a PC): the Windows kit ships the edition with `hwr: false`, and `server/devtools.js` answers
  "absent" on Windows so every Mac-only path stays shut. Scanned PDFs are not OCR'd on Windows. uv and ffmpeg are still
  installed, through PowerShell's `irm | iex`, so a video that lands as `.ts` is converted.
- **The words.** The kit builder's `--os windows` fills the guide, CLAUDE.md and the README with the PC's words —
  PowerShell for Terminal, Win + Shift + S for ⌘ ⇧ 4, "encrypted on this PC" for the keychain, "Windows protected your
  PC → More info → Run anyway" for the two Mac dialogs, a shortcut for the bundle — and the setup program says the same
  at run time. Git for Windows is recommended in the guide (Claude Code uses its Bash tool with it, PowerShell without).

The tests: the Pro and Max suites unchanged, and on the Windows kit the same suite plus one scenario that runs the whole
road as a PC — a Windows version and a Programs folder given through the environment, PowerShell and schtasks as
stand-ins (`scripts/sim/win-stubs.mjs`), `uv.exe` a stub, Electron's dist a folder with an `electron.exe` — and checks
the DPAPI file, the two task definitions, the renamed exe and its launcher, the shortcut, the safe file name, and that
no Mac tool was ever called. What no simulation can show: schtasks itself, DPAPI itself, the shortcut itself, and the
exe opening. Those need one run on a real PC; the test report carries the checklist.

### 21.8 The app runner: no command line tool (2026-09-24)

The Pro kit no longer needs the Claude command line tool, a Terminal login, or launchd. the student asked for the morning to
"run through the Claude scheduled task": the Claude desktop app keeps local scheduled tasks — a fresh session started
at an hour, in a folder, with a prompt kept as `~/.claude/scheduled-tasks/<id>/SKILL.md` — and that session is the
brain. The edition says `runner: 'app'` (adphi; a brother's `adphi-max` keeps `'cli'`), and three things follow.

**The morning in three commands.** `scripts/run.mjs fetch` does what the morning did up to the briefs — the cadence
check, the lock, the fetch, the PDF text, the transcripts on a Mac — and leaves the run open with `phase: deciding`;
`brief <CODE>` prints one course's brief as JSON, recomputed at the moment it is asked, so a session can resume;
`finish` counts what the brain recorded since the fetch, writes the plan pages and the morning note, and closes the
run. The session that calls them decides in between, by the same `scripts/light-prompt.md` as the CLI sessions did.
`scripts/task-morning-prompt.md` is the task's prompt; `scripts/task-review-prompt.md` the Sunday one (the code writes
the look-back page with `review --no-claude`, the session the plan paragraph). On this runner `morning` — the Check
Quercus button — fetches and leaves everything waiting for the next check, and says so; Home's "Checked" line now
carries the last run's numbers ("3 new, 3 filed, 0 waiting"), served on `/api/hub` as `lastRun`.

**Setup without the CLI.** The road loses the `claude` step. `first-run` is two halves — the fetch, then their Claude
deciding each course from `brief`, then `first-run --finish` — and its words tell their Claude to keep the brother
posted course by course and to say, plainly, how little there is in September and why. `schedule --at HH:MM` cannot
create the tasks (the app keeps the schedule, the folder and the model itself), so it prints the two task definitions
their Claude passes to the `create_scheduled_task` tool, and `schedule --check` reads the file the app writes for each
to say whether they exist; `doctor` shows them as a row of their own. The tasks run while the app is open and the Mac
awake, and a missed morning is caught up once when the app next opens; the guide says so, and offers the old road —
the command line tool, one Terminal login, `schedule.mjs install`, `"runner": "cli"` in the settings — as an optional
extra for a brother who wants the check without the app open.

**The first double-click.** The notes now default to `~/Slate`, a folder in the home itself, which macOS never asks
permission for: the first double-click opens with no question. The Documents question of §21.5 remains only for a
brother who chose Documents or the Desktop, and the guide's note is now about what to do when nothing seems to happen.
The launcher waits 45 seconds for its server instead of 15 and, if it cannot start, says why in a window rather than
quitting in silence.

**Tests.** The stand-in brain moved into `scripts/sim/decide.mjs`, so the fake CLI and the harness share it; on the app
runner the harness *is* the session — fetch, then `brief` and `decideBrief` per course, then `finish` — and the
schedule step writes the two task files the app would. The `apprunner` scenario walks the road, then the scheduled
not-due and due mornings, the button leaving things waiting and a later run filing them, `finish` with nothing open,
an empty brief, the review, the doctor — and, for the three things the 85 brothers will use most, that every to-do
carries a date and that every link on one leads to a page that exists or to Quercus. Two things the stand-in taught:
two classes in one week must not get the same task words (the brain refuses the batch), and what is filed has to be
read again after the placements for a task to name and link its document.

### 21.9 The Pro kit on Windows, for a brother (2026-09-24)

a brother's Surface Pro 9 (Intel) gets the Pro kit — the app runner of §21.8 — on the Windows road of §21.7, the first time
the two meet. the student's word for it: the same thing as decided, adapted from a Mac to Windows, every test kept. Four
places knew one side and not the other:

- **The words.** CLAUDE.md's note on the optional background check said "one login in Terminal" on a PC; the kit
  builder fills PowerShell there now, and names Task Scheduler rather than launchd for what `schedule.mjs install`
  registers. `finish` promised the two speech features on a PC and no longer does; the runner's "not installed on this
  Mac" says "this computer"; the README asked for "the three things" of a kit that asks for two.
- **The scenario.** `windows` expected Task Scheduler on every kit. On the app runner it now checks the two tasks in
  the Claude app — created from what `schedule --at` prints, at the hour asked, pointing at the folder and its two
  prompts, seen by `--check` and by `doctor` as a row of their own — and still installs, sees and removes the two
  Task Scheduler tasks as the optional road; `finish` must name the scheduled task and never a Mac or dictation.
- **The assumption.** The Windows Claude desktop app is taken to keep its scheduled tasks the way the Mac app does
  (`%USERPROFILE%\.claude\scheduled-tasks\<id>\SKILL.md`, Routines in the sidebar, `create_scheduled_task` for his
  Claude). No simulation can show that; it is the first line of the checklist, and the optional road — which the
  simulation walks — is the fallback if it is wrong.

**What the Surface said, the same evening.** the student set the first build up on a brother's PC. Two faults no Mac simulation
could see:

- *"Only URLs with a scheme in: file, data, node, and electron are supported by the default ESM loader. On Windows,
  absolute paths must be valid file:// URLs. Received protocol 'c:'"* — the first double-click. The launcher imported
  the server as `import(path.join(REPO, 'server', 'index.js'))`; a Mac's loader takes a bare path, Windows' does not.
  Now `pathToFileURL(…).href` there and in `courses.mjs` (the rendered course file is checked by importing it — the
  same fault, one step later in setup). The kit guard reads the code for any `import()` whose argument is not a
  relative or bare specifier or a `pathToFileURL` call and fails the build, and the `guard` scenario plants one to
  prove it. The launcher's error window gave macOS advice on a PC; it gives the PC its own now.
- *Transcription offered, and failing.* Every recording wore a Transcribe button, the mic sat in the toolbar, and the
  failure told him to `uv tool install parakeet-mlx`. The edition knew only `hwr: false`. There is a `speech`
  feature now: the Windows kit ships `speech: false`, `src/transcribe.js` exports it, and the player, the Library
  row, the week's row, Add files and the toolbar offer nothing without it; the server decides the same truth once
  (`SPEECH` in `server/index.js`: the edition, not Windows, Apple Silicon), says it on `/api/health`, and the
  transcribe route and the dictation status answer "Mac-only and not part of this copy" to anything that asks. An Intel
  Mac reads "needs a Mac with an Apple chip" by the same road.

Both are checks in the `windows` scenario now — the launcher's file URL and OS words, the edition's flag, the server's
three answers — beside the two planted imports in `guard`. The lesson for every kit after this one: a Mac simulation
proves the road, not the platform; what is platform-bound (module loading, spawning, paths, tools) needs a static check
in the guard or a real PC.

`node scripts/sim/scenarios.mjs --edition adphi --os windows`: 239 of 239 checks across 16 scenarios. The kit:
`node scripts/kit.mjs --edition adphi --os windows --for <name>` → `Slate share/2026-09-24/`, with an email and a test
report that carries the first-run checklist for his Surface (DPAPI, the shortcut, the exe, the app's tasks).

### 21.10 Public, and updated in place (2026-09-29)

**What the student decided.** The copies are published from a public GitHub repository on the chapter's own GitHub account (`academic-alphadeltaphi-ux`),
instead of a zip sent by WeTransfer. One branch serves both machines: `scripts/lib/platform.mjs` stays the only place that
knows the OS, and each release carries four zips — `slate-adphi-{pro,max}-{mac,windows}.zip`. A brother installs with
one message to Claude Code (the text is in the repository's README) and updates by saying *update Slate*; when the
code changes here, a new release is published and each copy takes it when asked.

**The tree is not this repository.** Every commit here carries the student's courses, professors and name, so the public
repository has a history of its own, and what it holds is `node scripts/kit.mjs --source <dir>`: the kits' manifest,
their depersonalisation and their guard, both machines' files in one tree, and `kit/REPO-README.md` as its README.
`scripts/publish.mjs` (development only, never shipped, the one place that runs git and gh on purpose) does the rest in
two calls. The build: the scenarios for all four copies, or nothing; the tree synced into a clone and committed under
the GitHub account's private address (never this Mac's host name); the four zips, each stamped in `kit.json` with the
repository, the tag (`vYYYY.MM.DD`, `-2` for a second the same day) and its own asset name; a record of the build.
Nothing is public yet. `--push` ships exactly that build, never a rebuild — the repository created if missing, the
commit pushed, `gh release create` with the four zips — and refuses if the clone has moved since.

**A public release is a shipped kit, so the guard grew.** The brothers a copy was built for are named in the code and
in this file where a PC taught something; they become "a brother", and the guard refuses the names. The suite's
fixture courses (a dropped course of the student's, with its Quercus id and its professor) never ship, and their ids and
professors are guarded like the live ones. `Read me first.html`, beside the `Slate` folder, is read by the guard too.
§20.67–68 (where the student's own textbooks came from) stay home.

**The update is in place.** `node scripts/update.mjs --check | (nothing) | --rollback`. It asks GitHub's API for the
latest release of the repository its `kit.json` names, takes the asset named for its own edition and machine, downloads
it with `fetch`, and unpacks it with the system's own tool — `ditto` on a Mac; on a PC Windows' own `tar.exe` by its
full path, because Git for Windows puts a GNU tar first on the PATH and GNU tar cannot open a zip. A zip for another
edition or machine changes nothing. The swap works from the two releases' file hashes: a file is replaced, added or
removed; what setup, the course file or their Claude wrote into the folder (`courses.json`, `slate.config.json`,
`setup-state.json`, the rendered `terms.mjs`/`syllabus.mjs`, `node_modules/`, `dist/`) is never touched; a shipped file
whose hash is not the one its release shipped was changed by hand, and is named. Everything replaced or removed is
copied first into `setup-downloads/update-<from>-<when>/before/` with a manifest, which is what `--rollback` reads.
Then what the new code needs: `npm install` if the lock changed, `setup.mjs courses write`, `setup.mjs app`, and
`setup.mjs schedule --check`. It refuses while the app is open (a server on the edition's ports answers with this
folder) and while a check runs (`Hub/_runs.lock` names a live process).

**Why in place, not a new folder.** The scheduled tasks are bound to the folder (§21.8), so a new folder meant new
tasks; the notes live apart and do not move; and the old road — "replace this folder with the new one" — would have
deleted the notes on a PC, where they could sit inside it (below).

**The notes and the kit never share a folder.** The Windows default for the notes was `Documents\Slate`, and the guide
told a brother to put the kit folder in Documents: the notes root was the code folder. The notes default is now
`Slate notes` (the home folder on a Mac, Documents on a PC); the kit folder goes in the home folder on both — never
Documents on a Mac, where macOS would ask the app's permission to read its own code; `setup.mjs notes` refuses a notes
folder that is the kit folder, is inside it or holds it; `setup.mjs doctor` flags an install where they overlap.

**Trust.** Whoever can push to the repository can put code on every brother's machine at their next update. The
account keeps two-factor authentication on, and its login and token stay with the maintainer. It is pushed to over HTTPS
with gh's token, never SSH: an SSH key belongs to one GitHub account, and the maintainer's key is his own account's.

The `update` scenario walks the road against a stand-in GitHub (`SLATE_UPDATE_API`): the check, the app open, the swap,
a hand edit set aside, the course file rendered again, a second check, the rollback — and no git, curl or python.

### 21.11 Every morning, in the app, and proved (2026-09-29, evening)

What sharing had got wrong before, the student listed: a setup that did not see itself through, a check that did not run, an
app that did not open, documents that never arrived, to-dos that led nowhere. Each is now a thing the code proves.

**One road.** Both copies check every morning (`cadenceDays: 1`; the Pro copy was every two days) as a scheduled task
inside the Claude app (`runner: 'app'`; the Max copy used the command line tool, launchd or Task Scheduler, and a
Terminal login). An app task runs on the model the app is set to — `create_scheduled_task` takes none — so an edition's
`model` and `costScale` only matter on the optional CLI road. An install keeps the cadence it was set up with
(`Hub/_settings.json`); the change reaches new setups.

**The schedule proves itself.** Setup's status says first that the conversation must be one opened on the Slate
folder: a task belongs to the folder of the conversation that creates it, and one made elsewhere runs there, without
this folder's permissions, and stops at the first question with nobody to answer. The schedule step then asks for three
proofs: `list_scheduled_tasks` shows both tasks enabled with the printed cron; `setup.mjs schedule --check` finds each
task's file and that it names this folder (an older copy's task would fetch into the older copy — and
`update_scheduled_task` never moves a task to another folder, so it is deleted and made again); and one
`run_scheduled_task` of the morning runs to "not a check day".

**The skill does the checking.** The repository's one skill, `quercus`, leads now with what a brother's install has — the
sweep and the audit with the student's own key, no MCP — and with the *completeness pass* every morning ends on (the
first run too): `node scripts/audit.mjs --json`, which since today carries each flag, then each flag acted on — what
waits decided, what the fetch missed fetched again or asked about, every assignment, quiz and forum given a task, every
task given its link, a date that disagrees with Quercus corrected — and the audit once more. The skill pre-approves its
commands (`allowed-tools`), so an unattended morning never waits on a permission question; the CLI road allows the Skill
tool and the sweep too. The kit's settings no longer carry `Write(**)` / `Glob(**)`-style rules the permission system
never consults.

**The app on the Desktop, and when it does not open.** Setup builds it where the edition says (the Desktop; on a PC a
shortcut there and the program under `%LOCALAPPDATA%\Programs`). When it does not open, the guide's last note sends the
brother to Claude, and `CLAUDE.md` gives Claude the order: wait twenty seconds; the box names the reason, and the app
writes the same into `setup-downloads/app.log`; the Mac's folder question and Gatekeeper, the PC's SmartScreen; `setup.mjs
doctor`, whose `app starts` row starts the app's server the way the app does and says why it fails, and `client built`
whether the screens exist; close the app, `setup.mjs app`, open it again.

**Every to-do leads somewhere, when there is somewhere.** The brief hands the session the link of each thing (a
Quercus URL, else the page it lands on), `light-prompt.md` asks for it, and `run.mjs finish` refuses to close a morning
while any open task — an older one too — has no link that opens (`linkGate`, lib/brief.mjs). the student's rule decides what
counts: *if the link is available, link it; try your best to find it.* So the gate presses a link only when code found the
thing itself (the hand-in its words name, the page it named where it moved, a document or Textbook page of its week);
where it found none it asks for a search (the sweep) and, failing that, words that say the thing lives nowhere online —
"(paper textbook)", "(in class)", "(your own work)", or the course textbook's author, the rule `lib/check.mjs` holds —
and then lets it pass. The week page is offered last, never pressed. A task's words refuse " — ", so parentheses.

**The walkthrough.** The scenarios run setup's commands themselves: they prove the commands, not the words. So a live
Claude was given what a brother's Claude has — the folder, `CLAUDE.md`, `setup.mjs status` — and told "set me up", in a
world that does not exist (`scripts/sim/walk.mjs`: a throwaway home, the stand-in Quercus with one student, every script
of the copy refusing to run outside it; `scripts/sim/walk-prompt.md` its instructions, the Claude app's tools emulated as
files). Twice, 10 of 10 steps. The first walk found what the words lacked, the second confirmed each fixed:
- a syllabus that lives on Quercus's Syllabus tab or a page could not be read at the courses step. `quercus-sweep.mjs
  --syllabus --course <id>` prints the Syllabus tab, the front page, outline and grading pages, the teachers, and the
  announcements about tests (with their authors), and names the outline files;
- an outline the first run brings goes into `courses.json` before the run closes. One that appears later makes the
  morning ask the student to "add the <CODE> outline", a procedure in `CLAUDE.md`. The morning never changes the course
  file itself;
- a course with no outline is asked about in one line, and a Quercus course missing from ACORN is asked about as an
  online course (`meetings: []`);
- setup's first run names one closing command (`setup.mjs first-run --finish`);
- `--for` is never used with `--to General`;
- a forum asks for a task only when a mark or a date hangs on it, and its flag prints its address;
- a graded quiz's or forum's own address counts as its assignment's;
- a deadline past and not handed in gets a task that says "(late)";
- the speech step looks for the engine it installed and says plainly when it is not there;
- a Winter course has no classes in the Fall (the brief and the morning note asked `isClassDay`, which knows every
  term, and not the course's own).

## 20.56 The gated page and the open stream (2026-09-18)

§20.53 recorded that MyMedia "sends anyone without a UTORid session to its login page, so a video's page holds the
link and says so, not the file: watching or downloading one is the browser's job." That was wrong, and the way it was
wrong is worth keeping, because it is a mistake the fetch can make again anywhere.

What was verified in September was real: `play.library.utoronto.ca/watch/<id>` is a Next.js shell whose HTML holds no
stream, whose `__NEXT_DATA__.props.pageProps` is `{}`, and which bounces an unauthenticated client to
`/login?sessionExpired=true`. The `/embed/<id>` form answers `200` rather than redirecting, but is the same empty
shell. Every one of those observations still holds.

The error was concluding from them that the *video* was unreachable. Only the *page* had been tested. The player, once
running, fetches an ordinary Wowza HLS stream from a different host:

```
https://stream.library.utoronto.ca:1935/MyMedia/play/mp4:1/<32-hex-id>.mp4/playlist.m3u8
```

and that host authenticates nothing. Verified 2026-09-18 against all three FCS298 videos — `200` on the master
playlist, the chunklist and all 99 segments, from `curl` with no cookie, no token and no referer. The id is the same
32-hex string the watch URL carries. The segments are MPEG-TS sharing one PAT/PMT, so concatenating their bytes yields
a playable file with no demuxer involved; `ffmpeg -c copy -bsf:a aac_adtstoasc` then remuxes to mp4, which is what
slate's media element and NotebookLM want (NotebookLM rejects `.ts` outright with a `400`). `aac_adtstoasc` is
required, not cosmetic: TS carries ADTS audio headers, mp4 expects ASC, and skipping the filter produces a file whose
audio most players will not play.

`scripts/lib/mymedia.mjs` holds this, `scripts/mymedia.mjs` is its CLI (`--course FCS298` fetches every MyMedia video
a course has posted, skipping what is already on disk), and `quercus-sync.mjs` calls it per run, so a newly posted
video downloads itself into the course's *Videos* folder and its page carries both the link and the file. A video link
that is not MyMedia — YouTube, Zoom — is still just a link. `bin/install-ffmpeg.sh` puts a static ffmpeg at
`~/.local/share/slate/ffmpeg` from the `imageio-ffmpeg` wheel, because this Mac has no Homebrew.

**The general lesson, and the reason this section exists.** A login wall in front of a page is not evidence that the
asset behind it is closed. The fetch stopped at the first `401`-shaped response and wrote its conclusion into the
SPEC, the skill and memory, where it then discouraged three further attempts. Before recording that something is
unreachable: open it in a browser that works, read the network requests, and check whether the thing actually serving
the bytes is the same thing that asked who you were. It usually is not.

## 20.57 The Library holds what the week shows (2026-09-18)

the student, 2026-09-18: "Every possible thing should be in Library. The videos are missing … all the videos should be there,
especially if they appear in the week view." Two things kept them out, and neither was about videos.

First, the Library's kinds were the sync's six buckets. A page filed on one of the shelves §20.53 added by name — Readings,
Videos, Assignments — fell into *Other*, a word that says nothing, so a video sat under Other with a reading beside it.
The kinds are now the week's shelves in the week's order (`src/components/Library.jsx` KINDS, `server/routes/library.js`
BUCKET), then what a course has beside its weeks.

Second, the bar a page had to clear to be a document — carry a file, or forty words — was written when everything that
mattered arrived as a file. A MyMedia video before §20.56 was a page of a link and one line; a forum is a page whose whole
point is a link; so the week's shelf showed them and the Library did not. A page whose text points somewhere outside is
the document *for* that thing, and it is a row: its badge is the kind's icon rather than TEXT, and the link on its card
says where it goes — MyMedia, YouTube, Zoom, Quercus. Video files are counted apart from audio (a video badge, and the
Transcribe offer for either), and a video filed under General wears the *videos* kind, because the welcome video belongs
with the module's wherever the fetch first put it. Any other section of a notebook is walked as well, so a download
waiting in the course's own `Videos` folder is found before the brain files it.

The rule §20.22's filter had right, and this entry keeps: a row must *be* something. What changed is the list of what counts.

## 20.58 A text layer can be present and still be nonsense (2026-09-18)

FCS298's assigned reading — Kunka's chapter, a clean scan of a book — carries a text layer that pdfjs extracts
without error and that decodes to line noise. Every page declares one font, `Helvetica` Type1 `WinAnsiEncoding`,
for what is plainly set in a serif face: something wrote a junk layer, probably a failed OCR pass. Extraction is
not the problem and no extraction flag fixes it — `sort=True`, `blocks`, and `remove_rotation()` all return the
same garbage, because the character codes themselves are wrong.

That mattered more than one reading, because `scripts/pdf-text.mjs` writes a `.pdf.txt` beside every PDF and
`brain-prompt.md` has the brain *read those sidecars* as its source for plans and study sheets. Nothing scored
them. The brain had been reading noise for the one assigned chapter of the term and saying nothing, and a study
sheet built from it would have been confidently wrong.

**The gate.** `wordish(text)` is the share of non-space characters sitting inside a run of two or more letters —
near zero for symbol soup, high for prose. Measured across FCS298's 15 sidecars: the broken chapter scores
**0.487**, the next-worst *good* file **0.838**, the rest 0.846–0.954. `WORDISH_MIN = 0.65` sits in that empty
band. Text under 200 non-space characters scores 1: a cover page is not a failure. A first attempt used a
dictionary hit-rate instead and was abandoned — it flagged *Refaie*, *Spiegelman's*, *didn't* and *boundaries*
as errors, because `/usr/share/dict/words` has no proper nouns, possessives, contractions or inflections. A
metric that cannot tell a proper noun from an OCR error will send you shopping for an engine you do not need.

**The fallback.** macOS's own Vision framework, via `scripts/ocr-pdf.py` (PyMuPDF rasterises, Vision reads).
Benchmarked against the two pages of the same scan whose embedded layer *is* intact: **0.974 character
similarity, 0.966 word recall** on a normal text page. Free, offline, no account, nothing leaves the Mac — no
cloud OCR was needed. A landscape page is treated as a two-page spread and each leaf is read separately, or
Vision reads straight across the gutter and interleaves two columns of unrelated prose; the fold is found as the
darkest vertical band in the middle third rather than assumed to be the midpoint (usually within 1%, but one
FCS298 page folds at 0.427).

**`VNRequestTextRecognitionLevel` is Accurate = 0, Fast = 1.** The first implementation passed `1` on the
assumption that the larger number meant the better setting. That drops word accuracy from 0.892 to 0.521 and
produces fluent-looking output with systematic `c`→`L` and `m`→`ni` confusions — which reads as a poor scan
rather than a bad API call, and was written up as such before being caught. When OCR output looks uniformly
mediocre rather than locally wrong, suspect the recogniser's settings before the paper.

`textFor(abs, { ocr: true })` runs the gate; **`ocr` defaults to false** because `textFor` is also on request
paths (`server/doc-index.js`, the ask context builder) where a ten-second OCR would be felt. Only the batch pass
asks for it. The cache header gains an `ocr=` field and `CACHE_VERSION` is 2, so existing sidecars re-extract
once. `bin/install-ocr.sh` provisions PyMuPDF and pyobjc into `~/.local/share/slate/venv`; without it the gate
still detects and records the failure, it just cannot repair it.

**A cache hit has to know what the reader wanted.** Because `ocr` defaults to false, the app's doc-index writes
a perfectly valid v2 cache holding the *unrepaired* text. The batch pass then saw a matching version, mtime and
size, reported `cached`, and never ran the gate — so the app silently clobbered the OCR'd sidecar and only
`--force` brought it back. A hit now only counts when the cache already carries `ocr=`, or its text passes the
gate, or the reader did not ask for OCR. The general shape: a cache key that records *what* was computed but not
*how well* will hand a cheap answer to a caller who needed an expensive one.

**One trap when verifying this.** Slate.app imports `server/` at launch and its doc-index rewrites caches with
whatever build it started from, so a running app quietly reverts freshly written v2 headers to v1 and makes the
CLI look broken. Rebuild and reopen the app before concluding the cache does not work — see
[[slate-app-runs-stale-build]].

## 20.59 What a full review found, and what changed (2026-09-18)

A read of the whole app — the server, the client, the scripts, the tests, the kit — by one model with four readers
under it, each claim checked against the code before it counted; then the notebooks themselves, page by page. The
reports are in `~/Desktop/Claude OS/Slate review/`. What it changed, by the rule it restores:

- **§8, two writers.** A save refused with a 409 marked the editor *clean*, so the next disk event reloaded over the
  unsaved text or ink with the banner still up; *Keep mine* wrote both files back, erasing the other writer's change on
  the side never touched. Now a conflict stays dirty until the banner is answered, and *Keep mine* keeps only the side that
  is yours. Inside the server, `writePage`, `writeLayout` and `patchFrontmatter` are serialised per file
  (`withFileLock`), so the pen's layout save and the auto-recognition write cannot both pass one hash check. The
  editor's unmount flush stashes what a failed save carried and hands it back as a marked *Recovered* block; the desktop
  window asks the page to flush every pending save before it closes.
- **§3, all four parts or none.** `POST /api/rename` moved `<Title>.assets/` and never rewrote a `src`: every document on
  a renamed page went dark until it was renamed back. The server's rename now checks all four destinations, rolls back a
  failure, and follows the title into every `src` and image link, through the same `followTitle` the scripts use.
- **§20.20, one guard.** `assertPagePath` guarded `PUT /api/page` alone; layout, frontmatter, upload, create, rename and
  trash now refuse reserved names too (`assertContentPath`), the watcher and both indexes skip `_exports/`, and the JSON
  body parser stays off the two routes that stream a raw body (a dropped `.json` file used to arrive empty).
- **Localhost is not a boundary.** A page on any site could POST here without a preflight when its body was plain text
  or absent — `/api/sync` starts a Claude session with Bash. A state-changing request naming a foreign Origin is refused.
- **The fetch.** A 5xx or a 429 from Canvas read as a quiet day and emptied the deadlines; lists were one page deep; a
  changed Quercus page was rewritten without its `for:`; the Files tab overwrote the module a file came from; a file
  replaced in place (same id) was never noticed; the sync's memory was written last and non-atomically, so a fetch cut
  short left pages in the inbox that the next run treated as known. Each is fixed: failures are recorded and yesterday's
  rows kept, every list follows `Link: rel="next"`, `for:` and extra tags survive a rewrite, a rewrite also stops when
  the body no longer matches what the sync wrote, a new version waits in the inbox named for its day, and the memory is
  written after every course and on SIGTERM, atomically.
- **The grade model.** `dropLowestFraction` was declared, printed and never applied; the item number was read from a
  capture group that only one alternative of ECO208's `match` has, so "Midterm 1" was dropped; a bonus with no marks yet
  made A+ read *gone* under any fill. All three are in `src/grade.js`.
- **Smaller.** The last open page never restored (a stored `null` read as "nothing stored"); the left pane's Ask rail
  never read the pen first; a personal calendar block drew an hour too tall; Esc in Take notes on a week screen also
  left the week; the grammar's "in class" regex stripped Claude's link from a task; done rows in the past vanished from
  *Show what is done*; a search target replayed on later pages; the transcript pass replaced a page of typed notes with
  its two-line header; a brain command that failed inside its lock left the lock behind; gray-matter cached every
  parsed page for ever; ffmpeg was looked for under one Python version only; the kit did not ship `bin/`.
- **The notebooks.** Seven documents had no class, five ECO206 problem pages wore `kind: lecture`, FCS298 had its welcome
  video twice (a stub and the file) — all put right through `brain.mjs` and the app's own frontmatter writer; the
  reconciliation audit against Quercus found nothing else missing.

Not done, on purpose: the client still has no tests of its own (the save pipeline in `Canvas.jsx` is the first thing to
cover). CLA204's four recorded lectures were MyMedia links inside Quercus *pages*, which the fetch never downloads (it
reads module video items only); on the student's word they were pulled into their lecture pages — 348 MB for 4 h 20 of
lecture, so the fear of a gigabyte was wrong — and transcribed, each page keeping its link and its class. A page that
links a MyMedia video is a shape the fetch should learn to download itself.

## 20.60 Cut in stone: the app follows its icon (2026-09-19)

"I want the UI rebuilt to be stronger, classier — marble, everything you know — more serious, academic. It needs to
follow the new logo, nice fonts." The icon (§20.17, replaced 2026-09-18) is a mortarboard carved in Carrara marble on
honed black slate. The app was still the blue-and-white dashboard of §20.34, and an uncommitted diff had started pulling
it the other way, toward warm parchment and bronze. Asked to choose, the student took **cool stone** over the warm library,
**veins in a few places** over none or everywhere, **Hoefler Text** for the headings, an **academic set** for the course
colours, **everything redrawn**, **airier everywhere**, and **both themes kept**, dark being the black slate. The
parchment diff was set aside as a patch and discarded.

**The stone.** Light is the marble page: a Carrara sheet (`--glass-solid` #faf9f7) on a honed grey desk (`--canvas`
#e8e7e4), graphite ink (`--text` #17181a), hairlines (`--edge` .16, `--edge-2` .30) instead of shadows, corners cut
square (`--radius` 6px, controls 4px). Dark is the slate the cap sits on: `--canvas` #121314, cards #1f2022, bone type
#eeebe5. Every card lost its shadow and its lift on hover; a marble slab does not jump under the pointer, it changes its
edge. The one filled control is ink — the primary button is graphite in light and bone in dark, and wears `--on-accent`
— and the one colour that is not a course's is **gilt** (`--gilt`, #8a6d3b light, #c9a961 dark): today's column, the
live class, the current week's ring, a link, the caret in Ask. Blue is gone from the app.

**The type.** Three voices. A heading is Hoefler Text at its natural weight (`--font-display`; Iowan Old Style and
Baskerville behind it, every Mac ships all three) — size does the work, not bolding. A kicker is Hoefler in true small
capitals, spaced (`font-variant-caps: small-caps; letter-spacing: .12em`): the screen's name, a card's `h3`, a shelf's
name, a course code, "before it", "next test". A number read as a number — a countdown, a date on a calendar leaf, a
mark, a week — is Hoefler with lining, tabular figures, because the face's own figures are old-style and hang below
the line. The body stays SF, a size larger and a line-height looser than before, so a dense list is still a dense list.
`.serif`, `.caps` and `.num` name the three in styles.css for anything new.

**The veins.** `scripts`-free: a 1400×420 SVG generated once (a seeded random walk with branches, two soft clouds,
graphite at 10–16 % in light, bone in dark) and embedded as a data URI in `src/styles/veins.css` as `--veins`. It is
drawn on the few surfaces that are a slab: every screen's masthead (`.home-head`, the course head `.cx-head`, a
document's `.pghead`), a dialog's title band, a sheet's `.cs-head`. Cards, lists and the writing page are plain
marble. The masthead is new: the screen's name as a kicker, the title set at 42px, the one sentence about now
(Home's "Next up is …") as an italic deck under it, a double rule cut beneath the whole slab. The course head carries
its pigment as a spine along the top; a document's header the same slab over the sheet.

**The pigments.** Nine swatches replace the nine saturated ones: oxblood #7a2e2b, navy #2c3e6b, forest #2f5d45,
ochre #9a7420, plum #5b3a6e, mulberry #8b3a5a, bronze #8a5a2b, teal #2e5f66, slate #4d5a66 (`src/palette.js`). Nothing
on disk is rewritten: a `_slate.json` or a hub still says `#2563eb`, and `api.js` runs `repaint` over every response,
so an old swatch becomes its pigment on the way in — the sidebar, Home, the plan, the course screen and the Library
agree without each remapping on its own. A page's `blocks` and `layout` are left alone: an ink stroke keeps the colour
it was drawn in. The picker (`COLORS` in the editor), `terms.mjs`, the import defaults and the kit's example now speak
the new set. A pigment reads as text through `color-mix(var(--c) var(--c-mix), var(--ink-mix))` — 80 % in light,
50 % toward white in dark, so a navy that is ink on marble is a lifted navy on slate — and fills through
`--btn-course` toward `--btn-mix` (black in light, white in dark) under `--on-c`; the ~40 rules that hard-coded 72–80 %
and `#fff` read the tokens now. A course code is its pigment as a word in small capitals, no tile behind it. The
sidebar's course number is a hairline box in the pigment that fills when the course is open.

**The screens, redrawn.** Home: the masthead, then course panels with the pigment as a rule along the top and "before
it" set off by one rule in the pigment rather than a tinted box; the agenda's dates as serif numerals; the section
bands as serif over one hairline. The course page: the slab head, the calendar leaf with the weekday cut into a band
of the pigment, the countdown at 68px. The week: the term as a row of serif numerals, the shelves with their names cut
in small capitals. The Library, To do and My notes: square-cornered marble cards, serif titles, pigment rules. The
notebook: the page list's head in serif, the top bar's title in serif, the ruled sheet unchanged except for its edge.
Dialogs and sheets: a veined title band over a hairline. The Ask bubble answers in the serif. Motion keeps the
assembly (`rise`) and loses every hover lift. The Electron window paints the new desk before the page does.

**What the editions keep.** Every token kept its name, so the ADPhi edition's overrides (§21) still land where they
did, and the kit builder needs no change. `--accent` is composed the same way inside `.course-screen`, `.np` and the
sheets. The promo harness (`Slate promo/`) records the old look and would need re-recording.

**Verified.** Home, the course page, a week, the Library, To do, My notes, the notebook page and both dialog kinds, in
light and dark, with no console errors; `vite build` clean. A note for anyone screenshotting through the hidden
Browser pane: CSS animations freeze on their first frame there, so a page mid-`rise` looks washed out — inject
`animation: none` before judging a screen.

## 20.61 The slab, and a ledger for To do (2026-09-19)

the student, on §20.60 an hour later: "more contrast, more space, more visually attractive — also I hate how the to-dos are
displayed in the To do tab." And, in passing: the Dock icon had not changed, and he had dropped CLA204.

**The slab.** The masthead of §20.60 was a lighter band on a light desk, and it read as nothing. A title is now cut into
the *opposite* stone: on the marble page the masthead is black slate with the veins in bone, on the slate page it is a
Carrara slab with graphite veins — the cap on the slate, the slate under the cap, as the icon has it. One rule does it
(`.slab, .home-head, .cx-head, .pghead, .cs-head, .dialog-title` in styles.css): every token a child reads — text, muted,
edges, fills, the accent and what sits on it, the pigment mix, the gilt, the veins — is re-declared from a `--slab-*`
set, so the buttons in the masthead, the course's small-capital code, the term's row of weeks and a sheet's close button
all set themselves for the ground without a rule of their own. The kicker over the title is gilt. The course head keeps
its pigment as a 6px spine along the top of the slab; a sheet's head keeps its 5px one. `veins.css` now carries the
texture in both inks (`--veins-ink`, `--veins-bone`), a little stronger than before.

**Contrast and room.** The desk is darker (`--canvas` #e3e2de), the sheet whiter (#fcfbfa), the hairlines heavier
(`--edge` .20, `--edge-2` .40), the ink blacker (#141517), the secondary greys darker (7.5:1 and 5.5:1 on the sheet),
and a pigment as text is mixed 84 % toward ink. Dark mirrors it. The screens' side padding went from 44 to 52px, the
masthead from 34 to 46px over the title, the title from 42 to 48px (a course's name 46px), cards from 22/24 to 26/28px
inside, the grid gaps from 18 to 24px, list rows from 10 to 12px, sidebar rows from 32 to 34px; a course panel's
pigment rule is 4px.

**To do as a ledger.** The grid of cards of §20.19 put forty near-identical tiles across the width, each repeating
"required · Open it" with its own frame, and the page read as one grey wall. It is a ledger now (`TodoRow`, todo.css):
each group is its heading in the serif with its count, cut over a double rule (gilt for the next class's group, oxblood
for what was missed), and each thing is one line read across — the tick, the course in its pigment, the title with its
kind and when under it, how crucial, the date in serif figures, and the one button that does it. A row is one hairline
from the next, and hovering tints it rather than lifting it. In a narrow pane the flags, the date and the button drop
under the title. The sheet that opens from a title is unchanged.

**One shelf.** With a fourth course the panels on Home wrapped, three across and one alone underneath. The grid now
has as many columns as there are courses (`--n`, set inline from the hub) and the panels narrow rather than wrap; only
a pane under 880px folds the shelf in two, and under 480px in one. The Library's course cards do the same.

**CLA 204H1, dropped.** Removed from `terms.mjs` (a note where it stood) and `syllabus.mjs`; stripped from `_hub.json`
(the course, its three deadlines, two tests, its grade line), `_plan-state.json` (four Plan pages), `_brain.json`'s task
register (thirteen tasks; its decisions and runs stay, they are history), `_inbox.json` (fifteen items) and
`_problems.json`; then `POST /api/plan/rebuild`, which rewrote `_plan.json` for four courses. Backups of every Hub file
sit in the session's scratchpad. The notebook folder and the Desktop mirror were left alone — they are the record of
the course — so `CLA 204H1` now lists under Notebooks as an ordinary one, and Home, To do and the Library no longer know
it. `_calendar-state.json` deliberately still lists the CLA204 events it pushed, so the calendar sync deletes them on
its next run rather than orphaning them; `Hub/Today/*.md` refresh on the next fetch. `Notebook 2`, empty, appeared at
17:15 today from someone's click on the sidebar's +; it was not removed.

**What the suite kept.** Four suites — plan, brain, calendar, review — were written around CLA204 as the worked
example of a course with no classes: the participation quiz each week, readings posted in a week's module, "Next Week's
Reading" filed a week early, an online midterm three days after FCS298's first quiz. That logic did not leave with the
course, so the course lives on as a fixture: `scripts/lib/terms-fixtures.mjs` holds its entry and its syllabus, and
`terms.mjs` and `syllabus.mjs` merge them in only under `SLATE_TEST_COURSES`, which `scripts/test.mjs` sets for every
suite and `scripts/lib/test-env.mjs` sets for a suite run on its own (it is the first import of those four). The guard
checks for `process`, because terms.mjs is bundled into the client. Nothing outside the suite ever sees the course.

**The calendar's colours.** `nearestGoogleColor` picked the Google Calendar colour by RGB distance, and every pigment of
§20.60 — navy, forest, bronze — is nearest to Graphite. A pigment is now matched by the swatch it stands for (the same
table the client remaps with, `src/palette.js`), and only then by distance, so ECO206 still books Blueberry, ECO208
Basil, ECO227 Tangerine; any hex outside the table is matched as before.

**The icon.** `/Applications/Slate.app` was built on 2026-09-18 at 16:31, before the marble icon landed in
`desktop/icon.svg`, so the Dock still showed the stroke tile. `npm run app` rebuilds the bundle (vite build, the icon
rendered to an icns, codesign) and the app was quit and reopened around it. If the Dock tile still shows the old
picture after that, it is the Dock's own icon cache: `killall Dock` clears it.

## 20.62 The frame in slate, the courses in their pigments (2026-09-19)

An hour after §20.61: "the courses need to be all in the same line on the home page, and there needs to be more
contrast and visuals in the entire app." The first was already in the source — Slate.app had been rebuilt before the
one-shelf change landed, so it was still serving the wrapping grid; the panels' fold point also moved from 880px down
to 640px, so only a genuinely narrow pane breaks the shelf. The second is the third ask for contrast, and this time the
answer is structural.

**Two grounds.** styles.css now declares the two grounds once, theme-free: the *slate ground* (bone type and hairlines,
a bone accent with ink on it, pigments lifted 52 % toward white as text and darkened 12 % as fills, gilt #d2b26c, bone
veins) and the *marble ground* (ink type, an ink accent with bone on it, pigments full strength as fills, gilt #8a6d3b,
graphite veins). A **slab** (every title band of §20.61) points at one per theme — slate on the marble page, marble on
the slate page — and the **chrome**, new, points at the slate ground in *both* themes. The `.slab` and `.chrome` rules
are generated from one map, so an element inside either reads every token it could need — text, edges, fills, accent,
the pigment mixes, gilt, veins, the danger red, the `color-scheme` of its scrollbars — from the ground it stands on.

**The chrome is black slate.** The sidebar and the top bar are the frame the marble page sits in, as the cap sits on
the slate in the icon: #1b1c1e in light, continuous with the masthead under it (the top bar loses its hairline on the
screens), #0c0d0e in dark, where it reads as the black under a dark desk. This is the dark rail of direction C that the student
passed over on the first morning; after three asks for contrast it is the move that changes the whole app at once. Take
notes in the sidebar is a bone button with ink type; the course numbers are filled tiles in their pigments, always, not
only when open; a notebook's colour dot wears a bone ring so it shows. The desk went darker again (`--canvas` #d6d5d1,
`--wash` #cbcac6) so the marble cards stand off it, and the dark page was layered — chrome #0c0d0e, desk #151618, cards
#242529 — where before the sidebar and the desk were one black.

**A pigment fill always wears bone.** `--btn-course` is 100 % in light and 88 % toward black in dark, `--on-c` white or
bone, in every ground; the pastel-with-ink fills of dark mode are gone. A course's panel head on Home and its card head
in the Library are now filled in its pigment with the code and the name in bone — the one-shelf row reads as four bound
volumes. The sidebar's badges, the To do count on each panel, a Library kind's icon tile, and the week's classes on the
timetable (solid blocks, bone type, the flag underlined instead of red) are the same fill.

**Weight elsewhere.** Every card heading sits on a 2px ink rule instead of a hairline; a plain button is outlined in ink;
the section bands on Home and the group heads on To do are a 3px double rule in ink. The agenda's dates are calendar
leaves like the course page's, the weekday cut into an ink band (gilt for today, oxblood for Overdue). Each shelf on a
week page has its pigment down its left edge and a 9 % wash on its head; each line of the To do ledger carries a 4px
spine in its course's pigment. The Track's cells are 14px tall, the Stack 18px. A note's card wears a 5px pigment rule.

**Verified** on Home, the course page, a week, To do, the Library, My notes and a notebook page, in both themes, no
console errors; `vite build` clean; the full suite green. Slate.app rebuilt and reopened. The promo harness still shows
the old look.

## 20.63 Graphite, the flags, and the week's load (2026-09-20)

the student, on §20.62 the next day, in French: a little dark; he wants more wow, useful interactive graphics; the words beside
a task on To do — required, late, important — should be recognisable, not washed out; ask questions. And, in passing:
rethink existing categories more visually rather than add new ones. Asked with a mock of each, he chose a **graphite**
frame over black or a light rail, the **week's load** as the one graphic, flags **filled with icons**, and **English**.

**Graphite.** The chrome and the light theme's slabs are #34373c now, not #1b1c1e — the same structure, the slate lifted
a tone — and the desk went back up to #e7e6e2 so the page no longer reads as grey on black. On a dark ground a pigment
fill is now the pigment *lifted* 58 % toward white with ink type (`--g-dark-btn-course`, and the dark theme's root
tokens), not darkened with bone: a darkened navy tile on graphite was invisible, and a lifted one is what the sidebar's
badges, the timetable's blocks and the course heads on the dark page needed. On marble a fill is still the full pigment
with white on it. So: **a fill wears the opposite of its ground.**

**The flags** (`src/components/Flags.jsx`, `.flag` in screens.css). They were grey pills that all read alike. Each
meaning has a fixed colour and an icon now, on every screen that draws a task — the To do ledger, the week's to-do, the
course page's two lists, the task sheet, Home's agenda: *Missed* an oxblood fill with a clock, *Crucial* an oxblood
outline with a warning, *Important* gilt with a star, *Graded* ink with the cap from the icon (and the points),
*Required* an ink outline with a tick, *Optional* a dashed grey, *Not open yet* grey with a lock. `rowFlags` orders
them — late, then how crucial, then what it is for the mark — and a screen that already says "before your next class"
leaves *Important* out; Home's agenda keeps only *Graded* of the three natures for room. The ledger's date column says
"6 days ago" alone now; the flag says missed. The old `.prio` and `.nature` rules are gone.

**The week's load**, inside the "This week" card rather than a card of its own. Over the timetable's day heads there is
a strip (`load` in Timetable.jsx, computed on Home from the same rows the agenda draws): a bar of the day's class hours
in the courses' pigments, scaled to the week's heaviest day, a bead per thing wanted by that day in its course's
pigment, and the numbers under them. Hovering opens a slab-coloured reading of the day — each class with its hours,
the first six things wanted, a count of the rest — and clicking opens **To do narrowed to that day**: App carries
`todoDay`, Todo takes `day`/`onDay`, the title becomes "2 things on Tue Sep 22" and a gilt chip in the filters is the
way back to every day. The strip's cells at the week's end open their reading to the left so it stays in the card.

**Two existing categories redrawn.** To do's masthead carries a ring of done over everything, in bone on the slab. The
week page's row of numbered chips is the course page's `Track` now — one cell per week, its fill saying what the week
holds (from `/api/term`), a flag over a week with a test (`testFlag`, shared from Viz.jsx), the current week ringed in
gilt and the week being read ringed in ink with its number underlined.

**Verified** on Home (the strip, its reading, both themes), To do (the ledger, the day filter, the ring, a task sheet),
the course page and a week page, no console errors from the app; `vite build` clean; the suite green; Slate.app
rebuilt and reopened.

## 20.64 The library as a room, the course as a cover, the week as a desk (2026-09-20)

"Rethink the way the information is displayed — the layout and the way it is presented — to make it more visually
attractive and interesting, in the course and week views and the rest of the app." Four rounds of mock-ups and one
firm steer: *rethink the categories that exist, more visually; do not add new ones.* What he took, and what he refused,
decided the shapes below.

**The library is a room of shelves.** Every document is drawn as the object it is, in CSS from the course's pigment and
the two stones: a bound *volume* with its title set down the spine (bottom to top, the European way) and as thick as
what it holds; a *cassette* for a recording or a video, its title on the label, the reels in the window; a ruled
*notebook* for your own notes; a *card pinned* to the shelf for a page that only points somewhere — a forum, a quiz, a
hand-in. `shapeOf` in Library.jsx decides which; the spine's width is `26 + 8·PDFs + words/350`, capped, and volumes on
one shelf differ a little in height by a hash of their path, as on a real one. Objects stand on planks — a grid of
64px columns with rows of one height and the plank drawn by a repeating gradient, dense-packed, cassettes and cards two
columns wide. Level one is four bookcases on one shelf, each with a small shelf per kind where every document is a tiny
spine, cassette, notebook or card: the count, made physical. Level two is a course's shelves; level three one shelf on
its own; search is a shelf of matches. Hovering or tabbing to an object raises a plate over it — the title, what it is,
where it lives, and the other ways in (the week, the solutions beside the questions, Quercus or MyMedia); a cassette
with no transcript wears Transcribe on its corner. He chose spines with vertical titles over covers, and the whole
family — but *only in the Library*; the week keeps flat cards.

**The course page is bound in its pigment.** The masthead of every other screen is graphite; a course's is its own
pigment deepened 14 % toward black, with bone type and bone veins — each course page has its colour, as a volume has
its cloth. The slab's tokens are re-pointed at the slate ground there whatever the theme, and every pigment-coloured
mark inside the cover (the code, the Track's cells, the legend) is set in bone by re-declaring `--c` on the cover's
children, because the pigment is the ground now. Three numbers are cut under the name: days to the next class with
how much of its list is prepared, days to the next test, the mark so far. Under the cover, one new band and nothing
else new: *the next two weeks* — this course's load day by day, Home's strip kept to one course (`LoadStrip` in
Viz.jsx, shared with the timetable, where it is `display: contents` so its cells fall into the day columns). Hover
reads a day out; click opens To do narrowed to that day *and that course* (`todoCourse` in App). Everything the page
had is kept. He refused a term timeline, a grade trajectory, a reading room of drawn objects ("too childish") and three
plainer layouts before this.

**The week is a desk beside its shelves.** Left, the week as seven rows — the day in the serif, its classes as blocks
in the course's pigment with their time, room and topic, and how many things are wanted by that day; today gilt, days
gone by dimmed — then the week's to-do, whose flags, date and way in now wrap onto a line of their own under the title.
Right, the shelves two by two, each document a flat card with the pigment along its top; the problem sets and what
another week holds run the width. The one-line list of the week's classes went, since the desk says it. The left
column's track is `minmax(0, 1fr)`: an implicit `auto` track grew to the to-do rows' min-content and the whole column
overflowed under the shelves.

**Home wears a dial.** The masthead is a grid now — the title block spans two rows, the actions sit top right, and
three numbers of the day sit under them on the sentence's line: hours of class today, things wanted today, things
missed. Below, the timetable and the agenda share a row, two thirds and one third, the agenda's leaves a size smaller
and its buttons under their titles; under 1100px they stack again.

**Taken out again the same hour.** the student saw the room of shelves and the dial and asked for the Library and Home back as
they were that morning: the bookcases with their bar charts, the kind tiles, the document rows; the masthead with its
sentence, the timetable, then the agenda across the width. The course cover, its strip and the week's desk stay. The
object library is recorded here because it was built and judged, not because it exists: `shapeOf`, the spines, the
planks and the plate are gone from the source.

**Verified** in the browser, light and dark: Home, the course cover and its strip with the plate open, the week's desk
and shelves, the library's three levels with a plate open; no console errors on a fresh load beyond a transient 500
from the dev server's own reload during editing. `vite build` clean; all fourteen suites green.

### 20.65 The contents column (2026-09-20)

"Rethink this part, cause I can't even use it to navigate through the app — it takes space and doesn't look good and is
confusing." The page list: the column between the sidebar and the page.

**What it was.** §20.27 took out the file tree and stood a stack of cards in its place: a tinted tile, the week's name,
"6 inside · Sep 8" (the count of its pages and the folder's date, which was the sync's date on every week), and the
week's pages as chips in whatever order the folder had them — Notes last in one week and first in the next — wrapping
onto three lines. Two hundred and fifty pixels a week; a term was three screens of scrolling, and a click on a week's
card left the column behind for the week screen.

**What it is.** A table of contents. A week is one numbered line: the numeral in the serif, the week in small capitals
with its dates at the right, its topic under them in a medium weight, two lines at most. Under a week that holds
something, a strip of small icons in the shelves' order — notes, lectures, recordings, study sheets, problems, then the
reading and anything else — each with its count, each opening that page directly; a shelf still empty is dim; the one
holding the open page is filled in the course's colour, full on marble and lifted on slate like every fill since
§20.63. A week still to come with nothing filed is one thin line. The current week's numeral, name and dates are gilt,
as today is on the timetable; the week holding the open page wears the colour's 2px bar on the sheet's ground. Pages
that are not weeks — the term's own page, a syllabus — are plain rows under a double rule, the way the sidebar reads,
their subpages as chips. The filter stays and flattens the section into rows that carry their trail ("Week 2 (Sep 14)
· Lectures"). Nothing unfolds, nothing moves under the pointer, and a thirteen-week term is one screen.

**Where the words come from.** The topics, the dates and which week is now come from `api.term`, the reading the course
screen makes for its term grid; the column asks for it when the section is a course's term (two path segments and
week-titled pages), matches by the week's label, and falls back to the folder's own dates. The routes are unchanged: a
week opens the week screen, a shelf opens that shelf on the week screen (`weekTabOf`), Notes and a reading open as pages.

**Verified** in the browser at 800×500 and 1440×900, light and dark: thirteen weeks with their topics, three strips, the
Notes icon opening the notes page with the column still standing, the filter's rows, a week's line opening the week
screen, the plain row under the rule. Fourteen suites green; `vite build` clean.

### 20.66 Claude's card, cut to size (2026-09-20)

"This is too long, and there is a bug: make the box the same size as the others next to it, with the see-it-all thing."
On Home's foot, Claude's decisions stood at 1,723px beside a morning note of 514 and a new-files card of 328: a
twelve-line question at the card's width, then six decisions with their whole reasons under them.

**Compact by default.** The question is clamped to four lines, and clicking it opens the card. Three decisions, each on
one line with its reason on one line under it, the whole reason in the tooltip; "Show all 10" opens every decision with
its reason and the question in full, "Show fewer" folds it again — the same link the new-files card wears. Waiting
shows three until then. The card is 537px now, the note's height.

**The bug was words.** A task edit's summary ends with the fields the patch named — `(graded, dueTime)`, `(level)` —
which are keys, not words. The row shows the task and, after it, what changed in words: "graded · time", "how crucial",
"class · how crucial" (`FIELD` in Home.jsx). The record in `Hub/_brain.json` is unchanged.

**Verified** in the browser, light and dark: the three cards in a row, Show all to ten rows and back, the fields worded.

## 20.69 One set is one row, and what is already in is ticked (2026-09-28)

"Some to-dos are duplicates. The WebAssign one shows with the right date and everything, and another one shows *week of
September 21st, date unconfirmed*. It's the same thing, and I can only click one done. The app should only display one.
And the morning check should fetch grades, and if I did something that was in the assignments but just didn't click it
done, it should click it for me. I shouldn't have to check the app to mark something I didn't use the app to do."

**Two rows for one set, twice.** To do carried Claude's *WebAssign Fall-Ex2 - up to three attempts before it closes*
(due Fri Oct 2, tickable, ticked) and, below it, the outline's *WebAssign Fall-Ex2 · week of Sep 21 · date unconfirmed*
(a hand-in row, which cannot be ticked); and the same pair for Fall-Ex3. §20.52 folded a hand-in into Claude's task by
course, URL and day — but Claude's Fall-Ex2 task links the set itself (`…/Assignment-Responses/last?dep=…`) while the
outline row links `webassign.net`, and Claude's Fall-Ex3 task has no day of its own (it read *by Sun Oct 4*, the week's
end) while the outline says Oct 9. So neither pair matched. And the outline's row leaves the hub only when the set's row
on the Problems page is ticked, never when a Plan task is — which is where the student ticks.

The rule now: a WebAssign row (`d.set`) and a task in the same course that names the set as a whole word (`mentions`:
*Fall-Ex2* is in *WebAssign Fall-Ex2 - up to three…*, not in *Fall-Ex21*) are one thing. `rowsFor` (src/todo.js) shows
the task — tickable, at Claude's level — lends it the set's due day when it has none (Fall-Ex3 now reads *due Fri Oct 9*,
the Friday-plus-seven the professor gave for Ex1 and Ex2 on Sep 22) and the points; once any task naming the set is
ticked, wherever it sits (Fall-Ex2's is in Week 4, the set is Week 3's), the outline row is gone. The hub agrees:
`webassignDeadlines` (scripts/lib/problems.mjs) skips a set any Plan page of the course has ticked, and `buildPlan` drops
it from `plan.deadlines`, so Home's *next marked thing* and Next 7 days stop naming it at once. `syllabus.webassign.
confirmed` stays false for ECO227 — flipping it would title the rows by topic and send them to Google Calendar, which is
the student's call, not this fix's.

**What is already in.** Work happens where it lives — the forum, the quiz, WebAssign — and was only done in slate once
the student came back and ticked it. Now the morning fetch records what Quercus knows, and the plan pass ticks the task:

- `quercus-sync.mjs` writes `Hub/_hub.json` → `handedIn`: every assignment Quercus has in — submitted, excused, or marked
  without a hand-in (a checkpoint quiz sat in the tutorial) — under each link a task may carry (the assignment, its quiz);
  a zero Quercus gave for a missing hand-in, or any mark on a submission it calls missing, is not "in". Forums are found
  by the post itself: for every graded forum and every forum an open task of the last plan links, one `/view` call, and
  the student's own entries in it, at the top (his post) or under someone else's (a reply). Before, a submitted assignment simply
  vanished from `deadlines` and nothing else knew.
- `doneEvidence` (src/plan.js) says what makes a task done: its link is a handed-in assignment or quiz (whatever its
  words, query and trailing slash aside); its link is a forum with his post — or his reply, when the task's words ask for a
  reply, so *Post the initial post* and *Reply to a classmate* on the same forum are told apart; the handed-in title,
  when it carries a number, is a whole phrase of the task's words and the task is itself the hand-in (kind quiz, due,
  participation, write, or graded) — *Sit Quiz 1* is, *Revise before Quiz 1 opens* is not; a WebAssign set whose Problems
  row is ticked; or Claude's own word (below).
- `mergeContainer` ticks a generated line that carries `auto` **once**: `_plan-state.json` keeps, per page, every line
  ticked that way with when and why, and a line in that memory is never ticked again — the student unticking it is final. `plan.mjs
  --pages` reports them as `autoTicked`, the run's morning note says *Ticked for you: …*, and the task sheet of a done row
  says *Ticked for you by the morning check — your reply is on the Quercus forum (Sun Sep 20)*.
- What code cannot match, Claude can: `brain.mjs task done <id> --reason "…"` records `done` on the task (a decision, with
  undo); the next pass ticks it once. The brain prompt's step 6 asks for it on evidence only — a mark in `handedIn` or
  `grades.recent` under another name than the task's link, the WebAssign answer notes, his own words — and never because a
  day went by. `task done` refuses a task already ticked or already marked; undo takes the word back and unticks the line
  only if it was that word that ticked it. The rule "never edit a tick" becomes "never tick or untick a line yourself".

WebAssign itself has no API and Quercus carries no WebAssign column for ECO227, so a set submitted there is ticked by its
Problems row, by Claude reading the answer note the webassign skill writes, or by the student — not by the fetch.

Checked on a clone of the notebooks against the real Quercus: `handedIn` found his Forum 1 post (Sep 18) and reply
(Sep 20); with the two forum tasks unticked in the clone, one pass ticked exactly those two with those reasons, and a second
pass wrote nothing. On the live data, To do shows one Fall-Ex2 row (ticked) and one Fall-Ex3 row due Fri Oct 9.
Tests: the fold, the evidence rules and the once-only merge (test-plan); the forum post, the reply, `task done`, his
untick, undo (test-brain); a set ticked on another week's Plan page leaves the hub, *Fall-Ex21* does not close *Fall-Ex2*
(test-problems).

## 20.70 The second review: what the uncommitted work held, and what changed (2026-09-29)

Before the copies went public (§21.10), everything since §20.59 — the Windows road, the day, the textbook, the brain as
a team, all uncommitted — was read by four readers (server and desktop; the client; the morning's scripts; the sharing
layer), each finding traced to a code path before it counted. Sixty-nine held. What they had in common: two writers of
one file with no lock between them, a Mac habit that a PC does not share, and a rule declared in one place and missing
in the next.

**What a brother would have met.** A brief larger than 64 KiB — any first run — reached the Pro copy's session cut off
mid-JSON: on a Mac a pipe takes stdout asynchronously and `process.exit()` right after the write dropped the rest
(`run.mjs` now exits when the write drains). ffmpeg was "installed" and never there: the uv package fetches its binaries
the first time it runs, and nothing ran it. Every PDF export failed in a kit, whose merge script is not shipped (one
page now needs none; several say so first). On a PC — traced in the code and Electron's rules, not yet seen on one: the
window had no frame buttons (`hiddenInset` is a Mac style); a
second double-click started a second app on the same notes (a single-instance lock, Windows only — two editions on one
Mac must still both open); an npm-installed `claude.cmd` could never be started, so setup said "not logged in" for ever
(`platform.mjs spawnable()` starts what the shim wraps, no shell); every console program the app started flashed a
window; Reveal and Open did nothing (`open` is a Mac program); a device name (`Aux`, `NUL`) could become a page; the
notes could land in the code folder (§21.10); PowerShell output of an accented folder name came back garbled; a missing
route file stopped the server, since its message has backslashes. The kit carried a dropped course's id and professor
in a test fixture the guard never read.

**Two writers.** The day (`Hub/_day.json`): the screen's acts, a Draft, the day agent and `brain.mjs day set` each read
a date and wrote it whole, so a confirm could vanish under Claude's draft — the one thing §23 says never happens. Every
read-modify-write of a day now goes through `serialDay` (in order within the server, under the brain's lock across
processes). The sync: two at once (the button, the morning, the team) downloaded the same file twice and each wrote back
the memory the other had changed; one sync at a time now (`Hub/.tmp-sync.lock`, a second exits `busy`), and the
checkpoint is a three-way merge against what it last read, under the brain's lock. The run lock was read-then-write
and trusted a process that had already exited; the plan's `auto` ticks could be written over by a second pass, and an
unticked line ticked again. Each now takes an exclusive lock and merges at the write.

**Rules half-wired.** Cancelled classes never reached the brief (it looked them up by a key `setClass` does not write),
so a cancelled class got a prep task. The stall of `fetchSafe` was not counted as "no network", so a half-up network
cost minutes per request and the morning's note blamed "a random line". The timer's *Done* un-ticked a task ticked while
it ran. The calibration learned against the already-calibrated minutes, and settled at the square root of the truth.
A day ended at midnight on the screen though it runs to 03:00. A task of his own changed its id when ticked and its
block went "missed". `daysLeft` counted hours, not Toronto days; "Latest" and "Attestation" were tests.

**Left open.** Three found in the brain's own files — a run that is not `current` does not yield; `log --run last`
reads the run in progress; the stale-lock takeover can admit two — went to the session that owns them. On a real PC,
still unproven: the toast's app id, the UTF-8 console, the shim's resolution, the frame. `refile.mjs` and
`study-sheets.mjs` still write the sync's memory without the lock. Dictation's worker outlives a server killed by
SIGTERM. Claude Code on Windows warns that `Write(**)` and `Glob(**)` permission rules are never consulted.

## 22. Today's work (2026-09-20)

"One new feature, its own page: a schedule for the day that shows me what I need to do and what I should do, with
parameters — what to focus on, what to ignore, only the required things, in order of priority — that takes into account
my timetable, what I have going on, and an optimal amount of work to still be catching up: review the study sheets of
the classes I missed, on top of the to-dos I already have. And it goes into the morning routine, the brain, everything."
Twenty-five questions, then seven, asked and answered the same evening; the answers are the design.

### 22.1 What the student decided

- **A fifth sidebar screen, *Today's work*, one day only.** Not under the Library (documents) and not a mode of To do
  (the ledger): time is its own thing. The hour axis on the left, the same plan as a ledger on the right.
- **The budget is a standing number per weekday**, overridable on the day, and *it adapts*: "it isn't fixed, it depends
  on what needs to be done." So it is a target, not a cap — what cannot wait and what is crucial stretch it, optional
  work fills it.
- **Crucial work is always there.** No dial drops it; only *Not today* on the task itself, and that lasts until 07:00.
- **The dials are all three**: per course (focus, ignore), per kind (no readings today), per task (not today). Standing
  defaults in a preferences file, Claude's morning steer on top, the student's own flips on top of that; everything resets at
  07:00 to the standing defaults plus the new steer.
- **Order**: "the ECO courses usually win, then it is about urgency, deadline, importance, weight in the grade." So a
  ladder (§22.2), not a formula, so that every row can say which rung it sits on.
- **Catch-up**: everything counts — missed tasks, the study sheets of missed sessions, recordings not watched, readings
  never ticked, problem sets never tried — "but I should be able to tick that one isn't very important."
- **Durations**: "Claude guesses it in the morning; after a task is done it asks how long it took, learns from it and
  recalibrates." And a timer: "start working, with a timer I can open when selecting the task, I can pause it and
  everything" — on every task row, everywhere.
- **Attendance**: "a checkbox, attended or not, on the calendar in Home."
- **The window**: "try nothing after midnight if possible, but I want the possibility to slide them till 3." Meals
  protected, "dinner a bit later"; twenty minutes to walk to every class and back; the fraternity meeting every Monday
  evening, 20:30 to 23:30, with the walk.
- **During the day**: a skipped or unfinished thing "falls back into To do until the next 7 AM run, which reallocates
  it"; re-packing both quietly as the day runs late and on a button; blocks he can drag across the day by hand.
- **The morning note and the email carry the plan; Google Calendar does not, "not until I validate it."**
- **Sunday**: planned against done, "with analytics and graphs."
- **Editions**: "for now just for me, and then maybe ship it."

### 22.2 The ladder

How the student weighs his day, in his words — written into `scripts/day-prompt.md` for Claude, who decides the day (§22.7), and
into the packer for the draft he is shown. A rung is a name for a reason, not a rule that decides anything.

Rung 1, *cannot wait*: due today, or due tomorrow and longer than the free time tomorrow holds before it is due. Rung 2,
crucial. Then important by tier, normal by tier, catch-up, optional — with two tiers (the three ECO courses, then FCS298)
that is rungs 1 to 8. Inside a rung: fewer days left first, then the earlier hour, then the heavier share of the mark. The
tiers are a line in the preferences. A test within three weeks does not leave its backlog on the catch-up rung: what it
covers is spread evenly over the days left and placed as ordinary work of its course, a quota per test per day. Backlog
marked *minor* sits with the optional. The catch-up dial: *light* keeps no reserve, *normal* keeps a quarter of the target
for it once the fresh work is placed, *heavy* puts it before the fresh normal work.

### 22.3 The packer

`src/dayplan.js`, pure, bundled on both sides like the terms. It does not decide the day (§22.7): it drafts a proposal for
Claude's brief, checks Claude's plan against the hours, and slides his blocks when the day runs late; with the brain off
it is the plan, the way the rules once filed pages. Either way the same `packDay` on the same inputs — the rows To do
already builds (`rowsFor`, past `'open'`), the day's classes and calendar events, the preferences, the day's dials, what
is pinned, skipped or minor, the work log's ratios — gives the same draft. Time is minutes past midnight; the window may
run past 1440 to the hard end at 1620 (03:00).

- **What the day holds**: classes (the plan's, so cancellations and announced times count) with the walk on both sides;
  the calendar readback's timed events, cut to the day (one running past midnight ends at 25:00, one begun the day before
  starts at 00:00; the sync's own class events and all-day rows are not busy time) — an event that is *workable* is drawn
  and not busy: a title holding *Bus* or *Train* (`workable.titles` in the preferences), an id listed there, or the day's
  own toggle on the event, which wins either way; the fixed engagements with their walk;
  the meals, slid five minutes at a time up to an hour when something sits on them (a Monday's dinner lands at 19:25,
  between the walk back from the tutorial and the walk to the frat) and dropped for the day when nothing fits; the past,
  when re-packing from an hour. Free time is what is left, in gaps of fifteen minutes or more.
- **Placing**: ladder order, earliest fit, ten minutes of air after every block. What is wanted before a class lands
  before the walk to it; what is due at an hour lands before the hour; what is wanted "today" with no hour may run past
  midnight, never past 03:00. Rungs 1 and 2 stretch the target and may spill into the late window; the rest stop at the
  target, with fifteen minutes of slack rather than leave a thing out for a quarter of an hour. Only a task over ninety
  minutes is cut, never into pieces under forty-five, never a quiz; what still finds no room is reported with its reason
  — *budget*, *no room*, *spread before the test* — never forced.
- **Minutes**: Claude's `minutes` when he gave them, else the kind's default, times the ratio the work log has learned for
  that course and kind, rounded up to five, never under ten.
- **In the room.** A quiz attached to a class whose link is not a Quercus quiz, or anything Claude gives zero minutes, is
  not work: it is written inside the class block on the day — *17:00–19:00 · ECO206 · Tutorial · FE 230 · during it:
  Checkpoint quiz in tutorial* — never placed, and not shown at all on a day its class does not meet. An online quiz with a
  window is work. The rendered day (`renderDay`, the page, the note, the CLI) lists the classes with what happens in them,
  the events and the fixed engagements in the order of the day beside the blocks; meals and walks are not lines.
- **Re-packing**: from an hour, the morning stays as it was and only the future is placed; a block pinned by a drag, or
  running on the timer, keeps its place and its air; the quiet re-pack (`only`) keeps the set of blocks and slides them in
  their order — a prep slid past its own class is reported, not moved.
- **Defaults** (the student's numbers, in `Hub/_day-prefs.json` the first time the script runs): Mon 1h30, Tue 4h, Wed 3h, Thu 4h,
  Fri 5h, Sat 4h, Sun 4h30; weekdays from 09:00, weekends from 10:00, to 24:00, hard end 03:00; lunch 12:30, dinner 20:00,
  45 minutes each; the frat Monday 20:30–23:30; walk 20, air 10, gap 15, slack 15; split over 90 into pieces of 45 or more;
  read 45, watch 60, problems 90, review 40, write 120, quiz 30, hand-in 60, participation 45, prepare 60, other 45,
  your own 30.

`scripts/lib/day.mjs` is the day on disk: `gatherDay` reads everything once (the plan's rows for the date, the classes of
the day and the next, the calendar's events cut to the day, the preferences, the work log, and what the student did to the day
as it stands), `briefDay` is what Claude reads, `checkPlan` is what his plan must pass, `buildDay` is the one shape of
`Hub/_day.json` whoever decided it, `writeDay` the two files (the page registered once after *Next 7 days*).
`scripts/dayplan.mjs` is the script: with the brain on it decides nothing — it writes the draft to `Hub/_day-draft.json`
for the brief, records the student's facts (`--not-today`, `--minor`, `--workable`, `--busy`, the dials) into the day as it
stands, removing a block the fact removes with the reason it left, and `--slide --now` moves Claude's unfinished blocks
from that hour, the same set in the same order, a block that no longer fits before its class reported rather than moved
past it; with the brain off it packs and is the one writer. A fact persists until the day changes. The edition flag
`work` (src/edition.js) is on for slate and off for the brothers: the packer, the checks and the screen are
edition-neutral, but the light brain prompt does not yet say `minutes` or plan a day.

### 22.4 The brain, the screen, the timer, the review (built 2026-09-20, §22.8)

- **The brain** (§22.7). Step 3 reads `Hub/_attendance.json` and the work log's calibration; step 6 gives every task its
  `minutes` — honestly, from the material, `0` for a thing sat in the room — its `weight` (the share of the final mark,
  when the syllabus says it) and `splittable`, and writes the catch-up for a class the student missed: its study sheet if one
  exists, else the recording, else the slides, at *important*, once; `checkTask` takes the three fields. Step 11 is the
  day: `scripts/day-prompt.md`, the brief, `brain.mjs day set`. The morning note carries the day's blocks, the email a
  *Today's work* section.
- **Attendance.** *Were you there?* in the class sheet once the class has met — Yes, No, or neither — on Home and on
  the day's axis; a No wears *missed* on the block and becomes catch-up in the morning. `Hub/_attendance.json`,
  `GET|POST /api/attendance`, never a decision.
- **The screen** (`src/components/Work.jsx`, `work.css`; the fifth sidebar entry). The masthead slab: the date, who decided
  the day and when, the steer in gilt, four numbers — planned of the target, free, worked, of class — and the ring of
  done as on To do; *Plan my day* or *Re-plan from now* (a Claude session, §22.8) and *Slide from now* (no session). The
  dial rail: the target with its stepper and the weekday's standing number, a chip per course in its pigment cycling
  focus, normal, ignore, a chip per kind, *Required only*, the catch-up dial, *Reset dials* — a dial sets a row aside at
  once, and Claude weighs the rest at the next Re-plan. Left, the day on the hour axis, one column: what the day holds in
  the left lane — classes in their pigment with what happens in them written inside, the walks hatched, the events in
  graphite and a workable one dashed with *I can work here* on it, meals and the frat dashed — and Claude's blocks in
  the right lane as marble cards with the course's spine, his reason under the title, drag to an hour or from the foot
  to a length (pinned where it lands, or the server says why not), the dashed midnight line, the red now-line. Right,
  the ledger in the To do rows: the tick, the course, the title with its minutes and his reason, the flags, the hour,
  *Start*, the way in, unpin, *Not today*; then *Not placed today* with the reason on each row and *Fit it in*; then
  *Set aside* with *Back in*. The foot: this week so far — per day, planned against done, in the courses' pigments,
  a tick on a finished day — and how the estimates run per kind.
- **The timer** (`WorkTimer.jsx`, `Hub/_work-log.json`). *Start* on a block, on any To do row, in the task sheet. A pill
  at the foot of every screen: the clock, the thing, its planned minutes, Pause, Resume, Stop. Stop asks *Done?* — Done
  ticks the task where it lives (the session carries the handle) and writes the session; Not yet writes it only. The
  session lives on the server, so a reload or a restart loses nothing. A tick without the timer asks *How long did it
  take?* (`HowLong.jsx`): five chips around the estimate, an exact number, Skip. Each finished session with a plan moves
  the calibration a third of the way toward its ratio, per course and kind and per kind, clamped to ¼–4×; the day's
  minutes and the brain's brief both read it.
- **The review.** *Work this week* on the Sunday page: planned against done, per course and per day, the days finished,
  how the estimates run per kind — from `Hub/_day-log.json` (one line per planned day, written with the day) and the
  work log. The graphs live on the Today's work foot.
- **Routes** (`server/routes/day.js`, mounted only where the edition has `work`): `GET /api/day`, `POST /api/day/fact`,
  `POST /api/day/block` (pin, unpin, fit), `POST /api/day/slide`, `GET|POST /api/day/prefs`, `POST /api/day/replan` and
  its `/status`, `GET|POST /api/work`, `GET|POST /api/attendance`. Calendar: `pushToCalendar` in the preferences, off.

### 22.5 Decisions taken by default

Question 5 (the order among the ECO courses) went unanswered: the three are one tier, FCS298 below; rungs 1 and 2 still
catch an FCS quiz that is due. The window opens at 09:00 on weekdays and 10:00 at weekends. Lunch 12:30, dinner 20:00,
each sliding up to an hour. "Nothing before midnight" is read as *nothing after midnight*: the packer closes at 24:00,
a drag may go to 03:00, and only rungs 1 and 2 spill. Question 22 (editions): built for slate, the flag off for the
brothers until it is proven.

**A limit to know.** The calendar readback runs only at 07:10 from the cron, because the Sync button never reaches a
connector: an event added to Google at noon is invisible to the packer until the next morning. Dragging covers that day.

### 22.7 Claude is the brain of the day (2026-09-20, later that evening)

the student, shown the packer's plan for Tuesday: "ok, but Claude should be the brain and do all of it, not a script." He is
right by the app's own rule (§20.37: nothing in slate decides, Claude does), and §22.3 as first built inverted it —
a script weighed the rows and Claude was to supply numbers. Redrawn the same evening:

- **The decision is Claude's**, through `node scripts/brain.mjs day set`: `{ reason, steer?, blocks: [{ row, start,
  end, why }], waiting: [{ row, why }] }`, `--date` for another day, `--from HH:MM` to re-plan from an hour with the
  day up to it standing as it was. `checkPlan` refuses the one thing wrong and keeps nothing of a refused plan: a row
  that is not today's, one that happens in the room, one the student set aside (*Not today*, or a dial of his), a block before
  the window or past 03:00, on a class, a walk, a meal, an event that is not workable, on what the student pinned, on what
  stands, on another of Claude's own, after the hour a task is wanted by (before the walk to its class, before a
  hand-in's hour), without a `why`. What is neither placed nor accounted for is shown as *not weighed*. The decision is
  recorded in `Hub/_brain.json` with its reason; `undo` puts the file and the page back as they stood.
- **What Claude reads**: `brain.mjs day brief --json` — the window, what the day holds (classes with what happens in
  them, the walks, the events and which are workable, meals, the frat), the gaps left and the hours past midnight,
  tomorrow's free time, every row with its minutes, its deadline, its level, whether a test covers it, what a dial says
  about it and Claude's own reason for it, what the student did to the day, the day as it stands, the work log's ratios, and
  the packer's draft — arithmetic, not judgment, to keep, change or discard. Times in the brief and in a plan do not
  wrap: `25:30` is half past one the next morning, so a late block can be said back the same way.
- **How the student weighs his day** is prose in `scripts/day-prompt.md`, his words: what cannot wait, then crucial always,
  "the ECO courses usually win, and then it is about urgency, deadline, importance, weight in the grade", the target
  that stretches only for those, catch-up before optional, a slice a day of what a test covers, nothing after midnight
  if it can be helped and never past 03:00, meals and walks where they are, a reason on every block and on what waits.
- **A dial is two things now**: a word to Claude (the brief carries it) and a fact the checks enforce (a row a dial
  set aside cannot be placed). *Not today*, a pin, a workable toggle and a tick are the student's own acts and never wait
  on Claude: the script records them and rebuilds the day around his blocks; a slide moves them when the day runs
  late. A re-plan on a button is a Claude session with `--from now` — the route and the screen are to build.
- **Contract v19**: the day too is Claude's, `day set`, never `Hub/_day.json` by hand.

### 22.8 Opus is the brain (2026-09-20, night)

"Just build it now with Opus being the brain, and update everything that needs to be updated — the brain, the scheduled
task, Claude's reasoning." So: `Hub/_settings.json` → `"model"`, set with `brain.mjs settings --model opus`, is the
model every brain session runs on — the Sync button (`--model` on its spawn when the brain is on), the day's re-plan
from the app, and the light routine's sessions (which already read it). The re-plan is `POST /api/day/replan`: one
`claude -p` on `scripts/day-prompt.md` with an appended note naming the date and the hour, the model, forty turns, a
four-dollar cap, `brain.mjs`, `dayplan.mjs` and `echo` the only commands, no connectors; the app polls its status and
reads the day Claude wrote. The 07:00 scheduled task is a Claude session of the desktop app's own, and the task tool
exposes no model of its own: its model is the app's, so *Opus for the morning* is the model chosen in the app, not a
line in a file. The task's prompt is unchanged — it defers to `brain-prompt.md`, where step 11 now is.

### 22.9 Today and tomorrow (2026-09-20, 23:00)

the student, at eleven at night, on the first screen: "It looks like shit. There's nothing on there." Two things were wrong,
one small and one real. The small one: the rail's chips were drawn as fixed 32-pixel squares — `week.css` already owned
the `.wk-` prefix (the Week screen's day chips), and in the built bundle its rule won; the day screen's classes are
`.dw-` now, and the collision cannot recur. The real one: at 23:00 on a Sunday nothing had been decided, the day held
seventy minutes, and the screen said so with a void. "I'm not going to do any work tonight, so run the brain, and I
should be able to see today *and tomorrow* — the brain needs to do both — and I can just move some things, like, I'll
do it tomorrow."

So the screen holds two days, and the brain decides both:

- **Two days in one file.** `Hub/_day.json` is `{ version: 2, days: { "<date>": day } }` — today and tomorrow, each
  decided on its own, yesterday kept a day for the review; the first shape (one day at the top level) is read as that
  day. `gatherDay` reads its date's entry; `writeDay` merges; a decision's undo puts back one date. `Today's work.md`
  holds both days under their own headings. `brain.mjs day show --date` reads one.
- **The switch.** *Today · Tomorrow* in the masthead, each with what stands ("2 blocks · 1h15", "not decided"). The
  title, the numbers, the dials, the axis and the ledger are the day chosen; the now-line, *worked* and *Slide from
  now* are today's alone. *Plan tomorrow* is the same session as *Re-plan from now* with the whole day to decide and
  no `--from`; the morning's step 11 decides today and then tomorrow, assuming today's blocks get done.
- **Never a void.** Before Claude has decided a day, `GET /api/day` carries the packer's draft, and the screen draws it
  as a draft — dashed on the axis, greyed in a ledger headed *The draft*, "the packer's arithmetic, not a decision" —
  with *Fit it in*, *Tomorrow* and *Not today* working on it as facts. Today is read from now, so *free* is what is
  left of it, and the draft starts at the hour.
- **"I'll do it tomorrow."** *Tomorrow* on any row (and *Today* on tomorrow's rows) is `POST /api/day/fact` with
  `move: { rowId, to }` → `moveRow`: the row is *not today* on the day it leaves and *asked* on the day it lands.
  Asked is a fact Claude reads (`student.asked` in the brief, first rung in the packer's draft, "you moved it here"); on a
  day he has already decided, the row is fitted into the first gap that holds it, pinned, or waits there with the
  reason. Only *Not today* removes a crucial row; a move keeps it.
- **A class he is not going to.** The class sheet asks *Will you be there?* ahead of a class (and *Were you there?*
  after); a No ahead of it is `attended: false` in `Hub/_attendance.json`, which the day reads: the class is drawn
  hatched, "not going · hours are yours", with no walk to it, its hours workable for the packer, for Claude's plan and
  for a drag; the brief says `notGoing`. Monday 2026-09-21 is the case that asked for it: he lands in Toronto at 17:00
  and the ECO227 lecture is 13:00–15:00. The morning still reads the same No as a class missed and adds the catch-up.
- **The decision keeps its hour.** A fact used to restamp the day, so "Claude decided at" read the time of the last
  skip; `decidedAt` now travels with the decision through every fact, slide and pin.

### 22.10 Two panels, one lane, and the day that plans itself (2026-09-21, after midnight)

The first two-day screen lasted an hour. the student, with a screenshot: the left side was unreadable — two lanes in a third
of the width, three lines of text in a forty-pixel box, a bus drawn over the lecture — and a button called *Plan my
day* made no sense when Claude is the one who plans. What he wanted, in his words: "a two-sided app — the schedule it
thinks I should do, and my own to-do list that I can drag into today; drag to-dos throughout the entire schedule; drag
lunch and dinner; Claude plans, then I add my own." His answers to the ten questions: one day at a time; one lane;
bigger hours, everything readable; panels that scroll on their own; the whole to-do list, grouped by when it is due;
the drag rules as proposed, plus "when I click a to-do anywhere in the app it needs to tell me the estimated time, I
should be able to change it, and it reflects when I drag"; when Claude plans — my call; no visual difference between
his blocks and Claude's; the draft stays.

- **The screen.** A compact slab (the day switch, the date, one line on who decided and the steer, the numbers with
  the target stepper inline, *Weigh*, *Plan* / *Re-plan*, *Slide from now*), then two panels that fill the window and
  scroll on their own. Left, the day: one lane, eighty pixels an hour, classes, walks, meals, the frat and the work
  blocks all in it; a workable event (the bus) is a hatched band behind the blocks with its toggle; a class he is not
  going to is hatched with its title struck; a block is a marble card with the course's pigment as its spine, the
  title on two lines, then course, hours and minutes, the reason in italics when there is room, Start and the tick on
  hover. Right, *Your to-dos*: every open row that is not on the day, grouped *Due today · Due tomorrow · This week ·
  Backlog · Later*, filtered by the course chips, each with its minutes and the reason it is not placed, and *Fit it
  in · Tomorrow · ×* on hover; *Set aside* under them; the week's bars at the foot.
- **Drag.** Everything moves with the pointer, snapped to five minutes: a block to another hour (pinned there), a
  block off the day (not today), a block's foot to another length, a draft block (placed and pinned), a to-do from the
  list onto an hour (`POST /api/day/block` with `place` → `placeBlock`: pinned at its length, Claude's own block for
  it gone with it, a *not today* on it lifted), a meal to another hour (`meal` on `/api/day/fact` → `moveMeal`: it
  stays there for the day and does not slide; refused on a class; double-click puts it back). The day panel scrolls
  itself when the pointer nears its edge. A click without movement opens the sheet.
- **His estimate.** Every task sheet says *How long* — his number, else Claude's minutes, else the usual for the kind —
  with five-minute steps. His number is `Hub/_estimates.json` by row id (`/api/estimate`), read by `gatherDay` onto
  the row, and `minutesOf` takes it first, unscaled by the calibration; the brief carries it as `estimate.student` and
  the prompt says never to second-guess it. It is the length a drag drops at.
- **Claude plans by himself.** When the screen opens on an undecided day and Claude is the brain, it asks for the plan
  (`auto: true` on `/api/day/replan`), once per date per six hours (`Hub/_day-auto.json`), never on a decided day; the
  slab says *Claude is planning…* with the seconds. The button is *Plan* or *Re-plan*, quiet, for after he has moved
  things. The draft stands in lightly until Claude has read the day.
- **Dials.** No rail. The target stepper sits in the numbers; the courses, the kinds to leave out, catch-up and
  *Required only* live in the *Weigh* menu with their reset; the course chips over the list only filter it.
- **And what happened at 23:40.** Slate.app had been running the server it loaded at 22:41 while its window picked up
  the new build: it served a draft file built from 10:00 and, on *Fit it in*, wrote `_day.json` in its old shape,
  erasing Monday's plan. Put back from the copy Opus left in `/tmp`. The rule stands (§20.42): a window reload keeps
  the old server; quit and reopen.

### 22.11 Readable, and the meal that is never buried (2026-09-23)

the student, on the screen as it stood two days in: a ten-minute task was a box he could not read and the whole thing "doesn't
make me want to work"; the *Weigh* menu was white on white; a block could not be dragged off the day into the to-dos;
a drop on lunch made lunch disappear, and lunch should be a big thing he can resize; a task he adds on To do never
reached this screen. What changed:

- **Readable.** The hour is 200 pixels by default (the stepper runs 90–300, remembered under a new key so the old 120
  does not carry over), a half-hour rule from 160 up, and a block under 56 pixels is one line — the title, then the
  hours — instead of two clipped ones. The list's rows carry the whole title on two lines, then the course, the
  minutes, the flags and the reason on one line, and the actions float over the row's right end on hover instead of
  taking a third of its width.
- **The Weigh menu** hangs under the slab in an anchor of no height, on the page's own tokens. Inside the slab it read
  the slab's bone `--text` on the page's marble `--paper` — the one token the slab does not re-declare. It closes on
  a click anywhere else, or Escape.
- **Off the day, into the list.** A block dragged onto the list — the list lights gilt and says so, the block fades —
  is *lifted* (`lift` on `/api/day/block` → `liftBlock`): Claude's, pinned or standing from before a re-plan alike,
  it leaves the day and the row waits in the list, "you took it off the day". Not *not today*: nothing is set aside,
  and Re-plan may place it again. A draft block dragged there is *not today*, since the draft would only draw it
  again. A standing block had no id in the file and could not be moved by a drag at all: `buildDay` names it
  `rowId#901`, `#902`… in order, and a drag hands that name back (`keptIdOf`).
- **Lunch is a wall.** A meal is hard for a drop — `pinBlock` no longer lets a pin sit on it ("that is on Lunch
  13:20–14:05 — drag the meal aside first") — and the screen never gets there: a drag snaps to the nearest free side of
  whatever it would cover, walls that touch (the walk back and lunch) read as one — the blocks he pinned, the finished
  ones and those that stand from before a re-plan are walls too, since the server refuses a drop on any of them; a
  block's foot stops at the next wall. A meal dragged onto Claude's blocks pushes them aside the way a dropped block does (`makeRoom`, factored out of
  `pinBlock`, "no room left after you moved Lunch" for what fits nowhere); on a block he pinned it is refused. Drawn
  as a big thing: a bone band with an ink rule round it, its name in small capitals, its foot a grip.
- **A meal's length is a habit.** The foot dragged sets `minutes` on the meal in `Hub/_day-prefs.json` (`meal:
  { name, minutes }` on `/api/day/fact` → `setMealMinutes`, 15–240 in fives), every day; the day it was dragged on
  and the other day that stands are settled again so both read it. Its hour stays the day's own (`meals` on the day,
  double-click puts it back, as before).
- **A task he adds is on the list.** The stored day knew only the rows of its last settle, so a task added on To do —
  or right here: the *Add a task of your own* line heads the list now — never appeared. `GET /api/day` weighs the
  rows and, when one is missing from the stored day, settles it again and writes once — never on a read that finds
  nothing missing, so the minute's poll does not write and the event stream does not loop. The screen weighs the same
  rows itself in the meantime (`candidateOf` on the client, "just added"), so the task shows the moment it is saved.
- **The release reads the pointer, not the render.** The drag lives in a ref beside its state: the window's listeners
  are bound once per drag and read the ref, so letting go right after the last move drops where the pointer was — the
  old listeners were rebound in an effect after every move, and a release inside that gap dropped at the position
  before (found by the synthetic drags: a drop at 14:05 arrived as one at 10:30).
- **The suite** runs on the week its fixtures live in: `SLATE_TODAY` pins `todayIso()` for the process and the server
  it spawns (`writeDay` strikes days older than yesterday, so from Sep 23 the suite lost its Monday and failed at part
  11), the free-time check of part 15 reads the day's gaps rather than the clock's, and part 17 covers the lift, the
  meal as a wall, the push, the length and the added task: 31 checks.

### 22.6 The build log

**2026-09-23, 17:00–18:30.** §22.11: `Work.jsx` (zoom 200, `snap` with merged walls, `lift`, the meal's grip,
`AddTask` in the list head, the rows weighed on the client, the Weigh menu out of the slab), `work.css` (short
blocks, the meal band, the drop zone, the rows), `day.mjs` (`makeRoom`, `liftBlock`, `keptIdOf`, `setMealMinutes`,
meals hard in `pinBlock`, `moveMeal` pushing and refusing), the day route (the re-settle on a missing row, `lift`,
the meal's minutes), `terms.mjs` (`SLATE_TODAY`), part 17 of the suite. Verified on a clone of the notebooks with
synthetic pointer events on a hidden tab (timers throttled — yields on a MessageChannel instead): a standing block
dragged onto the list left the day and waited "you took it off the day"; a ten-minute block dragged into lunch read
14:05 at every point over the walk-tutorial-lunch wall and 10:30 before it, then 09:40 once the standing 09:50 block was
a wall too, and the pin was taken there; lunch's foot dragged made it 50 minutes in the preferences and on tomorrow;
a task typed into the list head appeared "just added" and read "not weighed" a second later; the Weigh menu read ink
on marble. Slate.app rebuilt; he has to quit and reopen for the server.

**2026-09-21, 01:50–02:10.** "Zoom it in — a 55-minute block takes two dollars of screen; I can scroll." The hour is
120 pixels now (a zoom stepper in the day's head, 60 to 200, remembered in localStorage), the day opens scrolled to
now (today) or to its first block (tomorrow), the now line says the hour, type in the blocks a size up, an × on a
block's hover beside Start and the tick, the list panel on its own slightly darker ground, the steer clamped to two
lines. Slate.app rebuilt.

**2026-09-21, 01:10–01:50.** "Still looks awful, use a different approach" — and "I can't move things to a different
time, nothing works." Two causes. The drag: Claude packs his blocks back to back with ten minutes of air, so almost
every drop overlapped a neighbour and `pinBlock` refused it; the block snapped back and the reason sat in a banner at
the top. Now the blocks under a drop make room: `pinBlock` re-places the bumped rows, in their order, into what is
free around the pins and the blocks that stay (the packer's `only` mode with those as `kept`), and what no longer
fits waits "no room left after you moved …"; a drop still bounces off a class, a walk or one of his own pins, and a
block leaves the day only when dropped over the list, not when the pointer strays past the hour gutter. The look: a
flat calendar — sixty pixels an hour, hour rules only, a block a tint of its course's pigment with a four-pixel rail,
a class solid in its pigment, a class he skips an outline with its title struck, a meal a grey tint, the frat and a
busy event graphite, a walk a quiet strip, the bus a gilt ribbon down the left edge with its name written upward, no
hatching, no dashed box but the ghost of a drag; the lane no wider than 640px; list rows two lines, the flags small on
the title line, the reason cut to one line with the whole in its tooltip. A banner tells him when the app is still
running an older server under the new screen. Slate.app rebuilt; thirty checks green.

**2026-09-21, 00:00–01:10.** §22.10 built: `Work.jsx` and `work.css` written again (two panels, one lane, the drag
manager on pointer events, the list by due date, the Weigh menu), `placeBlock` and `moveMeal` in `day.mjs`, the
estimates in `work.mjs` with `/api/estimate` and the sheet's *How long*, `minutesOf` taking his number first, the
auto-plan with its guard, part 16 of the suite (30 checks; all fifteen suites green). Verified on the clone with
synthetic pointer events: a row dropped on 15:10 pinned there, refused on the walk before the tutorial, a block moved
by half an hour, lunch dragged to 11:45. One stray cost: the clone's screen, reopened on its restarted server before
the guard file existed, started a real Opus session on the clone; killed after a minute. Slate.app rebuilt.

**2026-09-20, 23:00–23:30.** The `.wk-` collision found and the prefix changed to `.dw-`; `Hub/_day.json` → days by
date; the *Today · Tomorrow* switch, the draft drawn before a decision, *Tomorrow* / *Today* on every row (`moveRow`),
*Will you be there?* ahead of a class and the hatched "not going" block, `decidedAt`; the suite's part 15 (29 checks
now, all green with the other fourteen suites); §22.9. Then one Opus session on the live Hub for both days, the same
arguments as the app's button: eleven turns, $1.01, one refusal (a steer over 200 characters, fixed and resent).
Sunday from 23:06: no blocks, forty-one rows waiting "off tonight", the steer naming the crucial FCS298 forum reply
that closes at 23:59. Monday: five blocks, 365 minutes — the Bagieu order and the late forum reply first on the bus,
the ECO206 handout, then Problem Set 2 and Application 2 in the hours of the ECO227 lecture he is not going to (marked
from his own words: he lands at 17:00), finished by 16:25 before the walk to the tutorial that holds the quiz; the frat
stands and nothing after it. Slate.app rebuilt. Nothing committed.

**2026-09-20.** `src/dayplan.js` (the packer), `scripts/dayplan.mjs` (the CLI and the two files), `scripts/test-dayplan.mjs`
(the `dayplan` suite: a Monday's busy time and meals, the ladder and the stretching target, the catch-up reserve and
dial, every dial, the split and the quiz that is never split, a pinned block, the late window with its deadline, the
re-pack from 14:00 and the slide, tomorrow's room, the backlog spread before a test, the minutes, then the script on a
throwaway root — the files written, a skip that persists, `--reset`, `--ignore` by code, `--budget`, `--now`, `--slide`,
another `--date`, `--dry` writing nothing, an unknown flag refused); `work` on the editions; `dueTime` on a hand-in row.
Three of the suite's first expectations were wrong and the packer right: dinner slides to 19:25 (the first five-minute
step that clears the walk), a prep for a class that has met is not slid past it, and crucial work in an ignored course
is still placed. A dry run on the live Hub for Monday 2026-09-21 — the bus back from Montreal and the frat — found
25 free minutes and put the two crucial FCS298 tasks after midnight, which is the rule working and a question for
the student: is bus time work time? Not built yet: the screen, the timer and the log, the brain's fields and steer, the routes,
attendance, the review's graphs, the morning note's block.

**Later the same evening.** the student: "I can also work on the bus — ok for the toggle"; and a quiz sat in the tutorial "should
be put during the class on the calendar, stating that it is during the class, because it is in my day schedule." Both
built: `workable` in the preferences and per event for the day (`--workable`, `--busy`, persisting like a skip), and the
in-room rule above, with the classes and events on the rendered day. Three suites green. He also said he reaches Toronto
at 17:00 on Monday, while his calendar holds two buses (08:00–15:00 and 13:00–19:45) — neither ends at 17:00, and the
checkpoint quiz is at the start of the 17:00 tutorial with no make-up; flagged to him, the calendar is his to fix.

**Later still.** "Claude should be the brain and do all of it, not a script" — §22.7. Built: `scripts/lib/day.mjs`,
`brain.mjs day brief | set | show` with the day's undo, `scripts/day-prompt.md`, step 11 of the morning with `minutes`,
`weight` and `splittable` on every task, the script redrawn to draft, record facts and slide, contract v19, and the
suite's twelfth part (the facts alone before Claude decides; the brief's rows, minutes, deadlines and room; a plan
set, recorded, written and read back; nine refusals with nothing kept; a skip and a slide that ask nothing; a re-plan
from an hour; undo). On the live Hub the brief for Tuesday 2026-09-22 is one JSON of about forty kilobytes — ten
thousand tokens, a few cents on Sonnet, well under a tenth of the morning on Opus.

**The night.** The rest, built and verified on a clone of the notebooks (`launch.json` → `slate-work`, :5191/:5192):
`scripts/lib/work.mjs` (the timer, the log and its calibration, the day log, attendance), `server/routes/day.js`,
`src/components/Work.jsx` with `WorkTimer.jsx`, `HowLong.jsx` and `work.css`, the sidebar entry and the screen in
`App.jsx`, *Start* on the To do rows and in the task sheet, *Were you there?* in the class sheet with *missed* on the
block, the review's *Work this week*, `settings --model`, Opus on the Sync button and the re-plan, the day's blocks
with stable ids so a drag finds them after a slide, the file keeping Claude's whole plan when a fact draws less of it,
and the suite's parts 13 and 14 (the timer and the log, then every route on the test port with a fake `claude` for
the re-plan — 28 checks; all fifteen suites green). `vite build` clean. Then the real thing, on the clone at 22:26
on the Sunday: *Plan my day* ran Opus for ten turns and $1.18, and it decided four blocks and left thirty-seven waiting,
each with a reason — "the post must connect to a concept from the Core Vocabulary — a fast pass, not the full 45: the
deadline is 90 minutes away"; "reading a chapter at 1am buys nothing; it comes back with Module 2 this week"; "90
minutes of problems deserve a fresh head, not 2am" — with the steer *Write the forum post tonight whatever else slips:
15% of FCS298, and it closes at 23:59.* The screen drew it; the page under Hub/Today reads it back. `npm run app`
rebuilt the bundle.

## 23. The day, drafted and confirmed (2026-09-29)

the student, at two in the morning, on the Today's work screen as §22.11 left it: a to-do he created there showed nowhere else;
a to-do he put on the calendar vanished from his list; "whenever I delete stuff and then I add new ones, the old ones just
keep popping back on the calendar"; "I should be able to have a draft of my day and then confirm it — it goes from faded
to actual things on the calendar"; and the design was "not very clear, not very understandable, hard to use". "Take a
very different approach." Twenty-four questions in six rounds, answered the same night; the answers are the design, and
they replace the model of §22.7–22.11. The ladder (§22.2), the packer's arithmetic (§22.3), the timer, the estimates,
attendance and the review (§22.4) stand.

### 23.1 Why the old ones came back

Three mechanisms, found on a clone before a line was written. (1) On a day Claude had not decided, the screen drew the
packer's draft, re-run after every change: take a block off and the next row filled the hole. (2) A drop on Claude's
block did not take it off the day — `makeRoom` slid it to the next gap. (3) Opening an undecided day started an Opus
session by itself (`auto`), whose plan landed a minute later over whatever he had done. And the new to-do: the form on
the screen saved it with no date and no course, so it sorted into *Later*, row 53 of 62; the Week page never read his
own tasks at all, and Home and the course page capped them at six.

### 23.2 What the student decided

- **Two states.** Faded is a draft; solid is confirmed. Claude drafts ("Claude, I confirm"); a ✓ on a block confirms it,
  *Confirm day* confirms every draft; × dismisses. **His own drops and moves are drafts too until he confirms them**
  ("all draft until Confirm"), and on a day he has confirmed, an edit is faded again with *Confirm N changes*.
- **Confirmed is his.** Claude never moves or removes a confirmed block; a Redraft replaces only Claude's own faded
  blocks — what the student put down, confirmed or not, stays.
- **Remove = back to the list, unscheduled.** The row waits in the list with no hour, and Claude never proposes it again
  on that date.
- **A scheduled to-do stays in the list**, with its hour on a chip that scrolls the calendar to it.
- **A new to-do** is typed at the top of the list, due the day on screen by default, and shows on Home, To do, its course
  page and its week page.
- **The list** shows Claude's picks for the day, with *All* behind a switch.
- **The layout**: the list on the left, the day on the right; one day at a time with ‹ › to any date; a true time scale.
- **The look**: its own, "closest to Structured" — a rail, a capsule per thing in its course's pigment with an icon by
  kind, the words beside it; not the stone of the rest of the app. What made the old one hard: too many buttons and
  concepts, not telling whose block was whose, the big slab and its numbers, too much text.
- **Kept**: the timer and the tick on a block, Claude's reason (only when the block is opened), meals as blocks that move
  and stretch, the walks. **Gone**: the Weigh menu, the target and the four numbers, *Slide from now*, *Fit it in*,
  *Tomorrow*, the week's bars, the zoom.
- **A confirmed block whose hour has passed unticked** stays where it was, marked *missed*, with *Back to list*.
- **A drop on a taken hour pushes the others later** — never onto a class or a meal.
- **Steering Claude**: one line typed when he presses Draft ("light day, ECO208 first"), read for that draft.
- **When Claude drafts**: the 07:00 run, "but with a sub-agent", and a Draft button — the same agent both ways, for
  focus and so the drafts come out alike. Opening a screen never starts a session.
- **Google Calendar**: a *Send to Google Calendar* button once a day is confirmed; nothing automatic.
- **The morning note and email** carry the draft, marked *Draft — confirm in Slate*.

### 23.3 How it is built

- **`src/today.js`**, pure, on both sides: `pushDown` (in start order, a block that collides with the drop or with one
  already settled goes to the first free minute after its own start, jumping the walls; a finished block never moves;
  one pushed past 03:00 leaves the day), `snapStart` (a drop on a wall lands on its nearest free side), `wallsOf`,
  `isMissed`, `draftCount` (Claude's proposals are never "changes").
- **`Hub/_day.json` v3**: `{ version: 3, days: { date: { blocks, removed, meals, workable, draft, request, confirmedAt,
  sent, updatedAt } } }`. A block is `{ id, rowId, title, course, courseKey, color, kind, start, end, by, state, why }`;
  `by: 'claude'` implies a draft, and confirming makes it the student's. What the day holds (classes, walks, events, meals) is
  never stored. The second shape is read as drafts — Claude's his, a pin the student's, a finished block confirmed, *not today*
  as removed — so nothing was confirmed that the student did not confirm.
- **`scripts/lib/day.mjs`** rewritten: `gatherDay` (rows with `past: 'all'`, so a finished to-do of a class gone by still
  marks its block done), `viewDay`, the acts `placeRow`, `moveBlock`, `removeBlock`, `confirmBlocks`, `moveMeal`,
  `setWorkable` (each returns the day and one line when something moved that he did not move), `briefDay` (what the student
  has on the day — `student.stays`, `student.removed` — his `note`, Claude's previous draft, the packer's arithmetic),
  `checkDraft` (refuses a removed row, a row already on the day, a block on one of his, besides the old checks; `picks`
  validated), `applyDraft`, `proposeDay` (recorded, undoable), `packerDraft` (brain off, tests), `writeDay`,
  `dayLines`/`statusLine` for the page, the note and `day show`.
- **The day agent** (`scripts/lib/day-agent.mjs`, `scripts/day-agent.mjs`): one `claude -p` on `scripts/day-prompt.md`
  for one date, only `brain.mjs` and `echo`, no connectors; the Draft button (`POST /api/day/draft`) and step 11 of the
  morning run start the same session. `--note` is the student's own line (saved as the day's `request`, read in the brief, kept
  on the draft); `--steer` is one line for one run only — the 07:00 run's coordinator correcting a draft its critic found
  wrong — passed in the session's environment (`SLATE_DAY_STEER`), shown in the brief as `runSteer`, weighed below his
  note, written nowhere.
- **The calendar agent**: `scripts/day-gcal.mjs` plans the confirmed blocks as events on the primary calendar, each tagged
  `slate:day:<date>:<block id>#<hash>` on the last line of its description, and diffs them against what is there — it
  deletes only its own; `scripts/day-gcal-prompt.md` is a short Sonnet session allowed the four calendar tools and that
  script (`POST /api/day/send`). The app cannot reach Google itself; only a session with the connector can. The 07:10
  readback marks these events `slate`, so the day never reads them as busy.
- **Routes** (`server/routes/day.js`): `GET /api/day` (any date; never writes, never starts Claude), `POST /api/day/act`
  (`place`, `move`, `remove`, `confirm`, `meal`, `mealsize`, `workable`), `POST /api/day/draft` and its status,
  `POST /api/day/send` and its status, and the timer, estimates, attendance and preferences as before.
- **The screen** (`src/components/Work.jsx`, `src/styles/day.css`, classes `.dy-`): the top (the date with ‹ ›, where the
  day stands in a line, Claude's steer, *Draft my day* / *Redraft* with the note, *Confirm day* / *Confirm N changes* /
  *Confirm the rest*, *Send to Google Calendar*); the list (*For today* / *All*, the adder, rows with a tick, course, due,
  and the hour chip); the timeline (180 px an hour, hours in a gutter, the rail, a capsule per class, meal, event and
  block, a walk as a line of small type, the bus as a band, free gaps labelled, the now line, after midnight shaded). Hover
  on a block: *Confirm*, *Start*, ×; its capsule's glyph ticks it done once confirmed; a click opens the sheet with *Why
  Claude proposed it*. Every drag previews the push before the drop.
- **Elsewhere**: the Week page reads his own tasks and ticks them; Home puts a task of his due by tomorrow on its course's
  panel; the course page puts his tasks due within the week at the head of *Also on your list*; `scripts/dayplan.mjs` is
  now the day read back, with `--draft` for the packer's; `brain.mjs day set` writes a draft, `day show` says what waits
  to be confirmed; contract v23.

### 23.4 Build log

**2026-09-29, 02:00–03:15.** The questions, then the build above. Verified on a clone of the notebooks with a fake Claude
behind both agents (`scripts/test/fake-day-agent.mjs`): a drop on a 2-hour block pushed it past lunch and the button read
*Confirm 2 changes*; a block dragged onto the list left the day and was remembered; a Redraft after a removal, a confirm
and a drop of his brought back nothing removed and moved nothing of his; Send planned seven tagged events and a diff that
deletes only its own; a to-do typed on the screen reached Home, To do, ECO208 and its Week 4. The dayplan suite rewritten
for the model (28 checks); all 17 suites and the 223 checks of the scenarios pass; the client builds. Not yet run against
a real Claude or the real Google Calendar: the first Draft and the first Send the student presses are the live tests. Slate.app
must be quit and reopened — it holds the server it loaded at launch.

## 24. The brain as a team (2026-09-29)

the student, at two in the morning: the morning run is "sublime", and he wants it smarter — sub-agents on Opus, "so it doesn't
get like 15 steps and then lose its ability to think straight", "absolutely perfect and spotless"; cost does not matter.
This reverses his rule of 2026-09-13 (§20.37: one thorough pass, no fan-out).

### 24.1 Why

The run of 09-24 took 177 turns and grew from 92k to 312k tokens of context: it read about 20k tokens of rules in its first
17 turns and applied them 150 turns later, and the day and the note — the steps that need the most judgment — came last,
with the most in its head. What slipped was the horizon, not the new: `t-v1imdv` "Read Perloff 4.2-4.4 in the textbook",
for the Sep 30 lecture, kept no link for five mornings after `Week 4 (Sep 28)/Textbook/Perloff 4.2–4.4.md` appeared,
though the prompt says in so many words that it should. The cost of one long pass also grows with the square of its
length (every turn re-reads the whole context: 177 × ~200k ≈ 35M cached tokens, the ~36M measured for a heavy morning).

### 24.2 What the student decided

- One **coordinator** (the 07:00 session, or the Sync button's) runs the scripts, starts the agents, weighs their reports
  and fixes what the critic finds; it does not read course material to decide.
- One **course agent** per course, **every course, every morning**, on Opus, all at once: it places, links, reviews, writes
  the course's tasks for fourteen days — and then re-reads every open task of its course one by one (link, class, level,
  minutes, done, still wanted), the part a single pass skimmed.
- A **critic** that only **reports**; the coordinator decides what is real and fixes it. It runs **twice** — after the
  course agents, and after the day — and **rechecks the fixes** each time, at most three rounds, and what is still wrong
  goes in the note. It hunts his four first: due today not on the plan; wrong week or class; bad or missing link; wrong
  level or minutes. No code guard on the day plan: the critic checks, code does not.
- A **day lead** after all of them: the **levels across courses**, **today and tomorrow** through the day agent of §23
  (`day-agent.mjs`, the same session as the Draft button — the lead wraps it and changes nothing in it), and the
  **morning note**. A critic finding about a draft goes back to the day agent as `--steer` (one run's correction, never
  saved as his request — added to §23's script for this); one about a level or the note goes back to the lead.
- The single pass stays, whole, behind a switch: `node scripts/brain.mjs settings --mode team|single` (`Hub/_settings.json`
  → `brainMode`, single unless set). Tested once on a clone before it goes live; he switches.

### 24.3 How it is built

- `scripts/brain/coordinator.md`, `course.md`, `critic.md`, `day-lead.md` — the roles. The rules of the work stay in one
  place, `scripts/brain-prompt.md`: each role file says which of its steps that agent does (by number and title) and what
  it must not run, so a rule refined there holds for both modes.
- Routing: the first line of `scripts/sync-prompt.md` (the 07:00 task's entry) and the Sync button (`server/index.js`)
  pick `brain/coordinator.md` in team mode, and the button then allows the Agent tool. `brain.mjs status --json` says
  `mode`.
- Four writers at once: every `brain.mjs` write already took `Hub/.tmp-brain.lock`; it now waits up to a minute instead of
  ten seconds (`acquireLock`), and `problems.mjs` takes the same lock around its read-merge-write of `Hub/_problems.json`,
  which two agents adding rows at once would otherwise overwrite. `plan.mjs` runs only in the coordinator.
- Found while asking why runs stalled (4 of the last 10 spanned 4–25 hours): each ran with the lid closed on battery, and
  the session moved only in Power Nap's DarkWakes. Fixed in code: `scripts/lib/net.mjs` `fetchSafe` — a request aborts only
  when no byte arrives for 60 s, then two more tries — for every Quercus and MyMedia fetch (suite `net`); a run left open
  is closed by the next at its last decision, with its decisions counted. Not code: the Mac must be awake at 07:00.

### 24.4 Build log

**2026-09-29, 02:20–03:05.** The questions (four rounds), the stall investigation, the fixes above, the roles.

**03:07–04:32, the rehearsal** — run `r-pw0vgm` on a `cp -c` clone of the notebooks, driven from a clone of the repo whose
`slate.config.json` points at it (so no command could reach the live notes; the live Hub files were byte-identical before
and after). Skipped: the calendar, the email and `mirror-course.mjs`, which write outside the clone. The four course
agents ran at once in 6–10 min (43–69 tool calls each) and made 55 decisions; the critic's first round (12 min) found six,
all verified and fixed — five past tutorial preps and a Ch 2 deck still `important`, a 60-minute estimate for six pages,
a duplicate task, and Fall-Ex2 ticked while its answer note says *not submitted* (asked); the recheck was clean. The day
lead raised one level and linked a guide; its day agent (§23) **failed for today**: the draft was sent through a heredoc,
which the permission check of a session that cannot ask refuses ("brace with quote character"), and it spent its $4
writing nothing — the same would have happened to the live single pass. Fixed in `day-prompt.md` (’ for apostrophes,
never a heredoc) and verified on a second clone ($1.93, landed). Tomorrow's first draft repeated today's blocks — the
brief for one date does not see the other's — so the lead now always steers tomorrow with what today holds. The critic's
day round found a promise of FCS298 work the other day did not keep and a wrong days-left; three rounds of redrafts
fixed those and each introduced a smaller slip (a redraft rewrites every reason), and the last — "14 days to Oct 13" — is
`terms.mjs`'s stale ECO208 date feeding every brief (q-vixdz1). Also fixed on the way: `ignore` now takes "<title> (2)"
when the name is taken in `Ignored/` (two ECO227 re-uploads had waited since Sep 26). 76 decisions, 85 minutes, of which
~30 were the failed day agent and its hand-drafted stand-in. Suites: all 17 green (brain 28, net), on a free port.

**10:10, live.** the student's go came after the 07:00 run had gone as the single pass (07:10–07:41, 34 decisions; it drafted
6 + 6 blocks, so the heredoc fix held; two Claude apps fired the task twice and the bookkeeping fix closed the stray run
with 0 decisions; its calendar commit was blocked by the auto-mode check again). `brainMode: "team"` is set on the live
notes, so the first team morning is 2026-09-30; the `slate-quercus-sync` prompt no longer forbids agents (it `cd`s into
the repo first and names both modes). Also on his word: ECO208 Term Test 1 is Thu Oct 15, 1–3 pm, SS 2118 in `terms.mjs`
(the lecture's slot; t1 no longer assumed), q-vixdz1 answered; the calendar, course, plan and review suites followed the
date (their frozen-clock counts: 36 days from Sep 9, 32 from Sep 13, 29 from Sep 16). `test-calendar` reads the live
`_hub.json`, which keeps the old Oct 13 row until the next fetch — green against a refreshed hub (`SLATE_LIVE_ROOT`).

### 24.5 The first live team morning, audited (2026-09-29, afternoon)

Run `r-rbes45`, 10:45–11:18, started by hand when FCS298 Module 3 opened (Quercus opens a module lazily: its `unlock_at`
was 10:30, it opened at 10:45:12, and `/files/:id/download` 404s even then — the metadata `url` is what works). Three
read-only audit agents the same afternoon: one read the transcripts, one graded every decision of this run and of the
07:10 single pass `r-d1a3es` on the same rubric, one audited the state the student was looking at.

**Better decisions.** Team 0 wrong / 2 debatable of 33; single pass 2 wrong / 9 debatable of 32; about 17 of the team's
decisions fixed what the single pass had missed (FCS298 Quiz 1 prep raised three days out, the practice check made
optional, Perloff and the Ch 5 slides raised for their classes, a stale "Finish Layers" withdrawn), none undid anything
right. Same speed: 33 minutes against 31.

**Not yet spotless.** (1) Every session and agent ran at effort **medium** — scheduled runs ignore `effortLevel`, and
there is no documented way to set a scheduled task's effort; the rehearsal had run at xhigh. (2) The course agents did not
do the one-task-at-a-time horizon: 2–3 minutes and 18–28 tool calls each (rehearsal: 6–10 and 43–69), two tested no link,
and `t-v1imdv` — the task §24.1 names — kept a wrong level until the critic. (3) The coordinator sent rechecks with
SendMessage and read them only because they happened to return in time; summarised the course reports (the note said 10
Problems rows, there were 28); edited the note itself with `sed`; rejected a true finding (Thursday overloaded) as "not
this run's day". (4) The day agent cost $4.76 and 40 turns and dropped a row twice: the row's id held a straight
apostrophe, the prompt says to write ’. (5) Left in the state: 13 wrong tasks — readings at about half their words
(Perloff 4.2–4.4: 13,400 words at 60 minutes), Checkpoint 2's four sets on weeks at normal — and ~470 minutes of Quiz 1
preparation parked on Thursday, because `_plan.json` → `tests` held one test per course from the component named
`tests`, so FCS298's `quizzes` never reached the day brief. (6) After `run done` the student typed into the session; it added
`brain.mjs kind`, fixed Quiz 1's coverage and fetched outside a run, leaving 8 items waiting.

**the student's decisions**, and what was built:
- *Fix it now*: run `r-pgcexc` by hand — the inbox cleared (six byte-identical re-uploads ignored, the announcement linked
  and read, the practice-quiz copies swapped so the tracked one with its instructions is filed), 23 task fixes, today and
  tomorrow redrafted with Quiz 1 in them (10 and 8 turns, $1.32 and $1.11, against 40 and $4.76 in the morning).
- *Effort xhigh for the team*: `.claude/agents/slate-course.md`, `slate-critic.md`, `slate-day-lead.md` — Opus, `effort:
  xhigh`, each with only the tools its role needs (the course agent and the critic have no Write or Edit). A definition's
  `effort` overrides the session's; the 07:00 coordinator itself stays at the scheduled default, the Sync button runs
  `claude -p … --effort xhigh`.
- *A code check the agents must answer*: `brain.mjs check [--course C] [--all]` (`scripts/lib/check.mjs`, suite
  `check`) — per open task: link on disk / not the course home / not a Problems page / a graded hand-in's own URL; the
  class exists and is not cancelled; the level against the date (due within a day → crucial, marked within three or the
  course's next class → important) and the missed-task rule both ways; minutes against the linked words (150 a minute, a
  deck 60; flagged a quarter short from 1,500 words, or more than three times over); a duplicate (same page, words that
  overlap); documents last week to next week with no `for:`. Tuned on the live notes from 25 flags to 7, all real
  questions. The course agent answers every flag and returns a `ledger:` line for every open task; the critic treats an
  unanswered flag or a missing ledger line as a must-fix.
- *A stricter coordinator*: the team's agent types; a recheck is a new critic agent it waits for, the last fix always
  rechecked; reports passed verbatim; it never writes the note; a finding is rejected only when false, else `Still open:`;
  after `run done` it fetches and decides nothing, and anything the student asks later is a run of its own.
- *The quiz blind spot*: `src/plan.js` takes each course's next quiz beside its next test when quizzes are their own
  component, so Quiz 1 is in the plan and in every brief — 16 rows became test preparation for it.
- *The day input*: `checkDraft` folds quotes when it matches a row id (’ and ' are the same row) and cuts a `why` over 160
  characters at a word instead of throwing the whole draft away (dayplan suite, +1 check).
- *Missed tasks*: a missed task that nothing ahead needs is `normal`; a test covering its week within 21 days, or a quiz
  within 14, makes it `important` again (brain-prompt step 6; `check` flags both directions).
- *Minutes from words*: step 6 and `check` carry the baseline.
- Also: `reviewed` closes an update whose page is in `Ignored/` or has moved on (it had been refused for good: brain +1
  check); `kind` documented in step 4 and forbidden to the critic.

Suites: all 18 green (brain 30, dayplan 29, check 11, plan with the Quiz 1 check). The next morning's run is the test of
the rest: whether the agents at xhigh answer every flag and return full ledgers.
