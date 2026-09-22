# Maintaining

[English] ・ 日本語: [maintaining.ja.md](maintaining.ja.md)

Notes for maintainers: the branch model and how changes reach the public `main`.

## Branches

- **`main`** — the public branch. Forward-only: only ever advanced by new
  commits, **never force-pushed or rebased**.
- **`topic/*`** — short-lived working branches, cut from `main`, one topic each.
- **`master`, `archive/*`** — local-only historical branches (the pre-squash
  granular history). Never pushed.

## Landing your own change

```bash
git checkout main && git pull --ff-only
git checkout -b topic/xxx
#   … work; commit freely (wip is fine) …
git rebase -i main          # tidy: fold "wip"/"typo" commits, reword messages
git checkout main
git merge --no-ff topic/xxx -m "Merge topic/xxx: summary"
git push origin main        # fast-forward; never use --force on main
git branch -d topic/xxx
```

Before merging, run the checks (Node 20+):

```bash
npm run format:check && npm run lint:all && npm test
```

Tidying with `rebase` happens **only inside the topic branch**. If a topic was
already pushed (e.g. for a PR), force-pushing that **topic** branch is fine —
but `main` is never force-pushed.

## External pull requests

Integrate them with a **merge commit** ("Create a merge commit" on GitHub),
which preserves the contributor's commits and authorship. The repository is
configured to allow merge commits only and to delete head branches on merge.

## Cutting a release

1. Bump the version in `package.json`, and the `version` strings in `server.mjs`
   and `agents/codex-app-server.mjs`, to match.
2. Update `CHANGELOG.md` (move `Unreleased` items under the new version).
3. Land it through the normal topic → `--no-ff` merge flow, then tag:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```
