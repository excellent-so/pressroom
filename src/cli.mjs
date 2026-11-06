// pressroom — CLI. The entry point behind `pressroom` and `npx @excellent-so/pressroom`.
// The local pressroom for your blog: draft MDX, preview it, publish each post as a
// scoped git commit into your static site's repo with one command.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, contentPostsDir } from "./config.mjs";
import { newPost, listPosts, STATUSES } from "./posts.mjs";
import { publishPost, publishReady } from "./publish.mjs";
import { importPostsFromSite } from "./import.mjs";
import { isGitRepo } from "./lib.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── flag + arg parsing ──────────────────────────────────────────────────── */

function parseFlags(argv) {
  const f = {}; const positionals = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) f[m[1]] = m[2] === undefined ? true : m[2];
    else positionals.push(a);
  }
  return { f, positionals };
}

function resolvePort(v, dflt = 4640) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : dflt;
}

/** Build config overrides from common CLI flags. */
function overridesFromFlags(f) {
  const o = {};
  if (f["site-repo"]) o.siteRepo = String(f["site-repo"]);
  if (f["posts-dir"]) o.postsDir = String(f["posts-dir"]);
  if (f["content-dir"]) o.contentDir = String(f["content-dir"]);
  if (f.branch) o.branch = String(f.branch);
  if (f.author) o.defaultAuthor = String(f.author);
  return o;
}

async function setup(f) {
  return loadConfig({ overrides: overridesFromFlags(f) });
}

/* ── small terminal helpers (never leak ANSI on a pipe) ──────────────────── */

const TTY = process.stdout.isTTY;
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const STATUS_COLOR = { draft: "2", ready: "33", published: "32" };
const statusTag = (s) => paint(STATUS_COLOR[s] || "0", s);

