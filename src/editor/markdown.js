// Static rendering of a block's markdown through the same schema the editor uses, so the
// unfocused view and the editor line up pixel for pixel. SPEC.md §7.
import { Editor } from '@tiptap/core'
import katex from 'katex'

export function createRenderer(extensions) {
  const editor = new Editor({ element: document.createElement('div'), extensions, content: '', contentType: 'markdown', editable: false })
  const cache = new Map()
  return {
    html(md) {
      if (cache.has(md)) return cache.get(md)
      editor.commands.setContent(md || '', { contentType: 'markdown', emitUpdate: false })
      const html = editor.getHTML()
      if (cache.size > 500) cache.clear()
      cache.set(md, html)
      return html
    },
    destroy() { editor.destroy() },
  }
}

export function typesetMath(root) {
  root.querySelectorAll('[data-type="inline-math"], [data-type="block-math"]').forEach(n => {
    if (n.dataset.typeset) return
    const latex = n.getAttribute('data-latex') ?? n.textContent
    try { katex.render(latex, n, { throwOnError: false, displayMode: n.getAttribute('data-type') === 'block-math' }); n.dataset.typeset = '1' } catch { }
  })
}
