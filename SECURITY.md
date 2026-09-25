# Security policy

## Supported versions

Only the latest release receives security fixes.

## Report a vulnerability

Do not open a public issue for a security problem.

Report it privately through
[GitHub security advisories](https://github.com/H3xept/herdr-gc/security/advisories/new).
Include the version, your platform, the steps to reproduce, and the impact you
expect.

The maintainer answers in the advisory. When the fix ships, the advisory is
published and credits you, unless you ask to stay anonymous.

## Scope

herdr-gc runs the commands of a trusted `.herdr-gc` folder with the rights of
your user. Trust pins a sha256 of the whole folder. Commands run from a
content-addressed snapshot of that folder. Trust approves the commands. It is
not a sandbox.

In scope:

- A way to run a command, a classifier or a file from a `.herdr-gc` folder that
  is not trusted, or that changed after trust.
- A way to run a `suggest` or `manual` step without the user's accept or
  `herdr-gc run-step`.
- A way to escape the snapshot, for example through a symlink, so that a run
  uses files the trust did not pin.
- A way to make the plugin delete or modify files on its own, outside a step
  the user declared.

Out of scope: what a trusted user command does. A trusted step can do anything
your user can do. Review a `.herdr-gc` folder before you trust it.
