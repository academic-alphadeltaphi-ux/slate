#!/usr/bin/env node
// Claude's hands (SPEC §20.37). With `brain: true` in Hub/_settings.json no rule decides where a thing goes or what there is to
// do: Claude does, through this file and only through this file. Every command checks what it is given and changes nothing
// when a check fails; every change is a decision in Hub/_brain.json with its reason and the way to undo it. The pages that
// show the result are written by the scripts that own them — run `plan.mjs --pages` (and `problems.mjs`) after deciding.
const USAGE = `node scripts/brain.mjs <command> [--root <notes root>] [--json]
  status                                          is Claude the brain, what waits, what is open
  inbox [--all]                                   what the fetch brought that nobody has placed yet
  place <inbox id | page.md> --to <folder> --reason "…" [--title T] [--kind K] [--for lecture|tutorial|both] [--dry-run]
        <folder>: General | General/<folder> | <Term>/<Week N (…)> | <Term>/<Week N (…)>/<folder>, optionally "<course notebook>/…"
  part <page.md> --for lecture|tutorial|both --reason "…"   which class in its week a document belongs to
  kind <page.md> --kind <kind> --reason "…"               what a filed page is (lecture, reading, problem-set…), in place
  ignore <inbox id | page.md> --reason "…"        not a course document; kept under Hub/Inbox/Ignored/
  reviewed <inbox id> --reason "…"                an announcement or changed page, read and acted on
  link <announcement.md> --week "<Term>/<Week N (…)>" [--week …] --reason "…"
  task add                                        stdin: a task or [tasks] — { course, what, class:{date,kind} | week | due,
                                                  level?, kind?, graded?, dueTime?, link?, source?, reason }
  task edit <task id>                             stdin: { the fields to change, reason }
  task withdraw <task id> --reason "…"
  task done <task id> --reason "…"               it is done already — a grade, his post, an answer note says so; the next
                                                  plan pass ticks its line once (an untick of his stands after that)
  tasks [--course CODE] [--all]
  check [--course CODE] [--all]                   what code sees in each open task (link on disk, class, level against the date,
                                                  minutes against the words, duplicates) and documents without for: — flags to decide on
  class <CODE> <YYYY-MM-DD> <Lecture|Tutorial|…> (--cancel "why" | --topic "what it is about" | --clear) --reason "…"
  review [list] [--course CODE]                   the topics he flagged for review, week by week, with his notes (SPEC §21.13)
  review set <CODE> <week n> [--topic "…"] [--note "…"]   flag a topic of that week (the same words change it; no topic: the week)
  review clear <CODE> <week n> [--topic "…"]      take one topic off, or every topic of the week
                                                  his flags, set or cleared when he asks — never by the morning on its own
  ask "<question for the student>" [--course CODE] [--page page.md]
  answered <question id> --reason "…"
  day brief [--date YYYY-MM-DD] [--from HH:MM] [--steer "…"]   everything the day is made of, as JSON: the hours, what the student put on it, every row
  day set [--date YYYY-MM-DD] [--from HH:MM]        stdin: { reason, steer?, blocks: [{ row, start, end, why }], waiting: [{ row, why }], picks: [row] } — a draft
  day show [--date YYYY-MM-DD]                      the day as it stands, each block draft or confirmed
  run start [--note "…"] | run done [--note "…"]
  log [--run last | <run id>] [--limit N]
  undo <decision id>
  settings --brain on|off | --model opus|sonnet|<model id> | --mode team|single
        whether Claude is the brain; which model it runs on; one pass, or a team of agents (SPEC §24)`
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { guardFlags } from './lib/argv.mjs'
import { notesRoot } from './lib/root.mjs'
import { writeAtomic } from './lib/problems.mjs'
import { COURSES, todayIso, weeks } from './lib/terms.mjs'
import { REVIEW_JSON, readReview, withReview } from './lib/review.mjs'
import * as B from './lib/brain.mjs'
import * as D from './lib/day.mjs'

const VALUE = ['--root', '--to', '--title', '--kind', '--for', '--reason', '--week', '--course', '--page', '--cancel', '--topic', '--run', '--limit', '--note', '--brain', '--model', '--mode', '--date', '--from', '--steer', '--topic']
const BOOL = ['--json', '--dry-run', '--clear', '--all']
guardFlags([...VALUE, ...BOOL], USAGE)

