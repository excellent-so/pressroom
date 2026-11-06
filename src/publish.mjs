// pressroom — the publish runner: read a post from its local `<slug>.mdx` file
// (posts.mjs), serialize it to MDX matching the site's frontmatter, write it into
// the site repo's content dir, commit ONLY that file, and push (the site host then
// rebuilds). Settings come from the `pressroom.config.*` object. Returns a
// structured result — it never throws on the git path; a failed step comes back as
// { ok:false, reason }.
//
// Invariants: SCOPED commit (`git add <path>` → `git commit -- <path>`, never
// `git add -A`); no-op when the target already matches byte for byte; NEVER
// force-push; a git failure surfaces git's own stderr.

import fs from "node:fs";
import path from "node:path";
import { parseMdxFrontmatter } from "./frontmatter.mjs";
import { serializePostToMdx } from "./serialize.mjs";
import { readPost, writePost, listPosts } from "./posts.mjs";
import { contentPostsDir } from "./config.mjs";
import { git, isGitRepo, today, nowStamp } from "./lib.mjs";

export { serializePostToMdx };

/** Map a local post → the shape serializePostToMdx consumes. */
function serializableFromPost(post, effectiveDate) {
  return {
    title: post.title,
    body: post.body,
    excerpt: post.excerpt || null,
    published_at: effectiveDate || post.date || null,
    created_at: post.created || today(),
  };
}

/**
 * Publish one post to the site. Serializes to MDX, writes content/posts/<slug>.mdx
 * into the site repo, commits ONLY that file, and pushes.
 *
 * @param {object} config  resolved pressroom config
 * @param {string} slug
 * @param {{dryRun?:boolean, push?:boolean}} [opts]
 *   `dryRun` returns the would-be MDX and touches nothing; `push:false` commits
 *   without pushing (defaults to `config.push`).
 * @returns {{ok:boolean, slug?:string, relPath?:string, dryRun?:boolean,
 *   committed?:boolean, pushed?:boolean, retried?:boolean, unchanged?:boolean, sha?:string,
 *   content?:string, reason?:string}}
 *   `retried`: nothing new to commit, but an earlier commit of this file that never reached origin
 *   was pushed now.
 */
