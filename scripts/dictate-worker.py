#!/usr/bin/env -S uv run --quiet --with parakeet-mlx --python 3.12 python
"""The live-dictation worker (SPEC §20.29).

The browser's speech recogniser is Google's, over the network, and Chromium builds that are not Chrome — Electron,
the app's own shell — ship without the key for it, so it fails with `network` however good the connection is. slate
already transcribes lectures locally with parakeet-mlx on the M-series GPU; dictation uses the same engine.

The CLI loads the model on every invocation, which is ~3 s — fine for an hour of lecture, useless for a phrase. This
holds the model in memory and answers one clip at a time:

    stdin   one absolute audio path per line
    stdout  one JSON line per clip: {"ok": true, "text": "..."} or {"ok": false, "error": "..."}

`ready` is printed once the model is loaded, before the first clip is read, so the server can tell "still warming
up" from "broken".
"""
import json
import sys


def main() -> int:
    try:
        from parakeet_mlx import from_pretrained
    except Exception as e:  # noqa: BLE001 — the message is the whole point
        print(json.dumps({"ok": False, "fatal": True, "error": f"parakeet-mlx is not installed: {e}"}), flush=True)
        return 1

    model_id = sys.argv[1] if len(sys.argv) > 1 else "mlx-community/parakeet-tdt-0.6b-v3"
    try:
        model = from_pretrained(model_id)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "fatal": True, "error": f"could not load {model_id}: {e}"}), flush=True)
        return 1
    print(json.dumps({"ready": True, "model": model_id}), flush=True)

    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            result = model.transcribe(path)
            text = getattr(result, "text", "") or ""
            print(json.dumps({"ok": True, "text": text.strip()}), flush=True)
        except Exception as e:  # noqa: BLE001 — one bad clip must not end the session
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
