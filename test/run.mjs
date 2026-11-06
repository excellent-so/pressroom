// pressroom — self-test. Zero-dep, offline. Exercises the serializer +
// frontmatter parser (the round-trip contract a static site reads), slugging, the
// file-based posts workspace, the publish runner end-to-end against a THROWAWAY git
// repo the test creates (never a real repo), and the import round-trip.
//
// Run: node test/run.mjs   (or `npm test`)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serializePostToMdx } from "../src/serialize.mjs";
import { parseMdxFrontmatter, normalizeDate, sameMeaning } from "../src/frontmatter.mjs";
import { slugify, newPost, listPosts, readPost, writePost, uniqueSlug, parsePostFile, deriveExcerpt, isValidSlug } from "../src/posts.mjs";
import { publishPost, publishReady } from "../src/publish.mjs";
import { importPostsFromSite } from "../src/import.mjs";
import { loadConfig, gitUserName } from "../src/config.mjs";
import { serve } from "../src/serve.mjs";
import { today } from "../src/lib.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PKG_ROOT, "bin", "pressroom.mjs");

/* ── harness ─────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`, DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const section = (n) => console.log(`\n${DIM("▶")} ${n}`);
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ${G("✓")} ${name}`); }
  catch (e) { fail++; console.log(`  ${R("✗")} ${name}\n      ${R(e.message.split("\n")[0])}`); }
}

/* ── tmp + git helpers (git via execFileSync — NOT a real repo) ──────────── */
const tmps = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pressroom-${label}-`));
  tmps.push(d);
  return d;
}
function cleanup() { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } }

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** A throwaway site repo with content/posts/ + one initial commit. */
function initSiteRepo(dir, { remote } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main", "."], dir);
  git(["config", "user.email", "test@pressroom.local"], dir);
  git(["config", "user.name", "Pressroom Test"], dir);
  fs.mkdirSync(path.join(dir, "content", "posts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "content", "posts", ".gitkeep"), "");
  fs.writeFileSync(path.join(dir, "README.md"), "# site\n");
  git(["add", "content/posts/.gitkeep", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  if (remote) {
    git(["init", "--bare", "-q", "-b", "main", remote], path.dirname(remote));
    git(["remote", "add", "origin", remote], dir);
    git(["push", "-q", "-u", "origin", "main"], dir);
  }
  return dir;
}
/** The Astro blog template's first post, as `npm create astro -- --template blog` writes it. */
const ASTRO_POST = [
  "---", "title: 'Using MDX'", "description: 'Lorem ipsum dolor sit amet'", "pubDate: 'Jun 01 2024'",
  "heroImage: '../../assets/blog-placeholder-5.jpg'", "---", "",
  "import HeaderLink from '../../components/HeaderLink.astro';", "", "## Why MDX?", "", "Body text.", "",
].join("\n");
/** A site repo whose content folder is the Astro template's, with one committed post. */
function astroSite(root, files = { "using-mdx.mdx": ASTRO_POST }) {
  const site = initSiteRepo(path.join(root, "site"));
  const cdir = path.join(site, "src", "content", "blog");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, ".gitkeep"), "");
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cdir, name), text);
  git(["add", "src"], site);
  git(["commit", "-q", "-m", "the template's posts"], site);
  return { site, cdir };
}
function commitCount(dir) { return Number(git(["rev-list", "--count", "HEAD"], dir)); }
function headSha(dir) { return git(["rev-parse", "HEAD"], dir); }
function filesInHead(dir) {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], dir).split("\n").filter(Boolean);
}

/* ── viewer-server helpers (ephemeral port:0, one-shot requests) ──────────── */
/** Start the viewer server on an OS-assigned free port; returns { server, port }.
 *  Muffles serve()'s boot banner so the test log stays clean. */
async function startServer(config, opts) {
  const log = console.log;
  console.log = () => {};
  try {
    const server = serve(config, { port: 0, ...opts });
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    return { server, port: server.address().port };
  } finally { console.log = log; }
}
/** One-shot JSON request against 127.0.0.1:port. Resolves { status, body }. */
function req(port, method, pathname, { body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) headers["content-type"] = "application/json";
    if (origin) headers["origin"] = origin;
    const r = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { ok: false, raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Run the CLI; returns { status, stdout, stderr }. */
function cli(args, cwd, env = {}) {
  return spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** Build a resolved config via the real loader (exercises config.mjs too). */
async function cfg(root, overrides) {
  const { config } = await loadConfig({ cwd: root, overrides });
  return config;
}

/* ── 1. serializer + frontmatter ─────────────────────────────────────────── */
function parseFm(mdx) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(mdx);
  assert.ok(m, "output must have a frontmatter block delimited by ---");
  return { fm: m[1], body: m[2].trim() };
}
const base = {
  title: "Hello world",
  body: "# Hi\n\nThis is the body.\n",
  excerpt: "A short excerpt.",
  published_at: "2026-06-26 23:11:05",
  created_at: "2026-06-20 10:00:00",
};

section("serializer — frontmatter");
await t("emits title, description, date", () => {
  const { fm } = parseFm(serializePostToMdx(base));
  assert.match(fm, /^title: "Hello world"$/m);
  assert.match(fm, /^description: "A short excerpt\."$/m);
  assert.match(fm, /^date: "2026-06-26"$/m);
});
await t("no built-in byline: no author key without a post author or default", () => {
  const { fm } = parseFm(serializePostToMdx(base));
  assert.doesNotMatch(fm, /^author:/m);
  assert.doesNotMatch(parseFm(serializePostToMdx(base, { defaultAuthor: "  " })).fm, /^author:/m);
});
await t("description omitted when excerpt is empty", () => {
  assert.doesNotMatch(parseFm(serializePostToMdx({ ...base, excerpt: "" })).fm, /^description:/m);
});
await t("description omitted when excerpt is null", () => {
  assert.doesNotMatch(parseFm(serializePostToMdx({ ...base, excerpt: null })).fm, /^description:/m);
});
await t("date falls back to created_at when published_at is null", () => {
  assert.match(parseFm(serializePostToMdx({ ...base, published_at: null })).fm, /^date: "2026-06-20"$/m);
});
await t("author override is honored", () => {
  const { fm } = parseFm(serializePostToMdx(base, { frontmatter: { author: "Sam Rivera" } }));
  assert.match(fm, /^author: "Sam Rivera"$/m);
});
await t("configured defaultAuthor is the fallback byline", () => {
  const { fm } = parseFm(serializePostToMdx(base, { defaultAuthor: "Jane Roe" }));
  assert.match(fm, /^author: "Jane Roe"$/m);
});

section("serializer — tags");
await t("tags rendered as a YAML block list when provided", () => {
  const { fm } = parseFm(serializePostToMdx(base, { frontmatter: { tags: ["Local-first", "AI"] } }));
  assert.match(fm, /^tags:\n {2}- "Local-first"\n {2}- "AI"$/m);
});
await t("tags key omitted when none provided", () => {
  assert.doesNotMatch(parseFm(serializePostToMdx(base)).fm, /^tags:/m);
});
await t("blank/whitespace tags are dropped", () => {
  const { fm } = parseFm(serializePostToMdx(base, { frontmatter: { tags: ["", "  ", "Perf"] } }));
  assert.match(fm, /^tags:\n {2}- "Perf"$/m);
  assert.doesNotMatch(fm, /- ""/);
});

section("serializer — frontmatter preservation (re-publish)");
await t("preserves arbitrary site-managed keys (hero/heroAlt)", () => {
  const { fm } = parseFm(serializePostToMdx(base, { frontmatter: { hero: "gradient", heroAlt: "A picture", tags: ["X"] } }));
  assert.match(fm, /^hero: "gradient"$/m);
  assert.match(fm, /^heroAlt: "A picture"$/m);
  assert.match(fm, /^tags:\n {2}- "X"$/m);
});
await t("pressroom owns title/description/date — never inherited from frontmatter", () => {
  const { fm } = parseFm(serializePostToMdx(base, { frontmatter: { title: "STALE", description: "STALE", date: "1999-01-01" } }));
  assert.match(fm, /^title: "Hello world"$/m);
  assert.match(fm, /^description: "A short excerpt\."$/m);
  assert.match(fm, /^date: "2026-06-26"$/m);
  assert.doesNotMatch(fm, /STALE|1999/);
});

section("serializer — YAML safety + body");
await t("quotes/escapes special chars in title", () => {
  const { fm } = parseFm(serializePostToMdx({ ...base, title: `How's Linear so fast? A "deep" dive: notes` }));
  assert.match(fm, /^title: "How's Linear so fast\? A \\"deep\\" dive: notes"$/m);
});
await t("escapes backslashes", () => {
  assert.match(parseFm(serializePostToMdx({ ...base, title: "a\\b" })).fm, /^title: "a\\\\b"$/m);
});
await t("body is trimmed and placed after a blank line", () => {
  const mdx = serializePostToMdx(base);
  assert.match(mdx, /---\n\n# Hi/);
  assert.equal(parseFm(mdx).body, "# Hi\n\nThis is the body.");
});
await t("output ends with a single trailing newline", () => {
  const mdx = serializePostToMdx(base);
  assert.ok(mdx.endsWith("\n") && !mdx.endsWith("\n\n\n"));
});

section("frontmatter parser — reading the site's posts");
await t("parses quoted + unquoted scalars and a tags list", () => {
  const raw = [
    "---", "title: Hello from the field notes", 'description: "What this blog is for: notes, kept short."',
    'date: "2026-06-26"', "tags:", "  - Announcements", "  - Meta",
    "author: Priya Shah", "---", "", "Body starts here.", "",
  ].join("\n");
  const { data, content } = parseMdxFrontmatter(raw);
  assert.equal(data.title, "Hello from the field notes");
  assert.equal(data.description, "What this blog is for: notes, kept short.");
  assert.equal(data.date, "2026-06-26");
  assert.deepEqual(data.tags, ["Announcements", "Meta"]);
  assert.equal(data.author, "Priya Shah");
  assert.equal(content, "Body starts here.");
});
await t("returns the whole input as body when there's no frontmatter", () => {
  const { data, content } = parseMdxFrontmatter("# Just markdown\n");
  assert.deepEqual(data, {});
  assert.equal(content, "# Just markdown");
});

section("round-trip — serialize → parse is lossless");
await t("title/description/date/tags/author survive a round-trip", () => {
  const post = {
    title: `How's Linear so fast? A "deep" dive`,
    body: "## Heading\n\nText.",
    excerpt: "A breakdown: instant, optimistic, local.",
    published_at: "2026-05-03 09:00:00",
    created_at: "2026-05-01 09:00:00",
  };
  const mdx = serializePostToMdx(post, { frontmatter: { author: "Sam Rivera", tags: ["Performance", "Local-first"] } });
  const { data, content } = parseMdxFrontmatter(mdx);
  assert.equal(data.title, post.title);
  assert.equal(data.description, post.excerpt);
  assert.equal(data.date, "2026-05-03");
  assert.equal(data.author, "Sam Rivera");
  assert.deepEqual(data.tags, ["Performance", "Local-first"]);
  assert.equal(content, post.body);
});

/* ── 2. slugging ─────────────────────────────────────────────────────────── */
section("slugging");
await t("slugify lowercases, strips punctuation, collapses dashes", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Why Linear is *so* fast?  "), "why-linear-is-so-fast");
  assert.equal(slugify("Café — 2026 Review"), "cafe-2026-review"); // accents dropped, not the letter
  assert.equal(slugify("!!!"), "post"); // empty → the "post" fallback
  assert.equal(slugify("a".repeat(200)).length, 80); // clamped to 80
});
await t("uniqueSlug appends -2, -3 when the base is taken", async () => {
  const root = mkTmp("slug");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  assert.equal(uniqueSlug(config, "My Post"), "my-post");
  newPost(config, { title: "My Post" });
  assert.equal(uniqueSlug(config, "My Post"), "my-post-2");
  newPost(config, { title: "My Post" });
  assert.equal(uniqueSlug(config, "My Post"), "my-post-3");
});

