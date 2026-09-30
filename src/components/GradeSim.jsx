import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { standing, neededFor, progress, componentScore, TARGETS } from '../grade.js'

// Where your mark stands, for one course (SPEC §20.15). Rewritten because the old one answered in three cramped
// statistic boxes that collided as soon as the card was narrow, and buried the only question worth asking.
// It now reads as three sentences: where you stand, where you land if the rest goes a certain way, and what you
// need for the grade you want. Every graded thing is a row; what Quercus returned is filled in and marked, the
// rest is yours to try. The course's own rules apply (best-of, drop-lowest, ECO206's two competing schemes)
// because src/grade.js is the same model the morning pass uses — the number here is the number in the email.
//
// Marks of his own (SPEC §21.12). A typed mark is a try until he keeps it: Keep writes every mark Quercus has not given
// into Hub/_marks.json, and from then on it counts everywhere — Home, the email, the next visit — as "yours". Quercus wins
// wherever it has a mark; a kept mark it has since overtaken is named until he forgets it. A `many` component (quizzes,
// a publisher's homework) takes an average or its marks one by one, so a drop rule applies to what he typed too. His own
// target sits beside A−, A and A+, and is kept as he types it.
const clamp = v => (v === '' || v == null ? null : Math.max(0, Math.min(100, Number(v))))
const fmt = v => (v == null ? '—' : v.toFixed(1))
const day = iso => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '')
const clone = x => JSON.parse(JSON.stringify(x || {}))
const LETTER = { 'A-': 'A−' }
const needText = need => (need == null ? '—' : need === 0 ? 'locked in' : need === Infinity ? 'gone' : `${need.toFixed(0)}%`)
const needClass = need => (need === 0 ? ' locked' : need === Infinity ? ' gone' : '')
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.05)
const has = x => (x?.avg != null) || (Array.isArray(x?.all) && x.all.some(v => typeof v === 'number'))
// "lowest 20% dropped" as the outline says it; a fraction that is one of n (0.0909) reads "lowest 1 of 11 dropped"
const dropNote = f => { const pct = f * 100, n = Math.round(1 / f); return Math.abs(pct - Math.round(pct)) < 1e-6 ? `lowest ${Math.round(pct)}% dropped` : Math.abs(n * f - 1) < 0.01 ? `lowest 1 of ${n} dropped` : `lowest ${pct.toFixed(1)}% dropped` }

// The marks to keep: every cell Quercus has not marked, as it stands on the screen. A list keeps its numbers in order.
function keepable(g, scores, quercus) {
  const out = {}
  for (const comp of g.components) {
    const s = scores[comp.key], q = quercus[comp.key] || {}
    if (!s) continue
    if (comp.many) {
      if (has(q)) continue
      const all = Array.isArray(s.all) ? s.all.filter(v => typeof v === 'number') : null
      if (all?.length) out[comp.key] = { all }
      else if (!Array.isArray(s.all) && s.avg != null) out[comp.key] = { avg: s.avg }
      continue
    }
    const items = {}
    for (const it of comp.items || []) if (q[it.key] == null && s[it.key] != null) items[it.key] = s[it.key]
    if (Object.keys(items).length) out[comp.key] = items
  }
  return out
}
const count = marks => Object.values(marks || {}).reduce((n, m) => n + (Array.isArray(m?.all) ? m.all.length : m?.avg != null ? 1 : Object.keys(m || {}).length), 0)

