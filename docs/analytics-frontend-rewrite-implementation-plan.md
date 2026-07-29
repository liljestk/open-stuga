# Authoritative analytics and frontend data rewrite

Status: implementation-ready; reviewed with Claude
Prepared: 2026-07-29
Audience: senior engineer leading the rewrite
Scope: API analytics, web server-state architecture, iPhone monitoring parity, and
the deletion of duplicated authoritative derivations

## 1. Outcome

Make the Stugu API the only authority for analytics, monitoring status, and
recommendations while keeping interaction, formatting, geometry, and explicitly
experimental visualization in clients.

The completed system has this flow:

```text
SQLite current/control data + HybridTelemetryReader/Timescale history
    -> authorization and evidence collection
    -> deterministic versioned API-internal algorithms
    -> typed result with completeness and provenance
    -> REST/MCP
    -> web and iPhone presentation
```

This is a structural rewrite, not a port of browser files into an API directory.
The server chooses evidence windows, source scope, quality gates, safety budgets,
and partial-evidence behavior. Clients choose only user intent and presentation.

## 2. Current baseline and problems

The relevant production surface is approximately:

| Area | Current size | Problem |
| --- | ---: | --- |
| Home Performance, including panel orchestration | 1,473 lines | Six requests, policy, failure reconciliation, and derivation are owned by React |
| Home Insights and house monitoring | 1,437 lines | Product status, freshness, thresholds, and recommendations are browser-only |
| Calendar comparison, including component orchestration | 956 lines | The browser builds local-calendar periods and recursively fans out bounded API calls |
| Opening analytics, including panel orchestration | 571 lines | Transition rules duplicate server logic and disagree on expiry |
| `useClimateData` implementation and support | 3,531 lines | One hook is mechanically split across 16 files and owns every server resource |
| Outdoor influence | 205 lines | Experimental renderer-local estimate; not authoritative and not part of the server migration |

Known correctness issue:

- `apps/api/src/daily-analytics-findings/01-daily-analytics-algorithm-version-to-error-message.ts:428`
  suppresses a state transition after the preceding observation expires.
- `apps/web/src/openingAnalytics.ts:141` counts a transition based only on the
  previous state. It applies expiry only to rendered timeline segments.
- `packages/contracts/src/building-structure.ts:230` treats an observation as
  expired at `validUntil`, while the daily detector currently uses a strict
  `<` comparison. The exact boundary is therefore not canonical either.

The iPhone companion has additional competing policy in
`TodayRecommendation.evaluate` and `HomeMonitorSummary.evaluate`, including
freshness and moisture thresholds that differ from the web implementation.

### 2.1 Baseline prerequisite

This plan was prepared against a dirty development worktree that already contains
in-flight Gree/heat-pump and Timescale analytics-rollup work. In particular,
`apps/api/src/analytics-rollup.ts` and
`apps/api/src/timeseries/read-analytics-rollup.ts` are currently untracked, while
`analytics.ts`, `app/part-10.ts`, contracts, OpenAPI, tests, and architecture docs
have related edits.

Do not begin Milestone 1 on an older branch. First commit/merge that work or rebase
the rewrite branch onto its final state. Preserve the new exports
`MAX_INTERACTIVE_OUTPUT_POINTS`, `resolveAnalyticsAggregation`,
`buildAnalyticsSummary`, and `finalizeAnalyticsResponse`, plus the
reconcile-then-archive rollup path and its typed 503 behavior.

## 3. Decisions

### 3.1 Authority boundary

Move a calculation to the API when it affects any of:

- alerts, monitoring status, recommendations, or user-visible conclusions;
- versioned scientific or statistical interpretation;
- cross-client consistency;
- persistence, auditability, provenance, or source-completeness claims;
- selection of sensors, metrics, evidence windows, or safety limits.

Keep a calculation in a client when it is limited to:

- localization and formatting;
- sorting or filtering an already-authoritative result;
- chart gaps, screen-space geometry, and accessible presentation;
- local interaction state;
- an explicitly experimental, disposable visualization that cannot create
  storage, alerts, findings, recommendations, or control inputs.

Consequently:

- Keep `openingState.ts`, `architecturalGeometry.ts`, `chartGaps.ts`, and
  `alertGrouping.ts`.
- Keep airflow, spatial volume/field sampling, and all of `outdoorInfluence.ts`
  client-side. `outdoorInfluence.ts` is used only by the experimental spatial
  renderer and is already documented as non-authoritative. Split it inside the
  visualization feature if useful, but do not create an API for it.
- Keep thermal and moisture-response models on the API.

### 3.2 Algorithm location and dependencies

Do not create a new workspace package for analytics in this rewrite.
Authoritative algorithms live in `apps/api/src/analytics` behind pure inner
modules. Promote code to a package only if a real non-API runtime needs to execute
the same algorithm rather than consume its result.

Dependency direction:

```text
@climate-twin/contracts
    <- pure analytics modules
    <- API evidence/orchestration services
    <- REST and MCP adapters
    <- web/iPhone consumers
```

Rules:

- Contracts contain transport/domain vocabulary and small existing low-level
  rules such as effective opening-state resolution. They do not contain Home
  Performance, monitoring, comparison, or recommendation algorithms.
- Pure analytics modules perform no I/O, import no Express/database/timeseries
  modules, read no configuration, and never call `Date.now()`.
- Every algorithm receives an explicit clock instant, timezone, policy version,
  and evidence object.
- Clients cannot import API analytics modules.
- API route handlers do validation, authorization, and response mapping only.

### 3.3 Persistence and caching

