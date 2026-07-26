# System updates

Stuga discovers versions and change notes from the public
[`liljestk/open-stuga` GitHub Releases](https://github.com/liljestk/open-stuga/releases)
feed. Owners and administrators manage updates at **Advanced → System
updates**.

The web/API process never replaces itself. It writes a bounded update request
to a shared operations directory. A separate update agent, with access to the
Docker CLI, creates a verified backup, pulls the release-tagged images from the
configured trusted GHCR namespace, recreates only the running Stuga
application services, and waits for their health checks. If the new API does
not report the requested product version, the agent restores the previous
release environment and starts the prior images again.

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
STUGA_UPDATE_OPERATIONS_DIRECTORY=/srv/stuga/update-operations
STUGA_UPDATE_OPERATIONS_GID=1001
STUGA_PROJECT_DIRECTORY=/srv/stuga
STUGA_RELEASE_ENV_FILE=/srv/stuga/.stuga-release.env
# Only if the stack was started with `docker compose --project-name stuga`:
STUGA_COMPOSE_PROJECT_NAME=stuga
```

The repository and image prefix are deployment configuration, not browser
settings. Update requests cannot override them. By default the host agent uses
the Compose project derived from `STUGA_PROJECT_DIRECTORY`, matching a normal
`docker compose up`; set `STUGA_COMPOSE_PROJECT_NAME` only for an installation
that was started with an explicit `--project-name`.

## Raspberry Pi appliance

New appliance images enable the `self-update` Compose profile. Its dedicated
agent image has Docker access and shares only the bounded request directory
with the API. The selected application release is stored on the persistent
partition, survives A/B slot changes, and is health-checked with the same
last-known-good container fallback used at boot.

The UI-managed path updates Stuga's release containers. Full operating-system,
kernel, and firmware updates remain signed A/B artifacts delivered through
Raspberry Pi Connect as described in
[Raspberry Pi 4 appliance](raspberry-pi-appliance.md). This separation lets the
same UI and GitHub release policy work on Docker Desktop, ordinary Docker
Engine, and the appliance without giving the application container root or
Docker access.

## Recovery

The latest state is visible in the UI and in
`data/update-operations/status.json`. Before changing images, the agent runs
the normal verified Stuga backup. If both the new release and automatic
rollback fail, restore the last `.stuga-release.env` values and run:

```sh
docker compose up --detach --wait api web stuga-backup-scheduler
```

Never edit a queued request to point at another registry. The agent rejects
repositories, tags, or image references outside its trusted configuration.
