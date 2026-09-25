# Design

This document records how herdr-gc was designed: the herdr behavior it relies
on, the first proposal, the adversarial review of that proposal, and the
decisions that changed because of the review. [architecture.md](architecture.md)
describes the code as it is.

## Product boundary

herdr-gc runs commands that the user declares in a `.herdr-gc/` folder, at
points in the life of a git worktree. The plugin decides *when* a command runs
and *whether* it runs without asking. It never decides *what* a command does.
Installing dependencies, stopping a stack or deleting a checkout are user
steps. The plugin has no built-in deletion and no built-in policy.

The HUD is one view on the state. Every operation also exists as a CLI verb,
and the common ones exist as herdr plugin actions and as notifications that
name the command to type.

## Herdr behavior the design relies on

Probed on herdr 0.9.1 with an isolated server:

- An `[[events]]` hook gets the event in `HERDR_PLUGIN_EVENT_JSON`. Its cwd is
  the plugin root. Hooks of different events run concurrently. Herdr did not
  kill a hook that ran for 90 s.
- `worktree.created` and `worktree.opened` carry `workspace` and
  `worktree{path, branch, is_linked_worktree}`; `worktree.opened` also carries
  `already_open`.
- `workspace.closed` carries `workspace_id` and the closed `workspace`,
  including `worktree{checkout_path, repo_root, is_linked_worktree}`.
- `herdr worktree remove` deletes the checkout first. Then herdr emits
  `workspace.closed` and `worktree.removed` together, so both hooks start
  while the checkout is already gone.
- `herdr server stop` and a server restart emit no workspace events.
- Several workspaces can be open on one checkout.

## First proposal (summary)

Five events (`create`, `open`, `close`, `remove`, `sweep`), a
`.herdr-gc/config.toml` with `[[step]]` and `[[classifier]]` entries, three
modes (`auto`, `suggest`, `manual`), a classifier verdict that gates steps
with `when`, a queue of suggestions, trust by folder hash, a detached worker
per event with a pid lock per worktree, sidebar tokens for busy, failed and
pending states, a `sweep` over closed worktrees, and a HUD popup.

## Review findings and decisions

The proposal went through an adversarial review. Each finding and the decision
it caused:

1. **Lost or reordered work after the hook detaches.** A worker can die, and
   `close` and `remove` of one worktree can arrive in any order.
   *Decision:* `close` is best effort. When the checkout is already gone,
   `close` runs nothing and the `remove` event does the cleanup. Every run
   has a durable record (`queued`, `running`, `done`, `failed`,
   `interrupted`). The startup hook and `status` mark runs whose worker died
   as `interrupted` and report them. herdr-gc never replays a lifecycle event
   by itself.
2. **Trust is not containment.** A hash of the folder does not cover `yarn`,
   PATH lookups, symlinks or package scripts. A check-then-run window exists.
   *Decision:* trust approves the declared commands, nothing more; the README
   says so. Symlinks inside `.herdr-gc/` are rejected. herdr-gc copies a
   trusted folder into a content-addressed snapshot and runs every command
   from the snapshot, so a file that changes after the hash check does not
   run.
3. **The motivating classifier had no data source.** *Decision:* ship
   `examples/reclaim-merged/`, a classifier recipe. It reads the merged PR from
   `gh`, refuses on a dirty checkout or on commits after the merge, and calls
   an optional user script `last-activity` for agent-session data. Every
   missing input gives `keep`. The plugin itself holds no policy.
4. **Destructive commands can race a reopened checkout.** *Decision:* before
   the classifier and before every step of a `close` or `sweep` run, herdr-gc
   asks herdr whether a workspace has the checkout open, and aborts the run if
   one does. The examples use `suggest` for deletion. The README states the
   residual race and tells users to recheck in destructive scripts.
5. **Replay and `run` semantics were vague.** *Decision:* an untrusted config
   queues one `event` suggestion. `trust` never runs anything.
   `accept <id>` replays the event only when the worktree is still in the
   state the event expects. `run <event>` behaves exactly like the hook:
   `auto` runs, `suggest` queues, `manual` skips. `run-step <name>` runs one
   step in any mode; it is the only way to run a `manual` step.
6. **`remove` could run twice.** Our own run can delete the checkout while
   herdr also emits `worktree.removed`. *Decision:* each worktree record has a
   generation. `remove` sets `removedAt` for the generation under the
   worktree lock; a second `remove` of the same generation is a no-op. A
   `create` or `open`, or finding the path checked out again, starts a new
   generation.
7. **A hand-written TOML subset is not TOML.** *Decision:* the README calls
   the format "restricted TOML" and lists what it accepts; everything else is
   an error with a line number. The ancestor search stops at the home
   directory. The nearest folder wins; the repo root is the fallback.
8. **Shared JSON files lose writes.** *Decision:* one file per suggestion and
   one file per trusted folder. Accepting claims a suggestion by an atomic
   rename, so two acceptors cannot run it twice. Worktree records are written
   only under the worktree lock. Locks are created with `O_EXCL`; a lock whose
   pid is dead is stale.
9. **Timeouts left children running.** *Decision:* every command runs in its
   own process group. A timeout sends SIGTERM to the group and SIGKILL after
   5 s. Step output streams to a log file; classifier output is capped at
   64 KiB.
10. **Too much in the first cut.** *Decision:* sidebar tokens are cut. `sweep`
    and the HUD stay, because they reuse the same runner and the HUD was part
    of the request; neither holds logic of its own.

## Resulting semantics

### Events

|Event|Trigger|Runs in|
|---|---|---|
|`create`|herdr `worktree.created`|checkout|
|`open`|herdr `worktree.opened` with `already_open = false`|checkout|
|`close`|herdr `workspace.closed` with worktree provenance, the checkout still exists, and no other workspace has it open|checkout|
|`remove`|herdr `worktree.removed`, or herdr-gc sees the checkout gone after one of its runs|repo root, else the nearest existing parent|
|`sweep`|`herdr-gc sweep`: each linked worktree of a repo that no workspace has open|checkout|

### Run algorithm

1. Resolve the worktree record, the config and its trust.
2. Untrusted config: run nothing, queue one `event` suggestion, notify.
3. For `close` and `sweep`: abort when a workspace has the checkout open.
4. Run the event's classifier, if any.
5. For each step bound to the event, in file order:
   skip it when its `when` list does not hold the verdict;
   `auto` runs it (for `close`/`sweep`, after the open check);
   `suggest` queues it; `manual` skips it.
   A failed `auto` step ends the run, unless `continue_on_error = true`.
6. Record the run and notify.
7. If the checkout is gone and the event is not `remove`, run `remove`.

### Accepting a suggestion

Claim the suggestion file by rename. Check that the config snapshot is still
trusted, that the worktree is in the state the event expects, and, for a step
with `when`, that the classifier still gives a verdict in `when`. Then run the
step from the snapshot. A `create` or `open` of a worktree drops its pending
`close` and `sweep` suggestions.
