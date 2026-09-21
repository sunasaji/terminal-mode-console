# Contributing

Thanks for your interest in improving terminal-mode-console! Contributions of
all kinds are welcome — bug reports, fixes, documentation, translations, and new
backends.

## Getting started

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/sunasaji/terminal-mode-console.git
cd terminal-mode-console
npm install          # or: npm install --omit=optional  (local LLM / echo only)
npm test
```

The optional Claude and Codex SDKs are declared as `optionalDependencies`; the
project runs with zero core dependencies when they are omitted.

## Before you open a pull request

Run the full local check suite (this is what CI runs):

```bash
npm run format:check   # Prettier
npm run lint:all       # ESLint + markdownlint + HTMLHint + cspell
npm test               # node --test
```

`npm run format` and `npm run lint:fix` will auto-fix most formatting and lint
issues.

## Guidelines

- **Language.** Code and comments are written in English. User-facing strings
  live in `locales/*.json`, not in the source (see Translations below).
- **Dependencies.** Keep the core dependency-free (Node.js standard library
  only). New third-party runtime dependencies should be optional and gated so
  the base install still works without them.
- **Tests.** Add tests for new logic where practical. Pure/extracted helpers are
  easy to test with `node --test`; see `test/*.test.mjs` for patterns (for
  example `session-metadata.test.mjs` uses a temp directory).
- **Docs.** Update the relevant document under `docs/` and, if behavior
  changes, the README. English is the source of truth; the Japanese README
  (`README.ja.md`) may lag.
- **Changelog.** Add a short entry under "Unreleased" in `CHANGELOG.md` for
  user-visible changes.

## Adding a new backend

The agent registry (`agents/index.mjs`) resolves provider slots to backend
implementations. See the "Adding a new backend" section of the README and the
existing agents in `agents/` (`echo.mjs` is the minimal reference) for the
interface a backend must implement.

## Translations

Adding a language is intentionally cheap: drop a `locales/<tag>.json` file next
to the existing ones. Files are keyed by [BCP 47](https://www.rfc-editor.org/info/bcp47)
language tag — `en.json`, `ja.json`, `zh.json`, and, for regional or script
variants, tags like `zh-Hant.json` or `pt-BR.json`.

Locale resolution follows the BCP 47 / RFC 4647 "lookup" fallback: a requested
tag is matched most-specific first, then less specific, then English. The script
subtag (Hans/Hant) is inferred from the region, so a browser sending `zh-TW`
prefers `zh-Hant.json` when it exists and otherwise falls back to `zh.json`.
Variant files may be partial: any missing key is filled from the base language
and then from English. So `zh-Hant.json` only needs to list what differs from
`zh.json`.

Use `locales/en.json` as the key reference. Machine-assisted translations are
welcome — please note in the PR if a translation has not been reviewed by a
native speaker.

## Reporting bugs and security issues

Open a GitHub issue for bugs and feature requests. For anything security-related,
please follow [SECURITY.md](SECURITY.md) and report privately instead.

## Relationship to Even Realities

This is an independent, unaffiliated implementation. Please read
[NOTICE.md](NOTICE.md) before contributing protocol-related changes.
