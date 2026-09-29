// The day, drafted and confirmed (SPEC §23) — the rules both sides share. Pure, bundled on the server and in the app like
// the packer, so a drop the screen previews is the drop the server writes.
//
// A block is a to-do given an hour: { id, rowId, start, end, by: 'claude' | 'student', state: 'draft' | 'confirmed' }. Two
// states only. Faded is a draft — Claude's proposal, or the student's own drop or move that he has not confirmed yet — and solid
// is confirmed. Claude's blocks are always drafts (`by: 'claude'` implies `state: 'draft'`): confirming one makes it
// the student's, and a Redraft replaces only Claude's own. Time is minutes past the day's midnight; 25:30 is 1530.
import { addDays } from './calendar.js'

export const overlaps = (a, b) => a.start < b.end && b.start < a.end
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

// What a block may not sit on: the classes he goes to, the walks, the calendar's events he cannot work through, the
// frat, the meals. A workable event (the bus) and a class he is not going to are free time.
export const WALL_KINDS = new Set(['class', 'walk', 'event', 'fixed', 'meal'])
export const wallsOf = (busy = [], { meals = true } = {}) => busy.filter(b => WALL_KINDS.has(b.kind) && !b.workable && (meals || b.kind !== 'meal')).map(b => ({ start: b.start, end: b.end, kind: b.kind, title: b.title }))
// Walls that touch — the walk back and lunch — read as one.
export function mergeWalls(walls) {
  return [...walls].sort((a, b) => a.start - b.start).reduce((acc, w) => { const last = acc[acc.length - 1]; if (last && w.start <= last.end) last.end = Math.max(last.end, w.end); else acc.push({ start: w.start, end: w.end }); return acc }, [])
}

// snapStart(start, len, walls, lo, hi) → where a dragged thing lands: where it was dropped when that is free, else the
// nearest free side of whatever it would cover — lunch is never buried under a drop.
export function snapStart(start, len, walls, lo, hi) {
  const merged = mergeWalls(walls)
  const free = s => s >= lo && s + len <= hi && !merged.some(m => s < m.end && m.start < s + len)
  if (free(start)) return start
  const cands = merged.flatMap(m => [m.start - len, m.end]).filter(free).sort((a, b) => Math.abs(a - start) - Math.abs(b - start))
  return cands.length ? cands[0] : clamp(start, lo, hi - len)
}

// pushDown(blocks, anchor, walls, { hardEnd }) → { blocks, moved, off }: the student put `anchor` somewhere — a block, a row
// dropped from the list, a meal — and what it lands on moves later to make room (his answer of 2026-09-29: "push the
// others down"). In start order, a block that collides with the anchor or with one already settled goes to the first
// free minute after its own start, jumping over the walls; one that collides with nothing stays. A finished block and
// the anchor never move. A block pushed past the hard end (03:00) leaves the day: `off` names it, and the caller sends
// it back to the list. `moved` names the blocks whose hour changed.
export function pushDown(blocks, anchor, walls, { hardEnd = 1620 } = {}) {
  const hard = mergeWalls(walls)
  const fixed = blocks.filter(b => b.id !== anchor.id && b.done)
  const taken = [{ start: anchor.start, end: anchor.end }, ...fixed.map(b => ({ start: b.start, end: b.end }))]
  const clash = (s, e) => hard.some(w => s < w.end && w.start < e) || taken.some(t => s < t.end && t.start < e)
  const firstFree = (from, len) => {
    let s = from
    for (let guard = 0; guard < 400; guard++) {
      const hit = [...hard, ...taken].filter(w => s < w.end && w.start < s + len).sort((a, b) => b.end - a.end)[0]
      if (!hit) return s
      s = hit.end
    }
    return s
  }
  const moved = [], off = [], out = []
  for (const b of [...blocks].filter(b => b.id !== anchor.id && !b.done).sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!clash(b.start, b.end)) { taken.push({ start: b.start, end: b.end }); out.push(b); continue }
    const len = b.end - b.start, s = firstFree(b.start, len)
    if (s + len > hardEnd) { off.push(b.id); continue }
    const nb = { ...b, start: s, end: s + len }
    taken.push({ start: nb.start, end: nb.end }); out.push(nb); moved.push(b.id)
  }
  const anchorBlock = blocks.find(b => b.id === anchor.id)
  return { blocks: [...fixed, ...(anchorBlock ? [{ ...anchorBlock, start: anchor.start, end: anchor.end }] : []), ...out].sort((a, b) => a.start - b.start || a.end - b.end), moved, off }
}

// A confirmed block whose hour has gone by and whose to-do is not ticked: it stays where it was, marked missed, with a
// way back to the list (his answer). A draft that has gone by is only a draft. `today` and `nowMin` are the day clock's.
export const isMissed = (b, { date, today, nowMin }) => !!b && b.state === 'confirmed' && !b.done && (date < today || (date === today && nowMin != null && b.end <= nowMin))

// dayClock(today, min, hardEndMin) → { date, nowMin }: the day a moment belongs to. A day runs to its hard end — 27:00,
// three the next morning — so at 00:40 it is still yesterday, at 24:40: a block from midnight to half past one is not
// missed at ten past twelve, and a Redraft then drafts from 24:40, not from nine. `today` is the calendar's date and
// `min` the minutes past its midnight. Only the day screen, its missed marks and the day routes read the clock so; the
// rest of the app keeps the calendar's date.
export const dayClock = (today, min, hardEndMin = 1620) => (min < hardEndMin - 1440 ? { date: addDays(today, -1), nowMin: min + 1440 } : { date: today, nowMin: min })
// Minutes as HH:MM that does not wrap and sorts as text: 1480 is 24:40.
export const unwrapped = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// What a day asks of the student, in a word: how many drafts wait to be confirmed, and whether they are only his own changes to
// a day he had confirmed (then the button says "Confirm 2 changes"; Claude's proposals are never called changes).
export function draftCount(day) {
  const drafts = (day?.blocks || []).filter(b => b.state === 'draft' && !b.done)
  const claude = drafts.filter(b => b.by === 'claude').length, confirmed = (day?.blocks || []).filter(b => b.state === 'confirmed').length
  return { drafts: drafts.length, claude, mine: drafts.length - claude, confirmed, changes: confirmed > 0 && drafts.length > 0 && claude === 0 }
}
