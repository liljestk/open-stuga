# Local CI and release publishing

GitHub-hosted CI is paused while the repository is private. Pushes and pull
requests do not start Actions or consume hosted-runner minutes. The two hosted
workflows remain available only as manually confirmed fallbacks.

## Prepare this computer

Install Node.js 22.22.2 or newer, Python 3.13, and Docker Desktop. Stugu itself
runs on Node 22.13+, but the gate's web tests use jsdom 30, which needs 22.22.2+.
Then install the locked dependencies:

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

## When the gate fails for environmental reasons

Before investigating a failure as a code defect, confirm it reproduces on an
unmodified checkout of `origin/main`. A worktree detached at `origin/main` and
the same single test file is usually enough, and it separates "my change broke
this" from "this machine cannot run this check" in one step.

Known environmental failures:

- **Every backup, restore-drill, or checkpoint test fails with "Could not
  identify the Windows account for a private ACL."** The tooling needs the real
  `whoami.exe`. Shells that place their own coreutils first on PATH — MSYS, Git
  Bash — supply a `whoami` that rejects `/user`. Resolution through `SystemRoot`
  makes this shell-independent, so a recurrence means a new caller is invoking a
  System32 tool by bare name.
- **A container step fails immediately with "failed to connect to the docker
  API ... dockerDesktopLinuxEngine."** Docker Desktop is not running. The engine
  is a precondition of the gate, not something it starts.
- **The run ends with "already exists with different content."** A receipt for
  this version is already on disk from an earlier, different run. Move the stale
  receipt and its `.sha256` aside — keep it rather than deleting it, since a
  failed receipt is evidence — and rerun.

A receipt is bound to the exact commit, worktree, lockfile, configuration, and
base hashes it was produced from. A receipt from a feature branch cannot publish
the merge commit that lands it, so the release gate must run in the checkout
that will actually be published, after the merge.

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
