// The hand-plotted SVG figures of a "week at a glance" sheet: a palette, a label mini-markup and `Fig`, a
// data -> pixel plotter that writes the SVG as text (no DOM, no canvas, nothing to install).
//
// The map's origin IS the axis pixel: X(xr[0]) = ox and Y(yr[0]) = oy exactly, so a point, a drop line or a curve
// end at data x = xr[0] lands on the vertical axis pixel itself, never a hair beside it.
//
// Maths inside SVG cannot be MathJax (it prints blank there), so labels are Unicode + <tspan>: in a label, $...$
// marks a maths run, where letters go italic, _x / _{xy} subscript and ^x / ^{xy} superscript. Greek letters outside
// a maths run are set in STIX too (the serif's fallback alpha reads as an a).
//
// Every number is printed the way the approved sheets were: coordinates to 1 or 2 decimals with toFixed, tick
// labels with g() (6 significant digits, trailing zeros dropped), plain values as they are (an int prints as an int).

export const C = {
  ink: '#141517', muted: '#43464b', muted2: '#5f6369', hair: '#cfcdc8', grid: '#e6e4df',
  blue: '#2563eb', blue_t: '#e6edfc', violet: '#6d4c9f', violet_t: '#efe9f7',
  gilt: '#8a6d3b', gilt_t: '#f4eedf', red: '#8c2f2a', red_t: '#f7e9e7', grey: '#9a9c9f',
}

const STIX = 'STIX Two Text, Cambria Math, Times New Roman, serif'
const SERIF = 'Hoefler Text, Iowan Old Style, Baskerville, Palatino Linotype, Book Antiqua, Georgia, serif'

// HTML-escape text and attribute values: & < > " ' (in that order, & first).
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

// A number in the "general" format: 6 significant digits, trailing zeros and a bare point dropped, exponent form
// only below 1e-4 or from 1e6 up (2.5 -> '2.5', 13 -> '13', 0.5 -> '0.5', 1234567 -> '1.23457e+06').
export function g(v) {
  v = Number(v)
  if (Number.isNaN(v)) return 'nan'
  if (v === Infinity) return 'inf'
  if (v === -Infinity) return '-inf'
  if (v === 0) return Object.is(v, -0) ? '-0' : '0'
  const P = 6
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  const [mant, ex] = a.toExponential(P - 1).split('e')
  const exp = Number(ex)
  const trim = s => s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  if (exp >= -4 && exp < P) return sign + trim(a.toFixed(P - 1 - exp))
  return sign + trim(mant) + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0')
}

const LET = 'A-Za-zα-ωΑ-Ωℒ'
const RUNS = new RegExp(`[${LET}]+|[^${LET}]+`, 'gu')
const IS_LET = new RegExp(`^[${LET}]`, 'u')

function ital(t) {
  let out = ''
  for (const mo of t.matchAll(RUNS)) {
    const run = mo[0]
    out += IS_LET.test(run) ? `<tspan font-style="italic">${esc(run)}</tspan>` : esc(run)
  }
  return out
}

function math(m) {
  const a = [...m] // by code point
  let res = '', i = 0
  while (i < a.length) {
    const ch = a[i]
    if (ch === '_' || ch === '^') {
      i += 1
      if (i >= a.length) throw new RangeError(`label maths ends on "${ch}": ${m}`)
      let tok
      if (a[i] === '{') {
        const j = a.indexOf('}', i)
        if (j < 0) throw new Error(`label maths has an unclosed "{": ${m}`)
        tok = a.slice(i + 1, j).join('')
        i = j + 1
      } else {
        tok = a[i]
        i += 1
      }
      const shift = ch === '_' ? 'sub' : 'super'
      res += `<tspan baseline-shift="${shift}" font-size="70%">${ital(tok)}</tspan>`
    } else {
      let j = i
      while (j < a.length && a[j] !== '_' && a[j] !== '^') j += 1
      res += ital(a.slice(i, j).join(''))
      i = j
    }
  }
  return res
}

// Label markup -> SVG text content.
export function lab(s) {
  let out = ''
  for (const p of String(s).split(/(\$[^$]*\$)/)) {
    if (p.length > 1 && p[0] === '$' && p[p.length - 1] === '$') {
      out += `<tspan font-family="${STIX}">${math(p.slice(1, -1))}</tspan>`
    } else {
      out += esc(p).replace(/([α-ωΑ-Ω]+)/gu, `<tspan font-family="${STIX}">$1</tspan>`)
    }
  }
  return out
}

