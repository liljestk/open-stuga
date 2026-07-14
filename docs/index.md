# Stuga documentation

Start here:

1. [Install and run](getting-started.md) — Docker Compose, local development,
   mock data, configuration, backup, and uninstall.
2. [Direct TP-Link H100/H200](tp-link-direct.md) — poll T310/T315 child sensors
   over the local LAN without requiring Home Assistant.
3. [TP-Link H100/H200 and Home Assistant](home-assistant.md) — use the official
   local integration as an alternative ingestion path.
4. [FMI weather and house location](weather.md) — map/manual WGS84 location,
   observations, forecasts, CAP warnings, provenance, cache/failure semantics,
   service limits, attribution, and map privacy.
5. [Architecture](architecture.md) — measurement registry, sparse per-metric
   storage, module boundaries, data flow, live/history/replay semantics,
   reliability, and accessibility.
6. [API, MCP, and integrations](integrations.md) — v1 compatibility and v2
   measurement REST/SSE examples, MCP tools, Home Assistant alert webhook, and
   DayOps/OpenWearable adapter guidance.
7. [Predictive maintenance](predictive-maintenance.md) — supported hypotheses,
   uncertainty, validation, replay, and safety limitations.
8. [Effective room thermal simulation](thermal-simulation.md) — persisted
   outdoor boundaries, calibration, residuals, scenarios, and interpretation limits.
9. [Sensor-constrained indoor flow](airflow-simulation.md) — shared 2D/3D
   buoyancy and pressure-projection model, data roles, geometry, and limits.
10. [Cloudflare hosting and multi-tenant operations](cloudflare-hosting.md) —
   hosted architecture, Access identity, tenant isolation, free-tier sizing,
   deployment, and rollback.
11. [Security, privacy, and retention](security-privacy.md) — deployment boundary,
   secrets, network/data controls, retention, backups, and incident response.
12. [Versioning](versioning.md) — pre-1.0 compatibility and pull-request release rules.
13. [Modular roadmap](roadmap.md) — hardening, digital-twin authoring, richer
   models, integrations, testing, and versioning.
14. [Known MVP limitations](known-limitations.md) — correctness and operational
   constraints to review before using physical data or notifications.

Reference configuration:

- [`config/home-assistant.entities.example.json`](../config/home-assistant.entities.example.json)
  maps the ten seeded sensor IDs to example Home Assistant entities.
- [`config/tp-link.devices.example.json`](../config/tp-link.devices.example.json)
  shows the stable direct hub-child-to-sensor mapping format.
- [`docker-compose.yml`](../docker-compose.yml) and [`Dockerfile`](../Dockerfile)
  provide the two-service production build.

The default edition is local-first and intended for a trusted host/private
network; its local API does not provide general user authentication. Read the
security guide before binding the Compose web port beyond loopback. The
optional hosted edition has a separate tenant-aware Worker API protected by
Cloudflare Access and does not expose the local stdio MCP or LAN integrations.
