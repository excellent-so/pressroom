// pressroom — CLI. The entry point behind `pressroom` and `npx @excellent-so/pressroom`.
// The local pressroom for your blog: draft MDX, preview it, publish each post as a
// scoped git commit into your static site's repo with one command.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, contentPostsDir, ConfigError } from "./config.mjs";
import { newPost, listPosts, STATUSES } from "./posts.mjs";
import { publishPost, publishReady, siteProblem } from "./publish.mjs";
import { importPostsFromSite, siteDateKey } from "./import.mjs";
import { hasGit, gitOr, isGitRepo } from "./lib.mjs";

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

// The flags each command takes. Anything else is refused, so a typo like
// `--dryrun` can never turn into a real publish.
const CONFIG_FLAGS = ["site-repo", "posts-dir", "content-dir", "branch", "author"];
const COMMAND_FLAGS = {
  new: CONFIG_FLAGS,
  list: CONFIG_FLAGS,
  publish: [...CONFIG_FLAGS, "all", "dry-run", "no-push"],
  import: [...CONFIG_FLAGS, "from"],
  serve: [...CONFIG_FLAGS, "port"],
  open: [...CONFIG_FLAGS, "port"],
  doctor: CONFIG_FLAGS,
  init: ["force"],
};

class UsageError extends Error {}

function checkFlags(cmd, f) {
  for (const name of Object.keys(f)) {
    if (!COMMAND_FLAGS[cmd].includes(name)) {
      throw new UsageError(`pressroom ${cmd} doesn't take --${name}. Run pressroom --help to see its options.`);
    }
  }
}

function resolvePort(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`The port must be a whole number from 1 to 65535 (got ${v}).`);
  }
  return n;
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

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version; } catch { return "unknown"; }
}

/* ── small terminal helpers (never leak ANSI on a pipe) ──────────────────── */

const TTY = process.stdout.isTTY;
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const STATUS_COLOR = { draft: "2", ready: "33", published: "32" };
const statusTag = (s) => paint(STATUS_COLOR[s] || "0", s);
const indent = (text, pad = "    ") => String(text).split("\n").map((l) => pad + l).join("\n");

