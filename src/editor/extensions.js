// TipTap extension set with the markdown overrides proven by spike/. SPEC.md §7 and spike/README.md.
import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import Highlight from '@tiptap/extension-highlight'
import Underline from '@tiptap/extension-underline'
import HardBreak from '@tiptap/extension-hard-break'
import Image from '@tiptap/extension-image'
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Mathematics } from '@tiptap/extension-mathematics'
import { Placeholder } from '@tiptap/extensions'

export const TextStyleMd = TextStyle.extend({
  renderMarkdown(node, h) {
    const a = node.attrs || {}
    const parts = []
    if (a.color) parts.push(`color: ${a.color}`)
    if (a.fontSize) parts.push(`font-size: ${a.fontSize}`)
    if (a.fontFamily) parts.push(`font-family: ${a.fontFamily}`)
    if (a.backgroundColor) parts.push(`background-color: ${a.backgroundColor}`)
    if (a.lineHeight) parts.push(`line-height: ${a.lineHeight}`)
    const inner = h.renderChildren(node)
    return parts.length ? `<span style="${parts.join('; ')}">${inner}</span>` : inner
  },
})
export const UnderlineMd = Underline.extend({ renderMarkdown: (node, h) => `<u>${h.renderChildren(node)}</u>` })
export const HardBreakMd = HardBreak.extend({ renderMarkdown: () => '\\\n' })

const encodeSrc = s => (s || '').replace(/ /g, '%20')
const decodeSrc = s => { try { return decodeURI(s || '') } catch { return s || '' } }
export const ImageMd = Image.extend({
  addOptions() { return { ...this.parent?.(), resolveSrc: s => s } },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: this.options.resolveSrc(HTMLAttributes.src) })]
  },
  parseMarkdown: token => ({ type: 'image', attrs: { src: decodeSrc(token.href), alt: token.text || null, title: token.title || null } }),
  renderMarkdown(node) {
    const a = node.attrs || {}
    const title = a.title ? ` "${a.title.replace(/"/g, '\\"')}"` : ''
    return `![${a.alt || ''}](${encodeSrc(a.src)}${title})`
  },
})

export const WikiLink = Node.create({
  name: 'wikiLink', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() { return { target: { default: '' }, alias: { default: null } } },
  parseHTML() { return [{ tag: 'a[data-wikilink]', getAttrs: el => ({ target: el.getAttribute('data-wikilink'), alias: el.getAttribute('data-alias') }) }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { 'data-wikilink': node.attrs.target, 'data-alias': node.attrs.alias, class: 'wikilink', href: '#' }), node.attrs.alias || node.attrs.target]
  },
  markdownTokenizer: {
    name: 'wikiLink', level: 'inline', start: src => src.indexOf('[['),
    tokenize(src) {
      const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src)
      if (!m) return
      return { type: 'wikiLink', raw: m[0], target: m[1].trim(), alias: m[2] ? m[2].trim() : null }
    },
  },
  parseMarkdown: token => ({ type: 'wikiLink', attrs: { target: token.target, alias: token.alias } }),
  renderMarkdown: node => (node.attrs.alias ? `[[${node.attrs.target}|${node.attrs.alias}]]` : `[[${node.attrs.target}]]`),
})

// ---- minimal escaper (replaces the stock one, which HTML-encodes and over-escapes) ----------
const isWord = ch => /[\p{L}\p{N}]/u.test(ch || '')
const isSpace = ch => ch === undefined || /\s/.test(ch)
function escapeInline(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], prev = text[i - 1], next = text[i + 1]
    if (ch === '\\' || ch === '`' || ch === '~' || ch === '$') { out += '\\' + ch; continue }   // $ would become math on re-parse
    if (ch === '*' && !(isSpace(prev) && isSpace(next))) { out += '\\*'; continue }
    if (ch === '_' && !(isWord(prev) && isWord(next))) { out += '\\_'; continue }
    if (ch === '<' && /[A-Za-z\/!?]/.test(next || '')) { out += '\\<'; continue }
    if (ch === '&' && /^&[A-Za-z][A-Za-z0-9]*;|^&#\d+;|^&#x[0-9a-fA-F]+;/.test(text.slice(i))) { out += '\\&'; continue }
    out += ch
  }
  return out.replace(/(!?)\[([^\]\n]*)\](?=[\(\[])/g, (m, bang, inner) => `${bang ? '\\!' : ''}\\[${inner}]`)
}
const escapeLineStart = t => t
  .replace(/^(#{1,6})(?=\s|$)/, m => '\\' + m).replace(/^>/, '\\>').replace(/^([-+*])(?=\s)/, '\\$1')
  .replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2').replace(/^([-*_])\1{2,}\s*$/, m => '\\' + m)
MarkdownManager.prototype.encodeTextForMarkdown = function (text, node, parentNode) {
  const inCode = (parentNode?.type != null && this.codeTypes.has(parentNode.type)) || (node.marks || []).some(m => this.codeTypes.has(typeof m === 'string' ? m : m.type))
  if (inCode) return text
  let out = escapeInline(text)
  const siblings = parentNode?.content || []
  const idx = siblings.indexOf(node)
  if (parentNode?.type === 'paragraph' && (idx <= 0 || siblings[idx - 1]?.type === 'hardBreak')) out = escapeLineStart(out)
  return out
}

export const FONTS = [
  { label: 'System', value: null },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: '"SF Mono", Menlo, monospace' },
  { label: 'Rounded', value: '"SF Pro Rounded", "Arial Rounded MT Bold", sans-serif' },
  { label: 'Handwriting', value: '"Bradley Hand", "Noteworthy", cursive' },
  { label: 'Condensed', value: '"Avenir Next Condensed", "Arial Narrow", sans-serif' },
]
export const SIZES = [10, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48]
// The academic palette (src/palette.js, SPEC §20.60): oxblood, navy, forest, ochre, plum, mulberry, bronze, teal, slate.
export const COLORS = ['#7a2e2b', '#2c3e6b', '#2f5d45', '#9a7420', '#5b3a6e', '#8b3a5a', '#8a5a2b', '#2e5f66', '#4d5a66']

export function buildExtensions({ resolveSrc = s => s, placeholder = '' } = {}) {
  return [
    StarterKit.configure({ underline: false, hardBreak: false, link: { openOnClick: false, autolink: true } }),
    UnderlineMd, HardBreakMd, WikiLink,
    Highlight, TextStyleMd, Color, FontFamily, FontSize,
    ImageMd.configure({ resolveSrc, allowBase64: false }),
    TaskList, TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Mathematics.configure({ katexOptions: { throwOnError: false } }),
    Placeholder.configure({ placeholder }),
    Markdown,
  ]
}
