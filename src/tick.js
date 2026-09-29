import { api } from './api.js'
import { findProblemsBlock, withRowState } from './problems.js'

// Set one Problems row's two boxes — attempted, and its nested reviewed — from a screen (SPEC §20.32). Same discipline as
// toggleMdTask below: read, rewrite the one row, write with the base hash, one retry on a stale hash. Returns false when
// the row is no longer on the page.
export async function setProblemRow(page, key, state) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await api.page(page)
    const bi = findProblemsBlock(p.blocks)
    if (bi < 0) return false
    const md = withRowState(p.blocks[bi].md, key, state)
    if (md === null) return false
    try { await api.savePage(page, p.blocks.map((b, k) => ({ id: b.id, md: k === bi ? md : b.md })), p.hash); return true }
    catch (e) { if (e.status !== 409 || attempt) throw e }
  }
  return false
}

// Tick a checkbox from a screen (SPEC §20.13). The page on disk is the truth: read it, flip the one line that stands
// exactly as `raw` stood when it was drawn, write it back through PUT /api/page with the base hash, one retry on a
// stale hash — the same path the editor and What's next already use, so nothing else in the file is touched and a
// concurrent write never loses. Two identical lines in one page flip the first; that is the only ambiguity.
// Returns true when the page changed, false when the line is gone. `to` (true|false) sets the box instead of flipping it:
// true, with nothing written, when it already stands so.
const BOX = /^(\s*(?:[-*+]|\d+[.)]) \[)([ xX])(\].*)$/
export async function toggleMdTask(page, raw, to = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await api.page(page)
    let bi = -1, li = -1
    for (let i = 0; i < p.blocks.length && bi < 0; i++) {
      const j = p.blocks[i].md.split('\n').indexOf(raw)
      if (j >= 0) { bi = i; li = j }
    }
    if (bi < 0) return false
    const lines = p.blocks[bi].md.split('\n'), m = BOX.exec(lines[li])
    if (!m) return false
    if (to !== null && (m[2] !== ' ') === !!to) return true
    lines[li] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3]
    try { await api.savePage(page, p.blocks.map((b, k) => ({ id: b.id, md: k === bi ? lines.join('\n') : b.md })), p.hash); return true }
    catch (e) { if (e.status !== 409 || attempt) throw e }
  }
  return false
}