/* ── the router ──────────────────────────────────────────────────────────── */

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { f, positionals } = parseFlags(rest);

  if (["help", "--help", "-h"].includes(cmd) || f.help || rest.includes("-h")) return printHelp();
  if (["--version", "-v", "version"].includes(cmd)) return console.log(version());
  if (!COMMAND_FLAGS[cmd]) {
    throw new UsageError(`${cmd} isn't a pressroom command. Run pressroom --help to see the commands.`);
  }
  checkFlags(cmd, f);

  switch (cmd) {
    case "new": {
      const { config } = await setup(f);
      const title = positionals.join(" ").trim();
      if (!title) throw new UsageError('Give the post a title: pressroom new "My first post"');
      const post = newPost(config, { title });
      const rel = path.relative(process.cwd(), path.join(config.postsDir, `${post.slug}.mdx`));
      console.log(`\n  ${paint("32", "✓")} new draft ${bold(post.slug)}`);
      console.log(`  ${dim(rel)}\n`);
      console.log(`  Edit it, then preview:  ${bold("pressroom open")}`);
      console.log(`  Set status: ready, then publish:  ${bold(`pressroom publish ${post.slug}`)}\n`);
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
        if (!r.ok) process.exitCode = 1;
        break;
      }
      const slug = positionals[0];
      if (!slug) throw new UsageError("Name the post to publish: pressroom publish <slug>, or pressroom publish --all. pressroom list shows the slugs.");
      const r = publishPost(config, slug, { dryRun, push });
      reportPublish(r, { dryRun });
      if (!r.ok) process.exitCode = 1;
      break;
    }

    case "import": {
      const { config } = await setup(f);
      const from = f.from && f.from !== true ? String(f.from) : undefined;
      if (f.from === true) throw new UsageError("--from needs a folder: pressroom import --from=<folder>");
      const r = importPostsFromSite(config, { from });
      if (!r.ok) {
        console.error(`\n  ${paint("31", "✗")} ${r.message}\n`);
        process.exitCode = 1;
        break;
      }
      const source = from ? path.resolve(from) : contentPostsDir(config);
      console.log(`\n  ${paint("32", "✓")} imported ${r.slugs.length} post(s) from ${dim(source)} → ${dim(config.postsDir)}`);
      console.log(`  ${dim(`${r.imported} new · ${r.updated} updated · ${r.unchanged} unchanged`)}${r.skipped.length ? "" : "\n"}`);
      if (r.skipped.length) {
        console.log(`  ${paint("33", "!")} left out ${r.skipped.join(", ")}: frontmatter pressroom can't read in full (not YAML, or values over several lines)\n`);
      }
      break;
    }

    case "serve":
    case "open": {
      const port = f.port !== undefined ? resolvePort(f.port) : (process.env.PORT ? resolvePort(process.env.PORT) : 4640);
      const { config, root, file } = await setup(f);
      const { serve } = await import("./serve.mjs");
      // Pass the config root + file so an in-app Connect can persist without a hand-edit.
      serve(config, { port, open: cmd === "open", root, configFile: file });
      break;
    }

    case "doctor": {
      const { config, file } = await setup(f);
      const posts = listPosts(config);
      const cdir = contentPostsDir(config);
      const gitOk = hasGit();
      const problem = siteProblem(config, { push: config.push });
      const siteOk = config.siteRepo && isGitRepo(config.siteRepo);
      const cdirOk = cdir && fs.existsSync(cdir);
      const mark = (ok) => (ok ? paint("32", "✓") : paint("31", "✗"));
      const k = config.fields;
      const renamed = Object.entries(k).filter(([a, b]) => a !== b).map(([a, b]) => `${a} → ${b}`);
      console.log("\npressroom — doctor\n");
      console.log(`  config:      ${file || dim("(none — using defaults; run `pressroom init`)")}`);
      console.log(`  git:         ${gitOk ? gitOr(["--version"], process.cwd()).replace(/^git version /, "") + "  " + mark(true) : mark(false) + " not found on your PATH"}`);
      console.log(`  postsDir:    ${config.postsDir}  ${fs.existsSync(config.postsDir) ? mark(true) : dim("(will be created on first `new`)")}`);
      console.log(`  siteRepo:    ${config.siteRepo || dim("(not set — publishing is disabled)")}  ${config.siteRepo ? mark(siteOk) + (siteOk ? "" : " not a git repo") : ""}`);
      console.log(`  contentDir:  ${config.contentDir}  →  ${cdir ? cdir : dim("(needs siteRepo)")}  ${cdir ? mark(cdirOk) + (cdirOk ? "" : " missing") : ""}`);
      console.log(`  branch:      ${config.branch}`);
      console.log(`  fields:      ${renamed.length ? renamed.join(", ") : dim("title, description, date, tags, author")}`);
      console.log(`  extension:   ${config.extension} ${dim("(for posts new to the site)")}`);
      const authorNote = config.authorFrom === "git" ? dim("  (from git config user.name)") : "";
      console.log(`  author:      ${config.defaultAuthor ? config.defaultAuthor + authorNote : dim("(none: set defaultAuthor or git config user.name)")}`);
      console.log(`  push:        ${config.push ? "yes" : "no (--no-push forced by config)"}`);
      console.log("");
      for (const s of STATUSES) console.log(`  ${s.padEnd(11)}${posts.filter((p) => p.status === s).length}`);
      const pending = posts.filter((p) => p.status === "ready").length;
      const dateKey = cdirOk ? siteDateKey(cdir, k.date) : null;
      if (dateKey) {
        console.log(`\n  ${paint("33", "!")} The site's posts keep their date in ${dateKey}, but publish writes ${k.date}. Add fields: { date: "${dateKey}" } to your config.`);
      }
      if (problem) {
        console.log(`\n  ${paint("31", "✗")} ${problem[1]}\n`);
        process.exitCode = 1;
      } else {
        console.log(`\n  ${pending ? bold(`${pending} post(s) ready to publish`) + ` — run ${bold("pressroom publish --all")}` : dim("ready to publish; nothing is queued")}\n`);
      }
      break;
    }

    case "init": {
      const target = path.join(process.cwd(), "pressroom.config.mjs");
      if (fs.existsSync(target) && !f.force) {
        throw new UsageError(`${target} already exists. Edit it, or pass --force to replace it.`);
      }
      fs.writeFileSync(target, scaffoldConfig());
      console.log(`\n  ${paint("32", "✓")} wrote ${path.relative(process.cwd(), target)}`);
      console.log(`  ${dim("Set `siteRepo` to your static site's git checkout, then:")}  ${bold('pressroom new "Hello, world"')}\n`);
      break;
    }
  }
}

/* ── result reporting ────────────────────────────────────────────────────── */

function reportFailure(r) {
  console.error(`\n  ${paint("31", "✗")} ${r.slug ? bold(r.slug) + ": " : ""}${r.message || r.reason}`);
  if (r.detail) console.error(`\n${dim(indent(r.detail))}`);
  console.error("");
}

