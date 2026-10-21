// The page half of a "week at a glance" sheet set: the page shell, cards, "Where" lists and the toolkit grid, plus
// everything in ./figure.mjs (the SVG plotter), re-exported so a spec needs this one module.
//
// Every sheet is one US Letter page (816 x 1056 CSS px); a document is a run of .page divs, one per sheet, printed
// edge to edge. Maths in HTML is MathJax (\( \) inline, \[ \] display), loaded from the CDN below; maths inside an
// SVG figure is Unicode + <tspan> (MathJax prints blank there) — see lab() in ./figure.mjs.
//
// Every builder returns an HTML string and interpolates its arguments as they are: titles, cells and footers are
// trusted markup written by the spec. Only the document <title> is escaped.
import { esc } from './figure.mjs'

export * from './figure.mjs'

const MATHJAX = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg-full.js'

export const CSS = String.raw`
:root{--ink:#141517;--muted:#43464b;--muted2:#5f6369;--hair:rgba(23,24,26,.17);--hair2:rgba(23,24,26,.32);
--sheet:#fcfbfa;--slab:#34373c;--bone:#efece6;--bone2:#b6b1a9;--gilt:#8a6d3b;--gilt-t:#f4eedf;
--c:#2563eb;--c-t:#e6edfc;--violet:#6d4c9f;--red:#8c2f2a;--red-t:#f7e9e7}
@page{size:8.5in 11in;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
.page{width:816px;height:1056px;background:var(--sheet);color:var(--ink);position:relative;overflow:hidden;
  font-family:"Hoefler Text","Iowan Old Style",Baskerville,"Palatino Linotype","Book Antiqua",Georgia,serif;font-size:10.3px;line-height:1.26;font-variant-numeric:lining-nums;
  display:flex;flex-direction:column;page-break-after:always}
.mast{background:var(--slab);color:var(--bone);padding:11px 26px 9px;display:flex;justify-content:space-between;align-items:flex-end}
.mast .k{font-variant-caps:all-small-caps;letter-spacing:.09em;font-size:12.5px;color:var(--bone2)}
.mast h1{font-weight:normal;font-size:25px;line-height:1.05;margin:2px 0 0;letter-spacing:.005em}
.mast .r{text-align:right}
.mast .r .big{font-size:15px;font-variant-caps:all-small-caps;letter-spacing:.08em;color:var(--bone)}
.cband{height:3px;background:var(--c)}
.body{flex:1;padding:10px 20px 0;display:grid;grid-template-columns:repeat(12,1fr);gap:8px;align-content:start}
.card{border:1px solid var(--hair);background:#fff;padding:6px 9px 7px;min-width:0}
.card h2{font-size:12.6px;font-weight:normal;font-variant-caps:all-small-caps;letter-spacing:.07em;margin:0 0 4px;
  padding-bottom:2px;border-bottom:1px solid var(--hair);display:flex;align-items:baseline;gap:6px}
.card h2 .n{color:var(--c);font-variant-caps:normal;font-size:11px;letter-spacing:0}
.card h2 .src{margin-left:auto;font-size:9.6px;color:var(--muted2);letter-spacing:.05em}
.s1{grid-column:span 1}.s2{grid-column:span 2}.s3{grid-column:span 3}.s4{grid-column:span 4}.s5{grid-column:span 5}
.s6{grid-column:span 6}.s7{grid-column:span 7}.s8{grid-column:span 8}.s9{grid-column:span 9}.s10{grid-column:span 10}.s11{grid-column:span 11}.s12{grid-column:span 12}
.row{display:flex;gap:8px;align-items:flex-start}.col{display:flex;flex-direction:column;gap:6px}
.f1{flex:1;min-width:0}
.q{font-style:italic;color:var(--muted)}
.mute{color:var(--muted2)}
.big{font-size:12px}
ul.t{margin:2px 0 0;padding:0 0 0 12px}ul.t li{margin:1px 0}
.where{display:grid;grid-template-columns:auto 1fr;column-gap:7px;row-gap:1px;font-size:9.8px;margin-top:3px;
  padding:3px 6px;background:#f6f5f2;border-left:2px solid var(--hair2)}
.where .w{font-variant-caps:all-small-caps;letter-spacing:.06em;color:var(--muted2);grid-column:1/-1;font-size:10px}
.where b{font-weight:normal;white-space:nowrap}
.eq{margin:3px 0;text-align:center}
.eqbox{border:1px solid var(--hair);background:var(--c-t);padding:4px 6px;margin:4px 0;text-align:center}
.step{display:grid;grid-template-columns:14px 1fr;column-gap:3px;margin:1px 0}
.step .i{color:var(--c);font-size:9.6px;padding-top:1px}
.rem{border:1px solid var(--hair);border-left:3px solid var(--gilt);background:var(--gilt-t)}
.rem h2{color:var(--gilt);border-bottom-color:rgba(138,109,59,.35)}
.trap{border:1px solid var(--hair);border-left:3px solid var(--red);background:var(--red-t)}
.trap h2{color:var(--red);border-bottom-color:rgba(140,47,42,.3)}
.tag{display:inline-block;font-variant-caps:all-small-caps;letter-spacing:.06em;font-size:9.4px;color:var(--muted2);
  border:1px solid var(--hair2);padding:0 3px;line-height:1.25;vertical-align:1px;font-style:normal}
.tag.b{color:var(--gilt);border-color:rgba(138,109,59,.5)}
.num{font-variant-numeric:lining-nums tabular-nums}
.res{border-top:1px solid var(--hair);margin-top:4px;padding-top:3px}
.fig{display:block;margin:2px auto 0}
.cap{font-size:9.5px;color:var(--muted);margin-top:1px;line-height:1.22}
table.tb{border-collapse:collapse;width:100%;font-size:10px}
table.tb td,table.tb th{border-bottom:1px solid var(--hair);padding:1.5px 4px;text-align:left;vertical-align:top}
table.tb th{font-weight:normal;font-variant-caps:all-small-caps;letter-spacing:.06em;color:var(--muted2)}
.foot{padding:5px 20px 7px;font-size:9px;color:var(--muted2);display:flex;justify-content:space-between;border-top:1px solid var(--hair);margin-top:8px}
mjx-container[jax="SVG"]{margin:0!important}
mjx-container[display="true"]{margin:2px 0!important}
.tg{display:grid;column-gap:0;row-gap:5px;margin:0 -9px}
.tc{padding:0 9px;border-left:1px solid var(--hair);min-width:0}
.tc:nth-child(3n+1){border-left:none}
.tt,.sub{font-variant-caps:all-small-caps;letter-spacing:.06em;color:var(--c)}
.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:9px}
`

