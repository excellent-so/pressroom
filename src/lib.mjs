// pressroom — shared helpers. Zero-dep, plain Node ESM, built-ins only.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * "YYYY-MM-DD" for today on this computer's calendar: a post published on a
 * Tuesday evening in California is dated Tuesday, not Wednesday (the UTC day).
 */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A full ISO-ish stamp, seconds precision, for created/updated bookkeeping. */
export function nowStamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function readText(file, fallback = null) {
  try { return fs.readFileSync(file, "utf8"); } catch { return fallback; }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Run a git command, returning trimmed stdout. On failure, throws an Error whose
 * `.stderr` carries git's own message (so callers can "fail politely with git's
 * stderr" — never force, never guess).
 */
export function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : "";
    const err = new Error(stderr || e?.message || "git failed");
    err.stderr = stderr;
    err.code = e?.status;
    err.missing = e?.code === "ENOENT"; // no git on PATH
    throw err;
  }
}

/** `git` with its output, or "" when it fails (a missing ref, an unset key). */
export function gitOr(args, cwd, fallback = "") {
  try { return git(args, cwd); } catch { return fallback; }
}

/** Can this machine run git at all? */
export function hasGit() {
  try { git(["--version"], process.cwd()); return true; } catch (e) { return !e.missing; }
}

/** Is `dir` the top of (or inside) a real git repo? */
export function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

/** Open the given URL in the default browser (best-effort; never throws). */
export function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  import("node:child_process")
    .then(({ execFile }) => { execFile(opener, [url], () => {}); })
    .catch(() => {});
}
