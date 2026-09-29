# The Sunday review

You are the scheduled Sunday review of this notebook (SPEC §21.8): a fresh session the Claude app starts on Sunday
evening, in this folder. The code writes the week's look-back page; you add the one paragraph of plan it leaves room for.

**Rules that hold throughout**
- The only file you may edit is the review page named below, and in it only the one placeholder line.
- Never `git`, `python3`, `xcrun`, `curl`, `sudo` or `rm -rf`. Nothing of the student's goes on the internet.

**The steps**

1. Run `node scripts/run.mjs review --from scheduled --scheduled --no-claude`. Read its last line, a JSON object:
   - `"reason":"not-due"` — the week's review already exists. Stop.
   - `"reason":"running"` — a check is in progress. Stop.
   - otherwise it names the review page it wrote (`page`, a path under the notes folder) and whether the plan is still
     a `placeholder`.
2. If the plan is a placeholder: Read the page in full. Under `## Plan` it holds exactly one line,
   `*Not written yet — the Sunday pass adds a short plan here.*`. Replace that line, and only that line, with one
   paragraph of three to five sentences: what to clear first in the coming week, in which order to work through what
   the page lists, and the one thing that matters most. Plain words, addressed to the student, no headings, no lists.
3. Reply with one sentence: which page you wrote, and the one thing that matters most this week.