- Keep daily peer-period findings as durable snapshots.
- Compute rolling Home Performance and Home Insights/monitoring on demand.
- Compute calendar comparison and opening activity on demand.
- Do not create a general analytics-job framework or durable result table.
- Reuse `LruTtlCache` for bounded, reconstructible API results and request
  coalescing. Keep HTTP responses `Cache-Control: no-store`.
- Start Home Performance with a 60-second in-process TTL, 128-entry bound, and
  no stale-while-revalidate. Routine measurement ingest does **not** evict this
  cache: TP-Link can publish every two seconds, so the TTL is the freshness
  policy for readings. Invalidate the Home namespace only for sensor/topology or
  measurement-definition changes, opening/weather changes, action runs,
  maintenance/observation changes, data-mode changes, and authorization changes.
- Resolve authorization before both cache lookup and in-flight request
  coalescing. Include data mode, algorithm version, evaluated-time bucket,
  sorted visible sensor IDs, and an authorization fingerprint in the key. Build
  that fingerprint with the same canonical hashing approach as
  `localAuthorizationFingerprint`, over principal ID, Home ID, role/grant
  revision, and sorted visible resource IDs. It must change for every visibility
  mutation and must never be logged. Use whole-Home namespace invalidation for
  v1; add dependency-generation vectors only if measurements show they are
  needed.
- Keep calendar comparison uncached initially. Measure before adding a cache.

### 3.4 Web server-state implementation

Adopt `@tanstack/react-query` v5 and pin an exact patch version. Use it as the
explicit server-state cache; do not build another general cache/store.

The query cache is memory-only. Authentication changes, authorization events,
server-origin changes, and the one-way demo-to-live transition cancel requests,
close streams, and clear it before a new bootstrap.

One `LiveEventCoordinator` owns both existing SSE transports. Consolidating the
server transports into one endpoint is not required. Components and feature
hooks never subscribe directly. The coordinator batches measurement updates,
updates current snapshot queries, and uses a tested event-to-invalidation map
for other resources.

During migration, a server resource has exactly one client owner. Query Client
initially owns only the newly migrated analytics endpoints. Legacy
`useClimateData` remains the owner of inventory/current/history resources until
their Milestone 6 cutover. Extract SSE transport ownership once into
`LiveEventCoordinator`; during the transition it dispatches to the legacy state
adapter and invalidates only migrated query keys. Never open a second stream or
store the same current snapshot independently in both caches.

## 4. Target module layout

### 4.1 API

```text
apps/api/src/analytics/
  common/
    errors.ts
    provenance.ts
    result-cache.ts
  query/
    validation.ts
    semantics.ts
    in-memory-rollup.ts
    archive-rollup.ts
    execute.ts
  temporal/
    local-calendar.ts
    opening-intervals.ts
  daily-findings/
    periods.ts
    detectors.ts
    opening-detector.ts
    worker.ts
  home-performance/
    model.ts
    exposure.ts
    moisture-recovery.ts
    opening-response.ts
    energy.ts
    maintenance.ts
    sensor-health.ts
    derive.ts
    collect-evidence.ts
    service.ts
  home-monitoring/
    model.ts
    freshness.ts
    insights.ts
    blockers.ts
    derive.ts
    service.ts
  calendar-comparison/
    model.ts
    periods.ts
    aggregate.ts
    service.ts
  opening-activity/
    model.ts
    derive.ts
    service.ts
  routes.ts
```

`apps/api/src/analytics.ts` becomes a short compatibility facade during the
rewrite and is deleted or reduced to stable exports at the cleanup gate.
`apps/api/src/analytics-rollup.ts` is moved without behavior change into
`analytics/query/archive-rollup.ts`.

Move analytics route registration out of `apps/api/src/app/part-10.ts` into
`analytics/routes.ts`. Follow `gree-routes.ts`: define a narrow
`AnalyticsRouteContext` containing only the Express app/prefix, database,
telemetry reader, services, visibility resolver, and cache. Call
`registerAnalyticsRoutes(context)` from the existing configuration chain using
structural typing. Do not pass the entire chained context into analytics
internals, add another numbered app part, or change the public `ApiRuntime`
surface in `finish.ts`/`app/support/part-07.ts`.

### 4.2 Contracts

Add focused files and re-export them from `packages/contracts/src/index.ts`:

```text
analytics-common.ts
home-performance.ts
home-monitoring.ts
calendar-comparison.ts
opening-analytics.ts
```

All derived responses include:

- `apiVersion`;
- `dataMode`;
- algorithm key and version;
- `generatedAt` and the explicit evaluation instant;
- resolved input ranges;
- completeness state;
- stable warning codes with structured details;
- archive state where history is used;
- source counts/IDs where disclosure is safe;
- cache metadata where applicable.

Do not make localized prose the semantic contract. Monitoring/insight results
carry stable condition/action codes and numeric parameters. REST may include
an English fallback message for generic clients; web and iPhone localize from
the codes.

### 4.3 Web

```text
apps/web/src/data/
  queryClient.ts
  queryKeys.ts
  session/
  workspace/
  houses/
  sensors/
  telemetry/
    LiveEventCoordinator.ts
    hydrationGate.ts
    eventInvalidation.ts
    currentQueries.ts
    seriesQueries.ts
  alerts/
  observations/
  maintenance/
  integrations/
  analytics/
    homePerformanceQuery.ts
    homeMonitoringQuery.ts
    calendarComparisonQuery.ts
    openingActivityQuery.ts
  demo/
```

Each feature owns query definitions, mutations, cache-update helpers, and tests.
A small `useAppBootstrap` composes session, inventory, selected-Home hydration,
and stream lifecycle. It must remain orchestration only.

