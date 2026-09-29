// Which slate this install is (SPEC §21).
//
// slate is one codebase handed to two kinds of person: the student, who runs all of it, and his fraternity brothers, who get
// the same app under Alpha Delta Phi's colours with two features left out and a Claude budget that fits a Pro plan.
// Everything that differs is named here and nowhere else: a feature that is off is never drawn, never mounted, and
// never described to their Claude. `scripts/kit.mjs` rewrites DEFAULT_EDITION when it packages a copy, so the client
// knows at first paint; the server also reads `Hub/_settings.json` → `"edition"`, so an install can be flipped without
// a rebuild.
//
// What each field decides:
//   ask, sheets   the two features the brothers' copy does without (an Ask panel spends the allowance the morning
//                 run needs; study sheets are the student's own workflow)
//   work          Today's work (SPEC §22): the day packed into hours, the timer, the work log. the student's for now — the
//                 packer and the screen are edition-neutral, the brothers' brain prompt does not yet say `minutes`
//   history       git snapshots and the History pane. Off where `git` may be a dialog rather than a command: on a Mac
//                 without Apple's developer tools /usr/bin/git is a shim that offers to install them (server/devtools.js)
//   speech        transcription and dictation (parakeet-mlx on Apple Silicon). The Windows kit sets it false, so the
//                 Transcribe button and the mic never show and the routes answer plainly (SPEC §21.9); on a Mac the
//                 server still says whether the engine is there.
//   hwr           handwriting recognition. Where it is on, the engine still never builds the Swift helper without the
//                 developer tools; it falls through to the uv path, which setup installs
//   budget        'heavy': one long Claude pass reads everything (scripts/brain-prompt.md). 'light': the fetch proposes,
//                 Sonnet decides one course at a time in short sessions with a turn cap (scripts/run.mjs) — the shape
//                 that fits a Claude Pro plan, measured in SPEC §21
//   cadenceDays   how often the scheduled morning runs; Home counts "days behind" from it
//   port          each edition's own, so two copies on one Mac never open a window onto each other
//   appDir        where the built app is put: 'Applications' for the student, 'Desktop' for the brothers — setup ends with the
//                 app on their Desktop and they double-click it there (2026-09-23)
//   plan          the Claude plan the copy is built for ('Pro' | 'Max'): the guide and CLAUDE.md say it
//   morningAt     the default hour of the scheduled morning (HH:MM)
//   costScale     how much dearer the edition's model is than Sonnet; the session caps in scripts/run.mjs scale by it
//   runner        who decides in the morning: 'cli' — scripts/run.mjs spawns one `claude -p` session per course (needs
//                 the command line tool, one Terminal login, launchd or Task Scheduler); 'app' — a scheduled task in
//                 the Claude desktop app is the session, and run.mjs fetch/brief/finish are what it calls (SPEC §21.8).
//                 No terminal, no login: the Pro brothers' way since 2026-09-24
export const EDITIONS = {
  full: {
    key: 'full', name: 'slate', short: 'slate',
    ask: true, sheets: true, history: true, hwr: true, work: true,
    accent: null, crest: null,
    app: 'Slate', bundleId: 'org.slate.notebook', copyright: 'slate', port: 5177, appDir: 'Applications',
    budget: 'heavy', cadenceDays: 1, model: null,
  },
  adphi: {
    key: 'adphi', name: 'Slate for Alpha Delta Phi', short: 'ΑΔΦ · Slate',
    ask: false, sheets: false, history: false, hwr: true, work: false,
    // Alpha Delta Phi's published palette (alphadeltaphi.org/branding): emerald PMS 357 #185932, gold PMS 113C #ffd65e,
    // sage #bbcec0, cream #fffaea, tan #dbd4c7, with black and white. Two tints are derived for legibility and nothing
    // else: the dark theme's accent is the emerald lifted until it reads on a dark ground, and the light theme's gold is
    // deepened so it can carry text. The crest is the Fraternity's own mark, served by the client from public/brand/.
    accent: { light: '#185932', dark: '#4fb883', gold: '#c9a227', goldDark: '#ffd65e', cream: '#fffaea', sage: '#bbcec0', tan: '#dbd4c7' },
    crest: '/brand/adphi-crest.png',
    app: 'Slate ADPhi', bundleId: 'org.alphadeltaphi.toronto.slate', copyright: 'Alpha Delta Phi · Toronto', port: 5178, appDir: 'Desktop',
    // every morning, and the morning is a scheduled task in the Claude app (SPEC §21.10: daily since 2026-09-29, was every 2 days)
    budget: 'light', cadenceDays: 1, model: 'sonnet', plan: 'Pro', morningAt: '07:30', costScale: 1, runner: 'app',
  },
}
// A brother on a Max plan (2026-09-23; a brother's copy): the same kit and the same light routine, every morning at seven.
// Since 2026-09-29 it runs as a scheduled task in the Claude app like the Pro copy (no command line tool, no Terminal
// login); an app task runs on the model the app is set to, so `model` and `costScale` only matter on the optional CLI road.
EDITIONS['adphi-max'] = { ...EDITIONS.adphi, key: 'adphi-max', model: 'fable', cadenceDays: 1, plan: 'Max', morningAt: '07:00', costScale: 5, runner: 'app' }
export const DEFAULT_EDITION = 'adphi'
export const editionOf = key => EDITIONS[String(key || '').toLowerCase()] || EDITIONS[DEFAULT_EDITION]
// A feature is on unless this edition turns it off, so an edition that forgets a key keeps everything.
export const has = (ed, feature) => editionOf(ed)[feature] !== false

// The edition this build *is*. The kit builder rewrites DEFAULT_EDITION above when it packages a copy, so the client
// knows synchronously at first paint — a feature that is off is never drawn and then taken away again.
export const THIS = editionOf(DEFAULT_EDITION)
