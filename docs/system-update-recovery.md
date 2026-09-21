# Raspberry Pi system-update recovery

Use this runbook when a Stugu Raspberry Pi reports an **unsupported safety
state**, an application-only update is hidden or blocked, or an update appears
complete but the recorded release is stale. It documents the recovery used on
28 August 2026 and turns it into a reusable, fail-closed procedure.

This is not a general host-update bypass. Diagnosis is read-only. A backup,
queued application request, service restart, host stage, or host activation is
a separate mutation and requires explicit authorization for the named
appliance and exact action.

## Safety boundary

The narrow benign state in the original incident was:

```text
native phase: failed
native errorCode: UPDATE_NOT_FOUND
doctor UPDATER check: pass
doctor summary: Host updater checked successfully; no newer signed target is available.
```

For the native updater, this exact pair means TUF found no eligible signed host
target. The native coordinator persists the check result as `failed`, but there
is no host release to install and no host recovery to perform. The doctor
deliberately treats only this exact pair as a pass.

Do not generalize that exception to an arbitrary native `failed` phase. Current
source also recognizes `TRUST_VERIFICATION_FAILED` and
`METADATA_FETCH_FAILED` as **feed-scoped** warnings: signed host updates pause,
but application-only updates remain available through the supported UI/API
because containers do not consult TUF. Machine trust faults, rollback,
recovery-needed, timeout, malformed state, active journals, qualification,
disk-layout, and hardware-identity failures remain real stops. Preserve their
evidence and follow the signed-host runbook or the doctor's single next action.

Keep these trust domains separate:

- An application update uses the public GitHub release manifest and seven
  digest-pinned GHCR image references. The manifest is identity- and
  contract-bound, but it is not a signed TUF target.
- A host update uses signed TUF metadata, a signed RAUC bundle, exact-device
  qualification, trial boots, and native rollback. Never stage or activate a
  host update merely to clear this UI message.

Never hand-edit any of the following:

- `/persistent/stugu/release-status`;
- `release-v3.env` or `known-good-v3.env`;
- a queued request, update journal, workflow journal, host journal, or bridge
  projection;
- TUF metadata, RAUC state, boot state, or a hardware qualification receipt.

Do not call RAUC directly, relax SSH host-key checking, copy private appliance
diagnostics into Git, or use `docker compose down -v`.

## Incident record: 28 August 2026

The affected appliance is intentionally not identified in Git. Its private SSH
selector, identity evidence, receipt paths, backup path, and backup digest were
kept outside the worktree.

| Evidence | Observed value |
| --- | --- |
| UI message | `The updater reported an unsupported safety state. Check again or review advanced details.` |
| Host release | `0.35.7` |
| Application before recovery | `0.39.2` |
| Recorded release before recovery | `0.39.2` |
| Public application target | stable `0.39.4` |
| Host target | none |
| Application after recovery | `0.39.4` |
| Recorded release after reconciliation | `0.39.4` |
| Final doctor | 11 pass, 0 warning, 0 fail |
| Host activation or reboot | none |

The root cause was a projection/UI disagreement:

1. The native TUF lookup found no eligible host target and recorded
   `phase=failed`, `errorCode=UPDATE_NOT_FOUND`.
2. Stugu 0.39.2 exposed that raw uppercase code through the API.
3. The web page did not recognize the value and used its unknown-reason text,
   producing the unsupported-safety-state message.
4. The same page treated any host reason as blocking, so it hid the otherwise
   independent application-only update.
5. The doctor correctly classified the exact native pair as a pass, revealing
   that the UI block did not represent a host safety failure.

Version 0.39.4 normalizes known native reasons into clearer application-facing
reasons, but still lets a host-feed reason block the application action. The
complete fix is in source version 0.40.0: feed-scoped host reasons remain
visible but do not block an application-only OTA. As of 30 August 2026, 0.39.4
was still the latest published stable release and 0.40.0 was merged but not
published. Always recheck current public state; do not reuse that dated
assumption.

## Recovery procedure

### 1. Start from current, clean tooling

Use a clean checkout containing `scripts/rpi-doctor.mjs`. Read `AGENTS.md`,
`CLAUDE.md`, `DESIGN.md`, this runbook, and
`docs/host-system-monitoring.md`. If the shared checkout lacks the doctor, use a
current clean checkout; do not recreate its SSH collection with ad-hoc
commands.