Pages receive feature-specific view models instead of the entire `ClimateState`.
UI-only selection, expanded state, hidden-insight preferences, chart formatting,
and CSV formatting remain local.

## 5. Canonical semantic rules

Implement these before moving feature algorithms.

### 5.1 Time ranges

- Historical ranges are half-open: `[start, end)`.
- Timestamps are canonical UTC at storage and API boundaries.
- Calendar periods are resolved only on the API in the Home's IANA timezone.
- DST days may contain 23, 24, or 25 hours; never normalize them to 24.
- An algorithm never reads the wall clock. The service captures one `now` and
  passes it through every evidence read and derivation.
- Late data is visible on the next uncached computation. Durable daily snapshots
  retain their existing invalidation rules.

### 5.2 Opening observations

- An observation is effective on `[observedAt, effectiveUntil)`.
- `effectiveUntil` is the minimum of declared `validUntil`, binding staleness,
  and the next relevant observation.
- It is expired when `at >= effectiveUntil`.
- `unknown` terminates confidence and prevents carrying an older state forward.
- Expiry gaps prevent transitions. A later `open` after an expired `closed` is
  an initial state, not an opening transition.
- Repeated same-state heartbeats do not create transitions.
- A transition at `end` is excluded because the range is half-open.
- Binding provider, external ID, connection ID, and inversion are applied before
  interval or transition derivation.
- Equal timestamps are ordered deterministically; the lexically greatest stable
  observation ID wins, matching effective-state resolution.
- Architectural defaults never invent observed transitions.

Expose/reuse one low-level validity helper beside
`resolvePlanElementOpeningState`; use the API temporal module for timeline and
transition construction. Update the daily findings detector to consume it.

### 5.3 Monitoring freshness

Create a versioned server policy rather than inheriting browser/iPhone constants.
For the first version, preserve the web Home Pulse behavior:

- fresh through 30 minutes;
- aging after 30 minutes through 120 minutes;
- stale after 120 minutes;
- source quality `estimated` remains distinct from age;
- a disconnected adapter that supplied a current value causes inspection, not
  a confirmed all-clear.

The 15-minute setup-doctor connectivity check remains a separate operational
check and must not be presented as Home monitoring policy.

## 6. API surfaces

Keep the generic `/api/v2/analytics/query`, `/coverage`, and persisted
`/findings` endpoints. They remain useful to Explorer and external clients.

Add:

### 6.1 Home Performance

```text
GET /api/v2/analytics/home-performance?houseId=...&dataMode=live|demo
```

The client cannot supply time windows, metrics, sensor caps, or quality policy.
The response contains the six existing sections, per-source evidence state,
limitations, algorithm metadata, and cache metadata.

Evidence policy initially preserves current behavior:

- 30 rolling days of hourly climate and energy;
- seven rolling days of 15-minute recovery evidence;
- matching outdoor history;
- expiry-aware opening history;
- bounded action runs;
- current maintenance and observation evidence;
- qualities `good` and `estimated`.

V1 uses every enabled visible sensor up to both deterministic internal limits:
`MAX_HOME_PERFORMANCE_SENSORS = 80` and
`MAX_HOME_PERFORMANCE_EVIDENCE_POINTS = 500_000`. Plan rollups in batches that
stay under the existing `MAX_INTERACTIVE_OUTPUT_POINTS = 100_000`, combine them
inside the API, and serialize only the derived result. Never silently select the
first identifiers. If either full-scope limit is exceeded, fail with typed 422
`HOME_PERFORMANCE_SCOPE_TOO_LARGE`; do not return a biased subset as a
whole-Home conclusion. Milestone 0 benchmarks may lower either constant before
the contract is frozen, but Milestone 3 cannot start with the limit undecided.
This deliberately replaces today's silent 40-sensor truncation.

Pre-serialize the final response and enforce
`MAX_HOME_PERFORMANCE_RESPONSE_BYTES = 1_000_000`. An over-limit result uses the
same typed scope error and records only counts in diagnostics.

### 6.2 Home monitoring and insights

```text
GET /api/v2/monitoring/houses?dataMode=live|demo
GET /api/v2/monitoring/houses/:houseId?dataMode=live|demo&include=insights
```

The collection returns authoritative summary status and blockers for every
visible Home without an N+1 browser calculation. The detail response adds
ranked insights, structured evidence, freshness, confidence, and advisory text.

The service reads current projections, enabled rules/active alerts, integration
status, weather, and only the bounded recent metric history needed by the trend
window. The summary path must not scan long-term history.

### 6.3 Calendar comparison

```text
POST /api/v2/analytics/calendar-comparison
```

The request contains user intent only:

- Home and selected sensor IDs;
- one measurement ID;
- period unit and local anchor;
- optional selected period references;
- aggregation and quality filter;
- data mode.

The server computes coverage, candidate periods, default/selected periods,
house-local UTC boundaries, aligned breakdown buckets, combined-sensor
semantics, headline values, and completeness.

The Home's stored IANA timezone is authoritative. The request has no timezone or
UTC-range field, unknown fields are rejected, and changing the stored timezone
changes the resolved comparison ranges.

Query each selected period as one archive rollup, with required counter context,
rather than reproducing the component's recursive request splitting and
four-way fan-out. Reject an unavailable complete archive with the existing typed
503 instead of comparing shortened history.

### 6.4 Opening activity

```text
POST /api/v2/analytics/opening-activity
```

The request supplies Home, half-open UTC range, data mode, and optional element
filters. The server resolves floor-plan targets and bindings and returns
timeline intervals, transition records, current state, durations, counts,
truncation/completeness, and provenance.

