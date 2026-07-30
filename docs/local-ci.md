# Local CI and release publishing

GitHub-hosted CI is paused while the repository is private. Pushes and pull
requests do not start Actions or consume hosted-runner minutes. The two hosted
workflows remain available only as manually confirmed fallbacks.

## Prepare this computer

Install Node.js 22.13 or newer, Python 3.13, and Docker Desktop. Then install
the locked dependencies:

```sh
npm ci
python -m pip install -r apps/api/python/requirements.txt -r apps/api/python/requirements-dev.txt
```

`npm run ci:local -- --install` performs both installation steps when the
active Python environment is already the intended one.

## Validate before pushing

Refresh the comparison ref and run the complete local gate:

```sh
git fetch origin main
npm run ci:local
```

The gate checks the release version, architecture and types, Python lint and
formatting, JavaScript/TypeScript and Python coverage, operational tooling,
the application build, Compose configuration, every production Docker target,
and the built API smoke test. On macOS it also runs Swift tests and unsigned
iOS and Mac Catalyst builds. Those native Apple checks are unavailable on
Windows and Linux and are recorded as such.

A machine-readable report and SHA-256 checksum are written to
`dist/ci/stugu-<version>-local-ci.json[.sha256]`. Build output remains ignored
locally; source code is pushed with Git:

```sh
git push origin HEAD
```

Useful options:

- `--base-ref REF` selects the version-comparison ref.
- `--skip-container-builds` is for the release publisher, which immediately
  performs multi-platform container builds itself.
- `--with-sonar` optionally submits the already-generated coverage reports.

## Publish release artifacts

`npm run release:local -- --ssh-public-key PATH --publish` reruns local CI,
pushes the AMD64/ARM64 images to GHCR, builds the Raspberry Pi artifacts, and
publishes the GitHub release. The local CI report and checksum are attached to
the release. The factory image remains local unless `--upload-factory` is
explicitly supplied.

The **CI (manual hosted fallback)** and **Raspberry Pi release (manual
fallback)** workflows require an explicit paid-runner confirmation. Use them
only when a suitable local machine is unavailable.
