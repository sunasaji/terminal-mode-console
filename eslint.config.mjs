// ESLint flat config — terminal-mode-console
//
// A pure ESM / zero-dependency Node.js project.
// Add the dev dependencies before running:
//   npm i -D eslint globals
//
// Docs: https://eslint.org/docs/latest/use/configure/configuration-files

import js from "@eslint/js";
import globals from "globals";

export default [
  // 1) Not analyzed (kept consistent with .gitignore)
  {
    ignores: [
      "node_modules/**",
      "web/vendor/**", // bundled minified libraries (diff2html/highlight/marked/purify)
      "**/*.log",
      "**/*.min.js",
    ],
  },

  // 2) Base recommended rules
  js.configs.recommended,

  // 3) Node.js side: server / agents / bin / tests (.mjs)
  {
    files: ["**/*.mjs"],
    ignores: ["web/**"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off", // allowed since this is a server/CLI
    },
  },

  // 4) Test files: allow the node:test global environment
  {
    files: ["test/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // 5) Browser side: front-end JS in web/
  {
    files: ["web/**/*.js"],
    ignores: ["web/vendor/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script", // IIFE style (not ESM)
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