/* ── 3. posts workspace: new + list ──────────────────────────────────────── */
section("posts workspace — new + list");
await t("new scaffolds a draft .mdx that parses back", async () => {
  const root = mkTmp("new");
  const config = await cfg(root, { postsDir: path.join(root, "posts"), defaultAuthor: "Ada Lovelace" });
  const post = newPost(config, { title: "The First Post" });
  assert.equal(post.slug, "the-first-post");
  assert.equal(post.status, "draft");
  const file = path.join(config.postsDir, "the-first-post.mdx");
  assert.ok(fs.existsSync(file), "file written");
  const reread = readPost(config, "the-first-post");
  assert.equal(reread.title, "The First Post");
  assert.equal(reread.status, "draft");
  assert.equal(reread.author, "Ada Lovelace");
});
await t("list returns every post, newest-created first", async () => {
  const root = mkTmp("list");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  newPost(config, { title: "Alpha" });
  newPost(config, { title: "Beta" });
  newPost(config, { title: "Alpha" }); // dup → alpha-2
  const posts = listPosts(config);
  assert.equal(posts.length, 3);
  const slugs = posts.map((p) => p.slug).sort();
  assert.deepEqual(slugs, ["alpha", "alpha-2", "beta"]);
});
await t("writePost is idempotent (no rewrite when unchanged)", async () => {
  const root = mkTmp("idem");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  const post = newPost(config, { title: "Stable" });
  const again = writePost(config, readPost(config, post.slug));
  assert.equal(again.changed, false, "re-writing identical content is a no-op");
});
await t("CLI router boots: --help, new, list (subprocess smoke)", async () => {
  const root = mkTmp("cli");
  const env = { ...process.env, PRESSROOM_POSTS_DIR: path.join(root, "posts") };
  const help = execFileSync("node", [BIN, "--help"], { encoding: "utf8", cwd: root });
  assert.match(help, /the local pressroom for your blog/);
  execFileSync("node", [BIN, "new", "Ship It"], { encoding: "utf8", cwd: root, env });
  assert.ok(fs.existsSync(path.join(root, "posts", "ship-it.mdx")), "new created the file");
  const list = execFileSync("node", [BIN, "list"], { encoding: "utf8", cwd: root, env });
  assert.match(list, /ship-it/);
  assert.match(list, /Ship It/);
});

