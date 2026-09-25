#!/usr/bin/env bash
# Re-record docs/hud.gif from docs/demo/hud.tape.
#
#   bash docs/demo/record.sh
#
# Needs vhs (which brings ttyd and ffmpeg), gifsicle, git and node. The tape
# runs in a demo world under /tmp/herdr-gc-demo with fake gh, yarn, aspire and
# herdr binaries (see env.sh), so it needs no herdr and no network.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

for bin in vhs gifsicle node git; do
  command -v "$bin" >/dev/null || {
    echo "record.sh needs $bin: brew install vhs gifsicle node git" >&2
    exit 1
  }
done

# Run from a herdr pane, the shell carries that server's socket and ids. The
# tape must not inherit them.
while IFS= read -r var; do
  unset "$var"
done < <(compgen -e | grep '^HERDR_' || true)

gif=docs/hud.gif
echo "recording docs/demo/hud.tape"
vhs docs/demo/hud.tape

# vhs writes a 256-colour GIF a frame at a time. A terminal recording is
# almost all repeated pixels, so -O3 with a light lossy budget typically
# halves the file with no visible change at README scale.
before=$(wc -c <"$gif")
gifsicle -O3 --lossy=40 --batch "$gif"
after=$(wc -c <"$gif")
printf '%s  %sK -> %sK\n' "$gif" "$((before / 1024))" "$((after / 1024))"
