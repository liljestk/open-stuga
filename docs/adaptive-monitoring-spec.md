# Adaptive Home monitoring specification

Status: target specification; offline foundations are partially implemented in 0.63.0.
Production persistence, execution, review UI and appliance enablement remain
incomplete; see the [delivery ledger](analytics-completeness-plan.md).

Date: 11 November 2026.

Code baseline: local v0.55.0, commit `54ccb06a`; reconcile with current `main`
before implementation. See the [implementation plan](adaptive-monitoring-plan.md).

## Outcome and scope

Help someone notice a persistent change in their Home and decide what to check.
The first release adds two capabilities to existing monitoring:

| Capability | Example of proposed wording | First-release scope |
| --- | --- | --- |
| Unusual climate behaviour | "The bedroom has stayed cooler than expected for its recent weather and daily pattern. Compare the readings and check the room." | Per-sensor temperature, relative humidity and CO2, summarized in the owning Room/Home. |
| Sensor comparison | "This thermometer's usual difference from its reference sensors has changed. Check its position and compare it with a reference thermometer." | Learned temperature comparisons; reuse existing coverage, flatline and changed-baseline checks for other supported metrics. |

These are reviewable suggestions. Models do not diagnose equipment failures,
leaks, mould or occupants; change calibration; remove observations; issue
actuator commands; or create maintenance work automatically. Existing threshold
alerts retain their independent lifecycle and priority. Energy anomalies,
heating planning and event-specific ventilation learning follow later gates.

Success means useful findings with a measured false-alarm burden, explicit
unknown states, and negligible impact on ingestion and interactive use.

## Existing foundations and ownership

Reuse these boundaries rather than create another analytics stack:

- `analytics/forecast/models.ts`: thermal relaxation and daily-profile models.
- `analytics/home-performance/derive.ts`: existing sensor reliability rules.
- `analytics/home-monitoring/`: authorization-aware summaries and insights.
- `HybridTelemetryReader`: canonical local/archive history and completeness.
- `AnalyticsWorkLimiter`, `hostAllowsBackgroundWork`, and the durable derived
  artifact/job patterns: admission, cancellation, identity and publication fences.
- `@climate-twin/analytics-kernel`: statistics, aggregation and calendar helpers.

New detection, model lifecycle and persistence belong to a named
`apps/api/src/analytics/adaptive-monitoring/` domain. Wire types, validators,
algorithm versions and defaults belong to `@climate-twin/contracts`. Extract
shared sensor checks into their owning domain if needed; Home performance and
adaptive monitoring must consume one implementation of each check.

Settings, model artifacts and findings are Home-owned. Every result captures
its original Property, Home, sensor, Room/floor association and evidence epoch.
Property/Workspace summaries project only authorized Home results. Hidden Homes
stop jobs, publication and writes. Read-only Stuguby projections do not train
local models from remote cache data in the first release.

## Evidence and readiness

1. Read closed UTC hourly buckets with coverage, source, quality and archive
   completeness. Preserve gaps; do not zero-fill or interpolate targets. First
   release latency is hours, normally two to three usable hourly buckets.
2. Use canonical units and deduplicated physical sources. Exclude stale,
   invalid and replay samples from live fitting. Demo has separate identities,
   artifacts and labels. Source-estimated samples remain available as context
   but do not establish a first-release training or scoring target.
3. A usable bucket has at least 80% coverage under the existing reporting-
   interval semantics. Check required weather/context separately. Never count
   dense polling as independent evidence or equate reporting coverage with a
   verified physical sensor accuracy.
4. Initial model qualification needs 28 calendar days in the same evidence
   epoch: seven days for initial fitting, seven for model/policy selection,
   seven for residual calibration and seven for final chronological evaluation.
   Each block needs at least 80% usable buckets. Insufficient coverage stays
   `collecting`; it never becomes an all-clear result.
5. Model selection compares the existing daily-profile/thermal candidates with
   persistence and same-hour-yesterday. Thermal candidates require usable
   historical outdoor observations. Future or subsequently observed weather
   must not enter an earlier prediction as if known then.
