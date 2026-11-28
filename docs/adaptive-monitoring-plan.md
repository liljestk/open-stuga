# Adaptive Home monitoring implementation plan

Status: foundation implementation started in 0.63.0; production adaptive monitoring remains unimplemented.

See the [delivery ledger](analytics-completeness-plan.md) for implemented scope,
verification and remaining milestones. The initial fixed-baseline harness is
partial milestone B; no appliance audit, learned model or pilot is implied.

Date: 11 November 2026.

Specification: [Adaptive Home monitoring](adaptive-monitoring-spec.md).

## Delivery decision

Deliver context-aware climate departures and sensor reliability first. Reuse
local models and the existing analytics/monitoring boundaries. Release in
shadow mode before showing suggestions. Heating planning and ventilation
learning are later milestones with separate evidence gates.

This plan is based on local v0.55.0 (`54ccb06a`), whose branch was behind
`origin/main` when inspected. Before implementing, reconcile the named extension
points against current source in a suitable checkout; do not switch or clean
another agent's shared worktree. Milestones are ordered by dependency, not
calendar promises. The live evidence pilot determines the earliest promotion.

## Milestones and acceptance

| Milestone | Concrete work | Exit evidence |
| --- | --- | --- |
| A. Evidence audit | Inventory available metrics, quality/coverage, history and archive readiness, source independence, placement/calibration boundaries, weather, heating/opening state and action outcomes. Audit timing/availability lineage. | Per-capability readiness report with gaps and trustworthy epoch start; no assumption that code support means usable appliance data. |
| B. Evaluation harness | Build causal rolling-origin replay, fixed baselines and preregistered synthetic change/nuisance scenarios. Measure event metrics and abstention. | Reproducible baseline receipt and failing/passing scenario catalogue before model tuning. |
| C. Contracts and persistence | Add typed settings, epochs, reference groups, versioned models/evaluations, prediction ledger, episodes and review records; migration/backups and authorization. | Guards/OpenAPI/migration tests pass; mode/scope/version fencing and retention are demonstrated. |
| D. Local detector worker | Reuse forecasters, extract shared reliability rules, implement residual and reference-offset policies, durable jobs, recovery and bounded governed execution. | Offline gates, restart/idempotency tests and Pi resource benchmark pass; no request-triggered fitting. |
| E. Shadow pilot | Explicit opt-in on consenting Homes; record prospective predictions, candidates and independent reviews. Owner/Admin diagnostic access only. | At least eight Home-weeks/three Homes and reviewed-event requirements from the spec, or a clear report that promotion remains blocked. |
| F. Review interface | Add canonical findings to Home, Sensors and Data & analytics; scoped detail/history, explanations, reversible reviews and learning settings. | API/UI workflow, locale and accessibility checks plus recorded blocking visual acceptance pass. |
| G. Limited advisory rollout | Consume the qualifying evaluation receipt; enable per capable metric and per ready Home by an explicit Owner/Admin setting. | Visible suggestions meet the frozen gates; disable/demotion/restore drills pass. No external learned notifications. |

Order: A -> B -> C -> D -> E -> G, with F after C and before G. E uses an
Owner/Admin diagnostic/review surface; that rendered surface must pass visual
acceptance before pilot use. F can proceed during the pilot without promoting
unqualified models into ordinary monitoring. A missed gate keeps the relevant
capability in shadow; completing implementation is not evidence of efficacy.

## Implementation boundaries

| Location | Responsibility |
| --- | --- |
| `packages/contracts/src/adaptive-monitoring.ts` (proposed) | Shared settings, findings, model references, evaluations, reason/status enums, guards and engineering defaults. Re-export through the existing package boundary. |
| `apps/api/src/analytics/adaptive-monitoring/` (proposed) | Evidence eligibility/epochs, fit and calibration, detection policy, episodes, evaluation, persistence and domain routes; split by responsibility. |
| `apps/api/src/analytics/forecast/` | Reuse model fitting and causal prediction helpers. Add a dedicated one-hour qualification policy; the existing six-hour forecast display gate is insufficient for this feature. |
| `apps/api/src/analytics/home-performance/` | Extract/reuse canonical sensor rules and consume shared sensor-health results without a second implementation. |
| `apps/api/src/analytics/derived-artifacts/` and `work-limiter.ts` | Extend governed job/artifact support for hourly checkpoints and daily fits. Preserve cancellation, priority and stale-result semantics. |
| `apps/api/src/db/migrations/`, domain DB methods and app composition | Additive schema, retention, backup participation, mode-transition cleanup, visibility and explicit worker lifecycle. |
| `apps/api/src/analytics/home-monitoring/` and OpenAPI | Project qualified advisory findings into existing monitoring with deduplication, stable priorities and one validated response shape. |
| `apps/web/src/data/`, API descriptors and owning page folders | Validated server-state hooks, shared finding/review UI, scoped deep links, semantic styling and complete translations. |

This is a proposed module map; use an existing helper when current source has
one. New statistics/calendar/energy helpers live in the analytics kernel when
shared, never as copied API-local implementations. Follow `CLAUDE.md`'s file,
import, options-object, contracts and complexity rules.

