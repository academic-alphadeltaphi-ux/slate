// The course colours (SPEC §20.60). Nine swatches, each a pigment rather than a screen colour — oxblood, navy, forest,
// ochre, plum, mulberry, bronze, teal, slate — so a course reads as a name on a spine, not as a tag on a dashboard.
//
// A notebook's colour is stored in its _slate.json, the hub carries each course's, and both were picked from the old
// saturated set; nothing on disk is rewritten. Instead every colour that reaches the client passes through `tone`: an
// old swatch becomes its pigment, anything else passes as it is. `api.js` runs `repaint` over every response, so the
// sidebar, Home, the course screen, the plan and the Library agree without each remapping on its own.
export const COURSE_COLORS = ['#7a2e2b', '#2c3e6b', '#2f5d45', '#9a7420', '#5b3a6e', '#8b3a5a', '#8a5a2b', '#2e5f66', '#4d5a66']
export const ACADEMIC = {
  '#e11d48': '#7a2e2b',   // rose → oxblood
  '#ea580c': '#8a5a2b',   // orange → bronze
  '#ca8a04': '#9a7420',   // amber → ochre
  '#16a34a': '#2f5d45',   // green → forest
  '#0891b2': '#2e5f66',   // cyan → teal
  '#2563eb': '#2c3e6b',   // blue → navy
  '#7c3aed': '#5b3a6e',   // violet → plum
  '#db2777': '#8b3a5a',   // pink → mulberry
  '#57534e': '#4d5a66',   // stone → slate
}
export const tone = hex => (typeof hex === 'string' ? ACADEMIC[hex.toLowerCase()] || hex : hex)
// Every `color` field in a response, at any depth, in place — except under `blocks` and `layout`, which are a page's
// own text and ink: a stroke's colour is the colour it was drawn in, and stays. A day's `blocks` (SPEC §23) are not a
// page's: to-dos given an hour, each in its course's colour — they carry a `rowId` — and are toned beside the classes.
const dayBlocks = v => Array.isArray(v) && v.length > 0 && v.every(b => b && typeof b === 'object' && typeof b.rowId === 'string')
export function repaint(x) {
  if (!x || typeof x !== 'object') return x
  if (Array.isArray(x)) { for (const y of x) repaint(y); return x }
  if (Array.isArray(x.strokes)) return x
  for (const k in x) {
    if ((k === 'blocks' && !dayBlocks(x[k])) || k === 'layout') continue
    if (k === 'color' && typeof x[k] === 'string') x[k] = tone(x[k])
    else if (x[k] && typeof x[k] === 'object') repaint(x[k])
  }
  return x
}
