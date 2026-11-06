// pressroom — config: discover, load, and normalize `pressroom.config.*`.
//
// Zero-config works out of the box: drafts live in `./posts`, publishing targets a
// sibling site repo you point at once. Every key is overridable by an env var or a
// CLI flag. Nothing is bundled; nothing phones home. Precedence: explicit override
// wins → config file → sensible default.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { SITE_FIELDS } from "./serialize.mjs";

const CONFIG_NAMES = [
  "pressroom.config.mjs",
  "pressroom.config.js",
  "pressroom.config.cjs",
  "pressroom.config.json",
];

/** The zero-config defaults. */
export function defaults() {
  return {
    // The local workspace: one <slug>.mdx per post. Relative to cwd (or the config).
    postsDir: "posts",
    // Absolute path to your static site's git repo. Publishing writes into it.
    siteRepo: null,
    // Where posts land inside the site repo (the site's MDX content dir).
    contentDir: "content/posts",
    // The branch the site deploys from — what publish commits + pushes to.
    branch: "main",
    // Byline the viewer + `new` default to, and the last-resort publish author.
    // Unset means `git config user.name`; with neither, posts carry no author.
    defaultAuthor: "",
    // Bylines the viewer offers besides the default.
    authors: [],
    // Push after committing? `--no-push` overrides per run.
    push: true,
    // The extension of a post file new to the site: ".mdx", or ".md" for a site that
    // builds only Markdown (Eleventy, by default). A post the site has keeps its own.
    extension: ".mdx",
    // The frontmatter key names the site reads, where they differ from pressroom's
    // (title, description, date, tags, author). The Astro blog template: { date: "pubDate" }.
    fields: {},
  };
}

/** A config problem worth one sentence (the CLI prints the message, not a stack). */
export class ConfigError extends Error {}

/**
 * `git config user.name` as git resolves it from `cwd` (repo config, then global),
 * or "" when git is missing or no name is set. Never throws.
 */
export function gitUserName(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["config", "user.name"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return "";
  }
}

/** Find the nearest config file walking up from `startDir`. Returns { file, dir } | null. */
export function findConfig(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file, dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

async function loadRaw(file) {
  try {
    if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf8"));
    const mod = await import(pathToFileURL(file).href);
    return mod.default ?? mod.config ?? mod;
  } catch (e) {
    const why = String(e?.message ?? e).split("\n")[0].replace(/\.$/, "");
    throw new ConfigError(`Couldn't load ${file}: ${why}. Fix the file and try again.`);
  }
}

/** `fields` → every SITE_FIELDS key mapped to a valid frontmatter key name. */
function normalizeFields(raw, file) {
  if (raw == null) return { ...SITE_FIELDS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`fields in ${file || "your config"} must be an object, like { date: "pubDate" }.`);
  }
  const out = { ...SITE_FIELDS };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in SITE_FIELDS)) {
      throw new ConfigError(`fields.${key} in ${file || "your config"} isn't one pressroom writes. It maps ${Object.keys(SITE_FIELDS).join(", ")}.`);
    }
    const name = String(value ?? "").trim();
    if (!/^[A-Za-z_][\w-]*$/.test(name)) {
      throw new ConfigError(`fields.${key} in ${file || "your config"} must be a frontmatter key name, like "pubDate".`);
    }
    out[key] = name;
  }
  if (new Set(Object.values(out)).size !== Object.keys(out).length) {
    throw new ConfigError(`fields in ${file || "your config"} maps two of pressroom's keys to the same name.`);
  }
  return out;
}

/**
 * Resolve the effective config. Precedence: overrides (CLI) > env > file > defaults.
 * Resolves `postsDir` / `siteRepo` to absolute paths against the config's root (or cwd).
 *
 * @param {object} [o]
 * @param {string} [o.cwd]
 * @param {object} [o.overrides]  CLI-supplied overrides (highest precedence)
 * @returns {Promise<{config:object, root:string, file:string|null}>}
 */
export async function loadConfig({ cwd = process.cwd(), overrides = {} } = {}) {
  const found = findConfig(cwd);
  const root = found ? found.dir : path.resolve(cwd);
  const fromFile = found ? await loadRaw(found.file) : {};
  const merged = { ...defaults(), ...fromFile, ...overrides };

  // Env escape hatches (overrides still win over env).
  if (!overrides.siteRepo && process.env.PRESSROOM_SITE_REPO) merged.siteRepo = process.env.PRESSROOM_SITE_REPO;
  if (!overrides.postsDir && process.env.PRESSROOM_POSTS_DIR) merged.postsDir = process.env.PRESSROOM_POSTS_DIR;
  if (!overrides.branch && process.env.PRESSROOM_BRANCH) merged.branch = process.env.PRESSROOM_BRANCH;
  if (!overrides.contentDir && process.env.PRESSROOM_CONTENT_DIR) merged.contentDir = process.env.PRESSROOM_CONTENT_DIR;

  // Normalize shapes so the engine never branches on config form.
  merged.push = merged.push !== false;
  merged.contentDir = String(merged.contentDir || "content/posts").replace(/^[/\\]+|[/\\]+$/g, "");
  merged.branch = String(merged.branch || "main");
  merged.fields = normalizeFields(merged.fields, found ? found.file : null);
  merged.extension = `.${String(merged.extension || "mdx").trim().replace(/^\./, "")}`;
  if (merged.extension !== ".mdx" && merged.extension !== ".md") {
    throw new ConfigError(`extension in ${found ? found.file : "your config"} must be ".mdx" or ".md".`);
  }
  merged.authors = Array.isArray(merged.authors)
    ? merged.authors.map((a) => String(a ?? "").trim()).filter(Boolean)
    : [];

  // The default byline: the flag or config, else `git config user.name`, else none.
  // `authorFrom` records which, so `doctor` can say so and the viewer never writes a
  // name it only borrowed from git into the config file.
  const configured = typeof merged.defaultAuthor === "string" ? merged.defaultAuthor.trim() : "";
  if (configured) {
    merged.defaultAuthor = configured;
    merged.authorFrom = "config";
  } else {
    const fromGit = gitUserName(root);
    merged.defaultAuthor = fromGit;
    merged.authorFrom = fromGit ? "git" : null;
  }

  // Absolutize paths against the config root (or cwd if none).
  merged.postsDir = path.isAbsolute(merged.postsDir) ? merged.postsDir : path.resolve(root, merged.postsDir);
  if (merged.siteRepo) merged.siteRepo = path.isAbsolute(merged.siteRepo) ? merged.siteRepo : path.resolve(root, merged.siteRepo);

  return { config: merged, root, file: found ? found.file : null };
}

/** The absolute path of the site's content-posts dir (or null if no siteRepo). */
export function contentPostsDir(config) {
  if (!config.siteRepo) return null;
  return path.join(config.siteRepo, ...config.contentDir.split(/[/\\]+/));
}
