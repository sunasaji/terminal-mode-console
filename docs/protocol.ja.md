English: [protocol.md](protocol.md)

# even-terminal 互換 HTTP API メモ(v0.8.1 時点)

Even Realities G2 の Terminal Mode アプリが話す HTTP API の、相互運用に必要な範囲のメモ。
terminal-mode-console はこの通りに実装している。

**情報源**は次の 2 つで、いずれも自分の端末の範囲で完結している:

1. `@evenrealities/even-terminal@0.8.1`(MIT ライセンスで npm 公開)のソースの読解
2. 自分のアプリと、自分が起動したサーバーとの間の HTTP / SSE 通信の観察

以下に載せた JSON は、フィールドの構造を示すために**値を差し替えた例**であり、
実際の通信内容そのものではない。プロジェクトの位置づけは [`../NOTICE.md`](../NOTICE.md) を参照。

> このメモは特定バージョンの観察に基づく。上流の変更で古くなる可能性がある。

## 1. トランスポート

- 素の Express 5。`app.listen(PORT, "0.0.0.0")`、既定ポート **3456**
- 独自プロトコル・署名・証明書ピン留め・デバイス登録は **一切なし**
- WebSocket はアプリ通信には使わない(codex app-server との内部接続専用、既定 8765)

## 2. 認証

共有トークン 1 個のみ。以下の 2 経路を両方受け付ける:

```http
Authorization: Bearer <token>
?token=<token>
```

### アプリ側の使い分け

**REST と SSE で経路が違う。互換サーバーは両方に対応必須。**

| 通信                    | 認証方法                                                        |
| ----------------------- | --------------------------------------------------------------- |
| REST 全般               | `Authorization: Bearer <token>` ヘッダ                          |
| **SSE (`/api/events`)** | **`?token=<token>` クエリのみ。Authorization ヘッダを送らない** |

SSE でヘッダを使わないのは、Dart の EventSource 系クライアントが
任意ヘッダを設定できないためと思われる。**ヘッダ認証だけを実装すると
SSE が 401 になり、画面が永久に無反応になる。**

- 既定値は `randomBytes(16).toString("hex")`、**`TMCON_TOKEN` 環境変数で固定可能**
- 不一致は全エンドポイントで `401 {"error":"Unauthorized"}`
- トークンは `~/.even-terminal/instances/<pid>.json`(mode 0600)に平文保存

## 3. CORS

