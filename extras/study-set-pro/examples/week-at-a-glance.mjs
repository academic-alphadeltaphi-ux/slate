// ECO206 Week 1 at a glance — Constrained Optimization, three US Letter sheets. This is the approved Week 1 example,
// ported line for line: every number, label, card, footer and figure is the one on the approved sheets, except that
// no professor is named.
// Sources: W1 slides (after class, 35 pp.), Problem Set 1 + solutions, Tutorial 1, Application 1, Perloff Ch. 1 +
// Calculus Appendix (the Week 1 Textbook shelf), the checked Week 1 guide, the 9 Sep lecture recording (what was
// stressed).
//
// How a spec works. A spec is a module whose default export is build(G). It imports nothing: G is the glance toolkit
// (scripts/lib/study-set/glance.mjs as a namespace, figure.mjs included) plus check(cond, msg), which throws when
// cond is false. build(G) does three things, in this order:
//   1. computes every number the sheets print and check()s each against the value written on the sheet, so a typo
//      in a card stops the build instead of reaching the printout;
//   2. draws each figure with G.Fig (one function per figure; data coordinates, Unicode maths in $...$ labels);
//   3. lays each sheet out as G.card(...)s on G.page(...) (one function per sheet; MathJax \( \) and \[ \] in HTML).
// It returns { title, pages }; the caller writes G.doc(title, pages), one sheet per page.
export default function build(G) {
  const { C, Fig, card, where, page, bisect, toolGrid, g, check } = G

  const sq = Math.sqrt

  // ---------------------------------------------------------------- numbers (every one printed below is checked here)
  const L_lin = ep => 6 * ep + 4 * (13 - ep)
  const L_dim = (ep, er) => 12 * sq(ep) + 8 * sq(er)
  const hump = ep => 12 * sq(ep) + 8 * sq(13 - ep)
  const V = T => 52 * sq(T / 13)
  const N = {}
  N.lin_corner = L_lin(13)                                  // 78
  N.lin_other = L_lin(0)                                    // 52
  const ep = bisect(x => 6 / sq(x) - 4 / sq(13 - x), 0.01, 12.99)
  N.ep = ep; N.er = 13 - ep                                 // 9, 4
  N.L = L_dim(9, 4)                                         // 52
  N.lam = 6 / sq(9)                                         // 2
  N.c_all_p = hump(13); N.c_all_r = hump(0)                 // 43.27, 28.84
  N.lam26 = 6 / sq(18)                                      // 1.414
  N.lam_eq = 6 / sq(6.5)                                    // 2.353
  N.lam3 = sq((36 + 16 + 25) / 77)                          // 1
  const ep7 = bisect(x => (6 / sq(x)) / (4 / sq(34 - 2 * x)) - 2, 0.01, 16.99)
  N.ep7 = ep7; N.er7 = 34 - 2 * ep7                         // 9, 16
  N.lam7 = 4 / sq(16); N.L7 = L_dim(9, 16)                  // 1, 68
  N.L8 = L_dim(5, 24)                                       // 66.02
  N.m8p = (6 / sq(5)) / 2; N.m8r = 4 / sq(24)               // 1.342, 0.816
  N.mu8 = 6 / sq(5) - 2 * 4 / sq(24)                        // 1.050
  N.share3 = (34 * 9 / 13) / 34; N.share7 = 18 / 34         // 0.692, 0.529
  N.mu10 = sq(9) / 6                                        // 0.5
  N.L_flip = L_dim(4, 9); N.L_eq = L_dim(6.5, 6.5)          // 48, 50.99
  N.V26 = V(26)                                             // 73.54
  N.dV13 = 26 / sq(13 * 13); N.dV26 = 26 / sq(13 * 26)      // 2, 1.414
  N.cd_f = sq(4) * sq(9); N.cd_fx = .5 * 6 / 4; N.cd_fy = .5 * 6 / 9   // PS1 Q1(b)
  N.t1 = [16, 9, 10 / sq(16), 20 * 4 + 15 * 3]              // Tutorial 1 Q1: (16, 9), λ 2.5, 125 t
  N.t2 = [16, 36, 7.5 / sq(36), 20 * 4 + 15 * 6]            // Q2(b): λ 1.25, 170 t
  N.t3 = 20 * sq(10) + 15 * sq(48)                          // Q2(c): 167.17 t
  N.t3m = [(10 / sq(10)) / 2, 7.5 / sq(48)]                 // Q2(d): 1.58, 1.08 per reservoir unit

  const expect = {
    lin_corner: 78, lin_other: 52, ep: 9, er: 4, L: 52, lam: 2, c_all_p: 43.3, c_all_r: 28.8, lam26: 1.41, lam_eq: 2.35,
    lam3: 1, ep7: 9, er7: 16, lam7: 1, L7: 68, L8: 66.0, m8p: 1.34, m8r: 0.82, mu8: 1.05, share3: .69, share7: .53, mu10: .5,
    L_flip: 48, L_eq: 51.0, V26: 73.5, dV13: 2, dV26: 1.41, cd_f: 6, cd_fx: .75, cd_fy: 1 / 3, t3: 167.2,
  }
  for (const [k, v] of Object.entries(expect)) {
    const got = N[k]
    const tol = Math.abs(v) < 2 ? 0.006 : 0.051
    check(Math.abs(got - v) <= tol, `${k} = ${got}, the sheet prints ${v}`)
  }
  check(N.t1[2] === 2.5 && N.t1[3] === 125 && N.t2[2] === 1.25 && N.t2[3] === 170, 'Tutorial 1: λ 2.5 / 125 t and λ 1.25 / 170 t')
  check(Math.abs(N.t3m[0] - 1.58) < .005 && Math.abs(N.t3m[1] - 1.08) < .005, 'Tutorial 1 Q2(d): 1.58 vs 1.08 per reservoir unit')
  check([0, 3, 6.5, 12.9].every(x => L_lin(x) < 78), "the linear model's best is the corner")
  check(Math.abs((6 / sq(9)) / (4 / sq(4)) - 1) < 1e-12, 'tangency at (9, 4): slope −MB_p/MB_r = −1')
  check(Math.abs(12 * sq(9) + 8 * sq(4) - 52) < 1e-12 && Math.abs(((68 - 12 * 3) / 8) ** 2 - 16) < 1e-12, 'L = 52 at (9, 4); the 68 level curve passes (9, 16)')

  // gilt is G_ here: G is the toolkit
  const B = C.blue, V_ = C.violet, G_ = C.gilt, R = C.red, I = C.ink, M2 = C.muted2, GR = C.grey

  // ---------------------------------------------------------------- figures

  function figPlaneLinear(width = 246) {
    const f = new Fig('a', 300, 236, [0, 16], [0, 16], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$e_p$ retrieval hours', '$e_r$ rereading hours', { xt: [0, 5, 10, 13], yt: [5, 10, 13] })
    for (const [Lv, w, d, op] of [[52, 1.3, '4,3', .8], [65, 1.3, '4,3', .8], [78, 2.1, null, 1]]) {
      f.line(0, Lv / 4, Lv / 6, 0, B, { w, dash: d, op })
    }
    f.line(0, 13, 13, 0, I, { w: 2.4 })
    f.point(0, 13, GR, { hollow: true })
    f.point(13, 0, G_, { r: 4.6 })
    f.text(52 / 6, 0, '52', B, 'middle', 10, { dx: -4, dy: -5 })
    f.text(65 / 6, 0, '65', B, 'middle', 10, { dx: -4, dy: -5 })
    f.text(13.6, 1.5, '$L$ = 78', G_, 'middle', 11, { weight: 'bold' })
    // the 13-hour line is labelled in the empty corner near the origin, with a leader to the line
    f.text(0.6, 4.3, '13-hour line', I, 'start', 10.4)
    f.text(0.6, 4.3, 'slope −1', I, 'start', 10, { dy: 12 })
    f.line(3.3, 5.0, 4.6, 8.0, M2, { w: 0.9 })
    f.text(4.2, 15.0, 'level lines $6e_p$ + $4e_r$ = $L$', B, 'start', 10)
    f.arrow(9.6, 10.2, 11.2, 11.27, B, { w: 1.4 })
    f.text(11.4, 11.4, 'higher $L$', B, 'start', 10)
    return f.svg(width)
  }

  function figFlatMb(width = 236) {
    const f = new Fig('b', 330, 148, [0, 13], [0, 8], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$e_p$ ($e_r$ = 13 − $e_p$)', 'extra points from one more hour', { xt: [0, 6.5, 13], yt: [2, 4, 6] })
    f.line(0, 6, 13, 6, B, { w: 2.4 })
    f.line(0, 4, 13, 4, V_, { w: 2.4 })
    f.text(0.3, 6, '$MB_p$ = $α_p$ = 6', B, 'start', 11, { dy: -11 })
    f.text(0.3, 4, '$MB_r$ = $α_r$ = 4', V_, 'start', 11, { dy: -11 })
    f.arrow(8.0, 4.2, 8.0, 5.8, I, { w: 1.3 })
    f.arrow(8.0, 5.8, 8.0, 4.2, I, { w: 1.3 })
    f.text(8.4, 5.0, 'gap of 2 at every split:', I, 'start', 10, { dy: -2 })
    f.text(8.4, 5.0, 'never equal', I, 'start', 10, { dy: 9 })
    f.point(13, 6, G_, { r: 4.6 })
    f.text(13, 6, 'corner', G_, 'end', 10.4, { dx: -7, dy: -8, weight: 'bold' })
    return f.svg(width)
  }

  function figMbCross(width = 290) {
    const f = new Fig('c', 330, 214, [0, 13], [0, 8], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$e_p$ ($e_r$ = 13 − $e_p$)', 'extra points from one more hour', { xt: [0, 4, 9, 13], yt: [2, 4, 6, 8] })
    f.line(0, 6, 13, 6, GR, { w: 1.1, dash: '4,3', op: .8 })
    f.line(0, 4, 13, 4, GR, { w: 1.1, dash: '4,3', op: .8 })
    f.text(5.2, 6, 'linear 6', GR, 'start', 9.6, { dy: -4 })
    f.text(5.2, 4, 'linear 4', GR, 'start', 9.6, { dy: -4 })
    f.curve(x => 6 / sq(x), 0.5625, 13, B, { w: 2.4 })
    f.curve(x => 4 / sq(13 - x), 0, 12.75, V_, { w: 2.4 })
    f.drop(9, 2)
    f.point(9, 2, G_, { r: 4.6 })
    f.text(0.3, 2, 'λ = 2', G_, 'start', 11, { dy: -4, weight: 'bold' })
    f.text(1.25, 6 / sq(1.25), '$MB_p$ = 6/√$e_p$', B, 'start', 11, { dx: 8, dy: 2 })
    f.text(12.3, 6.8, '$MB_r$ = 4/√(13 − $e_p$)', V_, 'end', 11, { dx: -10 })
    f.arrow(5.2, 0.7, 8.2, 0.7, I, { w: 1.3 })
    f.arrow(12.7, 0.7, 9.8, 0.7, I, { w: 1.3 })
    f.text(6.7, 0.7, 'to retrieval', I, 'middle', 9.6, { dy: -5 })
    f.text(11.25, 0.7, 'to rereading', I, 'middle', 9.6, { dy: -5 })
    return f.svg(width)
  }

  function figHump(width = 300) {
    const f = new Fig('d', 330, 206, [0, 13], [0, 80], { l: 30, r: 16, t: 18, b: 30 })
    f.axes('$e_p$ ($e_r$ = 13 − $e_p$)', 'learning $L$ along the 13-hour line', { xt: [0, 4, 9, 13], yt: [20, 40, 52, 78] })
    f.line(0, 52, 13, 78, GR, { w: 1.7, dash: '5,3' })
    f.curve(hump, 0, 13, B, { w: 2.5 })
    f.point(13, 78, GR, { hollow: true })
    f.text(13, 78, '78', M2, 'end', 10, { dx: -6, dy: 14 })
    f.text(5.2, 52 + 2 * 5.2, 'linear: a straight rise to the corner', M2, 'start', 9.8, { dy: -6 })
    f.drop(9, 52)
    f.line(7.3, 52, 10.7, 52, G_, { w: 1.4 })
    f.point(9, 52, G_, { r: 4.6 })
    f.text(9, 52, 'flat top (9, 4): 52', G_, 'middle', 11, { dy: -10, weight: 'bold' })
    f.point(0, N.c_all_r, B, { r: 3.4 })
    f.point(13, N.c_all_p, B, { r: 3.4 })
    f.text(0, N.c_all_r, '28.8', B, 'start', 10, { dx: 6, dy: 12 })
    f.text(13, N.c_all_p, '43.3', B, 'end', 10, { dx: -6, dy: 13 })
    f.text(3.0, hump(3.0), 'diminishing returns', B, 'start', 10.4, { dx: 6, dy: 15 })
    return f.svg(width)
  }

  function level(c) {
    return x => 12 * sq(x) <= c ? ((c - 12 * sq(x)) / 8) ** 2 : null
  }

  function figTangent(width = 236) {
    const f = new Fig('e', 300, 236, [0, 16], [0, 16], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$e_p$', '$e_r$', { xt: [0, 5, 9, 13], yt: [4, 8, 13] })
    f.line(0, 13, 13, 0, I, { w: 2.4 })
    f.curve(level(40), 0.2, (40 / 12) ** 2, B, { w: 1.4, dash: '4,3', op: .85 })
    f.curve(level(60), 3, 16, B, { w: 1.4, dash: '4,3', op: .85 })
    f.curve(level(52), 1, 16, B, { w: 2.4 })
    f.drop(9, 4)
    f.point(9, 4, G_, { r: 4.6 })
    f.text(9, 4, '(9, 4)', G_, 'start', 11, { dx: 7, dy: -7, weight: 'bold' })
    f.text(11.1, 0, '40', B, 'middle', 10, { dx: -5, dy: -5 })
    f.text(15.8, level(52)(15.8), '$L$ = 52', B, 'end', 10.4, { dy: -7 })
    f.text(15.8, level(60)(15.8), '60', B, 'end', 10, { dy: -6 })
    return f.svg(width)
  }

  function figValue(width = 254) {
    const f = new Fig('f', 290, 206, [0, 40], [0, 100], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$T$ hours available', '$V$($T$) best learning', { xt: [0, 13, 26, 40], yt: [52, 73.5], ytl: ['52', '73.5'] })
    f.curve(V, 0, 40, B, { w: 2.5 })
    f.line(3, 52 - 20, 23, 52 + 20, G_, { w: 1.4, dash: '5,3' })
    f.line(15, N.V26 - 11 * sq(2), 37, N.V26 + 11 * sq(2), V_, { w: 1.4, dash: '5,3' })
    f.drop(13, 52)
    f.drop(26, N.V26)
    f.point(13, 52, G_, { r: 4.4 })
    f.point(26, N.V26, V_, { r: 4.2 })
    f.text(13, 52, 'slope λ = 2', G_, 'start', 10.6, { dx: 6, dy: 14, weight: 'bold' })
    f.text(26, N.V26, 'slope √2 ≈ 1.41', V_, 'start', 10.6, { dx: 5, dy: 15, weight: 'bold' })
    f.text(31, V(31), '$V$ = 52√($T$/13)', B, 'end', 10.4, { dx: -4, dy: -11 })
    return f.svg(width)
  }

  function figPriceCap(width = 222) {
    const f = new Fig('g', 270, 236, [0, 18], [0, 40], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$e_p$', '$e_r$', { xt: [0, 5, 9, 17], yt: [16, 24, 34] })
    f.poly([[5, 0], [18, 0], [18, 40], [5, 40]], R, .07)
    f.line(5, 0, 5, 40, R, { w: 1.5, dash: '5,3' })
    f.curve(level(68), 3.2, 18, B, { w: 1.6, dash: '4,3' })
    f.line(0, 34, 5, 24, I, { w: 2.7 })
    f.line(5, 24, 17, 0, I, { w: 1.6, dash: '2,2.5' })
    f.point(9, 16, G_, { hollow: true, r: 4.2 })
    f.point(5, 24, G_, { r: 4.6 })
    f.text(9, 16, '(9, 16): 68, cut off', M2, 'start', 10, { dx: 7, dy: -3 })
    f.text(5, 24, '66.0', G_, 'end', 11, { dx: -7, dy: 4, weight: 'bold' })
    f.text(5, 31.0, 'cap $e_p$ ≤ 5', R, 'start', 10.4, { dx: 6 })
    f.text(0.5, 36.4, '2$e_p$ + $e_r$ = 34', I, 'start', 10)
    return f.svg(width)
  }

  function figBeliefs(width = 226) {
    const f = new Fig('h', 290, 206, [0, 13], [24, 56], { l: 30, r: 14, t: 18, b: 30 })
    f.axes('$e_p$ chosen', '$L$ learned (true $α$)', { xt: [0, 4, 6.5, 9, 13], yt: [30, 40, 48, 52], ybreak: true })
    f.curve(hump, 0, 13, B, { w: 2.5 })
    for (const [x, y, col] of [[9, 52, G_], [6.5, N.L_eq, V_], [4, 48, R]]) {
      f.drop(x, y, null, { toY: false })
      f.point(x, y, col, { r: 4.4 })
    }
    f.text(9, 52, 'truth: 52', G_, 'start', 11, { dx: 8, dy: 4, weight: 'bold' })
    f.text(6.5, N.L_eq, '51.0', V_, 'end', 10.6, { dx: -6, dy: -6, weight: 'bold' })
    f.text(4, 48, '48', R, 'end', 10.6, { dx: -6, dy: -6, weight: 'bold' })
    return f.svg(width)
  }

  function sub(t) {
    return `<div class="sub">${t}</div>`
  }

  // ---------------------------------------------------------------- sheet 1

  const MAST = 'ECO206 · Week 1 · Sep 7–13 · Lecture Wed 9 Sep · Tutorial 1 Mon 14 Sep'

  function sheet1() {
    const q = card('s5', '1', 'The question', String.raw`
<div class="big q" style="margin-bottom:2px">How should a student split 13 study hours between two methods?</div>
<div class="mute" style="margin-bottom:2px">Class poll: per 100 study minutes, how many rereading vs self-quizzing?</div>
<ul class="t">
<li><b>Economics?</b> Yes: a scarce resource (time) shared between uses. <b>Microeconomics</b> = the allocation of scarce resources. <span class="tag b">book</span></li>
<li><b>Model</b>: a simplification making testable predictions. <b>Positive</b> = testable cause → effect; <b>normative</b> = a value judgment. <span class="tag b">book</span></li>
<li>ECO206's skills: <b>set up</b> · <b>solve</b> with tools · <b>answer and communicate</b> the why.</li>
</ul>
<div class="mute" style="font-size:9.2px;margin-top:2px">Affonso, Aucejo, El Khoury &amp; Larroucau (2026), NBER w35436.</div>
`, 'slides 1–4 · Perloff 1.1–1.2')

    const box = (n, t, w, m, bg = '#fff') => (`<div class="f1 eqbox" style="background:${bg}"><div class="mute" style="font-variant-caps:all-small-caps;` +
      `letter-spacing:.06em">${n} · ${t} <i>${w}</i></div>${m}</div>`)
    const setup = card('s7', '2', 'Set up: the three questions', '<div class="row" style="gap:6px;margin:1px 0 2px">' +
      box(1, 'What can I choose?', 'knobs', String.raw`\(e_p,\ e_r\)`) +
      box(2, 'My objective?', 'the dial', String.raw`\(\max\ 6e_p + 4e_r\)`, 'var(--c-t)') +
      box(3, 'My constraint?', 'the fence', String.raw`\(e_p + e_r = 13,\ \ e_p, e_r \ge 0\)`) + '</div>' + where([
        [String.raw`\(e_p\)`, 'hours of retrieval practice (self-quizzing, explaining): a <b>choice variable</b>'],
        [String.raw`\(e_r\)`, 'hours of rereading (slides, notes, highlighting): a choice variable'],
        [String.raw`\(\alpha_p=6,\ \alpha_r=4\)`, "learning points per hour (the paper's 1–10 scale): <b>parameters</b>, given"],
        ['13', 'hours available. <b>Binding</b>: all used at the optimum. <b>Non-negativity</b>: no negative hours'],
      ]), 'slides 7–8')

    const toolkit = card('s12', '3', 'The toolkit', toolGrid([
      ['Partial derivative', String.raw`\(\partial f/\partial x\): turn one knob a little, hold the other still: how far does the dial move? (\(\partial\) = something held fixed: <i>all else equal</i>.) This week's functions are <b>additively separable</b>: each MB depends only on its own hours.`],
      ['Power and chain rules', String.raw`\(\dfrac{d}{dx}ax^b = abx^{b-1}\ \Rightarrow\ \dfrac{d}{dx}12\sqrt{x}=\dfrac{6}{\sqrt{x}}\)<br>\(\dfrac{d}{dx}g(h(x)) = g'(h(x))\,h'(x)\ \Rightarrow\ \dfrac{d}{dx}8\sqrt{13-x} = -\dfrac{4}{\sqrt{13-x}}\)`],
      ['Cobb-Douglas marginals', String.raw`\(f=Ax^ay^b:\ \ \dfrac{\partial f}{\partial x}=\dfrac{af}{x},\ \ \dfrac{\partial f}{\partial y}=\dfrac{bf}{y}\)<br>\(\sqrt{x}\sqrt{y}\) at (4, 9): \(f=6\), \(f_x=0.75\), \(f_y=\tfrac13\).`],
      ['Slope of a level curve', String.raw`Along \(f(x,y)=c\): \(\ \dfrac{dy}{dx}=-\dfrac{\partial f/\partial x}{\partial f/\partial y}\)<br>\(x^{0.5}y^{0.5}=10\ \Rightarrow\ dy/dx=-y/x\). Next week: indifference curve, slope = MRS.`],
      ['Finding a maximum', String.raw`FOC \(f'=0\) at an interior max; SOC \(f''<0\). <b>Concave</b>: never below its chords; strictly concave: at most one max. No FOC solution inside ⇒ the max is at an edge (<b>corner</b>).`],
      ['Logs and homogeneity <span class="tag b">book</span>', String.raw`\(\ln xz=\ln x+\ln z,\ \ \ln x^b=b\ln x,\ \ \frac{d}{dx}\ln x=\frac1x\)<br>\(f(tx)=t^\gamma f(x)\): degree \(\gamma\). \(Ax^\alpha y^\beta\): degree \(\alpha+\beta\), concave if \(\alpha+\beta\le1\).`],
    ], '0.9fr 1.3fr 0.95fr'), 'slide 6 · PS1 Q1–2 · Perloff A.2–A.5')

    const linear = card('s12', '4', 'The linear model: two routes, one corner', String.raw`
<div class="row" style="gap:12px">
<div class="f1">` + sub('Route 1 · substitution') + String.raw`
Put \(e_r = 13 - e_p\) into the objective:
\[6e_p + 4(13 - e_p) = 52 + 2e_p\]
Rising in \(e_p\): push it as high as it goes.<br><b>All 13 hours to retrieval: \(L = 78\).</b>
<div style="margin-top:8px">` + sub('Route 2 · the Lagrangian') + String.raw`</div>
\[\mathcal{L} = 6e_p + 4e_r + \lambda\,[\,13 - e_p - e_r\,]\]
<div class="where" style="margin-top:0"><b>\(\mathcal{L}\)</b><span>Lagrangian = objective + λ[available − used] (not the learning \(L\))</span><b>\(\lambda\)</b><span>the Lagrange multiplier on the constraint</span></div>
</div>
<div class="f1">` + sub('Route 2 · first-order conditions') + String.raw`
\[\frac{\partial\mathcal{L}}{\partial e_p} = 6-\lambda = 0\qquad \frac{\partial\mathcal{L}}{\partial e_r} = 4-\lambda = 0\]
\[\frac{\partial\mathcal{L}}{\partial \lambda} = 13 - e_p - e_r = 0\ \ \text{(the constraint back)}\]
<div class="eqbox" style="background:var(--red-t);border-color:rgba(140,47,42,.3)">\(\lambda = 6\) and \(\lambda = 4\): a contradiction.<br><b>The method fails.</b></div>
</div>
<div style="width:250px">` + figPlaneLinear() + String.raw`<div class="cap">Level lines (slope −1.5) are steeper than the 13-hour line (−1) everywhere: the best one touches only the end (13, 0). The other end, (0, 13), gives 52.</div></div>
</div>`, 'slides 9–13')

    const why = card('s6', '5', 'Interior or corner?', figFlatMb(300) + String.raw`
<ul class="t" style="margin-top:1px">
<li><b>Interior</b>: every choice &gt; 0. <b>Corner</b>: some choice = 0.</li>
<li>Lagrange looks for an interior split where moving an hour gains nothing; here every hour moved to retrieval gains 2.</li>
<li>Formal fix: <b>Kuhn–Tucker</b>. ECO206: solve, then <b>check the corners by hand</b>.</li>
</ul>`, 'slides 12–13 · PS1 Q11 · A.7')

    const bar = (lab_, pct, col, note) => (`<div class="row" style="align-items:center;gap:6px;margin:2px 0"><span style="width:84px">${lab_}</span>` +
      `<span style="flex:1;height:10px;background:#efeee9;position:relative"><span style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${col}"></span></span>` +
      `<span class="num" style="width:44px;text-align:right">${note}</span></div>`)
    const data = card('s6', '6', 'Does it match the data?', '<div class="mute" style="font-variant-caps:all-small-caps;letter-spacing:.06em">share of study time spent rereading</div>' +
      bar('model', 0.5, R, '0%') + bar('median student', 45, B, '45%') + String.raw`
<div style="margin:2px 0 3px">and 32% of study time goes to cramming. <b>The model is wrong</b>: change one assumption.</div>
<div class="step"><span class="i">1</span><span><b>Diminishing returns within a method</b>: the tenth straight hour of quizzing does less than the first. <span class="tag">the lecture's choice</span></span></div>
<div class="step"><span class="i">2</span><span><b>A cost of switching</b> methods: the paper's \(C(e)\).</span></div>
<div class="res">Either makes each extra hour of a method worth less than the last, so an interior split becomes possible.</div>`,
      'slides 14–15 · Application 1')

    const rem = String.raw`<div class="card s12 rem">
<div class="row" style="gap:14px"><div style="font-variant-caps:all-small-caps;letter-spacing:.07em;font-size:12.6px;color:var(--gilt);padding-top:1px">Remember</div>
<div class="f1"><b>Set up first</b>: choose · objective · constraint. The hardest part; the rest becomes mechanical.</div>
<div class="f1"><b>Contradictory FOCs</b> (λ = 6 and λ = 4) mean there is no interior answer: compare the corners.</div>
<div class="f1"><b>A linear objective ends at a corner</b>: the per-hour gap never shrinks (equal coefficients: every split ties).</div>
</div></div>`
    return page(MAST, 'Constrained Optimization', 'Week at a glance · 1 of 3', 'the problem · the tools · the corner',
      q + setup + toolkit + linear + why + data + rem,
      'Sources: W1 slides · Problem Set 1 · Application 1 · Perloff Ch. 1 + Calculus Appendix · 9 Sep lecture', '<span class="tag b">book</span> = Perloff only, not on the slides · slide numbers as printed on the deck')
  }

  // ---------------------------------------------------------------- sheet 2

  function sheet2() {
    const model = card('s5', '1', 'Diminishing returns', String.raw`
\[\max_{e_p,\,e_r}\ 12\sqrt{e_p} + 8\sqrt{e_r}\ \ \ \text{s.t.}\ \ e_p + e_r = 13\]
<div class="eqbox">\(MB_p = \dfrac{6}{\sqrt{e_p}}\qquad MB_r = \dfrac{4}{\sqrt{e_r}}\)</div>
` + where([
      [String.raw`\(MB_p,\ MB_r\)`, '<b>marginal return</b>: extra points from one more hour of each method'],
      ['12, 8', 'weights on the methods; at one hour the margins are 6 and 4'],
    ]) + String.raw`
<ul class="t" style="margin-top:3px">
<li><b>Diminishing marginal returns</b>: each MB falls as its own hours rise.</li>
<li><b>Interior?</b> Yes here: each MB → ∞ as its hours → 0, so the margins cross inside the line. Diminishing returns alone only make it <i>possible</i> (PS1 Q11).</li>
</ul>`, 'slides 16–17')

    const cross = card('s7', '2', 'The marginal returns cross', String.raw`<div class="row" style="gap:8px"><div style="width:290px">` + figMbCross() + String.raw`</div>
<div class="f1 cap" style="font-size:10px;margin-top:14px">Left of 9 retrieval pays more per hour: move hours to it. Right of 9 rereading pays more: move them back.<br><br>They meet at \(e_p = 9\), \(e_r = 4\), both worth <b>2 points an hour</b>. That height is λ.<br><br>Dashed: the linear model's flat 6 and 4 never meet.</div></div>`, 'slides 16, 21')

    const col = (t, b) => `<div class="f1">${sub(t)}${b}</div>`
    const solve = card('s12', '3', 'Solve it two ways', '<div class="row" style="gap:12px">' + col('Substitution', String.raw`
\[\max_{e_p}\ 12\sqrt{e_p} + 8\sqrt{13-e_p}\]
\[\frac{6}{\sqrt{e_p}} - \frac{4}{\sqrt{13-e_p}} = 0\ \ \ \text{(chain rule: the minus)}\]
\[36\,(13-e_p) = 16\,e_p\ \Rightarrow\ 52\,e_p = 468\ \Rightarrow\ e_p = 9\]`) + col('Lagrange', String.raw`
\[\mathcal{L} = 12\sqrt{e_p} + 8\sqrt{e_r} + \lambda\,[\,13 - e_p - e_r\,]\]
\[\frac{6}{\sqrt{e_p}} = \lambda,\quad \frac{4}{\sqrt{e_r}} = \lambda,\quad e_p + e_r = 13\]
\[\text{divide:}\ \frac{6}{4}\cdot\frac{\sqrt{e_r}}{\sqrt{e_p}} = 1\Rightarrow \frac{e_r}{e_p} = \frac49\Rightarrow e_p\Big(1+\frac49\Big) = 13\]`) +
      col('The answer', String.raw`
<div class="eqbox" style="background:var(--gilt-t);border-color:rgba(138,109,59,.4)">\(e_p = 9,\ \ e_r = 4,\ \ \lambda = 2\)<br>\(L = 12\sqrt9 + 8\sqrt4 = 36 + 16 = 52\)</div>
<div>Corners: 43.3 (all retrieval), 28.8 (all rereading).</div>
<div class="res"><b>Which route?</b> Substitution: quick for two choices, never gives λ. Lagrange: scales to many choices (PS1 Q6), gives λ and the ratio. <b>Divide one FOC by the other</b>: λ cancels.</div>`) + '</div>', 'slides 18–20 · PS1 Q3 · Perloff A.6')

    const top = card('s6', '4', 'The flat top', figHump() + String.raw`
<div class="cap">Learning along the 13-hour line. Linear: a straight rise to the end (78). Diminishing returns: a hump whose flat top, at 9 hours, is worth 52, above both ends. The FOC finds a flat top, never an end point.</div>`, 'slides 9, 20 · Perloff A.5')

    const ratio = card('s6', '5', 'The ratio condition: the economics', String.raw`
<div class="row" style="gap:6px"><div style="width:220px">` + figTangent(220) + String.raw`</div><div class="f1">
\[\frac{6}{\sqrt{e_p}} = \frac{4}{\sqrt{e_r}}\]
No shift of time between methods raises learning: no profitable swap is left.
<div class="res">Willing to trade (level-curve slope \(-MB_p/MB_r\)) = able to trade (slope of the black 13-hour line): the best level curve <b>touches</b> it at (9, 4). 40 crosses; 60 misses.</div></div></div>
<div class="eqbox">\(\dfrac{MB_p}{MB_r} = \dfrac{P_p}{P_r}\iff\dfrac{MB_p}{P_p} = \dfrac{MB_r}{P_r} = \lambda\qquad P\text{: resource per unit}\)</div>`, 'slide 21 · PS1 Q7')

    const lam = card('s6', '6', 'λ is a shadow price', String.raw`
<div class="eqbox">\(\lambda = \dfrac{6}{\sqrt9} = \dfrac{4}{\sqrt4} = 2\ \text{ points per extra hour}\)</div>
<ul class="t">
<li>The multiplier on the constraint, which <b>binds</b>. A slack constraint has λ = 0.</li>
<li><b>Meaning</b>: the value of relaxing the constraint by one unit, the "price" of an hour: \(dV/dT = \lambda\), where \(V(T)\) = the best learning with \(T\) hours (sheet 3).</li>
<li>Where the extra time goes does not matter: at the optimum both methods pay λ at the margin.</li>
</ul>`, 'slide 22 · Perloff A.6')

    const rem = card('s6 rem', '', 'Remember', String.raw`
<div class="step"><span class="i">◆</span><span><b>Concave makes splitting pay</b>: if \(g\) rises, is strictly concave and \(g(0)=0\), then \(g(a+b) &lt; g(a)+g(b)\) for all \(a, b &gt; 0\) (PS1 Q12). Next week convex preferences do the same job.</span></div>
<div class="step"><span class="i">◆</span><span>FOC = <b>necessary</b> at an interior max; concavity makes it <b>the</b> max.</span></div>
<div class="step"><span class="i">◆</span><span>Report: the choice, the value, λ <b>with units</b>, the corners checked.</span></div>`)
    const admin = card('s12', '', 'Course mechanics', String.raw`
<div class="row" style="gap:12px"><div class="f1"><b>Tests</b>, Mon 5–7 pm: Problem Solving 2 Nov · Application &amp; Communication 30 Nov · PS 1 Feb · A&amp;C 8 Mar · PS 5 Apr · final exam April, 3 h.</div>
<div class="f1"><b>Checkpoint quizzes</b> ≈ every two weeks: 20 min, start of tutorial, unaided, returned via Crowdmark; close to the class and problem-set core; TA solves them right after.</div>
<div class="f1"><b>Application files</b>: a paper or news story, explain-why questions; office hours or the AI prep coach (feedback only). <b>Calculus</b>: partials from Week 2; a tutorial on Quercus.</div></div>`, 'slides 26–30')
    return page(MAST, 'Constrained Optimization', 'Week at a glance · 2 of 3', 'diminishing returns · the interior answer · λ',
      model + cross + solve + top + ratio + lam + rem + admin,
      'Sources: W1 slides · Problem Set 1 · Perloff Calculus Appendix A.2–A.6 · 9 Sep lecture', 'test dates as the Week 1 slide gives them · slide numbers as printed')
  }

  // ---------------------------------------------------------------- sheet 3

  function sheet3() {
    const cs = card('s7', '1', 'Comparative statics: change one thing, say why', String.raw`
<table class="tb">
<tr><th style="width:104px">change</th><th style="width:92px">new choice</th><th style="width:58px">λ</th><th>why</th></tr>
<tr><td>baseline, 13 h</td><td class="num">(9, 4), 52</td><td class="num">2</td><td></td></tr>
<tr><td>26 hours <span class="mute">Q4</span></td><td class="num">(18, 8), same 9 : 4</td><td class="num">√2 ≈ 1.41 ↓</td><td>hours never enter the ratio; more hours, further down diminishing returns</td></tr>
<tr><td>rereading as good, \(12\sqrt{e_r}\) <span class="mute">Q5</span></td><td class="num">(6.5, 6.5)</td><td class="num">≈ 2.35 ↑</td><td>identical methods split evenly; better technology, every hour worth more</td></tr>
<tr><td>+ \(10\sqrt{e_s}\), 77 h <span class="mute">Q6</span></td><td class="num">(36, 16, 25)</td><td class="num">1</td><td>\(e_p = 36/\lambda^2,\ e_r = 16/\lambda^2,\ e_s = 25/\lambda^2\): hours ∝ squared coefficients</td></tr>
</table>
<div class="res"><b>Two things move λ</b>: more of the resource (↓ under diminishing returns), better technology (↑). Give the economic reason, never "the FOC says so".</div>`, 'slide 23 · PS1 Q4–6')

    const val = card('s5', '2', 'The value of time', figValue() + String.raw`
<div class="cap">\(V(T) = 52\sqrt{T/13}\), the best learning with \(T\) hours. Its slope is λ: 2 at 13 h, 1.41 at 26 h.</div>`, 'PS1 Q4 · Perloff A.5')

    const col = (t, b) => `<div class="f1">${sub(t)}${b}</div>`
    const pc = card('s12', '3', 'Prices, caps and the problem turned around', '<div class="row" style="gap:10px">' + col('A price · Q7', String.raw`
A unit of retrieval takes 2 clock hours: \(2e_p + e_r = 34\).
\[\frac{MB_p}{2} = \frac{MB_r}{1} = \lambda\]
(9, 16), λ = 1, \(L\) = 68. Equal benefit <b>per clock hour</b>, not equal MB. Retrieval's share of the hours falls from 69% to 53%.`) + col('A cap · Q8', String.raw`
Add \(e_p \le 5\). Lagrange returns 9: it only knows the constraints you give it.<br>Learning rises in \(e_p\) up to 9, so take the most allowed: <b>(5, 24), \(L\) ≈ 66.0</b>.<br>Per clock hour 1.34 vs 0.82: unequal is fine, the move is blocked. <span class="mute">(Kuhn–Tucker records it with a second multiplier, ≈ 1.05; not used in ECO206.)</span>`) + col('The dual · Q10', String.raw`
\[\min\ e_p + e_r\ \ \text{s.t.}\ \ 12\sqrt{e_p} + 8\sqrt{e_r} = 52\]
Same ratio condition, same (9, 4). Its multiplier \(\mu = \tfrac12 = 1/\lambda\): one more point costs half an hour. Same tangency, reciprocal multipliers (Perloff A.8).`) +
      `<div style="width:222px">${figPriceCap()}</div></div>` + String.raw`
<div class="res"><b>Tutorial 1, the same machine on a farm.</b> 25 units of water, \(20\sqrt{w_A}+15\sqrt{w_B}\) ⇒ (16, 9), λ = 2.5 t per unit, 125 t. Uphill field A draws 2 units per unit: \(2w_A + w_B = 68\) ⇒ (16, 36), λ = 1.25 t per reservoir unit, 170 t. Licence \(w_A\le 10\) ⇒ (10, 48), ≈ 167.2 t; per reservoir unit A 1.58 vs B 1.08. <span class="mute">(No posted solutions: worked here.)</span></div>`, 'PS1 Q7, Q8, Q10 · Tutorial 1 · Perloff A.7–A.8')

    const bel = card('s6', '4', 'Wrong beliefs', String.raw`<div class="row" style="gap:6px"><div style="width:226px">` + figBeliefs() + String.raw`</div><div class="f1">
Choose on <b>perceived</b> \(\tilde\alpha\); learn by the <b>true</b> \(\alpha\). In the diminishing model, weights \(2\tilde\alpha\): believed \(2\tilde\alpha_p\sqrt{e_p} + 2\tilde\alpha_r\sqrt{e_r}\) (truth: 12, 8). FOCs:
\[\frac{e_p}{e_r} = \Big(\frac{\tilde\alpha_p}{\tilde\alpha_r}\Big)^2\]
Only the believed <b>ratio</b> moves the split.</div></div>
<ul class="t">
<li><span style="color:var(--red)">●</span> \(\tilde\alpha_p = 4,\ \tilde\alpha_r = 6\) ⇒ (4, 9): learns 48, loses 4. <span style="color:var(--violet)">●</span> Believe equal ⇒ (6.5, 6.5): 51.0, loses ≈ 1 (PS1 Q9). <span style="color:var(--gilt)">●</span> Truth: (9, 4), 52.</li>
<li>Linear model: the flipped belief goes to the other corner, 52 not 78 (−26). Near a flat top mistakes are cheap: small effects.</li>
</ul>`, 'slide 24 · PS1 Q9')

    const paper = card('s6', '5', 'Back to the paper', String.raw`
<ul class="t">
<li>2,000+ students. Believed gap, active − passive methods: <b>0.83</b> below a B, <b>1.45</b> at B or above.</li>
<li><b>General feedback</b>: an hour seems worth 3% more; the relative belief does not move: little effect.</li>
<li><b>Personalized feedback</b>: the gap widens <b>42%</b>, time shifts to retrieval, scores <b>+0.05 to 0.08 SD</b>; for the most mistaken, worth a <b>16.5%</b> cut in the cost of better habits.</li>
<li><b>What the model predicts</b> for A1 Q4 (no posted solution): hours fixed ⇒ only the personalized group changes behaviour.</li>
</ul>
<div class="res"><b>One way to structure an application answer</b> (the Week 1 guide's): answer first · the model piece · the mechanism in words · one number and why · the assumption (fixed total hours).</div>`, 'slide 25 · Application 1')

    const steps = card('s5', '6', 'The eight problem-solving steps', String.raw`
<table class="tb">
<tr><td style="width:40px" class="mute">set up</td><td>1 What can I choose? · 2 My objective? · 3 My constraint?</td></tr>
<tr><td class="mute">solve</td><td>4 Is Lagrange valid here? · 5 \(\mathcal{L}\), FOCs, ratio, solve · 6 The ratio in words · 7 Is it the answer? (feasible, a max, corners, every restriction)</td></tr>
<tr><td class="mute">explain</td><td>8 Comparative static, and why.</td></tr>
</table>`, 'slide 23')

    const traps = card('s7 trap', '', 'Traps', String.raw`
<div class="row" style="gap:12px"><ul class="t f1" style="margin:0">
<li>Solving on after λ = 6 and λ = 4: stop, compare corners.</li>
<li>Losing the chain rule's minus on \(\sqrt{13-e_p}\).</li>
<li>Negative hours; a forgotten cap.</li>
<li>λ with no units or meaning.</li>
</ul><ul class="t f1" style="margin:0">
<li>Equal MB when prices differ: equalize MB <b>per unit of resource</b>.</li>
<li>Scoring a mistaken student by the belief, not the truth.</li>
<li>"Because the FOC says so" as a why.</li>
<li>Letting total hours change silently.</li>
</ul></div>`)

    return page(MAST, 'Constrained Optimization', 'Week at a glance · 3 of 3', 'using the model · prices, caps, beliefs · the method',
      cs + val + pc + bel + paper + steps + traps,
      'Sources: W1 slides · Problem Set 1 · Tutorial 1 · Application 1 · Perloff Calculus Appendix A.5–A.8', 'every number recomputed · slide numbers as printed')
  }

  return { title: 'ECO206 Week 1 at a glance', pages: [sheet1(), sheet2(), sheet3()] }
}
