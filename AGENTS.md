# Working in this repository

This file holds the conventions every agent and contributor follows here.

## Main-based development

`main` is the only long-lived branch. Everything is built on it, and every release is tagged from it.

- Work on a short-lived branch cut from current `main`. Merge it back within a day or two through a pull request. If a change can't land that quickly, make it smaller, or land it behind a feature flag (below). Never keep it on a long-running branch.
- Keep `main` releasable at every commit. A pull request merges only when the Chat checks pass and an independent reviewer who didn't write it has reviewed it clean.
- Rebase or merge `main` into your branch often, so it never drifts far from `main`.
- Delete the branch when it merges.
- Don't create release branches, candidate branches or notes branches. A release is a tag on a `main` commit, and its release notes land on `main` like any other change.
- If `main` breaks, fixing it comes before any other work. Revert first when that's the fastest way back to green.

## Large features behind a feature flag

A feature too big for one short-lived branch lands on `main` in small, reviewed slices, hidden behind a flag until it is ready.

- **Off by default.** A new flag ships off, so `main` and every release behave exactly as before until the flag is turned on.
- **Prefer one flag per feature.** A feature that seems to need many flags is usually better split into smaller features.
- **The old path keeps working.** While the flag is off, existing behavior must be unchanged and still covered by the checks. Test both the on and off states of anything the flag touches.
- **Recorded.** Every flag has an entry in `docs/feature-flags.md`: name, purpose, owner, the work item it belongs to, its current default, and the condition for removing it.
- **Turning it on is a reviewed change.** Making a flag default to on is its own small pull request. Merging it puts the feature on `main`; users get it with the first published release that contains that commit.
- **Removal is part of the feature.** Once a flag has been on in a published release and the feature is accepted, delete the flag, the off path and its tests in a follow-up pull request, and remove its entry. The feature isn't done until its flag is gone.
- **Branch by abstraction** is the alternative when you're replacing an existing mechanism rather than adding a new one. Put the old implementation behind an interface, build the new one alongside it, switch over, then delete the old one.
- Flags are for unfinished features. Don't use them for per-user settings or permanent configuration.

## Releases

Releases go through CI and need no human approval.

- Tag a reviewed `main` commit as `vMAJOR.MINOR.PATCH`. The tag workflow runs the checks and builds the release assets as a draft.
- Check the draft's asset, checksum, provenance and notes against the tagged commit, then publish it. Publishing a stable release triggers the automatic installer on deployed hosts. Don't ask for approval before tagging or publishing.
- Escalate only for a real problem: a failing check you can't fix, or a release that would break something users rely on.
- If a published release is bad, ship a fix or revert it from `main` as the next release. Don't patch a deployment by hand.

See [docs/private-server-release.md](docs/private-server-release.md) for packaging and installation details.
