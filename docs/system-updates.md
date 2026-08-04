# System updates

Stugu discovers versions and change notes from the configured GitHub Releases
feed. Owners and administrators manage updates in **Advanced → System**, under
**Software updates**.

The web/API process never replaces itself. It writes a bounded update request
to a shared operations directory. A separate update agent, with access to the
Docker CLI, creates a verified backup, pulls digest-pinned images from the
configured trusted GHCR namespace, recreates only the running Stugu
application services, and waits for their health checks. If the new API does
not report the requested product version, the agent restores the previous
release environment and starts the prior images again.

On a supported Raspberry Pi A/B host, the same page presents the native host
release separately from the application release. **Update everything** is a
deliberately ordered workflow:

1. create and verify a Stugu backup;
2. ask the native updater to independently select, verify, qualify, and stage
   the signed TUF + RAUC host target;
3. stop at **Restart and install** until an Owner or Admin confirms the exact
   staged operation, version, generation, and manifest digest;
4. reconnect through the trial boots and A/B probation, allowing the native
   selector to return to the previous slot automatically if checks fail;
5. only after the host is accepted, install and verify the separately bound
   application release with its existing container fallback.

A returned host, recovery-needed state, stale confirmation, failed backup,
busy mutation lock, unsupported layout, unqualified device, malformed state,
or unavailable trust metadata stops the workflow. It never falls through to an
application update. Host activation remains manual even when automatic
application updates are enabled.

The API and container update agent exchange bounded intent/status files only.
A dedicated `stugu-update-bridge` account can forward only `check`, `stage`,
`activate`, and `cancel` to the existing native Unix socket. It has no Docker
membership, network access, device access, Linux capability, RAUC command,
arbitrary path/URL field, repair flag, or recovery channel. Only the native
updater owns TUF target selection, exact-device qualification, RAUC,
inactive-slot writes, boot control, probation, and rollback. The parent,
application, and native journals remain separate and share the existing
cross-system mutation interlock.

Every installable GitHub release must attach
`stugu-release-manifest-v1.json`. The manifest binds the repository, version,
tag, updater contract `3`, Compose contract `2`, and all seven
`tag@sha256:<digest>` image references. Both the API and external agent reject
missing, mutable, cross-namespace, or incompatible manifests. A private source
repository can use a separate anonymously readable GitHub release repository by
setting `SYSTEM_UPDATE_REPOSITORY`; `SYSTEM_UPDATE_IMAGE_PREFIX` remains
independent. Private GitHub Releases are not supported because appliance
release discovery and asset reads deliberately carry no source-repository
credential.

While an update runs, the page shows the current step, elapsed time, and a
timestamped activity trail for preparation, backup, image download, service
replacement, and health verification. Status changes arrive over a live event
stream. If the API container is briefly unavailable while it is replaced, the
page keeps the last known step visible, says that it is reconnecting, and
continues automatically when the new container is healthy.

## Update choices

- **Manual** checks GitHub on the configured interval but installs only after
  an administrator chooses **Update now**.
- **Automatic** installs a newer eligible release only on one of the selected
  weekdays at the configured local time and IANA time zone.
- Preview releases are excluded unless **Include preview releases** is
  explicitly enabled.
- **Check for updates** refreshes the latest version and release notes
  immediately without installing anything.

Only an Owner or Admin can read update configuration, change the schedule, or
request an installation. Settings changes and manual installation requests are
recorded in the append-only security audit log.

## Docker host service

During guided Docker setup, explicitly choose the update-agent service. For an
existing installation, use:

```sh
npm run update-agent:service:install
```

The wizard warns before granting this authority, then installs and starts a
per-user service through Task Scheduler on Windows, systemd on Linux, or
launchd on macOS. It runs as the current Docker-authorized account, never as an
elevated system service. Remove it with:

```sh
npm run update-agent:service:uninstall
```

For a foreground session instead, run:

```sh
npm run update-agent
```

The default shared directory is `data/update-operations`. On Linux, the
installer sets `STUGA_UPDATE_OPERATIONS_GID` to the service account's primary
group and reapplies the bounded directory permissions so the API and host
agent can share it. A systemd user service starts with that user's service
manager; enable user lingering separately if the agent must run before login.
Docker access is host-administrator access.

The agent deliberately runs on the Docker Desktop host rather than in the
privileged Compose profile, preserving Windows and macOS bind-mount paths.

Rootless Docker and Podman installations instead use the
`stuga-update-operations` named volume because subordinate container IDs cannot
be made safely writable by an unrelated host process. Their supported update
path is to fetch the desired release and rerun Compose; the setup wizard
selects this mode automatically and refuses the incompatible host-agent option.

Useful overrides:

