# Analytics foundation and Explorer

This document records the first production-usable slice of the Graphing,
Statistics, Prediction and Findings specification. It implements the evidence
foundation plus a deliberately narrow daily descriptive-finding layer before
psychrometrics, causal inference, or new forecast models.

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
- Calendar-period comparison for the active all/single/multiple-sensor
  selection. A user can compare the same house-local calendar day, ISO week, or
  month across years, every recorded calendar year, or calendar decades. The
  view preserves missing periods, exposes sample coverage, and supports the
  registry-valid calculation and source-quality choices.
- A side-effect-free `POST /api/v2/analytics/coverage` discovery endpoint. It
  merges the SQLite hot tail and Timescale archive span for each selected series
  and marks the result incomplete when an unavailable archive could contain
  older matching periods.
- A persisted daily month-to-date comparison run for each Home. It evaluates
  only fully completed house-local dates and compares the same number of days
  with up to five earlier matching months. This prevents a partial July from
  being compared with a complete prior July.
- Versioned, deterministic notable-difference detectors for registered indoor
  sensor series, observed outdoor temperature, electricity power/energy
  measurements, and door/window open transitions. Repeated open heartbeats,
  startup snapshots, and `unknown` states are not counted as opening events.
- A read-only `GET /api/v2/analytics/findings?houseId=…` endpoint and a Data &
  analytics panel with the current value, prior-period median, direction,
  practical effect, peer years, sample counts, coverage where it can be
  estimated, and explicit archive/truncation warnings.
- A coverage-aware Home performance layer that derives six practical checks
  from existing climate, opening, outdoor, electricity, maintenance, and
  observation evidence. It keeps missing evidence unavailable, marks limited
  confidence explicitly, and exposes the algorithm version and source scope.
- Optional bounded history on the existing
  `GET /api/v1/houses/:id/opening-states` endpoint. The response preserves the
  current snapshot contract while adding ordered observations for a requested
  `from`/`to` window, including the effective leading state needed to identify
  real closed-to-open transitions.
- OpenAPI and shared TypeScript contracts for the query, coverage discovery,
  daily findings, and responses.

## Repository assessment

The implementation reuses the existing architecture:

| Concern | Existing path reused | Decision |
| --- | --- | --- |
| Canonical measurements | `packages/contracts`, v2 measurement definitions and samples | Extend the registry without changing package names or the ingest contract. |
| Primary telemetry | SQLite measurement samples | Read through the database's bounded multi-series window. |
| Historical archive | Hybrid SQLite/Timescale reader | Merge samples and per-series coverage through the existing read facade, exposing incomplete archive state instead of silently shortening comparisons. |
| Data-mode isolation | One-way database-wide demo-to-real transition | Require `demo` or `live` in every analytics request and reject the mode not active in the local database. |
| API conventions | Express v1/v2 routes, local authorization, OpenAPI parity tests | Put registry analytics in v2 and treat the complex POST as read-only for guest/CSRF/mutation-event rules. |
| UI | Existing Data & analytics route and SVG sensor chart | Add evidence below the chart; do not replace the chart renderer in this slice. |
| State and requests | Existing React state and API client | Use an abortable query tied to house, metric, entities, range, mode, and refresh revision. |
| Jobs | Existing background-worker patterns | A six-hourly idempotent worker guarantees at most one successful snapshot per house-local completed date; interactive rollups remain on demand. |
| LLM use | None required | All values are deterministic; no raw series is sent to an LLM. |

## Daily finding contract

The background worker wakes at startup and every six hours, but the
`evaluatedThrough` fence permits only one normal successful snapshot for each
completed house-local date unless a sensor, timezone, location, or opening
configuration change invalidates it. This accommodates Homes in different timezones
without one global midnight assumption. A forced test/embedding run can replace
the same date atomically; production has no mutation endpoint for findings.

The current window begins on the first local date of the month containing the
last completed local date. Each peer window uses the same month and completed
day number in up to five prior years. February peers clamp to the final valid
date where necessary. Baselines use the median of usable peers, and every card
retains the individual peer values instead of hiding them behind the median.

Initial practical reporting thresholds are versioned with
`calendar-peer-findings-v1.0.0`:

- temperature: at least 1 °C (strong at 2 °C);
- relative humidity: at least 5 percentage points (strong at 10);
- CO2: at least 100 ppm (strong at 250 ppm);
- electricity: at least 10% plus a unit-specific floor (0.5 kWh or 50 W for
  the built-ins; strong at 25%);
- opening activity: at least three confirmed opens (strong at ten);
- other registered finite measurements: at least the registry interpolation
  delta and 20% (strong at 40%).

