import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { typesetMath } from '../editor/markdown.js'

// A text container: static HTML when idle, a TipTap editor while focused. SPEC.md §7.
export default function TextBlock(props) {
  return props.focused ? <BlockEditor {...props} /> : <StaticBlock {...props} />
}

function StaticBlock({ id, md, renderer, onFocus, onOpenTitle }) {
  const html = useMemo(() => renderer.html(md), [md, renderer])
  // One object per html string: React 19 re-sets innerHTML whenever this prop's identity changes, which would erase the typeset math.
  const inner = useMemo(() => ({ __html: html }), [html])
  const ref = useRef(null)
  useLayoutEffect(() => { if (ref.current) typesetMath(ref.current) }, [html])
  const click = e => {
    const a = e.target.closest?.('a')
    if (a) {
      e.preventDefault(); e.stopPropagation()
      if (a.dataset.wikilink) onOpenTitle(a.dataset.wikilink)
      else if (a.href) window.open(a.href, '_blank', 'noopener')
      return
    }
    e.stopPropagation()
    onFocus(id, { x: e.clientX, y: e.clientY })
  }
  if (!md.trim()) return <div className="block-static prose placeholder" onClick={click}>Write…</div>
  return <div ref={ref} className="block-static prose" onClick={click} dangerouslySetInnerHTML={inner} />
}

function BlockEditor({ md, extensions, focusPoint, onChange, onBlur, onEditor, onOpenTitle, onUpload, onDelete }) {
  const cbs = useRef({}); cbs.current = { onChange, onBlur, onOpenTitle, onUpload, onDelete }
  const editorRef = useRef(null)
  const insertFiles = files => {
    const list = [...(files || [])].filter(f => f.type.startsWith('image/'))
    if (!list.length) return false
    list.forEach(f => cbs.current.onUpload(f).then(a => editorRef.current?.chain().focus().setImage({ src: a.src }).run()).catch(console.error))
    return true
  }
  const editor = useEditor({
    extensions, content: md, contentType: 'markdown', autofocus: 'end',
    editorProps: {
      attributes: { class: 'prose' },
      handlePaste: (view, event) => insertFiles(event.clipboardData?.files),
      // Backspace or Delete in an empty box removes the box itself.
      handleKeyDown: (view, event) => { if ((event.key === 'Backspace' || event.key === 'Delete') && editorRef.current?.isEmpty && cbs.current.onDelete) { event.preventDefault(); cbs.current.onDelete(); return true } return false },
      handleDrop: (view, event) => { const files = event.dataTransfer?.files; if (files?.length) { event.preventDefault(); insertFiles(files); return true } return false },
      handleClick: (view, pos, event) => {
        const a = event.target.closest?.('a')
        if (a?.dataset.wikilink) { cbs.current.onOpenTitle(a.dataset.wikilink); return true }
        if (a?.href && (event.metaKey || event.ctrlKey)) { window.open(a.href, '_blank', 'noopener'); return true }
        return false
      },
    },
    onUpdate: ({ editor }) => cbs.current.onChange(editor.getMarkdown()),
    onBlur: ({ event }) => {
      if (event?.relatedTarget?.closest?.('.toolbar')) return
      setTimeout(() => {
        const a = document.activeElement
        if (a?.closest?.('.toolbar') || a === editorRef.current?.view?.dom) return
        cbs.current.onBlur()
      }, 0)
    },
  }, [])
  editorRef.current = editor
  useEffect(() => {
    if (!editor) return
    onEditor(editor)
    // The view is attached by EditorContent after this render; focus once it exists.
    let tries = 0
    const focus = () => {
      if (editor.isDestroyed) return
      if (!editor.view?.dom?.isConnected) { if (tries++ < 30) setTimeout(focus, 16); return }
      const p = focusPoint ? editor.view.posAtCoords({ left: focusPoint.x, top: focusPoint.y }) : null
      editor.commands.focus(p ? p.pos : 'end')
    }
    setTimeout(focus, 0)
  }, [editor])
  return <div className="block-editor" onClick={e => e.stopPropagation()}><EditorContent editor={editor} /></div>
}
