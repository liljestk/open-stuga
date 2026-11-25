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

New local measurements record the originating SQLite write time. Both
checkpoint and queued archive copies preserve it independently of the
measurement and archive-ingest times. A correction with unknown lineage
cannot inherit the old value's recording time. Earlier rows remain unknown.
Recording time alone cannot establish when a transaction or complete hour
became visible to the prospective detector.

Owner and Admin accounts can read and change revisioned Home monitoring
settings through the v2 settings route. Shadow opt-in starts a new Home
baseline, resets retain their actor and reason, and duplicate retries return
the original revision. Owners and Admins can also set temperature reference
groups for a target, using two or more comparable peers or one designated
reference thermometer. Approval records the comparable placement. Settings
reject sensors outside the Home, disabled sensors and known source aliases.
Changing the groups renews the Home baseline in shadow mode. Live activation
purges demo settings, and a transition to shared authority revokes opt-in and
reference approvals. The detector still needs to qualify the references against
prospective evidence.

Prospective stream epochs now persist the Property, Home, sensor, metric, data
mode, effective boundary and recording time. Configuration changes invalidate
the current epoch even if values change back before the detector reads them.
Moving or rebinding a comparison sensor requires fresh placement approval. An
older opt-in cannot backdate an epoch past the start of configuration tracking.
Closed-hour captures now record each eligible observation or evidence gap at
the SQLite snapshot time. The capture uses mode-verified readings with known
recording times, validates units and source quality, and measures coverage
against occupied reporting intervals. An epoch keeps a consistent observed
producer. SQLite retention marks pruned history so the collector can withhold
an incomplete hour. A late write cannot revise an already sealed hour.
A background pass now collects opted-in streams under the shared analytics
governor after startup grace. It rotates across Homes, limits catch-up to 48
hours, checkpoints each stream in SQLite, and pauses on host pressure.
The offline climate screen uses four chronological weeks to fit the existing
daily-profile and thermal candidates, compare them on matching selection
hours, calibrate residuals, and report skill and range coverage on a held-out
week. It requires a 5% MAE improvement against the stronger fixed baseline
and 95% empirical range coverage. Weather and indoor readings must have been
available at the forecast cutoff. Run `npm run evaluate:adaptive -- --climate-qualification`
for a synthetic receipt. The shadow worker now runs the indoor-only screen
in its governed fit worker after a complete four-week cohort has elapsed.
It stores immutable reports with an input digest, rejects publication if
the epoch or evidence changed, and uses fresh cohorts after insufficient
coverage or rejection. Technically qualified indoor profiles now write
immutable next-hour shadow predictions, with both fixed baselines and the
input digest, before the target hour starts. Sealed observations or gaps
produce separate immutable outcome rows. The ledger records expired captures
explicitly, rolls off after 90 days, and follows epoch and mode cleanup.
The shadow detector now calibrates against prior prospectively recorded
forecast errors, persists its decision cursor and episode revisions, and
freezes the profile and calibration on the first breach. Missing evidence
marks an active episode stale. Recovery requires three consecutive usable
hours and a seven-day freeze expires the model. The detector remains
indoor-only. Independently timed weather and opening or heating context, the
reference detector, review surfaces, and advisory evidence remain open.

Continue milestones A–F in the adaptive plan: authorized evidence audit,
complete causal evaluation matrix, models, predictions,
episodes and reviews; governed worker; canonical routes
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
