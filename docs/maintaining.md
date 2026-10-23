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

## Dependencies and `npm audit`

Audit findings here are dev-tooling only: `npm ls --omit=dev --omit=optional`
is empty, and neither `devDependencies` nor `package-lock.json` is published.
So a fix is a plain `fix(deps):` commit — **no version bump, no tag**.
Only editing the `optionalDependencies` ranges is visible to installs, and that
warrants a patch release.

Note that `overrides` applies to this repository's own install, not to anyone
who depends on `terminal-mode-console`.

**Do not regenerate `package-lock.json` wholesale.** With npm 11.6.2, any
`npm install` — even with an unchanged `package.json` — drops
`@modelcontextprotocol/sdk` (a peer dependency of the optional
`@anthropic-ai/claude-agent-sdk`) from the tree, and the first pass leaves a
lock that `npm ci` then rejects as out of sync. To pin a single transitive
package, add the `overrides` entry and edit that one lock entry by hand
(`version`, `resolved`, `integrity` from `npm view <pkg>@<ver> dist.integrity`),
then verify with `npm ci --dry-run` and a clean `npm ci`.

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
