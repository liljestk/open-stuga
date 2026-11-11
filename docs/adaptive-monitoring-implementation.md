# Adaptive monitoring implementation record

Version: v0.63.0. Baseline: v0.62.2 (`d7c9c9f1`). Date: 11 November 2026.

This change implements the software for opt-in shadow evaluation. It does not
qualify advisory use, enable a real Home, install an appliance update or publish
a release. The [specification](adaptive-monitoring-spec.md) remains the
acceptance contract for promotion.

## Delivered behaviour

- Learning starts **off**. An Owner/Admin can select **Learn quietly** under
  Home → Data & analytics → Learning and unusual changes → Learning settings.
- Temperature uses a selected daily-profile or thermal-relaxation model;
  humidity and CO2 use a daily profile. Eligibility uses canonical units,
  measured reporting intervals, quality and hourly coverage. Missing data
  remains missing. Known opening/heating transitions guard affected hours.
- Predictions are issued before their target hour and persisted before scoring.
  The 28-day qualification window, separate selection/calibration/holdout,
  empirical ranges, persistence and seasonal comparisons use that ledger.
  Existing forecast code now supports restoring fitted parameters without
  reselecting weights every hour.
- Thermometer comparisons require explicit, comparably placed reference groups.
  The initial implementation accepts Tapo physical child IDs, including one
  explicitly designated reference. HA entity names do not prove physical
  independence. Other supported sources can still learn daily patterns.
  Reference jobs wait for committed peer hours. The fixed initial offset and
  peer spread survive normal hourly-evidence retention.
- Placement, source bindings, peer placement, Home location/timezone and
  algorithm changes fence the old epoch. Renaming preserves it. A documented
  manual reset expires earlier findings without claiming a repair.
- Persistent departures create stable candidate episodes. Open episodes freeze
  their reference before the first breach. Missing evidence does not resolve
  them; a frozen reference expires after seven days. Review dispositions and
  personal notes are separate, revision-checked and idempotent.
- Home, Analytics and Sensors share a progressively disclosed panel. Home
  groups at most three fresh advisory findings; Analytics exposes candidate
  review, readiness, history and settings to administrators. Members cannot
  see shadow diagnostics or other people's review notes. English, Finnish and
  Swedish copy, metric/imperial values and URL restoration are included.
  Fresh advisory changes give Home Pulse a review link and prevent a calm
  conclusion; incomplete advisory coverage stays unknown. Existing critical
  monitoring retains priority. Sensors counts only comparison streams.

The worker uses the existing low-priority limiter and host admission, a
two-minute startup grace, fair rotation across at most 32 streams, a shared
50,000-input-sample budget and a 30-second cancellation deadline. Production
fitting runs in an isolated worker with bounded V8 memory. It processes the
latest closed hour only; interruptions reduce coverage instead of inventing
historical forecasts. HTTP reads access persisted evidence only.

SQLite tables cover settings, epochs, hourly evidence, jobs, model artifacts,
finding revisions, reviews, audit and imported promotion receipts. Existing
SQLite backups include them. Hourly evidence lasts 90 days; superseded model
details and closed-finding revisions last 365 days. Active references and
compact reviewed findings are retained. Storage caps pause optional work.
Demo-to-live activation purges the other mode and imported qualifications.

## HTTP boundary

All endpoints are under `/api/v2/monitoring/houses/:houseId/adaptive` and
require the active `dataMode=demo|live` on reads, or `dataMode` in write bodies.

| Method and suffix | Result |
| --- | --- |
| `GET /` | Validated snapshot with state, counts, settings and paged streams/findings; optional `kind` scope. |
| `GET /findings` | Recent evidence first, optionally filtered by metric, kind, state or `activeOnly`. Closed history cannot displace current findings. |
| `GET /findings/:findingId` | Current finding and administrator-only paged revision history. IDs remain stable across revisions. |
| `PATCH /settings` | Owner/Admin mode, references or explicit baseline reset; requires `baseRevision`. |
| `POST /findings/:findingId/reviews` | Owner/Admin personal disposition/note; requires `baseRevision` and `idempotencyKey`. |

Contracts and guards live in `packages/contracts/src/adaptive-monitoring*.ts`;
OpenAPI documents the single success shape for each route. Cursors are bound
to the Home, data mode, viewer and evidence revision. Stale cursors fail with
409 and require a refreshed list. Read-only remote Homes cannot train or write.
There is no new write MCP tool, external notification or actuator path.

## Evaluation and promotion

Run the deterministic engineering evaluation with an absolute output path
outside Git:

```sh
npm run adaptive:evaluate -- --output /absolute/private/path/evaluation.json
```

The 50-day synthetic temperature scenarios produced these results. They test
controlled behaviour and are **not** real-Home validation.

| Scenario | Detected events | False episodes | Scored eligible hours | Delay |
| --- | --- | --- | --- | --- |
| Climate, ordinary weather | No injected event | 0 | 525/526 | — |
| Climate, sustained 1.6 °C change | 1/1 | 0 | 405/526 (77.0%) | 1 hour |
| Peer comparison, ordinary weather | No injected event | 0 | 526/526 | — |
| Peer comparison, sustained 1.6 °C change | 1/1 | 0 | 526/526 | 11 hours |

The climate-change case loses qualification after its frozen reference fails
to recover and expires. Its 77.0% scored fraction fails the 80% gate. This is a
known limitation requiring model/recovery evaluation before advisory use;
detecting the injected event does not make the scenario pass. No qualifying
humidity/CO2 corpus, consenting multi-Home prospective pilot or Pi 4 benchmark
was available. Broad seasonal accuracy and false-alarm improvement are unproven.
Every synthetic report has `canPromote: false` and is rejected by the importer.

