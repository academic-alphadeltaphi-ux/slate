// Which edition this server is (SPEC §21): the build's default, unless the notes root's settings say otherwise.
// Read once at boot; every server module that must know asks here rather than parsing Hub/_settings.json itself.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './fs.js'
import { editionOf, DEFAULT_EDITION, EDITIONS, has } from '../src/edition.js'

const settings = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'Hub', '_settings.json'), 'utf8')) || {} } catch { return {} } })()
export const EDITION = settings.edition ? editionOf(settings.edition).key : DEFAULT_EDITION
export const ED = EDITIONS[EDITION]
export const enabled = feature => has(EDITION, feature)
// The Claude budget for this install: the edition's, unless the settings pin one (`"budget": "light" | "heavy"`).
export const BUDGET = settings.budget === 'light' || settings.budget === 'heavy' ? settings.budget : ED.budget || 'heavy'
// How often the scheduled morning runs, in days: always the edition's — every plan checks every day (2026-10-12), so an
// install set up when the Pro copy ran every 2 days does not keep that in its settings. Home counts "days behind" from it.
export const CADENCE_DAYS = ED.cadenceDays || 1
// Who decides in the morning (SPEC §21.8): 'app' — a scheduled task in the Claude app; 'cli' — claude -p sessions.
export const RUNNER = settings.runner || ED.runner || 'cli'
