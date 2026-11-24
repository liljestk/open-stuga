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
  changes in temperature, humidity and CO₂, an isolated spike, an outage,
  delayed recovery, partial archive evidence, a known opening and sensor
  relocation. Receipts include counts by abstention reason. Adaptive milestone B
  still requires the remaining scenario and evidence matrix.
- Optional `include: ["distribution"]` on the existing analytics query returns
  equal-width histograms and quartiles per series. Raw observations and display
  buckets are labelled separately; missing/nonfinite values are excluded and
  counted. Bin counts describe equally weighted values, not elapsed time or
  independent physical measurements. Existing summaries remain unchanged.

Persistence missed all three synthetic steps. Same-hour-yesterday detected all
three and opened an unmatched episode after each. It also opened an unmatched
episode after the guarded opening, when the prior day's cooling became the
baseline. Learned models, production jobs, adaptive endpoints, UI and the
live pilot remain in later milestones.

## Milestone 2 — saved views, range selection and distributions UI

Implemented in the 0.63.0 draft:

- Private saved definitions scoped to the signed-in account, Home and data mode.
  List and write operations recheck visibility, revision conflicts prevent stale
  changes, and removal of workspace membership deletes that account's views.
- Pointer drag and labelled UTC fields select a half-open interval. The URL,
  analytics query and evidence exports preserve its bounds.
- Distribution charts and bin tables label raw readings and bucket values
  separately. The web client validates distributions before rendering them.
- English, Finnish and Swedish labels and recovery messages are included.

Review and verification evidence is tracked in the draft pull request.

## Milestone 3 — data isolation and invalidation

Daily findings now check the active data mode when persisting both a result
and an error. Work that started in demo mode cannot recreate a snapshot or
failure record after the live-mode latch purges that data.

Daily findings also track the current and peer windows for each Home in SQLite.
Overlapping measurement inserts, weather changes at the selected location,
and opening observations that affect those windows invalidate the snapshot.
The worker reconciles pending archive writes before calculation and discards
results if the tracked evidence changes during its reads. Existing snapshots
receive a fresh evaluation on the next worker run after upgrade.

Stugu logical archive backups omit the archive generation row. On startup
after a restore, the archive creates a fresh generation. SQLite discards daily
findings tied to the old generation and fences in-progress calculations.
Restarting with the same archive preserves existing findings.

Scheduled CSV runs bind the data mode at the start of the query. A transition
before handoff requires a fresh run. NAS requests carry the mode and the
worker routes them to the same separate demo and live folders used by cloud
delivery. A job already handed off may finish in its assigned folder.
Legacy queued NAS requests require a fresh run because their mode is unknown.
Direct Timescale restore still needs an independent lineage check.

SQLite now records immutable mode for new local measurements, legacy
readings, and outdoor temperatures. The additive migration leaves older rows
unclassified and preserves existing row IDs. The archive copies verified mode
through measurement queue writes, checkpoint replay, and corrections. It keeps
existing tags when replaying unclassified rows. Workspaces still use the
irreversible mode latch for production reads until the query and aggregate
migration is ready.

Internal raw measurement and coverage reads can now request an explicit
verified mode. SQLite and Timescale filter before selecting limited results
or coverage boundaries. The hybrid reader discards an in-flight demo read if
the workspace activates live mode. Coverage shows the first and last verified
observations for each series. Gaps can still exist inside those bounds.
Existing Analytics queries retain their current behavior during the migration.

Verified mode supports query-time display and summary aggregates, including
counter deltas and time-weighted means. It scopes observations, rejected
quality counts, and consumption boundary samples to the requested mode.
Timescale can explicitly refresh a bounded range into separate verified
continuous aggregates. They group by mode and index each mode's series
independently. Compatibility reads and startup policies retain their existing
behavior. Verified reads still compute from raw observations while refresh
coverage is missing. Mergeable reads can use stored full UTC days after a
bounded refresh certifies them against the current archive generation.
Late inserts and corrections invalidate affected dates in the same write
transaction. Deletions and truncation invalidate the archive's certificates.
Archive maintenance prepares and refreshes at most one closed UTC day per
five-minute pass when the archive is caught up and the host admits background
work. It prioritizes the latest closed day and subsequently refreshes tracked
days changed by late observations. Persisted ordered states and appliance cost
still need work.

Still to implement:

- Finish the SQLite/Timescale inventory and coordinated migration for explicit
  per-record data mode and mode-scoped identities and indexes.
  Existing database-wide demo-to-real isolation remains the production boundary
  until that migration and restore/rollback checks pass.
- Rebuild and validate affected aggregate identities and queries; prove demo
  observations cannot contribute to live summaries, model calibration, exports
  or recovery imports, including an in-flight mode transition. Preserve real
  history and immutable ownership. Unknown legacy lineage must fail closed.
- Audit additional late-data dependencies and third-party or physical restore
  paths. Generic query caches already use telemetry-history revisions. Verify
  logical archive recovery and late-data processing on a representative
  installation.
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
pass can be inferred from backend tests. Milestones 3–5 remain incomplete.