export default function GradeSim({ course, onSaved }) {
  const [live, setLive] = useState(course)
  useEffect(() => setLive(course), [course])   // a reload (the morning's check, a mark kept) is the new baseline
  const g = live.grading
  const base = live.scores || {}                         // Quercus's marks with his kept ones filled in
  const quercus = live.quercusScores || base             // Quercus's alone (a hub from before §21.12 has only `scores`)
  const mineFrom = live.fromMe || {}
  const [scores, setScores] = useState(() => clone(base))
  const baseSig = JSON.stringify(base), lastBase = useRef(baseSig)
  useEffect(() => { if (lastBase.current !== baseSig) { lastBase.current = baseSig; setScores(clone(base)) } }, [baseSig])
  const [fill, setFill] = useState(() => { const st = standing(g, base); return st.best.grade != null ? Math.round(st.best.grade) : 75 })
  const [target, setTarget] = useState(live.target != null ? String(live.target) : '')
  const [busy, setBusy] = useState(false), [err, setErr] = useState(null), [forgetting, setForgetting] = useState(false)
  // `many` components shown one mark at a time: when he asked, or when the list is his own. Quercus's lists open on their
  // average, as they always have.
  const [oneByOne, setOneByOne] = useState(() => new Set(g.components.filter(c => c.many && Array.isArray(base[c.key]?.all) && mineFrom[c.key]).map(c => c.key)))

  // Typing an average over a `many` component replaces the individual marks (`all`), or the drop rule would keep
  // reading the marks Quercus returned and ignore the number just typed.
  const set = (ck, ik, v) => setScores(s => { const cur = { ...(s[ck] || {}), [ik]: clamp(v) }; if (ik === 'avg') delete cur.all; return { ...s, [ck]: cur } })
  // One mark of a list; an emptied one stays an empty cell until Keep, so deleting a digit does not take the field away.
  const setNth = (ck, i, v) => setScores(s => {
    const all = [...(Array.isArray(s[ck]?.all) ? s[ck].all : [])]; all[i] = clamp(v)
    while (all.length && all[all.length - 1] == null) all.pop()
    const nums = all.filter(x => typeof x === 'number')
    return { ...s, [ck]: { all, avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null } }
  })
  // Switching the view changes no mark: an average he typed still counts in the list until he enters a mark there.
  const view = (ck, list) => setOneByOne(o => { const n = new Set(o); if (list) n.add(ck); else n.delete(ck); return n })

  // Whose a cell is: Quercus's, his kept one, a try (differs from what is on file), or nobody's yet. `ik` is an item key,
  // 'avg', or a position in a `many` list — a `many` component is Quercus's or his as a whole.
  const kind = (ck, ik) => {
    const pick = s => (typeof ik === 'number' ? s[ck]?.all?.[ik] : s[ck]?.[ik]) ?? null
    const v = pick(scores)
    if (!same(pick(base), v)) return 'trying'
    if (v == null) return ''
    if (ik === 'avg' || typeof ik === 'number') return has(quercus[ck]) ? 'known' : mineFrom[ck]?.avg ? 'mine' : ''
    return quercus[ck]?.[ik] != null ? 'known' : mineFrom[ck]?.[ik] ? 'mine' : ''
  }
  const touched = JSON.stringify(scores) !== JSON.stringify(base)
  const nowKeep = useMemo(() => keepable(g, scores, quercus), [g, scores, quercus])
  const kept = live.myMarks || {}
  const toKeep = touched && JSON.stringify(nowKeep) !== JSON.stringify(keepable(g, base, quercus))

  const save = async patch => {
    setBusy(true); setErr(null)
    try { const r = await api.saveMarks(live.key, patch); if (r?.course) { setLive(l => ({ ...l, ...r.course })); onSaved?.(r.course) } return true }
    catch (e) { setErr(e.message); return false }
    finally { setBusy(false) }
  }
  const keep = () => save({ marks: nowKeep })
  const forget = async () => { if (await save({ marks: {} })) setForgetting(false) }
  // A kept mark Quercus has since marked counts for nothing; forgetting it takes it off the file.
  const forgetOverridden = () => {
    const next = clone(kept)
    for (const o of live.overridden || []) { if (o.item === 'avg') delete next[o.comp]; else if (next[o.comp]) { delete next[o.comp][o.item]; if (!Object.keys(next[o.comp]).length) delete next[o.comp] } }
    save({ marks: next })
  }
  // The target is kept as he types it, once it is a real percent (or cleared when the field is emptied).
  const tNum = target.trim() === '' ? null : Number(target)
  const tOk = tNum != null && Number.isFinite(tNum) && tNum > 0 && tNum <= 100
  useEffect(() => {
    const want = target.trim() === '' ? null : tOk ? Math.round(tNum * 10) / 10 : undefined
    if (want === undefined || want === (live.target ?? null)) return
    const t = setTimeout(() => save({ target: want }), 700)
    return () => clearTimeout(t)
  }, [target])

  const st = useMemo(() => standing(g, scores), [g, scores])
  const proj = useMemo(() => standing(g, scores, fill), [g, scores, fill])
  const prog = useMemo(() => progress(g, scores), [g, scores])
  const targets = useMemo(() => TARGETS.map(([l, t]) => [LETTER[l] || l, t, neededFor(g, scores, t)]), [g, scores])
  const own = useMemo(() => (tOk ? neededFor(g, scores, tNum) : null), [g, scores, tOk, tNum])
  const scheme0 = g.schemes[0]

  return (
    <section className="sim">
      <div className="sim-top">
        <div className="sim-stat">
          <div className="sim-k">Where you stand</div>
          {st.best?.grade == null
            ? <div className="sim-none">Nothing marked yet</div>
            : <div className="sim-big">{fmt(st.best.grade)}<small>%</small>{st.letter && <span className="sim-letter">{st.letter}</span>}</div>}
          <div className="sim-s">{prog.written}% of the course written{g.schemes.length > 1 && st.best?.name ? ` · ${st.best.name} is ahead` : ''}</div>
        </div>
        <div className="sim-stat">
          <div className="sim-k">If the rest averages</div>
          <div className="sim-slider">
            <input type="range" min="40" max="100" value={fill} onChange={e => setFill(Number(e.target.value))} />
            <b>{fill}%</b>
          </div>
          <div className="sim-s">you finish at <b className="sim-land">{fmt(proj.best?.grade)}%</b>{proj.letter && <span className="sim-letter">{proj.letter}</span>}</div>
        </div>
        <div className="sim-stat sim-needs">
          <div className="sim-k">To finish with</div>
          <div className="sim-need-row">
            {targets.map(([l, t, need]) => (
              <div key={l} className={'sim-need' + needClass(need)} title={`${t}% overall`}>
                <b>{l}</b><span>{needText(need)}</span>
              </div>))}
            <label className={'sim-need sim-own' + (tOk ? needClass(own) : '')} title="Any grade you want: what you need on the rest for it. Kept for this course.">
              <b><input type="number" min="1" max="100" step="0.5" placeholder="Yours" value={target} onChange={e => setTarget(e.target.value)} aria-label="Your own target, in percent" />{target !== '' && '%'}</b>
              <span>{tOk ? needText(own) : target === '' ? 'any %' : '1–100'}</span>
            </label>
          </div>
          <div className="sim-s">on everything still to come</div>
        </div>
      </div>

      {(live.overridden || []).length > 0 && (
        <div className="sim-over">
          {live.overridden.map(o => <p key={o.comp + o.item}><b>{o.label}</b>: Quercus now says {fmt(o.quercus)}, so your {fmt(o.mine)} no longer counts.</p>)}
          <button className="link" onClick={forgetOverridden} disabled={busy}>Forget {live.overridden.length === 1 ? 'mine' : 'those of mine'}</button>
        </div>)}

      <div className="sim-marks">
        {g.components.map(comp => {
          const w = g.schemes.map(s => s.weights[comp.key]).filter(x => x != null)
          const weight = comp.bonus ? `+${Math.round(comp.bonus * 100)}% bonus` : [...new Set(w)].map(x => x + '%').join(' / ')
          const rule = [...new Set(g.schemes.map(s => s.best?.[comp.key]).filter(Boolean))]
          const note = [rule.length ? `best ${rule.join('/')}` : '', comp.best ? `top ${comp.best} of ${comp.count}` : '', comp.dropLowestFraction ? dropNote(comp.dropLowestFraction) : ''].filter(Boolean).join(' · ')
          const list = comp.many && oneByOne.has(comp.key)
          const marks = list ? (scores[comp.key]?.all || []) : null
          const counted = list ? componentScore(comp, scheme0, scores).value : null
          // how many of the marks on screen the drop rule leaves out, the same floor src/grade.js takes
          const dropped = list && comp.dropLowestFraction ? Math.floor(marks.filter(v => typeof v === 'number').length * comp.dropLowestFraction + 1e-3) : 0
          const cell = (key, label, date, value, onChange, k) => (
            <label key={key} className={'sim-cell' + (k ? ' ' + k : '')} title={k === 'known' ? 'From Quercus' : k === 'mine' ? 'Entered by you' : k === 'trying' ? 'Only a try until you keep it' : undefined}>
              <span className="sim-cell-n">{label}</span>
              {k === 'mine' && <span className="sim-cell-by">yours</span>}
              <span className="sim-cell-d">{date ? day(date) : ''}</span>
              <input type="number" min="0" max="100" placeholder="—" value={value ?? ''} onChange={e => onChange(e.target.value)} />
            </label>)
          return (
            <div key={comp.key} className="sim-comp">
              <div className="sim-comp-head"><b>{comp.label}</b><span className="pill">{weight}</span>{note && <i>{note}</i>}</div>
              <div className="sim-cells">
                {!comp.many && comp.items.map(it => cell(it.key, it.label, it.date, scores[comp.key]?.[it.key], v => set(comp.key, it.key, v), kind(comp.key, it.key)))}
                {comp.many && !list && cell('avg', 'Average so far', null, scores[comp.key]?.avg, v => set(comp.key, 'avg', v), kind(comp.key, 'avg'))}
                {list && [...marks, null].map((v, i) => cell('n' + i, i < marks.length ? `Mark ${i + 1}` : 'Add a mark', null, v, x => setNth(comp.key, i, x), i < marks.length ? kind(comp.key, i) : ''))}
              </div>
              {/* one by one only where there can be a list: his own component, or Quercus's when it returned each mark */}
              {comp.many && (!has(quercus[comp.key]) || Array.isArray(quercus[comp.key]?.all)) && (
                <div className="sim-comp-foot">
                  {list && counted != null && <span>counts as <b>{fmt(counted)}</b>{dropped ? `, lowest ${dropped === 1 ? '' : dropped + ' '}dropped` : ''}</span>}
                  <button className="link" onClick={() => view(comp.key, !list)}>{list ? 'Type an average instead' : 'Enter them one by one'}</button>
                </div>)}
            </div>)
        })}
      </div>

      <div className="sim-foot">
        {toKeep && <button className="btn small primary" onClick={keep} disabled={busy}>Keep as my marks</button>}
        {touched && <button className="link" onClick={() => setScores(clone(base))} disabled={busy}>Clear what I tried</button>}
        {!touched && count(kept) > 0 && !forgetting && <button className="link" onClick={() => setForgetting(true)} disabled={busy}>Back to Quercus only</button>}
        {forgetting && <span className="sim-ask">Forget the {count(kept) === 1 ? 'mark' : `${count(kept)} marks`} you entered? <button className="link danger" onClick={forget} disabled={busy}>Forget {count(kept) === 1 ? 'it' : 'them'}</button> <button className="link" onClick={() => setForgetting(false)}>Keep {count(kept) === 1 ? 'it' : 'them'}</button></span>}
        {(touched || count(kept) > 0) && <span className="sim-key"><i className="k-known" />Quercus <i className="k-mine" />yours <i className="k-trying" />a try</span>}
        {err && <span className="sim-err">{err}</span>}
      </div>
    </section>
  )
}