```dotenv
SYSTEM_UPDATE_REPOSITORY=liljestk/open-stuga
SYSTEM_UPDATE_IMAGE_PREFIX=ghcr.io/liljestk/open-stuga
STUGA_UPDATE_OPERATIONS_DIRECTORY=/srv/stugu/update-operations
STUGA_UPDATE_OPERATIONS_GID=1001
STUGA_UPDATE_COMPOSE_ENV_FILE=/srv/stugu/.env
STUGA_PROJECT_DIRECTORY=/srv/stugu
STUGA_FACTORY_RELEASE_ENV_FILE=/srv/stugu/release.env
STUGA_KNOWN_GOOD_RELEASE_ENV_FILE=/srv/stugu/.stugu-known-good.env
STUGA_RELEASE_ENV_FILE=/srv/stugu/.stugu-release.env
# Only if the stack was started with `docker compose --project-name stuga`:
STUGA_COMPOSE_PROJECT_NAME=stuga
```

The repository and image prefix are deployment configuration, not browser
settings. Update requests cannot override them. By default the host agent uses
the Compose project derived from `STUGA_PROJECT_DIRECTORY`, matching a normal
`docker compose up`; set `STUGA_COMPOSE_PROJECT_NAME` only for an installation
that was started with an explicit `--project-name`.

## Updater contract 3 transition

The API recognizes an older heartbeat but reports **Agent upgrade required**
and refuses to queue a contract-3 request. This prevents an old agent from
consuming a request format that it cannot validate.

On a Docker host, check out the exact Stugu tag already running, install its
dependencies, and reinstall the per-user service:

```sh
git fetch --tags
git checkout v<installed-version>
npm ci
npm run update-agent:service:install
```

The contract-3 host agent can validate an exact, trusted six-line legacy
release file as existing Docker-host rollback state. It never accepts that
mutable-tag format from the API. A contract-3 release uses an eleven-line,
seven-image, digest-pinned candidate and known-good file.

An existing Raspberry Pi image needs a one-time factory transition because its
older boot service cannot safely consume the new seven-image release file, and
a container cannot replace immutable host boot assets. A final five-image
bridge release must report **Factory upgrade required** before the first
contract-3 release. Run `stuguctl backup`, copy the verified backup off the
appliance, install a validated contract-3 factory image, and restore or migrate
the data. Writing a factory image erases the target disk. Contract 3 uses
`release-v3.env` and `known-good-v3.env`; older OS slots retain and use their
own unversioned state.

## Raspberry Pi appliance

New appliance images enable the `self-update` Compose profile. Its dedicated
agent image has Docker access and shares only the bounded request directory
with the API. The selected application release is stored on the persistent
partition and is health-checked with the same last-known-good container
fallback used at boot. Clean appliances default to stable automatic releases
on Sunday at 03:00 UTC; an Owner can change or disable that schedule.

Host staging/activation and container, storage, and migration changes share
fail-closed mutation locks. While a host journal is nonterminal, malformed, or
needs recovery, the container update agent reports itself paused and starts no
new mutation.

The appliance passes its persistent deployment environment to the update
agent's nested Compose client. Configuration, secrets, update state, and
migration state therefore remain on the shared persistent partition when
containers are recreated. Factory, last-known-good, and candidate release
environments are layered in that order, so the first backup and any rollback
cannot resolve local image defaults. The nested client is pinned to the
appliance's `stugu` Compose project so unattended updates inspect the running
services.

The unified UI path is capability-gated. New layout-v2 factory images contain
the bounded bridge, native TUF + RAUC host updater, and early-initramfs A/B root
selector. The native updater remains available through `stuguctl host-update`. It can
activate only when a signed qualification receipt matches the exact runtime Pi,
EEPROM, USB bridge, and storage fingerprint. Preview bundles must use a
byte-identical shared boot artifact and therefore update only the inactive
immutable root; kernel, firmware, EEPROM, and canonical p1 changes remain
recovery-class. The updater never writes p6 as a raw device.

An existing generation-6 image predates the host bridge. Containers cannot
install a systemd unit into its immutable root, so the first transition to the
bridge-capable host must use the audited `stuguctl host-update` CLI flow (or a
validated factory transition) and an exact-device qualification receipt. After
the accepted host restarts, the new update-agent container must advertise
`unified-host-update-v1` before **Update everything** is enabled. The UI reports
this honestly as a one-time transition; it never bootstraps host privilege from
a container.

Deployed layout-v1 appliances still require a validated factory transition:
their 96 MiB FAT fills p1 and cannot safely use layout-v2's raw boot-record
tail. Do not shrink/rebuild that FAT or bypass the qualification receipt.
Raspberry Pi Connect OS deployment remains disabled because partition handoff
was not reliable on the supported USB bridge. See the
[host release runbook](host-update-release.md) and
[architecture/gates](signed-host-updater-plan.md).

## Recovery

The latest application, host, and parent-workflow state is visible in the UI.
Its bounded projections live under `data/update-operations`; the privileged
native journal remains private to the host updater. Before changing a host or
application, the agent runs the normal verified Stugu backup. If both the new
release and automatic
rollback fail, restore the last `.stugu-release.env` values and run:

```sh
docker compose up --detach --wait api web stugu-backup-scheduler
```

Never edit a queued request to point at another registry. The agent rejects
repositories, tags, or image references outside its trusted configuration.
