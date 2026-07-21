# Modular roadmap

The roadmap is capability-based rather than tied to a specific vendor or cloud.
Each stage should keep mock mode, documented migration, automated tests, and a
usable local install.

## Stage 0 — working local vertical slice

- Ten seeded sensors across a two-floor example house.
- Registry-defined temperature, humidity, CO2, and custom finite numeric scalar
  measurements with sparse per-metric timestamps/source/quality.
- Registry-aware mock generation and scenario controls.
- Home Assistant WebSocket adapter with legacy and generic entity mapping.
- SQLite transactional control/current storage with a durable telemetry buffer.
- Compatible `/api/v1` readings plus `/api/v2` measurement REST/SSE and stdio MCP.
- Responsive accessible 2D authoring and whole-building stacked 3D views,
  current values, history, alerts, observations, static parameters, forecast
  baseline, and replay controls.
- Node and Docker Compose install paths with health checks.

Exit gate: clean install from documented commands; build/typecheck/test pass;
mock readings reach storage and UI; reconnect/stale states are understandable;
no secrets enter the browser/database/image.

## Stage 1 — harden the home installation

- The hybrid TimescaleDB archive, continuous rollups, verified backup CLI,
  resumable migration, and restore runbook are in place. Complete archive-aware
  SQLite buffer pruning, scheduled backup/restore drills, retention telemetry,
  and documented major-version rollback.
- Integration freshness metrics, historical gap import, malformed-state
  diagnostics, per-metric unit/conversion diagnostics, and longer-running
  reconnect/conformance tests.
- Built-in API authentication/authorization, resource-scoped Guest grants,
  rate/body/query limits, and an optional lockout-safe Cloudflare Access/Tunnel
  recipe are in place. The append-only structured security ledger and automated
  credential rotation/revocation drills are also in place; continue additional
  TLS/VPN/reverse-proxy recipes and expand audit coverage with future privileged
  capabilities.
- Webhook HMAC signatures, exact destination allowlisting, multi-destination
  fan-out, bounded attempts, durable dead letters, and Owner/Admin manual retry
  are now in place on top of the durable outbox.
- Wall-clock sustained-condition timers now fire without waiting for the next
  sample, resume their durable pending state after restart, and refuse stale
  evidence.
- Automated end-to-end accessibility auditing against WCAG 2.2 AA,
  localization extraction, and broader unit/timezone tests.
- Import/export with explicit schema/version and privacy preview.
- Immutable telemetry ownership context and retired-resource tombstones so
  historical samples remain attributable, queryable, and correctly authorized
  after sensor/Home moves or deletion.

Exit gate: recovery, token rotation, retention, alert retry, and Home Assistant
disconnect scenarios have automated integration tests and operational runbooks.

## Stage 2 — author the digital twin

- Multi-house CRUD and typed floor management (basement, ground, upper, attic,
  mezzanine, and outdoor) are available in the layout editor. Continue the
  accessible room/wall editor with snapping, scale, coordinate system,
  undo/redo, validation, and draft/publish lifecycle.
- Safe raster/SVG floor-plan import with calibration and image sanitization.
- Sensor placement history, labels/QR workflow, snapping, undo/redo, and a bulk
  entity-map assistant (basic pointer and keyboard placement are in the MVP).
- GLTF/GLB 3D import after parser sandboxing, size/complexity limits, accessible
  2D/table fallback, and progressive rendering.
- Time-aware interpolation/heat maps with visible confidence and controls that
  avoid suggesting measurements between sparse sensors are exact. Respect each
  definition's `spatialInterpolation` capability and keep marker/history-only
  metrics out of generated surfaces.

Exit gate: a non-technical user can map a real house and ten physical sensors,
correct mistakes, and use every essential function without a pointer or 3D view.

## Stage 3 — richer environmental reasoning

