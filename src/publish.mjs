// pressroom — the publish runner: read a post from its local `<slug>.mdx` file
// (posts.mjs), serialize it to the frontmatter the site reads, write it into the
// site repo's content dir, commit ONLY that file, and push (the site host then
// rebuilds). Settings come from the `pressroom.config.*` object. Returns a
// structured result — it never throws on the git path; a failed step comes back as
// { ok:false, reason, message, detail? }: `reason` is a stable code, `message` one
// sentence that says what to do, `detail` git's own words when git refused.
//
// Invariants: SCOPED commit (`git add <path>` → `git commit -- <path>`, never
// `git add -A`); no commit when the site's copy already says the same thing; NEVER
// force-push; nothing is written until the site repo can take the commit; edits
// someone made to the site's copy by hand are never overwritten.

import fs from "node:fs";
import path from "node:path";
import { parseMdxFrontmatter, asString, isBlank, normalizeDate, sameMeaning, frontmatterKind } from "./frontmatter.mjs";
import { serializePostToMdx, SITE_FIELDS } from "./serialize.mjs";
import { readPost, writePost, listPosts, isValidSlug, deriveExcerpt } from "./posts.mjs";
import { contentPostsDir } from "./config.mjs";
import { git, gitOr, isGitRepo, today, nowStamp } from "./lib.mjs";

export { serializePostToMdx };

/**
 * The site's file for a post: the one the site already has (`<slug>.mdx`, else
 * `<slug>.md`), or `<slug>` + the configured extension for a post new to the site.
 */
export function siteFileName(dir, slug, extension = ".mdx") {
  const has = (f) => Boolean(dir) && fs.existsSync(path.join(dir, f));
  if (has(`${slug}.mdx`)) return `${slug}.mdx`;
  if (has(`${slug}.md`)) return `${slug}.md`;
  return `${slug}${extension}`;
}

function failure(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/**
 * Why the site repo can't take a publish right now, as [reason, message], or null.
 * Checked before anything is written, so a refusal leaves the site as it was.
 */
export function siteProblem(config, { push = true } = {}) {
  const site = config.siteRepo;
  if (!site) {
    return ["site-repo-not-configured", "No site repo is set. Set siteRepo in pressroom.config.mjs (pressroom init writes one), or pass --site-repo=<path>."];
  }
  if (!fs.existsSync(site)) {
    return ["site-repo-not-found", `The site repo ${site} doesn't exist. Set siteRepo to your site's git checkout.`];
  }
  if (!isGitRepo(site)) {
    return ["site-repo-not-found", `${site} isn't a git repo (it has no .git folder). Set siteRepo to the top folder of your site's git checkout.`];
  }
  const cdir = contentPostsDir(config);
  if (!fs.existsSync(cdir)) {
    return ["content-posts-dir-missing", `The content folder ${cdir} doesn't exist. Create it, or set contentDir to the folder your site reads posts from.`];
  }
  let branch = "";
  try {
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], site);
  } catch (e) {
    if (e.missing) return ["git-missing", "git isn't installed or isn't on your PATH. Install it (https://git-scm.com/downloads), then publish again."];
    // A detached HEAD fails quietly; anything git says is a reason it can't work there.
    if (e.stderr) return ["git-failed", `git can't work in ${site}: ${e.stderr.split("\n")[0]}`];
  }
  if (branch !== config.branch) {
    return ["wrong-branch", branch
      ? `The site repo is on branch ${branch}, but publish pushes ${config.branch}. Run git switch ${config.branch} in ${site}, or set branch: "${branch}" in your config.`
      : `The site repo has no branch checked out. Run git switch ${config.branch} in ${site}, then publish again.`];
  }
  if (push && !gitOr(["remote", "get-url", "origin"], site)) {
    return ["no-remote", `The site repo has no remote named origin, so there's nowhere to push. Add one with git remote add origin <url> in ${site}, or publish with --no-push.`];
  }
  return null;
}

/** Has git been told who is committing? Without it, git invents a name from the machine. */
function hasGitIdentity(site) {
  const env = process.env;
  const name = env.GIT_AUTHOR_NAME || gitOr(["config", "user.name"], site);
  const email = env.GIT_AUTHOR_EMAIL || env.EMAIL || gitOr(["config", "user.email"], site);
  return Boolean(name.trim() && email.trim());
}

function pushFailure(e, config, extra) {
  const detail = String(e.stderr || e.message || "git failed").trim();
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(detail)) {
    return failure("push-rejected", `The commit is in your site repo, but the push was rejected: origin has commits this checkout doesn't. Run git pull in ${config.siteRepo}, then publish again to push it.`, { ...extra, detail });
  }
  return failure("push-failed", "The commit is in your site repo, but the push to origin failed. Fix what git says below, then publish again to push it.", { ...extra, detail });
}

