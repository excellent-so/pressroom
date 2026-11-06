// pressroom — the local posts workspace. There is no database: posts are files.
// The workspace is a directory (default `./posts`), one `<slug>.mdx` per post, each
// a frontmatter block + markdown body. This module is the file ⇄ post model: slug,
// list, read, write, new.
//
// A post has a slug, title, body, excerpt, status, published date and timestamps.
// `status` is a three-state life cycle: draft → ready → published.

import fs from "node:fs";
import path from "node:path";
import { parseMdxFrontmatter, asString, asTags } from "./frontmatter.mjs";
import { yamlStr, emitKey } from "./serialize.mjs";
import { today, nowStamp, ensureDir } from "./lib.mjs";

export const STATUSES = ["draft", "ready", "published"];
const STATUS_SET = new Set(STATUSES);

// The keys of a local post file that pressroom reads into fields. Any other key
// (heroImage, a site-specific flag) is kept as written, in `extra`.
const LOCAL_KEYS = new Set(["title", "status", "excerpt", "description", "author", "date", "tags", "created", "updated"]);

/**
 * Slugify a title: lowercase ASCII letters and digits joined by hyphens, at most 80
 * chars ("post" if none). Accents are dropped first, so "Café" becomes "cafe".
 */
export function slugify(s) {
  return (
    String(s)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "post"
  );
}

/** Can `slug` name a post file? Any file name, but no folders and no leading dot. */
export function isValidSlug(slug) {
  const s = String(slug ?? "");
  return Boolean(s) && !/[/\\\0]/.test(s) && !s.startsWith(".");
}

/**
 * The fallback description: the body's first paragraph of prose (not a heading,
 * code, an import, a component or an image), markup stripped, at most 160 chars.
 */
