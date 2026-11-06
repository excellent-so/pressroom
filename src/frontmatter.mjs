// pressroom — a minimal gray-matter-compatible frontmatter parser, the inverse of
// serialize.mjs. It splits a post file into its frontmatter (`data`) and its
// markdown body (`content`); pressroom uses it to read local posts, the site's
// existing posts on publish, and the site's posts on import. Zero dependencies —
// there is no YAML library in the tool, so a serialize→parse round-trip is what
// the test suite locks.
//
// Scope is deliberately narrow: top-level `key: scalar` pairs plus single-level
// block lists (`tags:` then `  - item`). That covers every field a blog uses
// (title, description, date, tags, author, hero, heroAlt, and pressroom's local
// status/created/updated). Nested maps aren't supported — if you ever need them,
// reach for a real YAML parser.

/** Strip YAML quoting from a scalar; unescape \" and \\ inside double quotes. */
function parseScalar(raw) {
  const s = String(raw).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Split "---\n<yaml>\n---\n<body>" into { data, content }.
 *
 * @param {string} raw
 * @returns {{data: Record<string, string|string[]>, content: string}}
 */
export function parseMdxFrontmatter(raw) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { data: {}, content: String(raw).trim() };

  const data = {};
  let listKey = null;

  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(parseScalar(item[1] ?? ""));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    const key = kv?.[1];
    if (!key) continue;
    const rest = kv?.[2] ?? "";
    if (rest.trim() === "") {
      // A bare `key:` opens a block list; rows below attach to it.
      data[key] = [];
      listKey = key;
    } else {
      data[key] = parseScalar(rest);
      listKey = null;
    }
  }

  return { data, content: (m[2] ?? "").trim() };
}