/* ── 4. publish end-to-end (throwaway git repo) ──────────────────────────── */
section("publish — end-to-end into a throwaway git repo");
await t("dry-run returns the MDX and touches nothing", async () => {
  const root = mkTmp("pubdry");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site });
  newPost(config, { title: "Dry One", status: "ready" });
  const before = commitCount(site);
  const r = publishPost(config, "dry-one", { dryRun: true });
  assert.ok(r.ok && r.dryRun);
  assert.match(r.content, /^title: "Dry One"$/m);
  assert.equal(fs.existsSync(path.join(site, "content", "posts", "dry-one.mdx")), false, "no file written");
  assert.equal(commitCount(site), before, "no commit made");
  assert.equal(readPost(config, "dry-one").status, "ready", "dry-run does not stamp the local post");
});
await t("publish writes the file and makes exactly ONE-file commit", async () => {
  const root = mkTmp("pubone");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "One File", status: "ready" });
  const before = commitCount(site);
  const r = publishPost(config, "one-file");
  assert.ok(r.ok && r.committed, "committed");
  assert.equal(commitCount(site), before + 1, "exactly one new commit");
  assert.deepEqual(filesInHead(site), ["content/posts/one-file.mdx"], "commit touches ONLY that file");
  assert.ok(fs.existsSync(path.join(site, "content", "posts", "one-file.mdx")));
  assert.equal(readPost(config, "one-file").status, "published", "local post stamped published");
});
await t("re-publish is a no-op (idempotent — no new commit)", async () => {
  const root = mkTmp("pubidem");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "Idem Post", status: "ready" });
  publishPost(config, "idem-post");
  const after1 = commitCount(site);
  const r2 = publishPost(config, "idem-post");
  assert.ok(r2.ok && r2.unchanged && !r2.committed, "second publish is a no-op");
  assert.equal(commitCount(site), after1, "no new commit on re-publish");
});
await t("scoped: a dirty working tree is NOT swept into the commit", async () => {
  const root = mkTmp("pubscope");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  // Dirty the tree: modify a tracked file + add an untracked one.
  fs.writeFileSync(path.join(site, "README.md"), "# site (edited, uncommitted)\n");
  fs.writeFileSync(path.join(site, "STRAY.txt"), "do not commit me\n");
  newPost(config, { title: "Scoped Ship", status: "ready" });
  publishPost(config, "scoped-ship");
  assert.deepEqual(filesInHead(site), ["content/posts/scoped-ship.mdx"], "only the post file was committed");
  const porcelain = git(["status", "--porcelain"], site);
  assert.match(porcelain, /README\.md/, "the dirty README is still uncommitted");
  assert.match(porcelain, /STRAY\.txt/, "the untracked stray file is still uncommitted");
});
await t("--no-push commits locally WITHOUT pushing", async () => {
  const root = mkTmp("pubnopush");
  const remote = path.join(root, "origin.git");
  const site = initSiteRepo(path.join(root, "site"), { remote });
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site });
  newPost(config, { title: "Local Only", status: "ready" });
  const originBefore = headSha(remote);
  const r = publishPost(config, "local-only", { push: false });
  assert.ok(r.ok && r.committed && !r.pushed, "committed but not pushed");
  assert.notEqual(headSha(site), originBefore, "site advanced");
  assert.equal(headSha(remote), originBefore, "origin did NOT move");
});
await t("publish with push updates origin (fast-forward)", async () => {
  const root = mkTmp("pubpush");
  const remote = path.join(root, "origin.git");
  const site = initSiteRepo(path.join(root, "site"), { remote });
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: true });
  newPost(config, { title: "Pushed Post", status: "ready" });
  const r = publishPost(config, "pushed-post");
  assert.ok(r.ok && r.pushed, "pushed");
  assert.equal(headSha(remote), headSha(site), "origin/main == site HEAD");
});
await t("non-fast-forward push fails politely (git stderr; never force)", async () => {
  const root = mkTmp("pubconflict");
  const remote = path.join(root, "origin.git");
  const site = initSiteRepo(path.join(root, "site"), { remote });
  // A second clone races ahead of origin so our push can't fast-forward.
  const other = path.join(root, "other");
  git(["clone", "-q", remote, other], root);
  git(["config", "user.email", "b@b.test"], other);
  git(["config", "user.name", "Bee"], other);
  fs.writeFileSync(path.join(other, "content", "posts", "theirs.mdx"), "---\ntitle: \"Theirs\"\n---\n\nhi\n");
  git(["add", "content/posts/theirs.mdx"], other);
  git(["commit", "-q", "-m", "theirs"], other);
  git(["push", "-q", "origin", "main"], other);
  const originAhead = headSha(remote);
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: true });
  newPost(config, { title: "Mine", status: "ready" });
  const r = publishPost(config, "mine");
  assert.equal(r.ok, false, "publish reports failure");
  assert.ok(/\S/.test(r.reason), "carries git's stderr as the reason");
  assert.match(r.reason, /reject|fast-forward|fetch first|non-fast/i);
  assert.equal(headSha(remote), originAhead, "origin was NOT force-moved");
  const after = readPost(config, "mine");
  assert.equal(after.status, "ready", "a failed publish leaves the post unpublished");
  assert.equal(after.date, "", "and undated");
});
await t("a publish whose push failed is pushed by the next publish, with no second commit", async () => {
  const root = mkTmp("pubretry");
  const remote = path.join(root, "origin.git");
  const site = initSiteRepo(path.join(root, "site"), { remote });
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: true });
  newPost(config, { title: "Stranded", status: "ready" });
  const originBefore = headSha(remote);
  // The remote goes away mid-publish: the commit lands locally, the push fails.
  fs.renameSync(remote, remote + ".away");
  const r1 = publishPost(config, "stranded");
  assert.equal(r1.ok, false, "the first publish reports the failed push");
  fs.renameSync(remote + ".away", remote);
  assert.equal(headSha(remote), originBefore, "origin never got it");
  const commits = commitCount(site);
  const r2 = publishPost(config, "stranded");
  assert.ok(r2.ok && r2.pushed && r2.retried && !r2.committed, "the second publish pushes the earlier commit");
  assert.equal(commitCount(site), commits, "and makes no new commit");
  assert.equal(headSha(remote), headSha(site), "origin now has it");
  assert.equal(readPost(config, "stranded").status, "published", "and the post is stamped published");
  const r3 = publishPost(config, "stranded");
  assert.ok(r3.ok && r3.unchanged && !r3.pushed, "a third publish has nothing to do");
});
await t("a post's own tags reach the site when the site's copy has none; the site's tags win", async () => {
  const root = mkTmp("pubtags");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  const post = newPost(config, { title: "Tagged", status: "ready" });
  writePost(config, { ...readPost(config, post.slug), tags: ["Writing", "Tools"] });
  publishPost(config, post.slug);
  const target = path.join(site, "content", "posts", "tagged.mdx");
  assert.deepEqual(parseMdxFrontmatter(fs.readFileSync(target, "utf8")).data.tags, ["Writing", "Tools"]);
  // The site's copy now has tags of its own: a local change to tags leaves them be.
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('  - "Tools"', '  - "Site Tag"'));
  writePost(config, { ...readPost(config, post.slug), tags: ["Other"] });
  publishPost(config, post.slug);
  assert.deepEqual(parseMdxFrontmatter(fs.readFileSync(target, "utf8")).data.tags, ["Writing", "Site Tag"]);
});
await t("publish --all drains every ready post idempotently", async () => {
  const root = mkTmp("puball");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "Ready A", status: "ready" });
  newPost(config, { title: "Ready B", status: "ready" });
  newPost(config, { title: "Just A Draft", status: "draft" });
  const first = publishReady(config, { push: false });
  assert.ok(first.ok);
  assert.equal(first.published, 2, "the two ready posts published; the draft is skipped");
  const second = publishReady(config, { push: false });
  assert.equal(second.published, 0, "a second drain commits nothing (all unchanged)");
});
await t("site-repo failures fail closed (no throw)", async () => {
  const root = mkTmp("pubfail");
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: path.join(root, "not-a-repo") });
  newPost(config, { title: "Nowhere", status: "ready" });
  const r = publishPost(config, "nowhere");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "site-repo-not-found");
});

