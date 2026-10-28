# Contributing

Thanks for helping improve Stugu.

## Development

1. Install Node.js 22.22.2 or newer. Stugu itself runs on 22.13+, but the web
   test environment (jsdom 30) needs 22.22.2+.
2. Run `npm run setup -- --mode local --real`; it creates a missing `.env`
   without replacing local settings and installs dependencies with `npm ci`.
3. Run `npm run dev` for the API on port 8787 and the web app on
   <http://localhost:5173>. Set `MOCK_ENABLED=true` in `.env` before the first
   start to work against the synthetic sample home.
4. Install the Python development dependencies (Python 3.13), start Docker
   Desktop, and run `npm run verify:local -- --full` before pushing or opening a
   pull request.

See [Architecture](docs/architecture.md) for how the workspaces fit together
and [CLAUDE.md](CLAUDE.md) for the repository layout and build commands.
Remember to rebuild `packages/contracts` and `packages/analytics-kernel`
(`npm run build:packages`) after editing them: the apps resolve them from
`dist`.

## Continuous quality

Hosted GitHub Actions CI is paused; its workflows run only when dispatched
manually. Run the checks on your own computer instead:

```sh
npm run verify:local -- --fast   # affected checks while iterating
npm run verify:local -- --full   # the authoritative gate; writes a receipt
```

The full gate checks the version, architecture and types, Python lint and
formatting, coverage, the build, Compose configuration, every production
Docker target and an API smoke test with analytics speed targets. See
[local CI and release publishing](docs/local-ci.md), which also covers
`npm run ci:local -- --with-sonar` for Sonar analysis. Changes to the native
Apple companion also need the macOS checks described there.

`npm run typecheck` enforces the rules in the "Code quality" section of
[CLAUDE.md](CLAUDE.md). In short:

- Split modules by domain, never by line count; no new numbered `part-NN`
  files.
- Keep files under 1,200 lines and functions at cognitive complexity 15 or
  less; existing baselines may only shrink.
- Leave no unused imports, locals or parameters.
- Reuse existing helpers. Statistics, time-weighted means, kWh integration and
  calendar helpers come from `@climate-twin/analytics-kernel`.
- Put types shared by two workspaces in `@climate-twin/contracts`.
- Document every new route once in OpenAPI with a single success body, and
  validate responses in the web client's API layer.
- Add every user-facing string to the English, Finnish and Swedish catalogs.

## Versioning

Every pull request bumps the version in all manifests: the minor version for a
feature or breaking change, the patch version for fixes and documentation. Add
a user-facing CHANGELOG entry with an "Upgrade impact" note.
`npm run version:check` lists every file that carries the version. See
[versioning](docs/versioning.md).

## Security and privacy

- Never commit credentials, tokens, real Home Assistant entity IDs, floor plans, telemetry, or SQLite databases.
- Keep local CI credentials out of the repository. GitHub secrets are only for
  explicitly invoked hosted fallbacks.
- Use fake or empty values in examples, tests and screenshots.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Pull requests

Work on a branch off `main`, keep changes focused, explain their user impact,
and add tests for changed behaviour where practical. By contributing, you agree
that your contribution is licensed under the MIT License.
