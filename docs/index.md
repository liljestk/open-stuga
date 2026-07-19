# Stuga documentation

Start here:

1. [Install and run](getting-started.md) — Docker Compose, local development,
   mock data, configuration, backup, and uninstall.
2. [Direct TP-Link H100/H200](tp-link-direct.md) — poll T310/T315 child sensors
   over the local LAN without requiring Home Assistant.
3. [Electricity prices and contracts](electricity-prices.md) — Property-owned
   price sources and contracts with Home-scoped Tapo meters.
4. [TP-Link H100/H200 and Home Assistant](home-assistant.md) — use the official
   local integration as an alternative ingestion path.
5. [Outdoor weather and home location](weather.md) — map/manual WGS84 location,
   observations, forecasts, CAP warnings, provenance, cache/failure semantics,
   event middle layer, service limits, attribution, and map privacy.
6. [Properties and Guest access](property-management.md) — property grouping,
   drawn areas, equipment, contextual work/notes, and local read-only Guest
   grants.
7. [Architecture](architecture.md) — measurement registry, sparse per-metric
   storage, module boundaries, data flow, live/history/replay semantics,
   reliability, and accessibility.
8. [Manual observations](observations.md) — observed versus recorded time,
   precision, provenance, confidence, revisions, and conflict handling.
9. [Activity and maintenance work](maintenance.md) — Home Activity, quick
   evidence capture, and a Property-owned work plan with verification history.
10. [API, MCP, and integrations](integrations.md) — v1 compatibility and v2
   measurement REST/SSE examples, MCP tools, Home Assistant alert webhook, and
   DayOps/OpenWearable adapter guidance.
11. [Apple Notes bridge and Telegram alerts](apple-notes-telegram.md) — guided
   bot/chat pairing, per-rule Telegram delivery, revocable Home-scoped iOS
   Shortcut grants, maintenance capture, and dated Notes snapshots.
12. [Predictive maintenance](predictive-maintenance.md) — supported hypotheses,
   uncertainty, validation, replay, and safety limitations.
13. [Effective room thermal simulation](thermal-simulation.md) — persisted
   outdoor boundaries, calibration, residuals, scenarios, and interpretation limits.
14. [Experimental spatial-layer engine](spatial-layer-engine.md) — local-only,
   failure-isolated backend inference, versioned house/property snapshots, and
   shared 2D/3D rendering contracts.
15. [Sensor-constrained indoor flow](airflow-simulation.md) — shared 2D/3D
   buoyancy and pressure-projection model, data roles, geometry, and limits.
16. [Security, privacy, and retention](security-privacy.md) — deployment boundary,
   secrets, network/data controls, retention, backups, and incident response.
17. [Versioning](versioning.md) — pre-1.0 compatibility and pull-request release rules.
18. [Modular roadmap](roadmap.md) — hardening, digital-twin authoring, richer
   models, integrations, testing, and versioning.
19. [Backend storage and operations](backend-storage.md) — SQLite control-plane
   durability, TimescaleDB telemetry, caching, migration, backup, and recovery.
20. [Known MVP limitations](known-limitations.md) — correctness and operational
   constraints to review before using physical data or notifications.

Reference configuration:

- [`config/home-assistant.entities.example.json`](../config/home-assistant.entities.example.json)
  maps the ten seeded sensor IDs to example Home Assistant entities.
- [`config/tp-link.devices.example.json`](../config/tp-link.devices.example.json)
  shows the stable direct hub-child-to-sensor mapping format.
- [`docker-compose.yml`](../docker-compose.yml) and [`Dockerfile`](../Dockerfile)
  provide the isolated web/API/Timescale runtime and maintenance images.

Stuga is local-first and has one local workspace with built-in accounts.
Browser sign-in uses a server-managed HttpOnly session, while Guest read-only
access and property/house/area grants are enforced by the API. Read the
security guide before binding the Compose web port beyond loopback; account
authentication does not replace TLS or a trusted network boundary.