`app.use(cors())` 全開放。OPTIONS 応答:

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
```

## 4. ペアリング

QR の中身は **ただの URL**:

```text
http://<host>:<port>?token=<token>&defaultProvider=<claude|codex>[&name=<EVEN_TERMINAL_NAME>]
```

`buildClientQuery()` が生成。公開トンネル(bore / ngrok / pinggy)使用時はホスト部が置き換わるだけ。

## 5. エンドポイント

すべて `/api` 配下。★ = 表示に最低限必要。

| メソッド | パス                                     | 備考                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET ★    | `/events?sessionId=&needReplay=`         | SSE。§6 参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST ★   | `/prompt`                                | `{text, images?, sessionId?, provider?, cwd?, model?}` → **202** `{ok, sessionId, provider, queued, model}`。拡張: `model` はこのターンで使うモデル(Claude はエイリアス/フルID、Codex は `model/list` の具体ID)。省略時は「この会話 or provider 枠で最後に指定されたモデル → provider の env (`CLAUDE_MODEL` / `CODEX_MODEL` / `LLM_MODEL`) → backend 既定(ローカル LLM は OpenAI 互換 API に「サーバーに任せる」が無いため、接続先の一覧からロード済みのモデルを選ぶ)」の順で解決。指定すると記憶し、以降 UI を持たないクライアント(グラス)もそれを引き継ぐ。**ユーザーが明示的に選んだときだけ載せる**こと(現在有効なモデルを画面に出しているだけの状態で載せ返すと、ただ引き継ぐはずの場面が明示指定になり、意図しないモデル切替が起きる)                                                 |
| GET ★    | `/sessions?provider=&cwd=&limit=`        | `{sessions:[{id,title,timestamp,cwd,provider,status,startedAt?,lastActivityAt?,activityKind?,stallWarnMs?,archived?}]}`。liveness はメモリ上で実行中の前景ターンだけ。`limit` 省略時は `SESSIONS_LIMIT_DEFAULT`(既定 **100**)、上限は `SESSIONS_LIMIT_MAX`(既定 **無制限**)。拡張: `includeArchived=1`でterminal-mode-console側のアーカイブも含める                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST     | `/sessions/archive`                      | terminal-mode-console拡張。`{sessionId,provider,archived,snapshot?}`。上流の会話は変更せず一覧表示用メタデータだけを保存。実行中・回答待ちはアーカイブ不可                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET ★    | `/info?provider=&sessionId=`             | `{account:{email,organization,subscriptionType}, model, version, provider}`。拡張: `backend.models`(provider のモデル選択肢。`[{value,label,noteKey?}]`。Claude はエイリアス、Codex は `model/list` 由来、ローカル LLM は判別した実装のネイティブ API 由来(切替できない場合 — 例: llama.cpp の単一モデルモード — は空配列)。`label` は言語非依存、`noteKey` は WebUI 側で訳す補足の i18n キー)、`currentModel`(sessionId 指定時はその会話、無指定時は provider 枠の記憶モデル。未設定なら `null`)、`backend.reachable`(ローカル LLM のみ。接続に失敗したと分かったとき `false`。401 のように応答が返って拒否された場合は到達扱い。初回の判定前は `null`)、`backend.autoModel`(ローカル LLM のみ。モデル未指定時に実際に使われるモデルの表示名。クライアントが「自動」の実体を示すために使う) |
| GET      | `/messages?sessionId=&after=`            | SSE 取りこぼし復旧。`{messages:[{id,...msg}], state, sessionId, provider}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET      | `/status?sessionId=`                     | `{state, sessionId, provider, startedAt, lastActivityAt, activityKind, stallWarnMs}`。時刻は epoch milliseconds、前景非実行時/不明時は `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET      | `/sessions/:id/history?limit=`           | `{history:[{role,text}]}`。`limit` 省略時は `HISTORY_LIMIT_DEFAULT`(既定 **100**)、上限は `HISTORY_LIMIT_MAX`(既定 **無制限**)。拡張: エージェントの質問は `{role:"assistant",kind:"question",questions:[…],answers:{…}}`(回答済みのみ)も混ざる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST     | `/permission-response`                   | `{sessionId, decision}` decision: `allow`/`allowAlways`/`deny`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST     | `/question-response`                     | `{sessionId, answer}` answer は JSON 文字列 or 素の文字列                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST     | `/interrupt`                             | `{sessionId}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST     | `/model`                                 | terminal-mode-console拡張。`{sessionId, provider, model}` → `{ok, sessionId, provider, model}`。プロンプト送信前にモデル選択を記憶する(WebUI のプルダウン変更時)。セッション単位 + provider 枠のグローバル既定の両方を更新し、`~/.tmcon/session-metadata.json` に永続化。`model:""` は記憶の**解除**(両方を削除し「指定なし」へ戻す)で、応答の `model` は `null`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET      | `/update-check`                          | `{packageName,currentVersion,newestVersion,updateAvailable,checkedAt}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET      | `/metrics`                               | `{codex:{subscribedSessions:[]}}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET      | `/debug/thread/:id`, `/debug/status/:id` | スタブ可                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`provider` は `SUPPORTED_PROVIDERS = ["claude","codex"]` でバリデートされ、外れると 400。
**自作サーバー側では任意のプロバイダ名を通せる**(アプリの選択 UI は 2 択なので、
`defaultProvider=claude` を受けて内部で振り分けるのが実際的)。
terminal-mode-console はこの2枠に加え、登録済みの実体名(`local` / `echo` など)を
provider として直接受け付ける。アプリが送るのは2枠だけなので互換性は保たれる。

