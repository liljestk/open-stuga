# Electricity audit — 28 September 2026

Initial audit source: main `9f644f456ffa34af1cd25858fbecc7b19dc25f85` (0.41.4).
Live appliance: recorded application 0.41.3, host 0.35.7; identity and diagnostic receipts remain outside Git.

## Initial checks

Visited the requested Home electricity route, then the Property electricity route. Both remained at the global loading screen and eventually showed a recoverable service-connection error. A direct API health request timed out after 15 seconds; the application bundle returned HTTP 200. Canonical default and approved deep doctor checks failed API health/live version identification. Containers and resource samples did not establish overload or a root cause.

Live metric, chart-interaction, refresh and latency acceptance is **BLOCKED** by this outage, not passed. No contract, sensor or appliance settings were changed during the audit.

Source audit covered Power / Interval use / Electricity price; Single / Multiple / Combined; 6h / 24h / 7d / 30d / 90d / 1y; cost 1h / 24h / 7d / 30d / 365d; Property totals, contract and optimizer. Source checks are supporting evidence, not visual acceptance.

## Issue backlog

“Fixed” below means implemented in the 0.41.5 source candidate with the focused verification recorded below. It does not close live acceptance, the DESIGN visual contract, or appliance deployment. E1 remains open; E2 and E15 are identified failure mechanisms, not a demonstrated sole cause of the live outage.

| ID | Priority | Status | Reproduction / evidence | Implemented correction or remaining acceptance |
| --- | --- | --- | --- | --- |
| E1 | P1 | Open — live reliability unverified | Both routes initially failed bootstrap; later summaries, history, optimizer and health still timed out intermittently | Diagnose root cause, restore service, then verify both live routes and primary workflows |
| E2 | P1 | Fixed | Optional hydration reads occupy the two background slots before mandatory snapshot/integrations; four 30s waves can delay the shell | Queue core reads and the empty-snapshot sensor fallback before optional hydration; real scheduler regression covers pending optional reads |
| E3 | P1 | Fixed | Mean-bucketed resetting counters turn 4 kWh actual use into 52.5 kWh in the chart | Ordered server consumption integrals handle resets and bounded power holds before aggregation; chart requests bounded long-range resolution and never differences averaged counters |
| E4 | P2 | Fixed | Property optimizer reports 200 W for two independent 200 W meters | Time-aligned Property totals honor meter roles and reporting cadence |
| E5 | P2 | Fixed | Optimizer joins price periods across an unpriced hour | Recommend only continuous fully priced windows |
| E6 | P2 | Fixed | Property price/history/optimizer load only on mounting or selection change | Refresh active views; load collapsed expensive optimizer on demand; expose recovery |
| E7 | P2 | Fixed | Cached current Home price remains displayed after its interval expires and polls fail | Reject expired, future, malformed and nonfinite current prices, including sample fallbacks; retain visible recovery |
| E8 | P2 | Fixed | Chart view and source selections disappear on refresh / Back | Preserve meaningful mode and source selection in the URL and restore navigation |
| E9 | P2 | Fixed | Chart load errors have no retry and no automatic recovery trigger | Add in-context retry and bounded refreshing of the selected view |
| E10 | P2 | Fixed | Desktop cost period selector clips its selected value in the narrow icon-adjacent column | Give values, period selector and explanations the card width; final responsive inspection remains required |
| E11 | P2 | Fixed | Consumer pattern/average/peak claims change when an unrelated chart replaces shared history | Remove unsupported profile claims; preserve measured kWh/share without additional scans. Rendered regression confirms chart-history replacement cannot change consumer content |
| E12 | P2 | Fixed | Property-only price chart announces no data in Single/Multiple views even with a plotted price | Announce the available Property price in every view |
| E13 | P1 | Fixed | Signed power can silently contribute zero consumption, including held buckets without an observation | Preserve explicit unavailable integrals as null in raw and cached aggregation; do not label them zero. The chart marks consumption incomplete with a localized capability note |
| E14 | P2 | Fixed | Disabling an electricity view leaves its in-flight query or next source batch running | Cancel inactive requests, stop batch continuation, and preserve shared active observers and cached results, including observer ownership handoffs in normal and StrictMode rendering |
| E15 | P1 | Fixed | Archive coverage used an unbounded historical aggregate on the request path | Use indexed first/last probes for each requested sensor/metric pair. A 100,000-row PGlite production-SQL plan regression verifies bounded reads and preserves source modes and boundary behavior; live-outage causality remains unproved |
| E16 | P2 | Fixed | A Home with a Property price but no electricity meter shows “Calculating from stored history…” indefinitely because a disabled query remains pending | Gate the daily loading state on whether summary queries are enabled; a rendered regression verifies empty usage and no summary request |
| E17 | P2 | Fixed | HTTP 403 from current-price and History requests is described as a transient loading failure | Render localized permission-denied text from structured status; preserve validated status through regular and historical raw-series loaders. The real-loader rendered regression also verifies a generic retry clears the permission message |
| E18 | P1 | Fixed | Eight delayed optional hydration reads can occupy both read slots and prevent visible electricity metrics from dispatching | Limit optional active and portfolio hydration to one slot within the unchanged two-read/three-total cap; preserve FIFO progress, pagination, cancellation and mutation capacity. Real API/scheduler regression fails before the fix; 119 tests across 12 files pass after it |

