// Today's work (SPEC §23): the day as it stands, the student's acts on it (drop, move, remove, confirm, a meal, the bus), the
// day agent that drafts it and the calendar agent that sends it, the timer, estimates and attendance. Claude drafts
// (scripts/brain.mjs day set); this file records what the student does and starts the sessions. Nothing here drafts by itself:
// a screen opening never starts Claude, and nothing fills a hole the student made.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as D from '../../scripts/lib/day.mjs'
import * as W from '../../scripts/lib/work.mjs'
import { startDayAgent, startSendAgent, summaryOf, nowHM } from '../../scripts/lib/day-agent.mjs'
import { todayIso } from '../../scripts/lib/terms.mjs'
import { writeAtomic } from '../../scripts/lib/problems.mjs'
import { withDefaults, DEFAULT_PREFS, minutesOf, windowFor, toMin } from '../../src/dayplan.js'
import { dayClock, unwrapped } from '../../src/today.js'

const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

export function register(app, { ROOT, wrap, HttpError, repo, env, q }) {
  const settings = async () => (await readJson(path.join(ROOT, 'Hub', '_settings.json'), {})) || {}
  const dateOf = req => { const d = q(req, 'date') || req.body?.date || todayIso(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'date: YYYY-MM-DD'); return d }
  let drafting = null, sending = null

  // ---- the day --------------------------------------------------------------------------------------------------
  // Any date. Reading never writes.
  app.get('/api/day', wrap(async (req, res) => {
    const date = dateOf(req)
    const g = await D.gatherDay(ROOT, { date })
    const [log, att] = await Promise.all([W.readLog(ROOT), W.readAttendance(ROOT)])
    res.json({ day: D.viewDay(g), today: todayIso(), now: nowHM(), brain: g.brainOn, prefs: { meals: g.prefs.meals }, running: log.running, attendance: att.classes, estimates: g.estimates,
      drafting: drafting && drafting.date === date ? summaryOf(drafting) : drafting?.running ? summaryOf(drafting) : null, sending: sending && sending.date === date ? summaryOf(sending) : null })
  }))
  // One act of the student's: { date, op, … }
  //   place   { rowId, start, end }   a to-do dropped on an hour — a draft of his
  //   move    { id, start, end }      a block to another hour or length — a draft again
  //   remove  { id }                  off the day, back in the list; Claude never proposes it here again
  //   confirm { ids? }                solid; no ids = every draft on the day
  //   meal    { name, start|null }    a meal's hour for the day (null puts it back)
  //   mealsize { name, minutes, start? }   a meal's standing length, every day
  //   workable { id, on|null }        an event he can (or cannot) work through
  // Times are HH:MM, unwrapped past midnight (25:30). Returns { day, notice }.
  // The gather and the write are one step, in turn with every other writer of the day (D.serialDay): two quick drags, or
  // a drag while Claude's draft lands, each read the other's write.
  app.post('/api/day/act', wrap(async (req, res) => {
    const b = req.body || {}, date = dateOf(req)
    const { g, out, saved } = await D.serialDay(ROOT, async () => {
      if (b.op === 'mealsize') { try { await D.setMealMinutes(ROOT, String(b.name || ''), Number(b.minutes)) } catch (e) { throw new HttpError(400, e.message) } }
      const g = await D.gatherDay(ROOT, { date })
      let out
      try {
        if (b.op === 'place') out = D.placeRow(g, g.day, { rowId: String(b.rowId || ''), start: String(b.start || ''), end: String(b.end || '') })
        else if (b.op === 'move') out = D.moveBlock(g, g.day, { id: String(b.id || ''), start: String(b.start || ''), end: String(b.end || '') })
        else if (b.op === 'remove') out = D.removeBlock(g, g.day, { id: String(b.id || '') })
        else if (b.op === 'confirm') out = D.confirmBlocks(g, g.day, { ids: Array.isArray(b.ids) ? b.ids.map(String) : null })
        else if (b.op === 'meal') out = D.moveMeal(g, g.day, { name: String(b.name || ''), start: b.start == null ? null : String(b.start) })
        else if (b.op === 'mealsize') out = D.moveMeal(g, g.day, { name: String(b.name || ''), start: b.start == null ? undefined : String(b.start) })
        else if (b.op === 'workable') out = D.setWorkable(g, g.day, { id: String(b.id || ''), on: b.on === null || b.on === undefined ? null : !!b.on })
        else throw new Error('op: place, move, remove, confirm, meal, mealsize or workable')
      } catch (e) { throw new HttpError(400, e.message) }
      return { g, out, saved: await D.writeDay(ROOT, out.day, { g }) }
    })
    res.json({ day: D.viewDay({ ...g, day: saved }, saved), notice: out.notice || null })
  }))
  app.get('/api/day/prefs', wrap(async (req, res) => { const { prefs } = await D.readPrefs(ROOT); res.json({ prefs }) }))
  app.post('/api/day/prefs', wrap(async (req, res) => {
    const patch = req.body?.prefs
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'prefs: an object')
    // Written whole or not at all, and in turn with the other writers of the file (a meal's length, a first draft creating
    // it): a half-written file read by one of them was taken for no file and written over with the defaults.
    const next = await D.serialDay(ROOT, async () => {
      const cur = (await readJson(D.PREFS_JSON(ROOT), null)) || { _note: "Today's work — the standing preferences (SPEC §22).", ...DEFAULT_PREFS }
      const next = { ...cur }
      for (const [k, v] of Object.entries(patch)) { if (k.startsWith('_')) continue; next[k] = v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k]) ? { ...cur[k], ...v } : v }
      await fs.mkdir(path.dirname(D.PREFS_JSON(ROOT)), { recursive: true })
      await writeAtomic(D.PREFS_JSON(ROOT), JSON.stringify(next, null, 2) + '\n')
      return next
    })
    res.json({ prefs: withDefaults(next) })
  }))

  // ---- the draft: the day agent ----------------------------------------------------------------------------------
  // Draft (or Redraft) with his one line. Today is drafted from now; a day ahead whole. Only Claude's own drafts are
  // replaced; what the student put down stays, and what he took off is never proposed again that day.
  app.get('/api/day/draft/status', (req, res) => res.json(summaryOf(drafting)))
  app.post('/api/day/draft', wrap(async (req, res) => {
    if (drafting?.running) return res.status(409).json({ error: `Claude is already drafting ${drafting.date}`, ...summaryOf(drafting) })
    const date = dateOf(req)
    // The slot is taken before the first await: two presses in the same instant each passed the check above and started
    // an agent apiece. The agent's own job replaces the claim; anything else gives the slot back.
    const prev = drafting, claim = drafting = { running: true, ok: null, startedAt: new Date().toISOString(), finishedAt: null, date, from: null, output: '' }
    try {
      const s = await settings(), { prefs } = await D.readPrefs(ROOT)
      // Today is drafted from now, and today runs to its hard end: at 00:40 the day still open is yesterday, from 24:40.
      const c = dayClock(todayIso(), toMin(nowHM()), windowFor(date, prefs).hardEnd)
      const from = date === c.date ? unwrapped(c.nowMin) : null
      await D.setRequest(ROOT, date, typeof req.body?.note === 'string' ? req.body.note : '')
      if (!s.brain) {
        // Claude is not the brain: the packer's arithmetic, at once, the same way a draft of Claude's is laid.
        const { g, saved } = await D.serialDay(ROOT, async () => { const g = await D.gatherDay(ROOT, { date, now: from }); return { g, saved: await D.writeDay(ROOT, D.applyDraft(g, g.day, D.packerDraft(g, { from }), { by: 'packer' }), { g }) } })
        drafting = prev
        return res.json({ started: false, ok: true, day: D.viewDay({ ...g, day: saved }, saved) })
      }
      drafting = startDayAgent({ repo, root: ROOT, env, date, from, model: req.body?.model || s.model || 'opus', maxUsd: Number(s.replanMaxUsd) > 0 ? s.replanMaxUsd : 4 })
      res.json({ started: true, ...summaryOf(drafting) })
    } catch (e) { if (drafting === claim) drafting = prev; throw e }
  }))

  // ---- Send to Google Calendar: the calendar agent -----------------------------------------------------------------
  app.get('/api/day/send/status', (req, res) => res.json(summaryOf(sending)))
  app.post('/api/day/send', wrap(async (req, res) => {
    if (sending?.running) return res.status(409).json({ error: 'Already sending a day to Google Calendar', ...summaryOf(sending) })
    const date = dateOf(req)
    const g = await D.gatherDay(ROOT, { date })
    if (!g.day.blocks.some(b => b.state === 'confirmed') && !g.day.sent) throw new HttpError(400, 'nothing confirmed on this day yet — confirm it first')
    sending = startSendAgent({ repo, root: ROOT, env, date, model: (await settings()).calendarModel || 'sonnet' })
    res.json({ started: true, ...summaryOf(sending) })
  }))

  // ---- the timer and the log ------------------------------------------------------------------------------------
  app.get('/api/work', wrap(async (req, res) => {
    const [log, week] = await Promise.all([W.readLog(ROOT), W.weekOf(ROOT, q(req, 'date') || todayIso())])
    res.json({ running: log.running, week, calibration: log.calibration, sessions: log.sessions.slice(-50) })
  }))
  // What a session teaches is measured against the row's estimate before any calibration (W.learn): the minutes minutesOf
  // starts from — Claude's, else the kind's usual — not the block or the planned minutes, which are already that times the
  // old ratio. His own number is his, never scaled, and teaches nothing; nor does a row that cannot be found.
  const estimateOf = async rowId => { try { const g = await D.gatherDay(ROOT, { date: todayIso() }); const r = g.rows.find(x => x.id === rowId); return r ? minutesOf(r, g.prefs, g.calibration) : null } catch { return null } }
  const measure = e => ({ base: e && !e.student ? e.base : null, student: !!e?.student })
  app.post('/api/work', wrap(async (req, res) => {
    const b = req.body || {}
    const e = b.op === 'start' || b.op === 'asked' ? await estimateOf(String(b.rowId || '')) : null
    try {
      // No block and no number from the screen (To do, the task sheet): the row's own minutes, as the day would give it.
      if (b.op === 'start') return res.json({ running: await W.startWork(ROOT, { ...b, planned: Number.isFinite(b.planned) ? b.planned : e?.minutes ?? null, ...measure(e) }) })
      if (b.op === 'pause') return res.json({ running: await W.pauseWork(ROOT) })
      if (b.op === 'resume') return res.json({ running: await W.resumeWork(ROOT) })
      if (b.op === 'stop') return res.json({ running: null, session: await W.stopWork(ROOT, { done: b.done !== false, minutes: Number.isFinite(b.minutes) ? b.minutes : null }) })
      if (b.op === 'drop') return res.json({ running: null, dropped: await W.dropWork(ROOT) })
      if (b.op === 'asked') return res.json({ running: (await W.readLog(ROOT)).running, session: await W.askedWork(ROOT, { ...b, ...measure(e) }) })
    } catch (e) { throw new HttpError(400, e.message) }
    throw new HttpError(400, 'op: start, pause, resume, stop, drop or asked')
  }))

  // ---- the student's estimates -------------------------------------------------------------------------------------------
  app.get('/api/estimates', wrap(async (req, res) => res.json({ rows: (await W.readEstimates(ROOT)).rows })))
  app.post('/api/estimate', wrap(async (req, res) => {
    const b = req.body || {}
    let entry
    try { entry = await W.setEstimate(ROOT, { rowId: String(b.rowId || ''), minutes: b.minutes === null || b.minutes === undefined ? null : Number(b.minutes), title: b.title || null }) } catch (e) { throw new HttpError(400, e.message) }
    res.json({ entry, rows: (await W.readEstimates(ROOT)).rows })
  }))

  // ---- attendance -----------------------------------------------------------------------------------------------
  app.get('/api/attendance', wrap(async (req, res) => res.json({ classes: (await W.readAttendance(ROOT)).classes })))
  app.post('/api/attendance', wrap(async (req, res) => {
    const b = req.body || {}
    let entry
    try { entry = await W.setAttendance(ROOT, { meetingId: String(b.meetingId || ''), attended: b.attended === null || b.attended === undefined ? null : !!b.attended, courseKey: b.courseKey || null, date: b.date || null, kind: b.kind || null, note: b.note || null }) }
    catch (e) { throw new HttpError(400, e.message) }
    res.json({ entry, classes: (await W.readAttendance(ROOT)).classes })
  }))
}