## 6. SSE (`GET /api/events`)

ヘッダ:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

- 接続直後に `:ok\n\n`
- フレーム形式は `id: <n>\ndata: <json>\n\n`(連番 id)
- `needReplay=true` でリングバッファ(**セッションあたり最大 500 件**)を全再送
- **再接続時の追いつき(terminal-mode-console 拡張)**: `Last-Event-ID` ヘッダ、または
  `?lastEventId=<n>` クエリを受けると、その id **以降**だけをリングバッファから
  順序どおり再送する。切れていた間に流れた `text_delta` / `tool_end` や、
  応答待ちの `permission_request` / `user_question` に、繋ぎ直しで追いつける。
  - EventSource の自動再接続は `Last-Event-ID` を標準で送る(ヘッダ経路)。
  - WebUI は前面復帰時にこちらから明示的に張り直す。新規 EventSource は
    ヘッダを持てないので、追跡済みの id を `?lastEventId=` で渡す(クエリ経路)。
  - リプレイ後には、現在未回答の `permission_request` / `user_question` を状態
    スナップショットとして必ず再送する。待機要求には安定した `requestId` が付き、
    WebUI は同じ要求の再送を冪等に扱うためカードや入力途中の回答を保持する。
- **15 秒ごと** に `:heartbeat\n\n`

heartbeat は接続維持専用で、下記のエージェント活動時刻を更新しない。EventSource の切断は
WebUI の `Reconnecting...` で示し、エージェントがイベントを発していない状態とは区別する。

### 前景ターンの liveness (terminal-mode-console 拡張)

`startedAt` は現在の前景ターン開始、`lastActivityAt` は最後に意味のあるエージェントイベントを
観測した epoch milliseconds、`activityKind` はそのイベント種別である。活動は
`think_start/end`、`text_start/delta/end`、`tool_start/end`、`result`。SSE heartbeat、接続、
notification(無音警告自身を含む)、表示タイマー、ユーザー回答待ちは活動に含めない。

値は停止や仕事の有用性を断定しない。イベントを出さない正常な長時間処理でも
`No activity` になり得る。`STALL_WARN_MS` 到達時の notification は同じ無活動区間で1回だけで、
ターンの自動中断・プロセスの自動再起動は行わない。`status:waiting` 中は警告せず、
前景終了後に届く `status:background` とその後続イベントは前景 liveness に混ぜない。

### イベント型

観察できた全種。値は例:

```jsonc
{"type":"user_prompt","text":"..."}
{"type":"status","state":"busy|idle|think_start|think_end|text_start|text_end","sessionId":"..."}
{"type":"text_delta","text":"部分的な"}                 // 数文字単位で高頻度
{"type":"tool_start","name":"Read","toolId":"<toolUseId>"}
{"type":"tool_end","name":"WebSearch","toolId":"<toolUseId>","summary":"Search \"...\"","detail":{"input":{},"output":""}}
{"type":"running_stats","durationMs":140013,"inputTokens":26384,"outputTokens":813}  // 10秒間隔
{"type":"result","success":true,"text":"...","sessionId":"...","costUsd":0.0142,"provider":"claude","turns":1,"durationMs":14936,"inputTokens":0,"outputTokens":0,"model":"claude-opus-4-6"}  // model は拡張: このターンで実際に使われた具体モデルID(Claude / Codex。取れなければ null)
{"type":"user_question","questions":[{"question":"...","header":"...","options":[{"label":"","description":"","preview":""}]}],"toolUseId":"..."}
{"type":"question_answer","answers":{"<question>":"<label>"}}
{"type":"permission_request","toolName":"Bash","description":"...","detail":"...","toolUseId":"...","options":[{"text":"Yes","key":"allow"}],"suggestions":null}
{"type":"permission_result","toolName":"...","summary":"...","decision":"allowed|always|denied"}
{"type":"task_progress","completed":3,"total":5,"current":"..."}
{"type":"notification","title":"...","message":"..."}
{"type":"error","message":"..."}
```

