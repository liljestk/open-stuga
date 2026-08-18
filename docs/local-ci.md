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
npm run verify:local -- --full
```

The gate checks the release version, architecture and types, Python lint and
formatting, JavaScript/TypeScript and Python coverage, operational tooling,
the application build, Compose configuration, every production Docker target,
and the built API smoke test. On macOS it also runs Swift tests and unsigned
iOS and Mac Catalyst builds. Those native Apple checks are unavailable on
Windows and Linux and are recorded as such.

On Windows the gate is shell-independent: tooling that needs System32
utilities (`whoami.exe`, `icacls.exe`) resolves them through `SystemRoot`
rather than PATH, because MSYS and Git Bash shells put their own `whoami`
first and it rejects Windows arguments. Docker Desktop must be running before
the gate starts; the container steps fail immediately when its named pipe is
absent.

A machine-readable wrapper receipt, the underlying authoritative CI evidence,
their checksums, and detailed logs are written to the per-user Stugu tooling
state directory outside Git. The wrapper is reused only for the exact commit,
worktree, lockfile, configuration, and base hashes. Build output remains ignored
locally; source code is pushed with Git:

```sh
git push origin HEAD
```

Use `npm run verify:local -- --fast` for the diff, architecture/type checks, and
affected tests while iterating. Useful authoritative-CI options remain available
through direct `ci:local` maintenance/debugging:

- `--base-ref REF` selects the version-comparison ref.
- `--skip-container-builds` is for explicit CI debugging only; a release full-CI
  receipt must come from the complete gate.
- `--with-sonar` optionally submits the already-generated coverage reports.

## Publish release artifacts

Draft preparation consumes the full receipt without rerunning CI:

```sh
npm run release:local -- --ssh-public-key PATH --full-ci-receipt PATH --keep-draft --publish
```

It pushes the AMD64/ARM64 images to GHCR, builds the Raspberry Pi artifacts,
writes the compatibility proof, and leaves a GitHub draft. Final publication
requires and consumes a matching `release:verify` receipt. The factory image
remains local unless `--upload-factory` is explicitly supplied.

Without `--publish`, the command prints a plan only; it does not run CI or
validate tags, credentials, input files, or artifacts. `--keep-draft --publish`
still pushes the container tags before leaving the GitHub release as a draft;
the publisher refuses to make it public without `--verification-receipt`.
Follow the complete [application release cycle](release-cycle.md) for the
private-source/public-feed tags, channel decision, operator context, audit, and
appliance verification.

The **CI (manual hosted fallback)** and **Raspberry Pi release (manual
fallback)** workflows require an explicit paid-runner confirmation. Use them
only when a suitable local machine is unavailable.
