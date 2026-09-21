# 開発者・運用ガイド

English: [developer.md](developer.md) ・ 日本語版

このガイドは [../README.md](../README.md) から切り出した、常駐運用・接続構成・WebUI の詳細・バックエンド連携・環境変数・内部設計・セキュリティのまとめです。

## systemdで常駐させる（Linux）

ログイン中のClaude/Codexの認証情報と同じホームディレクトリを使えるよう、ユーザーサービス用の
template unitを同梱しています。clone先がどこでも使えるよう、起動するディレクトリをunitの
instance名として渡します。

```bash
# リポジトリのルートで実行
mkdir -p ~/.config/systemd/user ~/.config/terminal-mode-console
cp systemd/terminal-mode-console@.service ~/.config/systemd/user/
cp systemd/env.example ~/.config/terminal-mode-console/env
chmod 600 ~/.config/terminal-mode-console/env

# envを編集し、少なくともTMCON_TOKENを推測不能な値へ変更
${EDITOR:-vi} ~/.config/terminal-mode-console/env

unit="terminal-mode-console@$(systemd-escape --path "$PWD").service"
systemctl --user daemon-reload
systemctl --user enable --now "$unit"
systemctl --user status "$unit"
```

ログは`journalctl --user -u "$unit" -f`で確認できます。更新後にプロセスを入れ替える場合は
`systemctl --user restart "$unit"`を実行します。ただし、サーバー再起動後はEven AppがSSEへ
自動再接続しないことがあるため、その場合はEven Appも再起動してください。

ログアウト後も常駐させたい場合は、管理者が一度だけ次を実行します。

```bash
sudo loginctl enable-linger "$USER"
```

