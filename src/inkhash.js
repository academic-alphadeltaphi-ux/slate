// The one staleness hash for recognised handwriting (SPEC §20.9), imported by the client and by server/hwr.js
// so the two can never disagree. FNV-1a 32-bit over the stroke ids of an ink element: ids survive a lasso
// move, resize or recolour and change on a new stroke or an erase (partial erases give the pieces new ids),
// so the hash says "the writing changed" and nothing else.
export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
export const inkHashOf = el => fnv1a((el?.strokes || []).map(s => s.id).join(','))
// `text` present (possibly "") means the element has been recognised.
export const hasText = el => typeof el?.text === 'string'
export const isStale = el => hasText(el) && el.inkHash !== inkHashOf(el)
