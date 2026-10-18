# Changelog

All notable changes appear in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `x` in the HUD runs any step of the selected worktree's config, without its
  classifier. When a herdr workspace has the checkout open, the prompt names
  it, and `y` closes the workspace first. The step then runs after the close
  steps. If herdr cannot say which workspaces are open, nothing runs.
- `space` in the HUD marks worktrees. `x` then offers the steps that every
  marked worktree's config has, and runs the chosen one for all of them in one
  confirmation. Each gets its own worker, and only the open ones are closed.
- `run-step --close` closes every herdr workspace on the checkout and waits for
  their close runs before the step runs. `run-step --detach` returns at once.
- Install from GitHub with `herdr plugin install H3xept/herdr-gc`. The README
  says what the install preview shows and how to pin a revision.
- A README banner GIF of the HUD, and `docs/demo/`, which records it again
  in a fictional world with no herdr and no network.
- A step's `notify` key: `"start"`, `"success"`, `"failure"`, a list of them,
  or `"all"`. Each moment sends its own herdr notification with the step's
  name and, at the end, the time it took, so a long install is visible while
  it runs. The run's summary leaves such a step out.
- `HERDR_GC_NOTIFY=verbose`: every step announces its start and end, as if it
  had `notify = "all"`. A setting value the key does not accept falls back to
  the default.
- Notifications, `status` and the HUD show how long each step and run took.
  The HUD's detail pane shows when a run was queued, started and ended.
- A `run-step` run, which the HUD starts detached, reports its result as a
  notification: the step's outcome, or why nothing ran.
- An interrupted run (a signal, a worker that died) sends a notification.
- A sweep's notification counts the steps that ran, the suggestions, the
  failures and the untrusted folders. With `HERDR_GC_NOTIFY=all` it is sent
  whenever a step ran; from the `sweep-here` action it is always sent.
- `reconcile` and `status` put a suggestion that a dead `accept` had claimed
  back in the queue, and forget the records of checkouts removed more than
  30 days ago.
- An unknown option, such as `--dryrun`, is an error. Before, `sweep
  --dryrun` ran a real sweep.

### Fixed

- `remove` drops the pending `close` and `sweep` suggestions of the gone
  checkout. Before, a checkout deleted by `run-step` or by hand kept its old
  `delete checkout` suggestion in the HUD.
- Steps and classifiers see the user's own `HERDR_GC_*` variables again.
  Before, every `HERDR_GC_*` variable was dropped, so a scheduled sweep could
  not pass `HERDR_GC_SUGGEST=0` to its classifier, and queued the delete
  suggestions it was told not to.
- A sweep over hundreds of worktrees no longer pushes the `open` and `close`
  runs out of history. Of the runs that ran, suggested or failed nothing,
  only the newest 60 stay; the cap of 300 runs applies to the rest.
- A worker that crashes ends its run as `failed`, with the error as the note,
  instead of leaving it `running` until the next reconcile.
- A `sweep` run that found an untrusted folder, or an `auto` step that ran
  during a sweep, is counted in the sweep's notification. Before, both were
  silent.
- A worker that cannot start (the system is out of processes) ends its run
  as `failed` with the reason. Before, the run stayed `queued`, and a
  `run-step --close` waited up to 15 minutes for it.

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
