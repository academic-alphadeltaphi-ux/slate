// What Hub/_courses.json may say (SPEC §21). check(doc) → a list of problems in plain words, empty when the file is good.
// Their Claude writes this JSON; the code it becomes is rendered by scripts/courses.mjs, so a mistake here is caught
// by a sentence and never by the app failing to boot.
const ISO = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^([01]\d|2[0-3]):[0-5]\d$/, HEX = /^#[0-9a-f]{6}$/i
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], KINDS = ['Lecture', 'Tutorial', 'Lab', 'Practical', 'Seminar']
const KEY = /^[A-Z]{3} \d{3}[A-Z]\d$/, CODE = /^[A-Z]{3}\d{3}$/

export function check(doc) {
  const p = []
  const bad = (where, what) => p.push(`${where}: ${what}`)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['the file must hold one JSON object']
  const cal = doc.calendar
  if (cal !== undefined) {
    if (typeof cal !== 'object') bad('calendar', 'must be an object with fall, winter and noClass')
    else {
      for (const t of ['fall', 'winter']) {
        const term = cal[t]; if (!term) { bad(`calendar.${t}`, 'is missing'); continue }
        for (const k of ['name', 'start', 'end']) if (typeof term[k] !== 'string' || !term[k]) bad(`calendar.${t}.${k}`, 'is missing')
        for (const k of ['start', 'end']) if (term[k] && !ISO.test(term[k])) bad(`calendar.${t}.${k}`, 'must be YYYY-MM-DD')
        if (term.reading !== undefined && (!Array.isArray(term.reading) || term.reading.some(d => !ISO.test(d)))) bad(`calendar.${t}.reading`, 'must be a list of Mondays as YYYY-MM-DD')
      }
      if (cal.noClass !== undefined && (!Array.isArray(cal.noClass) || cal.noClass.some(d => !ISO.test(d)))) bad('calendar.noClass', 'must be a list of dates as YYYY-MM-DD')
    }
  }
  const courses = doc.courses
  if (!courses || typeof courses !== 'object' || Array.isArray(courses)) return [...p, 'courses: must be an object keyed by course code, e.g. "ECO 100Y1"']
  if (!Object.keys(courses).length) bad('courses', 'must hold at least one course')
  const ids = new Map(), codes = new Map()
  for (const [key, c] of Object.entries(courses)) {
    const at = `courses["${key}"]`
    if (!KEY.test(key)) bad(at, 'the key must be the code as ACORN prints it: three letters, a space, three digits, H1 or Y1 (e.g. "ECO 100Y1")')
    if (!c || typeof c !== 'object') { bad(at, 'must be an object'); continue }
    if (!Number.isInteger(c.id) || c.id <= 0) bad(`${at}.id`, 'must be the course\'s Quercus number (the id in its URL)')
    else if (ids.has(c.id)) bad(`${at}.id`, `is also used by ${ids.get(c.id)}`); else ids.set(c.id, key)
    if (typeof c.code !== 'string' || !CODE.test(c.code)) bad(`${at}.code`, 'must be the short code without a space, e.g. "ECO100"')
    else if (key.replace(' ', '').slice(0, 6) !== c.code) bad(`${at}.code`, `does not match the key "${key}"`)
    else if (codes.has(c.code)) bad(`${at}.code`, `is also used by ${codes.get(c.code)}`); else codes.set(c.code, key)
    if (typeof c.name !== 'string' || !c.name.trim()) bad(`${at}.name`, 'is missing')
    if (!['F', 'S', 'Y'].includes(c.term)) bad(`${at}.term`, 'must be "F" (fall), "S" (winter) or "Y" (both terms)')
    if (typeof c.color !== 'string' || !HEX.test(c.color)) bad(`${at}.color`, 'must be a hex colour like "#2c3e6b"')
    if (c.url !== undefined && !/^https:\/\/q\.utoronto\.ca\/courses\/\d+/.test(String(c.url))) bad(`${at}.url`, 'must be the course\'s Quercus address, https://q.utoronto.ca/courses/<id>')
    if (c.url && Number.isInteger(c.id) && !String(c.url).endsWith('/' + c.id)) bad(`${at}.url`, `does not end with the id ${c.id}`)
    for (const k of ['professor', 'textbook', 'meets']) if (c[k] !== undefined && typeof c[k] !== 'string') bad(`${at}.${k}`, 'must be text')
    if (!Array.isArray(c.meetings)) bad(`${at}.meetings`, 'must be a list — an empty one for an online course with no class times')
    else c.meetings.forEach((m, i) => {
      const w = `${at}.meetings[${i}]`
      if (!DAYS.includes(m?.day)) bad(`${w}.day`, `must be one of ${DAYS.join(', ')}`)
      for (const k of ['start', 'end']) if (!HHMM.test(m?.[k] || '')) bad(`${w}.${k}`, 'must be a 24-hour time like "13:00"')
      if (m?.start && m?.end && m.start >= m.end) bad(w, 'ends before it starts')
      if (!KINDS.includes(m?.kind)) bad(`${w}.kind`, `must be one of ${KINDS.join(', ')}`)
      if (m?.where !== undefined && typeof m.where !== 'string') bad(`${w}.where`, 'must be text (the room)')
    })
    if (c.tutorialLag !== undefined && c.tutorialLag !== 1) bad(`${at}.tutorialLag`, 'is either 1 (the tutorial works through the previous week\'s lecture) or left out')
    if (c.tests !== undefined) {
      if (!Array.isArray(c.tests)) bad(`${at}.tests`, 'must be a list of { date, label }')
      else c.tests.forEach((t, i) => { if (!ISO.test(t?.date || '')) bad(`${at}.tests[${i}].date`, 'must be YYYY-MM-DD'); if (typeof t?.label !== 'string' || !t.label) bad(`${at}.tests[${i}].label`, 'is missing') })
    }
    if (c.weekly !== undefined) {
      if (!Array.isArray(c.weekly)) bad(`${at}.weekly`, 'must be a list')
      else c.weekly.forEach((w, i) => {
        const x = `${at}.weekly[${i}]`
        if (!Number.isInteger(w?.from) || w.from < 1) bad(`${x}.from`, 'must be the first week number it applies from')
        for (const k of ['kind', 'match', 'text']) if (typeof w?.[k] !== 'string' || !w[k]) bad(`${x}.${k}`, 'is missing')
        if (!DAYS.includes(w?.day)) bad(`${x}.day`, `must be one of ${DAYS.join(', ')}`)
        if (!HHMM.test(w?.time || '')) bad(`${x}.time`, 'must be a 24-hour time like "23:59"')
      })
    }
    if (c.grading !== undefined) {
      const g = c.grading
      if (!g || !Array.isArray(g.components) || !Array.isArray(g.schemes)) bad(`${at}.grading`, 'must have components (a list) and schemes (a list)')
      else {
        const keys = new Set()
        g.components.forEach((comp, i) => {
          const x = `${at}.grading.components[${i}]`
          if (typeof comp?.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(comp.key)) bad(`${x}.key`, 'must be a short lowercase word like "tests"')
          else if (keys.has(comp.key)) bad(`${x}.key`, 'is used twice'); else keys.add(comp.key)
          if (typeof comp?.label !== 'string' || !comp.label) bad(`${x}.label`, 'is missing')
          if (typeof comp?.match !== 'string' || !comp.match) bad(`${x}.match`, 'must be the pattern that recognises this component in a Quercus grade name, e.g. "\\\\btest\\\\s*([12])\\\\b"')
          else { try { new RegExp(comp.match, 'i') } catch (e) { bad(`${x}.match`, `is not a valid pattern (${e.message})`) } }
          if (comp?.items !== undefined) {
            if (!Array.isArray(comp.items)) bad(`${x}.items`, 'must be a list')
            else comp.items.forEach((it, j) => { const y = `${x}.items[${j}]`; if (typeof it?.key !== 'string' || !it.key) bad(`${y}.key`, 'is missing'); if (typeof it?.label !== 'string' || !it.label) bad(`${y}.label`, 'is missing'); if (it?.date !== undefined && !ISO.test(it.date)) bad(`${y}.date`, 'must be YYYY-MM-DD') })
          }
          for (const k of ['dropLowestFraction', 'bonus']) if (comp?.[k] !== undefined && !(typeof comp[k] === 'number' && comp[k] >= 0 && comp[k] < 1)) bad(`${x}.${k}`, 'must be a fraction between 0 and 1')
          for (const k of ['many', 'assumed']) if (comp?.[k] !== undefined && typeof comp[k] !== 'boolean') bad(`${x}.${k}`, 'must be true or false')
        })
        g.schemes.forEach((s, i) => {
          const x = `${at}.grading.schemes[${i}]`
          if (typeof s?.name !== 'string' || !s.name) bad(`${x}.name`, 'is missing')
          if (!s?.weights || typeof s.weights !== 'object') { bad(`${x}.weights`, 'must map component keys to percentages'); return }
          let sum = 0
          for (const [k, v] of Object.entries(s.weights)) { if (!keys.has(k)) bad(`${x}.weights.${k}`, 'is not a component key'); if (typeof v !== 'number' || v < 0) bad(`${x}.weights.${k}`, 'must be a number'); else sum += v }
          if (Math.round(sum) !== 100) bad(`${x}.weights`, `add up to ${sum}, not 100`)
          if (s.best !== undefined) for (const [k, v] of Object.entries(s.best)) { if (!keys.has(k)) bad(`${x}.best.${k}`, 'is not a component key'); if (!Number.isInteger(v) || v < 1) bad(`${x}.best.${k}`, 'must be a count') }
        })
      }
    }
    if (c.mirror !== undefined && typeof c.mirror !== 'boolean') bad(`${at}.mirror`, 'must be true or false')
  }
  if (doc.syllabus !== undefined) {
    if (typeof doc.syllabus !== 'object' || Array.isArray(doc.syllabus)) bad('syllabus', 'must be an object keyed by course')
    else for (const [key, s] of Object.entries(doc.syllabus)) {
      if (!courses[key]) bad(`syllabus["${key}"]`, 'is not one of the courses')
      if (!s || typeof s.weeks !== 'object') { bad(`syllabus["${key}"].weeks`, 'must be an object keyed by week number'); continue }
      for (const [n, w] of Object.entries(s.weeks)) { if (!/^\d{1,2}$/.test(n)) bad(`syllabus["${key}"].weeks.${n}`, 'keys are week numbers'); if (!w || typeof w.topic !== 'string') bad(`syllabus["${key}"].weeks.${n}.topic`, 'is missing') }
    }
  }
  return p
}
