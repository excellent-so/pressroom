// pressroom — import, the reverse of the publish runner: pull a static site's
// existing content/posts/*.mdx into the local posts folder so they become managed
// here (`pressroom import`).
//
// Matched BY SLUG: a post already in the folder is replaced by the site's version,
// and a new slug is added. The imported post's `updated` stamp is derived from the
// site's own `date` (not the wall clock) and an existing local `created` is
// preserved, so re-importing unchanged site content rewrites nothing on disk.

import fs from "node:fs";
import path from "node:path";
import { parseMdxFrontmatter } from "./frontmatter.mjs";
import { readPost, writePost } from "./posts.mjs";
import { contentPostsDir } from "./config.mjs";
import { today } from "./lib.mjs";

function asString(v) {
  if (Array.isArray(v)) return v[0] ?? "";
  return v == null ? "" : String(v);
}
function asTags(v) {
  if (Array.isArray(v)) return v.filter((t) => String(t).trim());
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/**
 * Import every `.mdx` under the source dir (default: the site repo's content dir,
 * overridable with `from`) into the local workspace.
 *
 * @param {object} config
 * @param {{from?:string}} [opts]  `from` overrides the source dir (the `--from=` flag)
 * @returns {{ok:boolean, reason?:string, imported:number, updated:number, unchanged:number, slugs:string[]}}
 */
export function importPostsFromSite(config, opts = {}) {
  const sourceDir = opts.from ? path.resolve(opts.from) : contentPostsDir(config);
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return { ok: false, reason: "content-posts-dir-missing", imported: 0, updated: 0, unchanged: 0, slugs: [] };
  }

  const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith(".mdx"));
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  const slugs = [];

  for (const file of files) {
    const slug = file.replace(/\.mdx$/, "");
    const raw = fs.readFileSync(path.join(sourceDir, file), "utf8");
    const { data, content } = parseMdxFrontmatter(raw);
    const date = asString(data.date); // "YYYY-MM-DD"
    const existing = readPost(config, slug);
    const post = {
      slug,
      title: asString(data.title) || slug,
      excerpt: asString(data.description || data.excerpt),
      // Preserve site-managed author/tags so a later re-publish keeps them.
      author: asString(data.author),
      status: "published",
      date,
      tags: asTags(data.tags),
      // Keep the slug + date stable so a re-import never forks or renames.
      created: (existing && existing.created) || date || today(),
      // Deterministic stamp (site date) → re-import is byte-for-byte idempotent.
      updated: date || today(),
      body: content,
    };
    const { changed } = writePost(config, post);
    if (!existing) imported++;
    else if (changed) updated++;
    else unchanged++;
    slugs.push(slug);
  }

  return { ok: true, imported, updated, unchanged, slugs };
}