CSV creation, visible filtering, and localized labels remain in the web client.

## 7. Evidence and failure behavior

Create one `AnalyticsEvidenceReader` API-internal interface over the database and
`HybridTelemetryReader`. Algorithms consume typed evidence, not
`AnalyticsQueryResponse` transport DTOs.

Rules:

- Authorization and visible sensor scope are resolved before reads.
- Bucketed history uses the current reconcile-then-archive rollup path. It is
  never merged with an overlapping SQLite tail.
- A standalone SQLite deployment uses the existing in-memory/local aggregation
  fallback only when `HybridTelemetryReader` proves the complete requested
  window is local. A `null` archive rollup result is the explicit signal to use
  that fallback; it is not an empty result.
- Home Performance returns 200 with explicit section states when independent
  long-history evidence is unavailable. Each affected section and any overall
  conclusion become `unavailable`; current maintenance/action sections may
  remain usable. The warning carries `TELEMETRY_ARCHIVE_REQUIRED` plus
  `archiveState` (`not-configured`, `not-ready`, or `failed`). It never treats a
  shortened range as complete or computes a whole-Home score from partial
  history.
- Calendar comparison uses the local fallback only when both selected windows
  are proven complete. Otherwise it fails the whole request with typed 503
  `TELEMETRY_ARCHIVE_REQUIRED` and `archiveState`; periods are never compared
  from different completeness levels.
- Opening activity fails when the requested range cannot be proven complete;
  a range fully covered by the local cache remains valid.
- Monitoring can use current SQLite projections and bounded recent local
  history; it reports unknown instead of manufacturing an all-clear.
- Data-mode mismatch remains a 409 and cross-mode rows never participate.
- Invalid/oversized intent is 422; inaccessible scope remains indistinguishable
  from missing scope with 404.

## 8. Web query and event behavior

### 8.1 Query keys

Use a key factory. Representative keys:

```text
["session"]
["workspace", "inventory"]
["house", houseId, "snapshot", dataMode]
["house", houseId, "measurements", "latest", dataMode]
["house", houseId, "series", sensorId, metric, range, resolution, dataMode]
["house", houseId, "heat-pumps", dataMode]
["house", houseId, "analytics", "home-performance", dataMode]
["house", houseId, "monitoring", dataMode]
["analytics", "calendar-comparison", requestFingerprint]
["analytics", "opening-activity", requestFingerprint]
```

Never place secrets in a key. Clear the complete query client on session or
origin changes.

### 8.2 Snapshot/SSE race

Preserve the current correctness guarantee:

1. Start the central event coordinator.
2. Register a per-Home hydration buffer.
3. Request the snapshot.
4. Merge buffered events by natural key, timestamp, source precedence, and
   mutation revision.
5. Commit one hydrated cache value and release the buffer.

Each per-Home buffer is bounded to 2,000 coalesced events, 256 KiB, and ten
seconds. Crossing any bound discards the attempted hydration result, clears the
buffer, and starts a fresh snapshot after the stream is established. After
three consecutive overflows, stop retrying and expose a reconnect/error state.
Never commit a snapshot after losing buffered events.

On reconnect, refresh snapshots before treating the stream as authoritative.
The event stream is not a durable log.

### 8.3 Event-to-invalidation map

Implement a pure, exhaustively tested map:

| Event | Direct cache update | Debounced invalidation |
| --- | --- | --- |
| measurement | latest measurement snapshot and active live series | monitoring and insights; Home Performance relies on its 60-second TTL |
| alert | alert collection | monitoring and insights |
| integration | integration status | monitoring |
| heat-pump | current heat-pump state | monitoring; Home Performance only if that evidence is added |
| weather | Home weather | insights and Home Performance |
| opening | current opening snapshot | opening activity and Home Performance |
| sensor/topology mutation | relevant inventory/snapshot | all Home analytics |
| observation/maintenance/action mutation | resource collection | Home Performance |
| authorization | none | cancel, close streams, clear all, bootstrap |
| heartbeat/reconnect | connection state | active Home snapshot |

Coalesce high-frequency measurement invalidations. Update current readings in a
short batch, but do not refetch expensive analytics more frequently than their
active-query debounce permits.

### 8.4 Mutations

Each domain mutation:

- cancels conflicting queries;
- snapshots affected cache values;
- applies an explicit optimistic update only where useful;
- rolls back on failure;
- adopts the server response;
- invalidates the smallest authoritative key set.

Preserve sensor-move serialization, observation/maintenance revision-conflict
reload behavior, live-event buffering during hydration, and demo/live
partitioning as named tests.

## 9. Implementation sequence

Every feature or breaking PR follows `docs/versioning.md`: increment the product
minor version, update all workspace versions and lockfile, add `CHANGELOG.md`,
and document migration impact. A pure bug-only PR may use a patch increment.

### Milestone 0 — freeze behavior and boundaries

Deliverables:

1. Add a short architecture decision record for the authority boundary,
   persistence policy, and API-internal core.
2. Convert current web algorithm tests into synthetic golden fixtures that can
   run against server algorithms. Include no household data.
3. Record intentional divergences: opening expiry, iPhone freshness, iPhone
   moisture threshold, Home Performance behavior above 40 sensors, and any
   floating-point/rounding differences.
4. Add injected clocks to any algorithm fixture that still reads current time.
5. Establish a representative benchmark dataset for 1, 10, 40, and 80 sensors.
6. Add `scripts/check-architecture-boundaries.mjs` and run it from `typecheck`.
7. Benchmark and obtain product sign-off for the v1 full-scope limits: 80 sensors
   and 500,000 internal evidence points, processed in rollup batches of at most
   100,000 points. Lower a limit here if the benchmark fails, then freeze the
   accepted constants before contracts are written. Above the accepted limits,
   the decided behavior is typed 422 `HOME_PERFORMANCE_SCOPE_TOO_LARGE`.
