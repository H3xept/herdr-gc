# Demo recording

[VHS](https://github.com/charmbracelet/vhs) records `docs/hud.gif` from
`hud.tape`. The recording is offline. It needs no herdr, no GitHub and no
Aspire.

## Re-record

```sh
brew install vhs gifsicle     # vhs brings ttyd and ffmpeg
bash docs/demo/record.sh
```

`record.sh` runs the tape with `vhs`, then shrinks the GIF with
`gifsicle -O3 --lossy=40`. Run it from anywhere in the checkout. It drops every
inherited `HERDR_*` variable first, so you can run it from a herdr pane.

## Try the HUD by hand

```sh
source docs/demo/env.sh
herdr-gc hud
```

Each `source` deletes the demo world and builds it again.

## The demo world

`env.sh` builds these under `/tmp/herdr-gc-demo/home`, which it also sets as
`HOME`:

| Checkout | What happens before the recording |
| --- | --- |
| `~/wts/shop/feat-checkout` | `close`: the classifier says `reclaim` (PR #412 is merged), the AppHost stops, and `delete checkout` is suggested |
| `~/wts/shop/docs-refresh` | `close`: the same, for PR #409 |
| `~/wts/shop/fix-cart` | `close`: `keep`, because no pull request is merged |
| `~/wts/shop/spike-cache` | `close`: `keep`, because the checkout has an untracked file |
| `~/wts/shop/feat-search` | `create`: `yarn install` runs |
| `~/wts/billing/feat-invoices` | `open`: blocked, because nobody trusted `~/wts/billing/.herdr-gc` yet |

`~/wts/shop/.herdr-gc` is a copy of `examples/reclaim-merged` and is trusted.
`~/wts/billing/.herdr-gc` installs on `create` and `open`.

## Where things live

| File | What it does |
| --- | --- |
| `hud.tape` | The recording: browse, accept a checkout deletion, trust a config and replay its event. Writes `docs/hud.gif`. |
| `style.tape` | Terminal size, font and theme. |
| `boot.tape` | Hidden setup: sources `env.sh`. |
| `env.sh` | Builds the demo world, points herdr-gc at it, and runs the events above. |
| `record.sh` | Records the tape and shrinks the GIF. |
| `bin/gh` | Answers `gh pr list --head <branch> --state merged` for the branches above. |
| `bin/yarn` | Prints what `yarn install` prints and writes nothing. |
| `bin/aspire` | Answers `aspire ps` and `aspire stop` for one AppHost per checkout. |
| `bin/herdr` | Answers `workspace list` with no workspace and logs `notification show`. |

## Isolation

`env.sh` unsets every inherited `HERDR_*` variable, then sets:

| Variable | Value |
| --- | --- |
| `HOME` | `/tmp/herdr-gc-demo/home` |
| `PATH` | `docs/demo/bin` and `bin/` first |
| `HERDR_BIN_PATH` | `docs/demo/bin/herdr` |
| `HERDR_PLUGIN_STATE_DIR` | `/tmp/herdr-gc-demo/plugin-state` |
| `HERDR_PLUGIN_CONFIG_DIR` | `/tmp/herdr-gc-demo/plugin-config` |
| `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM` | `/dev/null`, `1`: your git config does not apply |

The demo never reads or writes the real herdr state or plugin state. It never
calls the real `gh`, `yarn`, `aspire` or `herdr`.

## Check a recording

Extract frames and look at them before you commit:

```sh
ffmpeg -i docs/hud.gif -vf "fps=1/3,scale=620:-1,tile=2x6" /tmp/hud-%d.png
```
