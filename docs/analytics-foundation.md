# Analytics foundation and Explorer

This document records the first production-usable slice of the Graphing,
Statistics, Prediction and Findings specification. It deliberately implements
the evidence foundation before psychrometrics, inference, findings, or new
forecast models.

## What is implemented

- A registry-backed measurement model with physical dimension, allowed units,
  measurement kind, default aggregation, and generic history/statistics gates.
- A side-effect-free `POST /api/v2/analytics/query` endpoint with an explicit
  `dataMode`, strict request validation, house and sensor authorization, bounded
  source reads, automatic resolution, and machine-readable failures.
- Measurement-aware UTC rollups at 1 minute, 5 minutes, 15 minutes, 1 hour, or
  1 day. Missing buckets remain `null`; they are never zero-filled.
- Coverage, sample count, minimum/maximum envelopes, mean, median, sample
  standard deviation, median absolute deviation, p05, and p95.
- Time-weighted means for rate measurements and reset-aware interval deltas for
  cumulative counters. A counter's last value is carried across a bucket edge
  only to calculate the next delta; it is not emitted as a synthetic sample.
- Truth-class and provenance metadata. Raw points are labelled `observed` with
  aggregation `raw`; rollups are labelled `derived` with algorithm version
  `1.0.0`.
- An Explorer evidence section with progressive summaries, coverage warnings,
  a keyboard-focusable data table, and CSV/JSON export. CSV formula prefixes are
  neutralized, and exported rows include data mode, query scope/range,
  timezone, units, truth class, aggregation, quality, and algorithm version.
- Explorer evidence controls for explicit or automatic resolution,
  measurement-aware aggregation, and source-quality inclusion. The default
  excludes stale samples without treating them as missing or zero, and exports
  record both the selected filter and the excluded-source-sample count.
- Explorer ranges for 6 hours, 24 hours, 7 days, 30 days, 90 days, and 1 year,
  with range-aware server buckets, query budgets, labels, and visible-gap
  thresholds.
- OpenAPI and shared TypeScript contracts for the query and response.

## Repository assessment

The implementation reuses the existing architecture:

| Concern | Existing path reused | Decision |
| --- | --- | --- |
| Canonical measurements | `packages/contracts`, v2 measurement definitions and samples | Extend the registry without changing package names or the ingest contract. |
| Primary telemetry | SQLite measurement samples | Read through the database's bounded multi-series window. |
| Historical archive | Hybrid SQLite/Timescale reader | Merge through the existing read facade and expose archive state in provenance. |
| Data-mode isolation | One-way database-wide demo-to-real transition | Require `demo` or `live` in every analytics request and reject the mode not active in the local database. |
| API conventions | Express v1/v2 routes, local authorization, OpenAPI parity tests | Put registry analytics in v2 and treat the complex POST as read-only for guest/CSRF/mutation-event rules. |
| UI | Existing Data & analytics route and SVG sensor chart | Add evidence below the chart; do not replace the chart renderer in this slice. |
| State and requests | Existing React state and API client | Use an abortable query tied to house, metric, entities, range, mode, and refresh revision. |
| Jobs | Existing background-worker patterns | No job is needed for bounded, on-demand descriptive queries. Persisted rollups and expensive models remain future work. |
| LLM use | None required | All values are deterministic; no raw series is sent to an LLM. |

## Query contract

Example request:

```json
{
  "apiVersion": "1.0",
  "dataMode": "live",
  "scope": {
    "kind": "house",
    "id": "house-main",
    "entityIds": ["sensor-01", "sensor-02"]
  },
  "measurementIds": ["temperature"],
  "range": {
    "start": "2026-07-19T00:00:00.000Z",
    "end": "2026-07-20T00:00:00.000Z",
    "timezone": "Europe/Helsinki"
  },
  "resolution": "auto",
  "aggregation": "default",
  "qualityFilter": {
    "include": ["good", "estimated"]
  },
  "include": ["series", "summary", "quality", "provenance"],
  "maxPointsPerSeries": 500,
  "requestId": "explorer-temperature-24h"
}
```

The current interactive bounds are:

- one house per query;
- 1-50 explicitly selected sensors, or all enabled accessible sensors in the
  house;
- 1-8 measurement IDs;
- a historical range no longer than ten years and no future end time;
- 100-5,000 points per series;
- at most 100,000 projected output points;
- fewer than 250,000 source samples in the merged interactive window.

Explicit resolutions that exceed the per-series budget fail instead of being
silently truncated. `auto` chooses the finest supported UTC resolution that
fits the requested budget. Raw queries also fail when the actual series exceeds
the budget.

## Aggregation rules

| Measurement kind | Default | Other interactive choices |
| --- | --- | --- |
| Gauge | Mean | Last, minimum, maximum |
| Rate | Time-weighted mean | Mean, last, minimum, maximum |
| Increment | Sum | Last, minimum, maximum |
| Cumulative counter | Reset-aware delta | Last, minimum, maximum |
| Binary state | Last | Mean |
| Categorical state | Last | None |

