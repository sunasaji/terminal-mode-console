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
