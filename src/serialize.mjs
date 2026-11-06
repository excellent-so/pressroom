// pressroom — post → MDX serialization: turns a post into the file publish writes
// into the site repo. A pure, zero-dependency function, so the CLI, the viewer
// server, and the test suite share one implementation.
//
// It emits exactly the gray-matter frontmatter a static-site MDX pipeline reads
// (title, description, date, tags[], author), so a post drops into
// content/posts/*.mdx with zero schema change on the site.
//
// There is no built-in byline. The author comes from the post itself, then the
// configured `defaultAuthor` (which config.mjs fills from `git config user.name`
// when the config sets none). With neither, the `author` key is left out.

/** YAML-safe double-quoted scalar (escapes \ and "). */
export function yamlStr(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Emit one frontmatter key — block list for arrays, quoted scalar otherwise. */
function emitKey(key, val, lines) {
  if (Array.isArray(val)) {
    const items = val.filter((v) => String(v).trim());
    if (!items.length) return;
    lines.push(`${key}:`);
    for (const v of items) lines.push(`  - ${yamlStr(String(v).trim())}`);
  } else if (String(val).trim()) {
    lines.push(`${key}: ${yamlStr(String(val).trim())}`);
  }
}

/** "YYYY-MM-DD HH:MM:SS" or an ISO stamp → "YYYY-MM-DD"; today when there is none. */
function toDateOnly(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}

/**
 * A serializable post → the MDX file body (frontmatter + content).
 *
 * @param {{title:string, body:string, excerpt?:string|null, published_at?:string|null, created_at?:string}} post
 * @param {{frontmatter?:Record<string,string|string[]>, defaultAuthor?:string}} [opts]
 *   `frontmatter` carries site-managed keys through (tags, author, hero, …);
 *   pressroom owns title/description/date/body and never inherits them. `defaultAuthor`
 *   is the fallback byline (the configured `defaultAuthor`). With neither, the output
 *   has no `author` key.
 * @returns {string}
 */
export function serializePostToMdx(post, opts = {}) {
  const fm = { ...(opts.frontmatter ?? {}) };
  // pressroom owns these — never inherit them from the prior file.
  delete fm.title;
  delete fm.description;
  delete fm.date;
  const authorVal = fm.author;
  const author =
    (typeof authorVal === "string" && authorVal.trim()) ||
    (opts.defaultAuthor && String(opts.defaultAuthor).trim()) ||
    "";
  delete fm.author;

  const lines = ["---"];
  lines.push(`title: ${yamlStr(post.title.trim())}`);
  const description = (post.excerpt ?? "").trim();
  if (description) lines.push(`description: ${yamlStr(description)}`);
  lines.push(`date: ${yamlStr(toDateOnly(post.published_at ?? post.created_at))}`);
  // Preserved keys: tags first (the common one), then the rest, stable-sorted.
  if (fm.tags) emitKey("tags", fm.tags, lines);
  for (const key of Object.keys(fm).sort()) {
    if (key === "tags") continue;
    emitKey(key, fm[key], lines);
  }
  if (author && author.trim()) lines.push(`author: ${yamlStr(author)}`);
  lines.push("---");
  lines.push("");
  lines.push(post.body.trim());
  lines.push("");
  return lines.join("\n");
}
