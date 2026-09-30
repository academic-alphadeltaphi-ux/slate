// The grade model. Pure functions over a course's `grading` block (scripts/lib/terms.mjs) and a
// map of scores, so the Home screen, the morning email and any script agree to the decimal.
//
// scores: { [componentKey]: { [itemKey]: 0..100 | null } }        for itemised components,
//         { [componentKey]: { avg: 0..100 | null, all?: [..] } }  for `many` components (quizzes, WebAssign): `all` is
//         every mark written so far, so a drop rule can apply; `avg` alone is used as is (WebAssign's banked average,
//         or a number typed into the simulator).
// A null is "not written yet". Everything is in percent of the item, never in raw points.

export const LETTERS = [['A+', 90], ['A', 85], ['A-', 80], ['B+', 77], ['B', 73], ['B-', 70], ['C+', 67], ['C', 63], ['C-', 60], ['D+', 57], ['D', 53], ['D-', 50], ['F', 0]]
export const letterFor = pct => (pct == null ? null : LETTERS.find(([, min]) => pct >= min)?.[0] ?? 'F')

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

// The score of one component under one scheme: the mean of the items that count, after best-of
// and drop rules. `known` and `total` say how much of it has actually been written.
export function componentScore(comp, scheme, scores) {
  const sc = scores?.[comp.key] || {}
  if (comp.many) {
    // `dropLowestFraction` (ECO206's checkpoints: "lowest 20% dropped") was declared in terms.mjs and printed by the
    // simulator, and never applied — the standing understated the course by the dropped quizzes (review of 2026-09-18).
    // floor(n · fraction) of the marks written so far are dropped: never more than the rule drops of the full set.
    // The 1e-3 is for a fraction written to four places: "1 of 11 dropped" as 0.0909 gives 11 × 0.0909 = 0.9999, which
    // floored to 0 and dropped nothing, ever (a brother's courses.json, 2026-09-30).
    const all = Array.isArray(sc.all) ? sc.all.filter(x => typeof x === 'number') : null
    if (all && all.length) {
      const drop = comp.dropLowestFraction ? Math.floor(all.length * comp.dropLowestFraction + 1e-3) : 0
      const kept = [...all].sort((a, b) => b - a).slice(0, all.length - drop)
      return { value: mean(kept), known: 1, total: 1 }
    }
    const v = sc.avg ?? null
    return { value: v, known: v == null ? 0 : 1, total: 1 }
  }
  const vals = (comp.items || []).map(it => sc[it.key] ?? null)
  const known = vals.filter(v => v != null)
  const best = scheme?.best?.[comp.key]
  const counted = best ? [...known].sort((a, b) => b - a).slice(0, best) : known
  // How many items this component is graded out of: best-of N, or all of them.
  const total = best || vals.length
  return { value: mean(counted), known: known.length, total }
}

// Course grade under one scheme, treating unknown components as `fill` (null = leave out and
// renormalise, which is Canvas's "current score"; a number = "if the rest comes in at X").
export function schemeGrade(grading, scheme, scores, fill = null) {
  let sum = 0, weight = 0, bonus = 0, written = 0   // written: weight actually graded so far, item by item
  for (const comp of grading.components) {
    const w = scheme.weights[comp.key]
    // A bonus counts what has been earned of it, and is never assumed: filled at `fill`, a placement bonus nobody had yet
    // put "you finish at 101.6%" under a 95% slider and made every target look nearer than it is (2026-09-30).
    if (comp.bonus) { const v = componentScore(comp, scheme, scores).value; if (v != null) bonus += comp.bonus * v; continue }
    if (w == null) continue
    const s = componentScore(comp, scheme, scores)
    written += (w * Math.min(s.known, s.total)) / s.total
    let v = s.value
    if (fill != null) {
      // items still to be written count at `fill`; for best-of, the filled ones compete too
      if (comp.many) v = v ?? fill
      else {
        const vals = (comp.items || []).map(it => scores?.[comp.key]?.[it.key] ?? fill)
        const best = scheme.best?.[comp.key]
        v = mean(best ? [...vals].sort((a, b) => b - a).slice(0, best) : vals)
      }
    }
    if (v == null) continue
    sum += w * v; weight += w
  }
  const weightKnown = Math.round(written * 10) / 10
  if (!weight) return { grade: null, weightKnown, bonus }
  return { grade: sum / weight + bonus, weightKnown, bonus }
}

// Where he stands: every scheme evaluated, the best one chosen (that is what the registrar does).
export function standing(grading, scores, fill = null) {
  const out = grading.schemes.map(sch => ({ name: sch.name, ...schemeGrade(grading, sch, scores, fill) }))
  const best = out.reduce((a, b) => (b.grade ?? -1) > (a.grade ?? -1) ? b : a, out[0])
  return { schemes: out, best, letter: letterFor(best?.grade) }
}