6. Temperature uses weather and daily rhythm when supported; humidity/CO2 use
   daily rhythm. Raw RH departures are described as RH departures, without a
   claim about moisture quantity. Heating/opening states initially supply
   context and change guards, not learned intervention effects. Wording names
   only inputs actually used. Missing context is disclosed.

An evidence epoch changes on source/device replacement, sensor reassignment or
move, calibration/unit changes, reference-group changes, relevant weather
location changes, or an explicitly confirmed baseline reset. Preserve the
change's effective and recorded times. An unknown placement history cannot be
reconstructed from today's layout: initial qualification uses a trustworthy
history boundary established during the evidence audit, otherwise it starts
from enablement. A rename alone does not reset learning.

## Climate detection policy

Start with the existing small local models. Freeze the selected model family,
feature policy and detector settings before the final evaluation block. Replay
the production policy: fit parameters daily from at most the preceding 14
days, predict the next closed hour before seeing its target, and update
calibration only after that target is available. No hyperparameter or threshold
selection uses the final block. A candidate cannot become a champion without
passing the qualification gates below.

For each scored hour retain the prediction and model identity made before its
target. Let `e = observed - predicted`. Using up to seven preceding days of
out-of-sample errors, calculate `bias = median(e)`, centered errors `e - bias`,
and `scale = 1.4826 * MAD(centered errors)`. Require at least 120 usable prior
errors; otherwise abstain. The expected value is `predicted + bias`, and the
departure threshold is:

```text
T = max(p99(abs(centered errors)), 3 * scale, metric materiality floor)
```

Initial materiality floors are 1.0 C, 7 relative-humidity percentage points and
200 ppm CO2. These are versioned engineering defaults to validate, not health
limits. The resulting expected range is an empirical reference range, not a
probability of a defect or a guaranteed 99% prediction interval.

- Open a candidate when the latest bucket breaches `T`, and at least two of
  the last three consecutive usable hours breach in the same direction.
- Present it only after model qualification, in advisory mode, with sufficient
  current evidence and a useful verification step. First-release learned
  findings have `notice` severity and cannot become critical automatically.
- Clear after three consecutive usable hours within `0.6 * T`. A missing hour
  breaks continuity. If an active finding loses evidence, mark its evidence
  stale/unknown; absence of readings is not recovery.
- A known opening/heating transition applies a fixed two-hour context guard;
  record the reason and end time. Subsequent scoring requires a new contiguous
  sequence. Unknown context lowers qualification and prevents context-specific
  claims; it does not manufacture a known event or an indefinite suppression.
- Use one episode per sensor, metric, direction and epoch. Updates revise that
  episode. Reopening requires the recovery condition and a new qualifying
  sequence. Combine related display items without erasing their evidence.

Do not adapt away a newly detected departure immediately. Freeze that stream's
champion parameters and calibration contributions from the candidate's first
breach until recovery or a baseline review. Score before admitting an error to
calibration; keep first-breach errors provisional until the sequence is known.
Retain every excluded point and reason. A frozen model expires after seven
days; a stream with no eligible champion becomes `collecting` or `stale`, not
indefinitely anomalous. Normal
baseline resets require an Owner/Admin action with a recorded explanation.

## Sensor comparison policy

Preserve existing coverage and flatline checks. The learned addition first
supports temperature sensors with either two independent comparable peers or
one explicitly designated reference thermometer. A reference group must be in
the same Home and explicitly identify comparable placement; default automatic
groups are limited to the same recorded Room. Proximity alone is insufficient.

Learn the target's usual difference from the reference group's median using
paired hourly observations. For multiple peers, withhold comparison while their
mutual disagreement exceeds their qualified baseline. Apply the same 28-day
split and causal calibration rules. Require at least 120 usable paired
calibration hours and retain peer identities, coverage and baseline spread.

A changed relationship becomes a review candidate when the last 24 hours
contain at least 18 usable paired hours, no gap exceeds two hours, and the
median change in target-minus-reference offset exceeds both 0.7 C and four
times its calibrated robust scale. Clear after an equivalent qualified day
inside half that threshold. Context guards and epoch rules also apply here.
When evidence disappears, preserve the unresolved episode as stale.