8. Record the iPhone minimum-server policy: monitoring/recommendations require
   the first server version containing the v2 monitoring endpoints; there is no
   local semantic fallback.
9. Record the daily-findings algorithm-version transition and stale-snapshot UI
   behavior described in Milestone 2.

Exit gate:

- Golden outputs are committed and reviewed.
- The boundary checker rejects API I/O imports from pure analytics modules and
  rejects new numbered modules under API analytics or web data.
- The existing `check:file-size` script continues to enforce 600 physical lines;
  450 lines remains the documented review threshold and is checked during review,
  not silently redefined by the new boundary script.
- Existing tests remain green.

### Milestone 1 — decompose the existing analytics foundation

Deliverables:

1. Move parsing, semantics, in-memory aggregation, response construction, and
   archive rollup into the target `analytics/query` modules without changing the
   generic endpoint contract.
2. Preserve the current database-side rollup work in
   `apps/api/src/analytics-rollup.ts`.
3. Move route registration out of `app/part-10.ts`.
4. Rename/split daily-finding period math, detectors, and worker by domain.
5. Introduce `AnalyticsEvidenceReader` and adapters for rollups, raw opening
   history, outdoor history, current control-plane resources, and bounded
   recent history.
6. Add the shared result metadata and warning contracts.
7. Add `QueryClientProvider`, the key factory, and analytics-only query hooks to
   web without replacing `useClimateData` yet.
8. Extract the existing SSE transport setup into one `LiveEventCoordinator`
   without changing hydration, buffering, or legacy-state behavior. Add the
   typed event map, including `heat-pump`.

Exit gate:

- Generic analytics API/OpenAPI snapshots are unchanged.
- Timescale and SQLite fallback tests pass.
- No production behavior change beyond module names.
- Every new source file is below the 450-line review threshold.
- There is one network subscription per existing SSE transport, not one legacy
  and one Query Client subscription.

### Milestone 2 — canonical opening intervals and opening activity

Deliverables:

1. Define and test the half-open validity rule.
2. Update `resolvePlanElementOpeningState` to use the low-level helper without
   changing valid current-state behavior.
3. Make daily findings consume the canonical transition detector.
4. Add the opening-activity contract, service, endpoint, OpenAPI, API client,
   and web query hook.
5. Change `OpeningAnalyticsPanel` to render the server response.
6. Move pure rendering/CSV helpers beside the component.
7. Delete `apps/web/src/openingAnalytics.ts` and migrate its semantic tests to
   the API.
8. Bump every affected algorithm version for the expiry correction.
9. Add the read-only MCP tool `get_opening_activity`; it calls the same service
   and applies the existing MCP visibility/validation rules.
10. On an algorithm mismatch, have the worker recompute and atomically overwrite
    the one latest snapshot per Home. Until that succeeds, return the old
    snapshot only with its embedded version plus outer status
    `state: "stale-algorithm"`, `expectedAlgorithmVersion`, and
    `actualAlgorithmVersion`. Never mix findings from two versions. The web may
    render the old result only behind an explicit "updating analytics" warning.

Exit gate:

- An observation at `validUntil` is expired everywhere.
- A state after an expiry gap is initial, not a transition.
- Daily findings, opening activity, Home current state, and fixtures agree.
- Inaccessible Home, data-mode mismatch, incomplete archive, truncation,
  unknown state, inversion, heartbeat, and equal-timestamp cases are covered.
- An old persisted snapshot is marked stale, a successful run replaces it
  atomically, a failed run preserves it with a warning, and rollback to an older
  server version triggers the same mismatch/recompute path.
- `apps/api/tests/openapi-parity.test.ts` operation counts/schemas and
  `apps/api/tests/mcp-validation.test.ts` tool validation are updated. The MCP
  name is also added to `READ_ONLY_MCP_TOOL_NAMES`, and
  `apps/api/tests/mcp-server.test.ts` definition counts pass.

### Milestone 3 — Home Performance vertical slice

Deliverables:

1. Move response types to contracts and algorithm code into pure API modules.
2. Replace `AnalyticsQueryResponse` inputs with typed evidence buckets.
3. Implement server evidence collection using internal services, not HTTP calls.
4. Resolve all windows, metrics, visible sensors, safety budgets, and limits in
   the service. Add the <=100,000-point batch planner and combine all batches
   before derivation; do not expose batch boundaries in the result.
5. Add structured per-source evidence states and warnings.
6. Add the bounded/coalescing API cache. Authorize before cache/coalescing,
   prove cross-principal isolation, and implement only the explicit namespace
   invalidations from section 3.3; routine measurement events rely on TTL.
7. Add route, OpenAPI, web API method, and query hook.
8. Reduce `HomePerformancePanel` to loading/error/partial rendering and
   localization.
9. Delete `apps/web/src/homePerformance*` and all query-policy constants from
   the component.
10. Add the read-only MCP tool `get_home_performance`; it invokes the same
     service and never reimplements the algorithm.
11. Enforce the 80-sensor, 500,000-evidence-point, and 1,000,000-response-byte
    limits before returning data.

Exit gate:

- Golden parity fixtures with at most 40 sensors pass except the reviewed
  opening-expiry correction. Separate 41- and 80-sensor fixtures prove full
  scope replaces the old truncation; an 81-sensor fixture proves the typed
  error.
