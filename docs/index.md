# Climate Twin documentation

Start here:

1. [Install and run](getting-started.md) — Docker Compose, local development,
   mock data, configuration, backup, and uninstall.
2. [TP-Link H200 and Home Assistant](home-assistant.md) — commission T310/T315
   sensors, use the official local integration, map all ten entities, and verify
   live ingestion.
3. [FMI weather and house location](weather.md) — map/manual WGS84 location,
   observations, forecasts, CAP warnings, provenance, cache/failure semantics,
   service limits, attribution, and map privacy.
4. [Architecture](architecture.md) — measurement registry, sparse per-metric
   storage, module boundaries, data flow, live/history/replay semantics,
   reliability, and accessibility.
5. [API, MCP, and integrations](integrations.md) — v1 compatibility and v2
   measurement REST/SSE examples, MCP tools, Home Assistant alert webhook, and
   DayOps/OpenWearable adapter guidance.
6. [Predictive maintenance](predictive-maintenance.md) — supported hypotheses,
   uncertainty, validation, replay, and safety limitations.
7. [Security, privacy, and retention](security-privacy.md) — deployment boundary,
   secrets, network/data controls, retention, backups, and incident response.
8. [Modular roadmap](roadmap.md) — hardening, digital-twin authoring, richer
   models, integrations, testing, and versioning.
9. [Known MVP limitations](known-limitations.md) — correctness and operational
   constraints to review before using physical data or notifications.

Reference configuration:

- [`config/home-assistant.entities.example.json`](../config/home-assistant.entities.example.json)
  maps the ten seeded sensor IDs to example Home Assistant entities.
- [`docker-compose.yml`](../docker-compose.yml) and [`Dockerfile`](../Dockerfile)
  provide the two-service production build.

The project is local-first and currently intended for a trusted host/private
network. The MVP does not provide general API user authentication. Read the
security guide before binding the Compose web port beyond loopback.
