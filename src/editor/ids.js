export function newId() {
  let s = ''
  while (s.length < 6) s += Math.floor(Math.random() * 36).toString(36)
  return s
}
