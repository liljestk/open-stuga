# Contributing

Thanks for helping improve Stugu.

## Development

1. Install Node.js 22.13 or newer.
2. Run `npm run setup -- --mode local --real`; it creates a missing `.env`
   without replacing local settings and installs dependencies with `npm ci`.
3. Install the Python development dependencies, start Docker, and run
   `npm run ci:local` before pushing or opening a pull request.

## Continuous quality

Automatic GitHub-hosted CI is paused while the repository is private.
`npm run ci:local` is the authoritative gate and writes a checksummed receipt
under `dist/ci`. See [local CI and release publishing](docs/local-ci.md).

Use `npm run ci:local -- --with-sonar` when Sonar analysis is required. Changes
to the native Apple companion also need the macOS checks described in that
guide.

## Security and privacy

- Never commit credentials, tokens, real Home Assistant entity IDs, floor plans, telemetry, or SQLite databases.
- Keep local CI credentials out of the repository. GitHub secrets are only for
  explicitly invoked hosted fallbacks.
- Use fake or empty values in examples and tests.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Pull requests

Keep changes focused, explain their user impact, and add tests for changed behaviour where practical. By contributing, you agree that your contribution is licensed under the MIT License.