Sensor and outdoor periods require at least 50% inferred coverage. Opening
streams expose observation counts but use `coverage: null`, because transition
history cannot prove continuous source uptime. The persisted response contains
at most 16 ranked findings; source scope is bounded to 80 recorded
sensor/measurement series with an explicit warning when that limit is reached.

## Home performance checks

The Data & analytics page now adds a Home-owned, progressively disclosed
performance panel. Its collapsed view shows four conclusions: the share of
available room-climate measurement-hours inside their guide, median moisture
half-recovery time, weather-normalized energy, and monitoring coverage. Opening
all checks reveals the six derivations, typed limitations, room/sensor evidence,
and provenance. The implementation is deterministic and versioned as
`home-performance-v1.0.0`.

The current derivations are:

1. **Comfort and air-quality exposure.** Up to 30 days of hourly temperature,
   relative-humidity, and CO2 rollups are compared with the initial guide bands
   of 18-25 C, 30-60% RH, and 1,000 ppm CO2. The result reports coverage-weighted
   share of available metric-hours in range, sensor-hours outside the
   humidity/CO2 guides, and temperature degree-hours outside the guide. Missing
   buckets contribute no duration and are never treated as normal readings.
2. **Moisture recovery.** Seven days of 15-minute temperature and humidity
   evidence are converted to absolute humidity with the pinned Magnus formula.
   Rises of at least 0.8 g/m3 are treated as candidate moisture episodes. For
   episodes with enough before-and-after evidence, the check reports the median
   time to recover half of the rise, bounded to a six-hour recovery window.
   Buckets must have at least 50% coverage and be adjacent 15-minute buckets; a
   missing interval ends the candidate rather than being bridged.
   This is an event-recovery comparison, not a mould or ventilation diagnosis.
3. **Fresh-air response after openings.** Recorded closed-to-open transitions
   are de-duplicated from state heartbeats, associated with a nearby same-floor
   climate sensor, and evaluated for a material CO2 or absolute-humidity
   decline. An `unknown` contact state or expired prior observation breaks the
   transition sequence instead of carrying an older closed state across an
   evidence gap. The same coverage and continuity gates prevent sparse
   after-data from being interpreted as a response. The result reports evaluable
   and effective events plus median clearance time. It does not infer airflow
   rate or claim that the opening caused the change.
4. **Weather-normalized energy.** Recorded kWh, or integrated power when a
   cumulative energy series is unavailable, is divided by heating degree-hours
   from the same hourly buckets using an 18 C base. At least 24 overlapping
   hourly buckets and 24 heating degree-hours are required. A bucket needs at
   least 75% source coverage, and multi-meter totals use only hours represented
   by every selected meter. Per meter, a usable cumulative-energy delta is
   preferred and integrated power fills its missing hours. Heating-tagged
   meters are preferred. A bidirectional power series is not reinterpreted as
   consumption without an explicit import/export semantic. Totals from meters
   not identified as heating-specific are allowed only as explicitly limited
   context because they may include non-heating loads or cover only part of the
   Home. The value is not a certified efficiency rating.
5. **Measured action outcomes.** Completed action-verification runs are grouped
   into goals met and not improved, linked back to maintenance items, and
   compared with completed items that do not yet have measured before/after
   evidence. Recurring observations are retained in the derived result as
   supporting context. No result is created merely because a task was marked
   complete.
6. **Sensor reliability.** Recorded series are checked for less than 75%
   coverage, unusually flat climate/power values, and a material change in
   offset from peer sensors between the two halves of the window. Findings are
   phrased as placement/calibration checks to review, not confirmed sensor
   failures.

The interactive panel is limited to the first 40 enabled sensors in stable
identifier order so each query stays within the existing 100,000-point analytics
budget. Action evidence is requested for the selected Home rather than from the
cross-Home ledger. A history that reaches its fixed request cap is also marked
limited rather than silently treated as complete. Truncation, incomplete archive
state, missing opening history, unclassified electricity evidence, incomplete
maintenance verification, and low coverage are all surfaced as explicit
limitations. A failed evidence request does not suppress the other checks; the
panel presents the remaining results with a partial-evidence notice.

The evidence query and thermal-isolation calculation are lazy: opening their
disclosures starts the request, and closing an in-flight thermal calculation
cancels it.

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
3. **Keep the current rolling chart renderer.** The existing chart continues to
   handle rolling multi-sensor history and visible gaps. Calendar comparisons
   use a focused renderer below it and reuse the same sensor selection. A
   general chart-spec adapter and ECharts evaluation belong in a later Explorer
   slice with saved views, brushing, overlays, and linked panels.
4. **Use the current database-wide data partition.** Stuga already permanently
   purges demo telemetry when real mode is activated and filters synthetic
   archive rows in real mode. The analytics API adds mandatory mode guards but
   does not pretend that current telemetry rows have the per-row `dataMode`
   schema required by the complete specification.
