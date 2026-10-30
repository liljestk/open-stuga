# Lean verification and appliance diagnosis

Use three canonical commands. They emit short terminal summaries and keep
detailed logs plus JSON receipts in the per-user Stugu tooling state directory,
outside the Git worktree. Set `STUGU_TOOLING_STATE_DIR` only to another
outside-worktree directory.

## Local verification

During development:

```sh
npm run verify:local -- --fast
```

This stops at the first failed diff, type/architecture, or affected-test check.
Before release, from the fresh release checkout:

```sh
npm run verify:local -- --full
```

Full mode invokes the existing authoritative local CI exactly once and writes a
commit- and worktree-pinned wrapper receipt. Either mode reuses a receipt only
when the commit, complete worktree, lockfile, configuration, and base hashes are
identical. It never reuses evidence by age.

## Raspberry Pi diagnosis

```sh
npm run rpi:doctor -- --target operator@stugu.local
npm run rpi:doctor -- --target operator@stugu.local --deep
npm run rpi:doctor -- --target operator@stugu.local --json
```

Default mode opens one strict, non-interactive SSH connection and is killed at
14 seconds. It collects one-shot service, container, restart, CPU/memory,
event-loop, archive/database, bounded queue, integration, updater, version, and
appliance-identity evidence. It uses `docker stats --no-stream`; it does not
read raw telemetry, credentials, or unbounded logs. The API's archive
`caughtUp` flag is instantaneous: during steady streaming every new sample
clears it until the next one-second live flush. When the first health read is
not caught up, the collector re-reads only the archive status up to four times
within the health budget. `ARCHIVE_DATABASE` warns only when no follow-up read
sees the archive caught up or its `lastSuccessAt` advance, so a small in-flight
queue passes while a sustained, stalled, or growing backlog still warns. `--deep` explicitly adds
SQLite integrity checks and bounded service and API log summaries. The queue
and integration census remains available if the separately bounded integrity
scan times out. Database evidence includes only file sizes and a fixed index
presence list. API logs cover at most 160 records from the last 24 hours;
startup stages and the last five container health probes retain only fixed
classifications, never raw errors, configuration, SQL, or response bodies.

The receipt stores hashes of the SSH selector, machine ID, and hostname, the
verified SSH host-key fingerprint, and the host updater's hardware fingerprint.
It does not store the target hostname or raw machine ID. Diagnosis is read-only;
repairs and updates remain separate, explicitly authorized operations.

## Release verification

First prepare an explicitly authorized draft with the full-CI receipt printed
by the full command:

```sh
npm run release:local -- <reviewed-build-arguments> \
  --full-ci-receipt <FULL_CI_RECEIPT> --keep-draft --publish
```

The draft preparation consumes that receipt, builds once, writes the artifact
manifest and compatibility proof, and remains a draft. It does not rerun CI.

Then create the required visual-acceptance receipt outside Git, run the doctor
against the named appliance, and verify the prepared release:

```sh
npm run release:verify -- \
  --target operator@stugu.local \
  --target-receipt <DOCTOR_RECEIPT> \
  --visual-receipt <VISUAL_RECEIPT> \
  --channel preview
```

The verifier requires the exact clean-worktree full-CI receipt; validates the
artifact manifest and host compatibility proof; checks the visual evidence and
screenshot hashes; checks the target identity and application-release readiness; and anonymously inspects
each digest-addressed image index plus both AMD64 and ARM64 manifests,
descriptor closure, and source-commit provenance. It never builds, reruns CI,
publishes, or connects to the appliance.

Every appliance health check must pass, except a single `UPDATER` warning for
`TRUST_VERIFICATION_FAILED` or `METADATA_FETCH_FAILED`. That exception requires
a fresh doctor receipt with structured evidence of an available host updater,
failed feed check, no host journal, and no pending rollback or recovery. Older
warning receipts without this evidence are rejected. The doctor continues to
report `attention`, and signed host updates remain blocked. This exception
applies only to the container application publisher, never host publication,
staging, activation, or signature verification.

After separate authorization to publish, consume its receipt:

```sh
npm run release:local -- --repository <PUBLIC_FEED> \
  --verification-receipt <RELEASE_VERIFY_RECEIPT> --publish
```

Finalization accepts only a fresh verification receipt, checks the draft asset
digests, uploads that receipt, and anonymously rechecks every version tag,
platform manifest, and source provenance immediately before changing the
existing draft's visibility/channel. It does not rebuild or rerun CI.

The legacy Raspberry Pi Connect helper is disabled unless the release receipt
also binds its exact artifact hash, HTTPS URI, Connect device UUID, and SSH
target. Supply all three `release:verify` deployment options to create that
optional binding; the deploy helper consumes it through
`RPI_RELEASE_VERIFICATION_RECEIPT` and `RPI_OTA_TARGET_SELECTOR` and does not
repeat release verification.

## Visual-acceptance receipt

The receipt schema is `stugu-visual-acceptance/v1`. Follow the complete blocking
contract in `DESIGN.md`. Screenshot paths are relative to the receipt directory,
and every screenshot hash is SHA-256. A rendered web change needs, at minimum,
passed 320 px and 1440 px scenarios in both light and dark themes; record all
additional changed states, breakpoints, workflows, and accessibility checks the
design contract requires.

For a change that cannot affect a rendered screen, use `result:
"not-applicable"`, `renderedScreenChanges: false`, a concrete `reason`, and an
empty `scenarios` array. Obvious web/native source changes cannot use that form.

## Failure contract

Every canonical command reports one stable code, one cause, one suggested next
command/action, and one detailed-log path:

```text
FAIL <STABLE_CODE>
Cause: <concise cause>
Next: <one action or command>
Log: <outside-Git path>
```

Fix the first failure and rerun the same canonical command. Do not copy private
diagnostics into Git or chat.