/* ── 5. import round-trip ────────────────────────────────────────────────── */
section("import — site .mdx → local posts (round-trip)");
await t("import pulls site posts into the workspace, idempotently", async () => {
  const root = mkTmp("import");
  const site = initSiteRepo(path.join(root, "site"));
  const cdir = path.join(site, "content", "posts");
  fs.writeFileSync(path.join(cdir, "welcome.mdx"), [
    "---", 'title: "Welcome aboard"', 'description: "The first article."',
    'date: "2026-01-15"', "tags:", "  - News", 'author: "Sam Rivera"', "---", "", "## Hello", "", "Body text.", "",
  ].join("\n"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site });
  const r1 = importPostsFromSite(config);
  assert.ok(r1.ok);
  assert.equal(r1.imported, 1);
  assert.deepEqual(r1.slugs, ["welcome"]);
  const p = readPost(config, "welcome");
  assert.equal(p.title, "Welcome aboard");
  assert.equal(p.excerpt, "The first article.");
  assert.equal(p.date, "2026-01-15");
  assert.equal(p.status, "published");
  assert.deepEqual(p.tags, ["News"]);
  assert.equal(p.author, "Sam Rivera");
  assert.equal(p.body, "## Hello\n\nBody text.");
  // Re-import is idempotent: nothing new, nothing changed on disk.
  const r2 = importPostsFromSite(config);
  assert.equal(r2.imported, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.unchanged, 1);
});
await t("import --from=<dir> reads an explicit source dir", async () => {
  const root = mkTmp("importfrom");
  const src = path.join(root, "elsewhere");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "note.mdx"), "---\ntitle: \"A Note\"\n---\n\nJust a note.\n");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  const r = importPostsFromSite(config, { from: src });
  assert.ok(r.ok && r.imported === 1);
  assert.equal(readPost(config, "note").title, "A Note");
});
await t("full round-trip: import → publish preserves the post's data + then stabilizes", async () => {
  const root = mkTmp("roundtrip");
  const site = initSiteRepo(path.join(root, "site"));
  const cdir = path.join(site, "content", "posts");
  // Already-normalized (quoted) input → the first publish is a byte-for-byte no-op.
  const normalized = [
    "---", 'title: "Round Trip"', 'description: "Same in, same out."',
    'date: "2026-03-03"', "tags:", '  - "Meta"', 'author: "Priya Shah"', "---", "", "Content stays stable.", "",
  ].join("\n");
  fs.writeFileSync(path.join(cdir, "round-trip.mdx"), normalized);
  git(["add", "content/posts/round-trip.mdx"], site);
  git(["commit", "-q", "-m", "the site's post"], site);
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  importPostsFromSite(config);
  const r = publishPost(config, "round-trip");
  assert.ok(r.ok && r.unchanged, "re-publishing a normalized imported post is a no-op");
  assert.equal(fs.readFileSync(path.join(cdir, "round-trip.mdx"), "utf8"), normalized, "site file byte-for-byte unchanged");

  // And the data survives regardless of the source's quoting: an UNQUOTED source
  // re-serializes (normalizing quotes) but preserves every field, then stabilizes.
  fs.writeFileSync(path.join(cdir, "loose.mdx"), [
    "---", "title: Loose Quotes", "description: Unquoted in the source",
    "date: 2026-04-04", "tags:", "  - Meta", "author: Sam Rivera", "---", "", "Stays stable after the first pass.", "",
  ].join("\n"));
  git(["add", "content/posts/loose.mdx"], site);
  git(["commit", "-q", "-m", "another site post"], site);
  importPostsFromSite(config);
  const commits = commitCount(site);
  const first = publishPost(config, "loose");
  assert.ok(first.ok && first.unchanged, "the same data in other quoting is already published");
  assert.equal(commitCount(site), commits, "so no commit");
  const emitted = parseMdxFrontmatter(fs.readFileSync(path.join(cdir, "loose.mdx"), "utf8"));
  assert.equal(emitted.data.title, "Loose Quotes");
  assert.equal(emitted.data.description, "Unquoted in the source");
  assert.equal(emitted.data.date, "2026-04-04");
  assert.deepEqual(emitted.data.tags, ["Meta"]);
  assert.equal(emitted.data.author, "Sam Rivera");
  assert.equal(emitted.content, "Stays stable after the first pass.");
  const second = publishPost(config, "loose");
  assert.ok(second.ok && second.unchanged, "the normalized file is byte-stable on the next publish");
});

/* ── 6. config loader ────────────────────────────────────────────────────── */
section("config loader");
await t("loadConfig reads a pressroom.config.mjs and normalizes paths", async () => {
  const root = mkTmp("cfg");
  fs.writeFileSync(path.join(root, "pressroom.config.mjs"), [
    "export default {",
    "  postsDir: 'drafts',",
    "  siteRepo: './my-site',",
    "  contentDir: 'content/blog',",
    "  branch: 'trunk',",
    "  defaultAuthor: 'Grace Hopper',",
    "  push: false,",
    "};",
  ].join("\n"));
  const { config, file } = await loadConfig({ cwd: root });
  assert.ok(file && file.endsWith("pressroom.config.mjs"));
  assert.equal(config.postsDir, path.join(root, "drafts"), "postsDir absolutized against the config root");
  assert.equal(config.siteRepo, path.join(root, "my-site"));
  assert.equal(config.contentDir, "content/blog");
  assert.equal(config.branch, "trunk");
  assert.equal(config.defaultAuthor, "Grace Hopper");
  assert.equal(config.authorFrom, "config");
  assert.equal(config.push, false);
});

/** Run `fn` with git's global and system config hidden, so only a repo's own
 *  `user.name` (or none) is visible. Restores the environment afterwards. */
async function withoutGlobalGitConfig(fn) {
  const empty = path.join(mkTmp("gitcfg"), "gitconfig");
  fs.writeFileSync(empty, "");
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try { return await fn(); }
  finally {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
  }
}

section("default author — config, then git config user.name, then none");
await t("with no defaultAuthor set, the byline is git config user.name", async () => {
  await withoutGlobalGitConfig(async () => {
    const root = mkTmp("authgit");
    git(["init", "-q", "."], root);
    git(["config", "user.name", "Grace Hopper"], root);
    assert.equal(gitUserName(root), "Grace Hopper");
    const config = await cfg(root, { postsDir: path.join(root, "posts") });
    assert.equal(config.defaultAuthor, "Grace Hopper");
    assert.equal(config.authorFrom, "git");
    assert.equal(newPost(config, { title: "From Git" }).author, "Grace Hopper", "new posts take the git name");
  });
});
await t("a configured defaultAuthor wins over git config user.name", async () => {
  await withoutGlobalGitConfig(async () => {
    const root = mkTmp("authcfg");
    git(["init", "-q", "."], root);
    git(["config", "user.name", "Grace Hopper"], root);
    fs.writeFileSync(path.join(root, "pressroom.config.mjs"), "export default { defaultAuthor: 'Ada Lovelace' };\n");
    const { config } = await loadConfig({ cwd: root });
    assert.equal(config.defaultAuthor, "Ada Lovelace");
    assert.equal(config.authorFrom, "config");
    assert.deepEqual(config.authors, [], "no built-in byline list");
  });
});
await t("no config and no git name: no default author, and the published MDX has no author key", async () => {
  await withoutGlobalGitConfig(async () => {
    const root = mkTmp("authnone");
    const site = initSiteRepo(path.join(root, "site")); // has its own committer name, "Pressroom Test"
    const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
    assert.equal(config.defaultAuthor, "");
    assert.equal(config.authorFrom, null);
    const post = newPost(config, { title: "Nobody Wrote This", status: "ready" });
    assert.equal(post.author, "");
    const r = publishPost(config, post.slug, { dryRun: true });
    assert.doesNotMatch(r.content, /^author:/m, "no author key in the site frontmatter");
    assert.doesNotMatch(r.content, /Excellent|Matt Waite|Pressroom Test/, "no company, personal or committer name");
  });
});
await t("init scaffolds a config with no personal or company byline", async () => {
  const root = mkTmp("init");
  execFileSync("node", [BIN, "init"], { encoding: "utf8", cwd: root });
  const src = fs.readFileSync(path.join(root, "pressroom.config.mjs"), "utf8");
  assert.doesNotMatch(src, /Excellent Team|Matt Waite/);
  assert.match(src, /^\s*\/\/ defaultAuthor:/m, "defaultAuthor is left commented out");
  assert.match(src, /git config user\.name/);
});
await t("doctor says when the byline comes from git config user.name", async () => {
  await withoutGlobalGitConfig(async () => {
    const root = mkTmp("doctor");
    git(["init", "-q", "."], root);
    git(["config", "user.name", "Grace Hopper"], root);
    // No site repo is set, so doctor reports that and exits 1; the byline line is still there.
    const r = spawnSync("node", [BIN, "doctor"], { encoding: "utf8", cwd: root, env: { ...process.env } });
    assert.match(r.stdout, /author:\s+Grace Hopper\s+\(from git config user\.name\)/);
    assert.equal(r.status, 1, "doctor exits 1 while publishing can't work");
    assert.match(r.stdout, /No site repo is set/);
  });
});