- No React component chooses an evidence range, metric, cap, or source.
- A source failure affects only its section and is visible in the response.
- A history gap never becomes a successful complete result.
- Cache authorization, cross-account coalescing isolation, hit/miss,
  non-invalidation on routine measurement ingest, explicit invalidation, and
  TTL expiry are tested.
- SQLite-only `not-configured`, local-complete, archive `not-ready`, syncing, and
  failed states have explicit section/status assertions.
- `apps/api/tests/openapi-parity.test.ts`, `READ_ONLY_MCP_TOOL_NAMES`,
  `apps/api/tests/mcp-server.test.ts`, and MCP definition/validation counts are
  updated.

### Milestone 4 — Home monitoring and insights across clients

Deliverables:

1. Port Home Pulse, coverage, blocker ordering, and monitoring status into pure
   API modules.
2. Replace English-string identity with stable insight/blocker/action codes and
   structured evidence.
3. Add collection/detail monitoring endpoints, contracts, OpenAPI, and cache
   policy.
4. Replace web `deriveHomePulse` and `deriveHouseMonitoring` calls in Home,
   Portfolio, Alerts, and property status with server results.
5. Keep hiding/expansion/focus behavior in `HomePulsePanel`.
6. Add Swift decoding/API calls and localized presentation for the same codes.
7. Delete or reduce `TodayRecommendation.evaluate` and
   `HomeMonitorSummary.evaluate` to presentation-only mapping.
8. Add the read-only MCP tool `get_home_monitoring`; it calls the same service.
9. Delete `apps/web/src/homeInsights*` and `houseMonitoring.ts`.
10. Gate the new iPhone monitoring/recommendation surfaces on the minimum server
    version obtained from `/api/v1/health`; also map a missing monitoring
    endpoint to `server-upgrade-required`. Do not run the old evaluator as a
    fallback. Other compatible app surfaces remain available.

Exit gate:

- Web, iPhone, Watch/widget summaries, and MCP expose the same semantic status
  from identical server evidence.
- Freshness boundaries at 30 and 120 minutes are tested exactly.
- Weather warning, humidity/CO2/temperature, coverage, alert acknowledgement,
  disconnected source, estimated evidence, and no-sensor states are covered.
- All user-facing codes have English, Finnish, and Swedish presentations or a
  reviewed fallback across the web `en`, `fi-overrides`/`fi-supplement`, and
  `sv` catalogs plus iOS `Localizable.xcstrings`.
- A new iPhone client against an older server shows the upgrade-required state
  without manufacturing a local recommendation; unknown future codes still use
  the reviewed presentation fallback.
- `apps/api/tests/openapi-parity.test.ts`, `READ_ONLY_MCP_TOOL_NAMES`,
  `apps/api/tests/mcp-server.test.ts`, MCP tool definitions, and
  `mcp-validation.test.ts` are updated.

### Milestone 5 — server-side calendar comparison

Deliverables:

1. Move local-calendar period construction and aligned aggregation to the API.
2. Add request/response contracts, validation, endpoint, and OpenAPI.
3. Reuse coverage and archive rollup services internally.
4. Query one bounded rollup per selected period rather than per chart bucket.
5. Return candidate periods, resolved ranges, aligned values, headline
   statistics, quality, and provenance.
6. Replace the component's coverage request, recursive query splitting,
   concurrency pool, accumulator maps, and progress state with one query hook.
7. Keep form state, labels, chart/table mapping, and accessibility in the web.
8. Delete the semantic portion of `calendarComparison.ts`; retain only named
   presentation helpers where justified.
9. Add the read-only MCP tool `compare_calendar_periods` using the same request
   and service contract.
10. Resolve all ranges from the stored Home timezone and reject timezone or UTC
    range fields supplied by a client.

Exit gate:

- DST, leap day, ISO week 53, decade boundaries, cumulative-counter context,
  combined-sensor mean/total rules, incomplete periods, and missing buckets
  pass server tests.
- The browser sends no UTC range math and makes one comparison request.
- Local-complete SQLite-only comparison succeeds; incomplete
  `not-configured`, `not-ready`, syncing, and failed archive states return the
  typed whole-request 503 with no shortened comparison.
- The existing Explorer generic query remains unchanged.
- `apps/api/tests/openapi-parity.test.ts`, `READ_ONLY_MCP_TOOL_NAMES`,
  `apps/api/tests/mcp-server.test.ts`, MCP tool definitions, and
  `mcp-validation.test.ts` are updated.

### Milestone 6 — replace `useClimateData`

Perform this after authoritative analytics no longer depend on the monolithic
browser state.

Work packages:

1. Session and origin lifecycle.
2. Workspace/Property/Home inventory queries.
3. Current Home snapshot and central SSE coordinator.
4. Historical series and replay partition.
5. Sensors and floor-plan mutations.
6. Property/area/equipment/note mutations.
7. Alerts, observations, maintenance, and integrations.
8. Page-specific view models and removal of `ClimateState`.

For each package:

- add query/mutation modules and tests;
- migrate its page consumers;
- delete the corresponding code from the numbered chain immediately;
- update an explicit ownership manifest mapping every query-key family to
  `legacy` or `query-client`; the boundary checker rejects imports from a
  migrated resource back into the legacy chain;
- change all consumers and ownership in one green commit before deleting the
  legacy selectors, so `main` never contains a half-owned resource;
- keep `useAppBootstrap` below 450 lines and orchestration-only.

Final deletions:

- `apps/web/src/useClimateData/part-01.ts` through `part-10.ts`;
- `apps/web/src/useClimateData/render.ts`;
- mechanically split support parts;
- `ReturnType<typeof PreviousPart>` chaining;
- broad mutation/action bags passed through the App when feature-specific hooks
  can own them.