Run the bounded default doctor first:

```sh
npm run rpi:doctor -- --target <USER@HOST>
```

Do not add `--deep` unless the operator explicitly requests the bounded logs
and integrity checks. Preserve the printed receipt, adjacent `.sha256`, and
detailed-log path outside Git. Do not reconstruct a receipt.

The incident baseline was healthy: 11 pass, 0 warning, 0 fail. Its version
summary was host 0.35.7, application 0.39.2, recorded release 0.39.2. Although
the raw native updater state was `failed`, the doctor `UPDATER` check passed
with the no-newer-signed-target explanation.

Stop unless all ordinary health checks pass or the only reported condition is
separately understood and irrelevant to the authorized recovery. The UI text
alone is never evidence that `UPDATE_NOT_FOUND` is present.

### 2. Verify the current public application target

The word **latest** is time-sensitive. Query the public feed immediately before
the update and again before reporting completion. For the stable channel:

```sh
gh api repos/liljestk/stugu-releases/releases/latest \
  --jq '{tag_name, published_at, html_url, draft, prerelease}'
```

Download `stugu-release-manifest-v1.json` from that exact published release into
a new temporary audit directory. Verify all of the following against the
current appliance configuration and current source contract:

- schema `stugu-release-manifest/v1`;
- repository `liljestk/stugu-releases`;
- exact version and `v<version>` tag;
- updater contract `3` and Compose contract `2`;
- exactly the seven keys `api`, `web`, `backup`, `tapo`, `updateAgent`, `mqtt`,
  and `nexus433`;
- every reference uses the configured
  `ghcr.io/liljestk/open-stuga-<component>` namespace, exact version tag, and
  `@sha256:<64 lowercase hex>` digest;
- the installed version exactly matches the request's `previousVersion`;
- the release is public and its stable/preview state matches the appliance's
  configured channel.

For the incident, stable 0.39.4 was published on 26 August 2026. The downloaded
manifest SHA-256 was
`e356b8c4c65e0b5fbd18121a4840139f814726dd98b542ab1b90f15c2b490900`.
That digest is historical evidence only; never use it to approve another
release.

Do not describe this application manifest as signed. Do not substitute a draft,
source-repository release, mutable image tag, different GHCR namespace, or a
manifest copied from an earlier incident.

### 3. Create an operator-visible verified backup

After explicit authorization, run the supported backup separately from
diagnosis:

```sh
ssh <USER@HOST> stuguctl backup
```

Record its verified result, manifest, byte count, and SHA-256 outside Git. Copy
it off-device when the release impact warrants it. The incident backup
completed successfully; all identifying evidence and data-size details are
intentionally omitted here.

The application update agent will still create and verify its own pre-update
backup. The separate operator backup is additional recovery evidence, not a
replacement for the agent's safety gate.

### 4. Prefer the supported app-only request path

On a release with the corrected UI, use **Advanced -> System -> Update now**.
The authenticated API request path is also preferred because it performs the
current race checks and writes both the queued status and request using the
current contract.

An application-only request may queue only when all of these remain true:

- the fresh update-agent heartbeat is compatible, reports runtime
  `raspberry-pi`, contract `3`, and `ready: true`;
- no application update, storage change, migration, or Docker mutation is
  active;
- there is no nonterminal unified workflow, pending workflow request,
  `agent.lock`, `update-journal.json`, storage journal, or application request;
- the native status has no active/recovery workflow or journal; a current
  release may expose either the benign no-target result or an explicitly
  feed-scoped warning while keeping app-only OTA available;
- the bounded bridge is available, has no request in flight, and agrees with
  the native projection;
- the configured public repository and GHCR prefix match the downloaded
  manifest;
- the exact running API version, candidate/known-good state, and requested
  `previousVersion` agree;
- the current manifest passes every identity, compatibility, namespace, and
  digest check from the previous section.

Re-read these conditions immediately before queueing. Any changed, missing,
malformed, or ambiguous state is a stop, not permission to repair a file.

### 5. Historical direct queueing used in this incident