/* ── 7. viewer server — connect a site from the browser (POST /api/config) ── */
section("viewer server — connect + go live (POST /api/config)");
await t("GET /api/config carries a connection block (unconfigured out of the box)", async () => {
  const root = mkTmp("srvget");
  const config = await cfg(root, { postsDir: path.join(root, "posts") }); // no siteRepo
  const { server, port } = await startServer(config, { root, configFile: path.join(root, "pressroom.config.mjs") });
  try {
    const g = await req(port, "GET", "/api/config");
    assert.ok(g.body.ok);
    assert.ok(g.body.connection && typeof g.body.connection === "object", "connection block present");
    assert.equal(g.body.connection.configured, false);
    assert.equal(g.body.connection.isGitRepo, false);
    assert.equal(g.body.connection.contentPostsDir, null, "no siteRepo → no content dir");
    assert.equal(g.body.config.siteRepo, null);
  } finally { server.close(); }
});
await t("POST /api/config connects a throwaway git repo, persists the config, goes live", async () => {
  const root = mkTmp("srvconnect");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts") }); // starts unconnected
  const configFile = path.join(root, "pressroom.config.mjs");
  const { server, port } = await startServer(config, { root, configFile });
  try {
    // A fresh user: create a draft, mark it ready — all before any site is connected.
    const created = await req(port, "POST", "/api/posts", { body: { title: "Live One" } });
    assert.ok(created.body.ok);
    const slug = created.body.post.slug;
    await req(port, "POST", "/api/posts/" + slug, { body: { status: "ready" } });

    // Publishing is refused while unconnected (no siteRepo).
    assert.equal((await req(port, "GET", "/api/config")).body.connection.configured, false);

    // Connect the site (push:false — the throwaway repo has no remote).
    const conn = await req(port, "POST", "/api/config", { body: { siteRepo: site, push: false } });
    assert.ok(conn.body.ok, "connect succeeds");
    assert.equal(conn.body.connection.configured, true);
    assert.equal(conn.body.connection.isGitRepo, true);
    assert.equal(conn.body.connection.contentDirExists, true);
    assert.equal(conn.body.config.siteRepo, site);

    // It persisted a real, reloadable config file (not a hand-edit).
    assert.ok(fs.existsSync(configFile), "pressroom.config.mjs written");
    const { config: reloaded } = await loadConfig({ cwd: root });
    assert.equal(reloaded.siteRepo, site, "reloaded config points at the connected repo");
    assert.equal(reloaded.push, false);

    // The live config updated in place: publishing now actually commits into the site.
    const before = commitCount(site);
    const pub = await req(port, "POST", "/api/publish/" + slug, { body: {} });
    assert.ok(pub.body.ok && pub.body.result.ok && pub.body.result.committed, "committed into the site");
    assert.equal(commitCount(site), before + 1, "exactly one new commit");
    assert.deepEqual(filesInHead(site), ["content/posts/" + slug + ".mdx"], "scoped one-file commit");
  } finally { server.close(); }
});
await t("connecting from the viewer keeps the config's fields and extension", async () => {
  const root = mkTmp("srvfields");
  const site = initSiteRepo(path.join(root, "site"));
  const configFile = path.join(root, "pressroom.config.mjs");
  fs.writeFileSync(configFile, 'export default { fields: { date: "pubDate" }, extension: ".md" };\n');
  const { config } = await loadConfig({ cwd: root });
  const { server, port } = await startServer(config, { root, configFile });
  try {
    assert.ok((await req(port, "POST", "/api/config", { body: { siteRepo: site, push: false } })).body.ok);
    // A fresh import (this process cached the file it loaded above).
    const written = (await import(`${pathToFileURL(configFile).href}?after-connect`)).default;
    assert.equal(written.siteRepo, site);
    assert.deepEqual(written.fields, { date: "pubDate" });
    assert.equal(written.extension, ".md");
  } finally { server.close(); }
});
await t("connecting an Astro-shaped site picks up its pubDate key", async () => {
  const root = mkTmp("srvastro");
  const { site } = astroSite(root);
  const configFile = path.join(root, "pressroom.config.mjs");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  const { server, port } = await startServer(config, { root, configFile });
  try {
    const check = await req(port, "POST", "/api/config", { body: { siteRepo: site, contentDir: "src/content/blog", check: true } });
    assert.equal(check.body.connection.dateField, "pubDate", "the check shows it");
    assert.ok((await req(port, "POST", "/api/config", { body: { siteRepo: site, contentDir: "src/content/blog", push: false } })).body.ok);
    assert.match(fs.readFileSync(configFile, "utf8"), /^\s*fields: \{"date":"pubDate"\},$/m, "and the config file keeps it");
    newPost(config, { title: "Via The Viewer", status: "ready" });
    const pub = await req(port, "POST", "/api/publish/via-the-viewer", { body: {} });
    assert.ok(pub.body.result.ok, pub.body.result.message);
    assert.match(pub.body.result.content, /^pubDate: "\d{4}-\d{2}-\d{2}"$/m);
  } finally { server.close(); }
});
await t("POST /api/config at a non-git dir fails 400 and does NOT enable publishing", async () => {
  const root = mkTmp("srvnogit");
  const notGit = path.join(root, "not-a-repo");
  fs.mkdirSync(notGit, { recursive: true });
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  const configFile = path.join(root, "pressroom.config.mjs");
  const { server, port } = await startServer(config, { root, configFile });
  try {
    const r = await req(port, "POST", "/api/config", { body: { siteRepo: notGit } });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.connection.siteRepoExists, true, "the dir exists…");
    assert.equal(r.body.connection.isGitRepo, false, "…but it isn't a git repo");
    // Nothing persisted, nothing went live.
    assert.equal(fs.existsSync(configFile), false, "no config written on failure");
    const g = await req(port, "GET", "/api/config");
    assert.equal(g.body.connection.configured, false);
    assert.equal(g.body.config.siteRepo, null);
  } finally { server.close(); }
});
await t("cross-origin POST /api/config is rejected (403)", async () => {
  const root = mkTmp("srvcors");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  const { server, port } = await startServer(config, { root, configFile: path.join(root, "pressroom.config.mjs") });
  try {
    const r = await req(port, "POST", "/api/config", { body: { siteRepo: site }, origin: "https://evil.example.com" });
    assert.equal(r.status, 403);
    assert.equal(r.body.ok, false);
    // The rejected request did not connect the site.
    assert.equal((await req(port, "GET", "/api/config")).body.connection.configured, false);
  } finally { server.close(); }
});
await t("connecting keeps a git-derived byline out of the written config; a picked one is kept", async () => {
  await withoutGlobalGitConfig(async () => {
    const root = mkTmp("srvauthor");
    git(["init", "-q", "."], root);
    git(["config", "user.name", "Grace Hopper"], root);
    const site = initSiteRepo(path.join(root, "site"));
    const config = await cfg(root, { postsDir: path.join(root, "posts") });
    const configFile = path.join(root, "pressroom.config.mjs");
    const { server, port } = await startServer(config, { root, configFile });
    try {
      const g = await req(port, "GET", "/api/config");
      assert.equal(g.body.config.defaultAuthor, "Grace Hopper");
      assert.equal(g.body.config.authorFrom, "git");
      // Connect with the default byline left as it is: nothing about it is written.
      await req(port, "POST", "/api/config", { body: { siteRepo: site, push: false, defaultAuthor: "Grace Hopper" } });
      let src = fs.readFileSync(configFile, "utf8");
      assert.match(src, /^\s*\/\/ defaultAuthor:/m, "git name not frozen into the file");
      // Pick a different byline: now it is the configured one.
      await req(port, "POST", "/api/config", { body: { siteRepo: site, push: false, defaultAuthor: "Ada Lovelace" } });
      src = fs.readFileSync(configFile, "utf8");
      assert.match(src, /^\s*defaultAuthor: "Ada Lovelace",$/m);
      const { config: reloaded } = await loadConfig({ cwd: root });
      assert.equal(reloaded.defaultAuthor, "Ada Lovelace");
      assert.equal(reloaded.authorFrom, "config");
    } finally { server.close(); }
  });
});

/* ── 8. the viewer: the kit's rules, and the markdown preview ───────────── */
section("viewer — the kit's rules, and pressroom's own mark");
const VIEWER = fs.readFileSync(path.join(PKG_ROOT, "viewer", "index.html"), "utf8");
/** The favicon is drawn for the browser's tab bar, so it follows the browser's theme; the page doesn't. */
const ICON_LINK = (VIEWER.match(/<link rel="icon"[^>]*>/) || [""])[0];
const PAGE = VIEWER.replace(ICON_LINK, "");
const KIT_END = "/* excellent-kit:end */";
/** The viewer's own CSS: everything in its <style> after the synced kit block. */
const OWN_CSS = VIEWER.slice(VIEWER.indexOf(KIT_END) + KIT_END.length, VIEWER.indexOf("</style>"));
const cssRules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

