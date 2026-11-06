// pressroom — post → MDX serialization: turns a post into the file publish writes
// into the site repo. A pure, zero-dependency function, so the CLI, the viewer
// server, and the test suite share one implementation.
//
// It emits the frontmatter a static-site content pipeline reads: title,
// description, date, tags[] and author, under the key names the site uses (the
// `fields` config maps them, e.g. `date` → `pubDate` for the Astro blog template).
//
// There is no built-in byline. The author comes from the post itself, then the
// configured `defaultAuthor` (which config.mjs fills from `git config user.name`
// when the config sets none). With neither, the `author` key is left out.

import { today } from "./lib.mjs";

/** The frontmatter key names pressroom writes on the site, before any `fields` mapping. */
export const SITE_FIELDS = Object.freeze({
  title: "title",
  description: "description",
  date: "date",
  tags: "tags",
  author: "author",
});

/** YAML-safe double-quoted scalar on one line (escapes \ and ", folds line breaks to spaces). */
export function yamlStr(s) {
  return `"${String(s).replace(/\s*[\r\n]+\s*/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Emit one frontmatter key — block list for arrays, quoted scalar otherwise. */
export function emitKey(key, val, lines) {
  if (Array.isArray(val)) {
    const items = val.filter((v) => String(v).trim());
    if (!items.length) return;
    lines.push(`${key}:`);
    for (const v of items) lines.push(`  - ${yamlStr(String(v).trim())}`);
  } else if (val != null && String(val).trim()) {
    lines.push(`${key}: ${yamlStr(String(val).trim())}`);
  }
}

/**
 * "YYYY-MM-DD HH:MM:SS" or an ISO stamp → "YYYY-MM-DD"; today when there is none.
 * Any other text (a site's own "Jul 08 2022") is written as it is.
 */
function toDateOnly(ts) {
  if (!ts) return today();
  const s = String(ts).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/**
 * A serializable post → the MDX file body (frontmatter + content).
 *
 * @param {{title:string, body:string, excerpt?:string|null, published_at?:string|null, created_at?:string, date_text?:string}} post
 *   `date_text` is written as it is (the site's own date, kept when it's the same day).
 * @param {{frontmatter?:Record<string,string|string[]>, defaultAuthor?:string, fields?:Record<string,string>}} [opts]
 *   `frontmatter` carries site-managed keys through (tags, author, hero, …);
 *   pressroom owns title/description/date/body and never inherits them. `defaultAuthor`
 *   is the fallback byline. With neither, the output has no `author` key. `fields`
 *   renames the keys pressroom writes (see SITE_FIELDS).
 * @returns {string}
 */
export function serializePostToMdx(post, opts = {}) {
  const k = { ...SITE_FIELDS, ...(opts.fields ?? {}) };
  const fm = { ...(opts.frontmatter ?? {}) };
  // pressroom owns these — never inherit them from the prior file.
  delete fm[k.title];
  delete fm[k.description];
  delete fm[k.date];
  // The site's byline (a name, or a list of names), else the fallback.
  const authorVal = fm[k.author];
  const author =
    (Array.isArray(authorVal) && authorVal.some((a) => String(a).trim()) && authorVal) ||
    (typeof authorVal === "string" && authorVal.trim()) ||
    (opts.defaultAuthor && String(opts.defaultAuthor).trim()) ||
    "";
  delete fm[k.author];

  const lines = ["---"];
  lines.push(`${k.title}: ${yamlStr(post.title.trim())}`);
  const description = (post.excerpt ?? "").trim();
  if (description) lines.push(`${k.description}: ${yamlStr(description)}`);
  lines.push(`${k.date}: ${yamlStr(post.date_text || toDateOnly(post.published_at ?? post.created_at))}`);
  // Preserved keys: tags first (the common one), then the rest, stable-sorted.
  if (fm[k.tags]) emitKey(k.tags, fm[k.tags], lines);
  for (const key of Object.keys(fm).sort()) {
    if (key === k.tags) continue;
    emitKey(key, fm[key], lines);
  }
  emitKey(k.author, author, lines);
  lines.push("---");
  lines.push("");
  lines.push(post.body.trim());
  lines.push("");
  return lines.join("\n");
}