export const HALO = 'paint-order="stroke" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"'

// Data -> pixel map whose origin IS the axis pixel: X(xr[0]) = ox, Y(yr[0]) = oy.
export class Fig {
  constructor(id, w, h, xr, yr, { l = 40, r = 12, t = 18, b = 30, font = 10.5 } = {}) {
    this.id = id; this.w = w; this.h = h; this.xr = xr; this.yr = yr
    this.l = l; this.r = r; this.t = t; this.b = b
    this.ox = l; this.oy = h - b; this.pw = w - l - r; this.ph = h - t - b
    this.font = font
    this.els = []
    this.mk = new Map() // arrowhead colour -> marker id, in first-use order
  }

  X(x) { return this.ox + (x - this.xr[0]) / (this.xr[1] - this.xr[0]) * this.pw }
  Y(y) { return this.oy - (y - this.yr[0]) / (this.yr[1] - this.yr[0]) * this.ph }

  add(e) { this.els.push(e) }

  axes(xl, yl, { xt = [], yt = [], xtl = null, ytl = null, ybreak = false } = {}) {
    const a = C.muted, ox = this.ox, oy = this.oy
    this.add(`<line x1="${ox}" y1="${oy}" x2="${ox + this.pw + 7}" y2="${oy}" stroke="${a}" stroke-width="1.3" marker-end="url(#${this.id}-ar)"/>`)
    this.add(`<line x1="${ox}" y1="${oy}" x2="${ox}" y2="${oy - this.ph - 7}" stroke="${a}" stroke-width="1.3" marker-end="url(#${this.id}-ar)"/>`)
    xt.forEach((v, i) => {
      const x = this.X(v)
      const txt = xtl && xtl.length ? xtl[i] : g(v)
      this.add(`<line x1="${x.toFixed(1)}" y1="${oy}" x2="${x.toFixed(1)}" y2="${oy + 3.5}" stroke="${a}" stroke-width="1"/>`)
      this.add(`<text x="${x.toFixed(1)}" y="${oy + 12.5}" font-size="${this.font - 1.3}" text-anchor="middle" fill="${C.muted}">${lab(txt)}</text>`)
    })
    yt.forEach((v, i) => {
      const y = this.Y(v)
      const txt = ytl && ytl.length ? ytl[i] : g(v)
      this.add(`<line x1="${ox - 3.5}" y1="${y.toFixed(1)}" x2="${ox}" y2="${y.toFixed(1)}" stroke="${a}" stroke-width="1"/>`)
      this.add(`<text x="${ox - 5.5}" y="${(y + 3.3).toFixed(1)}" font-size="${this.font - 1.3}" text-anchor="end" fill="${C.muted}">${lab(txt)}</text>`)
    })
    if (ybreak) { // the vertical axis does not start at zero
      const y = oy - 7
      this.add(`<path d="M${ox - 4},${y + 2} l8,-3 M${ox - 4},${y + 5} l8,-3" stroke="${a}" stroke-width="1" fill="none"/>`)
    }
    this.add(`<text x="${ox + this.pw + 6}" y="${oy + 24}" font-size="${this.font}" text-anchor="end" fill="${C.ink}">${lab(xl)}</text>`)
    this.add(`<text x="${ox + 7}" y="${this.t - 6}" font-size="${this.font}" text-anchor="start" fill="${C.ink}">${lab(yl)}</text>`)
  }

  path(pts, color, { w = 2, dash = null, clip = true, op = 1 } = {}) {
    const d = 'M' + pts.map(([x, y]) => `${this.X(x).toFixed(2)},${this.Y(y).toFixed(2)}`).join(' L')
    const da = dash ? ` stroke-dasharray="${dash}"` : ''
    const cp = clip ? ` clip-path="url(#${this.id}-clip)"` : ''
    this.add(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}"${da}${cp} stroke-linecap="round" stroke-linejoin="round" opacity="${op}"/>`)
  }

  // n + 1 samples of f on [x0, x1]; a sample where f throws or gives no finite number is skipped, the rest are
  // clamped to one plot-height above and below the y range (the clip path does the visible cut).
  curve(f, x0, x1, color, { w = 2, dash = null, n = 240, op = 1 } = {}) {
    const pts = []
    for (let i = 0; i < n + 1; i++) {
      const x = x0 + (x1 - x0) * i / n
      let y
      try {
        y = f(x)
      } catch {
        continue
      }
      if (y === null || y === undefined || !Number.isFinite(y)) continue
      pts.push([x, Math.max(Math.min(y, this.yr[1] + (this.yr[1] - this.yr[0])), this.yr[0] - (this.yr[1] - this.yr[0]))])
    }
    this.path(pts, color, { w, dash, op })
  }