/* ── the router ──────────────────────────────────────────────────────────── */

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { f, positionals } = parseFlags(rest);

  switch (cmd) {
    case "new": {
      const { config } = await setup(f);
      const title = positionals.join(" ").trim();
      if (!title) { console.error("Usage: pressroom new <title>"); process.exit(1); }
      const post = newPost(config, { title });
      const rel = path.relative(process.cwd(), path.join(config.postsDir, `${post.slug}.mdx`));
      console.log(`\n  ${paint("32", "✓")} new draft ${bold(post.slug)}`);
      console.log(`  ${dim(rel)}\n`);
      console.log(`  Edit it, then preview:  ${bold("pressroom open")}`);
      console.log(`  Mark it ready + ship:   ${bold(`pressroom publish ${post.slug}`)}\n`);
      break;
    }

    case "list": {
      const { config } = await setup(f);
      const posts = listPosts(config);
      if (!posts.length) {
        console.log(`\n  No posts yet in ${dim(config.postsDir)}.\n  Start one: ${bold('pressroom new "My first post"')}\n`);
        break;
      }
      const w = Math.min(60, Math.max(...posts.map((p) => p.title.length), 5));
      // Pad the plain status to a fixed column, then colorize just the word so
      // ANSI codes never throw the column widths off.
      const statusCell = (s) => statusTag(s) + " ".repeat(Math.max(0, 11 - s.length));
      console.log("");
      console.log(`  ${"STATUS".padEnd(11)}${"DATE".padEnd(12)}${"TITLE".padEnd(w + 2)}SLUG`);
      for (const p of posts) {
        console.log(
          `  ${statusCell(p.status)}` +
          `${String(p.date || "—").padEnd(12)}` +
          `${p.title.slice(0, w).padEnd(w + 2)}${dim(p.slug)}`,
        );
      }
      const counts = STATUSES.map((s) => `${posts.filter((p) => p.status === s).length} ${s}`).join(" · ");
      console.log(`\n  ${dim(counts)}\n`);
      break;
    }

    case "publish": {
      const { config } = await setup(f);
      const dryRun = Boolean(f["dry-run"]);
      const push = f["no-push"] ? false : undefined; // undefined ⇒ config.push
      if (f.all) {
        const r = publishReady(config, { dryRun, push });
        reportDrain(r, { dryRun });
        if (!r.ok) process.exit(1);
        break;
      }
      const slug = positionals[0];
      if (!slug) { console.error("Usage: pressroom publish <slug> | --all   [--dry-run] [--no-push]"); process.exit(1); }
      const r = publishPost(config, slug, { dryRun, push });
      reportPublish(r, { dryRun });
      if (!r.ok) process.exit(1);
      break;
    }

    case "import": {
      const { config } = await setup(f);
      const from = f.from ? String(f.from) : undefined;
      const r = importPostsFromSite(config, { from });
      if (!r.ok) {
        console.error(`\n  ✗ import failed: ${r.reason}`);
        console.error(`  ${dim(`source: ${from || contentPostsDir(config) || "(no siteRepo configured)"}`)}\n`);
        process.exit(1);
      }
      console.log(`\n  ${paint("32", "✓")} imported ${r.slugs.length} post(s) → ${dim(config.postsDir)}`);
      console.log(`  ${dim(`${r.imported} new · ${r.updated} updated · ${r.unchanged} unchanged`)}\n`);
      break;
    }

    case "serve":
    case "open": {
      const { config, root, file } = await setup(f);
      const { serve } = await import("./serve.mjs");
      const port = f.port ? resolvePort(f.port) : (process.env.PORT ? resolvePort(process.env.PORT) : 4640);
      // Pass the config root + file so an in-app Connect can persist without a hand-edit.
      serve(config, { port, open: cmd === "open", root, configFile: file });
      break;
    }

    case "doctor": {
      const { config, file } = await setup(f);
      const posts = listPosts(config);
      const cdir = contentPostsDir(config);
      const siteOk = config.siteRepo && isGitRepo(config.siteRepo);
      const cdirOk = cdir && fs.existsSync(cdir);
      const mark = (ok) => (ok ? paint("32", "✓") : paint("31", "✗"));
      console.log("\npressroom — doctor\n");
      console.log(`  config:      ${file || dim("(none — using defaults; run `pressroom init`)")}`);
      console.log(`  postsDir:    ${config.postsDir}  ${fs.existsSync(config.postsDir) ? paint("32", "✓") : dim("(will be created on first `new`)")}`);
      console.log(`  siteRepo:    ${config.siteRepo || dim("(not set — publishing is disabled)")}  ${config.siteRepo ? mark(siteOk) + (siteOk ? "" : " not a git repo") : ""}`);
      console.log(`  contentDir:  ${config.contentDir}  →  ${cdir ? cdir : dim("(needs siteRepo)")}  ${cdir ? mark(cdirOk) + (cdirOk ? "" : " missing") : ""}`);
      console.log(`  branch:      ${config.branch}`);
      const authorNote = config.authorFrom === "git" ? dim("  (from git config user.name)") : "";
      console.log(`  author:      ${config.defaultAuthor ? config.defaultAuthor + authorNote : dim("(none: set defaultAuthor or git config user.name)")}`);
      console.log(`  push:        ${config.push ? "yes" : "no (--no-push forced by config)"}`);
      console.log("");
      for (const s of STATUSES) console.log(`  ${s.padEnd(11)}${posts.filter((p) => p.status === s).length}`);
      const pending = posts.filter((p) => p.status === "ready").length;
      console.log(`\n  ${pending ? bold(`${pending} post(s) ready to publish`) + ` — run ${bold("pressroom publish --all")}` : dim("nothing queued to publish")}\n`);
      break;
    }

    case "init": {
      const target = path.join(process.cwd(), "pressroom.config.mjs");
      if (fs.existsSync(target) && !f.force) {
        console.error(`${target} already exists (pass --force to overwrite).`);
        process.exit(1);
      }
      fs.writeFileSync(target, scaffoldConfig());
      console.log(`\n  ${paint("32", "✓")} wrote ${path.relative(process.cwd(), target)}`);
      console.log(`  ${dim("Set `siteRepo` to your static site's git checkout, then:")}  ${bold('pressroom new "Hello, world"')}\n`);
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default:
      printHelp();
  }
}

/* ── result reporting ────────────────────────────────────────────────────── */

