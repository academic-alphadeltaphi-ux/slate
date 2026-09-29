// Document kinds and highlight meanings. Stored in files: `kind:` in page frontmatter,
// `highlights` in the root _slate.json, `label` on every annotation. `icon` names a line icon in
// Icons.jsx — no emoji anywhere in the chrome; the set has to read as one family.
export const KINDS = [
  { key: 'lecture', icon: 'board', label: 'Lecture' },
  { key: 'reading', icon: 'bookOpen', label: 'Reading' },
  { key: 'syllabus', icon: 'clipboard', label: 'Syllabus' },
  { key: 'problem-set', icon: 'pencil', label: 'Problem set' },
  { key: 'exam', icon: 'checklist', label: 'Exam' },
  { key: 'summary', icon: 'bookmark', label: 'Summary' },
  { key: 'notes', icon: 'notes', label: 'Notes' },
  { key: 'admin', icon: 'bank', label: 'Admin' },
  { key: 'other', icon: 'file', label: 'Other' },
]
export const kindIcon = k => KINDS.find(x => x.key === k)?.icon || null
export const kindLabel = k => KINDS.find(x => x.key === k)?.label || k
export const DEFAULT_HIGHLIGHTS = [
  { color: '#ffd60a', label: 'key point' },
  { color: '#34c759', label: 'exam' },
  { color: '#5ac8fa', label: 'definition' },
  { color: '#ff9f0a', label: 'question' },
  { color: '#ff375f', label: 'todo' },
  { color: '#bf5af2', label: 'reference' },
]
