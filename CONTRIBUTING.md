# Contributing

Thanks for helping improve Climate Twin.

## Development

1. Install Node.js 22.13 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and keep all values local.
4. Run `npm run typecheck`, `npm test`, and `npm run build` before opening a pull request.

## Security and privacy

- Never commit credentials, tokens, real Home Assistant entity IDs, floor plans, telemetry, or SQLite databases.
- Put credentials needed by GitHub Actions in GitHub repository or environment secrets.
- Use fake or empty values in examples and tests.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Pull requests

Keep changes focused, explain their user impact, and add tests for changed behaviour where practical. By contributing, you agree that your contribution is licensed under the MIT License.
