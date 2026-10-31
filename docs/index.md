# Stugu documentation

Stugu is a local-first digital twin for indoor climate across one or more
homes. These guides cover installing it, connecting devices, using the app,
the models behind the analytics, running it day to day, and developing and
releasing it. The [README](../README.md) has screenshots and an overview, and
[Architecture](architecture.md) shows how the parts fit together.

## Get started

- [Install and run](getting-started.md): guided local, Docker, Podman and
  Raspberry Pi setup, demo data, configuration, backup and uninstall.
- [Raspberry Pi 4 appliance](raspberry-pi-appliance.md): one-time USB disk
  installation, immutable system images, persistent data and automatic,
  health-checked application releases.
- [Architecture](architecture.md): deployment, runtime view, data flow,
  storage model, analytics pipeline, module boundaries and workspace packages.
- [Security, privacy and retention](security-privacy.md): the deployment
  boundary, secrets, network and data controls, retention, backups and
  incident response. Read it before binding the web port beyond loopback.
- [Known limitations](known-limitations.md): correctness and operational
  limits to review before relying on physical data or notifications.

## Connect devices and data

- [Direct TP-Link H100/H200/H500](tp-link-direct.md): poll T310/T315 climate
  sensors, T110 contact sensors and energy plugs on the LAN without Home
  Assistant.
- [Home Assistant](home-assistant.md): use the official TP-Link integration as
  an alternative or failover ingestion path.
- [Local Tuya Wi-Fi devices](tuya-local.md): verified local control and
  measured power for supported lamps, outlets and switches.
- [Gree/Wilfa heat pumps](gree-direct.md): read compatible air-source heat
  pumps locally or through EWPE Smart and place them in the 2D/3D Home.
- [Nexus433 integration](nexus433-integration-plan.md) and its
  [runtime decision](nexus433-runtime-decision.md): 433 MHz thermometers
  through a GPIO receiver and a private MQTT broker on the Pi appliance.
- [Automated Tapo history recovery](tapo-history-automation.md): the optional,
  canary-gated Android export for gaps beyond the hub's retention.
- [Outdoor weather and home location](weather.md): location discovery,
  FMI/Open-Meteo observations, forecasts, warnings, provenance, caching and
  map privacy.
- [Electricity prices and contracts](electricity-prices.md): price sources,
  dated tariffs, hourly costs, bill check, the 30-day projection and optimizer
  savings.

## Use the app

- [Properties and Guest access](property-management.md): Properties, Homes,
  drawn areas, equipment, notes and read-only Guest grants.
- [Equipment tracking](equipment-tracking.md): profile-driven location
  evidence for Property equipment.
- [Manual observations](observations.md): observed versus recorded time,
  precision, provenance, confidence, revisions and conflicts.
- [Activity and maintenance work](maintenance.md): Home Activity, quick
  evidence capture and a Property work plan with verification history.
- [Apple Notes bridge and Telegram alerts](apple-notes-telegram.md): Telegram
  bot pairing and per-rule delivery, plus revocable iOS Shortcut grants.
- [Claude and ChatGPT](assistants.md): connect an AI assistant with one URL
  and an Owner/Admin approval, then ask about your Homes on the web, on your
  phone or by voice.
- [ChatGPT and voice](chatgpt.md): the focused read-only MCP profile and the
  private Secure MCP Tunnel for installations without a public address.
- [API, MCP and integrations](integrations.md): v1 and v2 REST and SSE, MCP
  tools, alert webhooks and adapter guidance. The
  [API testing catalogue](testing/api-endpoint-combinations.md) lists endpoint
  combinations, input cases and workflows.
- [Stuguby federation](stuguby.md): connecting independently run Stugu
  installations around a shared property.
- [Private bug reports](bug-reports.md): the in-app **Report a bug** flow and
  its redacted diagnostics.

## Analytics and models

- [Analytics foundation and Explorer](analytics-foundation.md): the query
  contract, aggregation rules, daily findings, Home performance checks and
  appliance diagnostics.