const args = process.argv.slice(2), pos = [], flags = {}
const JSON_OUT = args.includes('--json')
function fail(msg) { if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg })); else console.error(msg); process.exit(1) }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (VALUE.includes(a)) { if (i + 1 >= args.length) fail(`${a} needs a value`); (flags[a] ||= []).push(args[++i]); continue }
  if (BOOL.includes(a)) { flags[a] = [true]; continue }
  pos.push(a)
}
const one = k => flags[k]?.[flags[k].length - 1] ?? null
const DRY = !!one('--dry-run')
const ROOT = notesRoot(process.argv)
const say = (line, obj) => console.log(JSON_OUT ? JSON.stringify({ ok: true, ...obj }) : line)
const code = k => COURSES[k]?.code || k || '—'
const stdinJson = async what => {
  const text = await new Promise((res, rej) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => (s += d)); process.stdin.on('end', () => res(s)); process.stdin.on('error', rej) })
  try { return JSON.parse(text) } catch (e) { throw new Error(`${what} expects JSON on stdin: ${e.message}`) }
}
const where = t => (t.attach?.class ? `before the ${t.attach.class.kind.toLowerCase()} on ${t.attach.class.date}` : `in week ${t.attach?.week}`)

const [cmd, sub, ...rest] = pos
try {
  if (!cmd) fail(USAGE)

  if (cmd === 'status') {
    const settings = await B.readSettings(ROOT), brain = await B.readBrain(ROOT), waiting = await B.inboxItems(ROOT)
    const open = Object.values(brain.tasks).filter(t => !t.withdrawn), qs = Object.values(brain.questions).filter(q => !q.answered)
    const last = brain.runs[brain.runs.length - 1] || null
    const mode = B.brainMode(settings)
    say(`Claude is ${settings.brain ? '' : 'not '}the brain${settings.brain ? ` (${mode})` : ''} · ${waiting.length} waiting in the inbox · ${open.length} task(s) · ${qs.length} open question(s)${brain.current ? ` · run ${brain.current} in progress` : ''}${last ? ` · last run started ${last.startedAt}` : ''}`,
      { brain: !!settings.brain, mode, inbox: waiting.length, tasks: open.length, questions: qs.length, current: brain.current, lastRun: last })
  } else if (cmd === 'inbox') {
    const items = await B.inboxItems(ROOT, { all: !!one('--all') })
    // the words to read before deciding: a PDF's cached text beside it, else the page itself
    for (const it of items) {
      const assets = path.join(ROOT, String(it.page).replace(/\.md$/, '.assets'))
      it.read = [(it.page), ...(await fs.readdir(assets).catch(() => [])).filter(f => /\.(txt|transcript\.json)$/i.test(f)).map(f => `${String(it.page).replace(/\.md$/, '.assets')}/${f}`)]
    }
    if (!JSON_OUT) for (const it of items) console.log(`${it.id || '-'}  ${code(it.courseKey)}  ${it.page}${it.module ? `  · module: ${it.module}` : ''}${it.heading ? `  · heading: ${it.heading}` : ''}${it.status && it.status !== 'waiting' ? `  (${it.status})` : ''}`)
    say(`${items.length} item(s)${one('--all') ? '' : ' waiting'}`, { items })
  } else if (cmd === 'tasks') {
    const brain = await B.readBrain(ROOT), ck = one('--course') ? B.courseKeyOf(one('--course')) : null
    if (one('--course') && !ck) fail(`course: one of ${Object.values(COURSES).map(c => c.code).join(', ')}`)
    const list = Object.values(brain.tasks).filter(t => (one('--all') || !t.withdrawn) && (!ck || t.courseKey === ck))
    if (!JSON_OUT) for (const t of list) console.log(`${t.id}  ${code(t.courseKey)}  ${where(t)}${t.due ? ` · due ${t.due}${t.dueTime ? ' ' + t.dueTime : ''}` : ''} · ${t.level} · ${t.what}${t.withdrawn ? '  (withdrawn)' : ''}${t.done ? `  (done: ${t.done.reason})` : ''}`)
    say(`${list.length} task(s)`, { tasks: list })
  } else if (cmd === 'check') {
    // Read-only (SPEC §24.5): the course agents answer every flag, the critic checks they did. --all lists clean tasks too.
    const { checkCourse } = await import('./lib/check.mjs')
    const ck = one('--course') ? B.courseKeyOf(one('--course')) : null
    if (one('--course') && !ck) fail(`course: one of ${Object.values(COURSES).map(c => c.code).join(', ')}`)
    const out = []
    for (const k of ck ? [ck] : Object.keys(COURSES)) out.push(await checkCourse(ROOT, k, { today: todayIso() }))
    if (!JSON_OUT) for (const c of out) {
      console.log(`${c.course} · ${c.open} open task(s), ${c.flagged} flagged · ${c.documents.length} document(s) without for:`)
      for (const t of c.tasks) if (t.flags.length || one('--all')) console.log(`  ${t.id}  ${t.level} · ${t.minutes ?? '?'} min · ${t.what.slice(0, 70)}${t.flags.length ? '' : '  — ok'}${t.flags.map(f => `\n      ${f.kind}: ${f.why}${f.suggest ? `  → ${f.suggest}` : ''}`).join('')}`)
      for (const d of c.documents) console.log(`  ${d.page}\n      for: ${d.flags[0].why}`)
    }
    say(`${out.reduce((n, c) => n + c.flagged, 0)} flagged task(s)`, { courses: out })
  } else if (cmd === 'log') {
    const brain = await B.readBrain(ROOT), run = one('--run'), limit = Number(one('--limit')) || 50
    const { run: r, decisions } = run ? B.decisionsOf(brain, run) : { run: null, decisions: brain.decisions.slice(-limit) }
    if (!JSON_OUT) for (const d of decisions) console.log(`${d.id}  ${d.at}  ${d.type.padEnd(13)} ${d.summary}${d.reason ? ` — ${d.reason}` : ''}${d.undone ? '  (undone)' : ''}`)
    say(`${decisions.length} decision(s)${r ? ` in ${r.id}` : ''}`, { run: r, decisions })
  } else if (cmd === 'day' && sub === 'brief') {
    // Read-only, always JSON: it is what the day agent reads before drafting the day (SPEC §23).
    // `runSteer`: the one-run correction the day agent's runner put in SLATE_DAY_STEER (or --steer by hand) — never stored.
    const g = await D.gatherDay(ROOT, { date: one('--date') || undefined, now: one('--from') })
    console.log(JSON.stringify(D.briefDay(g, { runSteer: one('--steer') ?? process.env.SLATE_DAY_STEER ?? null })))
  } else if (cmd === 'day' && sub === 'show') {
    // The day as the student sees it: every block with its state — the morning note and the email read these lines.
    const date = one('--date') || todayIso(), g = await D.gatherDay(ROOT, { date }), v = D.viewDay(g)
    say([`${date} · ${D.statusLine(v)}${v.draft?.steer ? ` · ${v.draft.steer}` : ''}`, ...D.dayLines(v).map(l => '  ' + l)].join('\n'), { day: v })
  } else if (cmd === 'day' && sub !== 'set') {
    fail('day brief | day set | day show')
  } else if (cmd === 'review') {
    // The topics he flagged for review (SPEC §21.13), in Hub/_review.json — his, like his marks: the morning reads them and
    // writes a task before the test, and sets or clears one only when he asks for it. Not a decision of the brain's, so
    // not in its log; the week screen's Flag a topic for review writes the same file through the same function (withReview).
    const doc = await readReview(ROOT)
    const keyOf = c => Object.keys(COURSES).find(k => k === c || COURSES[k].code.toLowerCase() === String(c || '').toLowerCase()) || null
    if (!sub || sub === 'list') {
      const only = one('--course') ? keyOf(one('--course')) : null
      if (one('--course') && !only) fail(`review --course: ${one('--course')} is not one of ${Object.values(COURSES).map(c => c.code).join(', ')}`)
      const rows = Object.entries(doc.courses).filter(([k]) => !only || k === only).flatMap(([k, f]) => Object.entries(f).flatMap(([n, x]) => x.topics.map(t => ({ course: code(k), courseKey: k, week: Number(n), label: x.week, topic: t.topic, note: t.note || null, at: t.at || null }))))
      say(rows.length ? rows.map(r => `${r.course} · ${r.label} · ${r.topic || 'the whole week'}${r.note ? ` (${r.note})` : ''}`).join('\n') : 'Nothing is flagged for review.', { flags: rows })
    } else if (sub === 'set' || sub === 'clear') {
      const k = keyOf(rest[0]), n = Number(rest[1])
      if (!k) fail(`review ${sub} <CODE> <week n>: ${rest[0] || 'no course given'} is not one of ${Object.values(COURSES).map(c => c.code).join(', ')}`)
      const all = weeks(COURSES[k].term), w = all.find(x => x.n === n)
      if (!w) fail(`review ${sub}: ${code(k)} has weeks 1–${all.length}`)
      if (sub === 'clear' && !doc.courses[k]?.[n]) fail(`${code(k)} · ${w.label} has nothing flagged`)
      let r
      try { r = withReview(doc, k, n, w.label, sub === 'set' ? { topic: one('--topic') || '', note: one('--note') || '' } : { remove: true, ...(one('--topic') !== null ? { topic: one('--topic') } : {}) }) }
      catch (e) { fail(`${code(k)} · ${w.label}: ${e.message}`) }
      if (!DRY) await writeAtomic(REVIEW_JSON(ROOT), JSON.stringify(r.doc, null, 2) + '\n')
      say(`${code(k)} · ${w.label}: ${r.week ? r.week.topics.map(t => `${t.topic || 'the whole week'}${t.note ? ` (${t.note})` : ''}`).join(', ') : 'nothing flagged'}${DRY ? ' (dry run)' : ''}`, { week: r.week })
    } else fail('review [list] [--course CODE] | review set <CODE> <week n> [--topic "…"] [--note "…"] | review clear <CODE> <week n> [--topic "…"]')
  } else if (cmd === 'settings') {
    // Two settings of the brain's: whether Claude is it, and which model it runs on (the morning run, the Sync button,
    // the day's re-plan — SPEC §22.7). Opus unless the settings say otherwise.
    const v = one('--brain'), model = one('--model'), mode = one('--mode')
    if (v !== null && !['on', 'off'].includes(v)) fail('settings --brain on|off')
    if (mode !== null && !B.BRAIN_MODES.includes(mode)) fail('settings --mode team|single')
    if (model !== null && !/^[a-z][a-z0-9.-]{1,60}$/i.test(model)) fail('settings --model opus|sonnet|<model id>')
    if (v === null && model === null && mode === null) fail('settings --brain on|off | --model <name> | --mode team|single')
    const s = await B.readSettings(ROOT)
    if (v !== null) s.brain = v === 'on'
    if (model !== null) s.model = model
    if (mode !== null) s.brainMode = mode
    if (!DRY) await writeAtomic(B.SETTINGS_JSON(ROOT), JSON.stringify(s, null, 2) + '\n')
    say(`Claude is ${s.brain ? '' : 'not '}the brain${s.model ? `, on ${s.model}` : ', on the CLI\'s default model'}, as ${B.brainMode(s) === 'team' ? 'a team of agents' : 'one pass'}${DRY ? ' (dry run)' : ''}.`, { brain: !!s.brain, model: s.model || null, mode: B.brainMode(s) })
  } else {
    await B.withLock(ROOT, async () => {
      const brain = await B.readBrain(ROOT)
      let line, out
      if (cmd === 'place') {
        if (!sub) fail('place <inbox id | page.md> --to <folder> --reason "…"')
        if (!one('--to')) fail('place: --to <folder> is required')
        out = await B.placePage(ROOT, brain, sub, { to: one('--to'), title: one('--title'), kind: one('--kind'), part: one('--for'), reason: one('--reason'), dry: DRY })
        line = `${DRY ? 'Would move' : 'Placed'} ${out.from} → ${out.to}${out.part ? ` · for the ${out.part === 'both' ? 'week' : out.part}` : ''}${out.decision ? `  (${out.decision})` : ''}`
      } else if (cmd === 'part') {
        if (!sub) fail('part <page.md> --for lecture|tutorial|both --reason "…"')
        out = await B.partPage(ROOT, brain, sub, one('--for'), one('--reason'))
        line = `${out.page} is for the ${out.part === 'both' ? 'week (both classes)' : out.part}  (${out.decision})`
      } else if (cmd === 'kind') {
        if (!sub) fail('kind <page.md> --kind <kind> --reason "…"')
        out = await B.kindPage(ROOT, brain, sub, one('--kind'), one('--reason'))
        line = `${out.page} is a ${out.kind}${out.before && out.before !== out.kind ? ` (was ${out.before})` : ''}  (${out.decision})`
      } else if (cmd === 'ignore') {
        if (!sub) fail('ignore <inbox id | page.md> --reason "…"')
        out = await B.ignoreItem(ROOT, brain, sub, one('--reason'))
        line = `Ignored ${out.from}  (${out.decision})`
      } else if (cmd === 'reviewed') {
        if (!sub) fail('reviewed <inbox id> --reason "…"')
        out = await B.reviewItem(ROOT, brain, sub, one('--reason'))
        line = `Read ${out.id}  (${out.decision})`
      } else if (cmd === 'link') {
        if (!sub) fail('link <announcement.md> --week "<Term>/<Week N (…)>" --reason "…"')
        out = await B.linkAnnouncement(ROOT, brain, sub, flags['--week'] || [], one('--reason'))
        line = `Linked from ${out.linked.map(l => l.page).join(', ')}  (${out.decision})`
      } else if (cmd === 'task' && sub === 'add') {
        const added = await B.addTasks(ROOT, brain, await stdinJson('task add'))
        out = { tasks: added }
        line = added.map(t => `Added ${t.id}  ${code(t.courseKey)} ${where(t)} · ${t.level} · ${t.what}`).join('\n')
      } else if (cmd === 'task' && sub === 'edit') {
        if (!rest[0]) fail('task edit <task id>  (stdin: the fields to change)')
        out = await B.editTask(ROOT, brain, rest[0], await stdinJson('task edit'))
        line = `Edited ${out.id}  ${code(out.courseKey)} ${where(out)} · ${out.level} · ${out.what}`
      } else if (cmd === 'task' && sub === 'withdraw') {
        if (!rest[0]) fail('task withdraw <task id> --reason "…"')
        out = B.withdrawTask(brain, rest[0], one('--reason'))
        line = `Withdrew ${out.id}  (${out.decision})`
      } else if (cmd === 'task' && sub === 'done') {
        if (!rest[0]) fail('task done <task id> --reason "…"')
        out = await B.doneTask(ROOT, brain, rest[0], one('--reason'))
        line = `Marked ${out.id} done — the next plan pass ticks it  (${out.decision})`
      } else if (cmd === 'task') {
        fail('task add | task edit <id> | task withdraw <id> | task done <id>')
      } else if (cmd === 'class') {
        if (!sub || rest.length < 2) fail('class <CODE> <YYYY-MM-DD> <Lecture|Tutorial|…> (--cancel "why" | --topic "…" | --clear) --reason "…"')
        out = B.setClass(brain, { course: sub, date: rest[0], kind: rest[1], cancel: one('--cancel'), topic: one('--topic'), clear: !!one('--clear'), reason: one('--reason') })
        line = `${out.key}: ${out.entry ? [out.entry.cancel && `cancelled (${out.entry.cancel})`, out.entry.topic && `topic: ${out.entry.topic}`].filter(Boolean).join(' · ') : 'cleared'}  (${out.decision})`
      } else if (cmd === 'ask') {
        if (!sub) fail('ask "<question>" [--course CODE] [--page page.md]')
        out = await B.ask(ROOT, brain, { text: [sub, ...rest].join(' '), course: one('--course'), page: one('--page') })
        line = `Asked ${out.id}  (${out.decision})`
      } else if (cmd === 'answered') {
        if (!sub) fail('answered <question id> --reason "…"')
        out = B.answered(brain, sub, one('--reason'))
        line = `Answered ${out.id}  (${out.decision})`
      } else if (cmd === 'day' && sub === 'set') {
        // A draft, never the day itself (SPEC §23): the student confirms it on the screen.
        const r = await D.proposeDay(ROOT, brain, await stdinJson('day set'), { date: one('--date') || undefined, from: one('--from') })
        const v = D.viewDay({ ...r.g, day: r.day }, r.day), mine = r.day.blocks.filter(b => b.by === 'claude')
        line = [`Drafted ${r.day.date}${r.day.draft.from ? ` from ${r.day.draft.from}` : ''}: ${mine.length} block(s), ${mine.reduce((n, b) => n + b.end - b.start, 0)} min, ${r.day.draft.waiting.length} waiting${r.day.draft.steer ? ` · ${r.day.draft.steer}` : ''}  (${r.decision.id})`, ...D.dayLines(v).map(l => '  ' + l)].join('\n')
        out = { day: v, decision: r.decision.id }
      } else if (cmd === 'run' && sub === 'start') {
        out = { run: B.startRun(brain, one('--note')) }
        line = `Run ${out.run.id} started`
      } else if (cmd === 'run' && sub === 'done') {
        out = { run: B.endRun(brain, one('--note')) }
        const types = {}
        for (const d of brain.decisions.filter(x => x.run === out.run.id && !x.undone)) types[d.type] = (types[d.type] || 0) + 1
        out.types = types
        line = `Run ${out.run.id} done · ${out.run.decisions} decision(s)${Object.keys(types).length ? ': ' + Object.entries(types).map(([k, v]) => `${v} ${k}`).join(', ') : ''}`
      } else if (cmd === 'run') {
        fail('run start | run done')
      } else if (cmd === 'undo') {
        if (!sub) fail('undo <decision id>')
        out = await B.undoDecision(ROOT, brain, sub)
        line = `Undid ${out.id}: ${out.type} · ${out.summary}`
      } else fail(`unknown command: ${cmd}\n${USAGE}`)
      if (!DRY) await B.writeBrain(ROOT, brain)
      say(line + (DRY && cmd !== 'place' ? '  (dry run, nothing written)' : ''), out)
    })
  }
} catch (e) { fail(e.message) }