Codex App Server は、再試行可能な問題を `error` 通知した後、ターンの最終結果を
`turn/completed` の `status` で通知する。terminal-mode-console は途中の `error` をいったん保持し、
最終結果が `failed` の場合だけ上記の `error` イベントへ変換する。これにより usage limit
などでアシスタント本文が空のまま失敗しても、理由を表示してから `status:idle` へ戻る。
再試行で成功した場合、途中のエラーは表示しない。

terminal-mode-console の拡張(公式には無い。未知フィールド/未知 state はアプリが無視する):

```jsonc
{"type":"status","state":"waiting","waitingFor":"permission|question","label":"許可 Bash","sessionId":"..."}
{"type":"status","state":"background","count":1,"sessionId":"..."}   // バックグラウンドエージェント実行中
{"type":"permission_result","decision":"denied","cancelled":true}   // 中断で待ちを解いた
{"type":"question_answer","answers":{...},"cancelled":true}
```

#### バックグラウンドエージェントの可視化(claude バックエンド)

Claude Code 2.1.2xx の Agent(サブエージェント)ツールは既定でバックグラウンド実行される。
前景ターンはサブエージェントを起動して即 `result` を返し(`bus` は `idle` を流す)、完了は
後から task-notification 起点の後続イベントとして届く。このとき最下行が `Waiting input` の
ままだと「実行中/完了/停止」が区別できないため、次を出す:

- 実行開始(0→1件): `notification`「⏳ バックグラウンド実行中」+ 拡張 `status:background`
- サブターン完了(まだ他が走行中): `notification`「バックグラウンド更新」(本文に途中経過)
- 全完了(→0件): `notification`「✅ バックグラウンド完了」+ `status:idle`
- 中断: `notification`「⏹ バックグラウンド停止」+ `status:idle`

グラス純正アプリは未知の `status:background` を無視するので、消えない dim の
`notification` 行が区別の主手段になる。WebUI は `status:background` を最下行に
「バックグラウンド実行中」として表示する。

`bus` は前景ターンが空になったとき、無条件に `idle` を流すのではなくアダプタの
`backgroundStatus(session)` を問い合わせ、バックグラウンドが走っていれば `idle` の
代わりにその `status:background` を流す。これにより前景ターン終了後も WebUI が
一瞬 `Waiting input` に戻ることがなくなり、実行中はそのまま「バックグラウンド実行中」を
保つ(全完了時にアダプタが `idle` を流して `Waiting input` に戻す)。

### 1ターンのイベント順序

```text
user_prompt → status:busy
  → [status:think_start → status:think_end]        # 拡張思考時
  → [tool_start → tool_end]*                       # ツール使用ごと
  → status:text_start → text_delta* → status:text_end
  → result → status:idle
```

`running_stats` は busy 中に 10 秒間隔で割り込む。

## 7. タイムアウト

公式実装の値:

- 権限応答待ち: **60 秒**(無応答なら deny)
- 質問応答待ち: **120 秒**(無応答なら "skip")
- SSE ハートビート: 15 秒

**terminal-mode-console はこの2つの応答待ちタイムアウトを意図的に採用していない。** 無応答で
自動確定させると、ユーザーが考えている最中に勝手に答えが決まり、そのまま会話が
先へ進む(実際に AskUserQuestion の3択が提示 120 秒ちょうどで "skip" 扱いになり、
モデルが自分の推奨案で続行した)。terminal-mode-console は**ユーザーの応答か明示的な中断
(`POST /api/interrupt`)まで無期限に待つ**。SSE ハートビートは 15 秒のまま。

無期限に待つ以上、待っていることが見えなければならないので、次を足している:

- 待機に入ったら `status:waiting`(拡張)と `notification` を流す。
  グラスは未知の `status` を無視するので、薄字1行になる `notification` が保険になる。
