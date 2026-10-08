# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/sunasaji/terminal-mode-console/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/sunasaji/terminal-mode-console/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sunasaji/terminal-mode-console/releases/tag/v0.3.0
