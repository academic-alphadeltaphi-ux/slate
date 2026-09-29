import { Icon } from './Icons.jsx'
import { useEditorState } from '@tiptap/react'
import { FONTS, SIZES, COLORS } from '../editor/extensions.js'
import { useDialog } from './Dialog.jsx'

const keep = e => e.preventDefault()   // keep focus in the editor while clicking

export default function Toolbar({ editor, style, blockStyle, onBlockStyle }) {
  const s = useEditorState({ editor, selector: ({ editor: ed }) => ed ? ({
    bold: ed.isActive('bold'), italic: ed.isActive('italic'), underline: ed.isActive('underline'), strike: ed.isActive('strike'),
    highlight: ed.isActive('highlight'), code: ed.isActive('code'), h1: ed.isActive('heading', { level: 1 }), h2: ed.isActive('heading', { level: 2 }), h3: ed.isActive('heading', { level: 3 }),
    bullet: ed.isActive('bulletList'), ordered: ed.isActive('orderedList'), task: ed.isActive('taskList'),
    fontSize: ed.getAttributes('textStyle').fontSize || '', fontFamily: ed.getAttributes('textStyle').fontFamily || '', color: ed.getAttributes('textStyle').color || '',
  }) : {} })
  const dialog = useDialog()
  if (!editor) return null
  const c = () => editor.chain().focus()
  const B = ({ on, title, onClick, children }) => <button type="button" className={'tb' + (on ? ' on' : '')} title={title} onMouseDown={keep} onClick={onClick}>{children}</button>
  return (
    <div className="toolbar" style={style} tabIndex={-1} onMouseDown={e => e.stopPropagation()}>
      <select className="tb-select" title="Font" value={s.fontFamily || ''} onMouseDown={e => e.stopPropagation()} onChange={e => { const v = e.target.value; v ? c().setFontFamily(v).run() : c().unsetFontFamily().run() }}>
        {FONTS.map(f => <option key={f.label} value={f.value || ''}>{f.label}</option>)}
      </select>
      <select className="tb-select narrow" title="Size" value={s.fontSize || ''} onMouseDown={e => e.stopPropagation()} onChange={e => { const v = e.target.value; v ? c().setFontSize(v).run() : c().unsetFontSize().run() }}>
        <option value="">Size</option>{SIZES.map(n => <option key={n} value={`${n}px`}>{n}</option>)}
      </select>
      <span className="tb-sep" />
      <B on={s.bold} title="Bold ⌘B" onClick={() => c().toggleBold().run()}><b>B</b></B>
      <B on={s.italic} title="Italic ⌘I" onClick={() => c().toggleItalic().run()}><i>I</i></B>
      <B on={s.underline} title="Underline ⌘U" onClick={() => c().toggleUnderline().run()}><u>U</u></B>
      <B on={s.strike} title="Strikethrough ⌘⇧X" onClick={() => c().toggleStrike().run()}><s>S</s></B>
      <B on={s.highlight} title="Highlight ⌘⇧H" onClick={() => c().toggleHighlight().run()}><span className="hl">H</span></B>
      <B on={s.code} title="Code ⌘E" onClick={() => c().toggleCode().run()}><code>{'<>'}</code></B>
      <span className="tb-colors">{COLORS.map(col => <button key={col} type="button" className={'swatch' + (s.color === col ? ' on' : '')} style={{ background: col }} title={col} onMouseDown={keep} onClick={() => c().setColor(col).run()} />)}<button type="button" className="swatch none" title="No colour" onMouseDown={keep} onClick={() => c().unsetColor().run()} /></span>
      <span className="tb-sep" />
      <B on={s.h1} title="Heading 1 ⌘1" onClick={() => c().toggleHeading({ level: 1 }).run()}>H1</B>
      <B on={s.h2} title="Heading 2 ⌘2" onClick={() => c().toggleHeading({ level: 2 }).run()}>H2</B>
      <B on={s.h3} title="Heading 3 ⌘3" onClick={() => c().toggleHeading({ level: 3 }).run()}>H3</B>
      <B on={s.bullet} title="Bullet list" onClick={() => c().toggleBulletList().run()}>•≡</B>
      <B on={s.ordered} title="Numbered list" onClick={() => c().toggleOrderedList().run()}>1≡</B>
      <B on={s.task} title="Checklist ⌘⇧L" onClick={() => c().toggleTaskList().run()}><Icon.checkSquare width="15" height="15" /></B>
      <B title="Table" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>⊞</B>
      <B title="Link" onClick={async () => { const prev = editor.getAttributes('link').href || ''; const url = await dialog.prompt({ title: 'Link', label: 'URL', value: prev, placeholder: 'https://', confirmLabel: 'Set link' }); if (url === null) return; url ? c().extendMarkRange('link').setLink({ href: url }).run() : c().unsetLink().run() }}><Icon.link width="15" height="15" /></B>
      <span className="tb-sep" />
      <select className="tb-select" title="Container font" value={blockStyle?.font || ''} onMouseDown={e => e.stopPropagation()} onChange={e => onBlockStyle({ font: e.target.value || null })}>
        {FONTS.map(f => <option key={f.label} value={f.value || ''}>{f.label === 'System' ? 'Box: System' : 'Box: ' + f.label}</option>)}
      </select>
      <select className="tb-select narrow" title="Container size" value={blockStyle?.size || ''} onMouseDown={e => e.stopPropagation()} onChange={e => onBlockStyle({ size: e.target.value ? Number(e.target.value) : null })}>
        <option value="">Box</option>{SIZES.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  )
}
