// pressroom — import, the reverse of the publish runner: pull a static site's
// existing posts (`.mdx` and `.md` files in its content folder) into the local
// posts folder so they become managed here (`pressroom import`).
//
// Matched BY SLUG: a post already in the folder is replaced by the site's version,
// and a new slug is added. The imported post's `updated` stamp is derived from the
// site's own date (not the wall clock) and an existing local `created` is
// preserved, so re-importing unchanged site content rewrites nothing on disk.

import fs from "node:fs";
import path from "node:path";
import { parseMdxFrontmatter, asString, asTags, normalizeDate, isBlank, frontmatterKind } from "./frontmatter.mjs";
import { readPost, writePost, isValidSlug } from "./posts.mjs";
import { contentPostsDir } from "./config.mjs";
import { SITE_FIELDS } from "./serialize.mjs";
import { today } from "./lib.mjs";

/** The site's post files in `dir`, one per slug (`<slug>.mdx` wins over `<slug>.md`). */
export function sitePostFiles(dir) {
  const bySlug = new Map();
  for (const file of fs.readdirSync(dir).sort()) {
    const m = /^(.+)\.(mdx|md)$/.exec(file);
    if (!m || !isValidSlug(m[1]) || !fs.statSync(path.join(dir, file)).isFile()) continue;
    if (!bySlug.has(m[1]) || m[2] === "mdx") bySlug.set(m[1], file);
  }
  return [...bySlug].map(([slug, file]) => ({ slug, file }));
}

// Keys sites use for a post's publish date: pubDate (Astro's blog template),
// publishDate, publishedAt, published_at, datePublished, …
const DATE_KEY = /^(?:pub|publish|published)[_-]?(?:date|at|on)?$|^date[_-]?published$/i;

/**
 * The key the site's posts keep their date in, when none of them uses `dateKey`:
 * "pubDate" for the Astro blog template. Null when they use `dateKey`, or nothing
 * date-like, or there are no posts.
 */
export function siteDateKey(dir, dateKey = SITE_FIELDS.date) {
  if (!dir || !fs.existsSync(dir)) return null;
  const counts = new Map();
  for (const { file } of sitePostFiles(dir)) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    if (frontmatterKind(raw) !== "yaml") continue;
    const { data } = parseMdxFrontmatter(raw);
    if (!isBlank(data[dateKey])) return null;
    for (const key of Object.keys(data)) {
      if (DATE_KEY.test(key) && !isBlank(data[key])) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Import every `.mdx` and `.md` post in the source dir (default: the site repo's
 * content dir, overridable with `from`) into the local workspace.
 *
 * @param {object} config
 * @param {{from?:string}} [opts]  `from` overrides the source dir (the `--from=` flag)
 * Posts whose frontmatter isn't YAML (Eleventy's `---js`, TOML's `+++`), or has values
 * over several lines (a nested map, `>-` text), are left out and listed in `skipped`:
 * pressroom can't read all of them, so it mustn't rewrite them.
 *
 * @returns {{ok:boolean, reason?:string, message?:string, imported:number, updated:number, unchanged:number, slugs:string[], skipped:string[]}}
 */
export function importPostsFromSite(config, opts = {}) {
  const sourceDir = opts.from ? path.resolve(opts.from) : contentPostsDir(config);
  if (!sourceDir || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    const message = !sourceDir
      ? "No site repo is set, so there's nothing to import from. Set siteRepo in your config, or pass --from=<folder>."
      : `${sourceDir} doesn't exist. Set contentDir to the folder your site keeps its posts in, or pass --from=<folder>.`;
    return { ok: false, reason: "content-posts-dir-missing", message, imported: 0, updated: 0, unchanged: 0, slugs: [], skipped: [] };
  }

  const k = { ...SITE_FIELDS, ...(config.fields ?? {}) };
  const owned = new Set(Object.values(k));
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  const slugs = [];
  const skipped = [];

  for (const { slug, file } of sitePostFiles(sourceDir)) {
    const raw = fs.readFileSync(path.join(sourceDir, file), "utf8");
    if (frontmatterKind(raw) === "other") { skipped.push(file); continue; }
    const { data, content, nested } = parseMdxFrontmatter(raw);
    if (nested.length) { skipped.push(file); continue; }
    const date = normalizeDate(data[k.date]); // "YYYY-MM-DD"
    const existing = readPost(config, slug);
    // The site's other keys (heroImage, updatedDate, …) ride along in the local file.
    const extra = {};
    for (const [key, v] of Object.entries(data)) if (!owned.has(key)) extra[key] = v;
    const post = {
      slug,
      title: asString(data[k.title]) || slug,
      excerpt: asString(data[k.description] || data.excerpt),
      // Preserve site-managed author/tags so a later re-publish keeps them.
      author: asString(data[k.author]),
      status: "published",
      date,
      tags: asTags(data[k.tags]),
      // Keep the slug + date stable so a re-import never forks or renames.
      created: (existing && existing.created) || date || today(),
      // Deterministic stamp (site date) → re-import is byte-for-byte idempotent.
      updated: date || today(),
      extra,
      body: content,
    };
    const { changed } = writePost(config, post);
    if (!existing) imported++;
    else if (changed) updated++;
    else unchanged++;
    slugs.push(slug);
  }

  return { ok: true, imported, updated, unchanged, slugs, skipped };
}
