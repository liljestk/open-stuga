# Analytics and adaptive monitoring delivery ledger

Approved scope: all analytics gaps discussed on 12 November 2026, delivered in
staged milestones alongside [adaptive Home monitoring](adaptive-monitoring-plan.md).
Baseline: `origin/main` at `d7c9c9f1` (0.62.2). No appliance change is authorized.

## Milestone 1 — deterministic foundations

Implemented in the 0.63.0 candidate:

- Shared adaptive evidence/replay contracts and engineering materiality floors.
- A pure readiness audit requiring adequate coverage in each of four fixed
  chronological weeks, respecting epoch, source, quality and archive readiness.
  This audits supplied evidence only; it is not an audit of the appliance.
- Bounded fixed-baseline replay with availability-aware predictions/calibration,
  missing-hour abstention, context guards, sustained departures, recovery,
  frozen calibration and seven-day expiry. Outputs are retrospective and
  explicitly ineligible for advisory promotion.
- `npm run evaluate:adaptive` produces reproducible synthetic results for
  persistence and same-hour-yesterday. `-- --output PATH` writes a new receipt;
  store receipts outside Git. The fixed cases include daily rhythm, sustained
  change, an isolated spike, an outage and delayed recovery. This is the start
  of adaptive milestone B, not completion of its complete scenario/evidence matrix.
- Optional `include: ["distribution"]` on the existing analytics query returns
  equal-width histograms and quartiles per series. Raw observations and display
  buckets are labelled separately; missing/nonfinite values are excluded and
  counted. Bin counts describe equally weighted values, not elapsed time or
  independent physical measurements. Existing summaries remain unchanged.

The synthetic step demonstrates limitations rather than a passing detector:
persistence misses it; same-hour-yesterday detects it but also opens an
unmatched episode the next day. No learned model, production job, adaptive
endpoint, UI, or live pilot is enabled by this milestone.

## Milestone 2 — saved views, range selection and distributions UI

Still to implement:

- Home-owned saved query definitions, private to a durable signed-in principal;
  preserve mode, metric, sensor selection, resolution, aggregation, quality and
  relative/absolute range. Store definitions, not cached measurements. Recheck
  Home/sensor visibility whenever a view is loaded or executed. Reject stale
  revisions and cross-scope references. Account removal and Home retirement
  must have explicit behavior. Do not silently reuse another person's browser state.
- Pointer brush selection plus equivalent labelled start/end controls. A
  committed selection becomes the canonical half-open query range in the URL;
  refresh, Back/Forward, copied links and exports preserve it. Cancel retains
  the prior range, and Home/mode changes cannot carry incompatible selections.
- Distribution chart and accessible table using the server's declared basis,
  units and bin boundaries, with explicit absence/partial-history states.
  Histogram data must pass validation at the web request boundary.
- Complete EN/FI/SV copy, role/mode tests and blocking visual acceptance for the
  actual workflows and representative states under `DESIGN.md`.

## Milestone 3 — data isolation and invalidation

Still to implement:

- Inventory every SQLite/Timescale raw, current, outbox, aggregate, export and
  derived store before changing schemas. Write one coordinated, versioned
  migration for explicit per-record data mode and mode-scoped identities/indexes.
  Existing database-wide demo-to-real isolation remains the production boundary
  until that migration and restore/rollback checks pass.
- Rebuild and validate affected aggregate identities and queries; prove demo
  observations cannot contribute to live summaries, model calibration, exports
  or recovery imports, including an in-flight mode transition. Preserve real
  history and immutable ownership. Unknown legacy lineage must fail closed.
- Audit late-data dependencies beyond the three durable analytics artifact
  kinds. Existing generic query caches already include telemetry-history
  revisions; do not replace that with a duplicate invalidation mechanism.
  Add invalidation only for uncovered inputs and jobs; prove changed historical
  evidence refreshes the affected result without refreshing unrelated windows.
- Record migration size/runtime, archive preparation behavior, backup/restore,
  cancellation and ingestion/foreground impact on a representative Pi.

## Milestone 4 — adaptive persistence, execution and review

Continue milestones A–F in the adaptive plan: authorized evidence audit,
complete causal evaluation matrix, revisioned settings/epochs/reference groups,
models, predictions, episodes and reviews; governed worker; canonical routes
and access controls; then review/settings UI with visual acceptance.

Reuse the existing forecasters and reliability rules. Their six-hour forecast
display gate is not a qualification gate for one-hour anomaly detection. Freeze
selection policies before final holdout; test sensor reference comparisons
separately. Requests read persisted results and never start numerical fitting.

## Milestone 5 — evidence-gated advisory pilot

Requires consenting Homes, trustworthy lineage, at least eight Home-weeks over
three Homes, the spec's independently reviewed events and Pi resource results.
These are external evidence requirements, not software tests. Inadequate data
keeps a capability in shadow. Publication and appliance installation require
separate authorization. Heating planning, ventilation learning and predictive
maintenance retain their later, separately specified evidence gates.

## Acceptance record

This ledger must distinguish source implementation, automated verification,
visual acceptance, prospective model evidence and deployed verification. Record
the exact verification receipt in the handoff; no UI acceptance or appliance
pass can be inferred from backend tests. Milestones 2–5 remain incomplete.