- **応答待ちのまま SSE を張り直したクライアントには、待っている要求を再送する**
  (WebUI のリロードやアプリ再起動、スマホの前面復帰で誰も答えられなくなるのを防ぐ)。
  増分/全件リプレイの有無にかかわらず現在状態として再送し、WebUI は `requestId` で
  同じ要求を識別して二重表示や入力途中の回答の消失を防ぐ。
- 中断で待ちを解いたときの `permission_result` / `question_answer` には
  `cancelled: true`(拡張)を付ける。誰も答えていないことを区別するため。

## 7.5 アプリ側の振る舞い

クライアントは Flutter / Dart 製 (`User-Agent: Dart/3.11 (dart:io)`)、`accept-encoding: gzip`。

### セッション一覧

`GET /api/sessions?provider=claude` を **10 秒間隔でポーリング**。

### 新規セッション作成

**API 通信は一切発生しない。** アプリ内のローカル状態にすぎず、サーバー上の
セッションは最初のプロンプトで生成される。**「セッション作成 API」は不要。**

### プロンプト送信(新規セッション)

**未使用フィールドを省略せず、明示的に `null` で送ってくる**:

```json
{ "text": "こんにちは", "sessionId": null, "cwd": null, "provider": "claude" }
```

`cwd: null` なので **新規セッションの cwd はサーバー側の `PROJECT_DIR`(起動時 cwd)で決まる**。
互換サーバーは `sessionId` / `cwd` が `null` で来る前提で書くこと
(`if (sessionId)` 相当の判定なら null 安全)。

### プロンプト送信(既存セッション)

**新規と違い `cwd` に実値が入る**(一覧 API で返した cwd がそのまま返ってくる):

```json
{
  "text": "…",
  "sessionId": "<sessionId>",
  "cwd": "/path/to/project",
  "provider": "claude"
}
```

つまり `cwd` が null なのは新規セッションの時だけ。互換サーバーは
**null(=既定 cwd を使う)と実値(=それを使う)の両方**を扱えること。

### 画像付きプロンプト(拡張・任意)

グラスアプリは送ってこないが、WebUI 等の自作クライアント向けの拡張フィールド。
`images` に **data URL か生 base64 の文字列配列**を載せると、Vision 対応バックエンドが
user メッセージに画像を差し込む。`text` は省略可(画像のみ可)。
`local`(OpenAI Vision 形式の `image_url`)と `claude`(Anthropic の image ブロック)の
両バックエンドが対応する。`claude` は画像があるときだけ prompt をストリーミング入力形式に
切り替えて content 配列へ載せる(画像なしは従来どおり文字列 prompt)。

```json
{
  "text": "この画像を説明して",
  "images": ["data:image/png;base64,iVBORw0..."],
  "sessionId": null,
  "provider": "codex"
}
```

総量は `MAX_PROMPT_IMAGE_CHARS`(base64 文字数の合計)で制限。超過は **413**。
`images` が文字列配列でなければ **400**。会話の文脈で画像ファイルを解析させたい場合は、
モデルに `view_image` ツールを呼ばせる経路もある(README「ローカル LLM のツール利用」参照)。

### セッション使用量(WebUI 拡張・任意)

`GET /api/usage?sessionId=<id>&provider=<claude|codex>` は、WebUI のステータス行に出す現在の
コンテキスト使用率とプラン枠使用率を返す。WebUI はセッション接続時と `status:idle`
(ターン完了)時に取得する。

```json
{
  "available": true,
  "context": { "utilization": 50 },
  "fiveHour": { "utilization": 40, "resetsAt": "2026-09-13T10:00:00Z" },
  "sevenDay": { "utilization": 30, "resetsAt": "2026-09-20T10:00:00Z" }
}
```

