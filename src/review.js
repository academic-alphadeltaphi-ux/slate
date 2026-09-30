// Topics he flagged for review (SPEC §21.13), and the tests they reach. A week's flags are { week, topics: [{ id, topic,
// note, at }] } under a course and a week number (Hub/_review.json, scripts/lib/review.mjs); a test reaches the weeks of
// its coverage window (src/calendar.js coverageWindow → `window.weeks`), so a topic flagged in Week 3 rides on every test
// that covers Week 3 — on its row in To do and on Home, on the course's Next test card, in the morning's review task.

const cutTo = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)
// "IS-LM (the derivations), Phillips curve" — a week's topics in one clause; a topic of null is the week as a whole
export const topicsLine = (topics, cut = 60) => (topics || []).map(t => (t.topic ? (t.note ? `${t.topic} (${cutTo(t.note, cut)})` : t.topic) : t.note ? cutTo(t.note, cut) : 'the whole week')).join(', ')

// review: { [courseKey]: { [n]: { week, topics } } } → the flagged weeks a test's window holds, in week order
export function flaggedIn(review, courseKey, window) {
  const f = review?.[courseKey]
  if (!f || !Array.isArray(window?.weeks)) return []
  return window.weeks.filter(n => f[n]?.topics?.length).map(n => ({ n, ...f[n] }))
}
// "Week 3: IS-LM (the derivations), Phillips curve; Week 5: supply shocks" — for the line under a test's title
export const reviewText = flags => flags.map(f => `Week ${f.n}: ${topicsLine(f.topics)}`).join('; ')