The old UI was blocked and no authenticated browser session was available. With
explicit authorization to update the named appliance to 0.39.4, a single
application request was therefore queued directly in
`/persistent/stugu/update-operations`.

This was an incident-specific operator action, not a supported reusable
interface. The script is not tracked or tested in this repository, and the
request contract can change. Do not recreate it from this prose. If the current
UI/API cannot queue a safe app-only update, stop and add a reviewed, tested
canonical helper before repeating direct file publication.

For the historical record, the script re-read every prerequisite immediately
before publication; derived the contract-3 request from the freshly downloaded
manifest; bound a new UUID, current UTC time, exact target and previous
versions, public repository, compatibility contracts, and all seven immutable
image references; then created only one new request file with same-directory
temporary-file, `fsync`, atomic-rename, and directory-`fsync` semantics. It did
not alter `status.json`, native or bridge state, release environments,
journals, or `release-status`. The external agent independently revalidated the
request before doing any mutation.

### 6. Let the update agent own the mutation

The normal agent performed this sequence:

1. verified the current release environment and exact running API version;
2. wrote a durable rollback journal;
3. created and verified its own pre-update backup;
4. atomically wrote the candidate `release-v3.env`;
5. pulled only the seven digest-pinned target images;
6. recreated the active application services with Compose health waits;
7. required the new API to report the exact target version;
8. durably committed `known-good-v3.env`;
9. marked the operation `complete` and removed request/journal state.

The observed phases were:

```text
backup -> pulling -> applying -> verifying -> complete
```

The agent's backup took materially longer than the earlier operator backup.
Basic process sampling showed active CPU/disk work and ample free persistent
storage, so it was left uninterrupted. A slow verified backup is not itself a
stall. Do not kill it because an earlier backup happened to be faster.

As of 0.41.3, application and unified-workflow backups use the same bounded
24-hour allowance as storage-move backups. Other container commands retain
their 45-minute limit. Older agents can time out while the backup container
continues running; that leaves a deliberately blocking `termination-uncertain`
journal. Do not retry, remove the journal, or replace services until the backup
has stopped and its result, unchanged prior release, and idle mutation state
have been independently established. Preserve the failure evidence during
operator recovery. A newer release cannot fix the already-running old agent
until its updater image has been safely bootstrapped under operator control.

Before the known-good commit, an ordinary failure restores the previous release
environment and starts the prior services. If a Docker mutation times out or
cannot be proven quiescent, the agent deliberately blocks automatic rollback
and retains the journal for manual reconciliation. Never delete that journal
to make the UI quiet.

No host bundle was staged, no host activation was requested, and the appliance
was not rebooted during this application update.

### 7. Reconcile a stale release marker only through the service

After the agent reported `complete`, the API correctly reported 0.39.4 but
`/persistent/stugu/release-status` still recorded 0.39.2. The first post-update
doctor therefore failed `VERSIONS`; the archive was also briefly syncing after
container replacement.

This mismatch has split writers:

- the live application update agent commits `release-v3.env`,
  `known-good-v3.env`, and operation status, but does not write
  `release-status`;
- root `stugu.service` runs `/usr/local/sbin/stugu-compose-start`, which selects
  and validates the v3 release, reconciles containers with health waits, copies
  known-good state, and writes `version=<version>` plus `healthy_at=<UTC>` to
  `release-status`.

Do not hand-edit the marker. It is health evidence used by other safety gates.

The supported reconciliation is:

```sh
ssh <USER@HOST> stuguctl restart
```

Run it only after proving all of the following:

- application operation status is terminal `complete` for the exact target;
- the health endpoint reports the exact target version;
- candidate and known-good v3 release files both validate and identify that
  target;
- the application request, `agent.lock`, and update journal are gone;
- no host, storage, migration, or Docker mutation is active.

`stuguctl restart` restarts and health-checks the application service; it does
not reboot the host. Expect a brief application interruption. In the incident
it completed successfully, and the monitor then observed application 0.39.4
plus recorded release 0.39.4.

If it fails, preserve state and inspect the bounded next action and
`stuguctl system-log`. Do not force the marker, delete a journal, or start an
unrelated host update.

### 8. Verify and close

Run the canonical default doctor again:

```sh
npm run rpi:doctor -- --target <USER@HOST>
```

