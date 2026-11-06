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
- `pressroom import` copies a site's existing `.mdx` posts into the posts folder, matched by slug.
- The viewer (`pressroom open` or `pressroom serve`): the post list, an editor that saves to disk, a markdown
  preview or the raw file beside it, Publish and Dry run with git's result, a new-post form, and a dialog
  that connects a site repo and saves it to the config. It listens on `127.0.0.1` only, port 4640 by default,
  and refuses writes from other sites' pages.
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
- The code, issues and pull requests live at [github.com/excellent-so/pressroom](https://github.com/excellent-so/pressroom).
