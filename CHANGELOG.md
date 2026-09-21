# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sunasaji/terminal-mode-console/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sunasaji/terminal-mode-console/releases/tag/v0.3.0
