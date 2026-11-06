<img src="docs/mark.svg" width="40" height="40" alt="">

# pressroom

Write posts locally, preview them, and publish each one as a git commit that contains only that post's file.
Zero dependencies.

![The pressroom viewer: the post list, the editor, and the markdown preview of a post](docs/screenshot.png)

pressroom is for a blog that lives in a static site's git repo (Astro, Next.js, Eleventy, or anything that
builds `.mdx` files into pages). You write in a folder of `.mdx` files on your machine. When a post is ready,
`pressroom publish` writes it into your site's content folder, commits that one file, and pushes. If your
host builds on push, the post goes live.

## Install

Requires Node 20 or later and `git` on your PATH.

```sh
npm install -g @excellent-so/pressroom    # installs the pressroom command
npx @excellent-so/pressroom --help        # or run it without installing
npm install -D @excellent-so/pressroom    # or pin it in a project
```

To run it from a clone of this repo:

```sh
git clone https://github.com/excellent-so/pressroom.git
cd pressroom && npm link                  # puts pressroom on your PATH
```

## Quick start

```sh
pressroom init                    # writes pressroom.config.mjs here
# edit pressroom.config.mjs: set siteRepo to your site's git checkout
pressroom new "Hello, world"      # writes posts/hello-world.mdx, a draft
pressroom open                    # the viewer: edit, preview, publish
pressroom publish hello-world     # write it into the site repo, commit that one file, push
```

`pressroom doctor` checks the setup: the config file, whether `siteRepo` is a git repo, the content folder,
and how many posts are ready. Try `pressroom publish <slug> --dry-run` first to see the file it would write.

## The viewer

`pressroom open` starts a local server and opens it in your browser (`pressroom serve` starts it without
opening). It has the post list with each post's status, an editor that saves to disk, a markdown preview or
the raw file beside it, and Publish and Dry run buttons that show you what git did. If no site is connected
yet, the viewer asks for the path, checks it is a git repo, and saves it to `pressroom.config.mjs`.

The viewer is light by default; the Dark button switches it, and the browser remembers the choice. It listens
on `127.0.0.1` only, port 4640 by default (`--port=N` or `$PORT`; if the port is busy it tries the next one).
Requests that write files or publish are refused when they come from another site's page.

## Posts

Each post is one file in your posts folder (`./posts` by default), named `<slug>.mdx`:

```mdx
---
title: "Moving the site to Astro"
status: ready
excerpt: "What changed, what broke, and the three redirects that saved the old links."
author: "Sam Rivera"
tags:
  - "Tools"
created: "2026-10-28"
updated: "2026-10-30T14:12:00Z"
---

We moved the site from a hand-rolled build to Astro over two weekends.
```

| Status | Meaning |
|---|---|
| `draft` | Being written. `publish --all` skips it. |
| `ready` | Queued. `publish --all` publishes it. |
| `published` | On the site. `publish --all` publishes it again only if it changed. |

Once the site has the post, publishing sets it to `published` and gives it today's date if it has none. A
publish that fails leaves the post as it was.

## What publish does

```
posts/<slug>.mdx  ->  <siteRepo>/content/posts/<slug>.mdx
                      git add content/posts/<slug>.mdx
                      git commit -m "blog: publish <slug>" -- content/posts/<slug>.mdx
                      git push origin <branch>
```

- **One file per commit.** It stages only the file it wrote. Other changes in your site's working tree stay
  out of the commit.
- **No change, no commit.** If the site's copy already matches byte for byte, nothing is committed or pushed,
  so `publish --all` is safe to run again and again. The one exception: if an earlier publish committed the
  post but the push failed, publishing again pushes that commit.
- **No force-push.** If the remote has commits you don't have, the push fails and pressroom shows git's
  message. Nothing on the remote is overwritten.

