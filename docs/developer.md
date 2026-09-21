# Developer & Operations Guide

[English] ・ 日本語: [developer.ja.md](developer.ja.md)

This guide, split out from [../README.md](../README.md), collects the details on running as a daemon, connection setup, the WebUI, backend integrations, environment variables, internal design, and security.

## Run as a daemon with systemd (Linux)

A user-service template unit is included so it can use the same home directory as your logged-in Claude/Codex credentials. So it works no matter where you cloned it, you pass the directory to start in as the unit's instance name.

```bash
# Run at the repository root
mkdir -p ~/.config/systemd/user ~/.config/terminal-mode-console
cp systemd/terminal-mode-console@.service ~/.config/systemd/user/
cp systemd/env.example ~/.config/terminal-mode-console/env
chmod 600 ~/.config/terminal-mode-console/env

# Edit env and, at minimum, change TMCON_TOKEN to an unguessable value
${EDITOR:-vi} ~/.config/terminal-mode-console/env

unit="terminal-mode-console@$(systemd-escape --path "$PWD").service"
systemctl --user daemon-reload
systemctl --user enable --now "$unit"
systemctl --user status "$unit"
```

You can check the logs with `journalctl --user -u "$unit" -f`. To replace the process after an update, run `systemctl --user restart "$unit"`. Note, however, that after the server restarts the Even App may not automatically reconnect its SSE, so in that case restart the Even App as well.

If you want it to keep running after you log out, an administrator runs the following once.

```bash
sudo loginctl enable-linger "$USER"
```

