#!/bin/zsh
# OCR for slate, without Homebrew and without Apple's developer tools. Two pip wheels into ~/.local/share/slate/venv:
#   PyMuPDF  — rasterises PDF pages (also used to detect a book spread's gutter)
#   pyobjc-framework-Vision / -Quartz — macOS's own OCR, which is as good as any cloud engine on a clean
#   scan and never leaves the Mac. See scripts/ocr-pdf.py and SPEC §20.57.
# On a Mac that has never installed the developer tools, /usr/bin/python3 is a shim that opens Apple's install dialog
# (server/devtools.js), so the venv is made by uv — the speech step of setup installs it — and the system Python is
# used only where the tools are really there.
set -e
SD="$HOME/.local/share/slate"
mkdir -p "$SD"
UV=""; for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do [ -x "$c" ] && UV="$c" && break; done
if [ -n "$UV" ]; then
  [ -x "$SD/venv/bin/python" ] || "$UV" venv --quiet --python 3.12 "$SD/venv"
  "$UV" pip install --quiet --python "$SD/venv/bin/python" PyMuPDF pyobjc-framework-Vision pyobjc-framework-Quartz
elif [ -x /Library/Developer/CommandLineTools/usr/bin/git ] || [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/git ]; then
  [ -d "$SD/venv" ] || python3 -m venv "$SD/venv"   # the real python3: the devtools are there
  "$SD/venv/bin/pip" install --quiet --disable-pip-version-check PyMuPDF pyobjc-framework-Vision pyobjc-framework-Quartz
else
  echo "uv is not installed and Apple's developer tools are absent. Run the speech step of setup (node scripts/setup.mjs speech), which installs uv, then this again." >&2
  exit 1
fi
"$SD/venv/bin/python" -c "import fitz, Vision, Quartz; print('ocr ready:', '$SD/venv/bin/python')"
