// Weeks he flagged for review (SPEC §21.13), and the tests they reach. A flag is { week, note, at } under a course and a
// week number (Hub/_review.json, scripts/lib/review.mjs); a test reaches the weeks of its coverage window
// (src/calendar.js coverageWindow → `window.weeks`), so a flag on Week 3 rides on every test that covers Week 3 — on its
// row in To do and on Home, and on the course's Next test card.

// review: { [courseKey]: { [n]: { week, note, at } } } → the flags a test's window holds, in week order
export function flaggedIn(review, courseKey, window) {
  const f = review?.[courseKey]
  if (!f || !Array.isArray(window?.weeks)) return []
  return window.weeks.filter(n => f[n]).map(n => ({ n, ...f[n] }))
}
const cut = (s, max = 60) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)
// "Week 3 (elasticity derivations), Week 5" — one clause, for the line under a test's title
export const reviewText = flags => flags.map(f => `Week ${f.n}${f.note ? ` (${cut(f.note)})` : ''}`).join(', ')
