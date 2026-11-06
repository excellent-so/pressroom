# Changelog

Changes to pressroom, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

The first release.

### Added

- Posts are files: one `<slug>.mdx` per post in a folder (`./posts` by default), each `draft`, `ready` or
  `published`. `pressroom new` writes a draft; `pressroom list` shows every post.
- `pressroom publish <slug>` writes the post into your site repo's content folder with the frontmatter a
  static site reads (`title`, `description`, `date`, `tags`, `author`), commits that one file, and pushes.
  It stages nothing else, never force-pushes, and makes no commit when the site's copy already matches. If an
  earlier publish committed the post but its push failed, publishing again pushes that commit.
  `--all` publishes every `ready` post and every `published` post that changed; `--dry-run` prints the file
  and touches nothing; `--no-push` commits without pushing.
- On publish, keys the site's copy already has (`tags`, `author`, `hero` and the rest) are kept. A post's own
  tags and author fill in when the site's copy has none.
- `pressroom import` copies a site's existing `.mdx` and `.md` posts into the posts folder, matched by slug.
  Publishing a post the site keeps as `.md` writes back to that file.
- `fields` in the config renames the frontmatter keys publish writes and import reads, for a site whose schema
  uses other names: `fields: { date: "pubDate" }` makes it work with the Astro blog template. `extension: ".md"`
  names posts new to the site `.md`, for a site that builds only Markdown.
- Keys pressroom doesn't know (`heroImage`, `layout`) stay in a post's file and are published as they are.
- An empty excerpt publishes the post's first paragraph of prose as the description.
- `pressroom --version`, and `pressroom init --force` to replace a config.
- The viewer (`pressroom open` or `pressroom serve`): the post list, an editor that saves to disk, a markdown
  preview or the raw file beside it, Publish and Dry run with git's result, a new-post form, and a dialog
  that connects a site repo and saves it to the config. It listens on `127.0.0.1` only, port 4640 by default,
  and refuses writes from other sites' pages.
- The viewer embeds Geist and Geist Mono, so it looks the same on every machine with no outside requests.
- The viewer is built on `@excellent-so/kit` 0.2.1 (MIT): light by default whatever the OS says, a Dark
  button the browser remembers, statuses as ink-outline badges with a glyph, and red only for a failed
  publish. On a phone it is one column.
- pressroom has its own mark, a masthead bar over two columns: left of the name in the viewer's header, as the
  browser tab's icon, and at the head of the README. The header carries no publisher byline.
- The preview says it is a markdown preview. MDX it can't run (imports, JSX, HTML tags) shows as labelled code.
- The default byline is `defaultAuthor` from the config, then `git config user.name`; with neither, posts have
  no author. There is no built-in name. `pressroom doctor` says where the byline came from.
- `pressroom doctor` checks the config, the site repo and the content folder. `pressroom init` writes a
  commented `pressroom.config.mjs`.
- `npm run test:standalone` runs the CLI with a fresh HOME and a reduced PATH in a throwaway git repo, and
  checks that a publish commits only the post's file.
- No runtime dependencies.
- CI runs the suite and the standalone check on Node 20 and 22.
- The code, issues and pull requests live at [github.com/excellent-so/pressroom](https://github.com/excellent-so/pressroom).

### Fixed

Found by testing the release as a new user would, against a real Astro blog:

- A post published to the Astro blog template no longer breaks the site's build: the template needs
  `pubDate`, which `fields` now maps.
- Re-publishing an imported post you haven't changed makes no commit. pressroom compares what the site's file
  says (its values and body), not its bytes, keeps the site's date text (`'Jul 08 2022'`) when it is the same
  day, and no longer adds the default byline to a post the site already has.
- Import reads a date such as `Jul 08 2022` as that day, instead of cutting it to `Jul 08 202`.
- Publish no longer overwrites a site file that has edits you haven't committed. It refuses and says so.
- A publish whose commit didn't happen (a pre-commit hook, say) is committed next time instead of being
  reported as already up to date.
- With no `origin` remote, publish refuses before committing, instead of committing, failing to push, and then
  reporting the post up to date and published. A push to a branch origin has never had is no longer skipped.
- With the site checked out on another branch, publish refuses, instead of committing there and reporting
  "committed + pushed" while pushing nothing.
- When git has no name and email set, publish refuses instead of letting git invent an identity from the
  computer's user and host name.
- With no git on the PATH, publish says to install git instead of printing `spawnSync git ENOENT`, and writes
  nothing. `pressroom doctor` checks for git.
- Failures are one sentence that says what to do, with git's own message below when git refused: no more
  `site-repo-not-found` or `content-posts-dir-missing` codes, and a rejected push says to `git pull`.
- `pressroom doctor` exits 1 when publishing can't work.
- An unknown command or flag is an error (exit 1) instead of printing help or being ignored, so a typo such as
  `--dryrun` can't publish for real. A bad `--port` is an error instead of falling back to 4640.
- A broken config file is one sentence naming the file, not a stack trace.
- When its port is busy, the viewer prints its address once and opens one browser tab, not one per port it
  tried, and no longer warns about too many listeners.
- The preview names an image with a path on your site instead of requesting it from the viewer, so there's
  no 404 or console error on every keystroke.
- A site post whose frontmatter pressroom can't read in full (Eleventy's `---js`, TOML's `+++`, a nested map
  such as Next.js's `author:` with `name:` under it, `>-` text) is left out of import, and publish refuses to
  change it, instead of rewriting it without those values.
- A post the site already has keeps its own date text when it is the same day, full timestamps included, and
  doesn't get a description invented for it.
- A new post has no placeholder excerpt, so "Write your post here." can't end up as the site's description.
- Slugs keep accented letters as plain ones: "Café crème" is `cafe-creme`, not `caf-cr-me`.
- A slug with a `/` or a leading `.` is refused, so it can't reach outside the posts folder.
- Line breaks in a title or excerpt are folded to spaces, so they can't break the frontmatter.
- Dates are your computer's calendar day, not the UTC day, so an evening post isn't dated tomorrow.