| E19 | P2 | Fixed | Different sources at the same observation time produce different raw and SQL consumption (0.25 versus 0.5 kWh in the final review fixture) | Raw samples lack ingestion ordering, so conflicting timestamps now explicitly withhold affected consumption instead of choosing by source name or array order. Identical duplicates remain usable and later supported intervals recover; archived states retain their authoritative latest-ingestion rule |

| E20 | P1 | Fixed in follow-up candidate 0.41.6; live acceptance pending | After installing 0.41.5, live usage/cost retries still timed out and API CPU consumed a core. Synthetic SQLite reproduction with 10,000 price periods and 3,601 readings took 10.7 seconds for counter cost and 55.2 seconds for power cost, synchronously blocking the API thread | Seek the predecessor price and indexed overlapping starts for each measurement interval. The same local reproduction takes 29 ms / 50 ms with identical totals. Production-query-plan regressions reject full price scans; gaps and legacy overlapping prices retain their prior arithmetic. These timings establish a local failure mechanism, not a Pi latency guarantee or proof that every E1 cause is resolved |
| E21 | P2 | Open — dense local fallback responsiveness | The indexed candidate still processes local cost calculations synchronously. A synthetic 72-hour window with 259,201 one-second readings and 46,000 price periods took 2.4 seconds for counter cost and 4.0 seconds for power cost on the development machine | Preserve the existing 72-hour hybrid fallback limit; verify actual appliance sampling density and latency after E20 is installed. If dense fallback blocks ordinary reads, move expensive local cost work off the API thread or bound its admitted work. These synthetic timings do not identify the active Pi query |
| E22 | P2 | Open — chart/summary opening-interval mismatch | A same-window synthetic 24-hour API comparison returned 25.651584 kWh in the Home summary and 25.432717 kWh across chart consumption integrals. The raw analytics read begins at the requested start and its counter integrals omit the preceding anchor; the summary includes a prorated opening interval | Align the range-boundary semantics across raw and archived charts and summaries, with bounded predecessor reads, or explicitly label incomplete chart coverage. Cover arbitrary rolling-window starts, range-end observations, resets, source ambiguity and permission boundaries. This existing difference is separate from E20's unchanged cost arithmetic |

## October 3 deployment follow-up

Stable 0.41.5 was installed through the normal application updater after a verified backup. The running and recorded application version matched 0.41.5, with the host remaining unchanged. Initial post-install health passed, but Home usage/cost/price retries subsequently failed, the Property bootstrap failed, and bounded default/deep diagnostics observed API timeouts. E1 therefore remains open.

The 0.41.6 follow-up changes only the local cost-query access plan and synchronized release versions; it preserves existing arithmetic and visual presentation. It is not yet installed. Private appliance receipts, deployment evidence, and benchmark helpers remain outside Git. The earlier visual/manual acceptance limitations remain explicitly incomplete.