環境変数を変更したときもserviceの再起動が必要です。公開範囲については次のTailscale設定と
[セキュリティ](#セキュリティ)を確認してください。停止・自動起動解除は次のとおりです。

```bash
unit="terminal-mode-console@$(systemd-escape --path "$PWD").service"
systemctl --user disable --now "$unit"
```

## Tailscaleでスマホ・G2から接続する（推奨）

[Tailscale](https://tailscale.com/)をterminal-mode-consoleを動かすPCと、Even Appを使うスマホへ
インストールし、同じtailnetへログインします。サーバーはループバック待ち受けのまま、PCの別の
ターミナルで次を実行します。

```bash
tailscale serve --bg --https=3456 http://127.0.0.1:3456
tailscale serve status
```

`tailscale serve status`に表示されたHTTPS URLを控えます。例えば
`https://my-pc.example-tailnet.ts.net:3456`です。Tailscale ServeがTLSを終端するため、
terminal-mode-console自体を外部アドレスへbindする必要はありません。

Serveはループバックから転送するため、そのままだとリクエストログのアクセス元が
常に`127.0.0.1`になります。terminal-mode-consoleはServeが付与する
`Tailscale-User-Login` / `X-Forwarded-For`ヘッダを読み、実アクセス元——
アクセスしたユーザーのログインと送信元IPを併記(例 `[you@example.com, 10.x.x.x]`。
片方しか無ければある方だけ)——を代わりに記録します。
既定で有効で、TCP接続元がループバックのときだけ信用します。生の接続元を記録したい
場合は`TRUST_PROXY=0`を指定します。なおTailscale Funnelは`Tailscale-User-Login`を
付けません(匿名のインターネットアクセスのため)。そもそも本サーバーはFunnelでの公開を
想定していません。

Even AppでTerminal Modeを開き、ホスト追加画面へ次のように入力します。

| 項目             | 入力例                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| ホスト名         | `自宅PC`（一覧で見分けるための任意の名前）                                   |
| ホストのアドレス | `https://my-pc.example-tailnet.ts.net:3456`（`tailscale serve status`のURL） |
| 認証トークン     | サーバー起動時に表示した`TMCON_TOKEN`                                        |

QRコードは不要です。本ツールは`evenhub`コマンドへ依存せず、QRコードも生成しません。

同じURLはWebUIとCLIにも使えます。

WebUIは
`https://my-pc.example-tailnet.ts.net:3456?token=XXXX&defaultProvider=claude`をブラウザで開きます。

```bash
node bin/tmcon-cli.mjs \
  'https://my-pc.example-tailnet.ts.net:3456?token=XXXX&defaultProvider=claude'
```

Tailscale Serveはtailnet内だけに公開します。インターネット全体へ公開するTailscale Funnelは、
このサーバーの用途には使用しないでください。

## WebUI

**トークン付きの接続URLをブラウザで開くだけ**でWebUIが出る(認証も同じトークン)。
グラスが無くても会話でき、グラスがある場合は入力手段としても使える。

- **接続中のバックエンドをヘッダに表示し、プロバイダごとに見た目を変える**。`?defaultProvider=`
  に応じて `Claude Code / Codex / local` をヘッダの表示ピルに出すだけでなく、アクセント色
  (claude=テラコッタ / codex=グリーン / local=パープル)を**ヘッダ上部の帯・表示ピル・
  タブ名・ファビコン・`theme-color`** に反映する。色の定義は CSS の `[data-provider]{--accent}`
  一箇所にまとめ、JS はそれを読んで CSS で変えられないタブ名・ファビコン・theme-color に反映する。
  これで claude / codex / local のウィンドウやタブを並べても一目で判別できる
- グラスと同じ描画(本文・薄字のツール行・`Thinking...`・経過秒)
- **ステータス行は入力欄の直上**。`Waiting input` / `Thinking...` / `Responding...` と、
  こちらが答えを待っている `Waiting your answer — …`(黄色)を出す
- **前景ターンの liveness を表示**。開始からの経過時間に加え、最後に思考・本文・ツール・
  結果イベントを観測して30秒経つと `quiet 32s`、`STALL_WARN_MS` を超えると
  `No activity 2m` と表示する。セッション一覧にも `active 4s ago` などを付け、一覧を
  毎秒取り直さずブラウザ側で相対時間だけ更新する。これは「最後にイベントを観測した時刻」
  であって停止判定ではない。正常な長時間処理でも `No activity` になり得るほか、表示を理由に
  自動中断・自動再起動はしない。ユーザー回答待ちと Claude のバックグラウンド処理、SSE の
  `Reconnecting...` はそれぞれ別状態として扱う
- **Claude Code / Codex の使用量をステータス行の右端に表示**。`Ctx:50% 5h:40% 1w:30%` の
  形式で、セッションを開いた時とターン完了時に更新する。`5h` / `1w` をタップすると、
  各枠のリセット日時をブラウザのローカル時刻で `年月日(曜日) 時:分` まで表示する。
  Claude は Agent SDK の構造化 `/context`・`/usage`、Codex はセッションに保存された最新の
  `token_count` を利用する。Codex のレート枠はアカウント単位なので、5h 制限に当たって
  自セッションに枠情報が残らないときは、他セッションの直近値・失敗ターンのエラー
  (`usageLimitExceeded` の文言含む)・ディスクキャッシュ(`~/.tmcon/codex-usage.json`)
  の順でリセット日時を補完する。Claude のプラン使用量を取得できない API key / Bedrock /
  Vertex 接続では `5h` / `1w` を `—` とし、使用量 API 自体が未対応のバックエンドでは
  使用量欄を隠す
- **モデル選択(Claude / Codex / ローカル LLM)** — ヘッダの `ⓘ` を開くとプルダウンが出る。Claude で選べるのは
  `Default` / `Opus` / `Sonnet` / `Haiku` / `Fable` の**エイリアス**で、常にその系統の
  最新モデルへ解決されるため、モデルが更新されても設定を直す必要がない
  (`claude-opus-4-6` のような固定 ID を持たない)。Codex は App Server の `model/list` が
  返す現在のモデルを動的に表示するため、一覧をバージョン固定していない。ローカル LLM は
  接続先の実装(LM Studio / Ollama / llama.cpp)を**応答から判別**し、それぞれのネイティブ API で
  一覧を取る(後述)。選ぶと**即座にサーバーへ記憶**され、
  **モデル選択 UI を持たないグラスも次のターンからそのモデルを使う**。記憶はセッション単位と
  provider 枠のグローバル既定の二段で、別セッションのグラスにはグローバル既定が効く。
  **自分で選んでいないときは何も指定しない** — プルダウンは現在有効なモデルを*表示*するが、
  それは選択したことにはならず、送信時にモデルを指定しないので、セッションやサーバー側の
  設定をそのまま引き継ぐ(表示していただけのモデルを指定として送り返し、意図しない切替を
  起こすことはない)。`モデル: 自動` を選ぶと**記憶を解除**し、指定なしの状態へ戻す
  (設定時にセッションとグローバル既定の両方へ書くので、解除も両方が対象)。
  表示は現在の記憶値に追従するので、**CLI やグラスなど他のクライアントが変えたモデルも
  プルダウンに現れる**(セッションを開いた時・ターン完了時・15秒ごとに更新。ただし
  プルダウンを操作している間は動かさない)。
  ターン完了後は**実際に使われた具体モデルID**(例 `claude-sonnet-5`)を薄字で1行残すので、
  エイリアスが何に解決されたか確認できる。`Fable` は Pro プランだとクレジット従量課金に
  なり得る(Max では標準枠)ため、その旨をプルダウンに注記している
- **入力専用モード** — チェックすると出力を畳み、キーボード入力だけの UI になる。
  詳細はグラスで読み、長文入力は手元で、という使い分け向け
- **日本語入力**の変換候補はブラウザ側に出るので、グラスに送る必要がない。
  確定は `Ctrl+Enter`(IME 変換中の Enter は送信に取られない)
- **権限・質問はログ最下部のインラインカード**で答える。全画面モーダルは出さず、
  スクロール領域の末尾にカードを積むので、聞かれた内容も応答後の結果も履歴に残る
  (回答済みの質問は再開後も同じ見た目で復元される)
- **プロンプトメタデータを整形表示** — `<recommended_plugins>` や `<INSTRUCTIONS>`
  などの独自タグ内は Markdown、`<environment_context>` や `<task-notification>` のように
  タグ内が構造化されたものはタグ名を見出しに、中身を項目名と値の階層ツリーとして表示する。
  ツリー解析は厳密 XML ではなく寛容なタグ解析なので、`<summary>` 等の値に `&`・`<`・`>` を
  含む自由文が来ても崩れない。ライブ受信と履歴表示の両方に適用し、通常のユーザー入力とは
  色と先頭記号を分ける。標準 HTML タグと閉じタグのない入力は素テキストのまま扱う
- **ファイル添付**(📎 ボタン / テキスト欄へ Ctrl+V 貼り付け)。画像は Vision 対応
  バックエンド(`local` / `claude` / `codex`)へ渡し、テキストファイル(md/json/csv/ソース等)は
  中身を本文へインラインして送る。
  グラス本体からはファイルを送れないので、これは WebUI 側の入力手段
- **cwd で絞り込み / 新規の作業ディレクトリ指定** — ヘッダの cwd 欄に文字を入れると、
  その作業ディレクトリ(部分一致)のセッションだけを一覧に出す。欄に入れたパスは
  **「新規」で始めるセッションの作業ディレクトリ**にもなる(空ならサーバー既定)。
  過去に使った cwd は入力候補(datalist)に出る。絞り込みの制約は後述の「設計上の注意」を参照
- **セッションのアーカイブ** — 終了したセッションを削除せず通常一覧から隠せる。
  `ⓘ` で開く情報パネル内に、アーカイブ可能なセッションを選んでいるときだけ操作ボタンが現れる。
  セッション未選択・未送信の新規セッション・実行中・回答待ちではボタン自体を表示しない。
  アーカイブが1件以上あるときだけ `アーカイブ済 N` トグルが現れ、同じ一覧内で表示・復元できる。
  状態は terminal-mode-console 独自のメタデータであり、Claude / Codex の保存データは変更しない。
  `ⓘ` は情報パネルを閉じてもヘッダー最上行に残る

グラス・WebUI・その他クライアントは**同時接続できる**。出力は全員に配信され、
入力は後述の FIFO で直列化される。

### ホーム画面に追加(PWA / Service Worker なし)

WebUI は `manifest.webmanifest` とアイコン・メタタグを持ち、**スマホのホーム画面に追加**
すると URL バーの無い standalone で起動する。Service Worker は入れていない(常時接続前提の
ライブ UI でオフライン価値が薄く、平文 HTTP の LAN では SW を登録できないため)。

- **初回だけ**ペアリング URL(`?token=…` 付き)で開く。トークンは localStorage に退避される。
- iOS「ホーム画面に追加」は開いた時の URL(トークン付き)を起点にするのでそのまま動く。
- Android/デスクトップは `start_url`(`/`)にトークンが乗らないが、localStorage から復元する。
- トークンが URL にも localStorage にも無い場合はバナーが再ペアリングを促す。

トークンは無認証で取得できる manifest には**焼き込まない**(漏洩防止)。シェル HTML は
機密を含まないため認証手前で返し、実データ(REST/SSE)は従来どおりトークン必須。

> Tailscale を入れておくと、スマホ・グラスから安定して届く。ただし既定はループバック
> 待ち受けなので、外部から届かせるには後述「セキュリティ」の `tailscale serve`(推奨)か
> `HOST=0.0.0.0` のいずれかが要る。`<host>` は Tailscale IP か MagicDNS 名を使う。

### 素の HTTP だとタブは 5 枚まで(6 枚目以降が無反応になる)

**症状**: `http://…`(HTTPS でない)で WebUI を**同一ブラウザの複数タブ**で開くと、ある枚数を
超えたあたりから、履歴は出るのに**送信しても応答が返らない**タブが出る。DevTools の Network で
リクエストが `pending` のまま、Console に `net::ERR_INSUFFICIENT_RESOURCES` が出ていればこれ。

**原因**: WebUI はタブごとに `/api/events`(SSE)へ**常時接続を 1 本**張りっぱなしにする。
ブラウザは **HTTP/1.1 では 1 ホストあたり同時接続 6 本まで**という制限があるため、SSE だけで
6 タブ分の枠を使い切ると、7 本目にあたる新規リクエスト(送信・履歴取得など)が枠を取れずに
止まる。SSE 自体は繋がったまま(=「接続が切れました」は出ない)なので気づきにくい。

**回避策**:

1. **タブを減らす**(素の HTTP で使うなら 1〜数枚に留める)。いちばん手軽。
2. **HTTPS 化する**(推奨)。ブラウザとの通信が **HTTP/2** になり、1 本の接続で多数の
   ストリームを多重化するので、この 6 接続制限に**そもそも当たらなくなる**。
   - いちばん楽なのは後述「セキュリティ」の **`tailscale serve`** — 証明書の発行・更新が
     自動で、証明書管理の手間を持ち込まずに HTTPS(=HTTP/2)にできる。
   - 自前でリバースプロキシ(Caddy / nginx 等)や Node の TLS を立てても同じ効果。
     その場合は SSE をバッファリングしない設定(nginx なら `proxy_buffering off;`。
     本サーバーは応答に `X-Accel-Buffering: no` を付けて自衛済み)にすること。

> スマホや別ブラウザで平気なのは、接続プールがブラウザ(プロファイル)ごとに独立していて、
> かつ普通はタブを開きすぎないため。制限は「1 ホストあたり」なので、同じ端末でも別ブラウザなら
> 別枠になる。

## 常駐させるなら(Ollama)

サーバーとして動かしっぱなしにする場合は Ollama が扱いやすい。最初から daemon として動き、
ヘッドレス環境でもそのまま使える。

```bash
ollama serve
ollama pull <model>

TMCON_TOKEN=$(openssl rand -hex 16) \
LLM_BASE_URL=http://localhost:11434/v1 \
LLM_MODEL=<model> \
node server.mjs
```

## 端末クライアント(tmcon-cli)

グラス・WebUI と**同じ会話**を端末から読み書きできる薄いクライアント。

```bash
node bin/tmcon-cli.mjs 'https://<magicdns-name>:3456?token=XXXX'  # 接続 URL をそのまま
node bin/tmcon-cli.mjs --url https://<magicdns-name>:3456 --token XXXX --new --provider local
```

起動すると**セッション一覧を出して選ばせる**。黙って最新へ繋ぐと意図しない会話に
合流してしまうため。`--session <id>` か `--new` を渡せば聞かずに始める。一覧には
各セッションの作業ディレクトリ(cwd)も薄字で並ぶ。

```text
  1) 2026-07-21 17:05  even-terminalのログを…   /home/me/projA
  2) 2026-07-21 16:43  Japanese greeting response  /home/me/projB
  n) 新規セッション

番号を選択 (n=新規)>
```

`--cwd <dir>` を渡すと、その作業ディレクトリ(部分一致)のセッションだけに一覧を
絞り込み、`n`(新規)で始めるセッションもそのディレクトリで開く。`--cwd` を付けない
まま `n` を選んだときは**作業ディレクトリを聞く**(過去の cwd を番号で選ぶ / パスを
直接入力 / Tab でサーバー上の実在ディレクトリを補完 / 空でサーバー既定)。絞り込みの
制約は後述の「設計上の注意」を参照。

`--model <name>`(または `EVEN_MODEL`)で Claude / Codex のモデルを指定できる。会話中は
`/model <name>` で切り替え、`/model` 単体で**記憶を解除**して自動へ戻す(WebUI の
`モデル: 自動` と同じ)。値は WebUI のプルダウンと同じエイリアス
(`opus` / `sonnet` / `haiku` / `fable` / `default`)かフル ID。指定するとサーバーに
記憶され、他クライアントにも引き継がれる。Codex では `model/list` に現れる具体 ID を使う。
**指定しなければ `model` を送らない**ので、
セッションやサーバー側の設定をそのまま引き継ぐ。ターン完了後は
`› model: claude-sonnet-5` のように**実際に使われた具体モデルID**を薄字で出す。

入力行の直上に**ステータス行**を出す(`[Waiting input]` / `[Thinking... 12s]` /
応答待ちなら黄色で `[Waiting your answer — 質問 …]`)。端末でないとき(パイプ)は出さない。

Claude Code の TUI ではない(スラッシュコマンドや差分表示は無い)。代わりに
**会話状態がサーバー側にある**ので、切断しても文脈を失わない。繋ぎ直せば
`history` から続きが読める。**tmux は必須ではなく、好みで使う**もの。

権限・質問ダイアログは端末でも番号選択で答えられる。先に他のクライアントが
答えた場合は、こちらの待ち受けは自動で畳まれる。

## Claude Code を繋ぐ(任意)

`@anthropic-ai/claude-agent-sdk` を入れると `claude` バックエンドが有効になる。
**任意依存**なので、入れなければコア依存ゼロのまま。

```bash
npm install                  # claude も使える
npm install --omit=optional  # local / echo のみ(依存ゼロ)
```

**セッションごとに `query()` を1本だけ張り**(1セッション = 1 query = 1 子プロセス)、
ターンはその**ストリーミング入力**チャネルへ user メッセージを push して回す。接続を張る
時に `resume` で前回までの会話に続ける。会話状態は Claude 側の JSONL に永続化されるので
文脈は繋がり、グラス・WebUI・CLI が同じ文脈を共有する。

> 以前は per-turn(毎ターン `query()` を張り直して `result` で close)だったが、
> Claude Code 2.1.2xx で Agent(サブエージェント)ツールが既定でバックグラウンド実行に
> なったため、`result` で query=子プロセスごと close すると走行中のエージェントを
> 道連れに殺してしまう。永続 query なら子プロセスが生き続けてエージェントが死なず、
> メインターンの `result` で bus を idle に戻せるので、バックグラウンド実行中でも
> 会話を続けられる(2.1.2xx では旧来の「2ターン目で固まる」も解消済み)。

モデルはターンごとに切り替えられる。既存セッションの切り替えは SDK の
`Query.setModel()`(ストリーミング入力専用 API)で行い、**query は張り直さない**。
実効モデルの解決順は ①リクエストの `model` → ②サーバーが記憶した値(この会話 →
provider 枠のグローバル既定) → ③`CLAUDE_MODEL` → ④Claude Code の既定。
実際に使われた具体モデルIDは assistant メッセージの `message.model` から拾い、
`result` イベントの `model` に載せる(エイリアスの解決結果が分かる)。

**過去セッションの一覧と再開に対応**している。Claude Code が JSONL に持っている
会話がそのまま一覧に並び、開いて続きを話せる。新規セッションは terminal-mode-console 側の
UUID をそのまま Claude のセッション ID にするので、次回以降も同じ ID で並ぶ。

> ローカル LLM も会話を JSONL に永続化する(`LLM_STORE_DIR`、既定 `~/.tmcon/sessions`)。
> 一覧に残り、開き直せば文脈ごと続けられる。`LLM_PERSIST=0` で無効化できる。

## Codex を繋ぐ(任意)

`@openai/codex-sdk` を入れると `codex` バックエンドが有効になる。SDK に同梱される
Codex CLI の App Server と構造化 JSON-RPC で通信し、スレッドの新規作成・再開、履歴、
ストリーミング、ツール表示、中断、画像入力に対応する。

```bash
npm install
TMCON_TOKEN=$(openssl rand -hex 16) PROVIDER_CODEX=codex node server.mjs
```

Codex App Server 標準の `item/tool/requestUserInput` を `user_question` として
WebUI・グラス・CLI へ橋渡しする。thread固有のdynamic toolは登録しないため、通常のCodex
CLIで作成したthreadもterminal-mode-consoleから相互にResumeできる。terminal-mode-consoleが所有するApp Server
子プロセスだけを `--enable default_mode_request_user_input` 付きで起動し、新規threadとResumeの
両方に、明示的な2〜3択ではネイティブ質問を使うdeveloper instructionsを渡す。ユーザーの
`~/.codex/config.toml` は変更しない。

モデル一覧は App Server の `model/list` から取得してキャッシュし、WebUI に動的に表示する。
実効モデルはターンごとに `turn/start` へ渡すため、既存 thread の resume 時も切り替えられる。
解決順は ①リクエストの `model` → ②サーバーが記憶した値(この会話 → provider 枠の
グローバル既定) → ③`CODEX_MODEL` → ④Codex の既定。`thread/resume` では切り替えない。
`CODEX_REASONING_EFFORT` が選択モデルの対応一覧に無い場合は effort を送らず、そのモデルの
既定値に委ねる。実際に使われたモデルは `result.model` に載せる。

`default_mode_request_user_input` は現行Codexではunder-development featureであり、Default
モードのネイティブ質問はプロトコル上 `isBlocking: false` である。terminal-mode-consoleは要求IDを保持し、
ユーザーの選択後に標準の `{ answers: { id: { answers: [...] } } }` 形式で明示的に回答する。
コマンド実行やファイル変更の承認要求も `permission_request` へ橋渡しする。既定は
`workspace-write` と `on-request`。既存のCodex認証と設定はそのまま利用される。

WebUI の短縮セッションIDは、時刻由来で似やすい先頭8文字ではなく**末尾8文字**を表示する
(Claudeなど他providerは従来どおり先頭8文字)。

### ローカル LLM のモデル一覧と実装の判別

ローカル LLM 枠のモデル選択肢は、接続先の実装を**応答から判別**してから、その実装の
ネイティブ API で取得する。ポート番号では判別しない — ポートは自由に変えられるうえ、
リバースプロキシや SSH トンネル越しでは既定値と一致しないため。

判別は `GET /v1/models` 1本から始め、決まらなければ実装固有の口を順に叩く
(それぞれ1実装でしか 200 にならない)。

| 手掛かり                           | 判定                                             |
| ---------------------------------- | ------------------------------------------------ |
| `Server: llama.cpp` ヘッダ         | llama.cpp(全応答に付くので最も確実)              |
| `data` と並ぶトップレベル `models` | llama.cpp(Ollama 互換用の重複表現)               |
| `owned_by: "llamacpp"`             | llama.cpp                                        |
| `owned_by: "organization_owner"`   | LM Studio(※未文書化なので単独では決め手にしない) |
| `GET /api/version` が 200          | Ollama                                           |
| `GET /props` が 200                | llama.cpp                                        |
| `GET /api/v1/models` が 200        | LM Studio                                        |

一覧の取得元と、実装ごとの差:

- **LM Studio** — `GET /api/v1/models`(古い版は `/api/v0/models` へフォールバック)。
  `type` で**埋め込みモデルを除外**する。OpenAI 互換の `/v1/models` は `text-embedding-*` も
  同じ一覧に混ぜて返し対話用か区別できないので、そちらは使わない。
  `loaded_instances` が空でなければロード済みとして印を付ける。未ロードのモデルを指定した
  ときに自動で読み込まれるかは **JIT ロード設定**次第で、無効なら事前ロードが要る
- **Ollama** — `GET /api/tags`(pull 済み一覧)。`GET /api/ps` でロード中のものに印を付ける。
  指定すれば自動ロードされるので**自由に切り替えられる**(初回だけ読み込み待ちが入る)
- **llama.cpp** — `GET /props` の `role` を見る。**ルーターモード**(`-m` なしで起動)なら
  `/v1/models` の全モデルを出す。**単一モデルモード**は起動時に固定されていて変更しようが
  ないので、一覧を**空にしてピッカー自体を出さない**
- **その他の OpenAI 互換** — `GET /v1/models` をそのまま使う(種別が分からないので絞り込まない)

接続先から HTTP 応答が一切返らないときは、ヘッダに**接続エラーをそのまま出す**
(`接続できません @ <endpoint>`)。この状態のラベルとモデル名は接続先から取れた値では
なく、ポートからの推測と env の既定値なので、平常時と同じ体裁で出すと設定が効いて
いるように見えてしまう。なお 401 のように「応答は返るが拒否された」場合は到達扱い
とする — 認証が要るだけで接続自体は生きているため。

**モデル未指定(「自動」)のときは一覧から選ぶ。** OpenAI 互換 API は `model` 必須で
「サーバーに任せる」が無いため、何かを選ぶしかない。優先順は `LLM_MODEL` の明示指定 →
**ロード済み** → 一覧の先頭 → 既定値 `agents-a1-4b`。ロード済みを優先するのは、未ロードを
指すと読み込み待ちが入る(実装によっては失敗する)ため。既定値まで落ちると接続先に実在
しないことがあるので(例: LM Studio の実 ID は `internscience_agents-a1-4b`)、一覧から
選べる限りはそちらを使う。選ばれる予定のモデルは `describe().autoModel` として返し、
WebUI はプルダウンの「自動」へ `モデル: 自動 (InternScience Agents A1 4B)` のように併記する。

`describe()` は同期なので、一覧は**バックグラウンドで取得してキャッシュ**し(TTL 60秒)、
`describe()` はその時点のキャッシュを返す。取得前は空配列で、WebUI 側はそのとき
ピッカーを隠すため、起動直後に一瞬出ないだけで破綻はしない。

### ローカル LLM のツール利用

`LLM_TOOLS=1`(既定)なら、ローカル LLM に **bash / grep / read_file / view_image / list_dir** を
OpenAI 互換 function-calling で渡す。モデルがツールを呼べば実行し、結果を会話に足して
問い直す——というエージェンティックなループを回す(上限 `LLM_TOOLS_MAX_ROUNDS`)。
ツール利用の様子は Claude 枠と同じ `tool_start` / `tool_end` イベントでクライアントに出る。

**画像を会話の文脈で解析させる(`view_image`)**: バックエンドが Vision 対応モデル
(例: LM Studio の mmproj 付きモデル)なら、モデルが画像パスに対して `view_image` を呼ぶと、
その画像を **user メッセージに載せ直して**次のラウンドで解析させる。OpenAI 互換 API は
`role:"tool"` に画像を載せられないため、tool 応答にはテキストの控えだけを返し、画像は直後の
合成 user メッセージへ注入する仕組み。画像の base64 は JSONL に永続化しない
(文脈肥大を避けるため。再開後に必要ならモデルが `view_image` を呼び直せばよい)。
上限は `LLM_TOOLS_MAX_IMAGE`(既定 8MB)。

安全のため、読み取り系(`grep` / `read_file` / `list_dir`)は自動で通し、任意コマンドを
実行できる `bash` は既定で**毎回ユーザーに許可を聞く**(WebUI はログ最下部の許可カード、
グラスは本体側の確認)。
「常に許可」を選べばそのプロセス内では以後聞かない。自動許可の対象は `LLM_TOOLS_AUTO_ALLOW`
で変えられる(例: `LLM_TOOLS_AUTO_ALLOW=read_file,grep,list_dir,bash` で bash も無確認)。
ツールを完全に切るなら `LLM_TOOLS=0`。

> 実際にツールを使いこなせるかはモデル依存(小型モデルは引数 JSON を壊しがち)。
> tool 呼び出し・結果も JSONL に残るので、再開後も文脈ごと続けられる。

### ローカル LLM とのやり取りをデバッグする(`LLM_DEBUG_DUMP`)

**モデルに実際に渡った内容と返ってきた内容をそのまま見たい**とき——例えば小型モデルが添付済みの画像に対してなぜ `view_image` を呼ぶのかを調べたいとき——は `LLM_DEBUG_DUMP` を設定する。バックエンドとの全リクエスト/レスポンスの往復が JSONL に書き出される。会話ストア(`LLM_PERSIST`)とは別物で、ストアは再開用の**整えた会話**(画像は除去)を保持するのに対し、こちらは base64 画像も含む**生のワイヤトラフィック**をそのまま残す。

**記録内容** — 1行1 JSON オブジェクト。各行に `ts` と `session` を持つ:

- `dir: "request"` — `/chat/completions` に POST する body 全体。`model`、`messages` 配列すべて(システムプロンプト + tool ヒント、これまでの履歴、今回の user メッセージ = **生の `data:image/...;base64,...` の `image_url` を含む**)、ツール有効時は `tools`。
- `dir: "response"` — 組み立てた応答。`reasoning`(`reasoning_content` から得たモデルの思考。グラスに表示しない設定でも捕捉する)、`text`、`toolCalls`(名前 + 生の引数 JSON)、`finishReason`、`usedModel`。失敗時は代わりに `error: true` と `status`/`body`(HTTP エラー)または `message`(接続・ストリームエラー)。

1 tool round につき 1 行書かれるので、多段ターン(例: `view_image` の往復)は複数の request/response ペアとして順に現れる。

**出力先** — 値でレイアウトが決まる:

| `LLM_DEBUG_DUMP`      | 出力                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 未設定 または `0`     | 無効。オーバーヘッドなし——蓄積も書き込みも一切しない                                                                   |
| `1` または `true`     | `<LLM_STORE_DIR>/debug/<sessionId>.jsonl` — セッションごとに1ファイル、会話ストアの隣(既定 `~/.tmcon/sessions/debug/`) |
| ディレクトリのパス    | `<そのdir>/<sessionId>.jsonl` — 任意の場所にセッションごと1ファイル                                                    |
| `.jsonl` で終わるパス | その単一ファイルに**全**セッションを混在して追記                                                                       |

セッションごとのファイル名は会話ストアと同じ `<sessionId>.jsonl` なので、ダンプと保存済み会話を突き合わせやすい。存在しないディレクトリは自動作成される。

> **モデルのコンテキストは肥大化しない。** ダンプは純粋な副作用で、リクエスト body は組み立て後に送信されるものをそのままシリアライズするだけ、`reasoning` はローカル変数に蓄積してディスクに書くだけで会話には戻さない。モデルが見るプロンプトはダンプの ON/OFF で1バイトも変わらない。コストはディスク書き込みと、有効時に1ターン分の思考テキストをメモリに保持することだけ。ファイルは base64 画像全体を含むため急速に肥大化する——本番ではなくローカルデバッグ用途に。

## provider の解決規則

アプリ(even-terminal)が送る provider は **`claude` / `codex` の2枠だけ**。terminal-mode-console は
この2枠それぞれに「実体バックエンド」(`claude` / `codex` / `local` / `echo`)を割り当てて動く。
割り当ては環境変数で決める。

| 枠(アプリの選択)       | 環境変数          | 既定                                          |
| ---------------------- | ----------------- | --------------------------------------------- |
| Claude Code (`claude`) | `PROVIDER_CLAUDE` | `claude`(SDK 未導入なら自動で `local` へ降格) |
| Codex (`codex`)        | `PROVIDER_CODEX`  | `codex`(SDK 未導入なら自動で `local` へ降格)  |

例:

```bash
PROVIDER_CLAUDE=claude PROVIDER_CODEX=codex   # Claude/Codex とも本物
PROVIDER_CLAUDE=local  PROVIDER_CODEX=local   # 両枠ともローカル LLM
PROVIDER_CLAUDE=echo   PROVIDER_CODEX=echo    # 動作確認用
```

### 実体名の直接指定

枠に割り当てなくても、**実体名をそのまま provider に指定できる**(`local` / `echo` など)。
`?defaultProvider=local` で開けば、`PROVIDER_*` を設定していなくてもローカル LLM に繋がる。
`LLM_BASE_URL` さえ指定しておけば、1つのサーバーで `claude` / `codex` / `local` / `echo` を
URL だけで開き分けられる。

```bash
# LLM_BASE_URL だけ指定しておけば、4つとも URL で切り替えられる
LLM_BASE_URL=http://localhost:1234/v1 TMCON_TOKEN=… node server.mjs
#   ?defaultProvider=claude / codex / local / echo
```

**枠は実体名より優先される。** `PROVIDER_CLAUDE=local` のとき `provider=claude` は
(枠の割り当てどおり)ローカル LLM を開く。アプリが送るのは `claude`/`codex` だけなので、
実体名を受け付けるようにしても純正アプリの挙動は変わらない。

`claude` / `codex` / 登録済みの実体名 のいずれでもない provider は `claude` 枠へ寄せる。
セッション一覧などの応答は、**枠に割り当てられている実体なら枠名**(`claude`/`codex`)で返す
— アプリの語彙を保つため。どの枠にも割り当てられていない実体を直接指定した場合だけ、
その実体名(`local` など)で返す(そうしないとクライアントが同じ provider で開き直せない)。
`tmcon-cli` は `--provider <名前>` で指定できる。

なお、モデルの記憶やアーカイブ状態は **解決後の実体ごとに分けて保存**される(枠名では
なく実体名がキー)。モデル名は枠ではなく実体の属性だからで、`opus` は LM Studio には
意味を持たない。そのため:

- `local` と `claude` は別々に覚える。ローカル LLM 用に選んだモデル名が Claude へ渡ることはない
- `PROVIDER_CLAUDE=local` の枠経由で開いても、`local` を直接指定しても **同じ状態**に行き着く
- 枠の割り当てを `local` から `claude` に戻しても、**local 用の記憶が Claude に引き継がれない**

会話履歴そのものも実体側(ローカル LLM は自前の JSONL、Claude は Claude Code の JSONL)に
溜まるので、枠の割り当てを変えても混線しない。

### 実際の接続先を隠さない

フォールバックは黙って起きるので、**どのクライアントでも会話開始時に本当の接続先が見える**
ようにしてある。`GET /api/info` は要求された provider を実際に解決してから答える。

```text
要求 claude → Claude Code / (既定) @ Agent SDK
要求 codex  → LM Studio / agents-a1-4b @ localhost:1234   ← 未実装なので local へ
```

| どこで見えるか | 見え方                                                         |
| -------------- | -------------------------------------------------------------- |
| グラス         | セッション最初のターンに薄字で1行(`notification`)              |
| WebUI          | ヘッダのバッジに常時表示                                       |
| tmcon-cli      | 起動時に1行。フォールバック時は `(要求: codex → local)` も出る |

セッションごとに1度だけなので、`notification` が消えない仕様でも画面を埋めない。
不要なら `ANNOUNCE_BACKEND=0`。

## バックエンドの切り替え

どれも OpenAI 互換の `/v1/chat/completions` を話すので、環境変数2つで入れ替わる。

| backend   | `LLM_BASE_URL`              | 備考                                           |
| --------- | --------------------------- | ---------------------------------------------- |
| LM Studio | `http://localhost:1234/v1`  | GUI から Local Server を起動。**動作確認済み** |
| Ollama    | `http://localhost:11434/v1` | `ollama serve`。常駐向き                       |
| llama.cpp | `http://localhost:8080/v1`  | `llama-server -m model.gguf`                   |

必要なら `LLM_API_KEY`、`LLM_SYSTEM_PROMPT` も環境変数で指定できる。

## 環境変数

| 変数                     | 既定                                 | 説明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMCON_TOKEN`            | (必須)                               | 共有トークン。Even App・WebUI・CLIの認証に使う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TMCON_SESSION_METADATA` | `~/.tmcon/session-metadata.json`     | アーカイブ状態と、最後に指定されたモデル(セッション単位＋provider 枠のグローバル既定)などterminal-mode-console固有のセッション情報                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TMCON_LANG`             | (OS ロケール)                        | サーバー/CLI のログ・メッセージの表示言語。`locales/` にある言語コード(`ja`/`en` など)を指定。未指定なら `LC_ALL`→`LC_MESSAGES`→`LANG` から判定し、該当が無ければ英語。WebUI はこれと無関係にブラウザの言語で選ぶ                                                                                                                                                                                                                                                                                                                                                                                   |
| `PORT`                   | 3456                                 | 待ち受けポート                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PROVIDER_CLAUDE`        | `claude`                             | `claude` 枠に割り当てる実体(`claude` / `local` / `echo`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PROVIDER_CODEX`         | `codex`                              | `codex` 枠に割り当てる実体(`codex` / `claude` / `local` / `echo`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CLAUDE_MODEL`           | (Claude Code の既定)                 | Claude のモデル未指定時の既定。エイリアス(`opus`/`sonnet`/`haiku`/`fable`/`default`)かフル ID。WebUI のプルダウンや API の `model` 指定、サーバーが記憶した値の方が優先される                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CODEX_MODEL`            | (Codex の既定)                       | Codex のモデル未指定時の既定。WebUI のプルダウンや API の `model` 指定、サーバーが記憶した値の方が優先される                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CODEX_SANDBOX`          | `workspace-write`                    | Codex の sandbox (`read-only` / `workspace-write` / `danger-full-access`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CODEX_APPROVAL_POLICY`  | `on-request`                         | Codex の承認方針                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CODEX_APPROVE_FOR_ME`   | `1`                                  | Codex の許可要求を自動レビューする。`0` で無効化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CODEX_REASONING_EFFORT` | (Codex の既定)                       | Codex の reasoning effort。選択モデルの `supportedReasoningEfforts` に無い値は送らず、モデル既定に委ねる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CODEX_COMMAND`          | `codex`                              | App Server を起動する Codex コマンド                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LLM_BASE_URL`           | `http://localhost:11434/v1`          | OpenAI 互換エンドポイント                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LLM_MODEL`              | (接続先の一覧から自動選択)           | モデルを固定する。任意 — 未設定なら接続先の一覧からロード済みのモデルを使う。設定する場合はバックエンドが返す ID をそのまま入れる(存在しない ID は拒否されるので、誤った値は未設定より悪い)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LLM_API_KEY`            | `not-needed`                         | ローカルは通常不要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LLM_SYSTEM_PROMPT`      | (グラス向け簡潔指示)                 | システムプロンプト                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LLM_PERSIST`            | `1`                                  | ローカルLLMの会話をJSONL保存。`0`で無効                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `LLM_STORE_DIR`          | `~/.tmcon/sessions`                  | ローカルLLMセッションの保存先                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LLM_TOOLS`              | `1`                                  | ローカルLLMにツール(bash/grep/read_file/view_image/list_dir)を持たせる。`0`で無効                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LLM_TOOLS_AUTO_ALLOW`   | `read_file,grep,list_dir,view_image` | 確認なしで通すツール名(カンマ区切り)。`bash` は既定で毎回確認                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LLM_TOOLS_TIMEOUT`      | `30`                                 | bash/grep の実行タイムアウト秒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LLM_TOOLS_MAX_IMAGE`    | `8388608`                            | `view_image` が読む画像の上限バイト数(既定 8MB)。超えると縮小を促す                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LLM_TOOLS_MAX_ROUNDS`   | `8`                                  | 1ターン内でのツール往復の上限(暴走止め)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `LLM_DEBUG_DUMP`         | (無効)                               | デバッグ用: バックエンドとの全リクエスト/レスポンスを JSONL 記録する——リクエストの body 全体(システムプロンプト・履歴・生の base64 `image_url` データURL・tool 定義)と応答(reasoning・本文・tool 呼び出し・エラー)。値: `1`/`true` → `<LLM_STORE_DIR>/debug/<sessionId>.jsonl` にセッションごと出力 / `.jsonl` で終わるパス → 全セッション1ファイルに集約 / それ以外のパス → そのディレクトリに `<sessionId>.jsonl` をセッションごと出力。未設定/`0` は無効(オーバーヘッドなし。モデルに渡すコンテキストには一切影響しない)。ファイルは急速に肥大化し画像データ全体を含むため、ローカルデバッグ専用 |
| `MAX_PROMPT_IMAGE_CHARS` | `25165824`                           | `/api/prompt` に添付できる画像の総量(base64 文字数の合計。既定 24MB 文字)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SESSIONS_LIMIT_DEFAULT` | `100`                                | `/api/sessions` で `?limit=` 省略時に返す件数(自前ストアの一覧既定も兼ねる)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SESSIONS_LIMIT_MAX`     | (無制限)                             | `/api/sessions` の `?limit=` に許す上限。未設定/0 で無制限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `HISTORY_LIMIT_DEFAULT`  | `100`                                | `/api/sessions/:id/history` で `?limit=` 省略時に返す履歴件数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `HISTORY_LIMIT_MAX`      | (無制限)                             | `/api/sessions/:id/history` の `?limit=` に許す上限。未設定/0 で無制限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `STALL_WARN_MS`          | `120000`                             | 最後の意味あるエージェントイベントからこの時間経つと WebUI で `No activity` とし、同じ無活動区間につき薄字通知を1回流す。停止判定や自動中断はしない。`0` でログ通知を無効化(liveness表示は継続)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ANNOUNCE_BACKEND`       | `1`                                  | セッション開始時に接続先を1度知らせる。`0` で無効                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LOG_REQUESTS`           | `1`                                  | リクエストごとの診断ログ行(時刻・アクセス元・ステータス・メソッド・パス・応答時間・クライアント種別)を出す。`0` で無効                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TRUST_PROXY`            | `1`                                  | 前段プロキシ(`tailscale serve` 等)が付ける `Tailscale-User-Login` / `X-Forwarded-For` ヘッダを信用し、リクエストログにループバックのプロキシではなく実アクセス元を出す。TCP接続元がループバックのときだけ信用するので、LAN 直結クライアントは送信元を偽装できない。`0` で無効(生の TCP 接続元を記録)                                                                                                                                                                                                                                                                                                |

## 構成

```text
server.mjs        トランスポートの殻(REST+SSE+auth+ルーティング)。触らない。
bus.mjs           セッション状態・SSE配信・権限/質問の往復・ターンのFIFO実行。
session-metadata.mjs  上流を変更しないアーカイブ等の表示メタデータ。
i18n.mjs          server/CLI 共有の翻訳ローダ。locales/ を読み、環境ロケールで言語を選ぶ。
locales/          翻訳辞書 <tag>.json。BCP 47 タグで命名(en, ja, zh, zh-Hant, pt-BR など)。
                  server・CLI・WebUI が共有(WebUI へは /locales/ で配信)。言語を足すときは
                  locales/<tag>.json を1枚置くだけ。解決は「詳細 → 基底言語 → 英語」の順にフォールバック
                  (地域から用字を推定。例 zh-TW → zh-Hant → zh)するので、バリアントは部分訳でよい。
web/index.html    WebUI本体(依存ゼロ)。
web/tagged-markdown.js  独自タグで囲まれたプロンプトメタデータの分割処理。
web/manifest.webmanifest  PWA マニフェスト(ホーム画面追加/standalone 起動)。
web/icon.svg / icon-192.png / icon-512.png / apple-touch-icon.png
                  PWA アイコン(icon.svg が原本。PNG は convert で生成しコミット済み)。
bin/tmcon-cli.mjs  端末クライアント(依存ゼロ)。
agents/
  index.mjs       provider名 → アダプタ の登録。
  echo.mjs        依存ゼロの参照実装(アダプタの最小形)。
  local-llm.mjs   本命。OpenAI互換ストリーミングを text_delta に変換。ツール往復のループを回す。
  tools.mjs       ローカルLLM用ツール(bash/grep/read_file/list_dir)の定義・実行・許可判定。
  store.mjs       会話をJSONL永続化する最小ストア(local-llm が使用)。
  claude.mjs      Claude Code(任意依存)。セッションごとに query() を1本張り、
                  ストリーミング入力でターンを流す。モデルは Query.setModel() で切替。
                  画像添付は Anthropic の image ブロックに載せて渡す(Vision 対応)。
```

> **クライアントを自作する場合の注意**: `POST /api/prompt` の前に SSE を張ること。
> 先に送るとそのターンのイベントを丸ごと取りこぼす。`tmcon-cli` は初回接続が
> 完了するまで入力を受け付けないようにしている。

## 新しいバックエンドの足し方

`agents/<name>.mjs` を1つ書き、`agents/index.mjs` で `register` するだけ。
実装するのは実質 `runTurn` 1つ:

```js
export default {
  name: "mybackend",
  async listSessions(limit, cwd) {
    return [];
  }, // 無ければ空でよい
  async getHistory(session, limit) {
    return [];
  },
  async runTurn({ session, text, emit, ask }) {
    emit({ type: "text_delta", text: "..." }); // グラスに出す本体
    // await ask.permission({toolName, description, options:[{text,key}]});  // 権限が要るなら
    emit({
      type: "result",
      success: true,
      text: "...",
      sessionId: session.id,
      provider: this.name,
    });
  },
};
```

`emit` がグラスへの唯一の窓口。`text_delta` が本文、`result` がターン確定。

### グラスの再接続状態を検知する

アプリは SSE 切断後も一覧ポーリング(`GET /api/sessions`)だけは続ける。これを利用して、
**「Dart が最近ポーリングしているのに Dart の SSE が0本」= アプリは起動しているが
再接続に来ていない**、と判定できる(サーバー再起動後によく起きる状態)。

- `GET /api/app-health` … `{glassesPolling, glassesSse, glassesStale, sseClients}`
- `GET /api/info` の `app` フィールドにも同じ内容が入る
- 該当時はサーバーログに `[app] ⚠ …` を1度出す
- WebUI は該当時に上部へ警告バナーを出す(アプリ再起動を促す)

SSE 接続は UA で種別分けして数える(dart=グラス / web=WebUI / cli)。WebUI や CLI が
繋がっていてもグラスの未接続を誤検知しない。

## 設計上の注意(実機で確認した挙動より)

- **プロセスを落とさないこと**。アプリは SSE 切断を検知せず自動再接続しない。
  再起動すると、アプリ側は「開いたことのないセッション」以外すべて無反応になり、
  アプリ再起動でしか復旧しない。ホットリロード構成は避ける。
- **SSE 認証は `?token=` クエリ**。アプリは SSE でヘッダを送れない。ここを外すと
  REST は通るのに画面だけ無反応になり、原因特定が難しい。
- **`status: think_start` で「Thinking...」を出せる**。最下行はこのイベントで切り替わる
  (実機確認済み)。`think_end` で戻る。`busy` は可視ラベルを持たないので単体では効かない。
  経過秒カウンタだけはアプリのローカルタイマー駆動。
- **権限・質問の応答待ちにタイムアウトを置かない**。公式サーバーは 60 秒 / 120 秒で
  deny / "skip" を自動送信するが、それだと考えている間に勝手に答えが確定し会話が進む。
  terminal-mode-console は**応答か明示的な中断まで待つ**。待機中は `status:waiting`(拡張)と
  薄字の `notification` で全クライアントに知らせ、待機中に繋ぎ直したクライアントには
  要求を**再送**する(リロードで誰も答えられなくなるのを防ぐ)。
- **確実に伝えたい進捗やエラーは `text_delta` 本文に書く**。`running_stats` /
  `task_progress` はアプリがほぼ使わない。
- **ターンはセッション単位で直列実行する**。クライアントが複数ある以上、
  同時に prompt が届く。並行実行すると会話履歴が混線するため、`bus.enqueue()` が
  FIFO で捌く。`POST /api/prompt` の応答に `queued`(待ち順)が入る。
- グラス上で見えるのは `text_delta`(本文)・`tool_end` の `summary`・`notification`(薄字)・
  `error`(通常字)。`detail` は表示されない。**簡潔さが正義**(画面が小さい)。
- **Codex の失敗を無言で `idle` に戻さない**。App Server の `error` 通知は再試行中にも
  発生するため直ちには表示せず、ターンが最終的に `failed` になったときだけ、その理由を
  `error` として流す。usage limit・認証・コンテキスト上限など本文を生成できない失敗も、
  最下行が `Waiting input` に戻る前に理由が画面へ残る。
- **cwd の絞り込みは2段構え**。基本は取得済みの直近一覧(WebUI 30 件 / CLI 20〜50 件)を
  cwd の部分一致でクライアント側から絞る。加えて、cwd 欄/`--cwd` に**絶対パス**が入ったときは
  `GET /api/sessions?cwd=<dir>` を送り、Claude 枠ではそれが SDK の `listSessions({ dir })` に
  なる。**dir スコープはそのディレクトリのセッションを網羅**するので、全体の直近一覧から
  外れた更新の古いセッションも拾える(`claude` をその cwd で直接 resume したときと同じ範囲)。
  スコープ結果は全体一覧とマージして表示する。
- ただし **cwd が部分文字列(絶対パスでない)のときはスコープ取得できない**。SDK の `dir` は
  実在ディレクトリの完全一致を要求するため。この場合は従来どおり直近一覧に対する部分一致
  だけになり、取得窓の外の古いセッションは現れない(絶対パスで指定するか、`--session <id>`
  で直接開く)。サーバー側の `bus.listSessions` / ローカルストア `store.list` 自体は cwd で
  絞らない(dir スコープは Claude アダプタの `listSessions({ dir })` 側で効く)。
- **新規作成の cwd は自由入力**なので、履歴にも実在候補にも無いディレクトリでも開始できる。

HTTP API の詳細は [`protocol.md`](protocol.md) を参照。

## セキュリティ

このサーバーは単一トークン + CORS 全開放で、任意パス走査(`/api/fs/dirs`)や実質 RCE
(`POST /api/prompt`)を許す。ブラウザの任意ページからも `?token=` 付きで叩けるので、
**露出面は最小に、トークンは推測不能に**保つこと。

- **待ち受けは既定でループバックのみ**(`127.0.0.1`)。外部からは直接届かない。到達性は
  前段の TLS プロキシ(**`tailscale serve` 推奨** — 証明書は自動発行・自動更新、ブラウザとは
  HTTP/2 になるので SSE を多数タブで張っても HTTP/1.1 の 6 接続制限に当たらない)に持たせる:

  ```bash
  # terminal-mode-console はループバックのまま起動し、tailnet 側の 3456 を serve に譲る
  tailscale serve --bg --https=3456 http://127.0.0.1:3456
  # → https://<magicdns-name>:3456?token=XXXX&defaultProvider=claude で開く
  ```

- **グラス/スマホからLAN直結したいときだけ** `HOST=0.0.0.0`を明示する。これはTailscaleだけでなく、
  LANを含む全ネットワークインターフェイスで待ち受ける設定である。インターネット側や公共Wi-Fi、
  信頼できない端末からポートへ到達できないことを、ルーターとホストのファイアウォール設定で
  確認できる環境に限って使用する。同じLANに信頼できない端末がある場合も使用しない。

  ```bash
  HOST=0.0.0.0 TMCON_TOKEN=$(openssl rand -hex 16) node server.mjs
  ```

- `HOST` は任意のアドレスを取れる(例: Tailscale IP のみで待ち受けるなら `HOST=100.x.y.z`)。
