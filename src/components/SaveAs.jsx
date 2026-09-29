import { useState } from 'react'
import { api } from '../api.js'
import { Icon } from './Icons.jsx'
import { buildExtensions } from '../editor/extensions.js'
import { createRenderer } from '../editor/markdown.js'
import { fetchTranscript, hms } from './Elements.jsx'
import '../styles/export.css'

// The transcripts of the recordings a page shows (SPEC §20.33). They live beside the audio, not in the page text, so a
// copy made from the text alone left them out. → [{ name, paragraphs }]
const MEDIA_RE = /\.(m4a|mp3|wav|aac|flac|ogg|mp4|mov|webm)$/i
async function transcriptsOf(pg, dir) {
  const out = []
  for (const el of pg.layout?.elements || []) {
    if (el.type !== 'media' && !MEDIA_RE.test(el.src || '')) continue
    const tr = await fetchTranscript(el, api.fileUrl(dir, el.src))
    if (tr?.paragraphs?.length) out.push({ name: decodeURIComponent(String(el.src).split('/').pop()), paragraphs: tr.paragraphs })
  }
  return out
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Save this page as a file (SPEC §20.28). "Save as PDF" used to open the browser's print dialog, which is a printer
// with a Save button hidden inside it — the wrong object for "I want a copy of my notes". All three land as real
// files in `<Notebook>/_exports/`, with Open and Reveal beside them.
//
// PDF goes through the same hidden-Electron printer the section binders use, so a page prints exactly as it looks —
// ink, PDFs, images and all. Word is an HTML file with a `.doc` extension, rendered by the page's own markdown
// renderer: Word, Pages and Google Docs all open it and keep the headings, lists, tables and links. Markdown is the
// page itself, which is what is on disk anyway.
// props: { page: { path, title, dir }, onClose, onPrint(path) }
const FORMATS = [
  { id: 'pdf', label: 'PDF', icon: 'print', say: 'Exactly as it looks — ink, PDFs and images included.' },
  { id: 'doc', label: 'Word', icon: 'file', say: 'Opens in Word, Pages or Google Docs, still editable.' },
  { id: 'md', label: 'Markdown', icon: 'notes', say: 'The page itself, plain text. Obsidian reads it.' },
]

export default function SaveAs({ page, onClose }) {
  const [busy, setBusy] = useState(null)
  const [done, setDone] = useState(null)      // { rel, name, format }
  const [error, setError] = useState(null)

  const save = async id => {
    setBusy(id); setError(null); setDone(null)
    try {
      if (id === 'pdf') {
        await api.exportStart({ path: page.path, skipEmpty: false })
        for (;;) {
          await new Promise(r => setTimeout(r, 700))
          const s = await api.exportStatus()
          if (s.running) continue
          if (!s.ok || !s.out?.rel) throw new Error(s.note || s.failed?.[0]?.error || 'The printer could not finish this page.')
          setDone({ rel: s.out.rel, name: s.out.rel.split('/').pop(), format: id }); break
        }
      } else {
        let html, md
        const pg = await api.page(page.path)
        const trs = await transcriptsOf(pg, page.dir)
        if (id === 'doc') {
          const resolveSrc = src => (/^(https?:|data:|blob:|\/)/.test(src || '') ? src : api.fileUrl(page.dir, src))
          const r = createRenderer(buildExtensions({ resolveSrc }))
          html = `<h1>${page.title}</h1>` + pg.blocks.map(b => r.html(b.md)).join('\n')
            + trs.map(t => `<h2>Transcript · ${esc(t.name)}</h2>` + t.paragraphs.map(p => `<p><b>${hms(p.start)}</b>&nbsp;&nbsp;${esc(p.text)}</p>`).join('\n')).join('\n')
          r.destroy()
        } else if (trs.length) {
          md = [pg.blocks.map(b => b.md).join('\n\n'), ...trs.map(t => `## Transcript · ${t.name}\n\n` + t.paragraphs.map(p => `**${hms(p.start)}** ${p.text}`).join('\n\n'))].join('\n\n') + '\n'
        }
        const r = await api.exportFile({ path: page.path, format: id, html, md })
        setDone({ ...r, format: id })
      }
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs sv" onClick={e => e.stopPropagation()} role="dialog" aria-label="Save this page">
        <button className="cs-x" onClick={onClose} title="Close"><Icon.x width="15" height="15" /></button>
        <div className="cs-head"><h2>Save a copy</h2><p>{page.title}</p></div>
        <div className="cs-body sv-body">
          {FORMATS.map(f => (
            <button key={f.id} className="sv-row" disabled={!!busy} onClick={() => save(f.id)}>
              <span className="sv-ic">{(Icon[f.icon] || Icon.file)({ width: 16, height: 16 })}</span>
              <span className="sv-main"><b>{f.label}</b><small>{f.say}</small></span>
              <span className="sv-go">{busy === f.id ? (f.id === 'pdf' ? 'Printing…' : 'Writing…') : 'Save'}</span>
            </button>))}

          {error && <p className="home-error sv-note">{error}</p>}
          {done && (
            <div className="sv-done">
              <span className="grow">Saved to <b>{done.name}</b></span>
              <button className="btn small" onClick={() => api.exportOpen(done.rel).catch(e => setError(e.message))}>Open</button>
              <button className="btn small" onClick={() => api.exportOpen(done.rel, true).catch(e => setError(e.message))}>Reveal</button>
            </div>)}
        </div>
      </div>
    </div>)
}
