#!/bin/sh
# Classifier for close and sweep: prints {"verdict": "reclaim" | "keep",
# "reason": "..."}.
#
# reclaim needs every one of these to hold:
#   - the checkout is a linked worktree on a branch;
#   - it has no uncommitted or untracked (non-ignored) files;
#   - GitHub (`gh`) has a merged pull request for the branch;
#   - no commit on HEAD is newer than the merge;
#   - when `activity-since` exists next to this script, it reports no
#     activity in the checkout after the merge.
# A missing tool, a failed call or unknown data answers keep: the classifier
# never guesses in favor of deletion.
set -u

say() {
  node -e 'console.log(JSON.stringify({ verdict: process.argv[1], reason: process.argv[2] }))' "$1" "$2"
  exit 0
}

[ "${HERDR_GC_LINKED:-0}" = 1 ] || say keep "the main checkout"
branch="${HERDR_GC_BRANCH:-}"
[ -n "$branch" ] || branch="$(git branch --show-current 2>/dev/null)"
[ -n "$branch" ] || say keep "detached HEAD"

dirty="$(git status --porcelain --untracked-files=normal 2>/dev/null)" || say keep "git status failed"
[ -z "$dirty" ] || say keep "uncommitted or untracked files"

command -v gh >/dev/null 2>&1 || say keep "gh is not installed"
pr="$(gh pr list --head "$branch" --state merged --limit 1 \
  --json number,mergedAt --jq '.[0] | select(.) | "\(.number) \(.mergedAt)"' 2>/dev/null)" \
  || say keep "gh could not list pull requests"
[ -n "$pr" ] || say keep "no merged pull request for $branch"
number="${pr%% *}"
merged_iso="${pr#* }"
merged="$(node -e 'const t = Date.parse(process.argv[1]); if (!t) process.exit(1); console.log(Math.floor(t / 1000))' "$merged_iso")" \
  || say keep "cannot read the merge time"

head_time="$(git log -1 --format=%ct HEAD 2>/dev/null)" || say keep "git log failed"
[ "$head_time" -le "$merged" ] || say keep "a commit is newer than the merge of #$number"

hook="${HERDR_GC_DIR:-.}/activity-since"
if [ -x "$hook" ]; then
  activity="$("$hook" "$merged" 2>/dev/null)" || say keep "activity-since failed"
  case "$activity" in
    idle) ;;
    active*) say keep "${activity#active }" ;;
    *) say keep "activity-since printed neither idle nor active" ;;
  esac
fi

say reclaim "PR #$number merged $merged_iso"