await t("the kit block is synced in, between its markers", () => {
  const a = VIEWER.indexOf("/* excellent-kit:begin */"), b = VIEWER.indexOf(KIT_END);
  assert.ok(a > 0 && b > a, "markers present, in order");
  const block = VIEWER.slice(a, b);
  assert.match(block, /@excellent-so\/kit \d+\.\d+\.\d+, MIT/);
  assert.match(block, /--color-strong:/);
  assert.match(block, /\.ex-btn \{/);
});
await t("light by default, dark only by choice: no prefers-color-scheme, a remembered toggle", () => {
  assert.doesNotMatch(PAGE, /prefers-color-scheme/);
  assert.match(VIEWER, /localStorage\.getItem\('ex-theme'\)==='dark'/, "the head snippet restores a dark choice");
  assert.match(VIEWER, /data-ex-theme-toggle/);
  assert.match(VIEWER, /localStorage\.setItem\("ex-theme"/, "the toggle remembers the choice");
});
await t("the header is pressroom's own mark and name, with no publisher byline", () => {
  const brand = VIEWER.match(/<span class="pr-brand">([\s\S]*?)<\/span>/);
  assert.ok(brand, "the brand row is there");
  assert.match(brand[1], /<svg class="ex-mark" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">/, "the mark, in the kit's 16px slot");
  assert.match(brand[1], /<rect x="1" y="2" width="14" height="4"\/>/, "the masthead bar");
  assert.match(brand[1], /pressroom\s*$/, "the name, and nothing after it");
  assert.doesNotMatch(VIEWER, /pr-brand__by|by Excellent|excellent\.so/i, "no byline and no link to the publisher");
});
await t("the favicon is the same mark, as an SVG data URI", () => {
  assert.match(ICON_LINK, /href="data:image\/svg\+xml,/);
  assert.match(ICON_LINK, /%3Crect%20x='1'%20y='2'%20width='14'%20height='4'\/%3E/, "the masthead bar");
});
await t("the viewer's own CSS is on the kit's tokens: no colour literals, no old token names", () => {
  const literals = OWN_CSS.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(literals, [], "no hex colours");
  assert.doesNotMatch(OWN_CSS, /var\(--(surface-\d|text-(strong|default|subtle)|primary\b|info|success|warning|danger|violet)/, "no pre-kit token names");
  assert.doesNotMatch(VIEWER, /4F46E5|6366F1|10B981|8B5CF6|indigo|emerald|violet/i, "no indigo, emerald or violet");
});
await t("amber never appears in the viewer's CSS; red only on a failure", () => {
  assert.doesNotMatch(OWN_CSS, /--color-verified/);
  for (const { sel, body } of cssRules(OWN_CSS)) {
    if (/--color-returned/.test(body)) assert.match(sel, /is-no|is-err/, `red in ${sel}`);
  }
});
await t("no text under 12px in the viewer's CSS", () => {
  for (const m of OWN_CSS.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)) {
    const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
    assert.ok(px >= 12, `font-size ${m[1]}${m[2]}`);
  }
});
await t("statuses are ink outlines with a glyph or a word, never colour alone", () => {
  assert.match(VIEWER, /draft: \{ cls: "ex-badge--warning"/, "draft: an open square");
  assert.match(VIEWER, /ready: \{ cls: "ex-badge--info"/, "ready: an ink outline");
  assert.match(VIEWER, /published: \{ cls: "ex-badge--success"/, "published: a check");
  assert.match(VIEWER, /ex-alert--danger/, "a failed publish is the red alert");
});
await t("the server serves the viewer with the kit inside", async () => {
  const root = mkTmp("srvhtml");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  const { server, port } = await startServer(config, { root });
  try {
    const r = await req(port, "GET", "/");
    assert.equal(r.status, 200);
    assert.match(r.body.raw, /excellent-kit:begin/);
    assert.match(r.body.raw, /Markdown preview/);
  } finally { server.close(); }
});

section("viewer — the markdown preview");
const MD_BEGIN = "/* markdown-preview:begin */", MD_END = "/* markdown-preview:end */";
const renderMarkdown = new Function(`${VIEWER.slice(VIEWER.indexOf(MD_BEGIN), VIEWER.indexOf(MD_END))}; return renderMarkdown;`)();
await t("renders headings, lists, code and inline marks", () => {
  const html = renderMarkdown("# Title\n\nSome **bold**, *em* and `code`.\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<pre><code>const a = 1;<\/code><\/pre>/);
});
await t("a blockquote gets the same space above it as every other block", () => {
  // .pr-prose blockquote resets the browser's margin; the sibling rule after it puts the gap back.
  const reset = VIEWER.indexOf(".pr-prose blockquote { margin: 0;");
  const gap = VIEWER.indexOf(".pr-prose > * + blockquote { margin-top: 1em; }");
  assert.ok(reset > 0 && gap > reset, "the gap rule exists and comes after the reset");
});
await t("escapes HTML and neutralizes javascript: links", () => {
  const html = renderMarkdown('Hi <script>alert(1)</script> and [x](javascript:alert(1)).');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="#"/);
});
await t("MDX (imports, JSX, HTML tags) is shown as labelled code, never run", () => {
  const html = renderMarkdown('import Chart from "./Chart.astro";\n\nText.\n\n<Chart data={[1, 2]} />\n\n<div class="x">raw</div>\n');
  assert.equal((html.match(/MDX, shown as code/g) || []).length, 3);
  assert.match(html, /import Chart from &quot;\.\/Chart\.astro&quot;;/);
  assert.match(html, /&lt;Chart data=\{\[1, 2\]\} \/&gt;/);
  assert.doesNotMatch(html, /<Chart|<div class="x">/);
  assert.match(html, /<p>Text\.<\/p>/);
});
await t("an image on the site is named, not requested; a full URL loads", () => {
  const html = renderMarkdown("![Hero](../../assets/hero.jpg)\n\n![Logo](https://example.com/logo.png)");
  assert.doesNotMatch(html, /<img[^>]*assets\/hero\.jpg/, "no request the viewer's server would 404");
  assert.match(html, /Image on your site<\/span> <code>\.\.\/\.\.\/assets\/hero\.jpg<\/code> Hero/);
  assert.match(html, /<img alt="Logo" src="https:\/\/example\.com\/logo\.png">/);
});
await t("an autolink at the start of a line is not mistaken for JSX", () => {
  assert.doesNotMatch(renderMarkdown("<https://example.com> is the site."), /MDX, shown as code/);
});


/* ── 7. real sites: the Astro blog template's shape, .md posts, refusals ─── */
section("site shapes — fields, .md posts, extra keys");
await t("fields renames the keys publish writes (date → pubDate for Astro)", async () => {
  const root = mkTmp("fields");
  const { site, cdir } = astroSite(root, {});
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, contentDir: "src/content/blog", push: false, fields: { date: "pubDate" } });
  newPost(config, { title: "Hello Astro", status: "ready", body: "First words of the post.\n" });
  const r = publishPost(config, "hello-astro");
  assert.ok(r.ok && r.committed, r.message);
  const { data } = parseMdxFrontmatter(fs.readFileSync(path.join(cdir, "hello-astro.mdx"), "utf8"));
  assert.match(data.pubDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(data.date, undefined, "no date key the site doesn't read");
  assert.equal(data.description, "First words of the post.", "an empty excerpt publishes the start of the body");
  // A post the site already has with no description doesn't get one invented.
  fs.writeFileSync(path.join(cdir, "bare.mdx"), '---\ntitle: "Bare"\npubDate: "2024-01-02"\n---\n\nNo description here.\n');
  git(["add", "src"], site); git(["commit", "-q", "-m", "bare"], site);
  importPostsFromSite(config);
  assert.ok(publishPost(config, "bare").unchanged, "no description added, so no commit");
});
await t("fields is checked: an unknown key or a bad name is a ConfigError", async () => {
  const root = mkTmp("fieldsbad");
  await assert.rejects(cfg(root, { fields: { published: "pubDate" } }), /fields\.published .* isn't one pressroom writes/);
  await assert.rejects(cfg(root, { fields: { date: "pub date" } }), /must be a frontmatter key name/);
  await assert.rejects(cfg(root, { fields: { date: "title" } }), /same name/);
  await assert.rejects(cfg(root, { extension: ".txt" }), /must be "\.mdx" or "\.md"/);
});
await t("import → publish of an unchanged Astro template post makes no commit", async () => {
  const root = mkTmp("astroidem");
  const { site, cdir } = astroSite(root);
  const config = await cfg(root, {
    postsDir: path.join(root, "posts"), siteRepo: site, contentDir: "src/content/blog",
    push: false, fields: { date: "pubDate" }, defaultAuthor: "Ada Lovelace",
  });
  importPostsFromSite(config);
  const local = readPost(config, "using-mdx");
  assert.equal(local.date, "2024-06-01", "the site's 'Jun 01 2024' is read as its day");
  assert.equal(local.excerpt, "Lorem ipsum dolor sit amet");
  assert.equal(local.extra.heroImage, "../../assets/blog-placeholder-5.jpg", "heroImage rides along");
  const before = commitCount(site);
  const r = publishPost(config, "using-mdx");
  assert.ok(r.ok && r.unchanged, r.message || "unchanged");
  assert.equal(commitCount(site), before, "no commit");
  assert.equal(fs.readFileSync(path.join(cdir, "using-mdx.mdx"), "utf8"), ASTRO_POST, "the site's file is untouched");
  // An edit does publish, and keeps the site's date text, heroImage and no invented byline.
  writePost(config, { ...readPost(config, "using-mdx"), body: local.body + "\n\nA new line." });
  const r2 = publishPost(config, "using-mdx");
  assert.ok(r2.ok && r2.committed, r2.message);
  const { data, content } = parseMdxFrontmatter(fs.readFileSync(path.join(cdir, "using-mdx.mdx"), "utf8"));
  assert.equal(data.pubDate, "Jun 01 2024");
  assert.equal(data.heroImage, "../../assets/blog-placeholder-5.jpg");
  assert.equal(data.author, undefined, "the default byline isn't added to a post the site already has");
  assert.match(content, /A new line\.$/);
});
await t("import reads .md posts, and publish writes back to the site's .md file", async () => {
  const root = mkTmp("mdposts");
  const md = ASTRO_POST.replace("title: 'Using MDX'", "title: 'First post'");
  const { site, cdir } = astroSite(root, { "first-post.md": md, "notes.txt": "not a post" });
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, contentDir: "src/content/blog", push: false, fields: { date: "pubDate" } });
  const r = importPostsFromSite(config);
  assert.deepEqual(r.slugs, ["first-post"]);
  writePost(config, { ...readPost(config, "first-post"), title: "First post, edited" });
  const p = publishPost(config, "first-post");
  assert.ok(p.ok && p.committed, p.message);
  assert.equal(p.relPath, "src/content/blog/first-post.md");
  assert.deepEqual(filesInHead(site), ["src/content/blog/first-post.md"]);
  assert.equal(fs.existsSync(path.join(cdir, "first-post.mdx")), false, "no second copy as .mdx");
});
await t("a post with frontmatter that isn't YAML is left out of import and never overwritten", async () => {
  const root = mkTmp("jsfm");
  const jsPost = '---js\nconst title = "A fifth post";\nconst draft = true;\n---\nThis is a draft post\n';
  const { site, cdir } = astroSite(root, { "fifthpost.md": jsPost, "toml.md": '+++\ntitle = "T"\n+++\nBody\n' });
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, contentDir: "src/content/blog", push: false });
  const r = importPostsFromSite(config);
  assert.deepEqual(r.slugs, []);
  assert.deepEqual(r.skipped, ["fifthpost.md", "toml.md"]);
  // A local post that happens to share the slug still can't replace it.
  newPost(config, { title: "fifthpost", status: "ready" });
  const p = publishPost(config, "fifthpost");
  assert.equal(p.reason, "site-copy-unreadable");
  assert.equal(fs.readFileSync(path.join(cdir, "fifthpost.md"), "utf8"), jsPost);
});
await t("a post with values over several lines is left out of import, and a change to it is refused", async () => {
  const root = mkTmp("nested");
  const nextPost = '---\ntitle: "Dynamic Routing"\ndate: "2020-03-16T05:35:07.322Z"\nauthor:\n  name: Tim Neutkens\n  picture: "/assets/blog/authors/tim.jpeg"\n---\n\nBody.\n';
  const { site, cdir } = astroSite(root, { "dynamic-routing.md": nextPost });
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, contentDir: "src/content/blog", push: false });
  assert.deepEqual(importPostsFromSite(config).skipped, ["dynamic-routing.md"]);
  assert.deepEqual(parseMdxFrontmatter(nextPost).nested, ["author"]);
  writePost(config, { ...parsePostFile(nextPost, "dynamic-routing"), status: "published", date: "2020-03-16", body: "Body." });
  const same = publishPost(config, "dynamic-routing");
  assert.ok(same.ok && same.unchanged, "unchanged is fine: nothing is written");
  writePost(config, { ...readPost(config, "dynamic-routing"), body: "Changed." });
  assert.equal(publishPost(config, "dynamic-routing").reason, "site-copy-unreadable");
  assert.equal(fs.readFileSync(path.join(cdir, "dynamic-routing.md"), "utf8"), nextPost);
});
await t('extension: ".md" names a post new to the site', async () => {
  const root = mkTmp("mdext");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false, extension: "md" });
  newPost(config, { title: "Plain Markdown", status: "ready" });
  const r = publishPost(config, "plain-markdown");
  assert.equal(r.relPath, "content/posts/plain-markdown.md");
});
await t("a post's extra keys stay in its file and reach the site", async () => {
  const root = mkTmp("extra");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "With Hero", status: "ready" });
  const file = path.join(config.postsDir, "with-hero.mdx");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("status: ready", 'status: ready\nheroImage: "../../assets/hero.jpg"'));
  const r = publishPost(config, "with-hero");
  assert.ok(r.ok && r.committed, r.message);
  assert.match(fs.readFileSync(file, "utf8"), /^heroImage: "\.\.\/\.\.\/assets\/hero\.jpg"$/m, "kept when publish stamps the post");
  assert.match(fs.readFileSync(path.join(site, "content", "posts", "with-hero.mdx"), "utf8"), /^heroImage: "\.\.\/\.\.\/assets\/hero\.jpg"$/m);
});
await t("doctor notices a site that keeps its dates under another key", async () => {
  const root = mkTmp("doctordate");
  const { site, cdir } = astroSite(root);
  const r = cli(["doctor", `--site-repo=${site}`, "--content-dir=src/content/blog"], root);
  assert.match(r.stdout, /keep their date in pubDate, but publish writes date\. Add fields: \{ date: "pubDate" \}/);
  fs.writeFileSync(path.join(root, "pressroom.config.mjs"), 'export default { fields: { date: "pubDate" } };\n');
  assert.doesNotMatch(cli(["doctor", `--site-repo=${site}`, "--content-dir=src/content/blog"], root).stdout, /keep their date in/);
  assert.ok(fs.existsSync(cdir));
});
await t("dates, excerpts and the meaning of a file", () => {
  assert.equal(normalizeDate("Jul 08 2022"), "2022-07-08");
  assert.equal(normalizeDate("2026-03-03T23:30:00-08:00"), "2026-03-03");
  assert.equal(normalizeDate("someday"), "someday");
  assert.equal(deriveExcerpt("import X from './x';\n\n# Title\n\n```js\nx\n```\n\nThe **first** [real](http://x) words."), "The first real words.");
  assert.equal(deriveExcerpt("word ".repeat(80)).length <= 161, true);
  const a = parseMdxFrontmatter("---\ntitle: 'A'\ntags:\n  - x\n---\n\nBody\n");
  const b = parseMdxFrontmatter('---\ntags:\n  - "x"\ntitle: "A"\nempty: ""\n---\nBody');
  assert.ok(sameMeaning(a, b), "quoting, order and blank keys don't count");
  assert.ok(!sameMeaning(a, parseMdxFrontmatter("---\ntitle: 'B'\n---\nBody")));
});