This identifies a changed relationship, not which sensor is wrong. An approved
reference is still evidence, not a guarantee. Do not adjust or quarantine raw
values automatically. When the same stream has both a climate and a sensor
candidate, group them under one review action and show the attribution as
uncertain. Keep absolute threshold alerts visible.

## Artifacts, lifecycle and resources

Persist additive tables in the control-plane SQLite database for settings,
evidence epochs/reference groups, model/evaluation artifacts, prediction/error
ledger, finding episodes/revisions and human reviews. Store bounded derived
evidence; raw telemetry stays in its existing stores. Reuse durable job and
immutable artifact patterns, extending their contracts where necessary rather
than adding an ungoverned scheduler or a second telemetry database.

Model identity includes archive-source UUID, data mode, Property/Home/sensor/
metric, epoch, feature/model/detector versions, configuration digest, training
cutoff, source watermarks and input digest. Publish atomically only if the job,
scope, mode, epoch, configuration and input generations still match. A failed
or cancelled computation cannot replace the last successful artifact.

Record both observation time and when evidence became available. Recovered or
late data may produce a separately versioned retrospective analysis; it cannot
rewrite what a live finding claimed to know. If historical availability cannot
be established, label a replay retrospective and exclude it from prospective
accuracy claims. Raw sample deletion/retention must not be extended silently.

One low-priority job runs at a time through the shared governor after its
startup grace. Score newly closed hours; fit at most daily per stream. Process
at most 32 streams and 50,000 hourly input buckets per job, rotating fairly
across Homes/streams. Coalesce invalidations, checkpoint progress and bound
catch-up to the latest 48 hours; older backfills need an explicit evaluation
job. Resource pauses expose their cause and progress, with no silently omitted
scope. Requests read persisted results and never fit or scan raw history.

Proposed Pi acceptance budgets: a 30-second cancellable job deadline, at most
128 MiB additional worker memory, snapshot-read p95 below 200 ms, and no more
than 10% ingestion-throughput or foreground-p95 regression against the same
disabled-feature workload. Benchmark on Pi 4 before advisory rollout. Pressure
or missed deadlines pauses this optional work; telemetry continues.

Retain hourly prediction/error evidence for 90 days, superseded model artifacts
and finding revisions for 365 days, with a maximum of 10,000 retained episodes
per Home and 128 artifacts per stream. Keep review/audit records under existing
audit policy; link their compact evidence summary before derived-detail
expiry. Active/unresolved findings and their referenced artifacts are not
silently pruned. If caps cannot be met, pause new optional work and expose a
storage limitation. Purge demo-era state at the real-mode boundary. Include
tables in existing backups; restored identities follow the restored database.

## API and access contract

Proposed v2 routes, all within the existing authorization/mode boundary:

| Method and suffix under `/api/v2/monitoring/houses/{houseId}/adaptive` | Purpose |
| --- | --- |
| `GET /` | Read the bounded current snapshot; required `dataMode=live|demo`. |
| `GET /findings` | Keyset-paged episodes, default 50/max 100; state/metric filters and explicit data mode. |
| `GET /findings/{findingId}` | One episode, bounded revisions/evidence and continuation cursor. |
| `PATCH /settings` | Owner/Admin changes mode, supported reference groups or a baseline reset using `baseRevision`. |
| `POST /findings/{findingId}/reviews` | Owner/Admin records a review using `baseRevision` and an idempotency key. |

Use one response shape per endpoint with shared guards and OpenAPI operation
IDs. The snapshot extends `DerivedAnalyticsEnvelope` and includes `houseId`,
`settings`, `state`, `evaluatedThrough`, paged `streams`, paged `findings`,
`nextCursor` per collection and scope counts. Define one shared status enum:
`disabled | collecting | ready | stale | paused | failed`; apply it to the
snapshot and individual streams with typed reason codes and coverage. A `ready`
stream may have findings; it means scoring is available, not healthy climate.
Each collection includes `items` and `nextCursor`; snapshot pagination accepts
separate `streamCursor` and `findingCursor` values bound to scope, data mode,
filters and snapshot identity. Changed snapshots return a typed cursor conflict
and a fresh-read action. Snapshot completeness includes all eligible streams,
including deferred/unqualified ones, rather than just the current page. A
stream is stale when its evaluated-through time lags the latest closed hour
by more than two hours or its required evidence is no longer fresh.