Exit gate:

- Snapshot/SSE race, reconnect refresh, auth purge, demo/live transition,
  optimistic rollback, sensor move ordering, mutation-during-load replay, and
  historical-series cancellation tests pass.
- Event/byte/time hydration-buffer overflow discards the snapshot and re-fetches
  without unbounded growth; the three-attempt failure path is visible.
- No page receives the complete former `ClimateState`.
- No component subscribes to SSE directly.
- Query data is not persisted to browser storage.

### Milestone 7 — cleanup, hardening, and documentation

Deliverables:

1. Remove temporary parity adapters, shadow comparators, flags, dead contracts,
   and unused translations.
2. Run an import/reference search proving every deleted derivation has no caller.
3. Update `docs/architecture.md`, `docs/analytics-foundation.md`,
   `docs/source-file-modularization.md`, `apps/ios/README.md`, OpenAPI docs, and
   `docs/known-limitations.md`.
4. Document the retained experimental-visualization boundary in
   `docs/airflow-simulation.md`.
5. Add API analytics diagnostics and the benchmark script.
6. Run the complete build/test/version suite.

Exit gate:

- The deletion inventory is empty.
- Architecture checks prevent reintroduction.
- Documentation describes actual, not transitional, behavior.

## 10. Testing strategy

### 10.1 Pure algorithm tests

- Synthetic, deterministic fixtures only.
- Explicit clock and timezone.
- Boundary-value tests for every threshold.
- Invariants for interval non-overlap, non-negative durations, deterministic
  ordering, and count/record consistency.
- Pinned psychrometric reference vectors and floating-point tolerances.
- Daily-findings fixtures for old/current algorithm versions and atomic
  replacement behavior.

### 10.2 API integration tests

For every endpoint:

- Owner/Admin and Guest visibility;
- inaccessible/missing Home behavior;
- live/demo mismatch;
- local-complete SQLite fallback plus archive `not-configured`, `not-ready`,
  syncing/reconciled, and failed behavior for each endpoint;
- source truncation and oversized scope;
- partial source failure;
- abort/cancellation;
- response/OpenAPI schema parity;
- cache isolation and invalidation where used, including two principals on the
  same Home entering the coalescing path concurrently.

### 10.3 Web tests

- Query loading, abort, retry, partial, unavailable, and reconnect states;
- typed event-to-invalidation mapping;
- hydration-buffer merge and event/byte/time overflow re-fetch;
- optimistic mutation rollback;
- keyboard, focus restoration, live-region announcements, 320 px/zoom behavior,
  and automated accessibility checks;
- localized semantic-code presentation;
- charts/tables/CSV use server values without recalculation;
- routine measurement ingest does not invalidate Home Performance, while a
  sensor/topology mutation does.

### 10.4 iPhone tests

- Contract decoding and unknown-code forward compatibility;
- server status/recommendation presentation;
- protected offline snapshot behavior;
- Watch/widget projection;
- English/Finnish/Swedish fallback;
- no remaining independent threshold evaluation;
- upgrade-required behavior for an older server and unknown-code behavior for a
  newer server.

### 10.5 Commands

Focused work:

```powershell
npm run build:packages
npm run test --workspace @climate-twin/api -- tests/analytics.test.ts tests/daily-analytics-findings.test.ts tests/timeseries-analytics-rollup.test.ts tests/timeseries-read-facade.test.ts tests/openapi-parity.test.ts tests/mcp-validation.test.ts tests/mcp-server.test.ts
npm run test --workspace @climate-twin/web -- src/pages/DataAnalyticsPage.test.tsx src/components/OpeningAnalyticsPanel.test.tsx src/components/CalendarPeriodComparison.test.tsx src/pages/PortfolioOverview.test.tsx src/pages/AlertsPage.test.tsx
npm run typecheck --workspace @climate-twin/api
npm run typecheck --workspace @climate-twin/web
swift test --package-path apps/ios
```

Before each merge:

```powershell
npm run check:file-size
npm run typecheck
npm test
npm run version:check
```

Correct any focused test paths that differ when files are moved; do not weaken
the suites to match this plan.

## 11. Performance and observability

Capture per request without logging raw values:

- endpoint and algorithm version;
- duration;
- cache hit/miss/coalesced status;
- visible sensor and series counts;
- requested/returned bucket counts;
- archive state and reconciliation wait;
- evidence-source state;
- stable error/warning codes.

Expose bounded aggregate diagnostics to the existing owner-visible operational
status; do not expose sensor IDs or measurements.

Provisional Home Performance budgets on the benchmark fixture:

- cold 40-sensor request: under 2.5 seconds;
- warm cache request: under 150 ms;
- bounded response: under 1 MiB;
- no raw 30-day series serialized to the browser.

The evidence planner enforces 80 sensors and 500,000 internal points before any
read. The response mapper measures UTF-8 JSON bytes before sending and rejects
anything above 1,000,000 bytes with typed
`HOME_PERFORMANCE_SCOPE_TOO_LARGE`. The benchmark includes routine two-second
measurement events and must still exercise a warm cache hit.

Calendar comparison should make at most two archive rollup calls for two
selected periods, plus coverage metadata if not obtainable in the same read.
Record a benchmark before enforcing timing in CI; functional point/read limits
remain hard gates.

## 12. Rollout and rollback

- Use vertical slices. Do not leave both browser and server derivations active
  after a slice closes.
- During development of a slice, a test-only or development-only shadow
  comparator may record old/new fixture differences. It must be removed by the
  slice deletion gate.
- Prefer additive contracts and endpoints until the client in the same slice is
  ready, then delete the old browser implementation.
