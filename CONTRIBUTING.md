# Contributing to herdr-gc

Thanks for taking a look. This is a small Node plugin with no dependencies and
a few strong rules. The goal is to keep all of them.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## The rules that shape every review

**The plugin never deletes anything on its own.** herdr-gc holds no cleanup
policy. It does not decide that a worktree, a branch or a directory can go.
Deletion is only ever a step that the user declares in `.herdr-gc/config.toml`.
An example step that deletes something uses `mode = "suggest"`, so the user
accepts it first. A pull request that adds a built-in deletion, or a default
policy, will be declined.

**Nothing from `.herdr-gc` runs without trust.** A folder runs nothing until
the user runs `herdr-gc trust`. Trust pins a sha256 of the whole folder. Any
change to the folder needs trust again. Commands run from a content-addressed
snapshot of the trusted folder. A change that runs a command, a classifier or
any file from the folder before trust will be declined. Trust approves the
commands. It is not a sandbox.

**Nothing blocks a herdr hook.** The hook queues a run, starts a detached
worker, and returns at once. All the work runs in the worker. A 20-minute
install must never hold a herdr hook. Do not add work to the hook path that
waits on a step, a classifier, git or the network.

**No runtime dependencies.** The plugin needs Node >= 20 and git. "No install
step" is a feature. A new npm dependency needs a real argument, and the answer
is usually no.

**Tests run offline.** No test may need a real `herdr`, GitHub or a network.
The suite points `HERDR_BIN_PATH` at a fake `herdr` shell script. It builds
temp git repos with linked worktrees. The example classifier runs against a
fake `gh`. A test that needs a real herdr server is a test nobody can run,
including CI.

## Before you write code

Open an issue first for anything beyond an obvious fix. The answer is sometimes
"that is a step in your config" or "that belongs in herdr", and both are better
than a patch.

Good first contributions:

- A herdr event payload that changed shape. Attach the
  `HERDR_PLUGIN_EVENT_JSON` value that the hook received. Remove paths and
  names you do not want to share.
- A config that the parser rejects, but should accept. Attach the smallest
  `.herdr-gc/config.toml` that shows the problem, and the output of
  `bin/herdr-gc check`.
- Platform breakage. Development happens on macOS, so Linux gets less
  real-world use than it deserves.

## Development setup

There is no build step and no dependency install. You need Node >= 20 and git.

```sh
git clone git@github.com:H3xept/herdr-gc.git
cd herdr-gc
npm test
bin/herdr-gc help
```

Run it as a herdr plugin from your checkout:

```sh
herdr plugin link .
```

The hooks load the code again on every event, so a change in `lib/` applies to
the next event. Use `bin/herdr-gc run <event> [path]` to run an event by hand,
and `bin/herdr-gc check [path]` to see what each event does.

Try your change in a throwaway repo with a throwaway `.herdr-gc` folder. Do not
point it at a repo whose worktrees you want to keep.

[AGENTS.md](AGENTS.md) lists the modules, the invariants and the vocabulary.
[docs/architecture.md](docs/architecture.md) explains the run algorithm.

## Checks

```sh
npm run check   # node --check on bin/herdr-gc and every lib/*.mjs
npm test        # node --test tests/*.test.mjs
```

CI runs both on Node 20 and 22, on Linux and macOS.

Run `npm test` after any change to `lib/`, `bin/herdr-gc`, `examples/`,
`herdr-plugin.toml`, or version metadata.

## Pull requests

- One concern per pull request.
- Say what you ran and what you saw. "Removed a worktree in a temp repo, the
  suggest step queued, `herdr-gc accept --latest` ran it, and the branch went"
  is the useful kind of description.
- New verb, flag, or configuration key? Update the `HELP` text in
  `bin/herdr-gc` and the README together.
- Keep `package.json` and `herdr-plugin.toml` on one version. A test asserts
  it.
- Add to `CHANGELOG.md` under an `Unreleased` heading.

## Code conventions

- Plain Node ESM. Only `node:` built-ins.
- Comments explain *why*. The *what* is readable from the code.
- `lib/model.mjs` stays pure: no I/O, so every rule is testable without git,
  herdr or a shell. Put a new rule there, and test it there.
- One term per concept. An event, a step, a mode, a run and a suggestion each
  mean one thing. Do not add a synonym.
- Failure is data. A step that fails marks its run failed and writes its log. It
  does not stop the runs of other worktrees.
- Runs are durable JSON records. A worker that dies leaves its run for the
  startup hook to mark `interrupted`. Nothing replays a run automatically. Do
  not add retry or replay logic.

## Releasing

Maintainer only. Bump the version in `package.json` and `herdr-plugin.toml`,
update `CHANGELOG.md`, tag the commit `vX.Y.Z`, and push the tag.
