// pressroom — the viewer server. Serves the self-contained viewer and a tiny JSON
// API over the local posts workspace + the publish runner. Serving over http (not
// file://) avoids browser CSP/fetch quirks and lets the viewer save edits and drive
// a publish. Binds 127.0.0.1 only — this is a local authoring surface, never a
// public server.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPosts, readPost, writePost, newPost, STATUSES } from "./posts.mjs";
import { publishPost } from "./publish.mjs";
import { contentPostsDir } from "./config.mjs";
import { siteDateKey } from "./import.mjs";
import { SITE_FIELDS } from "./serialize.mjs";
import { nowStamp, openBrowser, isGitRepo } from "./lib.mjs";

const VIEWER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "viewer");
const MIME = {
  ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png",
};

function readBody(req, res, limit, cb) {
  let body = "";
  req.on("error", () => { try { res.writeHead(400); res.end(); } catch { /* ignore */ } });
  req.on("data", (c) => { body += c; if (body.length > limit) req.destroy(); });
  req.on("end", () => cb(body));
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

/**
 * CSRF/origin guard for mutating routes: these write to the local posts workspace
 * and can drive a git commit/push. Accept same-origin / no-Origin (curl, the viewer
 * itself); reject a cross-origin browser POST so a random page can't drive writes
 * while the viewer is running.
 */
function crossOriginBlocked(req) {
  const origin = req.headers.origin;
  return Boolean(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** A post's public-facing metadata (list rows don't ship the whole body). */
function postMeta(p) {
  return {
    slug: p.slug, title: p.title, excerpt: p.excerpt, author: p.author,
    status: p.status, date: p.date, tags: p.tags, created: p.created, updated: p.updated,
  };
}

/** Expand a leading `~` to the user's home dir (best-effort; leaves the rest alone). */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The publish-connection health the viewer reads — WHY publishing is (or isn't) live.
 * Lets the Connect UI say "dir missing" vs "not a git repo" vs "content dir missing".
 */
function connectionState(cfg) {
  const cdir = contentPostsDir(cfg);
  return {
    configured: Boolean(cfg.siteRepo),
    siteRepoExists: Boolean(cfg.siteRepo && fs.existsSync(cfg.siteRepo)),
    isGitRepo: Boolean(cfg.siteRepo && isGitRepo(cfg.siteRepo)),
    contentDirExists: Boolean(cdir && fs.existsSync(cdir)),
    contentPostsDir: cdir,
    dateField: (cfg.fields || SITE_FIELDS).date,
  };
}

/** The public config shape the viewer needs (never the whole resolved object). */
function publicConfig(cfg) {
  return {
    postsDir: cfg.postsDir,
    siteRepo: cfg.siteRepo,
    contentDir: cfg.contentDir,
    branch: cfg.branch,
    defaultAuthor: cfg.defaultAuthor,
    authorFrom: cfg.authorFrom || null,
    authors: cfg.authors,
    push: cfg.push,
    fields: cfg.fields,
    extension: cfg.extension,
    statuses: STATUSES,
  };
}

/**
 * Emit a clean, commented `pressroom.config.mjs` source (same voice as the CLI's
 * `scaffoldConfig()`), carrying the connected values plus the preserved keys. JSON
 * quoting keeps every value safe to paste back in — the module round-trips through
 * `loadConfig`.
 */
function configModuleSource(cfg) {
  const q = (v) => JSON.stringify(v);
  // A byline borrowed from `git config user.name` stays borrowed: writing it into the
  // file would freeze it. Only a byline the config (or the person connecting) chose is kept.
  const pinnedAuthor = Boolean(cfg.defaultAuthor) && cfg.authorFrom !== "git";
  return `// pressroom.config.mjs — written by pressroom when you connected your site.
// siteRepo, postsDir, contentDir and branch also take a PRESSROOM_* env var or a CLI flag.
export default {
  // Your local draft workspace: one <slug>.mdx per post.
  postsDir: ${q(cfg.postsDir)},

  // Absolute path to your static site's git checkout — publishing writes into it.
  // (env: PRESSROOM_SITE_REPO · flag: --site-repo)
  siteRepo: ${q(cfg.siteRepo)},

  // Where posts land inside the site repo (the site's MDX content directory).
  contentDir: ${q(cfg.contentDir)},

  // The branch your site deploys from — what publish commits + pushes to.
  branch: ${q(cfg.branch)},

  // Default byline for new posts and the fallback publish author. Left unset,
  // pressroom uses your \`git config user.name\`; with neither, posts carry no author.
  ${pinnedAuthor ? `defaultAuthor: ${q(cfg.defaultAuthor)},` : `// defaultAuthor: "Your Name",`}

  // More bylines the viewer offers in its Author menu.
  authors: ${q(Array.isArray(cfg.authors) ? cfg.authors : [])},

  // Push after committing? Override per run with --no-push.
  push: ${cfg.push ? "true" : "false"},
${siteShapeSource(cfg)}};
`;
}

/** The `fields` and `extension` lines, only when they differ from the defaults. */
function siteShapeSource(cfg) {
  const renamed = Object.fromEntries(Object.entries(cfg.fields || {}).filter(([k, v]) => SITE_FIELDS[k] !== v));
  let out = "";
  if (Object.keys(renamed).length) {
    out += `\n  // The frontmatter key names your site reads, where they differ from pressroom's.\n  fields: ${JSON.stringify(renamed)},\n`;
  }
  if (cfg.extension && cfg.extension !== ".mdx") {
    out += `\n  // The extension of a post new to the site.\n  extension: ${JSON.stringify(cfg.extension)},\n`;
  }
  return out;
}

export function serve(config, { port = 4640, open = false, root = process.cwd(), configFile } = {}) {
  // The config is MUTABLE for the session's life: connecting a site (POST /api/config)
  // updates it in place so publishing goes live without a restart or a hand-edit.
  let curConfig = config;
  const cfgFile = configFile || path.join(root, "pressroom.config.mjs");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    // ── API ────────────────────────────────────────────────────────────────
    // GET /api/config — the resolved config + live connection health the viewer needs.
    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, {
        ok: true,
        config: publicConfig(curConfig),
        connection: connectionState(curConfig),
      });
    }

    // POST /api/config — connect a site repo: validate → persist → go live in place.
    // Fails closed with a `connection` block so the UI can show WHY (dir missing vs
    // not a git repo). `check:true` validates only — never writes, never mutates.
    if (req.method === "POST" && url.pathname === "/api/config") {
      if (crossOriginBlocked(req)) return json(res, 403, { ok: false, error: "cross-origin blocked" });
      return readBody(req, res, 1e6, (body) => {
        try {
          const patch = JSON.parse(body || "{}");
          const raw = patch.siteRepo == null ? "" : String(patch.siteRepo).trim();
          if (!raw) {
            return json(res, 400, {
              ok: false, error: "A site repo path is required.",
              connection: connectionState({ ...curConfig, siteRepo: null }),
            });
          }

          // Resolve to an absolute path: expand a leading ~, relative against `root`.
          let abs = expandHome(raw);
          abs = path.isAbsolute(abs) ? abs : path.resolve(root, abs);

          // Normalize the rest exactly as loadConfig would (so the live config and a
          // reloaded one are identical).
          const contentDir = String(patch.contentDir || curConfig.contentDir || "content/posts").replace(/^[/\\]+|[/\\]+$/g, "");
          const branch = String(patch.branch || curConfig.branch || "main");
          const picked = typeof patch.defaultAuthor === "string" ? patch.defaultAuthor.trim() : "";
          const defaultAuthor = picked || curConfig.defaultAuthor;
          // Picking a different byline makes it a configured one; keeping the current
          // one keeps where it came from (config, or git config user.name).
          const authorFrom = picked && picked !== curConfig.defaultAuthor ? "config" : curConfig.authorFrom;
          const push = patch.push === undefined ? curConfig.push : patch.push !== false;
          // A site whose posts keep their date under another key (the Astro blog
          // template's pubDate) gets that key, unless the config already names one.
          let fields = curConfig.fields || { ...SITE_FIELDS };
          const dateKey = fields.date === SITE_FIELDS.date ? siteDateKey(contentPostsDir({ siteRepo: abs, contentDir })) : null;
          if (dateKey && !Object.values(fields).includes(dateKey)) fields = { ...fields, date: dateKey };
          const candidate = { ...curConfig, siteRepo: abs, contentDir, branch, defaultAuthor, authorFrom, push, fields };

          if (!fs.existsSync(abs)) {
            return json(res, 400, { ok: false, error: `No such directory: ${abs}`, connection: connectionState(candidate) });
          }
          if (!isGitRepo(abs)) {
            return json(res, 400, { ok: false, error: `Not a git repo (no .git): ${abs}`, connection: connectionState(candidate) });
          }

          // Validate-only: report the health without touching disk or the live config.
          if (patch.check) {
            return json(res, 200, { ok: true, check: true, config: publicConfig(candidate), connection: connectionState(candidate) });
          }

          // Persist a clean config module, then go live. Only ever writes `cfgFile`.
          try {
            fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
            fs.writeFileSync(cfgFile, configModuleSource(candidate), "utf8");
          } catch (e) {
            return json(res, 500, {
              ok: false, error: `Could not write ${path.basename(cfgFile)}: ${e.message}`,
              connection: connectionState(curConfig),
            });
          }

          curConfig = candidate;
          json(res, 200, { ok: true, config: publicConfig(curConfig), connection: connectionState(curConfig) });
        } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
      });
    }

    // GET /api/posts — the list.
    if (req.method === "GET" && url.pathname === "/api/posts") {
      return json(res, 200, { ok: true, posts: listPosts(curConfig).map(postMeta) });
    }

    // GET /api/posts/<slug> — one full post (with body).
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "posts" && parts[2]) {
      const post = readPost(curConfig, decodeURIComponent(parts[2]));
      if (!post) return json(res, 404, { ok: false, error: "post-not-found" });
      return json(res, 200, { ok: true, post });
    }

    // POST /api/posts — create a new draft from { title }.
    if (req.method === "POST" && url.pathname === "/api/posts") {
      if (crossOriginBlocked(req)) return json(res, 403, { ok: false, error: "cross-origin blocked" });
      return readBody(req, res, 2e6, (body) => {
        try {
          const { title } = JSON.parse(body || "{}");
          if (!title || !String(title).trim()) return json(res, 400, { ok: false, error: "title required" });
          const post = newPost(curConfig, { title: String(title) });
          json(res, 200, { ok: true, post });
        } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
      });
    }

    // POST /api/posts/<slug> — save edits.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "posts" && parts[2]) {
      if (crossOriginBlocked(req)) return json(res, 403, { ok: false, error: "cross-origin blocked" });
      const slug = decodeURIComponent(parts[2]);
      return readBody(req, res, 4e6, (body) => {
        try {
          const existing = readPost(curConfig, slug);
          if (!existing) return json(res, 404, { ok: false, error: "post-not-found" });
          const patch = JSON.parse(body || "{}");
          const next = {
            ...existing,
            title: patch.title !== undefined ? String(patch.title) : existing.title,
            excerpt: patch.excerpt !== undefined ? String(patch.excerpt) : existing.excerpt,
            author: patch.author !== undefined ? String(patch.author) : existing.author,
            status: STATUSES.includes(patch.status) ? patch.status : existing.status,
            date: patch.date !== undefined ? String(patch.date) : existing.date,
            tags: Array.isArray(patch.tags) ? patch.tags : existing.tags,
            body: patch.body !== undefined ? String(patch.body) : existing.body,
            updated: nowStamp(),
          };
          const { changed } = writePost(curConfig, next);
          json(res, 200, { ok: true, changed, post: readPost(curConfig, slug) });
        } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
      });
    }

    // POST /api/publish/<slug> — run the publish path; surface the git result.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "publish" && parts[2]) {
      if (crossOriginBlocked(req)) return json(res, 403, { ok: false, error: "cross-origin blocked" });
      const slug = decodeURIComponent(parts[2]);
      return readBody(req, res, 1e6, (body) => {
        try {
          const opts = JSON.parse(body || "{}");
          const result = publishPost(curConfig, slug, {
            dryRun: Boolean(opts.dryRun),
            push: opts.push === undefined ? undefined : Boolean(opts.push),
          });
          json(res, 200, { ok: true, result });
        } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
      });
    }

    // ── Static viewer ────────────────────────────────────────────────────────
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end("bad request"); }
    if (rel === "/") rel = "/index.html";
    const file = path.join(VIEWER_DIR, path.normalize(rel));
    if (!(file === VIEWER_DIR || file.startsWith(VIEWER_DIR + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });

  let active = port;
  // One listener for the one successful bind: a busy port retries the next one,
  // and the banner (and the browser) must not repeat for every retry.
  server.once("listening", () => {
    active = server.address().port;
    console.log(`\n  pressroom → http://127.0.0.1:${active}\n  (drafts in ${curConfig.postsDir} · Ctrl-C to stop)\n`);
    if (open) openBrowser(`http://127.0.0.1:${active}`);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && port !== 0 && active < port + 25 && active < 65535) { active++; server.listen(active, "127.0.0.1"); return; }
    console.error(e.code === "EADDRINUSE"
      ? `\npressroom: ports ${port} to ${active} are all in use. Stop what's using them, or pick another with --port=N.\n`
      : e.code === "EACCES"
        ? `\npressroom: you don't have permission to use port ${active}. Pick one above 1024 with --port=N.\n`
        : `\npressroom: the viewer couldn't start: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(active, "127.0.0.1");
  return server;
}
