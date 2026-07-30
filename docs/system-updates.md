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

Every installable GitHub release must attach
`stugu-release-manifest-v1.json`. The manifest binds the repository, version,
tag, updater contract `2`, Compose contract `1`, and all five
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

## Updater contract 1 to 2

The API recognizes a fresh contract-1 heartbeat but reports **Agent upgrade
required** and refuses to queue a contract-2 request. This prevents an old
agent from consuming a request format that it cannot validate.

On a Docker host, check out the exact Stugu tag already running, install its
dependencies, and reinstall the per-user service:

```sh
git fetch --tags
git checkout v<installed-version>
npm ci
npm run update-agent:service:install
```

The contract-2 host agent can validate an exact, trusted six-line contract-1
release file as existing rollback state. It never accepts that mutable-tag
format from the API. The first successful contract-2 update replaces it with a
digest-pinned nine-line candidate and known-good file; a failed first update
restores the original six-line text exactly.

An existing Raspberry Pi image needs a one-time factory transition. Its
contract-1 boot service cannot safely consume the new nine-line release file,
and a container cannot replace those immutable host boot assets. After the
bridge release is installed by the old updater, reboot once to start its
contract-2 agent. The UI then reports **Factory upgrade required** and no
further container update is queued. Run `stuguctl backup`, copy the verified
backup off the appliance, install a validated contract-2 factory image, and
restore or migrate the data. Writing a factory image erases the target disk.
The new boot service preserves old six-line candidate state as
`release.env.legacy-v1` and leaves `/persistent/stugu/last-known-good.env`
untouched for an old-OS rollback; it never executes those mutable tags.

## Raspberry Pi appliance

New appliance images enable the `self-update` Compose profile. Its dedicated
agent image has Docker access and shares only the bounded request directory
with the API. The selected application release is stored on the persistent
partition and is health-checked with the same last-known-good container
fallback used at boot. Clean appliances default to stable automatic releases
on Sunday at 03:00 UTC; an Owner can change or disable that schedule.

The appliance passes its persistent deployment environment to the update
agent's nested Compose client. Configuration, secrets, update state, and
migration state therefore remain on the shared persistent partition when
containers are recreated. Factory, last-known-good, and candidate release
environments are layered in that order, so the first backup and any rollback
cannot resolve local image defaults. The nested client is pinned to the
appliance's `stugu` Compose project so unattended updates inspect the running
services.

The UI-managed path updates Stugu's release containers. Full operating-system,
kernel, and firmware changes require a newly validated factory image and a
backup or migration. Raspberry Pi Connect OS deployment is disabled for Pi 4
USB because partition handoff was not reliable on the supported USB bridge.
This separation lets the same UI and GitHub release policy work on Docker
Desktop, ordinary Docker Engine, and the appliance without giving the
application container root or Docker access.

## Recovery

The latest state is visible in the UI and in
`data/update-operations/status.json`. Before changing images, the agent runs
the normal verified Stugu backup. If both the new release and automatic
rollback fail, restore the last `.stugu-release.env` values and run:

```sh
docker compose up --detach --wait api web stugu-backup-scheduler
```

Never edit a queued request to point at another registry. The agent rejects
repositories, tags, or image references outside its trusted configuration.
