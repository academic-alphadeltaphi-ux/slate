# Slate for Alpha Delta Phi

A notebook for UofT courses. Every morning it checks Quercus, files what is new into a page per week and per course,
and says on the Home screen what is new and what is due. Claude does the filing, through your own Claude account.

## Install — one message to Claude

Open **Claude Code** (the *Code* tab of the Claude desktop app) in any folder and send it this, as it is:

```text
Install Slate for Alpha Delta Phi for me from https://github.com/academic-alphadeltaphi-ux/slate.
Work out whether this computer is a Mac or a Windows PC, and ask me whether my Claude plan is Pro or Max.
Check `node --version`: if Node.js is missing or older than 22.12, stop and ask me to install the LTS
version from nodejs.org (a normal installer), then check again before going on.
Download the matching zip from https://github.com/academic-alphadeltaphi-ux/slate/releases/latest/download/<name>, where <name> is
slate-adphi-pro-mac.zip, slate-adphi-max-mac.zip, slate-adphi-pro-windows.zip or slate-adphi-max-windows.zip.
Unzip it and move the Slate folder that is inside into my home folder (on a PC: %USERPROFILE%) —
not Documents, the Desktop, Downloads or OneDrive. If a folder named Slate is already there, stop and ask me
before touching it: it may hold my notes or an earlier copy.
Don't use git. When the folder is in place, tell me to open it in Claude Code and say "set me up".
```

Then open that `Slate` folder in Claude Code and say **set me up**: Claude does the rest in one conversation.

**Updating:** close the app, open the `Slate` folder in Claude Code and say *update Slate*. It fetches the newest
release from here and swaps it in, in the same folder: your notes, courses and settings stay as they are.

### Or by hand

Take the zip that matches your computer and your Claude plan from the **[latest release](../../releases/latest)**:

| | Claude **Pro** | Claude **Max** |
|---|---|---|
| **Mac** (Apple chip or Intel) | `slate-adphi-pro-mac.zip` | `slate-adphi-max-mac.zip` |
| **Windows** 10 or 11 | `slate-adphi-pro-windows.zip` | `slate-adphi-max-windows.zip` |

Unzip it and open **`Read me first.html`**. It walks you through the rest: you open the `Slate` folder in the Claude
desktop app and Claude sets everything up in one conversation. It asks for a key from Quercus and a screenshot of your
ACORN timetable — nothing to type in a terminal.

**Every morning** a scheduled task inside the Claude app checks Quercus, files what is new, and writes the day's to-dos,
each with a link to where it lives. It runs while the Claude app is open (it can sit in the background); a morning the app
was closed catches up when it next opens. *Pro or Max?* Since both run inside the
Claude app they are the same program: the check uses whichever model the app is set to, at 07:30 on the Pro copy and
07:00 on the Max one, and each copy's guide speaks of its plan.

## What leaves your computer

- Your notes are plain files in a folder on your own computer.
- Your Quercus key stays on your computer: in the Mac's keychain, or in a file only your Windows account can decrypt.
- The check reads Quercus, and the filing decisions go to Claude through **your** Claude account — nobody else's.
  Nothing is sent to whoever maintains this repository.
- On a Mac, recording a lecture into text and dictation run on the Mac itself. Windows copies leave both out.

## This repository

This is the code the zips are built from, one tree for both machines: `scripts/lib/platform.mjs` is the only place that
knows which one it runs on, and the Windows zip leaves out the Mac-only installers (and the other way round).
`SPEC.md` is the design, section by section — §21 is the part about these copies.

It is published from the maintainer's development repository, so a pull request here is read and carried over by hand;
an issue is the easier way to report something.
