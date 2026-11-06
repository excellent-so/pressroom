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
 * Split "---\n<yaml>\n---\n<body>" into { data, content, nested }. `nested` names the
 * keys whose value runs over indented lines this parser doesn't read (a map such as
 * `author:` with `name:` under it, or `>-` block text), so callers can leave them be.
 *
 * @param {string} raw
 * @returns {{data: Record<string, string|string[]>, content: string, nested: string[]}}
 */
export function parseMdxFrontmatter(raw) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { data: {}, content: String(raw).trim(), nested: [] };

  const data = {};
  const nested = new Set();
  let listKey = null;
  let lastKey = null;

  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(parseScalar(item[1] ?? ""));
      continue;
    }
    if (/^\s/.test(line) && lastKey) { nested.add(lastKey); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    const key = kv?.[1];
    if (!key) continue;
    lastKey = key;
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

  return { data, content: (m[2] ?? "").trim(), nested: [...nested] };
}

/**
 * What kind of frontmatter a file opens with: "yaml" (`---`), "other" (one pressroom
 * can't read, such as Eleventy's `---js` or `---json`, or TOML's `+++`), or "none".
 */
export function frontmatterKind(raw) {
  const s = String(raw).replace(/^\uFEFF/, "");
  if (/^---[ \t]*\r?\n/.test(s)) return "yaml";
  if (/^(?:---[ \t]*[A-Za-z]\w*|\+\+\+)[ \t]*\r?\n/.test(s)) return "other";
  return "none";
}

/** A frontmatter value as one string (the first item of a list). */
export function asString(v) {
  if (Array.isArray(v)) return v[0] ?? "";
  return v == null ? "" : String(v);
}

/** A frontmatter value as a list of non-blank tags. */
export function asTags(v) {
  if (Array.isArray(v)) return v.filter((t) => String(t).trim());
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** True when a frontmatter value says nothing: missing, blank, or an empty list. */
export function isBlank(v) {
  return Array.isArray(v) ? !v.some((x) => String(x).trim()) : !String(v ?? "").trim();
}

/**
 * A site's date as "YYYY-MM-DD". An ISO date or stamp keeps its own day; other text
 * a date parser reads ("Jul 08 2022", the Astro blog template's style) becomes the
 * day it names, read as local time the way a site build reads it. Text that isn't
 * a date comes back as it is.
 */
export function normalizeDate(v) {
  const s = asString(v).trim();
  if (!s) return "";
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Do two parsed files say the same thing? The same body, and the same frontmatter
 * values in any order and any quoting; blank keys count as absent.
 */
export function sameMeaning(a, b) {
  if (a.content !== b.content) return false;
  const norm = (data) => {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (isBlank(v)) continue;
      out[k] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : String(v).trim();
    }
    return out;
  };
  const x = norm(a.data);
  const y = norm(b.data);
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]));
}