section("publish — refusals that leave the site as it was");
await t("no remote named origin: refused before the commit, nothing written", async () => {
  const root = mkTmp("noremote");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: true });
  newPost(config, { title: "Nowhere To Go", status: "ready" });
  const before = commitCount(site);
  const r = publishPost(config, "nowhere-to-go");
  assert.equal(r.reason, "no-remote");
  assert.match(r.message, /no remote named origin/);
  assert.equal(commitCount(site), before);
  assert.equal(fs.existsSync(path.join(site, "content", "posts", "nowhere-to-go.mdx")), false);
  assert.equal(readPost(config, "nowhere-to-go").status, "ready", "not stamped published");
  assert.ok(publishPost(config, "nowhere-to-go", { push: false }).committed, "--no-push still works");
});
await t("the site checked out on another branch: refused", async () => {
  const root = mkTmp("branch");
  const site = initSiteRepo(path.join(root, "site"), { remote: path.join(root, "origin.git") });
  git(["checkout", "-q", "-b", "feature"], site);
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site });
  newPost(config, { title: "Wrong Branch", status: "ready" });
  const r = publishPost(config, "wrong-branch");
  assert.equal(r.reason, "wrong-branch");
  assert.match(r.message, /on branch feature, but publish pushes main/);
  assert.equal(fs.existsSync(path.join(site, "content", "posts", "wrong-branch.mdx")), false);
});
await t("a hand edit to the site's copy that isn't committed is never overwritten", async () => {
  const root = mkTmp("handedit");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "Hand Edited", status: "ready" });
  publishPost(config, "hand-edited");
  const target = path.join(site, "content", "posts", "hand-edited.mdx");
  fs.appendFileSync(target, "\nA hand edit, not committed.\n");
  writePost(config, { ...readPost(config, "hand-edited"), body: "New words." });
  const r = publishPost(config, "hand-edited");
  assert.equal(r.reason, "site-copy-changed");
  assert.match(fs.readFileSync(target, "utf8"), /A hand edit, not committed\./, "the hand edit is still there");
});
await t("a file an earlier publish wrote but didn't commit is committed next time", async () => {
  const root = mkTmp("staged");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "Half Done", status: "ready" });
  const { content, relPath } = publishPost(config, "half-done", { dryRun: true });
  fs.writeFileSync(path.join(site, relPath), content); // what publish writes before a commit fails
  git(["add", relPath], site);
  const r = publishPost(config, "half-done");
  assert.ok(r.ok && r.committed, "committed, not reported up to date");
  assert.deepEqual(filesInHead(site), [relPath]);
});
await t("git with no name or email: refused, so git can't invent one from the machine", async () => {
  await withoutGlobalGitConfig(async () => {
    const saved = { n: process.env.GIT_AUTHOR_NAME, e: process.env.GIT_AUTHOR_EMAIL, m: process.env.EMAIL };
    delete process.env.GIT_AUTHOR_NAME; delete process.env.GIT_AUTHOR_EMAIL; delete process.env.EMAIL;
    try {
      const root = mkTmp("noident");
      const site = initSiteRepo(path.join(root, "site"));
      git(["config", "--unset", "user.name"], site);
      git(["config", "--unset", "user.email"], site);
      const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
      newPost(config, { title: "Anonymous", status: "ready" });
      const r = publishPost(config, "anonymous");
      assert.equal(r.reason, "no-git-identity");
      assert.match(r.message, /git config --global user\.name/);
      assert.equal(fs.existsSync(path.join(site, "content", "posts", "anonymous.mdx")), false, "nothing written");
    } finally {
      for (const [k, v] of [["GIT_AUTHOR_NAME", saved.n], ["GIT_AUTHOR_EMAIL", saved.e], ["EMAIL", saved.m]]) if (v !== undefined) process.env[k] = v;
    }
  });
});
await t("no git on PATH: one sentence, nothing written", async () => {
  const root = mkTmp("nogit");
  const site = initSiteRepo(path.join(root, "site"));
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site, push: false });
  newPost(config, { title: "No Git", status: "ready" });
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(root, "empty-bin");
  let r;
  try { r = publishPost(config, "no-git"); } finally { process.env.PATH = savedPath; }
  assert.equal(r.reason, "git-missing");
  assert.match(r.message, /git isn't installed/);
  assert.equal(fs.existsSync(path.join(site, "content", "posts", "no-git.mdx")), false);
});
await t("a rejected push says to pull; the drain stops early on a site problem", async () => {
  const root = mkTmp("rejected");
  const remote = path.join(root, "origin.git");
  const site = initSiteRepo(path.join(root, "site"), { remote });
  const other = path.join(root, "other");
  git(["clone", "-q", remote, other], root);
  git(["-c", "user.name=Bee", "-c", "user.email=b@b.test", "commit", "-q", "--allow-empty", "-m", "theirs"], other);
  git(["push", "-q", "origin", "main"], other);
  const config = await cfg(root, { postsDir: path.join(root, "posts"), siteRepo: site });
  newPost(config, { title: "Behind", status: "ready" });
  const r = publishPost(config, "behind");
  assert.equal(r.reason, "push-rejected");
  assert.match(r.message, /git pull/);
  assert.match(r.detail, /rejected/, "git's own words ride along");
  git(["checkout", "-q", "--detach"], site);
  const drain = publishReady(config);
  assert.equal(drain.reason, "wrong-branch");
  assert.equal(drain.results.length, 0, "one sentence, not one per post");
});
await t("a slug can't reach outside the posts folder", async () => {
  const root = mkTmp("slugpath");
  const config = await cfg(root, { postsDir: path.join(root, "posts") });
  assert.equal(isValidSlug("../etc/passwd"), false);
  assert.equal(isValidSlug("My Post!"), true);
  assert.equal(readPost(config, "../x"), null);
  assert.equal(publishPost(config, "../x").reason, "post-not-found");
});
await t("today is the local calendar day, not the UTC one", () => {
  const evening = new Date(2026, 10, 5, 23, 30); // 11:30pm on Nov 5, local time
  assert.equal(today(evening), "2026-11-05");
});
await t("frontmatter values stay on one line", () => {
  const { fm } = parseFm(serializePostToMdx({ ...base, title: "Two\nlines" }));
  assert.match(fm, /^title: "Two lines"$/m);
});

