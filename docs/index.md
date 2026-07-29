# Stugu documentation

Start here:

1. [Install and run](getting-started.md) — guided local, Docker, Podman, and
   Raspberry Pi paths, mock data, configuration, backup, and uninstall.
2. [Direct TP-Link H100/H200](tp-link-direct.md) — poll T310/T315 child sensors
   over the local LAN without requiring Home Assistant.
3. [Direct Gree/Wilfa heat pumps](gree-direct.md) — discover and monitor
   compatible air-source heat pumps locally without requiring Home Assistant.
4. [Electricity prices and contracts](electricity-prices.md) — Property-owned
   price sources and contracts with Home-scoped Tapo meters.
5. [TP-Link H100/H200 and Home Assistant](home-assistant.md) — use the official
   local integration as an alternative ingestion path.
6. [Outdoor weather and home location](weather.md) — map/manual WGS84 location,
   observations, forecasts, CAP warnings, provenance, cache/failure semantics,
   event middle layer, service limits, attribution, and map privacy.
7. [Properties and Guest access](property-management.md) — property grouping,
   drawn areas, equipment, contextual work/notes, and local read-only Guest
   grants.
8. [Architecture](architecture.md) — measurement registry, sparse per-metric
   storage, module boundaries, data flow, live/history/replay semantics,
   reliability, and accessibility.
9. [Manual observations](observations.md) — observed versus recorded time,
   precision, provenance, confidence, revisions, and conflict handling.
10. [Activity and maintenance work](maintenance.md) — Home Activity, quick
   evidence capture, and a Property-owned work plan with verification history.
11. [API, MCP, and integrations](integrations.md) — v1 compatibility and v2
   measurement REST/SSE examples, MCP tools, Home Assistant alert webhook, and
   DayOps/OpenWearable adapter guidance.
12. [Apple Notes bridge and Telegram alerts](apple-notes-telegram.md) — guided
   bot/chat pairing, per-rule Telegram delivery, revocable Home-scoped iOS
   Shortcut grants, maintenance capture, and dated Notes snapshots.
13. [Predictive maintenance](predictive-maintenance.md) — supported hypotheses,
   uncertainty, validation, replay, and safety limitations.
14. [Effective room thermal simulation](thermal-simulation.md) — persisted
   outdoor boundaries, calibration, residuals, scenarios, and interpretation limits.
15. [Experimental spatial-layer engine](spatial-layer-engine.md) — local-only,
   failure-isolated backend inference, versioned house/property snapshots, and
   shared 2D/3D rendering contracts.
16. [Sensor-constrained indoor flow](airflow-simulation.md) — shared 2D/3D
   buoyancy and pressure-projection model, data roles, geometry, and limits.
17. [Security, privacy, and retention](security-privacy.md) — deployment boundary,
   secrets, network/data controls, retention, backups, and incident response.
18. [Versioning](versioning.md) — pre-1.0 compatibility and pull-request release rules.
19. [Modular roadmap](roadmap.md) — hardening, digital-twin authoring, richer
   models, integrations, testing, and versioning.
20. [Backend storage and operations](backend-storage.md) — SQLite control-plane
   durability, TimescaleDB telemetry, caching, migration, backup, and recovery.
21. [Analytics foundation and Explorer](analytics-foundation.md) — the bounded
   query contract, measurement-aware rollups, evidence UI, decisions, and gap matrix.
22. [Known MVP limitations](known-limitations.md) — correctness and operational
   constraints to review before using physical data or notifications.

23. [Raspberry Pi 4 appliance](raspberry-pi-appliance.md) — one-time USB disk
   installation, immutable system images, persistent Docker data, and automatic
   health-gated GitHub container releases.

24. [System updates](system-updates.md) — GitHub release discovery, UI-managed
   maintenance windows, Docker/Desktop installation, health checks, and rollback.

Reference configuration:

- [`config/home-assistant.entities.example.json`](../config/home-assistant.entities.example.json)
  maps the ten seeded sensor IDs to example Home Assistant entities.
- [`config/tp-link.devices.example.json`](../config/tp-link.devices.example.json)
  shows the stable direct hub-child-to-sensor mapping format.
- [`docker-compose.yml`](../docker-compose.yml) and [`Dockerfile`](../Dockerfile)
  provide the isolated Docker/Podman web, API, Timescale, and maintenance
  images.

Stugu is local-first and has one local workspace with built-in accounts.
Browser sign-in uses a server-managed HttpOnly session, while Guest read-only
access and property/house/area grants are enforced by the API. Read the
security guide before binding the Compose web port beyond loopback; account
authentication does not replace TLS or a trusted network boundary.