// The uniform score needed on everything not yet written to finish at `target`, under the best
// scheme. Bisection on the fill value, because best-of rules make the map non-linear.
export const OUT_OF_REACH = 'out-of-reach'
// A JSON-safe reading of neededFor: null = nothing marked yet, 'out-of-reach' = impossible, else the number.
export const neededForJson = (g, sc, t) => { const n = neededFor(g, sc, t); return n === Infinity ? OUT_OF_REACH : n }
export function neededFor(grading, scores, target) {
  const done = standing(grading, scores, 100).best?.grade   // a course with no schemes has no best; this used to throw
  if (done == null) return null
  // Infinity survives in memory but JSON.stringify turns it into null — the same value 'nothing written yet'
  // uses — so the hub could not tell "out of reach" from "no marks". Callers writing JSON use OUT_OF_REACH.
  if (done < target) return Infinity                       // not reachable even with 100 on the rest
  if (standing(grading, scores, 0).best.grade >= target) return 0
  let lo = 0, hi = 100
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (standing(grading, scores, mid).best.grade >= target) hi = mid; else lo = mid }
  return hi
}

// The grades every screen offers, and the hub's standing of a course: the one shape the morning's sync writes and the
// server recomputes on read, so the Home figure, Ask and the email say the same thing. `target` is the student's own
// (Hub/_marks.json): what he needs on the rest for it rides beside the three letters.
export const TARGETS = [['A-', 80], ['A', 85], ['A+', 90]]
export function courseStanding(grading, scores, target = null) {
  const st = standing(grading, scores)
  if (st.best?.grade == null) return null
  return { grade: st.best.grade, letter: st.letter, scheme: st.best.name, weightKnown: st.best.weightKnown,
    need: Object.fromEntries(TARGETS.map(([l, t]) => [l, neededFor(grading, scores, t)])),
    ...(target != null ? { target: { pct: target, need: neededFor(grading, scores, target) } } : {}) }
}

// Marks he entered himself (Hub/_marks.json, SPEC §21.12): what never reaches Quercus — a publisher's homework, a
// participation mark kept on paper, a bonus. `mine` has the shape of `scores`. Quercus wins wherever it has a mark: an
// item it marked, a `many` component it holds any mark for. The typed one then counts for nothing and is listed in
// `overridden`, so the screen can say so; it stays on file until he forgets it.
// → { scores (Quercus's with his filled in), from: { [comp]: { [item | 'avg']: 'mine' } }, overridden: [..] }
export const markOf = v => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null)
export function manyOf(m) {
  const all = Array.isArray(m?.all) ? m.all.map(markOf).filter(x => x != null) : []
  if (all.length) return { avg: mean(all), all }
  const avg = markOf(m?.avg)
  return avg == null ? null : { avg }
}
export function withMine(grading, quercus, mine) {
  const scores = JSON.parse(JSON.stringify(quercus || {})), from = {}, overridden = []
  for (const comp of grading?.components || []) {
    const m = mine?.[comp.key], q = quercus?.[comp.key] || {}
    if (!m || typeof m !== 'object') continue
    if (comp.many) {
      const typed = manyOf(m)
      if (!typed) continue
      const qv = q.avg ?? (Array.isArray(q.all) && q.all.length ? mean(q.all) : null)
      if (qv != null) { overridden.push({ comp: comp.key, item: 'avg', label: comp.label, mine: typed.avg, quercus: qv }); continue }
      scores[comp.key] = typed; from[comp.key] = { avg: 'mine' }
      continue
    }
    for (const it of comp.items || []) {
      const v = markOf(m[it.key]); if (v == null) continue
      if (q[it.key] != null) { if (Math.abs(q[it.key] - v) > 0.05) overridden.push({ comp: comp.key, item: it.key, label: it.label, mine: v, quercus: q[it.key] }); continue }
      scores[comp.key] ||= {}; scores[comp.key][it.key] = v
      from[comp.key] ||= {}; from[comp.key][it.key] = 'mine'
    }
  }
  return { scores, from, overridden }
}

// How much of the course has been written, in weight, under the best scheme.
export function progress(grading, scores) {
  const st = standing(grading, scores)
  const sch = grading.schemes.find(s => s.name === st.best?.name) || grading.schemes[0]
  const totalWeight = Object.values(sch.weights).reduce((a, b) => a + b, 0)
  return { written: st.best?.weightKnown || 0, total: totalWeight }
}

// Map Quercus assignments onto the model by each component's `match` regex; an item match uses
// the captured number ("Test 2" → t2), a `many` component averages everything that matches.
export function scoresFromAssignments(grading, assignments) {
  const scores = {}
  for (const comp of grading.components) {
    const hits = assignments.filter(a => a.score != null && a.points && comp.match?.test(a.name))
    if (!hits.length) continue
    if (comp.many) { const all = hits.map(a => (100 * a.score) / a.points); scores[comp.key] = { avg: mean(all), all }; continue }
    scores[comp.key] = {}
    for (const a of hits) {
      // The number may be captured by the regex, or sit anywhere in the name when the alternative that matched has no group
      // (`/midterm|\btest\s*([1-3])\b/` matched "Midterm 1" and dropped it — review 2026-09-18).
      const n = comp.match.exec(a.name)?.[1] ?? /\b(\d{1,2})\b/.exec(a.name)?.[1]
      const item = (n && comp.items.find(it => it.key.endsWith(n))) || (comp.items.length === 1 ? comp.items[0] : null)
      if (item) scores[comp.key][item.key] = (100 * a.score) / a.points
    }
  }
  return scores
}
