# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue for
anything that could be exploited.

- Use GitHub's [private vulnerability reporting](https://github.com/sunasaji/terminal-mode-console/security/advisories/new)
  ("Report a vulnerability" on the repository's Security tab), or
- Email the maintainer at the address listed on the GitHub profile.

Please include a description, reproduction steps, and the affected version or
commit. You can expect an initial acknowledgement within a few days. This is a
volunteer-maintained project, so please allow reasonable time for a fix before
any public disclosure.

## Threat model

terminal-mode-console is designed to run on **your own machine or private
network** (for example behind Tailscale), not exposed directly to the public
internet. Keep this in mind when deploying:

- **Authentication is a single shared token** (`TMCON_TOKEN`). Anyone who has
  the token has full access to the console, including any connected agent.
  Generate an unguessable value (e.g. `openssl rand -hex 16`) and treat it as a
  secret. The token can appear in URLs (`?token=…`); avoid leaking it via
  browser history, logs, or shared links.
- **Connected agents can run code and read files.** Claude Code, Codex, and the
  built-in local-LLM agent loop can execute shell commands and read the
  filesystem with the privileges of the user running the server. A leaked token
  is therefore equivalent to shell access on the host.
- **The server binds to `127.0.0.1` by default.** Only change the bind address
  when you understand the exposure, and prefer a private overlay network over a
  public interface.
- **CORS and transport.** The API is REST + SSE over plain HTTP by default.
  Terminate TLS at a reverse proxy or overlay network if you need encryption in
  transit.

See the "Security" section of the README and `docs/protocol.md` for more detail
on the authentication and pairing model.

## Supported versions

Security fixes target the latest released version on the default branch.
