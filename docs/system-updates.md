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

## Docker Desktop on Windows or macOS

Start the application normally, then run the update agent from the repository
root in a host terminal:

```powershell
npm run update-agent
```

The default shared directory is `data/update-operations`. Keep the agent
running as a background service if automatic installation is enabled. The
agent uses the host's existing Docker Desktop CLI and Compose project, which
keeps Windows bind-mount paths intact.

## Docker Engine on Linux

The same host process works on Linux:

```sh
npm run update-agent
```

For a long-running installation, supervise it with systemd or another process
manager. Run it as an account that is deliberately authorized to manage this
Compose project. Set `STUGA_UPDATE_OPERATIONS_GID` in `.env` to that account's
numeric `id -g` before starting Compose, so the API and host agent share the
setgid operations directory. Docker access is host-administrator access.

Useful overrides:

```dotenv
SYSTEM_UPDATE_REPOSITORY=liljestk/open-stuga
SYSTEM_UPDATE_IMAGE_PREFIX=ghcr.io/liljestk/open-stuga
STUGA_UPDATE_OPERATIONS_DIRECTORY=/srv/stuga/update-operations
STUGA_UPDATE_OPERATIONS_GID=1001
STUGA_PROJECT_DIRECTORY=/srv/stuga
STUGA_RELEASE_ENV_FILE=/srv/stuga/.stuga-release.env
```

The repository and image prefix are deployment configuration, not browser
settings. Update requests cannot override them.

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