export function deriveExcerpt(body) {
  const strip = (s) => String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")          // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")       // links keep their text
    .replace(/^\s*(?:[>#]+|[-*+]|\d+\.)\s+/gm, "")  // quote, heading and list markers
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const noCode = String(body).replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, ""); // fenced code
  const prose = noCode
    .split(/\n\s*\n/)
    .find((p) => !/^\s*(#|import\s|export\s|<|!\[|\||---|\*\*\*)/.test(p) && strip(p));
  const text = strip(prose ?? noCode);
  if (text.length <= 160) return text;
  const cut = text.slice(0, 160);
  return cut.slice(0, cut.lastIndexOf(" ") > 100 ? cut.lastIndexOf(" ") : 160).replace(/[\s,;:.]+$/, "") + "…";
}

/**
 * Parse a local `<slug>.mdx` file's raw text into a post object. The local
 * frontmatter shape is: status, title, excerpt, author, date, tags, created,
 * updated — plus the markdown body. Other keys land in `extra`, written back as
 * they are and published when the site's copy doesn't have them.
 */
export function parsePostFile(raw, slug) {
  const { data, content } = parseMdxFrontmatter(raw);
  const extra = {};
  for (const [k, v] of Object.entries(data)) if (!LOCAL_KEYS.has(k)) extra[k] = v;
  const status = STATUS_SET.has(asString(data.status)) ? asString(data.status) : "draft";
  return {
    slug,
    title: asString(data.title) || slug,
    // Accept `excerpt` (local) or `description` (a site-shaped import).
    excerpt: asString(data.excerpt || data.description),
    author: asString(data.author),
    status,
    date: asString(data.date), // published date, "YYYY-MM-DD" (empty for a fresh draft)
    tags: asTags(data.tags),
    created: asString(data.created) || asString(data.date),
    updated: asString(data.updated),
    extra,
    body: content,
  };
}

/** Serialize a post object → the local `<slug>.mdx` file text. */
export function serializePostFile(post) {
  const lines = ["---"];
  lines.push(`title: ${yamlStr((post.title || post.slug).trim())}`);
  lines.push(`status: ${STATUS_SET.has(post.status) ? post.status : "draft"}`);
  if (post.excerpt && post.excerpt.trim()) lines.push(`excerpt: ${yamlStr(post.excerpt.trim())}`);
  if (post.author && post.author.trim()) lines.push(`author: ${yamlStr(post.author.trim())}`);
  if (post.date && post.date.trim()) lines.push(`date: ${yamlStr(post.date.trim())}`);
  const tags = asTags(post.tags);
  if (tags.length) {
    lines.push("tags:");
    for (const t of tags) lines.push(`  - ${yamlStr(t.trim())}`);
  }
  for (const [k, v] of Object.entries(post.extra || {})) {
    if (!LOCAL_KEYS.has(k) && /^[A-Za-z_][\w-]*$/.test(k)) emitKey(k, v, lines);
  }
  if (post.created && post.created.trim()) lines.push(`created: ${yamlStr(post.created.trim())}`);
  lines.push(`updated: ${yamlStr((post.updated && post.updated.trim()) || nowStamp())}`);
  lines.push("---");
  lines.push("");
  lines.push(String(post.body || "").trim());
  lines.push("");
  return lines.join("\n");
}

/** The absolute file path of a post's local `.mdx`. */
export function postPath(config, slug) {
  return path.join(config.postsDir, `${slug}.mdx`);
}

/** Does a local post exist for this slug? */
export function postExists(config, slug) {
  return isValidSlug(slug) && fs.existsSync(postPath(config, slug));
}

/** Read one post by slug, or null if it doesn't exist. */
export function readPost(config, slug) {
  if (!isValidSlug(slug)) return null;
  const file = postPath(config, slug);
  if (!fs.existsSync(file)) return null;
  return parsePostFile(fs.readFileSync(file, "utf8"), slug);
}

/**
 * Write a post to disk. Idempotent: if the serialized text is byte-for-byte
 * identical to what's on disk, it does NOT rewrite (so `updated` doesn't churn on
 * a no-op save). Returns { changed, file }.
 */
export function writePost(config, post) {
  ensureDir(config.postsDir);
  const file = postPath(config, post.slug);
  const next = serializePostFile(post);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev === next) return { changed: false, file };
  fs.writeFileSync(file, next, "utf8");
  return { changed: true, file };
}

/** List every post in the workspace, newest-created first. */
export function listPosts(config) {
  let files;
  try {
    files = fs.readdirSync(config.postsDir).filter((f) => f.endsWith(".mdx"));
  } catch {
    return [];
  }
  const posts = [];
  for (const f of files) {
    const slug = f.replace(/\.mdx$/, "");
    const raw = fs.readFileSync(path.join(config.postsDir, f), "utf8");
    posts.push(parsePostFile(raw, slug));
  }
  posts.sort((a, b) => (b.created || "").localeCompare(a.created || "") || a.slug.localeCompare(b.slug));
  return posts;
}

/** A unique slug for `title`, appending -2, -3, … if the base is taken. */
export function uniqueSlug(config, title) {
  const base = slugify(title);
  let slug = base;
  let n = 2;
  while (postExists(config, slug)) slug = `${base}-${n++}`;
  return slug;
}

/**
 * Scaffold a new draft post from a title. Returns the created post (with its file
 * written). The slug is unique in the posts folder (`-2`, `-3`, … on a clash).
 */
export function newPost(config, { title, body, excerpt, author, status = "draft" } = {}) {
  const slug = uniqueSlug(config, title);
  const stamp = today();
  const bodyText = body ?? `Write your post here. This is **${title.trim()}**.\n`;
  const post = {
    slug,
    title: title.trim(),
    // Left empty, publish describes the post with the start of its body as it is then.
    excerpt: (excerpt ?? "").trim(),
    author: author ?? config.defaultAuthor ?? "",
    status: STATUS_SET.has(status) ? status : "draft",
    date: status === "published" ? stamp : "",
    tags: [],
    created: stamp,
    updated: nowStamp(),
    body: bodyText,
  };
  writePost(config, post);
  return post;
}
