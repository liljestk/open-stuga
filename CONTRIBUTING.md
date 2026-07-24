# Contributing

Thanks for helping improve Stuga.

## Development

1. Install Node.js 22.13 or newer.
2. Run `npm run setup -- --mode local --real`; it creates a missing `.env`
   without replacing local settings and installs dependencies with `npm ci`.
3. Run `npm run typecheck`, `npm test`, `npm run build`, and
   `npm run smoke:built-api` before opening a pull request.

## Continuous quality

GitHub Actions sends trusted pull requests and pushes to `main` to the `liljestk_open-stuga` SonarQube Cloud project. The repository needs a `SONAR_TOKEN` Actions secret, and SonarQube Cloud automatic analysis must be disabled so that CI-based analysis is authoritative.

The SonarQube quality gate must pass, including an A maintainability rating on new code.

## Security and privacy

- Never commit credentials, tokens, real Home Assistant entity IDs, floor plans, telemetry, or SQLite databases.
- Put credentials needed by GitHub Actions in GitHub repository or environment secrets.
- Use fake or empty values in examples and tests.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Pull requests

Keep changes focused, explain their user impact, and add tests for changed behaviour where practical. By contributing, you agree that your contribution is licensed under the MIT License.