`utilization` は 0〜100 の百分率、`resetsAt` は ISO 8601。WebUI は `resetsAt` を
ブラウザのローカル時刻へ変換し、`年月日(曜日) 時:分`（秒なし）で表示する。個別の値を取得できない場合は
その項目を `null` にできる。バックエンドが使用量取得に未対応、または接続種別の都合で
取得できない場合は `{"available":false}` を返し、WebUI は使用量欄を表示しない。
Claude は Agent SDK の構造化 context/usage、Codex は rollout に保存された最新の
`token_count` を情報源とする。これは純正グラスアプリが使用する API ではなく、
互換サーバー独自の拡張である。

### 権限リクエストの往復

サーバー → アプリ(SSE):

```json
{
  "type": "permission_request",
  "toolName": "Bash",
  "description": "Bash Create a directory",
  "detail": "mkdir -p /tmp/example",
  "toolUseId": "<toolUseId>",
  "options": [
    { "text": "Yes", "key": "allow" },
    {
      "text": "Yes, and always allow Bash rule `mkdir -p /tmp/example` in local settings",
      "key": "allowAlways"
    },
    { "text": "No", "key": "deny" }
  ],
  "suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "mkdir -p /tmp/example" }],
      "behavior": "allow",
      "destination": "localSettings"
    },
    {
      "type": "addDirectories",
      "directories": ["/tmp"],
      "destination": "session"
    }
  ]
}
```

アプリ → サーバー(REST):

```json
POST /api/permission-response
{"sessionId":"<sessionId>","decision":"allow","provider":"claude"}   → 200 {"ok":true}
```

- **`decision` は `options[].key` がそのまま返る**(`allow` / `allowAlways` / `deny`)。
  アプリは `text` を表示し、`key` を送る。互換サーバーは options を自由に定義できる。
- グラス上で読んで選択するまで、実測で 10 秒強。公式の 60 秒タイムアウトには収まるが、
  迷えば当然超える(terminal-mode-console が待ち続ける理由は §7)。
- 直後に `permission_result` が流れる(`decision` は `allowed` / `always` / `denied` に
  **変換される** — リクエスト側の語彙と綴りが違う点に注意)。

### 質問応答の往復

サーバー → アプリ(SSE)。**複数問を1回で送れる**:

```json
{
  "type": "user_question",
  "toolUseId": "<toolUseId>",
  "questions": [
    {
      "question": "好きな色はどちらですか？",
      "header": "好きな色",
      "options": [
        { "label": "赤", "description": "赤色が好き", "preview": "" },
        { "label": "青", "description": "青色が好き", "preview": "" }
      ]
    },
    {
      "question": "好きな季節はどちらですか？",
      "header": "好きな季節",
      "options": [
        { "label": "夏", "description": "夏が好き", "preview": "" },
        { "label": "冬", "description": "冬が好き", "preview": "" }
      ]
    }
  ]
}
```

アプリ → サーバー(REST)。**`answer` は JSON を文字列化した二重エンコード**:

```json
POST /api/question-response
{"sessionId":"<sessionId>",
 "answer":"{\"好きな色はどちらですか？\":\"赤\",\"好きな季節はどちらですか？\":\"冬\"}",
 "provider":"claude"}
  → 200 {"ok":true}
```

**最重要**: `answer` は**オブジェクトではなく文字列**。中身は
`{質問文: 選んだ label}` の JSON。サーバー側は `JSON.parse(answer)` し、
失敗したら「全質問に同じ文字列」とみなすフォールバックを持つ。

- キーは `header` ではなく **`question` の全文**。
- 値は `options[].label` そのまま(`description` ではない)。
- `JSON.parse` の成否で分岐する実装にすること(素の文字列が来る経路も残っている)。

確定後、サーバーは `question_answer` を SSE に流す(こちらは**パース済みオブジェクト**):

```json
{
  "type": "question_answer",
  "answers": {
    "好きな色はどちらですか？": "赤",
    "好きな季節はどちらですか？": "冬"
  }
}
```

2 問選択で実測 13 秒。公式のタイムアウトは 120 秒(terminal-mode-console は無期限 — §7)。

### 1ターンの通信順序

