#!/bin/zsh
# ffmpeg for slate, without Homebrew and without Apple's developer tools. Used by scripts/lib/mymedia.mjs to remux
# MyMedia's HLS segments into mp4. With uv (the speech step of setup installs it) the `static-ffmpeg` tool brings a
# static binary that mymedia.mjs finds on its own; without uv, and only where the developer tools exist, a throwaway
# venv gets the `imageio-ffmpeg` wheel. On a Mac without the tools /usr/bin/python3 is a shim that opens Apple's
# install dialog (server/devtools.js), so it is never called there.
set -e
SD="$HOME/.local/share/slate"
mkdir -p "$SD"
if [ -x "$SD/ffmpeg" ]; then echo "already installed: $SD/ffmpeg"; "$SD/ffmpeg" -version | head -1; exit 0; fi
UV=""; for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do [ -x "$c" ] && UV="$c" && break; done
if [ -n "$UV" ]; then
  "$UV" tool install --quiet static-ffmpeg
  # The wheel carries no ffmpeg: its commands download the binaries the first time one of them runs, and installing runs
  # none — so on a fresh Mac nothing was ever there to find. Run one, once; it prints where the binary landed.
  P="$HOME/.local/bin/static_ffmpeg_paths"; [ -x "$P" ] || P="$("$UV" tool dir --bin)/static_ffmpeg_paths"
  FF="$("$P" | sed -n 's/^FFMPEG=//p')"
  [ -n "$FF" ] && [ -x "$FF" ] || { echo "static-ffmpeg could not download ffmpeg (see above). Check the wifi and run this again." >&2; exit 1; }
  echo "installed: $FF"; "$FF" -version | head -1
elif [ -x /Library/Developer/CommandLineTools/usr/bin/git ] || [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/git ]; then
  python3 -m venv "$SD/venv"   # the real python3: the devtools are there
  "$SD/venv/bin/pip" install --quiet --disable-pip-version-check imageio-ffmpeg
  ln -sf "$("$SD/venv/bin/python" -c 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())')" "$SD/ffmpeg"
  echo "installed: $SD/ffmpeg"; "$SD/ffmpeg" -version | head -1
else
  echo "uv is not installed and Apple's developer tools are absent. Run the speech step of setup (node scripts/setup.mjs speech), which installs uv, then this again." >&2
  exit 1
fi