section("CLI — wrong input");
await t("an unknown command or flag exits 1 with one sentence", async () => {
  const root = mkTmp("cliwrong");
  const unknown = cli(["publsh"], root);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^pressroom: publsh isn't a pressroom command/);
  const typo = cli(["publish", "x", "--dryrun"], root);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /doesn't take --dryrun/);
  const port = cli(["serve", "--port=abc"], root);
  assert.equal(port.status, 1);
  assert.match(port.stderr, /whole number from 1 to 65535/);
  assert.doesNotMatch(unknown.stderr + typo.stderr + port.stderr, /\n\s+at /, "no stack trace");
});
await t("--version prints the package version", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
  assert.equal(cli(["--version"], mkTmp("ver")).stdout.trim(), pkg.version);
});
await t("a broken config file is one sentence, not a stack trace", async () => {
  const root = mkTmp("badcfg");
  fs.writeFileSync(path.join(root, "pressroom.config.mjs"), "export default { postsDir: ");
  const r = cli(["list"], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^pressroom: Couldn't load .*pressroom\.config\.mjs: .*Fix the file/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});
await t("a failed publish exits 1 and says what to do", async () => {
  const root = mkTmp("clifail");
  const r = cli(["publish", "missing-post"], root, { PRESSROOM_POSTS_DIR: path.join(root, "posts") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /There's no post missing-post in .*pressroom list/);
});
await t("the viewer prints its address once when it skips busy ports", async () => {
  const root = mkTmp("busy");
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busy = blocker.address().port;
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let server;
  try {
    server = serve(await cfg(root, { postsDir: path.join(root, "posts") }), { port: busy });
    await new Promise((r) => server.once("listening", r));
    await new Promise((r) => setTimeout(r, 50));
  } finally { console.log = log; }
  assert.equal(lines.filter((l) => l.includes("pressroom → ")).length, 1);
  assert.notEqual(server.address().port, busy);
  server.close(); blocker.close();
});

/* ── done ────────────────────────────────────────────────────────────────── */
cleanup();
console.log(`\n${fail === 0 ? G(`${pass} passed, 0 failed`) : R(`${pass} passed, ${fail} failed`)}\n`);
process.exit(fail === 0 ? 0 : 1);
