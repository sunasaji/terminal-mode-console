import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../web/tagged-markdown.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);
const split = context.TaggedMarkdown.split;
const parseTreeRaw = context.TaggedMarkdown.parseTree;
const parseTree = (s) => {
  const r = parseTreeRaw(s);
  return r === null ? null : JSON.parse(JSON.stringify(r));
};

test("parses a flat task-notification into key/value nodes", () => {
  const tree = parseTree(
    "<task-id>abc</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>",
  );
  assert.deepEqual(tree, [
    { tag: "task-id", value: "abc" },
    { tag: "status", value: "completed" },
    { tag: "summary", value: "Agent finished" },
  ]);
});

test("keeps leaf values containing & < > literally instead of failing", () => {
  const tree = parseTree(
    "<status>done</status>\n<summary>Ran foo & bar; result < 5 items. See a<b compare.</summary>",
  );
  assert.equal(tree.length, 2);
  assert.equal(tree[1].tag, "summary");
  assert.equal(
    tree[1].value,
    "Ran foo & bar; result < 5 items. See a<b compare.",
  );
});

test("parses nested metadata into a child tree", () => {
  const tree = parseTree("<env>\n<cwd>/tmp</cwd>\n<git>true</git>\n</env>");
  assert.deepEqual(tree, [
    {
      tag: "env",
      children: [
        { tag: "cwd", value: "/tmp" },
        { tag: "git", value: "true" },
      ],
    },
  ]);
});

test("keeps a value with a balanced-looking inline tag literal, not a branch", () => {
  const tree = parseTree("<summary>Use <code>foo</code> here</summary>");
  assert.equal(tree.length, 1);
  assert.equal(tree[0].tag, "summary");
  assert.equal(tree[0].value, "Use <code>foo</code> here"); // stray text -> literal leaf
});

test("returns null for free text that is not a clean tag tree", () => {
  assert.equal(parseTree('if [ $a -lt 5 ] && echo "<x>" > out'), null); // stray text
  assert.equal(parseTree("plain notification text"), null);
  assert.equal(parseTree("<summary>unterminated"), null);
});

test("captures attributes on a leaf node", () => {
  const tree = parseTree('<file path="/a/b.txt">changed</file>');
  assert.deepEqual(tree, [
    { tag: "file", value: "changed", attrs: 'path="/a/b.txt"' },
  ]);
});

test("extracts Markdown from arbitrary custom prompt tags", () => {
  const parts = split(
    "before\n<recommended_plugins>\n- **GitHub**\n</recommended_plugins>\nafter",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), [
    { type: "text", content: "before\n" },
    { type: "tag", tag: "recommended_plugins", content: "- **GitHub**" },
    { type: "text", content: "after" },
  ]);
});

test("extracts adjacent custom tags as separate metadata blocks", () => {
  const parts = split(
    "<recommended_plugins>- GitHub</recommended_plugins><environment_context><cwd>/tmp</cwd></environment_context>",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), [
    { type: "tag", tag: "recommended_plugins", content: "- GitHub" },
    { type: "tag", tag: "environment_context", content: "<cwd>/tmp</cwd>" },
  ]);
});

test("extracts a paired custom tag embedded after ordinary user text", () => {
  const parts = split("question\n<INSTRUCTIONS>\n# Rules\n</INSTRUCTIONS>");
  assert.equal(parts[0].content, "question\n");
  assert.equal(parts[1].tag, "INSTRUCTIONS");
});

test("supports uppercase and nested same-name custom tags", () => {
  const parts = split(
    "<INSTRUCTIONS>\n# One\n<INSTRUCTIONS>\ninner\n</INSTRUCTIONS>\n</INSTRUCTIONS>\n",
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, "tag");
  assert.equal(parts[0].tag, "INSTRUCTIONS");
  assert.match(parts[0].content, /# One/);
});

test("treats punctuation in a custom tag name literally", () => {
  const parts = split("<app.context>\n- value\n</appXcontext>\n</app.context>");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, "tag");
  assert.match(parts[0].content, /appXcontext/);
});

test("leaves standard HTML and unmatched custom tags as plain text", () => {
  for (const input of [
    "<div>\n**not converted**\n</div>",
    "<environment_context>\n- unfinished",
  ]) {
    const parts = split(input);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, "text");
    assert.equal(parts[0].content, input);
  }
});
