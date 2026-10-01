# Contributing to Tikspot

Thanks for your interest in improving Tikspot! Contributions are welcome — bug reports,
feature ideas, docs, and code.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs / features:** open an issue first (use the templates) so we can agree on the
  approach before you spend time on a PR. For anything non-trivial, a quick "I'd like to
  work on this" comment avoids duplicated effort.
- **Security issues:** do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

Tikspot is a Node.js (Fastify) app that ships as a container for RouterOS v7. You can work
on the app directly with Node, and build the image with Docker + buildx.

```bash
cd app
npm install
npm test            # node --test — pure-module unit tests (no native deps needed)
```

To build the container image and check the size budget (run from the repo root):

```bash
npm run build:local   # amd64 image + the <250 MB size gate
```

The image **must stay under 250 MB** so it fits hotspot-class MikroTik devices — the build
gate (`scripts/check-size.mjs`) enforces this and CI will fail a PR that exceeds it.

### Keeping private data out of commits

If you work against real routers or guest systems, enable the pre-commit guard once per clone:

```sh
npm run hooks
```

It refuses commits that stage always-private paths (`local/`, `.env`, the changelog and
scratch files listed in `.gitignore`) and, if you create `local/forbidden-strings.txt`, any
added line containing one of your private strings — customer names, internal hostnames and
addresses, account numbers, fragments of secrets. See
`scripts/hooks/forbidden-strings.example.txt` for the format. The list itself is gitignored and
the hook never prints the matched text, only the file, line and list entry.

## Pull requests

1. Fork the repo and create a topic branch off `main`.
2. Keep changes focused; match the surrounding code style (plain ES modules, Node 22,
   `"type": "module"`, no runtime build step).
3. Add or update unit tests under `app/test/` where it makes sense.
4. Make sure `cd app && npm test` passes and the image still builds under budget.
5. Open the PR against `main` and fill out the template.

**All PRs are gated:** the CI workflow (unit tests + multi-arch image build + size gate +
container smoke test) must pass, and the maintainer reviews every PR before it can be
merged to `main`. CI runs automatically; please don't be discouraged if a first-time PR
needs maintainer approval to start its workflow run — that's a GitHub safety default.

## Commit messages

Short imperative subject (e.g. `fix(portal): escape voucher code in print sheet`), with a
body explaining the *why* when it isn't obvious. Reference the issue number when relevant.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
