# Repository guidance

`herdr-gc` is a herdr plugin in plain Node ESM. It needs Node >= 20 and git, and
it has no npm dependencies. `herdr-plugin.toml` declares the event hooks, the
startup hook, the HUD pane and the actions; every entry runs `bin/herdr-gc`
with one verb. `README.md` documents the behavior for users.
`docs/architecture.md` explains the code. `docs/design.md` records the design
review. None of them redefines what the code does.

## Module map

|File|Responsibility|
|---|---|
|`bin/herdr-gc`|The CLI. Parses the verb and the path, calls into `lib/`, prints results, and turns results into notifications inside herdr. Holds the `HELP` text. Reads its version from `package.json`.|
|`lib/env.mjs`|The plugin id, the config and state directories, `config.env` settings, the herdr binary, and the plugin context. Falls back to the directories herdr would inject.|
|`lib/toml.mjs`|A strict TOML subset parser. Rejects what it does not support, with the line number.|
|`lib/model.mjs`|Pure rules, no I/O: config validation, the step plan, the classifier protocol, herdr event mapping, `git worktree list` parsing, and the step environment.|
|`lib/config.mjs`|Finds the `.herdr-gc` folder for a checkout, reads it into a hash and a content-addressed snapshot, and answers trust.|
|`lib/state.mjs`|Files in the plugin state directory: worktree records, runs and logs, suggestions and claims, trust entries, and per-worktree locks.|
|`lib/exec.mjs`|Runs one command in its own process group with a timeout and a log.|
|`lib/git.mjs`|git facts about a checkout.|
|`lib/herdr.mjs`|The herdr CLI: the workspace list, notifications, and opening the HUD pane.|
|`lib/runner.mjs`|Runs: queueing, the worker, the run algorithm, accept and dismiss, `run-step`, `check`, `sweep`, and reconcile.|
|`lib/hud.mjs`|The HUD popup. Calls only runner, config and state functions that a CLI verb also calls.|
|`examples/`|Example `.herdr-gc` folders. Shipped, and tested.|
|`tests/`|`node:test` suites. A fake `herdr` script via `HERDR_BIN_PATH`, temp git repos, and a fake `gh`.|

## Invariants

The plugin holds no cleanup policy and deletes nothing itself. Deletion, like
every command, is a user step. Examples declare deletion steps as `suggest`.

Nothing from a `.herdr-gc` folder runs before the folder is trusted. Trust is a
SHA-256 over every file of the folder, so any change untrusts it. Commands run
from the content-addressed snapshot of the hashed bytes, never from the live
folder. `HERDR_GC_DIR` points at the snapshot.

A hook returns at once. It queues a run record and starts a detached worker.
Never do slow work in the `hook` verb.

One lock per worktree serializes every run, accept and `run-step` on it. Take
the lock before reading the worktree record.

`close` and `sweep` never run a classifier or an `auto` step while a herdr
workspace, other than the closing one, has the checkout open. The check runs
before the classifier and again before each `auto` step. If herdr does not
answer, the run stops.

`remove` runs at most once per checkout generation. A checkout that appears
again at the same path starts a new generation.

`accept` claims a suggestion with an atomic rename, so it runs once. Before the
step runs, it checks again: the worktree state that the event expects, the
trust of the snapshot hash, and, for a `when` step, a new verdict.

A classifier failure is the verdict `error`, and `error` cannot appear in
`when`. A broken classifier never unlocks a step.

Commands do not inherit `HERDR_PLUGIN_*` or `HERDR_GC_*` from the plugin
process. They get the `HERDR_GC_*` variables of `stepEnv` only.

Every command runs in its own process group, which a Ctrl-C does not reach.
Every verb except `hud` traps SIGINT, SIGTERM and SIGHUP and calls
`stopActive` before it exits. A new code path that runs a command must go
through `runCommand`, so the trap covers it.

Nothing replays an event by itself. `reconcile` only marks dead runs
`interrupted`.

`lib/model.mjs` stays free of I/O. Put a new rule there and test it there.

## Vocabulary

- **Event**: `create`, `open`, `close`, `remove` or `sweep`.
- **Step**: a `[[step]]` in `config.toml`: a named command bound to events.
- **Mode**: `auto`, `suggest` or `manual`.
- **Classifier**: the command that gives the verdict for an event.
- **Verdict**: the classifier's answer; `when` lists the verdicts a step needs.
- **Run**: one event, or one accepted step, for one worktree, with a record
  and a log.
- **Suggestion**: a queued `suggest` step, or a queued event of an untrusted
  folder.
- **Snapshot**: the copy of a hashed `.herdr-gc` folder that commands run from.
- **Record**: what herdr-gc remembers about one checkout path.
- **Generation**: one life of a checkout path, from its first event to its
  `remove`.

## Checks

```sh
npm run check
npm test
```

Keep the `package.json` and `herdr-plugin.toml` versions equal; a test checks
it. Add a `CHANGELOG.md` entry under `Unreleased` for every user-visible
change. A new verb, action or config key goes into `HELP` and the README.