- No milestone rewrites raw telemetry or control-plane records.
- On-demand endpoints require no schema rollback.
- Daily-finding storage remains one latest snapshot per Home. A version bump
  does not blend or bulk-rewrite JSON in place: the worker sees the mismatch,
  recomputes, and atomically replaces the row. Until success, the API exposes
  the prior embedded version as `stale-algorithm`; on rollback, the same process
  recomputes for the reverted version.
- If a slice must be reverted, revert its client, endpoint, contracts, and
  algorithm together. Never restore a divergent client calculation as a silent
  fallback.
- Older web/iPhone builds may be incompatible after a pre-1.0 breaking release;
  state this in the changelog and upgrade notes. A newer iPhone paired with an
  older server must show `server-upgrade-required` for monitoring rather than
  silently restoring its local evaluator.

## 13. Explicit non-goals

- No general analytics job queue or durable result platform.
- No new reusable analytics workspace package.
- No rewrite or server migration of airflow, spatial volume/field, or outdoor
  influence visualization.
- No replacement of TimescaleDB, SQLite, `HybridTelemetryReader`, or current raw
  retention rules.
- No deletion of the generic analytics query/coverage endpoints.
- No causal, diagnostic, mould, certified-efficiency, or calibrated-airflow
  claims.
- No generated API-client project across TypeScript and Swift in this program.
- No browser-persisted server-state cache.
- No broad visual redesign; existing DESIGN.md behavior and accessibility gates
  remain release criteria.

## 14. Estimate and staffing

Estimated effort: 13-16 senior-engineer weeks, including iPhone parity and the
full `useClimateData` replacement.

Approximate allocation:

| Work | Engineer-weeks |
| --- | ---: |
| Baseline, decomposition, contracts, guardrails | 1.5-2 |
| Opening semantics/activity | 1 |
| Home Performance | 2-2.5 |
| Monitoring/insights, three-locale presentation, iPhone/MCP | 3-3.5 |
| Calendar comparison | 1-1.5 |
| Web data layer replacement | 3.5-4.5 |
| Hardening, benchmarks, docs, deletion | 1 |

One senior owner should control contracts and semantic decisions. A second
engineer can parallelize client presentation/tests after each server contract
stabilizes, but should not independently port algorithms.

## 15. Definition of done

- No React or SwiftUI component selects analytics evidence or derives product
  conclusions.
- Web, iPhone, Watch/widget, REST, and MCP use the same server semantics where
  they expose the same feature.
- Opening expiry and transition behavior is identical everywhere.
- Every derived output is versioned, reproducible from stated inputs, and honest
  about missing/incomplete evidence.
- No arbitrary browser sensor truncation or recursive analytics query fan-out
  remains.
- `useClimateData` and its numbered chain are deleted.
- Retained frontend logic is explicitly presentation or experimental
  visualization.
- Source files are split by ownership, stay below review thresholds, and pass
  the architecture boundary check.
- Old implementations, temporary adapters, and shadow code are removed.
- Focused, full, Swift, OpenAPI, version, and accessibility gates pass.

## 16. Review record

The plan received two Claude principal-engineer passes through the repository's
multi-LLM review workflow:

1. The architecture pass reviewed the authority boundary, persistence choices,
   client/server split, sequencing, and the concrete opening-expiry divergence.
2. The implementation pass reviewed Milestones 3-7, testing, performance,
   rollback, estimates, and done criteria.

Accepted amendments include deterministic Home Performance limits, protection
from two-second telemetry cache churn, explicit SQLite-only behavior,
authorization-safe coalescing, iPhone/server compatibility, persisted
algorithm-version coexistence, bounded hydration buffers, stored-timezone
authority, complete MCP registration gates, response-size enforcement, and a
larger implementation estimate. Findings that contradicted the checked
worktree—such as claims that the plan ended at Milestone 2 or that existing
version/check scripts were absent—were rejected after local verification.

### Post-implementation Claude review (2026-07-29)

The completed 0.20.0 implementation and this stored plan received separate
Claude reviews before release. The following release amendments are binding:

1. Deploy API and web atomically before relying on the iPhone 0.20.0 monitoring
   feature gate. A server rollback to 0.19.x must visibly return the iPhone to
   `serverUpgradeRequired`; it must never run a local semantic fallback.
2. After deployment, verify the daily-findings worker replaces every
   `stale-algorithm` v1 snapshot with v2 output. A recorded worker error takes
   precedence over stale status so clients do not poll indefinitely.
3. Verify shutdown removes the analytics cache wake handle even in partial
   startup/teardown paths, and verify the process closes cleanly.
4. Treat calendar DST, leap-day, ISO week 53, and decade fixtures as permanent
   server regression coverage after deleting the browser implementation.
5. Keep OpenAPI operation-set equality, MCP handler/visibility checks, the
   architecture boundary check, version consistency, full web/API tests, and
   macOS Swift tests as release gates. Numeric operation counts are secondary
   guards, not the parity proof.
6. Label demo-derived iPhone monitoring/recommendations explicitly and verify
   the label in the macOS Swift test gate.
7. On the Raspberry Pi, validate current version, health, monitoring endpoints,
   daily-findings recomputation, SSE reconnect, and retained telemetry after the
   OTA update. Roll back the complete application release if any gate fails.

The review's claimed missing thermal API tests was rejected because the
assertions were moved intact to `api.thermal-simulation.test.ts`. Its proposed
opening double-count issue was also rejected: canonical normalization
deduplicates identical provider/external-id/connection/timestamp observations
before transition derivation. OpenAPI already compares the complete documented
and runtime operation sets, so replacing count-only parity was unnecessary.