5. **Descriptive findings only.** The daily detector uses versioned practical
   thresholds and peer-period medians. It says warmer/cooler, higher/lower, or
   more/fewer; it does not call a cause, diagnose equipment, or claim a formal
   statistical anomaly. Correlation, causality, psychrometrics, and scientific
   anomaly detection still need separate validated methods.

## Gap matrix and next increments

| Specification area | Current state | Next sensible increment |
| --- | --- | --- |
| Live/demo isolation | Explicit and fail-closed at query/export boundaries; database remains a single irreversible mode | Add per-row mode keys only as a coordinated storage/archive migration with cross-mode constraint tests. |
| Registry and units | Core semantics persisted and exposed; canonical ingest validation already exists | Add dimension-checked transformations and explicit conversion registry. |
| Explorer | Multi-sensor/single-measurement rolling chart, explicit or auto rollup evidence controls, 6h-1y ranges, calendar day/week/month/year/decade comparisons, accessible tables, CSV/JSON | Add brush selection and saved views. |
| Quality | Missing, stale, source-estimated, low-coverage, and counter-reset flags; source-quality inclusion is explicit and exportable | Preserve richer source timestamps/flags and add declared interpolation policies. |
| Rollups | Correct bounded on-demand UTC buckets | Add persisted rollups, source watermarks, late-data invalidation, and local-time daily buckets with 23/24/25-hour DST tests. |
| Descriptive statistics | Core robust summaries | Add histogram/distribution and duration statistics where registry semantics allow them. |
| Psychrometrics | A pinned Magnus calculation supports bounded within-event absolute-humidity recovery comparisons; no dew point, mould, or diagnostic claim is exposed | Add independent reference vectors and a reviewed library before broader psychrometric outputs. |
| Statistics/findings | Daily practical-effect peer-period findings with persisted evidence; no causal or inferential claims | Add source-declared cadence, robust seasonal models, autocorrelation-aware uncertainty, multiple-testing control, user confirmation, and longer detector validation before calling results statistical anomalies. |
| Topology dynamics | Deferred | First version topology snapshots and placement intervals; then validate lag/coupling models on synthetic scenarios. |
| Forecasts | Existing simple forecast paths are unchanged and are not promoted by this work | Add naive baselines, rolling-origin evaluation, intervals, promotion gates, and model cards before new production forecast claims. |
| Predictive maintenance | Completed measured-action outcomes and recurring observations are linked as descriptive evidence; no failure forecast or diagnosis | Add persisted confirmation workflows and validated failure labels before predictive models. |

## Migration and rollback

Startup migration adds registry columns with conservative defaults, backfills
an existing definition's allowed-unit list with its canonical unit, and creates
one cascade-deleted latest-findings row per Home. Built-in definitions are then
assigned explicit semantics. No telemetry sample is rewritten. Crossing the
one-way demo-to-real boundary deletes demo findings before live findings can be
written.

An older application can ignore the additive SQLite table. The endpoint, worker,
and panels can be rolled back without deleting source history; only the latest
derived findings snapshot would become unused.

## Verification

Focused coverage includes strict/mismatched data modes, archive-aware coverage
discovery, invalid aggregation, source-quality inclusion and rejection, raw
labelling, output budgets, reset-aware deltas across bucket boundaries,
registry migration compatibility, OpenAPI parity, house-timezone calendar
boundaries, DST, leap days, ISO week 53, decade segmentation, fair partial-month
windows, persisted daily idempotency, weather/electricity/opening detection,
heartbeat-safe opening counts, Explorer controls and long-range rendering,
visible-gap thresholds, and safe CSV metadata/export.
Run:

```powershell
npm run build:packages
npm run test --workspace @climate-twin/api -- tests/analytics.test.ts tests/timeseries-read-facade.test.ts tests/measurements.test.ts tests/openapi-parity.test.ts tests/app.test.ts
npm run test --workspace @climate-twin/web -- src/homePerformance.test.ts src/calendarComparison.test.ts src/components/CalendarPeriodComparison.test.tsx src/pages/DataAnalyticsPage.test.tsx src/components/SensorAnalyticsChart.test.tsx src/chartGaps.test.ts src/measurements.test.ts
npm run typecheck --workspace @climate-twin/api
npm run typecheck --workspace @climate-twin/web
```

A local deterministic smoke run rolled up 50,000 one-minute inputs across ten
series into 10,000 five-minute output points in 88.7 ms on the development
machine. This is a directional implementation result, not a CI performance
gate. Formal overview/30-day/multi-year benchmarks, archive-I/O measurements,
and persisted-rollup comparisons are still required before raising the
interactive limits.