The current live review again failed both requested routes with the service-connection screen. A bounded standard diagnostic timed out on health after 2.614 seconds while its existing one-shot sample measured API CPU at roughly one logical core. Containers had no unexpected restarts or unhealthy states and memory remained plentiful. Persistent storage had 11.8% free; the host-feed trust warning and capped notification dead-letter backlog also remain. Neither has been established as the electricity outage cause. Browser-generated electricity reads were closed after the failed check; no appliance service, settings, or stored data was changed.

The 0.41.6 fast verification passed all nine selected gates, including 1,132 API tests and 1,190 web tests. The six new production-query regressions are included. The synthetic density benchmark also preserved known totals for 24-hour and 72-hour one-second sampling, and one year of quarter-hour sampling. It measures only the development machine and explicitly leaves E21 open.

The later approved deep diagnostic observed API health recovery in 149 ms with a responsive event loop and matching application/recorded version 0.41.5. Its bounded database-integrity, updater-hardware and service-journal probes still timed out; integrity remains unverified, not corrupted. The Home then rendered live current power and Power history, but daily consumption, 30-day and 1-hour cost remained unavailable, and Energy used / Electricity price history did not finish loading. This is intermittent/partial recovery, not a live reliability pass.

The current synthetic source/build was inspected in the real Home and Property shells, with all five cost intervals, all three metrics in Single/Multiple/Combined mode, all six history ranges, and Property optimizer disclosure. Current power changed while the pages remained open. Populated summaries and layout were inspected at requested 320 and 1440 px sizes in both shipped CSS theme branches; screenshots and observations remain outside Git. The comparison described in E22 fails consistency acceptance. Manual accessibility checks and exact-size PNG release evidence remain unavailable, so no overall DESIGN or deployment acceptance is claimed.

## Focused implementation verification

These are completed focused runs, not a replacement for canonical verification or visual acceptance. Counts describe their recorded runs; later combined runs may overlap these files.

- Bootstrap scheduling and hydration: 44 tests passed across `useClimateData.bootstrap-scheduling.test.tsx`, the three existing `useClimateData` test files, and `api.request-scheduler.test.ts`. The new real-scheduler tests failed before the ordering fix and passed afterward, including an empty snapshot requiring a sensor fallback.
- Responsive styles and semantic tokens: 14 tests passed across `EnergyPage.responsive-styles.test.ts` and `styles/semantic-tokens.test.ts`.
- Measured consumers: `EnergyPlanningPanel.test.tsx` and `energyAnalysis.test.ts` passed after removing incidental history-based profiles. The rendered regression fails when the former profile content changes after chart-history replacement.
- Home and History workflows: 28 tests passed across `EnergyPage.test.tsx` and `ElectricityHistory.test.tsx`, including the bounded server-integral query contract instead of the former averaged-energy loader expectation.
- Signed-power helper, History UI and history query: 24 tests passed across `energyAnalysis.test.ts`, `ElectricityHistory.test.tsx` and `data/energy/electricityHistoryQuery.test.ts`.
- Cancellation and freshness: 16 tests passed across `data/energy/electricityCancellation.test.ts` (11), `data/energy/electricityHistoryQuery.test.ts` (2) and `EnergyPage.refresh.test.tsx` (3).
- Analytics: 25 tests passed across API `timeseries-analytics-rollup.test.ts` (4), `analytics-consumption.test.ts` (4) and `analytics.test.ts` (17). These include signed-power raw and cached SQL execution in PGlite, held-bucket null metadata, and preservation of null extrema.
- Coverage and cost: 14 tests passed across API `timeseries-coverage-performance.test.ts`, `measurement-window-coverage.test.ts` and `electricity-cost-correctness.test.ts`. The 100,000-row production-SQL comparison checks the historical aggregate against indexed first/last probes and covers real/synthetic modes, missing pairs, duplicate pairs and single-series boundaries.
- Empty and denied states: 36 rendered tests passed across `EnergyPage.empty-and-denied.test.tsx` (5), `EnergyPage.test.tsx`, `ElectricityHistory.test.tsx` and `EnergyPage.refresh.test.tsx`. The new tests cover price-only empty Home usage, Home/Property current-price denial, price History error propagation and consumption History denial; the empty-state assertion failed before the enabled-state guard.
- Ambiguous simultaneous readings: 32 API tests across four files and API typecheck passed. The original raw/SQL discrepancy now yields explicit raw unavailability with both direct and cached SQL at 0.5 kWh; reversed order, repeated duplicates, absent source labels, identical values and later counter recovery are covered. The two helper regressions failed before the fix. The generalized partial-data explanation passed 23 web tests across three files plus web typecheck/build, including a rendered positive-counter case.
- Final combined E17/E18 web typecheck and the 0.41.5 production build passed. Sixty tests across six affected files passed after raw-power permission propagation; the real-loader rendered regression failed before the fix and passed afterward.