export function publishPost(config, slug, opts = {}) {
  const post = readPost(config, slug);
  if (!post) return { ok: false, reason: "post-not-found", slug };

  const relPath = path.posix.join(config.contentDir, `${slug}.mdx`);
  const postsDir = contentPostsDir(config);
  const absPath = postsDir ? path.join(postsDir, `${slug}.mdx`) : null;

  // The date the post will carry publicly: its own date, else today (stamped below).
  const effectiveDate = post.date || today();

  // Preserve site-managed frontmatter (tags, author, hero, …) from the existing
  // file so re-publishing an imported post never strips it. pressroom only
  // overrides title/description/date/body.
  const frontmatter = {};
  if (absPath && fs.existsSync(absPath)) {
    Object.assign(frontmatter, parseMdxFrontmatter(fs.readFileSync(absPath, "utf8")).data);
  }
  if (!frontmatter.author) frontmatter.author = post.author || config.defaultAuthor;
  // Same rule for tags: the site's own win; a post's tags fill in when the site has none.
  const siteTags = frontmatter.tags;
  const siteHasTags = Array.isArray(siteTags) ? siteTags.some((t) => String(t).trim()) : Boolean(String(siteTags ?? "").trim());
  if (!siteHasTags && post.tags && post.tags.length) frontmatter.tags = post.tags;

  const content = serializePostToMdx(serializableFromPost(post, effectiveDate), {
    frontmatter,
    defaultAuthor: config.defaultAuthor,
  });

  if (opts.dryRun) {
    return { ok: true, dryRun: true, slug, relPath, content };
  }

  // Fail closed if the site checkout isn't where we expect a real git repo with the
  // content pipeline — writing into the wrong tree is worse than not writing.
  if (!config.siteRepo) return { ok: false, reason: "site-repo-not-configured", relPath, content };
  if (!isGitRepo(config.siteRepo)) return { ok: false, reason: "site-repo-not-found", relPath, content };
  if (!postsDir || !fs.existsSync(postsDir)) {
    return { ok: false, reason: "content-posts-dir-missing", relPath, content };
  }

  // Stamp the post published locally once the site has it (committed, pushed, or
  // already there), and only when that changes something, so a re-publish never
  // churns `updated`. A failed publish leaves the post as it was.
  const stamp = () => {
    if (post.status !== "published" || !post.date) {
      writePost(config, { ...post, status: "published", date: effectiveDate, updated: nowStamp() });
    }
  };

  const doPush = opts.push !== undefined ? opts.push : config.push;

  // Nothing new to commit. If an earlier publish committed this file but its push failed, that commit is
  // still only local (ahead of origin/<branch>), so push it now; otherwise there's nothing to do.
  const settled = () => {
    let waiting = "";
    try { waiting = doPush === false ? "" : git(["log", "--format=%H", `origin/${config.branch}..HEAD`, "--", relPath], config.siteRepo); } catch {}
    if (!waiting) {
      stamp();
      return { ok: true, slug, relPath, committed: false, unchanged: true, content };
    }
    try {
      git(["push", "origin", config.branch], config.siteRepo);
    } catch (e) {
      return { ok: false, reason: (e.stderr || e.message || "git failed").trim(), relPath, content };
    }
    stamp();
    return { ok: true, slug, relPath, committed: false, pushed: true, retried: true, sha: git(["rev-parse", "HEAD"], config.siteRepo), content };
  };

  // Idempotency: if the site file already matches byte-for-byte, don't commit again.
  const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
  if (existing === content) return settled();

  try {
    fs.writeFileSync(absPath, content, "utf8");
  } catch (e) {
    return { ok: false, reason: `write-failed: ${e.message}`, relPath, content };
  }

  try {
    // SCOPED: stage ONLY this file — never sweep unrelated working-tree changes.
    git(["add", relPath], config.siteRepo);
    // No-op if nothing actually changed vs. the index/HEAD (belt-and-suspenders).
    const staged = git(["status", "--porcelain", "--", relPath], config.siteRepo);
    if (!staged) return settled();
    git(["commit", "-m", `blog: publish ${slug}`, "--", relPath], config.siteRepo);
    const sha = git(["rev-parse", "HEAD"], config.siteRepo);
    if (doPush === false) {
      stamp();
      return { ok: true, slug, relPath, committed: true, sha, content };
    }
    // NEVER force — a non-fast-forward push fails and we surface git's stderr.
    git(["push", "origin", config.branch], config.siteRepo);
    stamp();
    return { ok: true, slug, relPath, committed: true, pushed: true, sha, content };
  } catch (e) {
    return { ok: false, reason: (e.stderr || e.message || "git failed").trim(), relPath, content };
  }
}

/**
 * The drain: publish every publishable post idempotently. "Publishable" = status
 * `ready` (promoted to publish) or `published` (re-emitted, so an edit lands). A
 * `draft` is never touched by the drain. Safe to run repeatedly — an unchanged post
 * skips both commit and push.
 *
 * @returns {{ok:boolean, considered:number, published:number, results:Array, reason?:string}}
 */
export function publishReady(config, opts = {}) {
  const posts = listPosts(config).filter((p) => p.status === "ready" || p.status === "published");
  const results = [];
  let published = 0;
  for (const post of posts) {
    const r = publishPost(config, post.slug, { push: opts.push, dryRun: opts.dryRun });
    results.push(r);
    if (r.ok && r.committed) published++;
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      considered: posts.length,
      published,
      results,
      reason: `${failed.length}/${posts.length} post(s) failed to publish`,
    };
  }
  return { ok: true, considered: posts.length, published, results };
}