```text
T+0ms      POST /api/prompt              → 202 {ok, sessionId, provider}
T+325ms    GET  /api/events?token=…&sessionId=<202で得たID>   ← SSE は後から張る
T+1.8s     SSE  status:text_start
T+1.8s     SSE  text_delta …
T+2.0s     SSE  status:text_end
T+2.1s     SSE  result
T+2.6s     SSE  status:idle
```

重要な含意:

- **SSE は POST の後に張る**。202 で返った `sessionId` を使って接続する。
- そのため **`user_prompt` と `status:busy` は取りこぼされる**(接続前に発火済み)。
  アプリはこれを気にしない = 互換サーバーも取りこぼし前提でよい。

### 既存セッションを開く

```text
T+0ms      GET /api/events?token=…&sessionId=<sessionId>                  ← SSE が先
T+165ms    GET /api/sessions/<sessionId>/history?limit=10&provider=claude
```

**SSE → history の順**。`limit` は常に 10。

### `needReplay` は使われない

新規・既存いずれのケースでも **アプリは `needReplay` を送らない**。
クエリは常に `?token=<token>&sessionId=<id>` の2つだけ。
サーバー側のリプレイ機構は、アプリからは事実上使われない。
**互換サーバーはリプレイ未実装でも動く。**

### ターンはアプリ以外からも開始できる(実機確認)

`POST /api/prompt` はアプリ専用の口ではない。トークンさえあれば任意のクライアント
(curl、Web ページ、CLI)から同じセッションにプロンプトを投入でき、**アプリが送った
ターンと完全に同一のイベント列**が流れる。サーバーは送信元を区別しない。

```text
POST /api/prompt (curl から) → 202
  status: busy → status: text_start
  text_delta … → status: text_end
  result → status: idle
```

グラス上でも、**注入したプロンプト文と応答本文の両方が通常どおり描画される**。

含意: アプリの入力手段(音声)に縛られない。キーボードのある端末から長文を投げ、
結果をグラスで読む、という使い方が**既存のサーバーを変更せずに成立する**。

### 1 セッションに複数クライアントが同時接続できる(実機確認)

アプリが SSE を張ったまま、別クライアントが同じ `sessionId` で `/api/events` に
接続すると、**両方が同じイベントを受信する**。取り合いにはならない。

出力の多重化はこれで足りる。一方 **入力側の排他は行われていない** ため、
ターン実行中に2本目の `POST /api/prompt` が来た場合の扱いは実装側の責任になる
(互換サーバーを書くならキューイングか 409 を用意すること)。

### SSE 接続はセッションを閉じても切れない

- 画面上でセッションを閉じても切断は発生しない。
  **同一セッションを再オープンしても、新規接続も history 取得も走らない**(接続を再利用)。
- 別セッションに切り替えると**新しい接続を追加で張る**。古い接続は開いたまま。
  接続はセッションを開くたびに蓄積していく。
- したがって互換サーバーは:
  - **長寿命接続前提**。アイドルタイムアウトで切ってはいけない。
  - 15 秒ハートビートは NAT / 中間装置に切られないために必須。
  - **1 セッションに複数クライアントが並存**しうる(全員にブロードキャストする)。
  - サーバー側から切ると **アプリは自動再接続しない**。
    アプリの再起動が必要になるため、サーバーの再起動は極力避ける。

## 7.6 グラス上の描画

各イベントを実際に送って G2 の表示を確認した結果。

