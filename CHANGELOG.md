# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Raised the optional `@anthropic-ai/claude-agent-sdk` to `^0.3.312` (was
  `^0.3.252`, which installs had resolved to 0.3.278). SDK 0.3.284 fixed
  `query()` closing the CLI's stdin before a follow-up turn woken by a finished
  background agent — the bug behind the 0.3.0 query-recycle workaround, which
  is now removed (see Fixed). The bump also clears three `npm audit`
  advisories (`@modelcontextprotocol/sdk`, `hono`, `zod`; 8 → 5 in total).

### Fixed

- Claude backend: the query is no longer closed and reopened with `resume`
  after a background (Task sub-agent) cycle. That workaround (0.3.0) left the
  replaced child running: it outlived `close()`, still held the same session,
  and kept acting on its own background notifications, so one conversation
  could end up with several `claude` processes, each able to edit files. Each
  session again keeps exactly one query and one child process.
- Claude backend: typed user turns are now stamped `origin: {kind: "human"}`,
  as the SDK requires. Without it Claude Code treats the input as unattributed
  and fails it closed at its `isHuman()` trust gates. The hidden
  auto-continuation is deliberately left unattributed, since it is not human
  input.
- Claude backend: a result is now matched to the user's turn by `origin.kind`
  (`human`, or no origin) rather than by whether it carries an `origin` at all.
  The SDK forwards the triggering message's origin onto its result, so with the
  stamp above the old check would have taken every foreground answer for a
  background update and left the turn stuck on "Running...".
  `task-notification`, `peer` and `channel` results still never resolve a
  pending turn.
- Claude backend: the idle GC no longer tears down a query while background
  tasks are in flight. It assumed background work keeps SDK messages flowing,
  but the SDK sends no heartbeat while a background agent waits on a tool that
  prints nothing: a silent 120 s `sleep` left a 108 s gap with only two
  `task_progress` messages. So a long build, sleep or Monitor running past
  `CLAUDE_SESSION_IDLE_MS` (10 min) had its query closed and the background
  agent killed mid-flight. The check is now `isIdleForGc()`, which skips any
  query with a pending foreground turn or a non-zero background task count.
- WebUI: reopening a session that is waiting on a question or permission
  request no longer loses the answer card. The SSE resends the pending request
  before the history fetch resolves, so the card landed at the top of the empty
  log and the history was appended below it, pushing it off-screen. After the
  history renders, any unanswered card is moved back to the end of the log,
  keeping any input already typed.

### Security

- Pinned `markdown-it` to 14.3.3 (via the existing `markdownlint-cli`
  `overrides` block) to clear two `npm audit` advisories, one of them high
  severity. Dev-tooling only — the published package has no runtime
  dependencies, so this changes nothing for installs and is not a release.
  The three remaining advisories live inside the optional Claude SDK's own
  peer tree (`@modelcontextprotocol/sdk` → `hono`, `ip-address`) and need an
  upstream SDK release; see [docs/maintaining.md](docs/maintaining.md).
- Cleared the last five `npm audit` advisories (one high) in the lock alone:
  `body-parser` 2.4.0, `qs` 6.17.1, `@hono/node-server` 2.1.5, `ip-address`
  10.7.5 and `fast-uri` 3.1.9, all inside the optional Claude SDK's
  `@modelcontextprotocol/sdk` peer tree and all within the ranges it already
  declares, so no upstream release was needed after all. `package.json` is
  unchanged and nothing published moves; `npm audit` now reports 0.

## [0.4.0] - 2026-10-23

### Added

- WebUI: on viewports 320px tall or shorter, the header and footer fold away
  while a session is open, leaving a thin grip at the top and the status row
  alone at the bottom. A bar slides open when the pointer comes near its
  screen edge, when it is hovered, or when focus moves inside it; tapping a grip
  pins that bar open for touch screens. The collapsed bars occupy body's
  padding, so opening one overlays the log rather than reflowing it. The
  header's grip claims a whole row, so it gives that row back once the header
  is open — the open bar shows itself — except while pinned, where the grip is
  the only way back to collapsed. The
  threshold can be overridden from the URL — `?compact=1` / `?compact=0` to
  force it on or off, `?compact=<px>` to move it. In compact mode the status
  row's elapsed-seconds counter also ticks every 10s instead of every second:
  on glasses it is the only thing on an idle screen that changes, and every
  change is a tile pushed over BLE.
