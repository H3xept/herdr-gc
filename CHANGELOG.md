# Changelog

All notable changes appear in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `x` in the HUD runs any step of the selected worktree's config, without its
  classifier. When a herdr workspace has the checkout open, the prompt names
  it, and `y` closes the workspace first. The step then runs after the close
  steps. If herdr cannot say which workspaces are open, nothing runs.
- `run-step --close` closes every herdr workspace on the checkout and waits for
  their close runs before the step runs. `run-step --detach` returns at once.
- Install from GitHub with `herdr plugin install H3xept/herdr-gc`. The README
  says what the install preview shows and how to pin a revision.
- A README banner GIF of the HUD, and `docs/demo/`, which records it again
  in a fictional world with no herdr and no network.

### Fixed

- `remove` drops the pending `close` and `sweep` suggestions of the gone
  checkout. Before, a checkout deleted by `run-step` or by hand kept its old
  `delete checkout` suggestion in the HUD.

## [0.1.0] - 2026-09-25

First public release. The plugin id is `h3xept.herdr-gc`.

### Added

- Lifecycle events `create`, `open`, `close` and `remove` from herdr's
  `worktree.created`, `worktree.opened`, `workspace.closed` and
  `worktree.removed`, and the on-demand `sweep`.
- `.herdr-gc/config.toml` with `[[step]]` and `[[classifier]]` entries. The
  nearest folder in the checkout or a parent directory applies, then the repo
  root's.
- Step modes `auto`, `suggest` and `manual`, and verdict gates with `when`.
- The classifier protocol: a bare verdict or a JSON line with a reason. Any
  failure gives the verdict `error`, which unlocks nothing.
- Trust by folder hash, and runs from a content-addressed snapshot.
- A Ctrl-C, SIGTERM or SIGHUP to herdr-gc stops the running command's process
  group, and the run becomes `interrupted`.
- Detached workers, a lock per worktree, durable run records and logs, and
  `interrupted` runs after a crash.
- Suggestions with an atomic claim, and checks again on `accept`.
- `remove` once per checkout generation, also when herdr-gc deletes the
  checkout itself.
- CLI verbs `run`, `run-step`, `sweep`, `pending`, `accept`, `dismiss`,
  `trust`, `untrust`, `trusted`, `check`, `status`, `log` and `hud`.
- Plugin actions `open`, `accept-latest`, `dismiss-latest`, `accept-here`,
  `trust-here`, `run-open-here` and `sweep-here`.
- herdr notifications that name the command to type.
- The HUD popup: pending suggestions, recent runs and logs.
- Settings `HERDR_GC_TRUST`, `HERDR_GC_NOTIFY` and `HERDR_GC_SWEEP_JOBS`.
- Examples `install-on-open` and `reclaim-merged`.