function reportPublish(r, { dryRun }) {
  if (dryRun) {
    console.log(`\n  ${dim(`— dry run: ${r.relPath || r.slug} — nothing written —`)}\n`);
    console.log(r.content || "");
    return;
  }
  if (!r.ok) {
    console.error(`\n  ${paint("31", "✗")} ${r.slug || "publish"} — ${r.reason}\n`);
    return;
  }
  if (r.unchanged) { console.log(`\n  ${dim("○")} ${r.slug} — already up to date (no commit)\n`); return; }
  const tail = r.retried ? "pushed the earlier commit" : r.pushed ? "committed + pushed" : "committed (not pushed)";
  console.log(`\n  ${paint("32", "✓")} ${bold(r.slug)} — ${tail}`);
  console.log(`  ${dim(`${r.relPath}${r.sha ? "  @ " + r.sha.slice(0, 9) : ""}`)}\n`);
}

function reportDrain(r, { dryRun }) {
  if (dryRun) {
    console.log(`\n  ${dim(`— dry run: ${r.considered} post(s) —`)}`);
    for (const p of r.results) console.log(`  ${dim("·")} ${p.slug} → ${p.relPath}`);
    console.log("");
    return;
  }
  console.log(`\n  ${r.ok ? paint("32", "✓") : paint("31", "✗")} drain: ${r.published}/${r.considered} post(s) committed`);
  for (const p of r.results) {
    if (!p.ok) console.log(`  ${paint("31", "✗")} ${p.slug} — ${p.reason}`);
    else if (p.unchanged) console.log(`  ${dim("○ " + p.slug + " — up to date")}`);
    else console.log(`  ${paint("32", "✓")} ${p.slug} — ${p.retried ? "pushed the earlier commit" : p.pushed ? "pushed" : "committed"}`);
  }
  console.log("");
}

/* ── scaffolds + help ────────────────────────────────────────────────────── */

function scaffoldConfig() {
  return `// pressroom.config.mjs — the local pressroom for your blog.
// siteRepo, postsDir, contentDir and branch also take a PRESSROOM_* env var or a CLI flag.
export default {
  // Your local draft workspace: one <slug>.mdx per post. Relative to this file.
  postsDir: "posts",

  // Absolute path to your static site's git checkout — publishing writes into it.
  // (env: PRESSROOM_SITE_REPO · flag: --site-repo)
  siteRepo: "/absolute/path/to/your-site",

  // Where posts land inside the site repo (the site's MDX content directory).
  contentDir: "content/posts",

  // The branch your site deploys from — what publish commits + pushes to.
  branch: "main",

  // Default byline for new posts and the fallback publish author. Left unset,
  // pressroom uses your \`git config user.name\`; with neither, posts carry no author.
  // defaultAuthor: "Your Name",

  // More bylines the viewer offers in its Author menu.
  // authors: ["Your Name", "A Co-author"],

  // Push after committing? Override per run with --no-push.
  push: true,
};
`;
}

function printHelp() {
  console.log(`pressroom — the local pressroom for your blog.

Draft posts as MDX on your machine, preview them in a viewer, and publish each one
as a scoped git commit into your static site's repo with one command.

  pressroom new <title>        scaffold a slugged draft .mdx in your posts dir
  pressroom list               every post + its status (draft · ready · published)

  pressroom publish <slug>     serialize → write into the site repo → scoped commit → push
  pressroom publish --all      publish every "ready" post (idempotent; skips unchanged)
      --dry-run                print the would-be MDX; write nothing, touch no git
      --no-push                commit but don't push (local verification)

  pressroom import --from=<dir>  pull existing site .mdx into your workspace (idempotent)
                                 (default source: <siteRepo>/<contentDir>)

  pressroom serve              host the viewer (preview · edit · publish)
      --port=N                 default 4640 (also honors $PORT; auto-advances if busy)
  pressroom open               serve + open the viewer in your browser

  pressroom doctor             config, site repo reachability, content dir, drafts pending
  pressroom init               scaffold a pressroom.config.mjs

Config: pressroom.config.{mjs,js,json}. Posts live in ./posts (gitignore or commit
them — your call). Publishing only ever stages the single file it wrote — never
git add -A, never a force-push. Zero runtime dependencies.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