The service also needs restarting when you change environment variables. For exposure scope, see the Tailscale setup below and [Security](#security). Stopping and disabling auto-start is as follows.

```bash
unit="terminal-mode-console@$(systemd-escape --path "$PWD").service"
systemctl --user disable --now "$unit"
```

## Connect from your phone and G2 via Tailscale (recommended)

Install [Tailscale](https://tailscale.com/) on the PC running terminal-mode-console and on the phone that uses the Even App, and log both into the same tailnet. Leave the server on loopback listening, and in a separate terminal on the PC run the following.

```bash
tailscale serve --bg --https=3456 http://127.0.0.1:3456
tailscale serve status
```

Note the HTTPS URL shown by `tailscale serve status`, for example `https://my-pc.example-tailnet.ts.net:3456`. Because Tailscale Serve terminates TLS, there is no need to bind terminal-mode-console itself to an external address.

Since Serve forwards from loopback, the request log's client would otherwise always read `127.0.0.1`. terminal-mode-console reads the `Tailscale-User-Login` / `X-Forwarded-For` headers Serve injects and logs the real client instead — the accessing user's login and their source IP together, e.g. `[you@example.com, 10.x.x.x]` (whichever is present if only one is). This is on by default and honored only when the TCP peer is loopback; set `TRUST_PROXY=0` to log the raw peer. Note that Tailscale Funnel does not add `Tailscale-User-Login` (anonymous internet access), and this server is not meant to be exposed via Funnel anyway.

Open Terminal Mode in the Even App, and enter the following on the add-host screen.

| Field        | Example input                                                                  |
| ------------ | ------------------------------------------------------------------------------ |
| Host name    | `Home PC` (any name to tell hosts apart in the list)                           |
| Host address | `https://my-pc.example-tailnet.ts.net:3456` (the `tailscale serve status` URL) |
| Auth token   | The `TMCON_TOKEN` shown when the server started                                |

No QR code is needed. This tool does not depend on the `evenhub` command and does not generate QR codes.

The same URL also works for the WebUI and the CLI.

For the WebUI, open `https://my-pc.example-tailnet.ts.net:3456?token=XXXX&defaultProvider=claude` in a browser.

```bash
node bin/tmcon-cli.mjs \
  'https://my-pc.example-tailnet.ts.net:3456?token=XXXX&defaultProvider=claude'
```

Tailscale Serve exposes it only within the tailnet. Do not use Tailscale Funnel, which exposes it to the entire internet, for this server.

## WebUI

**Just open the connection URL with the token in a browser** and the WebUI appears (auth uses the same token). You can converse without glasses, and if you have glasses you can use it as an input method too.

- **Shows the connected backend in the header, and changes the look per provider**. Depending on `?defaultProvider=`, it not only shows `Claude Code / Codex / local` in the header's display pill, but also reflects the accent color (claude=terracotta / codex=green / local=purple) in the **header top band, display pill, tab title, favicon, and `theme-color`**. The color definitions are consolidated in one place in CSS at `[data-provider]{--accent}`, and the JS reads that and applies it to the tab title, favicon, and theme-color, which cannot be changed by CSS. This makes claude / codex / local windows and tabs distinguishable at a glance even when lined up side by side
- The same rendering as the glasses (body text, dimmed tool lines, `Thinking...`, elapsed seconds)
- **The status line is directly above the input field**. It shows `Waiting input` / `Thinking...` / `Responding...`, and, when we are waiting for you to answer, `Waiting your answer — …` (yellow)
- **Shows the liveness of the foreground turn**. In addition to elapsed time since start, once 30 seconds pass after the last observed thinking/body/tool/result event it shows `quiet 32s`, and once it exceeds `STALL_WARN_MS` it shows `No activity 2m`. The session list also gets labels like `active 4s ago`, and instead of refetching the list every second the browser only updates the relative time. This is "the time the last event was observed," not a stall determination. Even normal long-running processing can become `No activity`, and it does not auto-interrupt or auto-restart on the basis of this display. Waiting for a user answer, Claude's background processing, and the SSE `Reconnecting...` are each treated as distinct states
- **Shows Claude Code / Codex usage at the right end of the status line**. In the form `Ctx:50% 5h:40% 1w:30%`, updated when a session is opened and when a turn completes. Tapping `5h` / `1w` shows each quota's reset time in the browser's local time, down to `YYYY/MM/DD(day) HH:MM`. Claude uses the Agent SDK's structured `/context` and `/usage`; Codex uses the latest `token_count` saved in the session. Because Codex rate quotas are per account, when you hit the 5h limit and no quota info remains in your own session, it fills in the reset time in the order: the most recent value from another session, the failed turn's error (including the `usageLimitExceeded` wording), and the disk cache (`~/.tmcon/codex-usage.json`). On API key / Bedrock / Vertex connections where Claude plan usage cannot be obtained, `5h` / `1w` are shown as `—`, and on backends where the usage API itself is unsupported the usage field is hidden. **The local LLM backend has no 5h/1w rate windows, so those two slots are repurposed to show actual token counts** — `Ctx:29% Tok 1.2k Max 4k`. `Ctx` is the context occupancy (last turn's `total_tokens` ÷ context window), `Tok` the used tokens, `Max` the context window. The token count comes from the streamed response's `usage` (requested via `stream_options.include_usage`); the context window is read from the backend (LM Studio `/api/v0/models` `loaded_context_length`, llama.cpp `/props` `n_ctx`, Ollama `/api/show` `context_length`) and can be overridden with `LLM_CONTEXT` (alias `LLM_NUM_CTX`) — useful for Ollama, whose effective `num_ctx` may be smaller than the model's advertised maximum. If neither a usage sample nor a context window is available, the slot shows `—`
- **Model selection (Claude / Codex / local LLM)** — opening the header's `ⓘ` reveals a dropdown. For Claude you can pick the **aliases** `Default` / `Opus` / `Sonnet` / `Haiku` / `Fable`, which always resolve to the latest model in that line, so you do not have to fix the setting when a model is updated (it holds no fixed ID like `claude-opus-4-6`). Codex dynamically shows the current models returned by the App Server's `model/list`, so the list is not pinned to a version. For a local LLM the server **identifies the backend from its responses** (LM Studio / Ollama / llama.cpp) and lists models through that backend's native API (see below). Selecting one is **remembered on the server immediately**, and **glasses, which have no model-selection UI, use that model from the next turn**. The memory is two-tiered: per session and a global default for the provider slot, and for glasses in a different session the global default applies. **When you have not selected anything yourself, nothing is specified** — the dropdown _shows_ the currently effective model, but that does not count as a selection, and since no model is specified on send, it inherits the session's or the server's setting as-is (a model that was merely displayed is not sent back as a specification, which would cause an unintended switch). Selecting `Model: Auto` **clears the memory** and returns to the unspecified state (since setting writes to both the session and the global default, clearing targets both as well). The display follows the current remembered value, so **a model changed by another client such as the CLI or the glasses also appears in the dropdown** (updated when a session is opened, when a turn completes, and every 15 seconds; but it does not move while you are operating the dropdown). After a turn completes it leaves one dimmed line with the **specific model ID actually used** (e.g. `claude-sonnet-5`), so you can confirm what the alias resolved to. `Fable` can become metered credit billing on the Pro plan (standard quota on Max), so the dropdown notes this
- **Input-only mode** — checking it collapses the output into a keyboard-input-only UI. For the use case of reading details on the glasses and typing long input at hand
- **Japanese input** conversion candidates appear on the browser side, so there is no need to send them to the glasses. Confirm with `Ctrl+Enter` (Enter during IME conversion is not taken as send)
- **Permissions and questions are answered in inline cards at the bottom of the log**. No full-screen modal appears; cards are stacked at the end of the scroll region, so both what was asked and the result after answering remain in the history (already-answered questions are restored with the same look after resume)
- **Formatted display of prompt metadata** — content inside custom tags such as `<recommended_plugins>` or `<INSTRUCTIONS>` is rendered as Markdown, while for ones whose contents are structured, like `<environment_context>` or `<task-notification>`, the tag name becomes a heading and the contents are shown as a hierarchical tree of item names and values. The tree parsing is lenient tag parsing, not strict XML, so it does not break even when free text containing `&`, `<`, or `>` comes in values like `<summary>`. It applies to both live reception and history display, and distinguishes ordinary user input by color and leading symbol. Standard HTML tags and input without closing tags are treated as plain text
- **File attachments** (📎 button / Ctrl+V paste into the text field). Images are passed to Vision-capable backends (`local` / `claude` / `codex`), and text files (md/json/csv/source, etc.) have their contents inlined into the body when sent. You cannot send files from the glasses themselves, so this is a WebUI-side input method
- **Filter by cwd / specify a new working directory** — typing text into the header's cwd field shows only sessions in that working directory (partial match). The path entered in the field also becomes the **working directory for sessions started with "New"** (server default if empty). Previously used cwds appear as input candidates (datalist). For filtering constraints, see "Design notes" below
- **Session archiving** — you can hide finished sessions from the normal list without deleting them. Within the info panel opened with `ⓘ`, the action button appears only when an archivable session is selected. The button itself is not shown when no session is selected, for an unsent new session, while running, or while waiting for an answer. Only when there is at least one archived item does an `Archived N` toggle appear, letting you show and restore them within the same list. The state is terminal-mode-console's own metadata and does not change Claude / Codex saved data. `ⓘ` remains on the top header row even after you close the info panel

The glasses, the WebUI, and other clients **can connect simultaneously**. Output is delivered to everyone, and input is serialized by the FIFO described below.

### Add to home screen (PWA / no Service Worker)

The WebUI has a `manifest.webmanifest`, icons, and meta tags, so **adding it to your phone's home screen** launches it standalone without a URL bar. No Service Worker is included (offline value is low for an always-connected live UI, and an SW cannot be registered on a plaintext HTTP LAN).

- **Only the first time**, open the pairing URL (with `?token=…`). The token is stashed in localStorage.
- iOS "Add to Home Screen" bases itself on the URL when opened (with the token), so it just works.
- On Android/desktop the `start_url` (`/`) carries no token, but it is restored from localStorage.
- If the token is in neither the URL nor localStorage, a banner prompts re-pairing.

The token is **not baked** into the manifest, which can be fetched without authentication (to prevent leakage). The shell HTML contains no secrets, so it is returned before authentication, while the actual data (REST/SSE) still requires the token as before.

> Having Tailscale installed lets it reach your phone and glasses reliably. But since the default is loopback listening, reaching it from outside requires either the `tailscale serve` (recommended) in "Security" below or `HOST=0.0.0.0`. Use a Tailscale IP or a MagicDNS name for `<host>`.

### Over plain HTTP, tabs are limited to 5 (the 6th onward becomes unresponsive)

**Symptom**: when you open the WebUI in **multiple tabs of the same browser** over `http://…` (not HTTPS), past a certain number of tabs some tabs show history but **do not return a response when you send**. If in DevTools' Network the request stays `pending` and the Console shows `net::ERR_INSUFFICIENT_RESOURCES`, this is it.

**Cause**: the WebUI keeps **one persistent connection** open per tab to `/api/events` (SSE). Because browsers limit **HTTP/1.1 to at most 6 concurrent connections per host**, once SSE alone uses up all 6 slots for 6 tabs, the 7th new request (send, history fetch, etc.) cannot get a slot and stalls. The SSE itself stays connected (so "connection lost" does not appear), which makes it hard to notice.

**Workarounds**:

1. **Reduce the number of tabs** (keep it to one to a few if using plain HTTP). The easiest.
2. **Switch to HTTPS** (recommended). Communication with the browser becomes **HTTP/2**, which multiplexes many streams over a single connection, so you **never hit this 6-connection limit in the first place**.
   - The easiest is the **`tailscale serve`** in "Security" below — certificate issuance and renewal are automatic, so you can go HTTPS (= HTTP/2) without bringing in certificate-management overhead.
   - Standing up your own reverse proxy (Caddy / nginx, etc.) or Node TLS has the same effect. In that case, use a configuration that does not buffer SSE (for nginx, `proxy_buffering off;`; this server already self-protects by adding `X-Accel-Buffering: no` to responses).

> The reason phones or other browsers are fine is that the connection pool is independent per browser (profile), and you usually do not open too many tabs. The limit is "per host," so even on the same device a different browser gets a separate quota.

## For running as a daemon (Ollama)

If you keep it running as a server, Ollama is easy to handle. It runs as a daemon from the start and works as-is in headless environments.

```bash
ollama serve
ollama pull <model>

TMCON_TOKEN=$(openssl rand -hex 16) \
LLM_BASE_URL=http://localhost:11434/v1 \
LLM_MODEL=<model> \
node server.mjs
```

## Terminal client (tmcon-cli)

A thin client that lets you read and write the **same conversation** as the glasses and WebUI from a terminal.

```bash
node bin/tmcon-cli.mjs 'https://<magicdns-name>:3456?token=XXXX'  # pass the connection URL as-is
node bin/tmcon-cli.mjs --url https://<magicdns-name>:3456 --token XXXX --new --provider local
```

On startup it **shows the session list and has you choose**. Silently connecting to the latest would merge you into an unintended conversation. Pass `--session <id>` or `--new` to start without being asked. The list also shows each session's working directory (cwd) in dimmed text.

```text
  1) 2026-07-21 17:05  Reading the even-terminal logs…  /home/me/projA
  2) 2026-07-21 16:43  Japanese greeting response        /home/me/projB
  n) New session

Select a number (n = new)>
```

Passing `--cwd <dir>` filters the list to only sessions in that working directory (partial match), and a session started with `n` (new) also opens in that directory. When you choose `n` without `--cwd`, it **asks for the working directory** (choose a past cwd by number / type a path directly / complete an existing directory on the server with Tab / server default if empty). For filtering constraints, see "Design notes" below.

You can specify the Claude / Codex model with `--model <name>` (or `EVEN_MODEL`). During a conversation, switch with `/model <name>`, and `/model` alone **clears the memory** and returns to auto (same as the WebUI's `Model: Auto`). The value is the same aliases as the WebUI dropdown (`opus` / `sonnet` / `haiku` / `fable` / `default`) or a full ID. When specified, it is remembered on the server and carried over to other clients too. For Codex, use the concrete IDs that appear in `model/list`. **If you do not specify one, `model` is not sent**, so it inherits the session's or the server's setting as-is. After a turn completes, it prints the **specific model ID actually used** in dimmed text like `› model: claude-sonnet-5`.

It shows a **status line** directly above the input line (`[Waiting input]` / `[Thinking... 12s]` / when waiting for an answer, `[Waiting for your answer — question …]` in yellow). It is not shown when not a terminal (piped).

It is not the Claude Code TUI (there are no slash commands or diff display). Instead, **the conversation state is on the server side**, so you do not lose context when you disconnect. Reconnect and you can read the continuation from `history`. **tmux is not required; use it if you like**.

Permission and question dialogs can be answered by number selection in the terminal too. If another client answers first, your prompt is automatically collapsed.

## Connect Claude Code (optional)

Installing `@anthropic-ai/claude-agent-sdk` enables the `claude` backend. It is an **optional dependency**, so if you do not install it the core stays dependency-free.

```bash
npm install                  # claude usable too
npm install --omit=optional  # local / echo only (zero dependencies)
```

**It holds a single `query()` per session** (1 session = 1 query = 1 child process), and turns run by pushing user messages into that **streaming input** channel. When the connection is made, it continues the previous conversation with `resume`. Conversation state is persisted in Claude's JSONL, so context stays connected and the glasses, WebUI, and CLI share the same context.

> Previously it was per-turn (re-establishing `query()` each turn and closing on `result`), but with Claude Code 2.1.2xx the Agent (subagent) tool became background-executed by default, so closing the query — the child process — on `result` would kill running agents along with it. With a persistent query the child process stays alive so agents do not die, and the main turn's `result` can return the bus to idle, so you can continue the conversation even during background execution (2.1.2xx also fixes the old "hangs on the second turn").

The model can be switched per turn. Switching for an existing session is done with the SDK's `Query.setModel()` (a streaming-input-only API), and **the query is not re-established**. The effective-model resolution order is (1) the request's `model` → (2) the value remembered by the server (this conversation → the provider slot's global default) → (3) `CLAUDE_MODEL` → (4) Claude Code's default. The specific model ID actually used is picked up from the assistant message's `message.model` and carried in the `result` event's `model` (so you can see what the alias resolved to).

**It supports listing and resuming past sessions**. Conversations that Claude Code holds in JSONL line up directly in the list, and you can open one and keep talking. A new session uses terminal-mode-console's UUID directly as Claude's session ID, so it lines up under the same ID from then on.

> Local LLMs also persist conversations to JSONL (`LLM_STORE_DIR`, default `~/.tmcon/sessions`). They remain in the list, and reopening one continues with the full context. Disable with `LLM_PERSIST=0`.

## Connect Codex (optional)

Installing `@openai/codex-sdk` enables the `codex` backend. It communicates with the Codex CLI's App Server bundled in the SDK over structured JSON-RPC, and supports creating and resuming threads, history, streaming, tool display, interruption, and image input.

```bash
npm install
TMCON_TOKEN=$(openssl rand -hex 16) PROVIDER_CODEX=codex node server.mjs
```

It bridges the Codex App Server's standard `item/tool/requestUserInput` to the WebUI, glasses, and CLI as `user_question`. Because it does not register thread-specific dynamic tools, threads created with the ordinary Codex CLI can also be resumed interchangeably from terminal-mode-console. It launches only the App Server child process that terminal-mode-console owns with `--enable default_mode_request_user_input`, and passes, to both new threads and resumes, developer instructions to use native questions for explicit 2-3 choice prompts. It does not modify the user's `~/.codex/config.toml`.

The model list is fetched from the App Server's `model/list`, cached, and displayed dynamically in the WebUI. The effective model is passed to `turn/start` each turn, so it can be switched even when resuming an existing thread. The resolution order is (1) the request's `model` → (2) the value remembered by the server (this conversation → the provider slot's global default) → (3) `CODEX_MODEL` → (4) Codex's default. It does not switch on `thread/resume`. If `CODEX_REASONING_EFFORT` is not in the selected model's supported list, the effort is not sent and it defers to the model's default. The model actually used is carried in `result.model`.

`default_mode_request_user_input` is an under-development feature in current Codex, and native questions in Default mode are `isBlocking: false` at the protocol level. terminal-mode-console retains the request ID and, after the user's choice, answers explicitly in the standard `{ answers: { id: { answers: [...] } } }` form. Approval requests for command execution and file changes are also bridged to `permission_request`. The defaults are `workspace-write` and `on-request`. Existing Codex authentication and settings are used as-is.

The WebUI's shortened session ID shows the **last 8 characters** rather than the first 8, which tend to look alike because they are time-derived (other providers such as Claude use the first 8 as before).

### Local LLM model listing and backend detection

The model choices for the local-LLM slot are obtained by first **identifying the backend from
its responses** and then calling that backend's native API. Port numbers are not used for
identification — ports are freely configurable, and behind a reverse proxy or an SSH tunnel they
will not match the defaults.

Detection starts from a single `GET /v1/models`; if that is inconclusive, backend-specific
endpoints are probed in turn (each returns 200 on exactly one implementation).

| Signal                              | Verdict                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `Server: llama.cpp` header          | llama.cpp (set on every response, so it is the most reliable)   |
| top-level `models` alongside `data` | llama.cpp (its Ollama-compatibility duplicate)                  |
| `owned_by: "llamacpp"`              | llama.cpp                                                       |
| `owned_by: "organization_owner"`    | LM Studio (undocumented, so not used as the sole discriminator) |
| `GET /api/version` returns 200      | Ollama                                                          |
| `GET /props` returns 200            | llama.cpp                                                       |
| `GET /api/v1/models` returns 200    | LM Studio                                                       |

Where the list comes from, and how the backends differ:

- **LM Studio** — `GET /api/v1/models` (falling back to `/api/v0/models` on older builds).
  `type` is used to **exclude embedding models**: the OpenAI-compatible `/v1/models` mixes
  `text-embedding-*` into the same list with no way to tell them apart, so it is not used here.
  A non-empty `loaded_instances` marks a model as loaded. Whether selecting an unloaded model
  loads it automatically depends on the **JIT loading** setting; with JIT off it must be loaded first.
- **Ollama** — `GET /api/tags` (pulled models), with `GET /api/ps` marking the loaded ones.
  Naming a model loads it on demand, so switching is **unrestricted** (only the first request waits).
- **llama.cpp** — check `role` from `GET /props`. In **router mode** (started without `-m`) every
  model from `/v1/models` is offered. **Single-model mode** is fixed at startup and cannot be
  changed, so the list is left **empty and the picker is not shown at all**.
- **Other OpenAI-compatible servers** — `GET /v1/models` as-is (no filtering, since types are unknown).

When no HTTP response comes back at all, the header **says so directly**
(`Cannot connect @ <endpoint>`). In that state the label and model name are not values read
from the backend but a guess from the port and the env default, so showing them in the normal
style makes a broken configuration look like a working one. A response that is returned but
rejected (401, say) counts as reachable — it only needs auth; the connection itself is alive.

**With no model specified ("auto"), one is picked from the list.** The OpenAI-compatible API
requires `model` — there is no "let the server decide" — so something has to be chosen. The order
is an explicit `LLM_MODEL` → a **loaded** model → the first in the list → the `agents-a1-4b`
default. Loaded wins because naming an unloaded model costs a load (and fails outright on some
backends). Falling through to the default risks naming something the backend does not have (LM
Studio's real ID here is `internscience_agents-a1-4b`), so the list is preferred whenever it is
available. The model that would be picked is returned as `describe().autoModel`, and the WebUI
appends it to the dropdown's auto entry, e.g. `Model: auto (InternScience Agents A1 4B)`.

Because `describe()` is synchronous, the list is **fetched in the background and cached**
(60 s TTL), and `describe()` returns whatever is cached at that moment. Before the first fetch
completes it is an empty array, and the WebUI hides the picker in that case — so it merely
does not appear for a moment after startup, rather than breaking.

### Tool use by local LLMs

With `LLM_TOOLS=1` (default), the local LLM is given **bash / grep / read_file / view_image / list_dir** via OpenAI-compatible function-calling. When the model calls a tool, it is executed, the result is added to the conversation, and it asks again — an agentic loop (capped by `LLM_TOOLS_MAX_ROUNDS`). Tool use appears to clients via the same `tool_start` / `tool_end` events as the Claude slot.

**Analyzing an image in the conversation's context (`view_image`)**: if the backend is a Vision-capable model (e.g. an LM Studio model with mmproj), when the model calls `view_image` on an image path, that image is **re-attached to a user message** and analyzed in the next round. Because OpenAI-compatible APIs cannot put an image in a `role:"tool"`, the tool response returns only a text note, and the image is injected into the immediately following synthetic user message. The image's base64 is not persisted to JSONL (to avoid context bloat; if needed after resume, the model can just call `view_image` again). The cap is `LLM_TOOLS_MAX_IMAGE` (default 8MB).

For safety, read-family tools (`grep` / `read_file` / `list_dir`) pass automatically, while `bash`, which can execute arbitrary commands, **asks the user for permission every time** by default (in the WebUI, the permission card at the bottom of the log; on the glasses, confirmation on the device). Choosing "always allow" stops asking within that process from then on. The auto-allow set can be changed with `LLM_TOOLS_AUTO_ALLOW` (e.g. `LLM_TOOLS_AUTO_ALLOW=read_file,grep,list_dir,bash` makes bash unconfirmed too). To turn tools off entirely, `LLM_TOOLS=0`.

> Whether a model can actually use tools well depends on the model (small models tend to corrupt the argument JSON). Tool calls and results also remain in JSONL, so you can continue with the full context after resume.

### Debugging the exchange with a local LLM (`LLM_DEBUG_DUMP`)

When you need to see **exactly what the model received and returned** — e.g. to work out why a small model calls `view_image` on an already-attached image — set `LLM_DEBUG_DUMP`. Every request/response round with the backend is written to JSONL. This is separate from the conversation store (`LLM_PERSIST`): the store keeps the _tidy_ conversation for resume (images stripped), whereas this dump keeps the _raw wire traffic_, base64 images and all.

**What it records** — one JSON object per line, each with `ts` and `session`:

- `dir: "request"` — the full body POSTed to `/chat/completions`: `model`, the entire `messages` array (system prompt + tool hint, prior history, and the current user message **including the raw `data:image/...;base64,...` `image_url`**), and `tools` when tools are on.
- `dir: "response"` — the assembled reply: `reasoning` (the model's thinking from `reasoning_content`, captured even when it isn't shown on the glasses), `text`, `toolCalls` (name + raw argument JSON), `finishReason`, `usedModel`. On failure instead: `error: true` with `status`/`body` (HTTP error) or `message` (connect/stream error).

One line is written per tool round, so a multi-round turn (e.g. a `view_image` round-trip) shows up as several request/response pairs in order.

**Where it writes** — the value picks the layout:

| `LLM_DEBUG_DUMP`          | Output                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| unset or `0`              | Disabled. Zero overhead — nothing is accumulated or written                                                                      |
| `1` or `true`             | `<LLM_STORE_DIR>/debug/<sessionId>.jsonl` — one file per session, next to the session store (default `~/.tmcon/sessions/debug/`) |
| a directory path          | `<that dir>/<sessionId>.jsonl` — one file per session in a location you choose                                                   |
| a path ending in `.jsonl` | That single file, with **all** sessions interleaved                                                                              |

Per-session files use the same `<sessionId>.jsonl` name as the conversation store, so a dump and its stored conversation are easy to line up. Missing directories are created automatically.

> **It never bloats the model's context.** The dump is a pure side-effect: the request body is serialized _after_ being built, exactly as sent, and `reasoning` is accumulated into a local variable that is only written to disk — never fed back into the conversation. The prompt the model sees is byte-for-byte identical whether the dump is on or off. The only costs are disk writes and, while enabled, holding one turn's reasoning text in memory. Because the files contain full base64 image data they grow quickly — use this for local debugging, not in production.

## Provider resolution rules

The provider the app (even-terminal) sends is **only the two slots `claude` / `codex`**. terminal-mode-console assigns a "concrete backend" (`claude` / `codex` / `local` / `echo`) to each of these two slots and runs. The assignment is decided by environment variables.

| Slot (app's choice)    | Environment variable | Default                                                 |
| ---------------------- | -------------------- | ------------------------------------------------------- |
| Claude Code (`claude`) | `PROVIDER_CLAUDE`    | `claude` (auto-demoted to `local` if SDK not installed) |
| Codex (`codex`)        | `PROVIDER_CODEX`     | `codex` (auto-demoted to `local` if SDK not installed)  |

Examples:

```bash
PROVIDER_CLAUDE=claude PROVIDER_CODEX=codex   # both Claude/Codex real
PROVIDER_CLAUDE=local  PROVIDER_CODEX=local   # both slots local LLM
PROVIDER_CLAUDE=echo   PROVIDER_CODEX=echo    # for testing
```

### Addressing a backend directly

A backend can also be **named directly as the provider** (`local`, `echo`, …) without binding it
to a slot. Opening `?defaultProvider=local` reaches the local LLM even with no `PROVIDER_*` set.
As long as `LLM_BASE_URL` is configured, a single server can serve `claude` / `codex` / `local` /
`echo` and you pick between them from the URL alone.

```bash
# With only LLM_BASE_URL set, all four are reachable by URL
LLM_BASE_URL=http://localhost:1234/v1 TMCON_TOKEN=… node server.mjs
#   ?defaultProvider=claude / codex / local / echo
```

**A slot wins over a backend of the same name.** With `PROVIDER_CLAUDE=local`, `provider=claude`
opens the local LLM, as the binding says. Since the app only ever sends `claude`/`codex`,
accepting backend names does not change how the stock app behaves.

A provider that is neither `claude` / `codex` nor a registered backend name is steered to the
`claude` slot. In responses such as the session list, a backend that is **bound to a slot is
reported under the slot name** (`claude`/`codex`) to preserve the app's vocabulary; a backend
bound to no slot and addressed directly is reported under its own name (`local`, …), since
otherwise the client could not reopen it with the same provider. `tmcon-cli` takes
`--provider <name>`.

Note that remembered models and archive flags are **stored per resolved backend** (the key is
the backend name, not the slot). A model name belongs to a backend rather than a slot — `opus`
means nothing to LM Studio. Consequently:

- `local` and `claude` are remembered separately, so a model chosen for the local LLM is never handed to Claude
- Opening through a `claude` slot bound to local and addressing `local` directly reach the **same state**
- Rebinding the slot from `local` back to `claude` does **not** carry the local memory over to Claude

Conversation history itself also lives on the backend side (its own JSONL for the local LLM,
Claude Code's JSONL for Claude), so changing a binding never mixes histories either.

### Do not hide the actual connection target

Fallback happens silently, so **any client can see the real connection target at the start of a conversation**. `GET /api/info` answers only after actually resolving the requested provider.

```text
requested claude → Claude Code / (default) @ Agent SDK
requested codex  → LM Studio / agents-a1-4b @ localhost:1234   ← not wired up, so it fell back to local
```

| Where it is visible | How it appears                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| Glasses             | One dimmed line on the session's first turn (`notification`)                |
| WebUI               | Always shown in the header badge                                            |
| tmcon-cli           | One line at startup. On fallback, `(requested: codex → local)` also appears |

Because it is only once per session, it does not fill the screen even with the spec where `notification` does not disappear. If unwanted, `ANNOUNCE_BACKEND=0`.

## Switching backends

They all speak OpenAI-compatible `/v1/chat/completions`, so you swap them with two environment variables.

| backend   | `LLM_BASE_URL`              | Notes                                         |
| --------- | --------------------------- | --------------------------------------------- |
| LM Studio | `http://localhost:1234/v1`  | Start Local Server from the GUI. **Verified** |
| Ollama    | `http://localhost:11434/v1` | `ollama serve`. Good for a daemon             |
| llama.cpp | `http://localhost:8080/v1`  | `llama-server -m model.gguf`                  |

If needed, `LLM_API_KEY` and `LLM_SYSTEM_PROMPT` can also be specified via environment variables.

## Environment variables

| Variable                 | Default                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMCON_TOKEN`            | (required)                           | Shared token. Used for authentication by the Even App, WebUI, and CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TMCON_SESSION_METADATA` | `~/.tmcon/session-metadata.json`     | terminal-mode-console-specific session info such as archive state and the last specified model (per session plus the provider slot's global default)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TMCON_LANG`             | (OS locale)                          | Display language for server/CLI logs and messages. Specify a language code present in `locales/` (`ja`/`en`, etc.). If unset, it is determined from `LC_ALL`→`LC_MESSAGES`→`LANG`, falling back to English if none match. The WebUI chooses by the browser's language independently of this                                                                                                                                                                                                                                                                                           |
| `PORT`                   | 3456                                 | Listening port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PROVIDER_CLAUDE`        | `claude`                             | The concrete backend assigned to the `claude` slot (`claude` / `local` / `echo`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PROVIDER_CODEX`         | `codex`                              | The concrete backend assigned to the `codex` slot (`codex` / `claude` / `local` / `echo`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CLAUDE_MODEL`           | (Claude Code's default)              | Default when Claude's model is unspecified. An alias (`opus`/`sonnet`/`haiku`/`fable`/`default`) or a full ID. The WebUI dropdown, the API's `model` specification, and the value remembered by the server take precedence                                                                                                                                                                                                                                                                                                                                                            |
| `CODEX_MODEL`            | (Codex's default)                    | Default when Codex's model is unspecified. The WebUI dropdown, the API's `model` specification, and the value remembered by the server take precedence                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CODEX_SANDBOX`          | `workspace-write`                    | Codex sandbox (`read-only` / `workspace-write` / `danger-full-access`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CODEX_APPROVAL_POLICY`  | `on-request`                         | Codex approval policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CODEX_APPROVE_FOR_ME`   | `1`                                  | Auto-review Codex permission requests. Disable with `0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CODEX_REASONING_EFFORT` | (Codex's default)                    | Codex reasoning effort. A value not in the selected model's `supportedReasoningEfforts` is not sent, deferring to the model default                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CODEX_COMMAND`          | `codex`                              | The Codex command that launches the App Server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `LLM_BASE_URL`           | `http://localhost:11434/v1`          | OpenAI-compatible endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LLM_MODEL`              | (auto-picked from the backend)       | Pins the model. Optional — with nothing set, a loaded model from the backend's own list is used. Set it to the ID the backend returns, as-is; a wrong ID is worse than none, since the backend rejects it                                                                                                                                                                                                                                                                                                                                                                             |
| `LLM_API_KEY`            | `not-needed`                         | Usually not needed for local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LLM_SYSTEM_PROMPT`      | (concise instructions for glasses)   | System prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LLM_PERSIST`            | `1`                                  | Save local LLM conversations to JSONL. `0` to disable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LLM_STORE_DIR`          | `~/.tmcon/sessions`                  | Storage location for local LLM sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LLM_TOOLS`              | `1`                                  | Give the local LLM tools (bash/grep/read_file/view_image/list_dir). `0` to disable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LLM_TOOLS_AUTO_ALLOW`   | `read_file,grep,list_dir,view_image` | Tool names to pass without confirmation (comma-separated). `bash` is confirmed every time by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LLM_TOOLS_TIMEOUT`      | `30`                                 | Execution timeout in seconds for bash/grep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LLM_TOOLS_MAX_IMAGE`    | `8388608`                            | Max bytes for an image read by `view_image` (default 8MB). Prompts to shrink if exceeded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `LLM_TOOLS_MAX_ROUNDS`   | `8`                                  | Cap on tool round-trips within one turn (runaway guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LLM_DEBUG_DUMP`         | (disabled)                           | Debug: record every request/response exchange with the backend as JSONL — the full request body (system prompt, history, raw base64 `image_url` data URLs, tool specs) and the reply (reasoning, text, tool calls, errors). Values: `1`/`true` → per-session files at `<LLM_STORE_DIR>/debug/<sessionId>.jsonl`; a path ending in `.jsonl` → one combined file; any other path → a directory holding per-session `<sessionId>.jsonl`. Unset/`0` = off (zero overhead; never affects the context sent to the model). Files grow fast and contain full image data; local debugging only |
| `MAX_PROMPT_IMAGE_CHARS` | `25165824`                           | Total volume of images attachable to `/api/prompt` (sum of base64 character count. default 24MB chars)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SESSIONS_LIMIT_DEFAULT` | `100`                                | Count returned by `/api/sessions` when `?limit=` is omitted (also serves as the own-store list default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SESSIONS_LIMIT_MAX`     | (unlimited)                          | Upper limit allowed for `?limit=` on `/api/sessions`. Unlimited if unset/0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `HISTORY_LIMIT_DEFAULT`  | `100`                                | History count returned by `/api/sessions/:id/history` when `?limit=` is omitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `HISTORY_LIMIT_MAX`      | (unlimited)                          | Upper limit allowed for `?limit=` on `/api/sessions/:id/history`. Unlimited if unset/0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STALL_WARN_MS`          | `120000`                             | Once this time passes since the last meaningful agent event, the WebUI shows `No activity` and emits one dimmed notification per no-activity interval. It makes no stall determination or auto-interruption. `0` disables the log notification (liveness display continues)                                                                                                                                                                                                                                                                                                           |
| `ANNOUNCE_BACKEND`       | `1`                                  | Announce the connection target once at session start. Disable with `0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LOG_REQUESTS`           | `1`                                  | Emit the per-request diagnostic log line (timestamp, client, status, method, path, response time, client kind). `0` disables it                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TRUST_PROXY`            | `1`                                  | Trust `Tailscale-User-Login` / `X-Forwarded-For` from a fronting proxy (e.g. `tailscale serve`) so the request log shows the real client, not the loopback proxy. Honored only when the TCP peer is loopback (a direct LAN client cannot spoof). `0` logs the raw peer                                                                                                                                                                                                                                                                                                                |

## Structure

```text
server.mjs        Transport shell (REST+SSE+auth+routing). Do not touch.
bus.mjs           Session state, SSE delivery, permission/question round-trips, FIFO turn execution.
session-metadata.mjs  Display metadata such as archiving that does not modify upstream.
i18n.mjs          Translation loader shared by server/CLI. Reads locales/ and chooses the language by the environment locale.
locales/          Translation dictionaries <tag>.json, keyed by BCP 47 tag (en, ja, zh, zh-Hant, pt-BR, …).
                  Shared by server, CLI, and WebUI (served to the WebUI at /locales/). To add a language,
                  place one locales/<tag>.json; resolution falls back most-specific → base language → English
                  (region infers script, e.g. zh-TW → zh-Hant → zh), so variant files may be partial.
web/index.html    The WebUI itself (zero dependencies).
web/tagged-markdown.js  Splitting of prompt metadata wrapped in custom tags.
web/manifest.webmanifest  PWA manifest (add to home screen / standalone launch).
web/icon.svg / icon-192.png / icon-512.png / apple-touch-icon.png
                  PWA icons (icon.svg is the master. The PNGs are generated with convert and committed).
bin/tmcon-cli.mjs  Terminal client (zero dependencies).
agents/
  index.mjs       Registration of provider name → adapter.
  echo.mjs        Zero-dependency reference implementation (the minimal form of an adapter).
  local-llm.mjs   The main one. Converts OpenAI-compatible streaming to text_delta. Runs the tool round-trip loop.
  tools.mjs       Definition, execution, and permission determination of local-LLM tools (bash/grep/read_file/list_dir).
  store.mjs       Minimal store that persists conversations to JSONL (used by local-llm).
  claude.mjs      Claude Code (optional dependency). Holds one query() per session and
                  streams turns via streaming input. Model is switched with Query.setModel().
                  Image attachments are passed in Anthropic's image blocks (Vision-capable).
```

> **Note if you build your own client**: establish the SSE before `POST /api/prompt`. Sending first drops that turn's events entirely. `tmcon-cli` does not accept input until the initial connection completes.

## How to add a new backend

Just write one `agents/<name>.mjs` and `register` it in `agents/index.mjs`. In practice you implement a single `runTurn`:

```js
export default {
  name: "mybackend",
  async listSessions(limit, cwd) {
    return [];
  }, // empty is fine if none
  async getHistory(session, limit) {
    return [];
  },
  async runTurn({ session, text, emit, ask }) {
    emit({ type: "text_delta", text: "..." }); // the body shown on the glasses
    // await ask.permission({toolName, description, options:[{text,key}]});  // if permission is needed
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

`emit` is the only window to the glasses. `text_delta` is the body, `result` finalizes the turn.

### Detecting the glasses' reconnection state

The app keeps polling the list (`GET /api/sessions`) even after SSE disconnection. Using this, we can determine that **"Dart is polling recently but Dart has 0 SSE" = the app is running but has not come to reconnect** (a state that often occurs after a server restart).

- `GET /api/app-health` … `{glassesPolling, glassesSse, glassesStale, sseClients}`
- The `app` field of `GET /api/info` also contains the same content
- When it applies, the server log emits `[app] ⚠ …` once
- The WebUI shows a warning banner at the top when it applies (prompting an app restart)

SSE connections are counted separately by UA type (dart=glasses / web=WebUI / cli). It does not falsely detect a disconnected glasses when the WebUI or CLI is connected.

## Design notes (from behavior verified on real hardware)

- **Do not kill the process**. The app does not detect SSE disconnection and does not auto-reconnect. If you restart, everything on the app side except "sessions it has never opened" becomes unresponsive, and only an app restart recovers it. Avoid a hot-reload setup.
- **SSE authentication is the `?token=` query**. The app cannot send headers over SSE. Leave this out and REST works but the screen alone is unresponsive, which is hard to diagnose.
- **`status: think_start` can show "Thinking..."**. The bottom line switches on this event (verified on real hardware). `think_end` returns it. `busy` has no visible label, so it has no effect on its own. Only the elapsed-seconds counter is driven by the app's local timer.
- **Do not put a timeout on waiting for a permission/question answer**. The official server auto-sends deny / "skip" at 60s / 120s, but with that the answer gets decided on its own while you are thinking and the conversation proceeds. terminal-mode-console **waits until an answer or an explicit interruption**. While waiting, it informs all clients via `status:waiting` (extension) and a dimmed `notification`, and **re-sends** the request to a client that reconnects while waiting (to prevent a reload from leaving no one able to answer).
- **Write progress and errors you definitely want conveyed in the `text_delta` body**. `running_stats` / `task_progress` are barely used by the app.
- **Turns are executed serially per session**. Since there can be multiple clients, prompts arrive simultaneously. Running them in parallel would tangle the conversation history, so `bus.enqueue()` handles them FIFO. The `POST /api/prompt` response includes `queued` (the wait position).
- What is visible on the glasses is `text_delta` (body), `tool_end`'s `summary`, `notification` (dimmed), and `error` (normal text). `detail` is not shown. **Brevity is justice** (the screen is small).
- **Do not silently return a Codex failure to `idle`**. The App Server's `error` notification also occurs during retries, so it is not shown immediately; only when the turn finally becomes `failed` is its reason emitted as `error`. Failures that cannot produce a body, such as usage limit, authentication, or context limit, also leave the reason on screen before the bottom line returns to `Waiting input`.
- **cwd filtering is two-tiered**. The basic case filters the already-fetched recent list (WebUI 30 items / CLI 20-50 items) by cwd partial match on the client side. In addition, when an **absolute path** is entered in the cwd field / `--cwd`, a `GET /api/sessions?cwd=<dir>` is sent, which for the Claude slot becomes the SDK's `listSessions({ dir })`. **The dir scope covers the sessions in that directory**, so it also picks up older, less recently updated sessions that fell out of the overall recent list (the same range as when you resume `claude` directly in that cwd). Scoped results are merged with the overall list for display.
- However, **when cwd is a substring (not an absolute path), scoped fetching is not possible**, because the SDK's `dir` requires an exact match of an existing directory. In that case it is only a partial match against the recent list as before, and older sessions outside the fetch window do not appear (specify an absolute path, or open directly with `--session <id>`). The server-side `bus.listSessions` / local store `store.list` themselves do not filter by cwd (the dir scope applies on the Claude adapter's `listSessions({ dir })` side).
- **The cwd for new creation is free input**, so you can start even in a directory that is in neither the history nor the existing candidates.

For details on the HTTP API, see [`protocol.md`](protocol.md).

## Security

This server, with a single token + fully open CORS, permits arbitrary path traversal (`/api/fs/dirs`) and effectively RCE (`POST /api/prompt`). Since any browser page can also hit it with `?token=`, **keep the exposure surface minimal and the token unguessable**.

- **Listening is loopback-only by default** (`127.0.0.1`). It does not reach directly from outside. Give reachability to a TLS proxy in front (**`tailscale serve` recommended** — certificates auto-issued and auto-renewed, and communication with the browser becomes HTTP/2, so even opening SSE in many tabs does not hit the HTTP/1.1 6-connection limit):

  ```bash
  # terminal-mode-console stays on loopback and hands the tailnet-side 3456 to serve
  tailscale serve --bg --https=3456 http://127.0.0.1:3456
  # → open at https://<magicdns-name>:3456?token=XXXX&defaultProvider=claude
  ```

- **Only when you want a direct LAN connection from the glasses/phone**, explicitly set `HOST=0.0.0.0`. This is a setting that listens on all network interfaces including the LAN, not just Tailscale. Use it only in an environment where you can confirm, via your router's and host's firewall settings, that the port cannot be reached from the internet side, public Wi-Fi, or untrusted devices. Do not use it if there is an untrusted device on the same LAN either.

  ```bash
  HOST=0.0.0.0 TMCON_TOKEN=$(openssl rand -hex 16) node server.mjs
  ```

- `HOST` can take any address (e.g. to listen only on the Tailscale IP, `HOST=100.x.y.z`).