Every finding has a stable ID/revision, captured scope, kind, metric/unit,
direction, `notice` severity, lifecycle state, first/last evidence and recorded
times, observed/expected values and reference range, coverage/context gaps,
supporting source IDs, model/evaluation references and localizable copy keys
with parameters. Lifecycle is `candidate -> presented -> resolved | expired`;
shadow candidates stay out of public monitoring reads. A review is a separate
audited record, not resolution or a training label.

Review dispositions are `useful | not-useful | expected-change | uncertain`;
an optional note records the person's explanation. A reported recovery is
recorded as human evidence; detector resolution still requires the recovery
rule. A separate baseline-reset action expires the old epoch's finding without
calling it a repaired defect. Acknowledgement,
dismissal, a completed task and `useful` are never automatically positive fault
labels. Reuse existing observation/maintenance workflows for confirmed outcomes.

Writes require the active data mode, an active local Home and valid revisions;
field validation is strict. Unknown fields, oversized payloads and cross-scope
references fail. Read permission mirrors existing Home/sensor visibility;
Guests cannot write. Public streams, caches and read-only MCP results recheck
access and cannot expose shadow evaluations, hidden Homes or other principals'
reviews. Shadow diagnostics are Owner/Admin-only. No new write MCP tool ships.

Return typed `200` snapshot states for disabled, collecting, paused or stale
data. Use existing error conventions for bad inputs, invisible resources,
mode/revision conflicts and unavailable storage. A valid settings/review write
returns its one canonical updated object; an idempotent retry returns the same
result. Validate every web response at the request boundary.

## Interface contract

- Home shows at most three grouped, qualified current suggestions beneath
  existing actionable alerts, with a link to remaining findings. Each has one
  primary action, **Review change**, and a clear Home/Room, timestamp, evidence
  qualification and explanation. Learning/unknown states belong in
  **Monitoring incomplete**, never **Needs attention**.
- Data & analytics owns history, expected-versus-observed evidence and advanced
  learning settings. Sensors reuses the same canonical sensor-health findings.
  Use existing Home routes with bookmarkable finding/disclosure state; Back,
  refresh and scope changes restore the correct context.
- The review disclosure distinguishes observations from model estimates, shows
  the empirical range with a text/table equivalent, names missing context, and
  offers the four review dispositions. Saving is reversible through a new
  revision and keeps focus/context. Raw model scores stay in advanced evidence.
- Include disabled, collecting, no finding, stale, partial, resource-paused,
  permission-denied and error states. "No unusual change detected in the
  monitored data" must name coverage; it never certifies the Home as healthy.
- Apply existing semantic tokens, plain Home/Room language, keyboard behaviour,
  focus restoration, reduced motion, units and complete `en`/`fi`/`sv` copy.
  No new primary navigation, opaque Home-health score or alert-delivery channel.
- A rendered implementation must pass `DESIGN.md`'s blocking visual contract:
  real shell/workflow, representative non-private data, 320/1440 px light/dark,
  768 px and changed breakpoint edges, relevant states, accessibility/reflow,
  and recorded route/scenario/screenshots/pass-fail evidence. Native clients
  remain on existing compatible endpoints until separately implemented and
  visually accepted.

## Evaluation and rollout gates

Numbers below are proposed acceptance thresholds, not claims of achieved
accuracy. Freeze datasets/splits and detector defaults before the final test;
change the algorithm version and rerun held-out evaluation after tuning.