- WebUI: on a folded viewport, keeping the wheel scrolling down at the end of
  the log focuses the text field — which slides the footer open by itself —
  instead of having to find the grip, pin the bar and then tap the field.
  A turn of the wheel back up — or Escape — blurs the field, which collapses
  the footer again; that notch is spent on closing and scrolls nothing
  underneath, since closing already hands ~110px of screen back to the log and
  one notch should do one thing. Over the field itself an upward turn scrolls a
  long draft first, and only puts the field away once that draft is at its own
  top; the text survives either way. The price is **two notches**
  of wheel travel the log could not absorb, within one stroke (a 2s gap, or a
  turn back up, starts it over — two deliberate clicks of the wheel are a
  second or more apart and must still count as one gesture) — a count rather than a distance, since a
  notch is 100px on one mouse, 53px on the next and 3 lines in Firefox's line
  mode, and any fixed pixel threshold is three notches for somebody. It is
  floored at 80px and capped at 150px of overscroll, so a trackpad's stream of
  10px dribbles (and the inertial tail that keeps firing them past the bottom)
  cannot pop the keyboard up on someone merely coasting to a stop, and a coarse
  wheel cannot demand a long push. The stroke is measured against the page's own
  running position rather than the live `scrollTop`, because `wheel` fires
  before the scroll it causes and smooth scrolling then animates it over
  ~150ms — read live, the overscroll of the first notches goes missing and the
  gesture silently costs an extra turn of the wheel.
- WebUI: `?diag=1` also prints the bounce gesture's arithmetic on a second line
  — `wheel <deltaY>/<deltaMode> = <px> over <reached>/<needed>` — so a wheel
  that takes one turn too many can be read off the screen rather than guessed
  at from the outside.
- WebUI: `?diag=1` draws a viewport ruler (a dashed frame on the browser's idea
  of the viewport edges plus `win` / `doc` / `scrollW` / `visualViewport` / `dpr`
  readouts), to tell a display that crops the window apart from a page that
  overflows on its own. `?width=<px>` / `?width=screen` then holds the page to
  the visible part of such a window.
- `tmcon-cli` now shows token usage on the prompt line, after the status:
  `[Waiting for input] Ctx:2% 5h:8% 1w:24% ›`. Thresholds match the WebUI (dim
  below 50%, yellow below 80%, red at 80% and above, suffixed with `!` so the
  warning reads on a colorless terminal); a local backend shows
  `Tok:used/max` in place of the 5h/1w windows, and windows the backend cannot
  report are omitted. Usage is read when the session opens and when a turn
  completes — never polled — and the cells are trimmed from the right (`1w`
  first) on a narrow terminal so the prompt always stays one physical line.
- Config file support: the server (`tmcon`) and the CLI (`tmcon-cli`) now read a
  plain `KEY=VALUE` `.env` config file by default from
  `~/.config/terminal-mode-console/env` (override with `--config <path>` or
  `TMCON_CONFIG`). Settings resolve as **arguments > environment variables >
  config file > built-in defaults**; a real environment variable always wins
  over the same key in the file.
- Server command-line arguments `--host`, `--port`, `--token`, `--config`, plus
  `--version` / `--help`. `tmcon-cli` gained `--config` and `--version`.

### Changed

- Renamed configuration environment variables to the `TMCON_` namespace for
  collision-safety and traceability:
  - `HOST` → `TMCON_HOST`, `PORT` → `TMCON_PORT` (the legacy `HOST` / `PORT` are
    still accepted as fallbacks, e.g. for PaaS that inject `PORT`).
  - CLI: `EVEN_URL` → `TMCON_URL`, `EVEN_TOKEN` → `TMCON_TOKEN`, `EVEN_PROVIDER`
    → `TMCON_PROVIDER`, `EVEN_MODEL` → `TMCON_MODEL`.
  - `/api/info` exposure reporting: `EVEN_TERMINAL_EXPOSE_PROVIDER` →
    `TMCON_EXPOSE_PROVIDER`, `EVEN_HOST_MODE` → `TMCON_HOST_MODE`. The old
    `EVEN_*` names are no longer read.

### Fixed

- Add `config.mjs` and `session-metadata.mjs` to the published `files` list.
  Both are imported by `server.mjs`, so a global/published install (`npm i -g`)
  previously crashed at startup with `ERR_MODULE_NOT_FOUND`
  (`session-metadata.mjs` was a pre-existing omission).
- Mark the `bin` entry points (`server.mjs`, `bin/tmcon-cli.mjs`) executable so
  they can be run directly via their shebang.

## [0.3.1] - 2026-09-22

### Changed