- Weather, HVAC state/setpoint, ventilation, window/door, energy, certified
  leak-detector, CO2, particulate, VOC, and other environmental adapters behind
  the appropriate typed source interfaces. Do not force categorical state into
  the numeric measurement registry.
- Derived dew point/absolute humidity and carefully labeled condensation-risk
  estimates.
- Forecast registry with dataset/model versions, generated-at time, intervals,
  calibration, drift monitoring, and house-specific release gates.
- Incident/maintenance feedback workflow and comparison against transparent
  persistence/seasonal baselines.
- Configurable alert policies, schedules, escalation, quiet hours, and per-channel
  routing.

Exit gate: every prediction has provenance, backtest metrics, uncertainty,
fallback behaviour, and a user-verifiable action; synthetic performance is not
used as the release claim.

## Stage 4 — integration ecosystem

- Generated typed client from the published OpenAPI documents, additive
  evolution policies for the v1 compatibility and v2 measurement APIs, and
  deprecation windows before any future major version.
- Expand the initial MCP tools with resources, pagination, read-only defaults,
  capability discovery, confirmation boundaries, and conformance tests.
- Versioned DayOps/OpenWearable adapter packages with field-level consent,
  pseudonymous identities, signed idempotent events, and contract fixtures.
- MQTT and additional vendor adapters without changing domain services.
- Extend the existing optional PostgreSQL/TimescaleDB archive toward managed or
  multi-node deployments only when fleet-scale evidence justifies the added
  operational complexity; keep SQLite as the local control plane.
- Packaging options evaluated from evidence: signed container releases, local
  desktop bundle, and/or reviewed Home Assistant app/add-on.

Exit gate: integrations negotiate versions/capabilities, can be revoked, and do
not require broad history or floor-plan disclosure for basic alerts.

## Cross-cutting test strategy

Maintain a test pyramid around module boundaries:

- unit: registry/ID validators, finite/range checks, unit conversions, retention dates, interpolation, alerts,
  forecasts, locale/unit formatting;
- contract: v1 compatibility golden fixtures, v2 sparse API/MCP schemas, entity
  maps, webhooks, DayOps/OpenWearable fixtures;
- repository: idempotent legacy backfill, sparse same-time metrics, out-of-order
  latest selection, transactions, UTC/range boundaries, WAL/restart;
- integration: fake Home Assistant WebSocket, reconnect, malformed/unavailable
  entities, webhook timeouts, SSE reconnect;
- browser: keyboard/screen-reader routes, responsive 2D and stacked 3D views, history/replay,
  reduced motion and colour-independent state;
- property/fuzz: geometry and ingestion validators, upload/base64 limits;
- performance: 10–100 sensors, long history/downsampling, SSE fan-out, mobile
  rendering, and 3D asset budgets;
- resilience: disk full, corrupt map, clock shifts, expired token, HA outage,
  process restart, and restore from backup.

No single coverage percentage proves quality. Set meaningful per-module branch
thresholds, forbid coverage regressions in critical validation/alert code, and
pair coverage with mutation/property tests for risky logic.

## Versioning principles

Product releases follow the dedicated [pre-1.0 versioning policy](versioning.md).
Every feature pull request carries a release bump and changelog entry; CI checks
that runtime, workspace, and lockfile versions agree.

- `/api/v1` remains the flat temperature/humidity compatibility contract;
  changes are additive unless correcting a security flaw. `/api/v2` owns sparse
  registry-driven measurements. Unknown fields must be tolerated by clients;
  removed/renamed fields or changed metric/unit semantics require a later major
  API path.
- Persisted schemas use ordered migrations and remain separate from public API
  versions.
- Entity-map, import/export, webhook, model, and MCP contracts carry their own
  explicit versions when published.
- UI, API, and adapter builds expose a release/commit identifier in diagnostics.
- Configuration has validated defaults but no site-specific sensor IDs, locale,
  house geometry, credentials, thresholds, or integration URLs in source code.
