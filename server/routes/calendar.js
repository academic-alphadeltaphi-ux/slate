// GET /api/calendar (SPEC §20.8): the readback the morning pass wrote (Hub/_calendar.json — the next seven days of
// every calendar, slate's own events marked) merged with the push's health (Hub/_calendar-state.json). 200 before
// the first run, with no events and `sync: null`, so the status line can say "not synced yet". The server only reads.
import fs from 'node:fs/promises'
import path from 'node:path'

const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

export function register(app, { ROOT, wrap }) {
  app.get('/api/calendar', wrap(async (req, res) => {
    const hub = path.join(ROOT, 'Hub')
    const cal = await readJson(path.join(hub, '_calendar.json'), null)
    const state = await readJson(path.join(hub, '_calendar-state.json'), null)
    const tags = state?.tags && typeof state.tags === 'object' ? state.tags : {}
    res.json({
      version: 1,
      updatedAt: cal?.updatedAt || null,
      timeZone: cal?.timeZone || 'America/Toronto',
      from: cal?.from || null,
      to: cal?.to || null,
      calendars: Array.isArray(cal?.calendars) ? cal.calendars : [],
      events: Array.isArray(cal?.events) ? cal.events : [],
      sync: state?.sync || null,
      tracked: Object.values(tags).filter(t => t && !t.gone).length,
      calendarId: state?.calendarId || null,
    })
  }))
}