`duration` and custom aggregations require a specialized module and are rejected
by the generic query. For example, summing temperature is rejected. The
time-weighted mean caps the final hold interval at 1.5 times the inferred median
cadence so a lone old value cannot silently fill a long gap.

## Architecture decisions

1. **On-demand rollups first.** The query performs deterministic rollups over
   the hybrid reader. Persisted rollup tables are deferred until measured query
   volume justifies their migration and invalidation complexity.
2. **No cache in the first slice.** Responses use `Cache-Control: no-store` and
   report `cache.hit: false`. This avoids stale results while late-data
   invalidation and semantic cache keys are not implemented.
3. **Keep the current chart renderer.** The existing chart already supports the
   selected multi-sensor use case and visible gaps. A general chart-spec adapter
   and ECharts evaluation belong in a later Explorer slice with saved views,
   brushing, overlays, and linked panels.
4. **Use the current database-wide data partition.** Stuga already permanently
   purges demo telemetry when real mode is activated and filters synthetic
   archive rows in real mode. The analytics API adds mandatory mode guards but
   does not pretend that current telemetry rows have the per-row `dataMode`
   schema required by the complete specification.
5. **No statistical or scientific claims yet.** Robust descriptive summaries
   are included. Correlation, causality, psychrometrics, anomalies, forecasts,
   and findings need separately versioned methods, validation data, and user
   wording rules.

## Gap matrix and next increments

| Specification area | Current state | Next sensible increment |
| --- | --- | --- |
| Live/demo isolation | Explicit and fail-closed at query/export boundaries; database remains a single irreversible mode | Add per-row mode keys only as a coordinated storage/archive migration with cross-mode constraint tests. |
| Registry and units | Core semantics persisted and exposed; canonical ingest validation already exists | Add dimension-checked transformations and explicit conversion registry. |
| Explorer | Multi-sensor/single-measurement chart, explicit or auto rollup evidence controls, 6h-1y ranges, table, CSV/JSON | Add brush selection, comparison periods, and saved views. |
| Quality | Missing, stale, source-estimated, low-coverage, and counter-reset flags; source-quality inclusion is explicit and exportable | Preserve richer source timestamps/flags and add declared interpolation policies. |
| Rollups | Correct bounded on-demand UTC buckets | Add persisted rollups, source watermarks, late-data invalidation, and local-time daily buckets with 23/24/25-hour DST tests. |
| Descriptive statistics | Core robust summaries | Add histogram/distribution and duration statistics where registry semantics allow them. |
| Psychrometrics | Deferred | Pin a trusted library and add reference vectors before dew point or moisture claims. |
| Statistics/findings | Deferred | Add versioned detectors only after autocorrelation, practical-effect, coverage, and multiple-testing policies exist. |
| Topology dynamics | Deferred | First version topology snapshots and placement intervals; then validate lag/coupling models on synthetic scenarios. |
| Forecasts | Existing simple forecast paths are unchanged and are not promoted by this work | Add naive baselines, rolling-origin evaluation, intervals, promotion gates, and model cards before new production forecast claims. |
| Predictive maintenance | Deferred | Build only from registered evidence outputs with persistence, confirmation, and maintenance linkage. |

## Migration and rollback

Startup migration adds registry columns with conservative defaults and backfills
an existing definition's allowed-unit list with its canonical unit. Built-in
definitions are then assigned explicit semantics. No telemetry sample is
rewritten and no analytic result is persisted.

An older application can ignore the additive SQLite columns. The endpoint and
Explorer evidence section can be rolled back without deleting source history or
losing stored analytic artifacts because this slice creates none.

## Verification

Focused coverage includes strict/mismatched data modes, invalid aggregation,
source-quality inclusion and rejection, raw labelling, output budgets,
reset-aware deltas across bucket boundaries, registry migration compatibility,
OpenAPI parity, Explorer controls and long-range rendering, visible-gap
thresholds, and safe CSV metadata/export. Run:

```powershell
npm run build:packages
npm run test --workspace @climate-twin/api -- tests/analytics.test.ts tests/measurements.test.ts tests/openapi-parity.test.ts
npm run test --workspace @climate-twin/web -- src/pages/DataAnalyticsPage.test.tsx src/components/SensorAnalyticsChart.test.tsx src/chartGaps.test.ts src/measurements.test.ts
npm run typecheck --workspace @climate-twin/api
npm run typecheck --workspace @climate-twin/web
```

A local deterministic smoke run rolled up 50,000 one-minute inputs across ten
series into 10,000 five-minute output points in 88.7 ms on the development
machine. This is a directional implementation result, not a CI performance
gate. Formal overview/30-day/multi-year benchmarks, archive-I/O measurements,
and persisted-rollup comparisons are still required before raising the
interactive limits.
