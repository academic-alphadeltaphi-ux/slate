---
name: slate-quercus
description: Read Quercus (UofT Canvas at q.utoronto.ca) directly and prove the notebook holds everything it posted. Use in EVERY morning check after the briefs are decided (the completeness pass below), whenever a task needs the exact Quercus link of an assignment, quiz, page, file, forum or video, and when the student asks "is everything from Quercus in here?", "what's due", "check quercus", "any announcements", "what did the prof post", or names a course and wants its content. Works with `node scripts/quercus-sweep.mjs` and `node scripts/audit.mjs` (the student's own key, no MCP needed); knows every place a file hides and the gotchas that make the obvious calls return empty.
allowed-tools:
  - Read
  - Bash(node scripts/quercus-sweep.mjs *)
  - Bash(node scripts/audit.mjs *)
  - Bash(node scripts/brain.mjs *)
  - Bash(node scripts/run.mjs *)
  - PowerShell(node scripts/quercus-sweep.mjs *)
  - PowerShell(node scripts/audit.mjs *)
  - PowerShell(node scripts/brain.mjs *)
  - PowerShell(node scripts/run.mjs *)
---

# Quercus

Two commands read Quercus with the student's own key (the keychain on a Mac, the Windows file on a PC — `node scripts/setup.mjs token`
put it there); no MCP server is needed:

- `node scripts/quercus-sweep.mjs --list` · `--modules --course <id>` · `--course <id>` — what the account is enrolled in,
  every module item of every type with its URL, and every file in the places listed below.
- `node scripts/audit.mjs --json` — read-only: everything the API exposes for every course, matched against the notebook,
  with a flag for each thing that is missing or wrong.

**Read the Gotchas section before concluding a course is empty.** Most of the failure modes here return cheerful empty
results rather than errors, which reads as "nothing posted" when it actually means "you looked in the wrong place."

## In the morning check: the completeness pass

The morning's fetch (`run.mjs fetch`) brings what it recognises; this pass proves nothing was missed and that every
task leads somewhere. Run it after the briefs are decided and before `node scripts/run.mjs finish`:

1. `node scripts/audit.mjs --json`. Its last line lists the flags (`list`: course, kind, text).
2. Act on each flag:
   - **WAITING** — decide it as the light prompt says (`brain.mjs inbox`, then `place` / `ignore`).
   - **NOT IN SLATE** — the fetch missed it. Run `node scripts/run.mjs fetch --from manual` once more, decide what it
     brings, and audit again. Still missing: `node scripts/brain.mjs ask "Quercus has <the thing> (<its URL>) and the
     notebook does not — <course>" --course <CODE>`, so the student sees it on Home, and name it in your summary.
   - **NO TASK** / **DISCUSSION NO TASK** — an assignment or quiz with no task, or a forum with a mark or a date on it:
     write one with its own Quercus URL as `link` (the flag prints a forum's; `--modules --course <id>` prints every
     module item's). An open Q&A forum is never flagged: it needs no task.
   - **TASK LINK MISSING** / a task with no link — look for the thing (`--modules --course <id>`, the notebook's pages) and
     give it: `node scripts/brain.mjs task edit <id>` with `{ "link": "<URL>", "reason": "…" }` on stdin — the Quercus URL,
     else the notebook page it concerns. Only when it truly exists nowhere online (a paper textbook, something done in
     class, the student's own work) does it stay without one, and its words say so in parentheses: `{ "what": "… (paper textbook)" }`.
   - **DUE MISMATCH** — the task's date follows Quercus: `task edit <id>` with the date Quercus gives.
   - **LOCKED** — a file the course has not opened yet (a module unlocks on its date, and Canvas opens it some minutes
     late): nothing to do; the next morning fetches it once it opens.
   - **EMBED NOT ON PAGE** — a page filed before embeds were kept; the next change on Quercus rewrites it. Name it only once.
   - **PAGE MISSING** / **STALE RECORD** / **ITEM NO PAGE** / **VIDEO NO PAGE** — bookkeeping the next fetch repairs; name
     them in your summary, change nothing by hand.
3. `node scripts/audit.mjs --json` again: what is left is only what you asked about or named.

A brother's install has no canvas MCP server: everything below that names an MCP call (`list_courses`, `get_course_structure`,
…) is the maintainer's own route; the sweep and the audit do the same work with the key.

---

## Orientation — start here

| Goal | Call |
|---|---|
| What am I enrolled in? | `list_courses(include_all=true)` |
| What's due soon? | `get_my_upcoming_assignments(days=30)` |
| Canvas's own to-do list | `get_my_todo_items()` |
| Grades across all courses | `get_my_course_grades()` |
| What haven't I submitted? | `get_my_submission_status(course_identifier)` |
| Course metadata | `get_course_details(course_identifier)` |

`course_identifier` accepts the numeric Canvas ID or the course code. **Numeric IDs are
more reliable** — the codes contain spaces and colons (`ECO208Y1 Y LEC0101 20269:...`)
and match inconsistently.

### Which courses, and their ids

**The ids live in `scripts/lib/terms.mjs`** — that file is this install's source of truth, so read it (the Read tool;
each course's `id` and `code`) rather than trusting a list here that would be some other student's.

For everything the account is enrolled in, including what is not in that file yet: `node scripts/quercus-sweep.mjs --list`
(or `list_courses(include_all=true)` where the MCP exists). Ignore what is plainly not a course this term — a study centre, a registrar page, a
welcome module. A full-year (`Y`) course that looks empty in September usually is; read the Gotchas before concluding
that anything is missing.

---

## Walking a course

**Use the token, not the MCP, for structure.** On 2026-09-16 `get_course_structure` answered `modules: []` for all
five courses while `list_assignments` on the same account worked and the plain call returned everything:

```
GET /courses/{id}/modules?include[]=items&per_page=100
```

`quercus-sweep.mjs --modules --course <id>` prints that walk, every item type included. Keep the MCP for
conversational questions; never conclude a course has no modules from the MCP alone.

Then, per item type — a module holds more than files and pages:

- **`File`** → `content_id` is the file ID → `GET /courses/{id}/files/{fid}` gives `display_name`, `size`, `url`
  (with a `verifier=` query that works without the header) and `updated_at`/`created_at`, the posting date.
- **`Page`** → `page_url` is the slug → `GET /courses/{id}/pages/{slug}`. **Raw HTML**, not markdown; `updated_at`
  is reliable for change detection. `locked_for_user` says when the professor has not opened it yet — but a topic
  page can open early (ECO206's Week 3 page was readable the Wednesday before its week), so ask again every run
  rather than assuming "locked until its week".
- **`ExternalUrl` / `ExternalTool`** → record the `external_url` in `Links.md`. A `play.library.utoronto.ca` or
  `mymedia.library.utoronto.ca` link is a **MyMedia video**: see the gotcha below — the page needs a UTORid but the
  stream behind it does not, so `scripts/lib/mymedia.mjs` downloads it.
- **`Discussion`** → `content_id` is the topic → `GET /courses/{id}/discussion_topics/{tid}`: `message` (HTML),
  `delayed_post_at`, `lock_at`, and `assignment` (with `due_at`, `points_possible`) **only when graded**. FCS298's
  forums carry no assignment at all: their real deadlines (post Friday, reply Sunday) are sentences in the message
  and in the syllabus — nowhere machine-readable. No `updated_at`: hash the message and dates to notice a change.
- **`Quiz`** → `content_id` is the quiz → `GET /courses/{id}/quizzes/{qid}`: `due_at`, `points_possible`,
  `question_count`, `time_limit`, `html_url`, and `assignment_id`. A graded quiz is also an entry in
  `/assignments` with `quiz_id`, and that is where its submission state lives. No `updated_at` either.
- **`Assignment`** → `GET /courses/{id}/assignments/{aid}`: `description`, `due_at`, `points_possible`, `html_url`,
  `updated_at`; `?include[]=submission` on the list adds `submission.workflow_state`.
- **`SubHeader`** → structure only; nothing behind it.

**Read the module's name.** Professors number by their own calendar: FCS298's modules are *"BEGIN HERE: COURSE
ORIENTATION - Week 1 (September 8-11)"* and *"Week 2 (September 14-18) - Module 1"* — Module N is week N+1. The
name, not the module's position, says which week an item is for.

Other content:

- `list_announcements(course_identifier)` → **IDs and titles only, no bodies**.
- `get_discussion_topic_details(course_identifier, topic_id)` → the body HTML. This is
  where announcement file links live.
- `list_discussion_topics(course_identifier)` → non-announcement discussions.
- `list_assignments` / `get_assignment_details`.
- `list_course_files(course_identifier)` → often `unauthorized`; see Gotchas.

---

## The places a document hides

**This is the most important section.** A document can be in any of these, and most courses
use only one or two. Checking modules and the Files tab alone will silently miss things —
that is exactly how the ECO208 syllabus was missed on the first sync. The morning fetch
(`quercus-sync.mjs`) looks in every one, and `audit.mjs` checks every one against the notebook:

1. **Files tab** — `/courses/{id}/files`; hidden (`401`) in most courses, so never the only list.
2. **Module `File` items** — `content_id` is the file id; a module too big to inline its items: `/modules/{mid}/items`.
3. **A module's `ExternalUrl` item** that is a Quercus file's or page's own address — that file or page.
4. **Pages** — module `Page` items, the front page, every page linked from a page, the syllabus, an announcement or a module item, and the Pages index where it is on; each body's file links.
5. **Announcements** — body links and `attachments[]`, re-read every run (an edit adds a link later). ← *the one everyone forgets*
6. **The syllabus** — `syllabus_body`'s links; its own text becomes the page *Syllabus on Quercus* at 200 characters or more.
7. **Hand-ins, quizzes (practice ones too) and forums, in a module or not** — description links, forum `attachments[]`; only module ones get a page.
8. **Another course's file** (`/courses/{other}/files/{fid}`, a department's shared course) — asked for by id alone, `/files/{fid}`.
9. **A video uploaded into a page** — `<iframe src="/media_attachments_iframe/{file id}">`, a file of that course.
10. **MyMedia videos** embedded or linked in any of the above (`lib/mymedia.mjs mymediaIn`) — downloaded into a page on *Videos*, known by their 32-hex id.
11. **Any other `<iframe>`** (YouTube, a form) — a link on its page; the audit's **EMBED NOT ON PAGE** is a page written before that: name it.
12. **Same name, other bytes** — a file counts as already here only by name **and** size: a second `Slides.pdf` is a new document.
13. **Not open yet** — an empty metadata `url` (its module unlocks later): the fetch asks again every run; the audit says **LOCKED**, nothing to do.

For the HTML places, extract file IDs with:

```
/courses/(\d+)/files/(\d+)
/media_attachments_iframe/(\d+)
```

Then resolve each ID via `download_course_file`. A file reachable this way often does
**not** appear in `list_course_files` — ECO208's syllabus (`44668332`) and Lucas reading
(`44522622`) are both invisible to the Files listing but download fine by ID.

For a complete sweep of the files in all of them, run `scripts/quercus-sweep.mjs` (see below).

---

## Gotchas — verified, each returns a misleading success

**`list_courses` returns nothing without `include_all=true`.** This MCP server is built
for *instructors*; the default listing filters to courses you teach. A student teaches none,
so the default is a bare "No courses found" — not an auth failure.

**`list_course_files` returns `unauthorized` on most courses.** True for ECO206, ECO227
and POL106. This is the instructor hiding the Files tab from students, not a broken
token. Fall through to modules/pages/announcements instead of reporting an error.

**The Pages *index* is disabled course-wide.** `list_pages` fails on all four courses with
"That page has been disabled for this course". **Individual pages still work** —
`get_page_content` with a `page_url` harvested from `get_course_structure` returns the
full body. Never conclude a course has no pages from `list_pages` alone.

**`get_front_page` 404s** ("No front page has been set") on most courses. Harmless.

**`download_course_file` renames files** — spaces become underscores
(`ECO208 Chapter 1.pdf` → `ECO208_Chapter_1.pdf`). If preserving the original display
name matters, fetch `/files/{id}` for `display_name` and write the bytes yourself.

**The syllabus lives somewhere different in every course.** Observed, all four courses,
all different: ECO206 = a PDF embedded in a *Page*; ECO208 = a PDF linked in an
*announcement*; ECO227 = a *module item* file; POL106 = `syllabus_body` text pointing at
an off-Canvas **Google Doc** that the API cannot reach (needs a signed-in browser —
tell him to grab it manually rather than silently omitting it).

**Empty `Y` courses are normal early in term.** ECO206/208/227 are full-year courses;
in September most have only admin pages. Report thin results as thin, don't pad them.

**Due stamps are UTC.** `due_at: "2026-09-22T03:59:59Z"` is **Monday 21 September, 23:59 in Toronto**. Take the
date after converting to `America/Toronto`; slicing the first ten characters put every 23:59 deadline on the day
after, for weeks, before anyone noticed (slate SPEC §20.52).

**The same file can carry two ids.** FCS298 posts its syllabus, course guide, forum guidelines and instructor
contact under two modules each, as separate uploads with different file ids — three pairs byte-identical, one pair
two exports a minute apart. Compare size and bytes before filing a "new" file that has a twin.

**A 404 on a module means "not yet", not "never".** FCS298's *Additional Course Resources* (module `1415680`) was
linked from the 2026-09-15 announcement, answered 404 to every endpoint at 17:19 on 2026-09-16, and was listed with
its file at 23:24 the same day: the professor had not published it yet. A module can be announced before it is
released. Note it, ask again on the next run, and never call it restricted or report the course complete without it.

**MyMedia's page is gated; its stream is not — the video IS downloadable.** The
`play.library.utoronto.ca/watch/<id>` page is a Next.js shell that asks for a UTORid: the HTML holds no stream,
`__NEXT_DATA__.props.pageProps` is `{}`, and an unauthenticated client is bounced to `/login?sessionExpired=true`.
The `/embed/<id>` form answers 200 instead of redirecting but is the same empty shell. **That is only the page.**
The player pulls a plain Wowza HLS stream from a different host that checks nothing at all:

```
https://stream.library.utoronto.ca:1935/MyMedia/play/mp4:1/<32-hex-id>.mp4/playlist.m3u8
```

Verified 2026-09-18 on all three FCS298 videos: 200 on every request from a bare `curl` — no cookie, no token, no
referer, no UTORid. The `<id>` is the same 32-hex string as in the watch or embed URL. The master playlist names a
chunklist, the chunklist names N `.ts` segments; fetch them in order and **concatenate the bytes** (HLS segments of
one Wowza stream share a PAT/PMT, so the join is already valid MPEG-TS and plays as-is).

**Remux to mp4.** NotebookLM rejects `.ts` with a `400`, and slate's media element wants mp4. `ffmpeg -i x.ts -c copy
-bsf:a aac_adtstoasc x.mp4` — seconds, no re-encode. The `aac_adtstoasc` bitstream filter is not optional: TS carries
ADTS audio headers and mp4 wants ASC, and without it the audio is silent in most players. No Homebrew on this Mac —
`bin/install-ffmpeg.sh` drops a static binary at `~/.local/share/slate/ffmpeg` from the `imageio-ffmpeg` wheel.

**Use the module, don't re-derive this.** `scripts/lib/mymedia.mjs` exports `isMyMedia`, `mymediaId`, `probe` and
`download`; `node scripts/mymedia.mjs --course FCS298` fetches every MyMedia video a course has posted into its
*Videos* folder, skipping what is already there. `quercus-sync.mjs` calls it on each run, so a new video downloads
itself and its page carries the file as well as the link. Non-MyMedia video links (YouTube, Zoom) stay links.

The old advice — "record the link, downloading is the browser's job" — was wrong, and wrong in the expensive
direction: it stopped at the first `401`-shaped wall instead of asking what the player actually fetches. When a
platform looks closed, read its network requests before concluding the API cannot reach it.

**A downloaded PDF can carry a text layer that is present and complete nonsense.** FCS298's assigned Kunka
chapter is a clean scan whose every page declares one `Helvetica`/`WinAnsiEncoding` font and decodes to line
noise; pdfjs and PyMuPDF both extract it without error. No extraction flag helps — `sort=True`, `blocks` and
`remove_rotation()` all return the same garbage, because the character codes are wrong, not the reading order.
Do not conclude from scrambled output that the scan is rotated or the images are bad: **render a page and look
at it** before diagnosing. slate now scores every `.pdf.txt` it writes (`wordish` < 0.65 fails) and re-reads a
failing PDF with macOS Vision OCR — `node scripts/pdf-text.mjs` reports `⎘ … re-read by vision OCR`, and
`bin/install-ocr.sh` provisions it. SPEC §20.57 has the numbers and the Accurate=0/Fast=1 trap.

**`only_announcements=true` gives the bodies.** `GET /courses/{id}/discussion_topics?only_announcements=true`
returns each announcement's `message` HTML and its `attachments[]` in one call — the MCP's `list_announcements`
gives titles only, and needs a second call per announcement for the same thing.

---

## Auth

slate's own scripts look for the key in this order: `CANVAS_API_TOKEN` in the environment, the key `node scripts/setup.mjs token`
stores — on a Mac the keychain item `slate-quercus`, on Windows `%LOCALAPPDATA%\Slate\slate-quercus.dpapi`, encrypted by
Windows for this user (DPAPI) — then the Claude desktop config below.
For the canvas MCP server the token lives in `~/Library/Application Support/Claude/claude_desktop_config.json` under
`mcpServers.canvas.env.CANVAS_API_TOKEN`. The desktop app spawns the server as a child
process and injects that env at **spawn time** — so after editing the token you must
**fully quit (Cmd+Q) and reopen** Claude. Editing alone changes nothing for the running
process, which presents as a stubborn `401 Expired access token` while `curl` with the
same token succeeds.

A new token comes from q.utoronto.ca → Account → Settings → **+ New Access Token**.
Only the student can create it; leave the expiry blank. On any `401`, check expiry first —
the previous token silently died mid-summer and 401'd every call.

---

## Full sweep script

`scripts/quercus-sweep.mjs` checks all six file locations across every active course and
reports (or downloads) everything found. It finds the key the way every slate script does (`CANVAS_API_TOKEN` in the
environment, then the key setup stores — the keychain on a Mac, DPAPI on Windows — then the Claude desktop config), so it works from a plain shell
without the MCP server running — and it is Node, not Python: on a Mac without Apple's developer tools `python3` is an
install dialog, not an interpreter.

```bash
node scripts/quercus-sweep.mjs --list
node scripts/quercus-sweep.mjs --course <id>
node scripts/quercus-sweep.mjs --course <id> --download ~/Desktop/"<course>"
```

```bash
node scripts/quercus-sweep.mjs --modules --course <id>   # every module item, every type, with ids, slugs, urls, due dates
```

Use the script for completeness sweeps and weekly syncs; use the MCP tools for
conversational questions ("what's due Thursday?"). The script is the more capable path
because it works around the disabled Pages index and always checks announcements.

## Reconciling Quercus against slate

`node scripts/audit.mjs` (read-only; `--root` for another notes root, `--out` for another report folder) reads
everything the API exposes for every course in `terms.mjs` — module items of every type, page bodies, announcement
bodies and attachments, the syllabus body, the files tab, assignments, quizzes, discussions — and matches each item
against the notebooks, `Hub/_sync-state.json`, `Hub/_inbox.json`, `Hub/_hub.json` and Claude's tasks. It writes a
Markdown report with one table per kind and a list of flags: `NOT IN SLATE`, `PAGE MISSING`, `STALE RECORD`,
`WAITING`, `LINK NOT LISTED`, `VIDEO NO PAGE`, `ITEM NO PAGE`, `NO TASK`, `DUE MISMATCH`, `DISCUSSION NO TASK`,
`TASK LINK MISSING`, `TASK SOURCE MISSING`. Run it after a sync when something looks missing, and before saying that
everything posted is in slate. On 2026-09-16 it found five stale records and a week posted after the morning fetch;
after the fixes it reports none.

## Local folders

Some installs keep a plain copy of a course's documents outside the notebooks, refreshed by
`scripts/mirror-course.mjs` for any course marked `mirror: true` in `scripts/lib/terms.mjs`. It only ever adds files.
If such a folder exists and has been reorganised by hand, **respect the layout that is there** — add to it, never
restructure it.