## Evidence audit deliverable

Use an Owner/Admin-authorized local audit, without committing or exporting raw
telemetry, real IDs, floor plans, credentials or model artifacts. The report
records counts, coverage and limitations; its private detailed outputs remain
outside Git. Identify separately:

- what is recorded, what is missing, and whether historical availability times
  can be reconstructed;
- temperature/RH/CO2 streams eligible for hourly modelling and the reliable
  start of their source/placement epoch;
- comparable independent temperature peers or an explicitly chosen reference;
- supported weather/context inputs and sources that cannot support a causal
  replay;
- which existing checks already cover the issue, to establish a fair baseline;
- the intended benchmark appliance and permitted prospective pilot Homes.

No historical corpus or multi-Home pilot is presumed available. Missing inputs
block that capability's promotion, not independent contracts/harness work.

## Verification work

Create meaningful tests for these new behaviours rather than mirroring helper
implementations:

1. **Causality and data quality:** future-data leakage, availability timestamps,
   late recovery, stale/estimated/replay samples, gaps, sparse polling, UTC/DST,
   source duplication, moved sensors, weather-location changes and partial
   archives. Prove evaluation cannot use the displayed six-hour gate as a
   substitute for one-hour anomaly skill.
2. **Detection and baseline comparison:** sustained material departures,
   ordinary weather/day cycles, opening/heating guards, stable room gradients,
   drift/reference disagreement, common outages, frozen calibration,
   expiry/relearning and unavailable peers. Freeze thresholds before holdout.
3. **Lifecycle and persistence:** one episode across duplicate readings/restarts,
   idempotent writes, revision conflicts, evidence loss without false recovery,
   review without automatic labels, late-data retrospective versions, retention
   with active references, migration and backup/restore.
4. **Access:** revoked/cross-Home/cross-Property access, Guest writes, hidden
   Homes, remote projections, cache isolation, shadow confidentiality and the
   irreversible demo-to-live boundary during an in-flight fit.
5. **Operations:** concurrent foreground work and ingestion on Pi 4, bounded
   queue/input/memory, fair scheduling, cancellation/deadlines, unavailable
   storage/archive, resource pause and stale-artifact reads. Record disabled
   and enabled measurements on the same fixture/workload.
6. **Product:** review a finding, inspect provenance and range, save/revise a
   disposition, navigate Back/deep links, switch Home, disable learning and
   recover from failed writes. Existing absolute alerts remain visible and
   independently acknowledgeable.

After contracts change, rebuild them before API/web tests. Each implementation
change runs `npm run verify:local -- --fast` and fixes failures. Before the
release candidate, run the authoritative full gate and follow the repository's
release process; this planning task does not authorize release or installation.

For every rendered milestone, record representative non-private scenarios in
the actual shell: populated/no findings, learning, stale, partial, paused,
permission and error states; 320/1440 px light/dark plus 768 px and changed
breakpoints; keyboard/focus, reduced motion, 200%/400% reflow, locale/unit changes
and the full primary workflow. Record route, scenario, viewport/theme,
screenshot paths and pass/fail findings under `DESIGN.md`. If inspection cannot
run or fails, UI acceptance is blocked/failed and the milestone is incomplete.

## Rollout, rollback and handoff

- Ship additive schema and a default `off` setting. Existing monitoring remains
  usable before learning is enabled. Use a minor product-version bump for the
  implementation feature PR, synchronized manifests/contracts/native metadata,
  and a user-facing changelog with upgrade impact under `docs/versioning.md`.
- A shadow receipt records code/model/feature/detector versions, configuration
  and dataset digests, split dates/availability policy, per-Home/metric results,
  abstention, episode denominators, reviewed outcomes, resource measurements
  and unresolved limitations. Store private receipts/artifacts outside Git.
- The receipt makes no unsupported multi-season, fault-diagnosis or savings
  claim. A pilot short of events, Homes, time or reliable review stays shadow.
- Test per-stream automatic demotion and Owner/Admin `off`. Stop/cancel work,
  fence stale publications, remove learned suggestions and preserve existing
  telemetry/alerts/audit. Keep additive tables until an explicit future
  migration; do not delete private history as rollback.
- Handoff identifies implemented commits, algorithm/configuration versions,
  evaluation and visual evidence, eligible/blocked capabilities, benchmark
  target, pilot scope, default mode, rollback results and remaining evidence.
  Publication and appliance installation require their separate authorization.

## Subsequent milestones

1. **Energy anomaly detection:** qualify meter scope, energy semantics and
   weather/load context; evaluate excess-consumption episodes separately.
2. **Heating planning:** collect reliable setpoint/power/energy and warm-up
   episodes, then specify backtested arrival-time/cost advice. Actuator control
   is a distinct future decision.
3. **Ventilation learning:** qualify repeated openings/fan events and paired
   moisture/CO2 evidence, then compare event-conditioned recovery with today's
   descriptive recovery checks.
4. **Predictive maintenance:** establish confirmed fault and repair labels
   before designing a condition-specific failure model.

Each extension requires a scoped specification and its own held-out evidence;
the initial rollout is not blanket approval for these later features.