| イベント        | 見え方                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification`  | **薄い(dim)文字**で 1 行追記。`> <title> <message>` の形で **title と message が同一行に連結**される。自動消滅せず残り続ける                     |
| `error`         | **通常輝度**で 1 行追記。既存行が上へスクロールする。異常系としての特別扱い(色・強調・状態変化)は**なし**。最下行の "Waiting input" も変わらない |
| `task_progress` | **画面に一切現れない**。idle 中も、`status:busy` を送った状態でも変化なし                                                                        |

`notification` と `error` の差は**輝度のみ**で、重大度を伝える手段としては弱い。
確実に伝えたい情報は `text_delta` 本文に混ぜるほうがよい。

### ターン実行中の画面

最下行(ステータス行):

- アイドル時: `Waiting input`
- 実行中: `Planning...` / `XXXing...` のような動名詞表示に変わり、
  **ターン開始からの経過時間(秒 → 分+秒)が毎秒カウントアップ**する。

ツール実行のたびに、本文に**薄い文字**で 1 行追記される(`notification` と同じ dim 表示):

```text
> tool end: TodoWrite・TodoWrite update tasks
> tool end: Bash・Bash sleep 20 を実行
```

形式は `> tool end: <name>・<summary>`。`tool_end` イベントの `name` と `summary`
がそのまま使われている(`detail` は表示されない)。

### ステータス行は `status` イベントで駆動される。ただし全状態が可視ではない

ステータス行(最下行)は SSE の `status` で切り替わる。**アプリが送っていないターン
——外部から `POST /api/prompt` で注入したターン——でも切り替わる**ことを実機で確認した。

| `state`                     | 最下行                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `think_start` → `think_end` | **`Thinking...`** を表示                                            |
| `busy`                      | **可視ラベルなし**。単体で送っても `Waiting input` のまま変わらない |
| `idle`                      | `Waiting input` に戻る                                              |

`busy` に見た目の変化が無い点は紛らわしい。`busy` は内部状態で、表示を伴うのは
`think_start` / `text_start` 側だと考えるのが実挙動に合う。

一方 **経過秒カウンタはアプリのローカルタイマー**。`running_stats` は 10 秒間隔でしか
来ないので、秒単位のカウントアップを SSE では説明できない。

**互換サーバーへの含意**: `status: think_start` を送れば、サーバー側の都合で
「Thinking...」を出せる。ローカル LLM の推論中や、時間のかかる前処理中に
グラスを無反応に見せないための実用的な手段になる。終わったら `think_end` を送る。

### `task_progress` は実際には発火しない

TodoWrite を繰り返し呼ぶ長めのターンを流しても **0 件**だった。ソースを追うと、
このイベントは実質到達不能と分かる:

- 送信箇所は `canUseTool` 内の `if (toolName === "TodoWrite")` ブロックのみ。
- しかし **TodoWrite は `canUseTool` を通らない**(SDK 側で自動承認される)。
  観察した範囲で `canUseTool` が呼ばれたのは **Bash と AskUserQuestion だけ**。
- 結果、TodoWrite 自体は多数使われているのに `task_progress` の
  SSE ブロードキャストは 1 件も発生しない。

したがってアプリに何も表示されないのは当然で、アプリ側の実装有無は
サーバーからは判定できない。**互換サーバーで進捗を見せたいなら `text_delta` に
`[2/5] …` のように書き出すこと。**

紛らわしい別物として、ログに出る `{"type":"system","subtype":"task_progress",…}` は
**Agent SDK のサブエージェント進捗**であり、even-terminal の SSE イベントとは無関係。
`processSystem()` は `api_retry` しか扱わないため、こちらは捨てられている。
互換サーバーならここを拾ってサブエージェントの進捗を可視化する余地がある。

## 8. 未確認事項

- **アプリ側の入力検査の厳密さ**。上記はサーバーの実装と実際の応答から導いた契約であり、
  アプリが未知フィールドや欠損フィールドにどう反応するかまでは網羅していない。
- バージョン差分。ここに書いたのは v0.8.1 時点の観察で、上流の更新で変わりうる。
  自分の環境で確かめるのが確実。

## 9. セキュリティ上の注意

互換サーバーを自作する場合も、次の性質は公式実装と共通:

- `0.0.0.0` 待ち受け + 単一トークンなので **同一 LAN の全端末から到達可能**
- CORS 全開放のため、ブラウザで開いた任意のページから `?token=` 付きで叩ける
- `POST /api/prompt` は任意のプロンプトをセッションに投入できる = 実質的な RCE 経路

Tailscale などの私設網に限定する、トークンを推測不能に保つ、といった運用は維持すること。
