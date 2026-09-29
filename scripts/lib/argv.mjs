// Argument checking for every script (SPEC §20.20).
//
// On 2026-09-09 an audit ran `node scripts/plan.mjs --help` on the assumption that an unrecognised flag is
// harmless. None of these scripts had an unknown-flag branch, so `--help` simply left every boolean false and the
// script did its full live write pass against the real notebook — including three one-off migrations that
// scaffolded 78 empty week folders at the wrong level. A mistyped `--dry-runn` would have done the same.
//
// So: an unknown flag is an error, not a no-op. `--help` prints usage and exits 0. And a migration that is only
// ever meant to be run once refuses to run at all without `--yes-migrate`, because the cost of running it by
// accident is much higher than the cost of typing eight more characters.
const argv = () => process.argv.slice(2)

export function guardFlags(known, usage = '') {
  const ok = new Set([...known, '--help', '-h'])
  const args = argv()
  if (args.some(a => a === '--help' || a === '-h')) { console.log(usage || `flags: ${[...known].join(' ')}`); process.exit(0) }
  const bad = args.filter(a => a.startsWith('-') && !ok.has(a) && !ok.has(a.split('=')[0]))
  if (bad.length) {
    console.error(`unknown flag: ${bad.join(' ')}`)
    if (usage) console.error(usage)
    else console.error(`known flags: ${[...known].join(' ')}`)
    console.error('nothing was written.')
    process.exit(2)
  }
}

// A one-off migration: destructive, already run, and not idempotent in the way the daily scripts are.
export function guardMigration(name, what) {
  if (!argv().includes('--yes-migrate')) {
    console.error(`${name} is a one-off migration: ${what}`)
    console.error('It has already been run. Running it again scaffolds folders in the wrong place.')
    console.error('If you really mean it: --yes-migrate')
    process.exit(2)
  }
}
