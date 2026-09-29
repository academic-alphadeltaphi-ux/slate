// The timer's start, from anywhere a task row is drawn (SPEC §22): the Today's work ledger, To do, the task sheet.
// The running session carries what ticking the task needs, so the pill can mark it done from any screen.
import { api } from './api.js'

export const kindOfRow = r => (r.type === 'hand-in' ? 'due' : r.type === 'mine' ? 'mine' : (r.task?.kind || 'other'))
// Minutes by kind when the day gave none — the same table the packer starts from.
export const DEFAULT_MINUTES = { read: 45, watch: 60, problems: 90, review: 40, write: 120, quiz: 30, bring: 5, due: 60, participation: 45, prepare: 60, other: 45, mine: 30 }
export const tickHandle = r => (r.type === 'mine' && r.raw ? { raw: r.raw } : r.meeting?.planPage && r.task?.key ? { meeting: { id: r.meeting.id, planPage: r.meeting.planPage, planBlock: r.meeting.planBlock }, task: { key: r.task.key, text: r.task.text, pending: !!r.task.pending } } : null)
// Planned is the block's length, or the number given; with neither the server takes the row's own minutes (his, else
// Claude's, else the usual, calibrated) — the kind's default here was not the row's. What the session teaches is
// measured on the server against the row's estimate, never against this.
export async function startWork(row, { block = null, planned = null } = {}) {
  const minutes = block?.minutes ?? planned ?? null
  const r = await api.work({ op: 'start', rowId: row.id, title: row.title, courseKey: row.courseKey || null, course: row.course || null, kind: kindOfRow(row), planned: minutes, blockId: block?.id || null, tick: tickHandle(row) })
  window.dispatchEvent(new Event('slate:work'))
  return r.running
}