function reportPublish(r, { dryRun }) {
  if (!r.ok) return reportFailure(r);
  if (dryRun) {
    console.log(`\n  ${dim(`— dry run: ${r.relPath || r.slug} — nothing written —`)}\n`);
    console.log(r.content || "");
    return;
  }
  if (r.unchanged) { console.log(`\n  ${dim("○")} ${r.slug} — already up to date (no commit)\n`); return; }
  const tail = r.retried ? "pushed the earlier commit" : r.pushed ? "committed + pushed" : "committed (not pushed)";
  console.log(`\n  ${paint("32", "✓")} ${bold(r.slug)} — ${tail}`);
  console.log(`  ${dim(`${r.relPath}${r.sha ? "  @ " + r.sha.slice(0, 9) : ""}`)}\n`);
}

function reportDrain(r, { dryRun }) {
  if (!r.considered) {
    console.log(`\n  ${dim("○")} Nothing to publish: no post is ready or published. Set a post's status to ready first.\n`);
    return;
  }
  if (!r.results.length && !r.ok) {
    console.error(`\n  ${paint("31", "✗")} ${r.message}\n`);
    return;
  }
  if (dryRun) {
    console.log(`\n  ${dim(`— dry run: ${r.considered} post(s), nothing written —`)}`);
    for (const p of r.results) {
      console.log(p.ok ? `  ${dim("·")} ${p.slug} → ${p.relPath}` : `  ${paint("31", "✗")} ${p.slug}: ${p.message || p.reason}`);
    }
    console.log("");
    return;
  }
  console.log(`\n  ${r.ok ? paint("32", "✓") : paint("31", "✗")} published ${r.published} of ${r.considered} post(s)${r.ok ? "" : `: ${r.message}`}`);
  for (const p of r.results) {
    if (!p.ok) {
      console.log(`  ${paint("31", "✗")} ${p.slug}: ${p.message || p.reason}`);
      if (p.detail) console.log(dim(indent(p.detail, "      ")));
    } else if (p.unchanged) console.log(`  ${dim("○ " + p.slug + " — up to date")}`);
    else console.log(`  ${paint("32", "✓")} ${p.slug} — ${p.retried ? "pushed the earlier commit" : p.pushed ? "committed + pushed" : "committed"}`);
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

  // Where posts land inside the site repo (the site's content folder).
  // The Astro blog template: "src/content/blog".
  contentDir: "content/posts",

  // The branch your site deploys from — what publish commits + pushes to.
  branch: "main",

  // The frontmatter key names your site reads, where they differ from pressroom's
  // (title, description, date, tags, author). The Astro blog template reads pubDate:
  // fields: { date: "pubDate" },

  // The extension of a post new to the site: ".mdx", or ".md" for a Markdown-only site.
  // extension: ".mdx",

  // Default byline for new posts. Left unset, pressroom uses your
  // \`git config user.name\`; with neither, posts carry no author.
  // defaultAuthor: "Your Name",

  // More bylines the viewer offers in its Author menu.
  // authors: ["Your Name", "A Co-author"],

  // Push after committing? Override per run with --no-push.
  push: true,
};
`;
}

function printHelp() {
  console.log(`pressroom ${version()} — the local pressroom for your blog.

Write posts as files on your machine, preview them in a viewer, and publish each one
as a git commit to your static site's repo that contains only that post's file.

  pressroom init               write a pressroom.config.mjs here
      --force                  replace an existing one
  pressroom new <title>        write a draft <slug>.mdx in your posts folder
  pressroom list               every post with its status, date, title and slug

  pressroom publish <slug>     write the post into the site repo, commit that file, push
  pressroom publish --all      publish every ready post, and every published one that changed
      --dry-run                print the file it would write; touch nothing
      --no-push                commit without pushing

  pressroom import             copy the site's .mdx and .md posts into your posts folder
      --from=<folder>          read them from another folder

  pressroom open               start the viewer and open it in your browser
  pressroom serve              start the viewer
      --port=N                 default 4640, or $PORT; the next free port if it's busy

  pressroom doctor             check git, the config, the site repo and the content folder

  Every command but init also takes --site-repo=, --posts-dir=, --content-dir=,
  --branch= and --author= to override the config for one run.

Config: pressroom.config.mjs (or .js, .cjs, .json), found in this folder or above.
Publishing stages only the file it wrote and never force-pushes.`);
}

main().catch((e) => {
  if (e instanceof ConfigError || e instanceof UsageError) {
    console.error(`pressroom: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