| Gate | Requirement |
| --- | --- |
| Time correctness | Predictions, features, transformations and calibration use only evidence available before each scored target; late data, DST and restart tests pass. |
| Baselines | Compare current rules and fixed persistence/seasonal residual detectors on identical eligible hours and material event definitions. Climate-model one-hour MAE must beat the better persistence/seasonal baseline by at least 5% before that stream qualifies. Sensor comparisons use the current offset checks and a fixed reference-offset baseline. |
| Reference range | Measure empirical range coverage/width by metric, Home and context. Holdout coverage below 95% blocks that stream's advisory promotion; report denominators and dependence-aware uncertainty. High coverage alone is not a failure: the material-event gate prevents an arbitrarily wide range from passing. |
| Event usefulness | Detect at least 80% of preregistered sustained changes above the materiality floor: temperature/RH/CO2 departures lasting at least four hours; peer-offset changes of at least 1 C lasting 48 hours. Report every scenario separately. |
| Alarm burden | At most one false presented episode per eligible Home-week across all streams; on a corpus with enough baseline false episodes to compare, at least 25% fewer than the strongest applicable fixed baseline with held-out recall no more than five percentage points lower. Select baseline sensitivities on selection data only. If the comparison is not identifiable, improvement is unproven. |
| Detection delay | Climate-event median no more than three usable hours; sensor relationship-change median no more than 30 hours. Count wall-clock delay and abstained events separately. |
| Operational quality | No cross-scope/mode leak, stale-as-healthy result, duplicated episode after restart, data loss or actuator command; resource budgets pass under concurrent ingestion and foreground use. |

Synthetic fixtures test controlled behaviours and nuisance events (weather
fronts, ordinary daily patterns, showers, opening/heating transitions, stable
room differences, sensor moves, shared outages and missing peers). They do not
prove real-home performance. Report abstention/coverage so a silent detector
cannot pass by monitoring nothing; score at least 80% of otherwise eligible
held-out hours. Episode metrics include all monitored streams and avoid treating
correlated sensors or repeated polls as independent Homes.

Roll out `off -> shadow -> advisory`. Default new installations to `off`.
Owner/Admin opt-in enables local shadow evaluation without attention cards or
external notifications. Advisory requires all technical gates plus at least
eight prospective Home-weeks across three consenting Homes, spanning heating-
active and heating-inactive periods, with at least ten independently reviewed
material events per promoted capability/metric (at least 20 to promote both
capabilities). At least 80% of eligible review candidates must be reviewed;
report uncertainty and count unreviewed candidates against the false-alarm
budget until adjudicated. Promotion is per capability/metric and Home readiness;
underrepresented capabilities remain in shadow. These minimums permit a limited
pilot, not broad seasonal/general-home accuracy claims.

Promotion requires an explicit local Owner/Admin setting and a matching
versioned evaluation receipt. No timed automatic promotion. External Telegram/
webhook notifications remain deferred until a separate delivery/false-alarm
review. Rolling model no-skill, invalid lineage, missing calibration or expired
evidence demotes the affected stream and explains why. Turning the feature off
stops work immediately and removes suggestions without altering observations,
existing alerts or audit evidence.

## Later opportunities

| Extension | Entry evidence | Deliverable |
| --- | --- | --- |
| Energy anomalies | Qualified whole-Home/heating meters, tariff and weather history; correct counter/power integration and load context. | Unusual consumption suggestions, validated separately from climate findings. |
| Heating planning | Durable setpoint/mode/power history, measured heating energy and repeated warm-up episodes in different weather. | Backtested warm-up-time and cost ranges; suggestions first, with control as a separate specification. |
| Ventilation/moisture recovery | Repeated timestamped opening/fan events, paired indoor/outdoor temperature and humidity, and CO2 where present. | Event-conditioned recovery comparisons using moisture quantity, with no unsupported causal or ventilation-rate claim. |
| Predictive maintenance | Confirmed faults, inspections and independently verified repair outcomes with sufficient positive and negative examples. | A separately validated condition-specific model and feedback/notification contract. |

## References

- [Design contract](../DESIGN.md), [analytics foundation](analytics-foundation.md),
  [thermal models](thermal-simulation.md), [predictive maintenance limits](predictive-maintenance.md).
- [Time-ordered validation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit)
  and [novelty/outlier detection](https://scikit-learn.org/stable/modules/outlier_detection.html).
- [DOE: building models and predictive HVAC operation](https://www.energy.gov/cmei/buildings/articles/building-energy-modeling-101-hvac-design-and-operation-use-case).