  line(x0, y0, x1, y1, color, { w = 1.6, dash = null, clip = true, op = 1 } = {}) {
    this.path([[x0, y0], [x1, y1]], color, { w, dash, clip, op })
  }

  arrow(x0, y0, x1, y1, color = null, { w = 1.3, px = false } = {}) {
    color = color || C.ink
    if (!px) [x0, y0, x1, y1] = [this.X(x0), this.Y(y0), this.X(x1), this.Y(y1)]
    const mid = this.mk.has(color) ? this.mk.get(color) : `${this.id}-ah${this.mk.size}`
    this.mk.set(color, mid)
    this.add(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${color}" stroke-width="${w}" marker-end="url(#${mid})"/>`)
  }

  drop(x, y, color = null, { toX = true, toY = true } = {}) {
    color = color || C.grey
    if (toY) {
      this.add(`<line x1="${this.ox}" y1="${this.Y(y).toFixed(1)}" x2="${this.X(x).toFixed(1)}" y2="${this.Y(y).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="3,2.5"/>`)
    }
    if (toX) {
      this.add(`<line x1="${this.X(x).toFixed(1)}" y1="${this.oy}" x2="${this.X(x).toFixed(1)}" y2="${this.Y(y).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="3,2.5"/>`)
    }
  }

  point(x, y, color = null, { r = 3.6, hollow = false } = {}) {
    color = color || C.gilt
    if (hollow) {
      this.add(`<circle cx="${this.X(x).toFixed(1)}" cy="${this.Y(y).toFixed(1)}" r="${r}" fill="#fff" stroke="${color}" stroke-width="1.6"/>`)
    } else {
      this.add(`<circle cx="${this.X(x).toFixed(1)}" cy="${this.Y(y).toFixed(1)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1"/>`)
    }
  }

  text(x, y, t, color = null, anchor = 'start', size = null, { dx = 0, dy = 0, px = false, halo = true, weight = null, italic = false } = {}) {
    color = color || C.ink
    size = size || this.font
    const X = (px ? x : this.X(x)) + dx
    const Y = (px ? y : this.Y(y)) + dy
    const hw = halo ? ` ${HALO}` : ''
    const fw = weight ? ` font-weight="${weight}"` : ''
    const fi = italic ? ' font-style="italic"' : ''
    this.add(`<text x="${X.toFixed(1)}" y="${Y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}" fill="${color}"${hw}${fw}${fi}>${lab(t)}</text>`)
  }

  poly(pts, color, op = .14) {
    const d = pts.map(([x, y]) => `${this.X(x).toFixed(1)},${this.Y(y).toFixed(1)}`).join(' ')
    this.add(`<polygon points="${d}" fill="${color}" fill-opacity="${op}" stroke="none" clip-path="url(#${this.id}-clip)"/>`)
  }

  svg(width = null) {
    width = width || this.w
    const hgt = this.h * width / this.w
    return (`<svg class="fig" width="${width.toFixed(0)}" height="${hgt.toFixed(0)}" viewBox="0 0 ${this.w} ${this.h}" xmlns="http://www.w3.org/2000/svg" ` +
      `font-family="${SERIF}" style="font-variant-numeric:lining-nums">` +
      `<defs><marker id="${this.id}-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">` +
      `<path d="M0,1 L10,5 L0,9z" fill="${C.muted}"/></marker>` +
      [...this.mk].map(([c, m]) => `<marker id="${m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">` +
        `<path d="M0,1 L10,5 L0,9z" fill="${c}"/></marker>`).join('') +
      `<clipPath id="${this.id}-clip"><rect x="${this.ox}" y="${this.t - 2}" width="${this.pw + 2}" height="${this.ph + 2}"/></clipPath></defs>` +
      this.els.join('') + '</svg>')
  }
}

// A root of f in [a, b] by halving (f(a) and f(b) of opposite signs).
export function bisect(f, a, b, tol = 1e-10) {
  let fa = f(a)
  for (let k = 0; k < 200; k++) {
    const m = (a + b) / 2
    const fm = f(m)
    if ((fa < 0) === (fm < 0)) {
      a = m
      fa = fm
    } else {
      b = m
    }
    if (b - a < tol) break
  }
  return (a + b) / 2
}
