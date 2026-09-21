import test from "node:test";
import assert from "node:assert/strict";
import { titleFromUserText } from "../agents/codex.mjs";

test("titleFromUserText removes injected Codex context blocks", () => {
  assert.equal(
    titleFromUserText(`<recommended_plugins>\n- GitHub\n</recommended_plugins>
<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>
セッション一覧を改善してください`),
    "セッション一覧を改善してください",
  );
});

test("titleFromUserText skips a context-only message", () => {
  assert.equal(
    titleFromUserText("<recommended_plugins>GitHub</recommended_plugins>"),
    "",
  );
});

test("titleFromUserText removes repository instructions", () => {
  assert.equal(
    titleFromUserText(` <recommended_plugins>x</recommended_plugins># AGENTS.md instructions for /tmp/project
<INSTRUCTIONS>\n# Rules\nRun tests.\n</INSTRUCTIONS>
実際の依頼です`),
    "実際の依頼です",
  );
});

test("titleFromUserText makes a compact bounded title", () => {
  assert.equal(
    titleFromUserText("  複数行の\n\n  依頼です  ", 7),
    "複数行の 依頼",
  );
});