## Visual and deployment acceptance

**BLOCKED overall:** the inspected scenarios and remaining manual gates are recorded below. No blanket accessibility, live performance, reliability or deployment pass is claimed.

The local inspection environment runs the real application shell and current API against synthetic in-memory data: Birch Garden, Birch House, three meters, 35 days of quarter-hour telemetry and synthetic prices. Its owner session is ephemeral. Contract-save inspection affects only this fixture. The production web build is served locally; scripts, screenshots, visual receipts and private diagnostics remain outside Git.

Additional local fixture controls can overlay signed-power null integrals, empty history/meters, denied requests, expired prices, delayed optional hydration or energy request failures. These controls inspect UI states; they are not evidence that the real API generated those states. Raw/cached aggregation semantics have separate regressions above.

Light/dark inspection can activate the shipped CSS media branches through a preview-only response transform. It changes only `prefers-color-scheme` conditions, preserving declarations and tracked production files. This is forced-media inspection, not native OS color-scheme emulation. Native accessibility and other unavailable manual checks must be recorded as blocked rather than inferred from screenshots.

## Browser inspection findings

Routes inspected in the real application shell:

- Home: `/properties/property-main/homes/house-main/electricity`.
- Property: `/properties/property-main/electricity`.

The synthetic populated Home and Property screens were inspected at viewport overrides of 320x900, 768x900 and 1440x1000, in both shipped light and dark CSS branches. Summary values, units, cost controls and expanded contract/optimizer content remained readable without horizontal page overflow. The desktop cost selector clipping was corrected. Separate screenshots cover chart controls and lines, keyboard focus, exact-data disclosure, and narrow expanded content.

| Scenario / workflow | Evidence filenames | Observed result |
| --- | --- | --- |
| Populated Home, 320/768/1440, light/dark | `final-home-{320,768,1440}-{light,dark}.jpg` | Pass for inspected layout; current power updates while the view remains open |
| Populated Property, 320/768/1440, light/dark | `final-property-{320,768,1440}-{light,dark}.jpg` | Pass for inspected layout and Home coverage labels |
| Property contract edit/save, desktop dark and narrow light | `final-contract-save-1440-dark.jpg`, `property-contract-320-light.jpg` | Synthetic retailer saved; success message visible; no live contract changed |
| Optimizer expanded, 320 light | `property-optimizer-detail-320-light.jpg` | Future priced windows, Property scope, measured totals and limitations readable |
| Energy chart, multiple sources, 1440/320 dark | `home-chart-1440-dark.jpg`, `home-energy-chart-320-dark.jpg` | Labels, distinct line patterns, units, ranges and source controls readable |
| Keyboard chart inspection, 1440 light | `home-chart-keyboard-1440-light.jpg` | Arrow-key value/tooltip and focus visible; exact-data table expands |
| Property-only price chart, Single/Multiple/Combined | `home-price-single-1440-light.jpg` | Chart and accessible summary both report the Property price |
| Signed-power partial consumption, 1440 light / 320 dark | `signed-power-limitation-1440-light.jpg`, `signed-power-320-dark.jpg` | Explicit limitation visible; no claim of complete usage. Final copy covers unsupported and ambiguous stored readings |
| Final generalized partial-consumption explanation, 1440 light and 320 light/dark | `partial-consumption-final-1440-light.jpg`, `partial-consumption-final-320-{light,dark}.jpg` | Readable explanation of incomplete usable intervals; final API source and production web build inspected |
| Empty history, 320 dark | `empty-history-320-dark.jpg` | No-data state and scope remain clear |
| Empty meters, 1440 light | `empty-meters-fixed-1440-light.jpg` | Setup action and empty usage; corrected endless calculating state |
| History failure and retry, 320 dark | `history-error-retry-320-dark.jpg`, `history-recovered-320-dark.jpg` | Recovery restores the selected sources/range in context |
| Expired current price, 1440 light | `stale-price-settled-1440-light.jpg` | Current price withheld; recovery action visible |
| Structured permission denial, 320 dark | `history-denied-fixed-320-dark.jpg`, `property-denied-fixed-320-dark.jpg` | Explicit permission wording; loaded configuration cannot be edited while unavailable |