// One sheet: the masthead (kicker over title, rightBig over rightSmall), the colour band, the 12-column card grid
// and the footer.
export function page(kicker, title, rightBig, rightSmall, body, footLeft, footRight) {
  return `<div class="page">
<div class="mast"><div><div class="k">${kicker}</div><h1>${title}</h1></div>
<div class="r"><div class="big">${rightBig}</div><div class="k">${rightSmall}</div></div></div>
<div class="cband"></div>
<div class="body">${body}</div>
<div class="foot"><span>${footLeft}</span><span>${footRight}</span></div>
</div>`
}

// The whole document: pages = the page() strings, in order.
export function doc(title, pages) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${CSS}</style>
<script>window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)']],displayMath:[['\\\\[','\\\\]']]},
svg:{fontCache:'global',scale:0.98},startup:{typeset:true}};</script>
<script src="${MATHJAX}"></script></head><body>
${pages.join('')}
</body></html>`
}

// A card: cls = its span and kind ('s6', 's7 trap', 's6 rem'), num = the blue number ('' for none), src = the
// small source note at the right of its heading.
export function card(cls, num, title, inner, src = '') {
  const n = num ? `<span class="n">${num}</span>` : ''
  const s = src ? `<span class="src">${src}</span>` : ''
  return `<div class="card ${cls}"><h2>${n}${title}${s}</h2>${inner}</div>`
}

// A "Where" list: rows = [[symbol, meaning]].
export function where(rows, head = 'Where') {
  const cells = rows.map(([a, b]) => `<b>${a}</b><span>${b}</span>`).join('')
  return `<div class="where"><span class="w">${head}</span>${cells}</div>`
}

// A grid of small titled cells (the toolkit): cells = [[title, html]]; cols = a grid-template-columns value.
export function toolGrid(cells, cols = '1fr 1fr 1fr') {
  const inner = cells.map(([t, b]) => `<div class="tc"><div class="tt">${t}</div>${b}</div>`).join('')
  return `<div class="tg" style="grid-template-columns:${cols}">${inner}</div>`
}