For this incident the final receipt reported:

- 11 pass, 0 warning, 0 fail;
- host 0.35.7;
- application 0.39.4 and recorded release 0.39.4;
- eight containers, none unexpectedly stopped or unhealthy, zero restarts;
- archive `ready`, caught up, with no queued samples or dirty rows;
- updater pass: no newer signed host target.

Verify the adjacent receipt checksum and keep both outside Git. Requery the
public release feed before claiming the installed application is still latest.
If a newer eligible release appeared during recovery, report the exact installed
and latest versions and request a new decision; do not silently chain another
update.

## Decision table

| Evidence | Interpretation | Action |
| --- | --- | --- |
| Native `failed` + `UPDATE_NOT_FOUND`; doctor `UPDATER` pass | No eligible signed host target | App-only recovery may be evaluated against every prerequisite above |
| `TRUST_VERIFICATION_FAILED` or `METADATA_FETCH_FAILED`; doctor feed-scoped warning | Host feed trust is unavailable, but application containers do not use TUF | Pause host updates; a current release may perform app-only OTA through the supported UI/API after ordinary app checks |
| Host `staged`, activating, returned, recovery-needed, or nonterminal journal | Real host workflow or recovery state | Stop; use `docs/host-update-release.md` and preserve the native journal |
| Agent missing, incompatible, not ready, or contract below 3 | App updater cannot safely consume the request | Stop; upgrade the supported agent or perform the documented factory transition |
| App operation `failed` or `rolling-back` | Candidate did not commit cleanly | Let rollback settle, preserve state, and rerun the doctor; do not queue another request |
| App operation `complete`, API target version, stale `release-status` | Service health marker was not refreshed | After the exact idle checks, use `stuguctl restart`; never edit the marker |
| Running API, v3 environments, and recorded release disagree | Ambiguous release state | Stop and preserve evidence; do not infer which file is authoritative |

## Claude/operator checklist

Before acting, Claude or another agent must be able to answer **yes** to every
applicable item:

- I read the repository instructions and this runbook from a current clean
  checkout.
- The operator explicitly authorized the named appliance and each mutation I
  am about to perform.
- I ran the default doctor first and preserved its receipt/checksum outside
  Git.
- I did not infer the native error from the UI message; I proved whether it is
  the exact no-target pass, an explicitly feed-scoped warning, or a real host
  fault.
- I independently verified the current public release and exact seven-image
  digest manifest.
- I proved the agent, workflow, journals, locks, running version, repository,
  image namespace, and rollback state agree.
- I created a verified backup and retained its receipt.
- I use the supported UI/API request path. I will not reproduce the historical
  direct writer unless a reviewed, tested canonical helper is added first.
- I am allowing the update agent to own backup, pull, apply, verification,
  commit, and rollback.
- I will use `stuguctl restart` only for a proven post-commit stale marker and
  never edit health evidence.
- I will finish with another default doctor, checksum verification, and a fresh
  public-release query.

If any answer is no or ambiguous, stop and report the exact missing evidence or
authority.

## Source landmarks

Use current source rather than line numbers copied from this incident:

- `scripts/rpi-doctor.mjs` and `docs/lean-tooling.md` — bounded diagnosis and
  receipt contract;
- `deploy/rpi/host-updater/stugu_host_updater/repository.py` — distinction
  between no target and trust verification failure;
- `apps/api/src/system-update-reasons.ts` — canonical host/feed reason mapping;
- `apps/api/src/system-updates.ts` — app-only queue checks and request builder;
- `apps/web/src/pages/SystemUpdateOverview.tsx` and `SystemUpdatesPage.tsx` —
  displayed safety state and action routing;
- `scripts/stugu-update-agent/configuration-request.mjs` — request, repository,
  contract, namespace, and digest validation;
- `scripts/stugu-update-agent/update-loop.mjs` — backup, apply, verification,
  commit, rollback, and journal boundaries;
- `deploy/rpi/assets/stugu-compose-start`, `stuguctl`, and `stugu.service` —
  application reconciliation and `release-status` writer;
- `docs/system-updates.md`, `docs/release-cycle.md`, and
  `docs/host-update-release.md` — application, release, and signed-host trust
  boundaries.