/**
 * Publish one post to the site. Serializes it, writes <contentDir>/<slug>.mdx (or the
 * site's existing `.md`) into the site repo, commits ONLY that file, and pushes.
 *
 * @param {object} config  resolved pressroom config
 * @param {string} slug
 * @param {{dryRun?:boolean, push?:boolean}} [opts]
 *   `dryRun` returns the would-be file and touches nothing; `push:false` commits
 *   without pushing (defaults to `config.push`).
 * @returns {{ok:boolean, slug?:string, relPath?:string, dryRun?:boolean,
 *   committed?:boolean, pushed?:boolean, retried?:boolean, unchanged?:boolean, sha?:string,
 *   content?:string, reason?:string, message?:string, detail?:string}}
 *   `retried`: nothing new to commit, but an earlier commit of this file that never reached origin
 *   was pushed now.
 */
export function publishPost(config, slug, opts = {}) {
  if (!isValidSlug(slug)) {
    return failure("post-not-found", `"${slug}" can't name a post: use a post's file name in your posts folder, without .mdx.`, { slug });
  }
  const post = readPost(config, slug);
  if (!post) {
    return failure("post-not-found", `There's no post ${slug} in ${config.postsDir}. Run pressroom list to see your posts.`, { slug });
  }

  const k = { ...SITE_FIELDS, ...(config.fields ?? {}) };
  const postsDir = contentPostsDir(config);
  const fileName = siteFileName(postsDir, slug, config.extension);
  const relPath = path.posix.join(config.contentDir, fileName);
  const absPath = postsDir ? path.join(postsDir, fileName) : null;
  const existing = absPath && fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
  if (existing !== null && frontmatterKind(existing) === "other") {
    return failure("site-copy-unreadable", `${relPath} on the site has frontmatter pressroom can't read (it isn't YAML), so publishing would replace it. Edit that post in the site repo.`, { slug, relPath });
  }
  const siteCopy = existing === null ? null : parseMdxFrontmatter(existing);

  // The date the post will carry publicly: its own date, else today (stamped below).
  const effectiveDate = post.date || today();

  // Keys pressroom doesn't own (tags, author, heroImage, …) are kept from the site's
  // copy; the post's own fill in where the site's copy has none. A post new to the
  // site takes the default byline when it names no author.
  const frontmatter = { ...(siteCopy?.data ?? {}) };
  for (const [key, value] of Object.entries(post.extra ?? {})) {
    if (isBlank(frontmatter[key])) frontmatter[key] = value;
  }
  if (isBlank(frontmatter[k.author])) frontmatter[k.author] = post.author || (siteCopy ? "" : config.defaultAuthor);
  if (isBlank(frontmatter[k.tags]) && post.tags.length) frontmatter[k.tags] = post.tags;
  // The site's own way of writing the date ("Jul 08 2022", a full timestamp) is kept
  // when it's the same day.
  const siteDate = siteCopy ? asString(siteCopy.data[k.date]).trim() : "";
  const keepSiteDate = Boolean(siteDate) && normalizeDate(siteDate) === effectiveDate;

  // An empty excerpt is described by the start of the body, unless the site already
  // has this post with no description (then none is invented, as with the byline).
  const describe = !siteCopy || !isBlank(siteCopy.data[k.description]);
  const excerpt = post.excerpt || (describe ? deriveExcerpt(post.body) : "");

  const content = serializePostToMdx(
    { title: post.title, body: post.body, excerpt, published_at: effectiveDate, date_text: keepSiteDate ? siteDate : "" },
    { frontmatter, fields: k },
  );

  // Values over several lines (a nested map, `>-` text) can't be written back: a
  // change would lose them, so leave that post to the site repo.
  if (siteCopy?.nested.length && !sameMeaning(siteCopy, parseMdxFrontmatter(content))) {
    return failure("site-copy-unreadable", `${relPath} on the site has frontmatter pressroom can't keep (${siteCopy.nested.join(", ")}: values over several lines), so publishing a change would lose it. Edit that post in the site repo.`, { slug, relPath });
  }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, slug, relPath, content };
  }

  const doPush = opts.push !== undefined ? opts.push : config.push;
  const site = config.siteRepo;
  const at = { slug, relPath, content };

  // Fail closed before writing anything: writing into a tree that can't take the
  // commit is worse than not writing.
  const problem = siteProblem(config, { push: doPush !== false });
  if (problem) return failure(problem[0], problem[1], at);

  // Stamp the post published locally once the site has it (committed, pushed, or
  // already there), and only when that changes something, so a re-publish never
  // churns `updated`. A failed publish leaves the post as it was.
  const stamp = () => {
    if (post.status !== "published" || !post.date) {
      writePost(config, { ...post, status: "published", date: effectiveDate, updated: nowStamp() });
    }
  };

  const push = (result) => {
    try {
      git(["push", "origin", config.branch], site);
    } catch (e) {
      return pushFailure(e, config, at);
    }
    stamp();
    return { ...result, pushed: true };
  };

  // Nothing new to commit. If an earlier publish committed this file but its push failed, that commit is
  // still only local (ahead of origin/<branch>), so push it now; otherwise there's nothing to do.
  const settled = () => {
    const unchanged = { ok: true, slug, relPath, committed: false, unchanged: true, content };
    if (doPush === false) { stamp(); return unchanged; }
    const tracking = gitOr(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${config.branch}`], site);
    const waiting = tracking
      ? gitOr(["log", "--format=%H", `origin/${config.branch}..HEAD`, "--", relPath], site)
      : gitOr(["log", "-1", "--format=%H", "HEAD", "--", relPath], site); // origin has never had the branch
    if (!waiting) { stamp(); return unchanged; }
    return push({ ok: true, slug, relPath, committed: false, retried: true, sha: git(["rev-parse", "HEAD"], site), content });
  };

  // The state of the site's copy in git: staged changes are pressroom's own (it
  // stages what it writes); unstaged ones, or an untracked file, someone else made.
  const tracked = Boolean(gitOr(["ls-files", "--", relPath], site));
  const staged = Boolean(gitOr(["diff", "--cached", "--name-only", "--", relPath], site));
  const unstaged = existing !== null && (!tracked || Boolean(gitOr(["diff", "--name-only", "--", relPath], site)));

  if (existing === content) {
    // Already written. An earlier publish may have stopped before its commit; finish it.
    if (!staged && !unstaged) return settled();
  } else if (unstaged) {
    return failure("site-copy-changed", `${relPath} has changes in the site repo that aren't committed, and publishing would overwrite them. Commit or discard them in ${site}, then publish again.`, at);
  } else if (siteCopy && !staged && sameMeaning(siteCopy, parseMdxFrontmatter(content))) {
    // The same title, date, keys and body, written another way: leave the site's file alone.
    return settled();
  }

  if (!hasGitIdentity(site)) {
    return failure("no-git-identity", "git doesn't know your name and email, so it can't commit. Run git config --global user.name \"Your Name\" and git config --global user.email \"you@example.com\", then publish again.", at);
  }

  if (existing !== content) {
    try {
      fs.writeFileSync(absPath, content, "utf8");
    } catch (e) {
      return failure("write-failed", `Couldn't write ${absPath}: ${e.message}`, at);
    }
  }

  let sha;
  try {
    // SCOPED: stage ONLY this file — never sweep unrelated working-tree changes.
    git(["add", "--", relPath], site);
    // Nothing differs from the last commit (belt and braces): nothing to commit.
    if (!gitOr(["diff", "--cached", "--name-only", "--", relPath], site)) return settled();
    git(["commit", "-m", `blog: publish ${slug}`, "--", relPath], site);
    sha = git(["rev-parse", "HEAD"], site);
  } catch (e) {
    return failure("commit-failed", `git couldn't commit ${relPath}. Fix what git says below, then publish again.`, { ...at, detail: String(e.stderr || e.message).trim() });
  }
  if (doPush === false) {
    stamp();
    return { ok: true, slug, relPath, committed: true, sha, content };
  }
  // NEVER force — a non-fast-forward push fails and we surface git's stderr.
  return push({ ok: true, slug, relPath, committed: true, sha, content });
}

/**
 * The drain: publish every publishable post idempotently. "Publishable" = status
 * `ready` (promoted to publish) or `published` (re-emitted, so an edit lands). A
 * `draft` is never touched by the drain. Safe to run repeatedly — an unchanged post
 * skips both commit and push. A site repo that can't take a publish stops it
 * before the first post.
 *
 * @returns {{ok:boolean, considered:number, published:number, results:Array, reason?:string, message?:string}}
 */
export function publishReady(config, opts = {}) {
  const posts = listPosts(config).filter((p) => p.status === "ready" || p.status === "published");
  if (!opts.dryRun && posts.length) {
    const problem = siteProblem(config, { push: (opts.push !== undefined ? opts.push : config.push) !== false });
    if (problem) return { ok: false, considered: posts.length, published: 0, results: [], reason: problem[0], message: problem[1] };
  }
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
      reason: "some-failed",
      message: `${failed.length} of ${posts.length} post(s) didn't publish.`,
    };
  }
  return { ok: true, considered: posts.length, published, results };
}
