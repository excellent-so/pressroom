# Security

## Reporting a vulnerability

Please report security issues privately to **matt@excellent.so**. Do not open a
public GitHub issue.

Include a description of the issue, steps to reproduce, and any relevant version
information. You'll get a response within a few business days. There is no bug bounty
program.

## Supported versions

The supported version is the **latest release on npm** (`@excellent-so/pressroom`).
Older versions do not receive security fixes.

## Scope

`pressroom` is a local-only authoring tool. It has no cloud component, no accounts,
and no network access beyond the `git push` you ask for. Areas most likely to matter:

- **The git-push trust boundary.** Publishing writes into a site repo you configure
  and shells out to `git`. By design, pressroom **only ever stages the single file it
  wrote** (`git add <path>`, then `git commit -- <path>`) — never `git add -A`, `-u`,
  or `-A .` — so it cannot sweep unrelated working-tree changes into a commit. It
  **never force-pushes**: a push that can't fast-forward fails and returns git's own
  stderr; nothing on the remote is overwritten. Push credentials come from the site
  repo's own git remote — pressroom never handles or stores a token.
- **The local viewer.** `pressroom serve` binds `127.0.0.1` only and guards mutating
  routes (`POST /api/posts`, `POST /api/publish/*`) against cross-origin requests, so
  a page in your browser can't drive local writes or a publish while the viewer runs.
- **Config loading + path handling.** Config is imported from `pressroom.config.*` in
  your project; treat a project's config as you would its code.
