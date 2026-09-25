#!/bin/sh
# Stops every running .NET Aspire AppHost whose project lives inside this
# checkout. Never passes --force: that also deletes persistent volumes.
set -u

aspire="${ASPIRE_BIN:-}"
[ -n "$aspire" ] || aspire="$(command -v aspire 2>/dev/null || true)"
[ -n "$aspire" ] || { [ -x "$HOME/.aspire/bin/aspire" ] && aspire="$HOME/.aspire/bin/aspire"; }
[ -n "$aspire" ] || { echo "aspire is not installed; nothing to stop"; exit 0; }

# `aspire ps` can print a notice before the JSON; parse from the first [.
paths="$("$aspire" ps --format Json --nologo --non-interactive 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const i = s.indexOf("[");
    const list = i < 0 ? [] : JSON.parse(s.slice(i));
    const root = process.env.HERDR_GC_WORKTREE.replace(/\/$/, "") + "/";
    for (const a of list) if (a.appHostPath && a.appHostPath.startsWith(root)) console.log(a.appHostPath);
  });
')" || { echo "aspire ps failed"; exit 1; }

[ -n "$paths" ] || { echo "no AppHost runs from this checkout"; exit 0; }
# A here-document, not a pipe: a pipe would run the loop in a subshell and
# lose `status`.
status=0
while IFS= read -r p; do
  echo "stopping $p"
  "$aspire" stop --apphost "$p" --nologo --non-interactive || status=1
done <<EOF
$paths
EOF
exit $status
