# Contributing

pressroom is MIT licensed. By contributing you agree your changes are offered under the same license. There
is no CLA.

## What's welcome

- Bug fixes
- Documentation improvements
- Support for more site frontmatter conventions and frameworks
- Small, focused improvements with a clear use

For larger changes, or anything that touches the publish guarantees (one file per commit, no force-push, no
commit when nothing changed), open an issue first so we can agree on the direction before you spend time on
a pull request.

## Getting the code

```sh
git clone https://github.com/excellent-so/pressroom.git
cd pressroom
```

Issues and pull requests go to [github.com/excellent-so/pressroom](https://github.com/excellent-so/pressroom).
Security issues are the exception: see [SECURITY.md](SECURITY.md).

## Before you submit

Run both checks and confirm they pass:

```sh
npm test                  # the suite; ends with "N passed, 0 failed"
npm run test:standalone   # the CLI in a fresh HOME, a reduced PATH and a temp git repo
```

Both are offline and dependency-free. They make throwaway git repos in your temp folder and never touch a
real repo or push anywhere outside it.

The viewer's styles come from `@excellent-so/kit` (MIT), synced into `viewer/index.html` between the
`excellent-kit:begin` and `excellent-kit:end` markers. Edit the viewer's own CSS below that block, and use the
kit's tokens (`--color-*`) there. To update the kit's block:

```sh
npx @excellent-so/kit sync viewer/index.html --no-compat
```

Keep pull requests focused: one change per pull request makes review faster.
