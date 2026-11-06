#!/usr/bin/env node
// pressroom: the independence gate (`npm run test:standalone`).
//
// Runs the real CLI the way a new user would, with nothing else installed and
// nothing borrowed from this machine: HOME is a fresh temp folder (so no global git
// config), PATH is node's own bin folder plus /usr/bin:/bin, and no other
// environment variable is passed on (so no PRESSROOM_* override or other setting
// from this shell leaks in). The working directory is a throwaway git repo outside
// any other repo, and its only remote is a bare repo in the same temp folder, so
// the publish push never leaves this machine.
//
// It scaffolds a config, writes a post, publishes it, and checks that the commit
// holds that post's file and nothing else. POSIX only (macOS, Linux).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PKG_ROOT, "bin", "pressroom.mjs");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pressroom-standalone-")));
const home = path.join(base, "home");
const site = path.join(base, "site");
const origin = path.join(base, "origin.git");
fs.mkdirSync(home);

const ENV = {
  HOME: home,
  PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  GIT_CONFIG_NOSYSTEM: "1",
};

let step = 0;
let child = null; // the viewer, while it runs
const ok = (msg) => console.log(`  ok ${++step}  ${msg}`);
function fail(msg) {
  if (child) child.kill();
  console.error(`\n  FAILED: ${msg}\n  (left for inspection: ${base})\n`);
  process.exit(1);
}
function check(cond, msg) { if (!cond) fail(msg); }

/** Run a command with the reduced environment; returns trimmed stdout. */
function run(cmd, args, { cwd = site, allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    fail(`${cmd} ${args.join(" ")}\n${String(e.stderr || e.message).trim()}`);
  }
}
const git = (args, opts) => run("git", args, opts);
const pressroom = (args, opts) => run("node", [BIN, ...args], opts);

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

console.log(`\npressroom standalone check\n  temp: ${base}\n`);

// ── the environment is really reduced ──────────────────────────────────────
check(Object.keys(ENV).sort().join(" ") === "GIT_CONFIG_NOSYSTEM HOME PATH", "only HOME, PATH and GIT_CONFIG_NOSYSTEM are passed on");
const gitPath = run("/bin/sh", ["-c", "command -v git"], { cwd: base });
check(gitPath && /^\/(usr\/)?bin\/git$/.test(gitPath), `git resolves from /usr/bin or /bin (got ${gitPath})`);
const nodePath = run("/bin/sh", ["-c", "command -v node"], { cwd: base });
check(nodePath === path.join(path.dirname(process.execPath), "node"), `node resolves from its own bin folder (got ${nodePath})`);
check(git(["config", "--global", "user.name"], { cwd: base, allowFail: true }) === null, "no global git user.name in the fresh HOME");
check(git(["rev-parse", "--is-inside-work-tree"], { cwd: base, allowFail: true }) === null, "the temp folder is outside any git repo");
ok(`reduced environment: HOME=${home}, git=${gitPath}, node=${nodePath}`);

// ── a site repo whose only remote is a local bare repo ──────────────────────
fs.mkdirSync(path.join(site, "content", "posts"), { recursive: true });
git(["init", "-q", "-b", "main", "."]);
git(["config", "user.name", "Standalone Tester"]);
git(["config", "user.email", "tester@example.invalid"]);
fs.writeFileSync(path.join(site, "content", "posts", ".gitkeep"), "");
fs.writeFileSync(path.join(site, "README.md"), "# a site\n");
git(["add", "README.md", "content/posts/.gitkeep"]);
git(["commit", "-q", "-m", "init"]);
git(["init", "-q", "--bare", "-b", "main", origin], { cwd: base });
git(["remote", "add", "origin", origin]);
git(["push", "-q", "-u", "origin", "main"]);
check(git(["remote"]) === "origin" && git(["remote", "get-url", "origin"]) === origin, "the only remote is the local bare repo");
ok("site repo with a local bare remote");

// ── init, new, doctor ───────────────────────────────────────────────────────
pressroom(["init"]);
const cfgFile = path.join(site, "pressroom.config.mjs");
check(fs.existsSync(cfgFile), "init wrote pressroom.config.mjs");
const cfgSrc = fs.readFileSync(cfgFile, "utf8");
check(!/Excellent Team|Matt Waite/.test(cfgSrc), "the scaffold carries no built-in byline");
fs.writeFileSync(cfgFile, cfgSrc.replace('"/absolute/path/to/your-site"', '"."'));
ok("init scaffolded a config (siteRepo set to this repo)");

pressroom(["new", "Standalone check"]);
const postFile = path.join(site, "posts", "standalone-check.mdx");
check(fs.existsSync(postFile), "new wrote posts/standalone-check.mdx");
check(/^author: "Standalone Tester"$/m.test(fs.readFileSync(postFile, "utf8")), "the byline came from git config user.name");
ok("new wrote a draft, bylined from git config user.name");

const doctor = pressroom(["doctor"]);
check(/Standalone Tester\s+\(from git config user\.name\)/.test(doctor), "doctor names the byline's source");
ok("doctor ran");

// ── publish: one commit, that post's file only, pushed to the local remote ──
const before = Number(git(["rev-list", "--count", "HEAD"]));
pressroom(["publish", "standalone-check"]);
check(Number(git(["rev-list", "--count", "HEAD"])) === before + 1, "exactly one new commit");
const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean);
check(files.length === 1 && files[0] === "content/posts/standalone-check.mdx", `the commit holds only the post's file (got: ${files.join(", ")})`);
check(git(["log", "-1", "--format=%s"]) === "blog: publish standalone-check", "the commit message names the post");
check(git(["rev-parse", "HEAD"]) === git(["rev-parse", "main"], { cwd: origin }), "the local bare remote received the commit");
const untracked = git(["status", "--porcelain"]);
check(/^\?\? posts\/$/m.test(untracked) && /^\?\? pressroom\.config\.mjs$/m.test(untracked), "the posts folder and the config stayed out of the commit");
const published = fs.readFileSync(path.join(site, "content", "posts", "standalone-check.mdx"), "utf8");
check(/^title: "Standalone check"$/m.test(published) && /^author: "Standalone Tester"$/m.test(published), "the published frontmatter has the title and byline");
ok(`publish made one commit with one file: ${files[0]}`);

// ── the viewer serves, with the kit inside ──────────────────────────────────
const port = 41000 + Math.floor(Math.random() * 8000);
child = spawn("node", [BIN, "serve", `--port=${port}`], { cwd: site, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
try {
  const livePort = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the viewer didn't start within 10s")), 10000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (code) => reject(new Error(`the viewer exited (${code})`)));
  }).catch((e) => fail(e.message));
  const page = await get(livePort, "/");
  check(page.status === 200 && page.body.includes("/* excellent-kit:begin */"), "the viewer page serves with the kit block");
  const posts = JSON.parse((await get(livePort, "/api/posts")).body);
  check(posts.ok && posts.posts.some((p) => p.slug === "standalone-check" && p.status === "published"), "the viewer lists the published post");
  ok(`the viewer served on port ${livePort}`);
} finally {
  child.kill();
  child = null;
}

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n  standalone: ${step} checks passed\n`);
