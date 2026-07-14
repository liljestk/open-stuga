# Changelog

All notable Stuga releases are recorded here.

## Unreleased

## 0.2.0 - 2026-07-14

- Added multi-home setup, typed floor and sensor management, shared map
  placement, plan orientation, and guided location discovery.
- Added direct local TP-Link H100/H200 discovery and polling alongside guided
  Home Assistant discovery, connection testing, secure credential storage, and
  explicit real-data mode transitions.
- Added automatic location-based weather routing: Finnish locations use FMI
  observations, forecasts, and official warnings, while other locations use
  Open-Meteo current conditions and forecasts with explicit attribution and
  coverage semantics.
- Added durable, location-isolated outdoor temperature observations from fresh
  FMI results; stale responses and forecasts are not stored as observations.
- Added a shared 2D/3D sensor-constrained indoor-flow layer using paired
  temperature/RH virtual-temperature buoyancy, wall/door constraints, weak
  fresh-wind window leakage, pressure projection, passive CO2 seeding, replay
  driver history, and an honestly labelled scalar-gradient fallback.
- Added an experimental sensor-scoped first-order thermal calibration,
  fitted reconstruction, untouched holdout metrics, residual analysis, and
  constant-outdoor weather scenario.
- Added bounded five-minute calibration buckets, continuous-coverage gates,
  stale scenario-anchor protection, and privacy-aware boundary retention.
- Added a distinct Twin physics panel for observed, simulated, empirical-band,
  and signed-residual values, including honest collecting/provisional states.
- Added model provenance, calibration metrics, OpenAPI documentation, and
  deterministic physics/API/UI tests.
- Expanded the REST/OpenAPI and local MCP surfaces across home authoring,
  integrations, measurements, alerts, observations, weather, replay, and
  simulation workflows, with structured schemas and redacted integration
  responses.
- Added a tenant-isolated Cloudflare hosted edition with a Worker-hosted SPA
  and API, D1 telemetry, private R2 assets, Cloudflare Access identity, scoped
  bridge tokens, a machine-readable route manifest, and a guarded deployment
  workflow. Local LAN discovery and the stdio MCP remain deliberately separate.
- Added Home Pulse, prioritized room comfort, a moisture and ventilation coach,
  indoor/outdoor comparison, and a unified home activity timeline.
- Added responsive portfolio, outdoor-weather, sensor-management, home-insight,
  and setup experiences, plus keyboard navigation, drawer focus isolation,
  accessible state labels, and English/Finnish copy corrections.
- Added JavaScript/TypeScript and Python coverage ingestion plus a blocking
  SonarQube Cloud quality gate in CI.
- Added a canonical runtime system version, release consistency check, and
  pre-1.0 pull-request versioning policy.

## 0.1.0

- Initial local-first Stuga digital-twin vertical slice.
