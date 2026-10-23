# メンテナ向けガイド

English: [maintaining.md](maintaining.md) ・ 日本語

ブランチ構成と、変更が公開ブランチ `main` に入るまでの流れのメモです。

## ブランチ

- **`main`** — 公開ブランチ。前進のみ（新しいコミットで進めるだけ）で、**force-push や rebase はしない**。
- **`topic/*`** — `main` から生やす短命の作業ブランチ。1トピック1ブランチ。
- **`master` / `archive/*`** — ローカル限定の履歴ブランチ（squash 前の粒履歴）。push しない。

## 自分の変更を取り込む

```bash
git checkout main && git pull --ff-only
git checkout -b topic/xxx
#   … 作業（wip コミットで可）…
git rebase -i main          # 整形: "wip"/"typo" を fold、メッセージを整える
git checkout main
git merge --no-ff topic/xxx -m "Merge topic/xxx: 概要"
git push origin main        # fast-forward。main には --force を使わない
git branch -d topic/xxx
```

マージ前にチェックを実行（Node 20+）:

```bash
npm run format:check && npm run lint:all && npm test
```

`rebase` による整形は **topic ブランチの中だけ**で行う。topic を既に push 済み
（PR 用など）なら、その **topic** ブランチは force-push してよい——ただし
`main` は決して force-push しない。

## 依存関係と `npm audit`

このリポジトリの audit 指摘は dev ツールに限られる。`npm ls --omit=dev
--omit=optional` は空であり、`devDependencies` も `package-lock.json` も publish
されない。したがって修正は `fix(deps):` コミット 1 本で済み、**バージョンは
上げない・タグも打たない**。install 内容が変わるのは
`optionalDependencies` のレンジを書き換えたときだけで、その場合は patch
リリースが妥当。

なお `overrides` はこのリポジトリ自身の install にしか効かない。
`terminal-mode-console` を依存として入れた側には適用されない。

**`package-lock.json` を丸ごと再生成しないこと。** npm 11.6.2 では、
`package.json` を変えずに `npm install` しただけでも、optional な
`@anthropic-ai/claude-agent-sdk` の peerDependency である
`@modelcontextprotocol/sdk` が tree から落ちる。さらに 1 回目の
`npm install` が生成した lock は `npm ci` が「同期していない」として拒否する。
推移的依存を 1 つだけ固定したいときは、`overrides` に追記した上で該当の lock
エントリ（`version` / `resolved` / `integrity`。integrity は
`npm view <pkg>@<ver> dist.integrity` で取得）だけを手で書き換え、
`npm ci --dry-run` とクリーンな `npm ci` で検証する。

## 外部からのプルリクエスト

**マージコミット**（GitHub の「Create a merge commit」）で取り込む。貢献者の
コミットと author がそのまま保持される。リポジトリはマージコミットのみ許可・
マージ後にブランチ自動削除に設定済み。

## リリースの切り方

1. `package.json` のバージョンと、`server.mjs`・`agents/codex-app-server.mjs`
   の `version` 文字列を揃えて上げる。
2. `CHANGELOG.md` を更新（`Unreleased` の項目を新バージョンへ移す）。
3. 通常の topic → `--no-ff` マージの流れで取り込み、タグを打つ:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```