| Raw-power permission denial, 1440 light | `raw-power-denied-fixed-1440-light.jpg` | Explicit permission text and retry visible below the chart |
| Delayed optional hydration, 1440 light | `optional-hydration-metrics-fixed-1440-light.jpg` | Current power, daily use, current price and cost were visibly populated by the 14.6-second observation while optional requests were configured with a 20-second delay; this is a local scenario observation, not a production latency guarantee |

The browser workflow exercised Power, Energy used and Electricity price; Single, Multiple and Combined; all six history ranges (6h through 1y); all five cost intervals (1h through 365d); source selection; refresh; Back; exact values; and optimizer disclosure. URL state restored metric, range and selected sources. The synthetic data contains only 35 days, so longer intervals correctly have limited coverage. Regression tests establish arithmetic correctness; these screenshots establish inspected presentation and interactions only.

Screenshots and the per-file hash/dimension manifest are held outside Git in the task's `electricity-audit` evidence directory. CUA exports JPEG evidence and may resize it relative to the requested viewport; no exact-pixel PNG release receipt is claimed. CSS theme forcing changes only media conditions in the local preview. It is not native OS theme emulation.

**Overall DESIGN acceptance remains BLOCKED.** Keyboard/chart interactions and responsive inspection above are complete for those scenarios. NVDA/Chrome or Firefox, VoiceOver/Safari, native 200%/400% browser zoom, forced colors, reduced-motion operation, and color-vision simulations are unavailable in this browser-only environment. The browser zoom key attempt did not change the viewport, so it is not a zoom pass. The JPEG evidence also cannot be presented as the exact viewport PNG evidence required by release verification. A reviewer with the supported environments must complete these gates; automated tests do not replace them.

## Live recheck and release handoff

The deployed 0.41.3 pages later loaded and showed current power and current Property price, but the 24-hour consumption, 1-hour and 30-day cost, price history and optimizer still failed or timed out. E1 is therefore intermittent and remains open. E2/E15/E18 address demonstrated local mechanisms; none proves the sole appliance root cause or a live performance pass.

The final standard doctor at 16:07 UTC reported eight containers with no unhealthy state or unexpected restarts and healthy memory/disk headroom, but API health timed out after 2.617 seconds. The approved bounded deep check at 16:09 UTC again timed out on API health; API-log collection succeeded with zero records in the last 15 minutes, and the integrity query exceeded its 12-second limit. This is unverified integrity, not evidence of corruption. No appliance setting, service or data was mutated.

The source candidate is 0.41.5. No schema migration, configuration migration, Compose contract change or signed host update is required by these fixes. Publication/deployment remains blocked by E1 target readiness and DESIGN acceptance. Operator-owned release inputs also remain unresolved: allocated next generation, selected channel and factory artifact upload decision. The observed public feed is v0.41.3/stable with generation 22; an ignored local context at generation 15 is stale and must not be reused. No new release tag, public image/artifact, channel change or appliance installation is claimed. Exact candidate commit and canonical full-verification receipt are recorded in the PR/handoff after the source is frozen.