- [Effective room thermal simulation](thermal-simulation.md): outdoor
  boundaries, calibration, residuals, scenarios and interpretation limits.
- [Sensor-constrained indoor flow](airflow-simulation.md): the shared 2D/3D
  buoyancy and pressure-projection estimate and its limits.
- [Experimental spatial-layer engine](spatial-layer-engine.md): local,
  failure-isolated backend inference and renderer-neutral snapshots.
- [Predictive maintenance](predictive-maintenance.md): supported hypotheses,
  uncertainty, validation and safety limits.

## Operate and recover

- [Backend storage and operations](backend-storage.md): SQLite durability,
  TimescaleDB telemetry, caching, migration, backup and restore.
- [Encrypted Cloudflare R2 backups](cloudflare-r2-backups.md): optional
  off-site copies encrypted on the node.
- [System updates](system-updates.md): release discovery, maintenance windows,
  the update agent, health checks and rollback.
- [Raspberry Pi system-update recovery](system-update-recovery.md): diagnosis
  and recovery for unsupported updater safety states and blocked
  application-only updates.
- [Host system monitoring](host-system-monitoring.md): CPU, memory, storage,
  temperature, strain alerts and Prometheus scraping.
- [Live system migration](live-migration.md): moving a running Compose install
  to an appliance with seed, cutover and rollback.
- [Cloudflare Tunnel and Access](cloudflare-access.md): optional,
  operator-owned remote entry and the Stuguby coordinator path.

## Develop and release

- [Contributing](../CONTRIBUTING.md): development setup, quality gates and
  pull requests.
- [Versioning](versioning.md): pre-1.0 compatibility and the per-pull-request
  version bump.
- [Local CI and release publishing](local-ci.md): the authoritative
  `verify:local -- --full` gate on a development computer.
- [Lean verification and appliance diagnosis](lean-tooling.md): the canonical
  commands and their receipts.
- [Application release cycle](release-cycle.md): merge, tags, local build,
  draft, channel, verification and appliance handoff, with the
  [release operator context template](release-operator-context-template.md).
- [Source file modularization](source-file-modularization.md): the file-size
  policy and how modules are split by domain.
- [Design principles](../DESIGN.md): the product and interface design rules.
- [Changelog](../CHANGELOG.md): what changed in each release.

## Plans, reviews and incident records

These record decisions and investigations at a point in time. Each one states
its status and date; the guides above describe current behaviour.

- [Modular roadmap](roadmap.md)
- [Simple view plan](simple-view.md)
- [Analytics and frontend data rewrite plan](analytics-frontend-rewrite-implementation-plan.md)
- [Lossless telemetry scale plan](telemetry-scale-plan.md)
- [Signed Raspberry Pi host updater](signed-host-updater-plan.md), its
  [implementation review](host-updater-implementation-review.md),
  [hardware handoff](host-updater-hardware-handoff-2026-08-02.md) and
  [host-update release runbook](host-update-release.md)
- [Raspberry Pi 4 SSD boot incident, 2026-07-29](rpi4-ssd-boot-incident-2026-07-29.md)
- [Premium redesign UX review, 2026-08-01](ux-reviews/2026-08-01-stugu-premium-redesign/README.md)
  and [electricity audit, 2026-09-28](ux-reviews/2026-09-28-electricity-audit.md)
- Release notes for [0.29.0](release-notes-v0.29.0.md) to
  [0.41.7](release-notes-v0.41.7.md); later releases are in the
  [changelog](../CHANGELOG.md).

## Reference configuration

- [`config/home-assistant.entities.example.json`](../config/home-assistant.entities.example.json)
  maps the ten sample sensor IDs to example Home Assistant entities.
- [`config/tp-link.devices.example.json`](../config/tp-link.devices.example.json)
  shows the direct hub-child-to-sensor mapping format.
- [`docker-compose.yml`](../docker-compose.yml) and [`Dockerfile`](../Dockerfile)
  define the web, API, TimescaleDB, backup and optional profile services.
