## What changes

<!-- One concern per pull request. Link the issue if there is one. -->

## What you ran and what you saw

<!-- For example: "Removed a worktree in a temp repo, the suggest step queued,
`herdr-gc accept --latest` ran it, and the branch went." -->

## Checklist

- [ ] `npm run check` and `npm test` pass.
- [ ] No new runtime dependency.
- [ ] No command from a `.herdr-gc` folder runs before trust.
- [ ] No built-in deletion or cleanup policy. Deletion stays a user step.
- [ ] A new verb, flag or configuration key is in the `HELP` text and the README.
- [ ] `CHANGELOG.md` has an entry under `Unreleased`.
