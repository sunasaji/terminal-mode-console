(function (root) {
  "use strict";

  // Custom prompt metadata is commonly delivered as Markdown enclosed in XML-like
  // tags.  Standard HTML is deliberately excluded so a pasted HTML example keeps
  // being displayed verbatim.
  const HTML_TAGS = new Set(
    (
      "a abbr address area article aside audio b base bdi bdo blockquote body br button " +
      "canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl " +
      "dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header " +
      "hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta " +
      "meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby " +
      "s samp script search section select slot small source span strong style sub summary sup " +
      "table tbody td template textarea tfoot th thead time title tr track u ul var video wbr"
    ).split(" "),
  );

  function splitTaggedMarkdown(raw) {
    const text = String(raw ?? "");
    const segments = [];
    const token = /<\/?([A-Za-z][\w.-]*)>/g;
    let cursor = 0;
    let match;
    while ((match = token.exec(text))) {
      const tag = match[1];
      const isClosing = match[0][1] === "/";
      if (isClosing || HTML_TAGS.has(tag.toLowerCase())) continue;
      const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sameTag = new RegExp(`<(/?)${escapedTag}>`, "ig");
      sameTag.lastIndex = token.lastIndex;
      let depth = 1;
      let close;
      while ((close = sameTag.exec(text))) {
        if (close[1]) depth--;
        else depth++;
        if (depth === 0) break;
      }
      if (!close) continue;
      if (match.index > cursor)
        segments.push({
          type: "text",
          content: text.slice(cursor, match.index),
        });
      segments.push({
        type: "tag",
        tag,
        content: text
          .slice(token.lastIndex, close.index)
          .replace(/^\r?\n|\r?\n$/g, ""),
      });
      cursor = sameTag.lastIndex;
      // A wrapper written on its own lines owns the newline after its closing tag;
      // keeping it would create an unexplained blank line before the next block.
      if (text[cursor] === "\r" && text[cursor + 1] === "\n") cursor += 2;
      else if (text[cursor] === "\n") cursor++;
      token.lastIndex = cursor;
    }
    if (cursor < text.length)
      segments.push({ type: "text", content: text.slice(cursor) });
    return segments;
  }

  // Metadata such as <environment_context> or <task-notification> is a shallow
  // tree of <key>value</key> pairs, but leaf values are free text that routinely
  // contains &, <, > (prose summaries, shell output).  A strict XML parser rejects
  // those, so we tokenise leniently instead: match a specific opening tag to its
  // depth-balanced closing tag (same approach as split), and treat a leaf's inner
  // text as a literal string.  A block only becomes a branch when its whole content
  // is itself clean tag pairs; anything else stays a literal leaf, so `a<b` or
  // `foo & bar` inside a value never derails the parse.
  const OPEN_TAG = /<([A-Za-z][\w.-]*)((?:\s[^<>]*?)?)(\/?)>/g;

  // Find the depth-balanced close of `name` starting at `from`. Returns the index
  // where the inner content ends and where scanning should resume, or null if
  // unbalanced (which makes the caller treat the surrounding text as a literal).
  function matchClose(text, name, from) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<(/?)${esc}(?:\\s[^<>]*?)?(/?)>`, "g");
    re.lastIndex = from;
    let depth = 1;
    let m;
    while ((m = re.exec(text))) {
      if (m[1])
        depth--; // </name>
      else if (!m[2]) depth++; // <name> (a <name/> self-close is net zero)
      if (depth === 0) return { contentEnd: m.index, after: re.lastIndex };
    }
    return null;
  }

  // Parse one level. ok=false when non-whitespace text sits outside tag pairs at
  // this level, i.e. the content is not clean structured metadata.
  function parseLevel(text, depth) {
    const nodes = [];
    if (depth > 20) return { nodes, ok: false }; // guard against pathological nesting
    const open = new RegExp(OPEN_TAG.source, "g");
    let cursor = 0;
    let m;
    while ((m = open.exec(text))) {
      if (text.slice(cursor, m.index).trim()) return { nodes, ok: false };
      const name = m[1];
      const attrs = m[2].trim();
      if (m[3] === "/") {
        // self-closing: empty leaf
        nodes.push(
          attrs ? { tag: name, attrs, value: "" } : { tag: name, value: "" },
        );
        cursor = open.lastIndex;
        continue;
      }
      const close = matchClose(text, name, open.lastIndex);
      if (!close) return { nodes, ok: false };
      const inner = text.slice(open.lastIndex, close.contentEnd);
      const child = parseLevel(inner, depth + 1);
      const node =
        child.ok && child.nodes.length
          ? { tag: name, children: child.nodes }
          : { tag: name, value: inner.trim() };
      if (attrs) node.attrs = attrs;
      nodes.push(node);
      cursor = close.after;
      open.lastIndex = cursor;
    }
    if (text.slice(cursor).trim()) return { nodes, ok: false };
    return { nodes, ok: true };
  }

  // Public: return an array of {tag, attrs?, value|children} for cleanly nested
  // metadata, or null when the content is not a clean tag tree (caller then falls
  // back to Markdown rendering).
  function parseTagTree(raw) {
    const res = parseLevel(String(raw ?? ""), 0);
    return res.ok && res.nodes.length ? res.nodes : null;
  }

  root.TaggedMarkdown = { split: splitTaggedMarkdown, parseTree: parseTagTree };
})(typeof window === "undefined" ? globalThis : window);
