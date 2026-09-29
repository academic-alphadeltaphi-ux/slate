import { Fragment } from 'react'

// A small read-only markdown renderer for the screens (SPEC §20.13). The editor is still the only place a page is
// written; this draws what a page holds so the week screen and the hub can show content instead of a link to it.
// It covers what the notebooks actually contain: headings, paragraphs, lists, GFM task items, tables, quotes, rules
// and fenced code, with **bold**, *italic*, `code`, ==highlight==, ++underline++, ~~strike~~, [links](…) and [[wikilinks]] inline.
// Anything it does not know is printed as written, never swallowed.
//   <MdLite md={…} onToggle={raw => …} onOpenTitle={title => …} />
// `onToggle` receives the task line exactly as it stands in the file, which is what src/tick.js flips.

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|==[^=]+==|\+\+[^+\n]+\+\+|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)\s]+\))/g
export function Inline({ text, onOpenTitle }) {
  const s = String(text ?? ''), out = []
  let i = 0, m
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(s))) {
    if (m.index > i) out.push(<Fragment key={i}>{s.slice(i, m.index)}</Fragment>)
    const t = m[0], k = m.index
    if (t.startsWith('**') || t.startsWith('__')) out.push(<b key={k}><Inline text={t.slice(2, -2)} onOpenTitle={onOpenTitle} /></b>)
    else if (t.startsWith('~~')) out.push(<s key={k}>{t.slice(2, -2)}</s>)
    else if (t.startsWith('==')) out.push(<mark key={k}>{t.slice(2, -2)}</mark>)
    else if (t.startsWith('++')) out.push(<u key={k}><Inline text={t.slice(2, -2)} onOpenTitle={onOpenTitle} /></u>)
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('[[')) { const w = t.slice(2, -2).split('|'), label = (w[1] || w[0]).split('/').pop()
      out.push(onOpenTitle ? <button key={k} className="md-wiki" onClick={() => onOpenTitle(w[0])}>{label}</button> : <span key={k} className="md-wiki">{label}</span>) }
    else if (t.startsWith('[')) { const p = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)
      out.push(<a key={k} href={p[2]} target="_blank" rel="noopener">{p[1]}</a>) }
    else out.push(<i key={k}><Inline text={t.slice(1, -1)} onOpenTitle={onOpenTitle} /></i>)
    i = k + t.length
  }
  if (i < s.length) out.push(<Fragment key={'t' + i}>{s.slice(i)}</Fragment>)
  return <>{out}</>
}

const TASK = /^(\s*)[-*+] \[([ xX])\]\s+(.*)$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const depthOf = indent => Math.floor(indent.replace(/\t/g, '  ').length / 2)

// md → a flat list of nodes. One pass, no dependencies; a blank line ends a paragraph, two spaces or a trailing
// backslash is a hard break inside one.
function parse(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) { i++; continue }
    if (/^```/.test(l.trim())) {
      const lang = l.trim().slice(3).trim(), body = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++])
      i++
      out.push({ type: 'code', lang, text: body.join('\n') }); continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { out.push({ type: 'h', level: h[1].length, text: h[2] }); i++; continue }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(l)) { out.push({ type: 'hr' }); i++; continue }
    if (/^\s*>\s?/.test(l)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ type: 'quote', text: body.join('\n') }); continue
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[-: |]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const head = cells(l); i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push({ type: 'table', head, rows }); continue
    }
    if (ITEM.test(l)) {
      const items = []
      while (i < lines.length && (ITEM.test(lines[i]) || (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])))) {
        const t = TASK.exec(lines[i]), it = ITEM.exec(lines[i])
        if (it) items.push({ depth: depthOf(it[1]), ordered: !/^[-*+]$/.test(it[2]), done: t ? t[2] !== ' ' : null, text: t ? t[3] : it[3], raw: lines[i] })
        else if (items.length) items[items.length - 1].text += ' ' + lines[i].trim()
        i++
      }
      out.push({ type: 'list', items }); continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !ITEM.test(lines[i]) && !/^(#{1,6})\s|^\s*>|^```|^\s*\|/.test(lines[i])) para.push(lines[i++])
    out.push({ type: 'p', lines: para })
  }
  return out
}

export default function MdLite({ md, onToggle, onOpenTitle, className = '' }) {
  const nodes = parse(md)
  if (!nodes.length) return null
  return (
    <div className={'md ' + className}>
      {nodes.map((n, k) => {
        if (n.type === 'h') { const H = `h${Math.min(6, n.level + 2)}`; return <H key={k} className={'md-h md-h' + n.level}><Inline text={n.text} onOpenTitle={onOpenTitle} /></H> }
        if (n.type === 'hr') return <hr key={k} className="md-hr" />
        if (n.type === 'code') return <pre key={k} className="md-code"><code>{n.text}</code></pre>
        if (n.type === 'quote') return <blockquote key={k} className="md-quote"><MdLite md={n.text} onOpenTitle={onOpenTitle} /></blockquote>
        if (n.type === 'table') return (
          <div key={k} className="md-tablewrap"><table className="md-table">
            <thead><tr>{n.head.map((c, j) => <th key={j}><Inline text={c} onOpenTitle={onOpenTitle} /></th>)}</tr></thead>
            <tbody>{n.rows.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}><Inline text={c} onOpenTitle={onOpenTitle} /></td>)}</tr>)}</tbody>
          </table></div>)
        if (n.type === 'list') return (
          <ul key={k} className="md-list">
            {n.items.map((it, j) => (
              <li key={j} className={'md-item d' + Math.min(3, it.depth) + (it.done === null ? '' : it.done ? ' done' : '') + (it.done === null ? '' : ' task')} style={{ marginLeft: it.depth * 16 }}>
                {it.done === null
                  ? <span className="md-bullet">{it.ordered ? '·' : '•'}</span>
                  : <input type="checkbox" checked={it.done} disabled={!onToggle} onChange={() => onToggle?.(it.raw)} />}
                <span className="md-text"><Inline text={it.text} onOpenTitle={onOpenTitle} /></span>
              </li>))}
          </ul>)
        return <p key={k} className="md-p">{n.lines.map((t, j) => <Fragment key={j}><Inline text={t.replace(/(\\|\s\s)$/, '')} onOpenTitle={onOpenTitle} />{j < n.lines.length - 1 && (/(\\|\s\s)$/.test(t) ? <br /> : ' ')}</Fragment>)}</p>
      })}
    </div>
  )
}
