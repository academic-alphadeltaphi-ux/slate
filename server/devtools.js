// Apple's developer tools, asked about without waking them (SPEC §21).
//
// On a Mac that has never had the Command Line Tools installed, /usr/bin/git, /usr/bin/python3, xcrun and swiftc are
// not those programs: each is a shim that opens a system dialog offering to install "the command line developer tools",
// and then fails. Run from a background server that is a dialog nobody asked for, on the first launch of an app that
// never needed git. So nothing in slate runs one of those without asking here first — and this asks the file system,
// never a shim, because `xcrun --find` is itself one of them.
//
// SLATE_DEVTOOLS=0 pretends they are absent (the brother simulation asserts the app never wakes them); =1 pretends
// they are present.
import fs from 'node:fs'
import { WIN } from '../scripts/lib/platform.mjs'

export const DEVTOOLS_GIT = ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git']
// On Windows there is no dialog and nothing the Swift helper could be built with: "absent" keeps every Mac-only path shut.
export const hasDevTools = () => WIN ? false : process.env.SLATE_DEVTOOLS === '0' ? false : process.env.SLATE_DEVTOOLS === '1' ? true : DEVTOOLS_GIT.some(p => fs.existsSync(p))
