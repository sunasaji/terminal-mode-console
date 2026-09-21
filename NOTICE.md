日本語: [NOTICE.ja.md](NOTICE.ja.md)

# About This Project

## An Independent Implementation

terminal-mode-console is an **independent implementation** of a server that
communicates with the Terminal Mode app of the Even Realities G2.

- **It contains none of the `@evenrealities/even-terminal` code.** No copying,
  modification, or derivation of any kind has taken place; all code in this
  repository was written from scratch.
- The only things referenced were the **behavior** of the publicly available
  package and the **shape of the HTTP API** it exposes. The shape of the API
  (endpoint names, JSON field names, and so on) must match in order to
  interoperate; it is a functional specification, not a copying of expression.

## What It Is Based On

The contents of `docs/protocol.md` were derived from the following two sources:

1. Reading the source of `@evenrealities/even-terminal` (published on npm under
   the MIT license)
2. Observing the HTTP/SSE communication, **on my own device**, between my own
   app and a server I started myself

Neither involves decompiling the software or circumventing protection
mechanisms. The first is an act the MIT license explicitly permits, and the
second is observing communication between things I own. The G2 app itself was
never touched or analyzed.

## Trademarks and Affiliation

- **This project is not affiliated with, nor endorsed or sponsored by, Even
  Realities.**
- "Even Realities" and "Even G2" are trademarks of their respective owners. This
  project refers to them only for the purpose of identifying the corresponding
  hardware and software.
- The phrase "even-terminal-compatible" is meant in the **technical sense** of
  speaking the same HTTP API, and does not indicate any official compatibility
  certification.

## Respect for the Upstream

This project exists thanks to the author of even-terminal, who published it as
straightforward REST + SSE under the MIT license, without using a proprietary
protocol or certificate pinning. If you are going to use the G2, we recommend
trying the official even-terminal first.

If you notice improvements or errors, please contribute them back upstream where
possible.
