# Sourced by boot.tape before the recording starts, or by hand to try the HUD.
# Builds a fictional world under /tmp/herdr-gc-demo and points herdr-gc at it:
#
#   ~/wts/shop/     main plus five linked worktrees, and the reclaim-merged
#                   example as ~/wts/shop/.herdr-gc (trusted)
#   ~/wts/billing/  main plus one worktree, and a new .herdr-gc that installs
#                   on open (not trusted)
#
# Then it runs the events a day of work would have run, so the HUD opens on
# real runs and suggestions. The steps call fake gh, yarn, aspire and herdr
# binaries from docs/demo/bin. HOME points under /tmp/herdr-gc-demo too, so
# nothing reaches the real ~/.config/herdr, the plugin's real state, or GitHub.
#
# shellcheck shell=bash

DEMO=/tmp/herdr-gc-demo
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Run from a herdr pane, the shell carries that server's socket and ids.
while IFS= read -r var; do
  unset "$var"
done < <(compgen -e | grep '^HERDR_' || true)

export PS1='$ '
export PROMPT_COMMAND=
export HISTFILE=/dev/null

rm -rf "$DEMO"
mkdir -p "$DEMO/home" "$DEMO/state" "$DEMO/plugin-state" "$DEMO/plugin-config"
DEMO="$(cd "$DEMO" && pwd -P)" # /private/tmp on macOS, as git prints it

export HOME="$DEMO/home"
export PATH="$REPO/docs/demo/bin:$REPO/bin:$PATH"
export DEMO_STATE="$DEMO/state"
export DEMO_WTS="$HOME/wts"
export HERDR_BIN_PATH="$REPO/docs/demo/bin/herdr"
export HERDR_PLUGIN_STATE_DIR="$DEMO/plugin-state"
export HERDR_PLUGIN_CONFIG_DIR="$DEMO/plugin-config"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# git with a fixed author and date. `at <date> git ...` dates one commit.
g() { git -c user.name=demo -c user.email=demo@example.invalid -c init.defaultBranch=main "$@"; }
at() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" "${@:2}"; }

# A repo at ~/wts/<name>/main with a lockfile and <Project>.AppHost.csproj.
new_repo() {
  local main="$DEMO_WTS/$1/main"
  mkdir -p "$main/src/AppHost"
  : >"$main/yarn.lock"
  : >"$main/src/AppHost/$2.AppHost.csproj"
  g -C "$main" init -q
  g -C "$main" add -A
  at 2026-01-05T10:00:00Z g -C "$main" commit -q -m "initial"
}

# A linked worktree ~/wts/<repo>/<branch> with one commit at <date>.
new_worktree() {
  local main="$DEMO_WTS/$1/main" path="$DEMO_WTS/$1/$2"
  g -C "$main" worktree add -q -b "$2" "$path"
  at "$3" g -C "$path" commit -q --allow-empty -m "$2"
}

new_repo shop Shop
new_worktree shop feat-checkout 2026-01-10T15:00:00Z # PR #412 merged after it
new_worktree shop docs-refresh 2026-01-07T11:00:00Z  # PR #409 merged after it
new_worktree shop fix-cart 2026-01-14T09:00:00Z      # no merged PR
new_worktree shop spike-cache 2026-01-06T17:00:00Z   # uncommitted work
new_worktree shop feat-search 2026-01-15T08:00:00Z
echo "an idea" >"$DEMO_WTS/shop/spike-cache/NOTES.md"
cp -R "$REPO/examples/reclaim-merged/.herdr-gc" "$DEMO_WTS/shop/.herdr-gc"

new_repo billing Billing
new_worktree billing feat-invoices 2026-01-15T10:00:00Z
mkdir "$DEMO_WTS/billing/.herdr-gc"
printf '%s\n' 'version = 1' '' '[[step]]' 'name = "install"' \
  'on = ["create", "open"]' 'run = "yarn install"' >"$DEMO_WTS/billing/.herdr-gc/config.toml"

# The day so far, oldest first. The HUD lists the newest first.
herdr-gc trust "$DEMO_WTS/shop/.herdr-gc" >/dev/null
DEMO_YARN_DELAY=0
export DEMO_YARN_DELAY
for e in "close fix-cart" "close spike-cache" "open ../billing/feat-invoices" \
  "close docs-refresh" "create feat-search" "close feat-checkout"; do
  herdr-gc run "${e%% *}" "$DEMO_WTS/shop/${e#* }" >/dev/null 2>&1
done
unset DEMO_YARN_DELAY
unset -f g at new_repo new_worktree

cd "$REPO" || return 1
clear 2>/dev/null || true