The file it writes has the frontmatter a static site reads: `title`, `description` (from the excerpt), `date`,
`tags` and `author`. When the site already has the post, the keys pressroom doesn't own (`tags`, `author`,
`hero` and any others) are kept from the site's copy; a post's own tags and author fill in when the site's
copy has none.

## Commands

| Command | What it does |
|---|---|
| `pressroom init` | Write a `pressroom.config.mjs` in the current folder |
| `pressroom new <title>` | Write a draft `<slug>.mdx` |
| `pressroom list` | Every post with its status, date, title and slug |
| `pressroom open` | Start the viewer and open it in your browser |
| `pressroom serve` | Start the viewer |
| `pressroom publish <slug>` | Write the post into the site repo, commit that file, push |
| `pressroom publish --all` | Publish every `ready` post, and every `published` post that changed |
| `pressroom import` | Copy the site's existing `.mdx` posts into your posts folder (`--from=<dir>` for another folder) |
| `pressroom doctor` | Check the config, the site repo and the content folder |

Publish takes `--dry-run` (print the file it would write and touch nothing) and `--no-push` (commit without
pushing). `import` matches posts by slug: a post already in your folder is replaced by the site's version, and
files that already match are left alone.

## Configuration

`pressroom init` writes this, and pressroom finds it by looking in the current folder and then each folder
above it. `pressroom.config.js`, `.cjs` and `.json` work too.

```js
export default {
  postsDir: "posts",                       // your posts, relative to this file
  siteRepo: "/absolute/path/to/your-site", // your site's git checkout
  contentDir: "content/posts",             // where posts go inside the site repo
  branch: "main",                          // the branch publish pushes
  // defaultAuthor: "Your Name",           // left unset: git config user.name
  // authors: ["Your Name", "A Co-author"],// more bylines for the viewer's Author menu
  push: true,                              // false: commit without pushing
};
```

The byline for new posts is `defaultAuthor`, or else your `git config user.name`, or else none (then posts
have no `author` key). `pressroom doctor` shows which.

These settings also take a flag or an environment variable, which win over the file: `--site-repo` or
`PRESSROOM_SITE_REPO`, `--posts-dir` or `PRESSROOM_POSTS_DIR`, `--content-dir` or `PRESSROOM_CONTENT_DIR`,
`--branch` or `PRESSROOM_BRANCH`, and `--author` for the byline.

## Limits

- **The preview is a markdown preview.** It draws headings, paragraphs, lists (nested items come out flat),
  block quotes, fenced code, rules, links, images, bold, italic and inline code. MDX components, JSX,
  `import` and `export` lines and HTML tags appear as labelled code when they start a line and as plain text
  inside one; tables appear as plain text. Your site's build is the real render.
- Images with paths on your site (`/images/a.png`) don't load in the preview. Full URLs do.
- Posts are `.mdx` files. Publish writes `<slug>.mdx`, and `import` reads only `.mdx`.
- Frontmatter is read as `key: value` lines and one-level lists. A nested map in a site post's frontmatter
  (for example `seo:` with keys under it) is dropped when pressroom publishes that post again.
- Publish commits on the branch your site checkout has checked out and pushes `branch` to the remote named
  `origin`. Keep the checkout on that branch.
- If a push fails, the commit stays in your site repo. Fix the cause and run `git push` there yourself:
  publishing again finds the file unchanged and reports it up to date without pushing.
- Only post files are published. Images and other files go into the site repo the way you add them now.
- Publish dates are UTC days.
- The viewer is for one person on one machine. It has no accounts and no login.

## Development

```sh
npm test                  # the suite: offline, makes throwaway git repos in your temp folder
npm run test:standalone   # the CLI in a fresh HOME, a reduced PATH and a temp git repo
```

The viewer is one HTML file, `viewer/index.html`, built on `@excellent-so/kit` (MIT).
The kit's CSS sits between two markers in its `<style>`; to update it, run
`npx @excellent-so/kit sync viewer/index.html --no-compat --fonts`.

## License

MIT. See [LICENSE](LICENSE).