Advisory requires an independently reviewed, trusted local receipt matching
the algorithm/configuration and live data mode, the specified prospective
Home/event/review denominators, quality gates, heating contexts and appliance
budgets. The operator owns that evidence and its review. This change does not
automatically produce a passing live receipt or start the pilot.

Once that evidence exists, an operator can import it into an existing local
installation database (keep both files outside Git):

```sh
npm run adaptive:import-receipt -- --database /absolute/private/path/climate.db --receipt /absolute/private/path/reviewed-live-receipt.json
```

The schema is `AdaptivePromotionReceipt` in the shared contracts. Import is
transactional and audited; it does not turn learning on. An Owner/Admin then
selects the receipt ID with an explicit revision-checked settings request and
selects advisory mode. Each stream still needs its own current qualification;
capabilities absent from the receipt remain candidates. Disabling learning
stops new optional work and hides its findings while retaining telemetry and
audit. A browser cannot assert its own evaluation results.

## Verification and visual evidence

Required automated gate: `npm run verify:local -- --fast`. The production build
and targeted causal, storage, access, dependency-order, retention-baseline,
publication-fence, forecast-serialization and UI workflow tests also run.

Visual inspection uses an isolated, in-memory synthetic Home with three fake
Tapo thermometers and generated readings in the production application shell.
The fixture and screenshots are outside Git under the local Stugu tooling
directory. The final visual record lists routes, states, viewports, themes,
screenshots and findings; it is engineering UI evidence, not pilot evidence.

Visual inspection matrix: **PASS**. Overall UI/accessibility acceptance remains
**BLOCKED** on the required NVDA smoke test: NVDA could not be located on this
host. `DESIGN.md` §11 explicitly requires “NVDA with Firefox or Chrome on
Windows.” The UI is not declared complete until that check passes.

The final Chromium run captured 61 screenshots, found no horizontal overflow or browser
exceptions, and completed the workflow. Axe reported no WCAG A/AA violations
in the new panel in either theme. Screenshots were inspected after capture;
automated checks alone were not treated as visual acceptance.

Local evidence directory:
`C:/Users/nikla/AppData/Local/Stugu/tooling/adaptive-visual-acceptance/`.
`results.json` records the full route, viewport, theme and absolute screenshot
path for every capture. UI fixture names and identities are synthetic.

| Route / scenario | Viewports and themes | Screenshot names | Inspection / workflow result |
| --- | --- | --- | --- |
| `/properties/property-main/homes/house-main/analytics?learning=1`, populated candidate and evidence | 320, 679, 681, 768, 1440 CSS px; light/dark | `finding-{width}-{theme}.png`, `summary-{width}-{theme}.png` | PASS: readable evidence, single/two-column transition around 680 px, no overlap or horizontal overflow. |
| Same route, off/collecting/stale/partial/paused | 320 light/dark and 1440 dark | `{state}-320-{theme}.png`, `{state}-1440-dark.png`, `stale-coverage-1440-dark.png` | PASS: qualification and missing evidence are explicit; stale readings show their time and cannot confirm recovery. |
| Same route, loading, denied, request failure, Member | 1440 dark | `loading-1440-dark.png`, `permission-denied-1440-dark.png`, `error-1440-dark.png`, `member-advisory-1440-dark.png` | PASS: loading/denied/error are neutral or explicit; retry recovers; Member has no settings or personal-review form. |
| Same route, settings/review/reset | 1440 dark | `references-saved-1440-dark.png`, `review-saved-1440-dark.png`, `reset-confirmation-1440-dark.png`, `keyboard-focus-1440-dark.png` | PASS: opt-in, physical references, review save, scoped reset, Cancel preservation, Escape/safe focus/restoration, history and Back complete. |
| Same route, reflow/locales/units/colour | 720 CSS px at 2× and 360 CSS px at 4× pixel density (1440 physical px); Finnish/Swedish at 320 light; imperial/grayscale at 768 dark | `reflow-{200,400}-percent.png`, `locale-{fi-FI,sv-SE}-320-light.png`, `imperial-768-dark.png`, `grayscale-768-dark.png` | PASS: reflow and labels remain usable; document language follows locale; units change consistently; status remains understandable without colour. Reduced motion was enabled throughout. |
| `/properties/property-main/homes/house-main`, advisory / incomplete | 320, 679, 681, 768, 1440 light/dark; incomplete at 1440 dark | `home-advisory-{width}-{theme}.png`, `home-incomplete-1440-dark.png` | PASS: review action is visible, opens the owning Home's analytics, and replaces the calm claim; incomplete learning stays unknown. |
| `/properties/property-main/homes/house-main/sensors`, comparison scope | 1440 dark; shared panel responsive layout as above | `sensors-1440-dark.png` | PASS: climate qualification is not represented as thermometer-comparison coverage. |
| Home status / finding in forced colours and colour-vision simulations | 1440 dark, forced colours, protanopia, deuteranopia, tritanopia | `home-forced-colours-1440-dark.png`, `finding-forced-colours-1440-dark.png`, `home-{protanopia,deuteranopia,tritanopia}-1440-dark.png` | PASS: readable status, links, boundaries and controls; no meaning depends on colour alone. |

Two UI issues found during inspection were fixed and re-inspected: contact
sensors in the reference picker, and calm Home Pulse content despite a fresh
learned suggestion. The Home/epoch processing and pagination regressions found
during implementation have focused automated coverage. NVDA is the remaining
required UI check. VoiceOver on Safari applies to a release candidate, which
this change does not prepare. Appliance performance and the consenting live
pilot also remain pending; this is not a certification or advisory receipt.