- Tracked upstream `@evenrealities/even-terminal` up to v0.10.4 (protocol notes
  were based on v0.8.1) and aligned the HTTP API responses for compatibility
  with newer clients:
  - `401` responses now use the structured envelope
    `{"error":{"code":"auth_failed","message":"Unauthorized"}}` instead of the
    bare `{"error":"Unauthorized"}` string.
  - `/api/info` now includes `extra.expose` (`off` by default; honours the same
    `EVEN_TERMINAL_EXPOSE_PROVIDER` / `EVEN_HOST_MODE` env vars as upstream), and
    answers a failed build with `500 {"error":{"code":"info_failed","message"}}`.
  - `/api/permission-response` now rejects a decision that was never offered:
    unknown session → `404 {"error":"Session not found"}`, session with no
    pending request → `400 {"error":"…not offered or no permission request is
pending"}` (previously always acknowledged with `200`).
  - Documented that the experimental `claude-sync` provider name is accepted
    (it resolves to the `claude` slot; its internal CLI-wrapping transport is
    not reimplemented). Updated `docs/protocol.md` / `docs/protocol.ja.md`.

## [0.3.0] - 2026-09-22

### Fixed

- Claude backend: a foreground turn sent right after a background (Task
  sub-agent) cycle completed could hang forever ("Running...", no response),
  because the SDK stops emitting a foreground result for the reused persistent
  query. The query is now recycled (closed and reopened with `resume`, keeping
  context) on the next turn after a background cycle. Verified end-to-end
  against the live Claude backend.

### Added

- Request log now shows the real client behind a fronting proxy. When the TCP
  peer is loopback (e.g. `tailscale serve` forwarding from `127.0.0.1`), the
  server reads the `Tailscale-User-Login` / `X-Forwarded-For` headers and logs
  the accessing user and their source IP together (e.g. `[you@example.com,
10.x.x.x]`) instead of `127.0.0.1`. Controlled by the new `TRUST_PROXY`
  (default on; `0` to log the raw peer). Documented `LOG_REQUESTS` alongside it.
- Project metadata for publication: `repository`, `bugs`, `homepage`, `author`,
  and `keywords` fields in `package.json`.
- Standard open-source files: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`,
  `.editorconfig`, and a GitHub Actions CI workflow (test + lint on Node 20/22).
- Minimum supported Node.js is 20 (the optional Claude/Codex SDKs and the dev
  tooling require it); the dependency-free core still uses only the standard
  library.
- Eight new UI locales: `es`, `fr`, `de`, `pt`, `zh` (Simplified), `zh-Hant`
  (Traditional), `ko`, `ru` (machine-assisted, review welcome). English/Japanese
  continue to ship as before; unsupported languages fall back to English.
- BCP 47 locale resolution (server, CLI, and WebUI). Locale files are keyed by
  BCP 47 tag and resolved with an RFC 4647 "lookup" fallback (most-specific →
  base language → English); the script subtag is inferred from the region via
  `Intl.Locale.maximize()` (e.g. `zh-TW` → `zh-Hant` → `zh`). Regional/script
  variant files (e.g. `zh-Hant.json`, `pt-BR.json`) may be partial and inherit
  missing keys from their base language.
- Security-focused tests: HTTP-layer tests for `server.mjs` (token auth,
  `/api/fs/dirs` listing behind the token, `/api/prompt` validation and the
  image-size cap) and tool-dispatch tests for `agents/tools.mjs`
  (auto-allow gating, `execute` for each tool).

### Changed

- `package.json` description is now in English.
- Documentation restructured for publication: a concise, English-default
  `README.md` for users with the deep operator/developer content moved to
  `docs/developer.md`. Japanese counterparts are provided and cross-linked
  (`README.ja.md`, `docs/developer.ja.md`, `docs/protocol.ja.md`, `NOTICE.ja.md`);
  English is now the source of truth for `docs/protocol.md` and `NOTICE.md`.
- All in-source code comments translated from Japanese to English.
- All runtime user-facing strings (glasses/WebUI notifications, session-title
  fallback) and model-facing strings (local-LLM system prompt, tool descriptions,
  tool results) moved out of the source and into `locales/`. User-facing strings
  are translated across all shipped locales; model-facing strings default to
  English (other locales fall back to it). The WebUI now keys the "waiting"
  notification off a stable `key` field instead of matching localized title text.

## 0.2.0 (pre-public)

- Locale-based i18n (ja/en) shared by the server, CLI, and WebUI.
- Per-provider color theming in the WebUI to distinguish Claude / Codex / local.
- Linting and formatting tooling: ESLint, Prettier, markdownlint, stylelint,
  HTMLHint, and cspell.

[Unreleased]: https://github.com/sunasaji/terminal-mode-console/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sunasaji/terminal-mode-console/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/sunasaji/terminal-mode-console/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sunasaji/terminal-mode-console/releases/tag/v0.3.0
