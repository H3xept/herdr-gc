# herdr-gc

<div align="center">
  <img src="docs/hud.gif" alt="The herdr-gc popup: three pending suggestions over the recent runs. Accepting 'delete checkout' for a merged worktree removes it and runs the remove event. Trusting a new config replays the open event it blocked, and yarn install runs." width="100%">
</div>

Run your own commands when a git worktree is created, opened, closed or
removed in [herdr](https://herdr.dev). You decide per step whether it runs
automatically, is only suggested, or waits for you. An optional classifier
decides whether a step applies at all.

The motivating case: run `yarn install` when a worktree opens. When a worktree
closes, stop the Aspire stack that runs in it. Then, if its pull request is
merged and nobody worked in it since, offer to delete the checkout.

```toml
# .herdr-gc/config.toml
version = 1

[[step]]
name = "install"
on = ["create", "open"]
run = "yarn install"

[[classifier]]
on = "close"
run = '"$HERDR_GC_DIR/classify.sh"'   # prints "reclaim" or "keep"

[[step]]
name = "stop stack"
on = "close"
run = "aspire stop"

[[step]]
name = "delete checkout"
on = "close"
when = "reclaim"
mode = "suggest"
run = 'git -C "$HERDR_GC_REPO_ROOT" worktree remove "$HERDR_GC_WORKTREE"'
```

herdr-gc has no built-in cleanup. It never deletes a file or decides that a
worktree is stale. Every command, including a deletion, is a step that you
write, and a deletion is best declared as `suggest`.

## Features

- **Five events.** `create`, `open`, `close` and `remove` come from herdr.
  `sweep` runs on demand over every closed worktree of a repo.
- **Three modes per step.** `auto` runs. `suggest` queues the step and notifies
  you; `herdr-gc accept` runs it. `manual` never runs by itself;
  `herdr-gc run-step <name>` runs it.
- **Classifiers.** One command per event prints a verdict, such as `reclaim`.
  A step with `when = ["reclaim"]` only applies on that verdict. A crashed or
  slow classifier gives the verdict `error`, which unlocks nothing.
- **Trust.** A `.herdr-gc` folder runs nothing until you approve it with
  `herdr-gc trust`. Any later change to any file in the folder needs approval
  again.
- **Safe acceptance.** `accept` checks again before it runs a step. The
  worktree must still be closed, the config still trusted, and the classifier
  must still give the same kind of verdict.
- **No blocked hooks.** A hook queues a run and returns. A detached worker
  runs the steps, so a 20-minute install holds nothing in herdr.
- **Works without the HUD.** Notifications name the command to type. Plugin
  actions cover the common answers. The HUD popup is a convenience view.
- No dependencies: plain Node >= 20.

## Requirements

- herdr >= 0.9.1 on macOS or Linux.
- Node >= 20 on `PATH`.
- git.
- Whatever your own steps call (`yarn`, `aspire`, `gh`, …).

## Install

```sh
herdr plugin install H3xept/herdr-gc
```

Or link a checkout, to hack on it:

```sh
git clone https://github.com/H3xept/herdr-gc.git
herdr plugin link ./herdr-gc
```

The plugin runs as your user, with your environment and the full herdr CLI.
`herdr plugin install` shows the manifest and every command it runs before it
installs; read them, and pin a revision with `--ref <tag-or-sha>` if you want
one. See herdr's
[trust and security guidance](https://herdr.dev/docs/plugins/#trust-and-security)
and [SECURITY.md](SECURITY.md).

Put the CLI on your `PATH` if you want to type `herdr-gc` instead of
`path/to/bin/herdr-gc`. From a checkout:

```sh
ln -s "$PWD/herdr-gc/bin/herdr-gc" ~/.local/bin/herdr-gc
```

## Quick start

1. Create `.herdr-gc/config.toml` in a repo, or in the directory that holds
   your worktrees. The examples below are a good start.
2. Check what each event would do:

   ```sh
   herdr-gc check path/to/a/worktree
   ```

3. Review the folder, then trust it:

   ```sh
   herdr-gc trust path/to/.herdr-gc
   ```

4. Create, open or close a worktree in herdr. Or run an event by hand:

   ```sh
   herdr-gc run close path/to/a/worktree
   ```

5. Answer suggestions:

   ```sh
   herdr-gc pending
   herdr-gc accept --latest
   ```

## Examples

- [`examples/install-on-open`](examples/install-on-open/.herdr-gc/config.toml):
  the smallest useful config.
- [`examples/reclaim-merged`](examples/reclaim-merged/.herdr-gc/): installs
  dependencies on create and open. On close, it stops the Aspire AppHosts that
  run from the checkout. It then suggests `git worktree remove` when
  [`classify.sh`](examples/reclaim-merged/.herdr-gc/classify.sh) says
  `reclaim`. That needs a merged pull request (through `gh`), a clean checkout,
  and no commit after the merge. Rename
  [`activity-since.example`](examples/reclaim-merged/.herdr-gc/activity-since.example)
  to `activity-since` to also keep worktrees where an agent session started
  in the checkout after the merge. It reads the `cwd` field of JSON session
  files under `AGENT_SESSION_DIRS`.

Copy an example folder next to your worktrees and change it. Every copy needs
`herdr-gc trust` once.

## Where the config lives

For a worktree, herdr-gc uses the nearest `.herdr-gc/config.toml` in the
checkout or in one of its parent directories. The search stops at your home
directory. When it finds nothing, it uses the folder at the repo root of the
main checkout.

So one folder can serve every worktree of a repo:

```text
~/code/app/            main checkout
~/code/app-wts/
  .herdr-gc/           applies to every worktree below
  feat-a/
  feat-b/
```

The `.herdr-gc` folder can hold scripts next to `config.toml`. Commands see the
folder as `$HERDR_GC_DIR`. Symlinks are refused inside the folder, and the
folder holds at most 256 files and 4 MiB.

## Config reference

```toml
version = 1                      # required

[[classifier]]
on = ["close", "sweep"]          # an event or a list; one classifier per event
run = "./classify.sh"            # a shell command
timeout = "2m"                   # default 2m

[[step]]
name = "delete checkout"         # required, unique; letters, digits, space . _ : -
description = "shown in suggestions"
on = ["close", "sweep"]          # required: an event or a list
run = "git worktree remove ."    # required: a shell command
mode = "suggest"                 # auto (default) | suggest | manual
when = ["reclaim"]               # verdicts; needs a classifier for every event in `on`
timeout = "10m"                  # default 10m; "90s", "20m", "1h", or seconds
continue_on_error = false        # true: a failure does not stop the later steps
```

The file is strict TOML without floats, dates and inline tables. An unknown key
is an error: a typo such as `mdoe = "suggest"` must not make a step `auto`.
`herdr-gc check` lists every problem at once.

### Events

|Event|When|Commands run in|
|---|---|---|
|`create`|herdr created the worktree.|the checkout|
|`open`|herdr opened an existing worktree in a new workspace.|the checkout|
|`close`|A workspace on the worktree closed, the checkout still exists, and no other workspace has it open.|the checkout|
|`remove`|herdr removed the worktree, or herdr-gc saw the checkout disappear during one of its runs.|the repo root|
|`sweep`|You ran `herdr-gc sweep`. It runs for each linked worktree of the repo that no workspace has open.|the checkout|

`remove` runs once per checkout, however many sources report it. If the same
path gets a checkout again, that is a new worktree.

`close` is best effort. herdr sends no event when its server stops, and
`herdr worktree remove` deletes the checkout before it reports the close. So
put the cleanup that must happen on `remove`, and use `sweep` to catch up.

### Modes

|Mode|On its event|
|---|---|
|`auto`|Runs. A failure ends the run, unless `continue_on_error = true`.|
|`suggest`|Queues a suggestion and notifies you. Nothing runs until you accept.|
|`manual`|Nothing. Only `herdr-gc run-step <name>` runs it.|

Steps run one at a time, in file order. `herdr-gc run-step` ignores the mode
and the `when` gate.

### Classifier protocol

A classifier is a command. The last non-empty line of its stdout is the
verdict: a word of `a-z`, `0-9`, `_` and `-`, up to 32 characters. The last
line can also be JSON with a reason:

```json
{"verdict": "keep", "reason": "uncommitted files"}
```

A nonzero exit, a timeout, no output or bad output gives the verdict `error`.
`error` is not allowed in `when`, so a broken classifier never unlocks a step.
The verdict and the reason show in the log, the notification and the
suggestion.

For `close` and `sweep`, herdr-gc checks before the classifier and before each
`auto` step that no herdr workspace has the checkout open.

### Command environment

Every classifier and step runs with `/bin/sh -c` in its own process group. A
timeout sends SIGTERM to the group and SIGKILL 5 s later. A Ctrl-C, SIGTERM or
SIGHUP to herdr-gc stops the running command the same way, and the run becomes
`interrupted`. A command sees your environment without `HERDR_PLUGIN_*`, plus:

|Variable|Value|
|---|---|
|`HERDR_GC_EVENT`|`create`, `open`, `close`, `remove` or `sweep`|
|`HERDR_GC_WORKTREE`|the checkout path|
|`HERDR_GC_BRANCH`|the branch, when known|
|`HERDR_GC_REPO_ROOT`|the main checkout of the repo|
|`HERDR_GC_LINKED`|`1` for a linked worktree, `0` for the main checkout|
|`HERDR_GC_WORKSPACE_ID`|the herdr workspace, when herdr started the run|
|`HERDR_GC_DIR`|the trusted snapshot of the `.herdr-gc` folder|
|`HERDR_GC_CONFIG_DIR`|the `.herdr-gc` folder itself|
|`HERDR_GC_VERDICT`, `HERDR_GC_REASON`|the classifier's answer (steps only)|
|`HERDR_GC_STEP`|the step name, or `classifier`|
|`HERDR_GC_TRIGGER`|`herdr`, `cli`, `accept`, `run-step`, `sweep`, `chained` or `preview`|
|`HERDR_GC_RUN_ID`|the run, for `herdr-gc log`|

Use `$HERDR_GC_DIR` to call scripts from the folder. It points at the copy
that you trusted, so a script cannot change between the check and the run.

## Trust

A `.herdr-gc` folder comes with a repo, and a repo can come from anyone. So
herdr-gc runs nothing from a folder until you trust it:

```sh
herdr-gc trust path/to/.herdr-gc    # or a path inside the worktree
herdr-gc trusted                    # list
herdr-gc untrust path/to/.herdr-gc
```

Trust pins a SHA-256 hash of every file in the folder. When a file changes,
the folder is untrusted again. An event on an untrusted folder runs nothing,
queues itself as one suggestion, and notifies you. After `trust`,
`herdr-gc accept <id>` replays the event.

Trust approves the commands. It is not a sandbox: a trusted step runs with your
rights. Set `HERDR_GC_TRUST=all` only if every repo you open is yours.

## Without the HUD

Every operation is a CLI verb. herdr-gc tells you which one to type.

- **Notifications.** Each run that did something sends a herdr notification.
  It lists the verdict, the steps that ran, and the suggestions, with the
  command that accepts them.
- **Plugin actions.** Bind them to keys in herdr, or run them from the command
  palette:

  |Action|Does|
  |---|---|
  |`accept-latest`|Accepts the suggestions of the newest run that has any.|
  |`dismiss-latest`|Dismisses them.|
  |`accept-here`|Accepts the suggestions for the focused worktree.|
  |`trust-here`|Trusts the focused worktree's `.herdr-gc` folder.|
  |`run-open-here`|Runs the `open` event again, for example after a failed install.|
  |`sweep-here`|Sweeps the focused repo.|
  |`open`|Opens the HUD.|

- **The CLI.**

  ```text
  run <event> [path]      run an event now, as the hook would (--detach)
  run-step <name> [path]  run one step now, whatever its mode or event
  sweep [path]            the sweep event on every closed worktree (--dry-run, --jobs N)
  pending [--json]        pending suggestions
  accept <id…>            or --latest, --here, --all
  dismiss <id…>           or --latest, --here, --all
  trust / untrust [path]  approve or forget a .herdr-gc folder
  trusted                 list trusted folders
  check [path]            validate the config and show each event's plan
                          (--event E also runs E's classifier, but no step)
  status [path]           a worktree's record, pending suggestions, last runs
  log [run|path]          a run's log (default: the newest)
  hud                     the popup
  ```

`[path]` defaults to the worktree of the herdr workspace that invoked the
command, then to the current directory.

## The HUD

The popup lists pending suggestions, then recent runs. The bottom half shows
the selected item: the step, the verdict and the log.

|Key|Does|
|---|---|
|`j`/`k`, arrows|select|
|`y`|accept the selected suggestion (asks first)|
|`d`|dismiss it|
|`t`|trust its folder (asks first)|
|`r`|reload|
|`q`, `esc`|close|

## Settings

`config.env` in the plugin config directory holds `KEY=value` lines. Find the
directory with `herdr plugin config-dir h3xept.herdr-gc`. An environment
variable of the same name wins.

|Key|Default|Values|
|---|---|---|
|`HERDR_GC_TRUST`|`ask`|`ask`: trust per folder. `all`: trust every folder.|
|`HERDR_GC_NOTIFY`|`all`|`all`, `attention` (failures, suggestions, trust), `off`|
|`HERDR_GC_SWEEP_JOBS`|`4`|how many worktrees `sweep` classifies at once|

## State

herdr-gc keeps its state in the herdr plugin state directory. Runs and their
logs live in `runs/` and `logs/`, and the newest 300 runs stay. Suggestions
live in `suggestions/`, one file each. Trusted snapshots live in `snapshots/`.

A worker that dies (a reboot, a kill) leaves a `running` record. At herdr
startup, and on `herdr-gc status`, such a run becomes `interrupted` and you
get a notification. herdr-gc never replays an event by itself. Run it again
with `herdr-gc run <event>`.

## Development

```sh
npm run check    # node --check on every file
npm test         # node:test, offline: a fake herdr, temp git repos, a fake gh
```

See [AGENTS.md](AGENTS.md) for the module map and the invariants,
[docs/architecture.md](docs/architecture.md) for the design, and
[docs/design.md](docs/design.md) for how the design was reviewed.

`docs/demo/` builds a fictional world with fake `gh`, `yarn`, `aspire` and
`herdr` binaries under `/tmp/herdr-gc-demo`. Try the HUD in it with no herdr
and no network:

```sh
source docs/demo/env.sh
herdr-gc hud
```

To record `docs/hud.gif` again, install [VHS](https://github.com/charmbracelet/vhs)
and `gifsicle`, then run `bash docs/demo/record.sh`. See
[docs/demo/README.md](docs/demo/README.md).

## Credits

The design of herdr-gc comes from a need that
[@rory660](https://github.com/rory660) described: worktrees pile up, each with
its dependencies and a running stack, and cleaning them up by hand does not
scale. Thanks, Rory, for the push that started this plugin.

Built on [herdr](https://herdr.dev) and its plugin API.

## License

[MIT](LICENSE)
