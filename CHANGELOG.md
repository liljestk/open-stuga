# Changelog

All notable Stugu releases are recorded here.

## 0.54.0

A new look: Kaamos, the polar night.

- Stugu has a new visual identity:
  - The navigation and the phone's header bar are night blue in both light and dark mode.
  - Pages are snow-light or night-dark, with cool blue-grey neutrals.
  - Buttons are rounded pills.
  - One lantern amber marks the logo's window, the page you are on, and the page title, like a lit cottage window in the dark. It is never used for a status. Warning yellow is now a separate straw yellow, so the two can't be confused in dark mode.
- All text uses Atkinson Hyperlegible Next, a typeface drawn for low-vision reading. It is bundled with Stugu, so no font is fetched from the internet. Its zero has a slash, so it can't be mistaken for the letter O.
- Text is never smaller than 12 px. Sizes come from one scale of eight steps instead of 52 different sizes, of which 10 px was the most common.
- Labels are written in sentence case instead of spaced capitals.
- Corners, shadows and greys follow one set of values everywhere, including the floor plan and the 3D view in dark mode.
- "Report a bug" in the navigation is readable again: its text had 2.8:1 contrast against the dark rail.
- The logo, favicon and browser theme colour use the new mark, and spreadsheet exports use the new blue for their header row.
- The tabs on Property, Set up, Activity and the Outdoor forecast now share one design and one keyboard behaviour. Arrow keys work in both directions, and Home and End jump to the first and last tab. On Set up, the tab row keeps a keyboard stop while an advanced section is open.
- Upgrade impact: application-only update; no API, schema, Compose, configuration or host-trust change. The iOS companion keeps its previous colours for now.

## 0.53.0

Clearer messages and visible progress.

- Data & analytics:
  - Home performance, Thermal isolation and Moisture response each show one message for their saved analysis instead of up to three. A failed update said both "the update failed" and "newer evidence is prepared". It now says the update couldn't run, why, and that the saved result below is still shown.
  - You can close these messages. A closed message comes back when its situation changes, for example a different failure or a new result.
  - Their button is now "Recalculate". After you choose it, it reads "Recalculating…" until the background job finishes. The panel checks every 5 seconds instead of every 30, for up to two minutes.
  - The "Daily comparisons are being updated" banner no longer runs its title and text together.
- Refresh buttons say what they are doing:
  - Data & analytics, Set up's check, Alerts, the calendar comparison, Sensors' device list and System's update check read "Refreshing…" or "Checking…" while they work.
  - With reduced motion turned on, as Windows does when animation effects are off, every spinner stopped after one frame. Spinners now fade in and out instead of turning.
- Outdoor: Refresh on the "weather unavailable" card keeps the card in place while it retries, then says when it last tried. Before, the card blinked to "Updating" and back, so the button seemed to do nothing.
- Opening Stugu no longer flashes the "Add your first home" screen while the selected Home is still loading.
- Upgrade impact: application-only update; no API, schema, Compose, configuration or host-trust change.

## 0.52.18

Fixes found in a review of every page and tab.

- Charts show their full range as soon as the history arrives. They used to wait for the forecast as well, which is computed on request and can take tens of seconds. Until then a sensor's detail chart drew only its newest log page, about five hours of a 24-hour range, and said its history began there. The forecast is now added when it arrives, and the chart no longer reports where the history begins while the range is still loading.
- The Sensors page now treats a reading as current for 15 minutes, the same window Home, Overview and the floor plan use (`VITE_SPATIAL_MAX_SAMPLE_AGE_MS` still overrides it). Before, a sensor reporting every 10–15 minutes kept switching between Live and Waiting, and Sensors could show none live while Home counted most of them. A sensor that has reported before but not recently now says "Not reporting" instead of "Waiting for data". The summary tile and the status filter call both kinds "No recent data".
- Layout fixes:
  - Set up → Sensor mapping and the property's Tariff and Bill check cards have inner padding.
  - Property → Map layer names and the search and type filters no longer get cut off.
  - On phones, "View data for …" buttons with long sensor names wrap instead of running past the card.
- "1 item shown" and "1 home with a location" replace "1 items" and "1 homes".
- On the floor plan:
  - A room's name moves above a sensor marker that would cover it.
  - The zoom control no longer covers the west compass label. On tablets and desktops it moves to the top-left corner.
  - On tablets, the layer notes wrap above the temperature legend instead of covering it.
- Upgrade impact: application-only update; no API, schema, Compose, configuration or host-trust change.

## 0.52.16

- Set up → Connections: the note telling a Member that only an Owner or Admin can change TP-Link or Home Assistant credentials now has the same inner spacing as the other text in the "Enter an address manually" section. It sat against the section's border before.
- Upgrade impact: application-only update; one web style changes. No API, schema, Compose, configuration or host-trust change.

## 0.52.15

Power and energy charts on the Analytics page load in about half the time.

- A chart's summary (mean, spread and extremes) used to need a second pass over the same stored power and energy states at finer buckets. Chart and summary now come from one pass with identical results. On a Raspberry Pi, a 30-day power chart for four plugs went from about 8.5 s to about 4 s of database time, measured with today's samples still read raw.
- The count of readings outside the chosen quality filter no longer re-reads every raw sample since midnight UTC. Today's finished hours come from the hourly aggregate; only the last hour or two is read raw.
- Opening a chart no longer writes to the archive when its stored states are up to date. It prepares them only when a day is missing or out of date, or when today's states have not been started yet.
- Upgrade impact: application-only update; no schema, Compose or host-trust change beyond those of 0.52.7, which it builds on.

## 0.52.14

- Saving something in Stugu no longer makes every open browser reload the whole workspace. Before, each save (renaming a sensor, dragging it, adding a note, acknowledging an alert) reopened both live connections in every open tab and queued about 18 reads, which delayed the page you were looking at. Other tabs now reload only what changed: renaming a sensor reloads the sensor list and refreshes monitoring and analytics, and a new note reloads the notes. Adding or deleting a Home or property, membership and Stuguby changes still reload everything, as do changes a Guest is not allowed to see in detail.
- Opening activity and calendar comparison charts no longer announce themselves as workspace changes. While one was open, each load could trigger the next one and a reload in every other tab.
- Home monitoring answers are reused for up to 10 seconds, and routine integration polls no longer discard them. Gree and TP-Link republish their status after every poll; the cache is now cleared only when a connection's state actually changes, or by alerts, weather and saves. Open pages also stop refreshing monitoring for those polls.
- Upgrade impact: application-only update; no schema, Compose, configuration or host-trust change. The live-stream `mutation` event is unchanged, but `POST /api/v2/analytics/opening-activity` and `POST /api/v2/analytics/calendar-comparison` no longer emit one.

## 0.52.13

Electricity costs and analytics answer much faster, especially late in the day.

- "Calculating from stored history…" no longer takes 5–30 seconds on a Raspberry Pi. The cost and consumption figures used to re-read every raw power and energy sample since midnight UTC on every refresh: about 30,000 rows per fast plug by evening. The archive now keeps compact states for today's finished 15-minute periods and reads raw samples only for the last few minutes. Charts and summaries on the Analytics page use the same states.
- A meter that only reports power is no longer first checked for an energy counter it does not have, and a meter that only has a counter skips the power pass.
- The Energy page asks for its projection only after the visible summaries have answered, so they no longer queue behind it.
- Several requests could each hold one of the two analytics slots while waiting for an energy summary that needed the other. This happened with the projection, the optimizer and the Analytics Health panel. They now finish in the slot they already hold instead of waiting until the browser gives up.
- Invoice checks and the Health panel's bill comparison share one cached summary per closed period instead of recalculating each one.
- Refreshes keep what is already on screen:
  - Energy cost and consumption cards stay visible while a refresh is still preparing or fails, instead of switching back to "Calculating…".
  - Daily findings keep their content during the 15-second poll.
  - The "open now" state of doors and windows no longer blanks every minute.
  - The electricity history chart no longer shows a loading note on background refreshes.
- Repeated Analytics and export previews within the same minute reuse the server's cached answer.
- Upgrade impact: application-only update. The TimescaleDB archive gains two nullable columns (`sealed_until` on the ordered-state tables, schema migration 9), applied automatically when the API starts. Today's states are built in the background, so the first visit after an update or after midnight UTC still reads today raw until they are ready. Nothing waits for them.

## 0.52.12

- `npm run rpi:doctor` no longer reports `ARCHIVE_DATABASE: Archive syncing, caught up false` on a healthy, streaming Raspberry Pi. The API marks the TimescaleDB archive as not caught up for about a second after every new sample, until its next live flush. A production Pi was in that state for about half of its health reads, so two of three doctor runs said "attention" and `release:verify` refused the receipt even though there was no backlog. When the first read is not caught up, the doctor now re-reads the archive status up to four more times over about three seconds. It passes if any of those reads finds the archive caught up, or sees its last successful sync move forward. If the archive is still behind on every read (a stall, or a queue that keeps growing), the check warns as before, now with the queue length at the first and last read.
- The API, its `caughtUp` flag, the setup doctor in the web app, and the live-migration readiness checks are unchanged.
- Upgrade impact: no appliance update needed. Only the operator's `rpi:doctor` tooling changes. It works against any installed release, including 0.52.0, and a default doctor run takes up to three seconds longer when the archive is busy.

## 0.52.5

- Long chart ranges load much faster. The dashboard, sensor details and electricity charts, replay, per-sensor forecasts and the optimizer's flexible-load profiles now read their history buckets from the TimescaleDB continuous aggregates. Raw samples are read only for the partial periods at the range edges and for the newest period the aggregate has not finished. On a Raspberry Pi, the history of a power plug reporting every 2 seconds took 2.0 s for 30 days and 6.2 s for a year; it now takes 0.13 s and 0.32 s. A 14-day forecast history went from 0.20 s to 0.03 s.
- Chart values are unchanged: each bucket keeps the same mean and the latest reading's source, quality and unit. The 6-hour chart's 15-second buckets and installs without TimescaleDB still group raw samples.
- Upgrade impact: application-only update; no schema, Compose, configuration or host-trust change. The aggregates already exist on every TimescaleDB install.

## 0.52.1

- Document that 433 MHz (Nexus433) readings sent while the API is stopped, restarting or reconnecting to its private MQTT broker are not queued or replayed. Nexus packets carry no clock, so a replayed reading would get the wrong time; the Sensor shows a gap as long as the outage instead. The Nexus433 guide explains why a persistent MQTT session would not fix this, and the architecture's recommended failure behaviour now says the same.
- Upgrade impact: none. Only documentation changes; the API, web app, database, configuration, Compose and host trust are unchanged.

## 0.52.0

A code-health release: most of the work restructures the API and web app, with a few fixes and stricter behaviour you may notice.

- Security: Home Assistant, TP-Link, Telegram and Apple Notes credential routes and LAN discovery now require an Owner or Admin, like Gree, Tuya and Nexus433. Members see a translated note instead of the forms. Guests no longer receive other people's mutation events on the live stream, starting or stopping the local MCP runtime is audited, and spatial-layer routes refuse access when an authorization check is missing.
- Failed actions are explained in the viewer's language. Finnish and Swedish users saw the server's English error text before.
- The web app checks the shape of every API response and reports a clear error instead of showing broken values when one does not match.
- Fixes:
  - A shared Home with an invalid floor in a layout request answers 400 instead of failing with a 500.
  - Retrying an older dead-lettered notification works.
  - `GET /api/v1/forecast` for a hidden sensor answers 404 instead of a body the web app rejected.
  - Opening the spatial layers of a newly added Home no longer stores a default configuration.
- Scheduled exports, sensor-gap recovery, the Tapo mailbox, the TimescaleDB archive, Cloudflare Access sync, weather and spatial layers now record their failures in the system error log you can export, instead of only printing them.
- The Excel import checks workbooks with the bundled ZIP library, still stopping any entry that expands beyond its declared size.
- The API container image installs only the API's production dependencies, so it is smaller.
- Internal: numbered "part" files are replaced by modules named after what they own (route families, the database, Stuguby and TimescaleDB stores, the MCP server, the web API client and pages). The MCP server builds its services when it starts rather than when it is imported. The built-in measurement definitions come from one shared catalogue. About 22,000 unused imports and locals are gone, functions over the complexity limit drop from 301 to 294, and test coverage is now gated.
- Upgrade impact: application-only update; no schema, Compose or host-trust change. Clients of the HTTP API should note:
  - Request bodies with unknown fields answer `400 UNKNOWN_FIELD` (observations, maintenance tasks, properties and calendar comparisons said `INVALID_FIELD`), and a body that is not a JSON object says "Request body must be a JSON object".
  - `POST /api/v1/alert-rules` answers `{ rule }`, like `PATCH`.
  - The `TELEMETRY_ARCHIVE_REQUIRED` 503 always includes `details.archiveState`, and unexpected server errors answer 500 instead of being reported as a client 400.
  - The compatibility routes `/alerts`, `/alerts/{id}/acknowledge`, `/events`, `/snapshot`, `/static-parameters` and `PUT /sensors/{id}` keep their shapes for the iOS companion; the web app now uses the canonical routes.
  - Members (not Owners or Admins) can no longer change integration credentials.
  - An alert webhook configured through environment variables keeps working, and the setup doctor now checks signing for every webhook destination.
  - Built-in measurement definitions are unchanged on existing installs; fresh installs get the shared catalogue's labels and ranges.

## 0.51.4

- Rewrite the README for the current release. It now shows the app in light and dark screenshots of the sample home with synthetic data: Home Pulse, the live 2D plan, the 3D building, Data & analytics, and Electricity. Diagrams explain how readings flow from devices to the apps, how Properties and Homes own data, and the install paths. The version is no longer in the README title, where it had stayed at 0.32.3.
- Add diagrams to the documentation:
  - Architecture: the Compose deployment with its optional profiles, the analytics pipeline (cache, work limiter, archive rollups, analytics kernel), the background analytics jobs, and the workspace package dependencies.
  - Storage, system updates, live migration, Stuguby, electricity costs, and the first Home setup.
- The documentation index now links every guide, grouped by task, with plans, reviews and incident records in their own section. Twenty guides were not linked from it before.
- Correct outdated documentation: **Set up** has six sections, not four. The analytics guide now describes the query cache (0.48) and the backtested forecasts (0.45). Contributing names `npm run verify:local` as the gate and summarises the code-quality rules. Hosted CI is described as paused without saying the repository is private, since it is public.
- Upgrade impact: none. Only documentation and images change; the API, web app, database, configuration, Compose and host trust are unchanged.

## 0.51.2

- Lay out **Analytics health on this appliance** like the other Data & analytics tools: it now sits in the same list, with an icon, a short description and one disclosure arrow, and its contents are padded. Each response time, forecast, bill and projection check shows its name, its result and its on-target badge as separate columns, stacked on narrow screens. Before, the panel was unstyled, labels ran into their values and two disclosure markers showed.
- Upgrade impact: application-only update. API responses, configuration, database, Compose and host trust are unchanged.

## 0.51.1

- Simplify 23 of the most complex functions in the API, the web app and the spatial-layer engines without changing what they do. They include TP-Link and Home Assistant ingestion, Home Assistant history recovery, the spatial inference scheduler and engine host, notification delivery, alert follow-ups, the integrations setup page, and the web app's session start-up and live telemetry. Each now scores 15 or less on SonarCloud's cognitive-complexity rule (S3776), and the number of functions over that limit drops by 23.
- `npm run typecheck` now runs `npm run check:cognitive-complexity`. It scores functions the way SonarJS 4.2 does and fails when a file gains a function over 15 or an existing one gets more complex, compared with a committed per-file baseline. It uses the TypeScript compiler the repository already depends on, so no new dependency is added.
- New tests cover TP-Link snapshot errors, Home Assistant unit conversion and recorder history, spatial-inference failures, alert escalation and reminders, APNs delivery failures, spatial propagation classification and hydration replay.
- Upgrade impact: none. API responses, live updates, configuration, database, Compose and host trust are unchanged.

## 0.51.0

- The Data & analytics page has a new **Analytics health on this appliance** section. It shows how the analytics actually performed for the Home over the last 30 days, measured on the appliance:
  - how fast charts and the energy summary answered, against their speed targets
  - how often forecasts beat "no change" and how often their range held the outcome
  - how many entered invoices the cost model matched within ±2%
  - how the 30-day projection did against simply repeating the last month
  - how many daily findings came from how many compared series

  Each line says whether it is on target, off target, or still collecting. Owners and household members can see it; Guests cannot, because it includes bills.
- New endpoint `GET /api/v2/analytics/diagnostics`. The speed targets now live in one place, shared by the release benchmark and the appliance.
- The web app now checks the shape of the tariff, invoice, forecast, projection and diagnostics responses, and reports a clear error instead of showing broken values if one doesn't match.
- Upgrade impact: application-only update with an automatic SQLite schema addition (`analytics_latency_histogram`). The evidence starts collecting after the update. Database archive, configuration, Compose and host trust are unchanged.

## 0.50.0

- The Data & analytics page loads its chart data, outdoor history, recorded gaps, prices and forecasts through the shared query cache. Behaviour is unchanged: a failed refresh keeps the last data it had, a refresh keeps the chart visible until the new data arrives, and forecasts are reused for five minutes. Reopening the page no longer starts from nothing.
- Very long series no longer risk a browser or server error when charts, comparisons and thermal results take their minimum and maximum.
- Internal: the background SQLite reader is now called the local telemetry worker, since it serves history reads as well as costs.
- Upgrade impact: application-only update. Database, configuration, Compose and host trust are unchanged.

## 0.49.0

- The Energy page's 30-day outlook is now calculated by the server and tested against the Home's own history. It models daily use as a base load plus heating that follows the weather forecast. It is used only if, on past months, it predicted better than simply repeating the last 30 days; otherwise the outlook says it repeats the last 30 days. The range and confidence now come from how far those past predictions were off, not from how much data there is, and the outlook says how it did.
- The energy optimizer measures each device's own runs over the last week, such as a dishwasher or a water heater, and estimates the daily saving from moving them to the cheapest upcoming window of the same length. The baseload tip no longer shows a savings figure it could not measure.
- New endpoint `GET /api/v1/houses/{id}/energy-projection`. The optimizer report adds `flexibleLoads`.
- Upgrade impact: application-only update. Database, configuration, Compose and host trust are unchanged.

## 0.48.0

- Repeated analytics queries are answered from a server cache. A chart reopened in another tab or by another household member no longer recomputes, and the response reports whether it came from the cache. Ranges that ended more than two hours ago are kept for up to an hour; an import of older history makes them recompute. Ranges reaching the present are kept for 30 seconds.
- Raw history reads ask the time-series archive and the local database at the same time instead of one after the other. While the archive is up to date, the local database only reads the last 24 hours.
- The Energy page and the energy optimizer share one summary cache. A summary still waiting for some meters is shared for 15 seconds instead of being recomputed for every request. Optimizer reports are no longer thrown away on every door, heat-pump or device event, only when a Property, Home or sensor changes.
- The release checks now measure analytics speed on a year of readings, for 24-hour, 7-day, 30-day and 365-day charts and the 30-day energy summary. `scripts/benchmark-analytics.mjs` runs the same check against an appliance.
- Upgrade impact: application-only update with an automatic SQLite schema addition (`telemetry_history_revision` and its trigger). Database archive, configuration, Compose and host trust are unchanged.

## 0.47.0

- Analytics summaries (median, percentiles, extremes, spread) no longer change with the chart resolution. They are computed from fixed 1-minute, 15-minute or hourly buckets depending on the range, weighted by time where the measurement is a level, and each summary card says which base it used. Coverage is now measured against each sensor's usual reporting interval (the median gap over the last three days), so a sensor that lost half its readings shows about 50% instead of looking complete.
- Daily findings now report a difference only when it is clear beyond chance as well as large enough to matter. Each difference is judged against how much the earlier years varied and how noisy the days were. Electricity and indoor temperature are compared with earlier years moved to this month's weather. Sums are scaled up for missing readings. A false-discovery control covers every series compared, so a large house with many sensors no longer surfaces more chance differences. Each finding explains the weather adjustment and how clear the difference is.
- Home Performance judges each room against a comfort band for its kind (bedrooms 16–23 °C, bathrooms 20–27 °C, wider bands for storage, utility and garage spaces, 18–25 °C elsewhere) and leaves saunas out. Room parameters can set a band or exclude a room. The energy index is now a regression of daily energy on heating degree-hours: a base load plus a heating slope with a 90% interval. The comparison between the two halves of the period uses the slope, so a new appliance no longer looks like worse insulation. The heating base temperature is a house parameter (`heating-base-temperature`, default 17 °C instead of the former fixed 18 °C).
- Upgrade impact: application-only update with an automatic SQLite schema addition (`sensor_reporting_intervals`). Daily findings (`calendar-peer-findings-v4.0.0`) and Home Performance (`home-performance-v4.0.0`) are recalculated once. With only one or two earlier years, fewer daily findings may appear than before. Database archive, configuration, Compose and host trust are unchanged.

## 0.46.0

- Home Performance now measures energy the same way as the energy summaries: it uses the integrated consumption from the analytics engine (counter increments that survive a meter restart, power held for at most 15 minutes) instead of average power × hours. Usage right after a meter restart is no longer dropped, and a plug that went silent no longer counts a full hour of its last reading.
- The browser's energy charts and replay detection now use the shared analytics kernel for meter-restart handling, power-to-energy conversion and medians, so they can no longer drift from the server.
- Upgrade impact: application-only update. Stored Home Performance results are recalculated once (`home-performance-v3.2.0`). Database, configuration, Compose and host trust are unchanged.

## 0.45.0

- Forecasts are rebuilt and checked against what actually happened. Each forecast now starts from the latest reading instead of drifting toward the recent average.
- Temperature is forecast with the room's thermal response, driven by the FMI hourly outdoor forecast and corrected for what the model has recently been missing (heating, an open window). Humidity, CO₂ and other supported measurements use a daily-rhythm model that follows the current level and blends in the same hour yesterday.
- Every forecast is backtested on the last two weeks against "no change" and "same time yesterday". The better model is used, and its 90% band comes from its recent errors at each horizon, instead of a rule of thumb.
- A forecast that does not beat "no change" at six hours is no longer shown. The analytics chart explains why it is missing, or how much better than "no change" a shown forecast was.
- Each sensor's daily forecast evaluation is kept for a year, so long-run accuracy can be reviewed.
- API: `GET /api/v2/measurements/forecast` adds `evaluation` (`measurement-forecast/v2`) and returns no points when the forecast is withheld. `GET /api/v1/forecast` reports `backtested-v2` and returns points only where both the temperature and the humidity forecast passed.
- Upgrade impact: application-only update with an automatic SQLite schema addition (`forecast_evaluations`). A sensor needs three days of history before any forecast is shown, and sensors whose forecast does not beat "no change" show none. Database archive, configuration, Compose and host trust are unchanged.

## 0.44.0

- Thermal and moisture models now learn from every period the heat pump was off, not just the single longest one. With a heat pump that cycles through the day, rooms that previously stayed "collecting" can now be calibrated. Each stretch must last at least two hours, and together they must cover at least 24 hours.
- The time constant (and the moisture response time) is now searched continuously from minutes up to 1,000 hours instead of on a fixed grid capped at 240 hours, so well-insulated homes are no longer cut off. A fit at either end of the range is flagged.
- Both models add a daily cycle for regular daytime gains from sun and occupancy when the data shows one. This keeps those gains from distorting the base estimate.
- Isolation scores and time constants now come with a real 90% interval from a block bootstrap, shown next to each room and sensor score. The moisture response time reports its interval too.
- Heat-pump evidence is read in time order and condensed into on/off runs, so long windows no longer hit a fixed 50,000-row limit that could drop arbitrary polls.
- Thermal and moisture models now share one fitting framework instead of two copies.
- Upgrade impact: application-only update. Stored nightly thermal-isolation and moisture-response results are recalculated once, because their algorithm version changed. Thermal models report version 1.1.0, with optional `parameters.dailyCycle` and `quality.stretchesUsed`. Moisture quality adds `responseTimeLowHours` and `responseTimeHighHours`. Database, configuration, Compose and host trust are unchanged.

## 0.43.0

- Electricity contracts are now dated tariff versions. Each version sets the energy price (spot plus margin, or a fixed price that can be flat, day/night or seasonal), an optional transfer charge with the same schedule choices, electricity tax, and retailer and network monthly fees. A new version applies from its start date, so earlier periods keep the terms they were billed with. Edit them under **Property → Electricity → Tariff**.
- Costs follow the contract that was in force for each hour. Fixed-price contracts are no longer priced at spot plus margin. Until a fixed contract's energy price is entered, its cost shows as unavailable instead of a spot-based figure. Monthly fees are pro-rated by local calendar day and added once per Home.
- Energy summaries show what each cost includes: energy, transfer, tax and fees. The running-cost card shows the total with fees and the split below it.
- Prices shown as "Price now" and in price history are the variable price you pay per kWh (energy, transfer and tax) under the tariff. Raw spot prices are still stored unchanged.
- The running-cost card no longer estimates a cost from usage × the current price when historical prices are missing. It shows that the cost is unavailable.
- New bill check: enter an invoice's billing dates and total, and optionally its kWh and its energy, transfer, tax and fee lines. Stugu compares them with its own calculation and shows the difference per line. A total within ±2% counts as a match. Guests cannot see invoices.
- API: new tariff, invoice and reconciliation endpoints under `/api/v1/properties/{id}/electricity/`. Energy summaries move to schema 3 (`home-energy-summary/v3`), adding `totalCostEur`, `costBreakdown` and `tariffRevision`. Price points add `components`. The configuration's `marginCentsPerKwh`, `contractType` and `monthlyFeeEur` become optional and reflect the version in force today.
- Upgrade impact: application-only update with an automatic SQLite schema addition (two new tables). Each Property starts with one open-ended tariff version built from its current contract fields, so its margin now applies to all of its history until you add dated versions. Previously, each stored price kept the margin that applied when it was fetched. Fixed contracts need their energy price entered before costs are shown. Database archive, configuration, Compose and host trust are unchanged.
## 0.42.8

- Fix the remaining 11 security advisories in the development and test toolchain. None of these packages ships in the containers or the Raspberry Pi image:
  - `vitest` and `@vitest/coverage-v8` 4.1.12, which brings `@vitest/mocker` 4.1.12 (GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp, medium): code injection through mock registration, and a Windows path traversal past the mock allowlist.
  - `undici` 7.30.1 (GHSA-w293-vg96-wgc3 and GHSA-xjj6-f33q-929c, high, plus five medium and low advisories) and `sharp` 0.35.5 (GHSA-rgj7-g3m4-5g8c and GHSA-wq5f-xc86-pv6w, high). Both come from the Cloudflare test pool that runs the bug-report relay's tests. Even its newest release pins the vulnerable versions exactly, so a root `overrides` entry for `miniflare` moves them to the patched versions.
- Upgrade impact: no application change. Only development and test tooling is updated; the API, web app, database, configuration, Compose and host trust are unchanged.

## 0.42.7

- Add code-quality gates that fail the build instead of relying on written advice:
  - `npm run check:unused` counts unused imports, locals and parameters in every file. A file's count may fall but never rise, and a new file may have none. The baseline (22,269 today, mostly import headers copied by old file splits) is committed under `scripts/baselines/` and may only shrink. `npm run typecheck` runs the check as its last step, so `verify:local` and `ci:local` enforce it.
  - The architecture check now rejects a new numbered module (`part-NN`, `NN-name`, `name.part-NN`) anywhere in code, styles or tests, not only in the analytics and web data folders. The 336 existing ones are listed in a baseline that may only shrink.
  - The architecture check also rejects "keep identical" and "keep in sync" comments, which mark a type copied by hand instead of shared through `@climate-twin/contracts`.
- Claude Code sessions in this repository now run `npm run verify:local -- --fast` when a turn changed files or made a commit, and the turn cannot end while it fails. Turns that changed nothing skip the check. Set `STUGU_STOP_GATE=off` in Claude Code's environment to turn it off.
- `CLAUDE.md` has a new "Code quality" section with seven rules, each naming the check that enforces it. `AGENTS.md` points other agents to it.
- Upgrade impact: none. Only development tooling and documentation change; the API, web app, database, configuration, Compose and host trust are unchanged. `npm run typecheck` takes 10–25 seconds longer for the unused-symbol check.

## 0.42.6

- Fix the security and reliability findings from a SonarJS scan with the "Sonar way comprehensive" rules. Behaviour is unchanged unless noted.
  - 55 sorts of identifiers, timestamps and canonical JSON keys now pass an explicit code-unit comparator instead of relying on the default sort. The order is exactly the same as before, so signatures, cache keys and hashes do not change.
  - Simplify three conditionals whose branches returned the same value, give three `reduce()` calls a starting value, and rewrite two loops that changed their own counter.
  - The temporary file used while saving integration secrets now gets a cryptographically random name instead of one from `Math.random()`.
  - The electricity-price and Tapo private-endpoint checks now share one list of blocked private and reserved networks; previously each kept its own identical copy.
  - The API now turns off the `X-Powered-By` header where it creates the Express app. The header was already off.
  - The web API client no longer exports its set of in-flight requests; requests register through a small function instead.
- Reviewed and kept as they are: the blocked-network list, the MD5 signatures that the EWPE cloud protocol requires, the `http://homeassistant.local:8123` and LAN-address examples in setup forms, a Swedish "password" field label, and the `Math.random()` fallback that only runs when a browser has no Web Crypto.
- Upgrade impact: none. Database, configuration, Compose and host trust are unchanged.

## 0.42.4

- Tidy the web app's API client without changing what it does. Each client module now imports only what it uses, which removes 887 unused imports left over from when the client was split into several files.
- The live streams for telemetry, measurements and spatial layers now share one connection helper. They behave as before: "live" appears only after the connection has held for 0.75 seconds, a server that falls back to polling shows "reconnecting", and a session change closes the stream before the app reacts to it.
- Upgrade impact: none. Requests, live updates, configuration, database, Compose and host trust are unchanged.

## 0.42.2

- Update the web test environment to `jsdom` 30.1.3. This also removes a deprecated text-encoding dependency from the test toolchain.
- Running the test suites now needs Node.js 22.22.2 or newer, because that is what jsdom 30 supports. The manual CI test job uses Node 22.22, and the web tests stop with a clear message on an older Node instead of failing inside the DOM emulation. The contributor and local-CI guides are updated to match.
- Several buttons now always have a space between their label and count in their accessible names: the maintenance and sensor summary filters (for example "Overdue 1") and the spatial-layer toggles. Screen readers previously got that space only from the page layout.
- Stugu itself still runs on Node.js 22.13 or newer: `engines`, the setup check and the runtime-floor CI job are unchanged.
- Upgrade impact: application-only update. Apart from those accessible names, the change is limited to development and test tooling. Database, configuration, Compose and host trust are unchanged.

## 0.42.1

- Update dependencies:
  - API: `@modelcontextprotocol/sdk` 1.32.0 and `fast-xml-parser` 5.11.1.
  - Web: `lucide-react` 1.48.0 and `vite` 8.1.6.
  - Indirect dependencies: `hono` 4.13.13, `proxy-addr` 2.0.8 and `source-map-js` 1.2.2.
- Move the development launcher to `concurrently` 10.0.6. This also keeps its `shell-quote` dependency on 1.12.0, which is not affected by advisory GHSA-pqg4-j6r4-53mv.
- Fix four production dependency advisories published in October that had no update pending yet:
  - `body-parser` 2.4.0 (GHSA-27r3-jxmh-p828, high): denial of service in request-body parsing.
  - `zod` 4.6.7 (GHSA-mrhx-c7xc-m3w5, high): memory exhaustion while validating oversized collections, reached through the MCP SDK.
  - `fast-uri` 3.1.9 (GHSA-w74x-v6f9-j3xg and GHSA-xhq7-xmqj-769h).
  - `ip-address` 10.7.4 (GHSA-rxp7-6hxx-x8q5).

  `npm audit --omit=dev` now reports no production advisories. The lockfile now installs the pinned `fast-uri` version, which a previous dependency update had raised without updating the lockfile.
- Update the manual GitHub Actions workflows to `actions/upload-artifact` 7, `actions/download-artifact` 8, `docker/setup-qemu-action` 4, `docker/build-push-action` 7.4 and the SonarQube scan action 8.2.2. These run on Node 24 hosted runners; artifacts are still uploaded zipped and downloaded by name.
- Upgrade impact: application-only update with no database migration and no change to configuration, Compose or host trust. Development and CI still support Node 22.13 or newer.

## 0.42.0

- Counter-based measurements such as energy now keep the usage recorded after a meter restart in `delta` analytics, matching the consumption totals; previously the post-restart reading was dropped. A bucket with only one reading and nothing before it is now shown as missing instead of zero.
- Charts and tables now give the same answer whether a query is served from the long-term archive or from raw local samples:
  - Power charts are no longer marked "counter reset" when the load drops.
  - A reading imported twice through two integrations counts once for `delta` and time-weighted means.
  - The quality-filter warning no longer counts such repeats as excluded samples.
- Daily findings use the corrected energy deltas; existing findings are recalculated on the next scheduled run.
- Statistics, counter and kWh integration, time-weighted means and local-calendar boundaries now come from one shared analytics library instead of separate copies in the API. A new automated parity check compares the archive and raw paths on generated data with gaps, meter restarts, repeated readings, mixed quality and irregular timing.
- Upgrade impact: application-only update. There is no database migration, and stored rollups are reused, so no rebuild is triggered. Configuration, Compose and host-trust contracts are unchanged. `delta` values change only where a meter restarted within the selected range.

## 0.41.19

- Reorganize the API's analytics, forecast, thermal and moisture response, and electricity endpoints into dedicated modules, so later analytics and tariff work can change them in one place. Measurement ingest and snapshot endpoints move to their own module as well.
- Add an architecture check that keeps these endpoints out of the legacy numbered route chain, and lower the numbered-module allowance to 304.
- Upgrade impact: application-only update with no behaviour change. Endpoints, responses, caching, configuration, database schema, Compose and host trust are unchanged; existing telemetry and verified backups are retained.

## 0.41.18

- Complete verification of the privacy-preserving startup and container health diagnostics introduced in 0.41.17 by correcting the diagnostic collector's Python formatting.
- Upgrade impact: application-only update; no additional database migration, API, configuration, Compose or host-trust change. Existing telemetry and verified backups are retained. Appliance installation remains subject to its normal backup, readiness and rollback checks.

## 0.41.17

- Capture API startup failures from configuration, database/runtime initialization, archive readiness and HTTP binding using fixed error codes that exclude private configuration and data. Failed HTTP binding now closes the runtime cleanly.
- Record HTTP status and timeout classifications in container health probes, while keeping the existing readiness window and health requirements.
- Preserve queue, integration and index evidence when a bounded deep integrity check cannot finish. Summarize recent startup stages and container health failures without retaining raw logs.
- Upgrade impact: application-only update. Existing telemetry, configuration, backups, host trust and updater/Compose contracts remain compatible; no new database migration is introduced. The failed 0.41.15/0.41.16 installation cause has not yet been proven, and the next installation must be verified on the appliance.

## 0.41.16

- Give cold API startup the updater's existing ten-minute readiness window, including first-start sensor-history index creation on large databases. Successful probes still mark the API healthy immediately.
- Upgrade impact: application-only update. The sensor-history index from 0.41.15 is retained; existing telemetry, configuration, backups, host trust and Compose contracts remain compatible.

## 0.41.15

- Keep export previews, sensor measurement pages and setup integrity checks responsive on large local databases. Excluded telemetry is no longer counted, and heavy reads run in a bounded, cancellable worker.
- Avoid repeated full-window telemetry sorts in energy optimization and direct climate analyses. Repeated optimization reads share a short, scope-specific cache that expires or clears after configuration changes.
- Integrate local power costs in one ordered pass while preserving price changes, overlapping-price clipping, stale-data exclusion and duration coverage. The optimizer skips climate-only sensors when reading power history.
- Reject invalid playbook timing, improvement and target values with a clear client error before saving, including partial updates.
- Align OpenAPI with sharing metadata, dimensionless measurements, security events, derived monitoring evidence, Access synchronization and one-time MCP tokens. Return the public backup status without worker bookkeeping fields.
- Add a reproducible endpoint testing catalogue with ordered pairs, query variants, input boundaries and fixture workflows. Keep the API and diagnostics headings readable on narrow screens.
- Upgrade impact: application-only update; an additional sensor-history index is created automatically on first startup and may lengthen that startup on large databases. Existing telemetry, configuration and backups are retained. Host trust and Compose contracts are unchanged.

## 0.41.14

- Reduce long chart-history archive reads by skipping compressed metadata fields that are absent from the chart response. Preserve bucket averages, timestamps, latest-source ties, quality and units; full archive reads still retain metadata.
- Upgrade impact: application-only update; no database migration, public API, configuration, Compose or host-trust change. Existing history and verified backups are retained.

## 0.41.13

- Keep the API responsive during local chart-history reads by sharing the bounded read-only SQLite worker with electricity costs.
- Resolve local bucket provenance through indexed latest-sample lookups instead of sorting every raw observation. Preserve averages, source ties, units, quality, limits and inclusive or exclusive bounds.
- Upgrade impact: application-only update; no database migration, API, configuration, Compose or host-trust change. Existing history and verified backups are retained.

## 0.41.12

- Load long power-history charts faster by avoiding full-history source sorts and repeated decompression for each bucket.
- Preserve bucket values, latest-source tie breaking, quality, units and metadata while retrieving provenance in one bounded batch.
- Upgrade impact: application-only update; existing measurements, bucket averages, cost arithmetic, configuration and host-update trust remain compatible.

## 0.41.11

- Long power-history queries keep metadata out of full-history sorts and retrieve provenance only for returned buckets.
- Archive maintenance continues through a failed first startup and resumes ordered energy-history preparation after recovery. Closed-day replacement reads only its time partition.
- Upgrade impact: application-only update; existing measurements, bucket averages, cost arithmetic, configuration and host-update trust remain compatible.

## 0.41.10

- Load compressed electricity history and annual costs within each meter's selected time windows, reading each required cost day once.
- Preserve consumption, price changes, missing prices and partial coverage with the faster reads.
- Bound expired Pi database diagnostic checks inside their container and align private workspace dependencies for clean release builds.

Upgrade impact: includes the 0.41.8 and 0.41.9 candidate fixes. No database migration, configuration change, Compose contract change or host update is required. Existing readings and backups are retained.

## 0.41.9

- Correct private workspace dependency versions so the electricity fixes build and install from a fresh checkout. Check all workspace dependency pins and their lockfile entries before preparing a release.

Upgrade impact: includes the 0.41.8 electricity history, cost and diagnostic fixes. No database migration, configuration change, Compose contract change or host update is required. Existing readings and backups are retained.

## 0.41.8

- Load long electricity history and annual costs more efficiently on Raspberry Pi installations with compressed history. Keep reads within each meter's selected time windows and read each required cost day once.
- Preserve exact consumption and pricing through partial periods, meter resets, bounded power holds, changing prices and missing price intervals.
- Stop expired Pi database diagnostic checks inside their container so they cannot continue scanning after the diagnostic command has ended.

Upgrade impact: no database migration, configuration change, Compose contract change or host update is required. Existing readings and backups are retained.

## 0.41.7

- Prepare electricity history only across each meter's recorded range. Long periods no longer schedule a full year of empty history before a newly connected meter can answer.
- Keep unfinished ordered history retryable without falling back to expensive raw reads or requesting unrelated archive catch-up. Cost reads skip the full pricing calculation while their required summaries are still preparing.
- Automatically refresh preparing usage and cost views, keep their selections, and explain the loading state. Cancel cost requests when their view becomes inactive.
- Preserve internal counter gaps, the 15-minute power hold, quality/source filters and partial coverage of the originally requested period.

Upgrade impact: no database migration, configuration change, Compose contract change or host update is required. Existing readings and pending history work are retained; preparation may continue after installation.

## 0.41.6

- Reduce the time spent calculating Home and Property electricity costs as stored price history grows. Local calculations now seek only prices overlapping each measured interval instead of scanning the complete price history for every reading.
- Preserve counter resets, bounded power holds, price gaps, and clipping of legacy overlapping prices with the faster queries.
- Run file-backed local cost calculations in a bounded, read-only worker so dense history cannot stall the API. Cancel disconnected requests and stop scans that exceed their deadline.
- Include the preceding measurement and exact range-end counter observation when calculating chart consumption. Rolling windows now retain the same supported opening and closing intervals as the electricity summary, including in archived history.

Upgrade impact: no database migration, configuration change, or host update is required. Application and Compose update contracts are unchanged.

## 0.41.5

- Keep optional background reads from delaying Home and Property startup or visible electricity metrics, while preserving bounded request concurrency and save capacity.
- Find electricity-history coverage with indexed boundary lookups so Home summaries do not aggregate every archived sample before calculating usage.
- Calculate electricity charts from ordered consumption so meter resets and power-reporting gaps cannot inflate usage; mark conflicting simultaneous readings incomplete when their authoritative order is unavailable.
- Refresh current electricity prices and history, remove expired prices, and preserve unsaved contract edits during refresh.
- Restore chart views and meter selections through copied links and browser navigation, with retry and automatic recovery after history failures.
- Load the advisory optimizer on demand, calculate simultaneous Property power without double-counting submeters, and recommend only continuously priced periods.
- Keep summary controls readable on small screens, distinguish empty and permission-denied data, and remove consumption claims based on incidental chart history.

Upgrade impact: no database migration, configuration change, or host update is required. Application and Compose update contracts are unchanged.

## 0.41.4

- Update the bug-report relay tooling and its HTTP dependency with upstream security fixes.
- Restore type generation in fresh checkouts by creating the ignored output directory before Wrangler runs.

Upgrade impact: no database migration, configuration change, or host update is required.

## 0.41.3 — 2026-09-21

- Give verified update backups the existing 24-hour storage-backup allowance. Large SQLite integrity checks no longer inherit the 45-minute container-command timeout. Other command deadlines and uncertain-mutation recovery protections remain unchanged.
- Migration impact: none; application and Compose contracts are unchanged.

## 0.41.2

- Permit application-only releases when the sole appliance warning is unavailable signed host-feed metadata, with structured proof that no host journal or recovery is pending. Keep host trust checks and all other health gates intact.
- Preserve the host-feed warning in doctor receipts and explain the separate metadata renewal requirement.

Upgrade impact: no database migration, host update, or change to updater/Compose contracts.

## 0.41.1

- Correct electricity forecast descriptions for assistive technology.

- Keep the API responsive while reading large analytics windows, use the data volume for SQLite spill files, and serve archived history when a local read fails.
- Include the Raspberry Pi application-update recovery runbook and update application dependencies and build tooling.
- Restore electricity totals when archived calculations are catching up, and avoid expensive long-window fallback scans that can stall the appliance. Normalize quarter-hour price boundaries so cost calculations use the intended history summaries.
- Load electricity charts across the full selected range, preserve the selected meter when changing metrics, and exclude submeters from a whole-Home chart.
- Show unavailable and incomplete consumption explicitly with a retry action, keep current prices refreshed, and make mobile chart range controls readable.

Upgrade impact: No configuration or database migration is required. Existing stored prices are handled on read; archived calculations may briefly show partial data while summaries finish rebuilding.
- Keep thermal and moisture fits within uninterrupted passive periods; excluded heat-pump operation can no longer be joined back into a fit across a short gap.
- Exclude five-minute climate averages that overlap heat-pump exclusion boundaries.
- Explain unavailable thermal scores with the evidence period, usable continuous hours and sensor-specific reasons instead of implying that recordings are missing.
- Reuse materialized climate history while reading only uncached boundaries and the newest bucket from raw observations.
- Keep stale source-outage records from hiding recorded data, load full history for gap checks, and show loading while history is pending.
- Process sensor reconnections even if another history scan fails, and cancel requests promptly while archive synchronization continues.
- Upgrade impact: no database migration. Previous thermal and moisture artifacts become stale and refresh with the corrected calculation on the normal schedule or an explicit refresh. Some previously reported scores may become unavailable when their evidence crossed excluded pump operation.

## Unreleased

## 0.41.0 - 2026-09-04

- Keep thermal isolation and moisture response comparisons alive on homes with
  a cloud-connected Gree/Wilfa heat pump. The EWPE cloud poller previously
  ended its whole session on a single failed poll and journaled the pump as
  unavailable during every ~2-second reconnect. Those blips, padded by the
  verified-off exclusion policy, excluded entire evidence windows, so the
  nightly comparisons failed with "heat-pump evidence insufficient" every
  night (on the reference appliance: 19 nights in a row) while the panels
  showed a weeks-old empty result. The poller now retries transient failures
  in-session (a failed reconnect counts toward the same streak instead of
  ending the session), and the durable journal records unavailability only
  for outages longer than three minutes, backdated to the first failed poll.
  While the poller retries, the integration status keeps showing the pump as
  connected; it reports the failure once the session gives up, about a minute
  into an outage, as the local transport already did after three failed polls.
- Give an unavailability report no more weight than reporting silence in the
  passive-analytics evidence policy (`verified-heat-pump-off-v2`). The
  state-gap rule already trusts a verified pump-off report for up to five
  minutes of silence, so an `available: false` blip between two pump-off
  reports at most five minutes apart no longer breaks the pump-off evidence.
  Silence beyond a report's five-minute reach stays unclassified as before.
  This also makes the existing flap-polluted history usable again without
  touching the journal.
- Stop retrying derived-analytics jobs that failed for a deterministic reason
  (insufficient heat-pump evidence, over-large scope or result). They burned
  their whole retry budget on identical failures before being left alone.
- Say why a saved comparison's background update failed. The thermal
  isolation, moisture response, and home performance panels now explain
  recognized failure causes — most importantly scarce verified heat-pump-off
  evidence — instead of only showing a generic failure notice, in English,
  Finnish, and Swedish.

Upgrade impact: install the update on the appliance. Thermal isolation,
moisture response, and home performance algorithm versions were bumped, so the
first nightly run (or a manual Refresh) recomputes each comparison; homes that
were stuck on "heat-pump evidence insufficient" recover on that first run
because the new evidence policy reads the existing journal. No configuration
changes are needed.

## 0.40.1 - 2026-08-31

- Add an operator tool that diagnoses and repairs the appliance Tailscale
  connection over SSH. It reports the tailscaled service state, whether
  /var/lib/tailscale is backed by the persistent shared partition, the
  operator assignment, and the Tailnet login in one pass, and can complete a
  recoverable login. It refuses to continue when the service or the persistent
  mount needs host maintenance rather than reconnecting onto state that will
  be lost at the next update.

Upgrade impact: developer tooling only. No API, web, contract, or appliance
image behaviour changes, so no update needs to be installed on a running
appliance.

## 0.40.0 - 2026-08-26

- Keep application updates installable while the update feed's trust metadata
  is stale. Expired feed metadata previously failed the host updater and the
  combined safety gate hid the application install button, leaving appliances
  on the old version with no error reported anywhere. Faults that describe the
  remote feed now pause host updates only, with a precise explanation; faults
  that describe the machine itself still block everything.
- Explain the stale-feed state in plain language in English, Finnish, and
  Swedish instead of reporting an unsupported safety state.
- Report feed-scoped host updater faults as warnings in the appliance doctor,
  keeping hard failures for machine-state faults.
- Refuse to publish a release to a separate artifact repository without an
  explicit image prefix, and print every resolved image reference in the
  release plan. A derived prefix once pushed all seven images under a new
  private namespace that no appliance could pull from.
- Record the release-runbook lessons from the 0.39.4 cycle: verifying a
  checkout against origin/main before trusting it, why a drafted release never
  reaches an appliance, the environmental gate failures and their checks, the
  image-prefix trap, and how expired feed TUF metadata blocks promotion of an
  unrelated application release.

Upgrade impact: application-only release. Existing telemetry, configuration,
and durable analytics are retained; no schema rewrite, signed host update, or
factory image is required. Pairs with the feed-side TUF refresh automation in
the release repository, which keeps the trust metadata from expiring again.

## 0.39.4 - 2026-08-17

- Stop analytics queries failing outright when a single bucket holds a very
  large number of samples. Dense sensors could push bucket minimum/maximum
  calculations past a JavaScript engine limit and return a server error instead
  of a chart.
- Report the real cause when an electricity price feed is rejected. Malformed
  prices, duplicate intervals, and overlapping intervals previously surfaced
  only as a generic "refresh failed".
- Keep sample-source and archive-rollup analytics answers consistent, so the
  same query no longer reports different coverage or a different low-coverage
  warning depending on which source served it.
- Give an actionable message when an automatically chosen resolution still
  exceeds the point limit, instead of advising the automatic mode already in
  use.
- Protect every CSV export against spreadsheet formula injection, including the
  chart's exact-data download and the historical-import template.
- Speed up wide analytics queries by grouping source samples once rather than
  rescanning the whole window for each series.

Upgrade impact: application-only fix release. Existing telemetry,
configuration, and durable analytics are retained; no schema rewrite, signed
host update, or factory image is required.

## 0.39.3 - 2026-08-12

- Bound and prioritize browser requests so abandoned history work cannot block
  current data, saves, or recovery actions behind repeated 30-second timeouts.
- Keep successful history and analytics evidence visible across refreshes,
  cancel obsolete work, and recover authoritatively after hidden tabs resume.
- Push 24-hour history bucketing into the database path so the Raspberry Pi no
  longer reads large raw windows only to discard most samples in JavaScript.
- Explain known native updater safety states consistently while preserving
  unknown future states as blocked diagnostics.

Upgrade impact: application-only reliability patch. Existing telemetry,
configuration, and cached evidence are retained; no schema rewrite, signed host
update, or factory image is required.

## 0.39.2 - 2026-08-12

- Preserve exact release-commit provenance when publishing from a clean
  Windows checkout whose ignored verification outputs would otherwise make
  Buildx append a false `-dirty` suffix.

Upgrade impact: tooling-only follow-up to 0.39.1. Application behaviour and
stored data are unchanged; no schema rewrite, signed host update, or factory
image is required.

## 0.39.1 - 2026-08-11

- Batch selected sensor history into one cancellable, backpressure-limited
  analytics request that reuses the existing Timescale rollups and stops work
  when the page disconnects.
- Keep sensor and opening source tables lazy and paginated, and generate their
  CSV files only on request instead of building thousands of rows during the
  initial page load.
- Stabilize opening-history request windows, bound history and forecast work,
  avoid background Home Performance recomputation on a page refresh, and
  combine related connection failures into one useful notice.
- Report Raspberry Pi storage health from the writable `/persistent` data
  volume when present, rather than treating the immutable root slot's expected
  zero free space as a disk-capacity failure.

Upgrade impact: this is an application-and-tooling-only patch. Existing
telemetry, databases, configuration, and durable analytics are retained; no
schema rewrite, signed host update, or factory image is required.

## 0.39.0 - 2026-08-10

- Add canonical fast/full local verification with exact-input caches, stable
  failure codes, detailed logs, and commit-pinned JSON receipts outside Git.
- Split draft preparation, release verification, and final publication so CI,
  builds, ARM64 image identity, compatibility, visual acceptance, and target
  appliance evidence are each produced once and consumed by later steps.
- Add a one-session, read-only Raspberry Pi doctor with bounded default health,
  resource, container, archive/database, queue, integration, updater, and
  identity checks; expensive integrity and log checks require `--deep`.
- Include the application changes prepared since 0.35.7: correct cancelled-
  request logging and audit migrations, in-app bug-relay setup, bounded durable
  analytics, and heat-pump-aware passive thermal and moisture fits.

Upgrade impact: the first application start performs idempotent database updates
for audit, weather, projections, and durable analytics jobs. Existing telemetry
and last-good results are retained. This release does not require a signed host
update or factory image; future publication/deployment commands require matching
verification receipts.

## 0.38.0 - 2026-08-08

- Exclude powered, compressor-active, unavailable, and stale-gap heat-pump
  periods from passive thermal and moisture fits. A five-minute lead and
  thirty-minute recovery margin are applied, and insufficient state coverage
  now fails closed to the durable last-good result instead of being treated as
  heat-pump-off evidence.
- Remove the Gree/Wilfa equipment projection from ambient room comparisons,
  Home monitoring, Home Performance recovery/opening analysis, and daily
  environmental findings while retaining actual comfort exposure and energy
  outcomes.
- Report the classified, usable, excluded, and unknown heat-pump evidence in
  thermal, moisture, and Home Performance API results. Appliance power and raw
  compressor frequency are not normalized into delivered thermal output.

Upgrade impact: this application-only release changes derived analytics
identities and recomputes them under the verified-off policy. Existing telemetry
and last-good artifacts are retained; no database rewrite or signed host update
is required.

## 0.37.1 - 2026-08-08

- Keep experimental spatial-layer storage completely idle on ordinary House,
  live-map, replay, and analytics views. Spatial summaries and polling now begin
  only while the nested Spatial Layer Lab is open and stop when it closes.
- Combine the lab's current-layer and health reads so each refresh resolves the
  current snapshot set once, and index latest-run lookups by scope, engine, and
  start time instead of synchronously scanning and sorting retained run history.

Upgrade impact: this application-only patch creates one idempotent, bounded
index over spatial inference runs on first start. It retains spatial
configuration, snapshots, jobs, and raw data, starts no inference session, and
requires no signed host update.

## 0.37.0 - 2026-08-08

- Replace request-time thermal-isolation, moisture-response, and Home
  Performance recalculation with durable last-good artifacts, explicit refresh,
  stable Home-local nightly scheduling, and one shared host-load governor.
- Serve current opening state from a bounded SQLite projection, use cancellable
  archive reads only for explicit history/replay, and make the browser SSE-first
  with edit, visibility, reconnect, and replay load controls.
- Persist canonical outdoor-weather snapshots so pages and MCP reads never call
  FMI or Open-Meteo; serialize and coalesce provider refresh/recovery work in the
  background while preserving stale last-good data on failure.
- Turn experimental spatial inference into an authorized, timed Home session
  that is off by default, max-one and low priority, with no Property fan-out or
  measurement-triggered ambient inference.
- Keep heavy daily findings and historical sensor-gap recovery deployment
  opt-ins, remove full-history startup/live-ingestion scans, and isolate
  thermal/moisture fitting in a resource-limited worker.

Upgrade impact: this application-only release adds idempotent SQLite projections
and durable weather/analytics job tables; it does not require a signed host
update. Existing telemetry and last-good results are preserved. The v2 Home
Performance endpoint now returns the common durable-artifact status envelope;
v1 exact-window thermal and moisture endpoints remain available. Spatial
capability must be enabled by deployment configuration before the timed House
control is shown, but no inference session starts automatically.

## 0.36.1 - 2026-08-05

- Stop answering a cancelled request with "The request could not be completed".
  Navigating away from a page, or a background refresh clearing an analytics
  cache, produced a server error instead of a cancellation, and each one was
  filed in the system error log as a fault. Cancellations now answer `503
  REQUEST_CANCELLED` and are no longer logged, so **Advanced → System → Export
  error log** shows real problems again.
- Let a Monitoring Home page finish loading when a cache entry is invalidated
  while its data is still being read. The reader is now allowed to finish and
  answer the waiting page; only the caching of its result is skipped. This was
  most visible on the Raspberry Pi appliance, where the slower history read left
  a wide window for a routine event to cancel the request.
- Fix **Request system update**, **Change update settings**, **Change storage
  location**, and **Start Cloudflare setup** failing on installations upgraded
  from an earlier release. Each writes a security audit event, and the audit
  table in those databases still constrained subjects to the four kinds that
  existed when it was created, so the write — and the whole request — failed.
- Make the complete application release cycle transferable between agents with
  provider-neutral instructions, explicit private-source/public-feed tagging,
  operator-context and approval gates, artifact checks, failure recovery, and
  the separate host-signing boundary.

Upgrade impact: the security audit table is rebuilt in place on first start to
accept every audited subject; existing audit events are preserved and no
operator action is required. Clients that treated any non-2xx monitoring
response as an outage should treat `503 REQUEST_CANCELLED` as a retry.

## 0.36.0 - 2026-08-05

- Let an Owner or Admin enable bug reporting from **System → Bug report relay**
  by saving the relay address and shared token into the protected integration
  secrets file, instead of requiring deployment environment variables and a
  restart. Environment-provided relays stay read-only and cannot be replaced
  through the API.
- Keep the offered "Download copy" fallback working in Firefox and Safari by
  attaching the download anchor to the document and revoking the object URL
  only after the browser has started the download.
- Document the repository's build, test, invariant, and release expectations in
  `CLAUDE.md` for future contributors and assistants.

Upgrade impact: no persistent-data migration change. Deployments that already
set `BUG_REPORT_RELAY_URL` and `BUG_REPORT_RELAY_TOKEN` keep working unchanged
and now show the relay as read-only in the app; deployments without those
variables can configure the relay in **System → Bug report relay**, which
writes it to the existing protected integration secrets file.

## 0.35.7 - 2026-08-05

- Restore the Raspberry Pi host-update status in **Advanced → System** by
  accepting a legacy completed bridge record only when its target generation
  exactly equals the current host generation and its signed manifest identity
  remains valid.
- Include the target application version in every newly completed native host
  operation so future bridge records satisfy the full API contract directly.
- Distinguish an older GitHub stable or preview release from an available
  update, and hide redundant application target rows when nothing can update.

Upgrade impact: no persistent-data migration change. Host update selection,
exact-device qualification, explicit activation, shared mutation locks, signed
TUF/RAUC verification, A/B probation, and automatic rollback are unchanged.

## 0.35.6 - 2026-08-05

- Keep the native host-update bridge heartbeat independent from the durable
  host operation timestamp, so a healthy idle bridge remains connected in
  **Advanced → System** after the API's two-minute freshness window.
- Add a regression test that reproduces a completed native journal with an old
  timestamp and proves every bridge heartbeat reports its own current time.

Upgrade impact: no persistent-data migration change. This supersedes 0.35.5
for Raspberry Pi appliances; update selection, qualification, explicit host
activation, A/B probation, and automatic rollback are unchanged.

## 0.35.5 - 2026-08-05

- Create the bounded native host-update bridge directory during appliance
  startup, before systemd applies the bridge service's strict writable-path
  sandbox.
- Lock the ordering contract into the Pi OTA tests so fresh factory disks,
  restored appliances, and future A/B slots cannot regress into a restart
  loop even when the persistent directory does not exist yet.

Upgrade impact: no persistent-data migration change. Existing appliances keep
their operation history and permissions; the exact TS240 qualification,
explicit host activation, signed TUF/RAUC selection, A/B probation, and
automatic rollback remain unchanged.

## 0.35.4 - 2026-08-05

- Materialize the dedicated, unprivileged host-update bridge account while the
  immutable Raspberry Pi root is built, instead of relying on a boot-time
  sysusers condition that is intentionally false for a current EROFS image.
- Inspect the generated EROFS account and group databases before any host or
  factory artifact can be released, preventing a healthy application with a
  restart-looping native updater bridge from passing publication.

Upgrade impact: no persistent-data migration change. This patch supersedes the
generation-9 v0.35.3 host image with generation 10. A generation-9 appliance
can stage and activate it through the recovery SSH CLI; host activation remains
explicit and the signed qualification remains limited to the exact TS240
appliance.

## 0.35.3 - 2026-08-05

- Carry the unified, backup-first application and Raspberry Pi host-update
  experience forward as the direct installation candidate for the current
  TS240 SSD appliance.
- Bind host activation to that appliance's exact Pi, EEPROM, USB bridge, and
  storage fingerprint while retaining explicit restart confirmation, signed
  TUF/RAUC selection, shared mutation locks, A/B probation, and rollback.
- Record the accepted-risk first physical validation and preserve the future
  goal of remotely recoverable boot-chain, firmware, and recovery updates.

Upgrade impact: no persistent-data migration change. The existing generation-6
SSD requires one final offline factory transition with verified backup/restore.
The candidate uses host generation 9 and does not claim general hardware
qualification.

## 0.35.2 - 2026-08-04

- Make the unified update summary fail closed when the application update
  agent or native host updater is unavailable, a trusted target is incomplete,
  or a prepared host target is not bound to the active workflow.
- Keep verified in-progress workflows visible during their expected mutation
  interlock, but suppress update, retry, restart, and cancellation controls
  whenever a required updater safety state is unavailable or stale.
- Keep recovery, rollback, and component-specific failures ahead of generic
  availability while leaving externally managed hosts neutral and accessible
  application-only updates intact.

Upgrade impact: no persistent-data migration change. This preview uses host
generation 8 and retains explicit host activation, exact-device qualification,
TUF/RAUC verification, A/B probation, and automatic rollback.

## 0.35.1 - 2026-08-04

- Repair the clean-container release build by keeping the heat-pump test
  fixtures aligned with the full state contract.
- Record connected Wilfa/Gree heat-pump telemetry as sensor history and expose
  its complete available state in analytics plus calm 2D/3D room inspectors.
- Add a unified, backup-first application and native Raspberry Pi host-update
  workflow with separate component status, exact staged-target confirmation,
  reboot/probation reconnection, cancellation before activation, and fail-closed
  recovery handling.
- Isolate UI host intents behind a dedicated no-network, no-device,
  no-capability account while retaining native TUF selection, exact-device
  qualification, RAUC writes, shared mutation locks, A/B probation, and
  automatic host rollback.
- Fail host staging early when RAUC/SquashFS tooling is absent and retain
  exact-device qualification when a USB storage model is reported only by
  `lsblk`.

Upgrade impact: no persistent-data migration change from 0.35.0. Generation-6
hosts need a one-time audited CLI or factory transition before the unified UI
is available. Host activation remains explicit. This patch supersedes the
unpublished 0.35.0 factory candidate.

## 0.35.0 - 2026-08-04

- Let archived sensors with known recorded measurements be selected explicitly
  in Data & analytics, CSV/XLSX exports, and calendar comparison while keeping
  them out of live defaults, forecasts, and missing-data warnings.
- Persist each sensor's observed measurement catalogue independently of sample
  retention so archived history remains discoverable after compaction.
- Preserve Raspberry Pi appliance identity when a USB SSD exposes its model
  through `lsblk` but leaves the matching sysfs field blank, while retaining
  fail-closed validation for missing or invalid identity data.

Upgrade impact: the API creates and backfills a compatible measurement-catalogue
table automatically. Existing nonblank hardware fingerprints are unchanged;
factory and host-update publication remains a hardware-qualified preview.

## 0.34.2 - 2026-08-04

- Package the immutable boot and EROFS root payloads as generic `.img` members
  inside signed RAUC bundles so RAUC 1.13 selects its raw-copy handler for the
  appliance's raw A/B slots.
- Require the updater and release tests to accept only those raw-compatible
  bundle member names while preserving the exact signed image hashes.

Upgrade impact: this release supersedes the unpublished 0.34.1 preview as host
generation 6. It retains the combined H500, H200, Gree, telemetry-retention,
mobile overview, RAUC service, and signed A/B updater changes without a
persistent-data migration.

## 0.34.1 - 2026-08-04

- Install Debian's `rauc-service` package so signed host updates have the
  systemd unit, D-Bus activation policy, and service launcher required by the
  RAUC client.
- Reject incomplete updater hosts before download, and reject factory builds
  that omit any RAUC service runtime file.

Upgrade impact: this release supersedes the unpublished 0.34.0 preview as host
generation 5. It retains the combined H500, H200, Gree, telemetry-retention,
mobile overview, and signed A/B updater changes without a persistent-data
migration.

## 0.34.0 - 2026-08-04

- Allow a factory host-generation seed with no accepted manifest digest to bind
  its first same-generation repair only after explicit repair authorization and
  signed TUF/RAUC verification. Once bound, later repairs must still match the
  exact accepted manifest.
- Add a pinnable, configurable phone overview to mobile web and iPhone with
  attention-first Home or Property status, fresh temperature, humidity,
  electricity and CO2 summaries, and Room or Home breakdowns.

Upgrade impact: this release supersedes the unpublished 0.33.0 preview as host
generation 4. It combines H500, H200, Gree, telemetry-retention, mobile
overview, and signed A/B updater changes without a persistent-data migration.

## 0.33.0 - 2026-08-04

- Honor `RETENTION_DAYS=0` as an unbounded SQLite telemetry duplicate: do not
  compact it, and keep analytics/history available during TimeDB interruptions;
  genuinely bounded or gapped history still reports its limits.
- Add read-only Gree and Wilfa heat-pump discovery through local LAN and EWPE
  Cloud, with encrypted credentials, Timescale history, and clearly qualitative
  2D/3D influence markers. Stugu does not send heat-pump control commands.
- Include `squashfs-tools` in Raspberry Pi host images, reject an update before
  download when RAUC or `unsquashfs` is absent, and fail image builds that omit
  either executable.
- Retain the H500 compatibility, exact-device qualification, signed RAUC/TUF
  updater, redundant boot records, and automatic A/B rollback controls from the
  unpublished 0.32.x hardware-test candidates.

Upgrade impact: this combined hardware-validation candidate supersedes the
unpublished v0.32.3 factory image, which could not unpack a RAUC bundle. Host
activation remains gated by an exact hardware receipt and a backed-up
layout-v2 factory transition.

## 0.32.3 - 2026-08-03

- Preserve the `stugu` group on the signed host updater's systemd runtime
  directory so appliance operators can use the documented `stuguctl
  host-update` interface without root access.
- Retain the Raspberry Pi 4 USB 3 topology correction, H500 compatibility,
  exact-device qualification, signed RAUC/TUF updater, and rollback controls
  from the rejected 0.32.2 preview candidate.

Upgrade impact: this patch supersedes the unpublished 0.32.2 candidate. Host
activation remains disabled unless the immutable image contains a receipt for
the exact Pi, EEPROM, USB bridge, and storage fingerprint.

## 0.32.2 - 2026-08-03

- Correct Raspberry Pi 4 USB 3 boot-disk topology matching by translating the
  firmware VL805 root-port number to Linux's split USB 3 root-hub devpath.
- Add a Linux regression test with a decoy disk on the uncorrected topology so
  the strict resolver cannot silently select the wrong device.

Upgrade impact: this patch supersedes the unpublished 0.32.1 candidate and is
the bundled H500 and signed host-updater hardware-test release. The resolver
remains fail-closed; no sole-disk fallback is included.

## 0.32.1 - 2026-08-03

- Collect the generated host SBOM from rpi-image-gen's versioned target
  directory so the local Pi release publisher can complete the signed-host
  input set instead of failing after the factory image was built.

Upgrade impact: no runtime behavior changes relative to 0.32.0. This patch
supersedes the unpublished 0.32.0 release attempt and is the hardware-test
artifact for the bundled H500 and exact-device host-updater preview.

## 0.32.0 - 2026-08-03

- Add capability-based TP-Link Tapo H500 discovery and polling with an
  instance-scoped compatibility adapter for `python-kasa` 0.10.2. H100/H200
  instances retain their normal protocol path, and Stugu reports when H500
  firmware hides paired children from the local API.
- Add the signed layout-v2 Raspberry Pi host-update preview: TUF metadata,
  RAUC bundles, exact-device qualification, redundant boot records, a compiled
  early-initramfs A/B root selector, durable probation/reconciliation, and
  fail-closed p6 and wrong-disk guards.
- Add independent host signing/publication verification, updater/container
  mutation interlocks, hardware identity diagnostics, and a draft/prerelease
  release path for hardware validation.
- Persist identity-verified TP-Link DHCP address swaps atomically so temporary
  address collisions cannot restart the API.

Upgrade impact: application updates preserve existing H100/H200 connections and
data. H500 visibility is limited to children exposed by the hub's local API.
Host activation is preview-only, requires a new layout-v2 factory image and an
exact matching hardware receipt, and currently permits only an unchanged boot
artifact with inactive-root A/B replacement. Existing layout-v1 appliances
require a backed-up factory transition.

## 0.31.0 - 2026-08-02

- Add an Owner/Admin-started, bearer-protected Streamable HTTP MCP endpoint
  alongside the local stdio server, with the same fail-closed read-only tool
  allowlist and explicit stop/revocation controls.
- Let each Home schedule checksummed CSV exports to the installation NAS on a
  daily, weekly, or monthly local-time cadence, with bounded retention and an
  isolated storage worker.
- Prevent temporary review databases from silently taking over the primary API
  port, and distinguish missing thermal evidence, unavailable history, and
  explicitly simulated demo estimates in the thermal comparison.
- Keep file export and thermal comparison available from complete raw archive
  samples while optimized telemetry rollups catch up with live ingestion.
- Improve Data & analytics export controls and the Set up provider-card layout
  across desktop and narrow screens.
- Generate SSH server host keys independently on each Raspberry Pi appliance's
  first boot and preserve them across A/B and application updates instead of
  allowing a cloned factory image to reuse one server identity.

Upgrade impact: startup creates the scheduled-export records and queue state;
existing telemetry and storage configuration are preserved. Scheduled exports
remain inactive until an Owner/Admin configures the NAS and enables a schedule.
The first OS image adopting the SSH-key change rotates an existing appliance's
fingerprint once. Verify it through a trusted local or Raspberry Pi Connect
console before updating `known_hosts`.

## 0.30.0 - 2026-08-02

- Let each Property designate a default Home, use it consistently when opening
  Property and Home views, and keep the choice valid when Homes move or hide.
- Make telemetry and backup storage changes easier to understand and safer to
  enter with an explicit move plan, allowed-root validation, overlap checks,
  resumable progress, and a reset action.
- Preserve bookmarkable Home view modes, open layout editing directly, centre
  the 3D Home view, and improve setup, monitoring, analytics, and responsive
  status wording across English, Finnish, and Swedish.
- Count cancelled analytics work separately from failures and exclude aborted
  durations from execution metrics.
- Make private bug-report relay configuration available to Compose and
  Raspberry Pi appliances through a protected, upgrade-safe token mount.

Upgrade impact: startup adds and backfills the Property default-Home reference.
Existing telemetry, storage settings, and Home ownership are preserved. The
bug-report relay remains optional and requires an explicitly configured URL and
protected token file.

## 0.29.1 - 2026-08-02

- Let an application role reuse an existing telemetry schema without requiring
  database-wide schema creation privilege; a genuinely missing schema still
  fails closed when the role cannot create it.
- Exclude only TimescaleDB's built-in telemetry reporter from migration
  recovery when telemetry is disabled, and normalize restored non-finite run
  timestamps without weakening checks for real scheduled jobs.
- Detect and replace restored legacy bounded measurement refresh policies with
  the current lossless full-history policies before API startup completes.

Upgrade impact: startup repairs affected restored refresh policies in place.
No raw telemetry is deleted, downsampled, or rewritten.

## 0.29.0 - 2026-08-02

- Keep every raw telemetry sample in TimescaleDB while compressing older chunks
  and serving long ranges from quality-, source-, unit-, and aggregation-aware
  1-minute, 5-minute, hourly, and daily rollups.
- Preserve exact reset-safe counter, time-weighted, and energy-cost semantics
  through durable ordered rollup state, bounded query deadlines, caches, and
  keyset-paged raw history/export paths.
- Make the acknowledged SQLite telemetry copy a bounded 30-day hot cache for
  new installations while retaining compatibility with explicitly unbounded
  existing configurations.
- Add System storage settings for managed volumes, local SSD paths, local
  recovery paths, and mounted NAS recovery storage under an administrator
  allowlist.
- Journal storage migrations across clean PostgreSQL shutdown, restore-tested
  backup, capacity and filesystem checks, exact mount verification, durable
  rollback, and manual-intervention fencing without deleting the old source.
- Add persisted storage-growth forecasts, warning/critical local-capacity
  alerts, recovery notifications, database/component metrics, bounded error
  history, and authenticated Prometheus output.
- Fail backups closed when a configured NAS is missing or replaced, verify
  recovery-set capacity and restore drills, and preserve encrypted Cloudflare
  R2 backup handling.
- Stream federation recovery history and bound terminal notification payload,
  command, receipt, staging, and job history independently of authoritative
  telemetry, alert, audit, and revision records.

Upgrade impact: startup creates or repairs Timescale rollups and policies but
does not install raw-data retention. External storage must already be mounted
under `STUGA_STORAGE_ALLOWED_ROOTS`; PostgreSQL remains restricted to local
block storage, while NAS is supported for recovery sets.

## 0.28.0 - 2026-08-01

- Redesign the responsive web lifecycle from first account and Property setup
  through Home configuration and connection enablement, inferring safe defaults
  and keeping advanced controls available through progressive disclosure.
- Recompose Workspace, Property, Home, Live View, navigation, setup, and daily
  decision layers around the most important status and next action, with
  bookmarkable context and phone, tablet, and desktop layouts.
- Add richer interval-aware Home energy analysis with reset-safe counters,
  power-only integration, cost and projection fallbacks, ranked consumers,
  uncertainty, patterns, and practical recommendations.
- Make weather configuration Property-owned by default with explicit advanced
  Home overrides, automatic map/location inheritance, and read-only sharing
  safeguards that preserve separate authoritative records.
- Add an authenticated, consent-aware in-product bug-report flow with exact
  diagnostic preview, redaction and rate limits, backed by a least-privilege
  GitHub App relay fixed to the private issue repository.
- Harden role and visibility policy, deep-link restoration, structured
  confirmations, principal-scoped browser storage, and retained-data handling
  when a Home is hidden.
- Reduce default Home history fan-out from one request per sensor/metric to one,
  avoid spatial work while Live View is hidden, abort obsolete refreshes, and
  open measurement event streams immediately through buffering proxies.
- Complete Finnish and Swedish web/native catalogue coverage, improve Apple
  large-screen routes and ready-state errors, and make Watch state fallbacks
  safe for future values.
- Prevent live sensor readings from flickering between Good and Stale when the
  Stugu host and browser clocks differ by a small amount.
- Enable continuous NTP synchronization on Raspberry Pi appliances without
  making local startup depend on internet time being reachable.

## 0.27.1 - 2026-08-01

- Reduce initial web transfer size by lazy-loading non-English catalogs, serving
  pre-compressed immutable assets, and keeping telemetry hydration scoped to the
  active Home while preserving workspace-wide sensor identity and actions.
- Batch live measurement updates without sacrificing ordering or deduplication,
  and derive portfolio monitoring totals from coverage rather than hydrated
  telemetry.
- Bound electricity-price and Home Assistant history work by shared deadlines,
  response-size and sample limits; make backup scheduling fail safe on malformed
  state and make updater mutation recovery durable and process-tree aware.
- Retain Watch alert actions until the phone durably records them and returns an
  idempotent receipt, with bounded retry lifetime and clock-skew handling.

## 0.27.0 - 2026-07-31

- Refine the Home, Workspace, Property, Alerts, and room-comfort surfaces into
  calmer decision layers that lead with actionable exceptions and preserve
  critical guidance until the underlying condition resolves; acknowledgement
  remains lifecycle metadata rather than a dismissal.
- Treat monitoring trust as product state: distinguish pending, partial,
  unavailable, stale, estimated, and complete evidence; expose source,
  freshness, quality, and provenance without presenting unknown coverage as
  reassurance.
- Preserve Property sections, Home scope, browser history, deep links, and
  keyboard focus when switching context, while keeping Property-owned content
  correctly scoped and usable without a Home.
- Make alert-delivery retry eligibility explicit and enforce Owner/Admin
  authority server-side, with durable notification and sensor-gap schema
  migrations that preserve existing records during upgrade.
- Bound TP-Link temperature and humidity recovery by retained device history,
  record none/partial/complete recovery outcomes, and document source-specific
  Home Assistant and outage-recovery limits.
- Version iPhone, iPad, Mac, Widget, and Watch persistence migrations; bind
  Watch actions to the correct server, account, and Home; enforce per-alert
  authority plus offline/read-only action gating; and verify Finnish and Swedish
  localization coverage.

## 0.26.1 - 2026-07-31

- Keep Tuya discovery disabled during general network searches and require an
  explicit Device ID plus local key before any targeted Tuya probing begins.
- Discover the Tuya device address and LAN protocol automatically after opt-in,
  verify credentials locally without retaining the key in the browser, and
  retain manual address and protocol entry as a fallback.

## 0.26.0 - 2026-07-31

- Add disabled-by-default Nexus 433 MHz reception through isolated decoder and
  private MQTT profiles, with no receiver process, socket, retry timer, GPIO
  mount, or optional image pull on unsupported and disabled systems.
- Discover and explicitly attach Nexus senders to stable Sensors, including a
  revision-checked sender replacement flow that preserves history, placement,
  and alerts after battery-induced radio ID changes.
- Validate and bound untrusted radio input, deduplicate bursts, quarantine
  anomalous jumps, commit paired telemetry atomically, and use Home Assistant
  only as the stale or unavailable direct-source fallback.
- Package canonical Nexus433 separately under GPL-3.0-only with embedded rebuild
  inputs and a mandatory deterministic corresponding-source release artifact,
  without including Stugu application source.

## 0.25.1 - 2026-07-31

- Separate network discovery from provider-specific setup so Tuya, direct
  TP-Link, Home Assistant, and discovered Gree devices appear as independent,
  responsive connection cards.

## 0.25.0 - 2026-07-31

- Add local-first Tuya Wi-Fi light, switch, and metered-outlet support with
  authenticated LAN discovery, durable supervised workers, absolute commands,
  and protected local keys.
- Configure and control Tuya devices from their Home, place them once across
  the shared 2D and 3D views, and keep controls accessible during unavailable
  and pending states.
- Ingest only measured Tuya power into Home energy views, without estimating
  unsupported energy counters, and document the cloud-assisted key bootstrap
  plus fully local steady-state operation.
- Safely rebuild empty legacy tracking-preview tables during upgrade while
  refusing to discard non-empty legacy tracking data.
- Harden local-device durability with crash-recoverable credential commits,
  bounded host recovery, finite telemetry validation, and floor-plan integrity
  checks for placed devices.

## 0.24.2 - 2026-07-31

- Run the verified pre-update backup with Compose dependency startup disabled,
  preventing backup creation from reconciling or restarting live services.

## 0.24.1 - 2026-07-31

- Preserve the persistent release-state directory owner on atomic updater
  writes so unprivileged `stuguctl` can read candidate, known-good, and rollback
  manifests immediately after an OTA update.

## 0.24.0 - 2026-07-31

- Add an explicit six-second Raspberry Pi USB root delay for the observed
  bridge-enumeration race, and enable memory cgroups for Docker metrics and
  limit-aware service tuning.
- Keep thermal simulation and isolation responsive under load with cooperative,
  cancellable fitting, including REST and MCP requests; batch live browser
  telemetry, bound its retained tail, and replace the automatic-update
  maintenance-window CPU hot loop with a bounded, cached calculation.
- Recover a verified backup when the original Stugu source is unavailable,
  while retaining the target appliance's host settings, pairing encrypted
  tracking endpoints with their restore key, and preserving guarded rollback;
  activate TimescaleDB after the final database swap and refuse commit until
  due policies and the local archive have reconciled without a new failure.
- Keep a verified Cloudflare connection enabled across appliance reboots, keep
  failed setup disabled, and preserve the host secret bind path when the
  containerized updater invokes Docker Compose.
- Improve room-comfort evidence selection and move outdoor conditions beside
  floor/building maps with responsive layouts instead of obscuring the map.
- Let recovery-key operators gracefully reboot or power off a password-locked
  Pi through exact sudoers commands without granting general sudo.

## 0.23.0 - 2026-07-30

- Show Stugu API CPU use and event-loop responsiveness in System health, with
  sustained alerts and Prometheus gauges that expose single-core strain.
- Replace raw 30-day gap scans and full spatial payload ranking with bounded,
  indexed database queries, while keeping explicit TP-Link outage recovery.
- Coalesce live Timescale writes, browser monitoring refreshes, and TP-Link
  status work; disable unused contact polling and back off broken Stuguby links
  while preserving immediate state transitions and manual synchronization.

## 0.22.0 - 2026-07-30

- Add an Owner/Admin **System** view for host CPU, memory, data-volume storage,
  temperature, and uptime, with sustained built-in alerts in the System and
  Alerts views plus authenticated Prometheus metrics for external alerting.

## 0.21.0 - 2026-07-30

- Calculate Home electricity cost from time-aligned consumption and historical
  raw price intervals plus their effective contract margin.
- Reject overlapping tariff intervals, distinguish measured, estimated,
  partial, and archive-pending results, and prefer acknowledged TimescaleDB
  history for final costs.
- Add whole-Home, submeter, and independent meter roles so Home totals and the
  optimizer avoid double counting. Existing sensors migrate to independent
  meter behavior until their role is configured.
- Move automatic CI off paid GitHub-hosted runners and onto one local gate that
  validates, tests, builds, checks containers, and emits a release receipt.
- Add opt-in, client-side-encrypted Cloudflare R2 replication for verified
  recovery sets, with isolated egress, immutable promotion, and portable
  update/migration handling.
- Bind appliance updates to digest-pinned release manifests with factory and
  known-good rollback state, and make local release publishing attach the
  validated manifest and CI receipt.
- Support a private source repository through a separate public artifact
  release feed and optional read-only GHCR credentials, with an explicit,
  fail-closed updater contract transition for existing Docker and Pi installs.
- Make alert evaluation crash-safe, remove Stuguby history truncation, and
  expand restore drills across every control file and telemetry family.
- Stage Stuguby telemetry by grant epoch and atomically expose only completed
  snapshots, including crash-safe terminal replay and immediate narrowed-grant
  purging.
- Close runtime method-registration type holes, ratchet numbered-module debt,
  replace the mechanical line cap with a cohesion review plus hard ceiling, and
  begin extracting `createApi` into narrow domain route registrars.
- Prevent stale iOS scope requests and cross-origin WebKit redirects or cookie
  bridging from affecting the selected Property or Home.
- Fail closed on malformed web API collections, scope live invalidation to
  canonical query keys, and move sensor writes into the query-client owner.

## 0.20.2 - 2026-07-29

- Make Home electricity consumption and running cost server-authoritative across
  every meter, including power-only plugs through conservative bounded
  integration.
- Expose versioned per-source energy provenance through REST, OpenAPI, MCP, and
  a thin React Query client while preserving cumulative counters as preferred.

## 0.20.1 - 2026-07-29

- Include the server-authoritative monitoring model and localization catalog in
  the checked-in native Xcode application target.

## 0.20.0 - 2026-07-29

- Move Home Performance, Home monitoring/insights, opening activity, and
  calendar comparison to versioned server-authoritative analytics shared by
  REST, MCP, web, and iPhone clients.
- Replace the mechanically numbered `useClimateData` chain with named,
  ownership-based modules, one live-event coordinator, React Query analytics
  resources, and automated architecture boundaries.
- Correct expired opening-transition counting, room freshness and live power,
  exact wind bearings, and whole-home electricity aggregation.
- Require complete calendar evidence, invalidate bounded analytics caches on
  relevant writes, and make stale daily-finding versions visible while they
  recompute.

## 0.19.10 - 2026-07-29

- Emit Raspberry Pi initramfs files as one zstd stream to match the
  known-working Pi 4 USB-SATA path and reject divergent rescue/A/B payloads.
- Keep migrated Cloudflare tunnel tokens readable only by the bound host user
  and normalize legacy Stuguby coordinator metadata during upgrades.
- Record the failed v0.19.9 factory-image evidence and require a physical SSD
  hardware gate before publishing compatibility claims.

## 0.19.9 - 2026-07-29

- Restore Raspberry Pi firmware-managed kernel/initramfs pairing to prevent
  seven-flash Pi 4 USB-SSD failures.
- Select the immutable A/B root from a validated marker on the direct-boot
  partition, failing safely to slot A without unreliable firmware handoff.
- Validate the complete SSD layout and record the hardware recovery evidence
  and release gate.

## 0.19.8 - 2026-07-29

- Pin the Raspberry Pi update agent to the appliance's actual `stugu` Compose
  project so unattended releases inspect and update the running services.

## 0.19.7 - 2026-07-29

- Preserve the appliance deployment environment inside the privileged update
  agent so unattended releases keep every bind mount on persistent storage.

## 0.19.6 - 2026-07-29

- Validate migration health against the active OTA application release rather
  than the older version baked into an immutable Raspberry Pi factory OS.

## 0.19.5 - 2026-07-29

- Mount the complete migration settings root so clean appliances can replace
  environment, configuration, and secret files atomically.
- Recover safely on older immutable appliances by verifying bounded in-place
  writes when an exact bind-mounted settings file cannot be renamed.

## 0.19.4 - 2026-07-29

- Stage quiesced SQLite sources in private writable storage before snapshotting,
  preserving read-only source mounts on every supported Node.js 22 runtime.

## 0.19.3 - 2026-07-29

- Read quiesced WAL-mode SQLite databases safely from read-only backup mounts
  during cutover, while failing closed if a WAL sidecar remains.
- Keep appliance maintenance locks writable by both root services and the
  authenticated `stugu` migration user after clean boots and updates.
- Allow clean-install safety backups without an integration-secrets file and
  keep Timescale ownership validation compatible with non-interactive `psql`.

## 0.19.2 - 2026-07-29

- Run appliance maintenance and migration jobs with the active last-known-good
  application release, including after updating an older immutable factory OS.
- Treat absent auto-discovered optional secret roots as empty while retaining
  strict validation for explicitly configured migration inputs.

## 0.19.1 - 2026-07-29

- Include the split live-migration target modules in the maintenance image and
  guard their packaging so appliance seed and cutover commands work in releases.

## 0.19.0 - 2026-07-29

- Add read-only direct Gree/Wilfa heat-pump discovery, Home-scoped setup,
  polling, durable observations, Timescale history, protected connection
  settings, migration support, and localized web guidance.
- Move bucketed measurement analytics into complete database-side archive
  rollups, preserve quality, counter, rate, and coverage semantics, and name
  partial Home-performance evidence sources instead of reporting only a count.
- Make Pi 4 USB factory images boot their complete first FAT partition directly,
  preserve firmware-qualified slot aliases across `switch_root`, repair clean
  shared-state initialization, and reject self-redirecting `autoboot.txt`
  layouts that caused seven-flash and reboot-loop failures.
- Keep LAN, persistent Tailscale, full-disk growth, EEPROM USB compatibility,
  and health-gated GitHub container updates enabled in clean appliance builds.
  Stable application releases install automatically in a weekly window;
  unsafe Raspberry Pi Connect OS partition deployment is disabled for Pi 4 USB.
- Existing SQLite and Timescale databases migrate automatically. Tailnet login
  remains a one-time operator authorization, and immutable OS/kernel changes
  require a newly validated factory image plus backup or migration.

## 0.18.2 - 2026-07-29

- Fixed clean Raspberry Pi factory builds so the first-partition USB rescue
  filesystem receives the complete firmware, kernel, initramfs, and autoboot
  payload instead of only its partition metadata.

## 0.18.1 - 2026-07-28

- Fixed Raspberry Pi factory-image generation by using a valid FAT16 cluster
  size for the enlarged first-partition USB rescue filesystem.

## 0.18.0 - 2026-07-28

- Add bounded hybrid SQLite/Timescale history reads, archival coverage and
  recovery safeguards, richer daily analytics, and full electricity-history
  exploration without presenting incomplete archive data as complete.
- Add replay-aware outdoor context and influence overlays, resumable
  integration discovery, and clearer Stuguby grant/identity repair workflows
  across the API and web product.
- Make Raspberry Pi 4 factory images boot reliably from USB SSDs with a
  complete first-partition rescue payload, explicit Pi 4 kernel/initramfs
  selection, portable initramfs A/B aliases, and firmware-qualified udev
  device links.
- Expand the final persistent partition across the complete SSD after moving
  the backup GPT, remove early-boot systemd ordering cycles, seed shared
  container state once per release, and accept either Ethernet or Wi-Fi as
  the appliance uplink.
- Keep stable EEPROM USB settings, LAN access, and an enabled persistent
  Tailscale client in every appliance build. Existing application databases
  migrate automatically; Tailnet enrollment remains a one-time operator step.

## 0.17.1 - 2026-07-28

- Make Raspberry Pi appliances reachable on their private LAN by default,
  include an enabled Tailscale client whose identity persists across A/B
  updates, and add one-command Tailnet login and access discovery.
- Keep first-owner setup protected on network-bound appliances with a
  device-generated persistent secret delivered through a private browser
  fragment instead of weakening the local bootstrap boundary.

## 0.17.0 - 2026-07-28

- Make clean Raspberry Pi installations self-healing when PostgreSQL
  initialization is interrupted, persist the APNS secret mount, and include
  every update-agent module in its container image.
- Validate the complete factory image under Linux before release, including
  the protective MBR, GPT, six named partitions, A/B slot contents, filesystem
  signatures, and Pi firmware boot files required for USB SSD boot.
- Redesign calendar comparison around two explicit periods. Week views now
  align Monday through Sunday, months use seven-day blocks, years use months,
  and decades use years. The view can compare a stable selected-sensor
  aggregate or one sensor, reports signed headline differences over shared
  completed buckets, and preserves local-time partial and missing evidence.
- Poll T110 trigger logs every 500 ms by default so quick door/window cycles are
  retained once, even when both transitions occur between full hub polls, and
  replay retained logs after restarts to backfill recoverable outage events.
  Push persisted opening states over the existing live stream so both 2D and 3D
  views update without waiting for their periodic reconciliation poll. Keep
  every Home visual event-driven too: streamed measurements, readings, weather,
  alerts, and spatial layers now render without waiting for the visual clock.
- Bring those TP-Link door/window contacts into the native iPhone companion
  with live state, protected offline snapshots, bounded opening history,
  transition summaries, and a handoff to the full management surface.

## 0.16.1 - 2026-07-27

- Fixed Raspberry Pi 4 factory images installed on USB storage so initramfs
  securely resolves the firmware-selected disk and binds its A/B system slots.

## 0.16.0 - 2026-07-27

- Redesigned opt-in equipment tracking around explicit profiles, bounded
  evidence, people-presence sharing, and matching iOS and web workflows.
- Isolated Stuguby shared Homes from local demo/replay telemetry, integrations,
  gap recovery, weather, analytics, alerts, openings, and other local-authority
  data, including browser fallbacks and stale federation projections.
- Existing databases migrate automatically. Federation grant, suspension,
  revocation, and regrant transitions now clean and rematerialize projections
  without transferring local credentials or integration state.

## 0.15.0 - 2026-07-27

- Move expensive AMD64/ARM64 container and Raspberry Pi artifact publishing to
  a guarded local release command, with immutable image digest resolution,
  release asset upload, optional Connect deployment, and an explicitly
  confirmed GitHub-hosted fallback.

## 0.14.2 - 2026-07-27

- Align the Raspberry Pi image-generator layer and build overrides on the
  declared `stugu` variable prefix so appliance assets and immutable image
  references reach the custom image hook.

## 0.14.1 - 2026-07-27

- Build architecture-neutral web assets on the native Docker builder before
  packaging AMD64 and ARM64 images, preventing Raspberry Pi release builds from
  timing out under ARM emulation.

## 0.14.0 - 2026-07-27

- Split oversized application, API, persistence, protocol, localization,
  styling, tooling, and test sources into focused modules while preserving
  existing public entry points, and added an enforced 600-line source-file
  ceiling.
- Made iPad and Mac Catalyst present the complete server-hosted web product
  with shared sessions, native downloads and confirmations, Apple-only actions,
  deep links, and a protected offline companion fallback; iPhone keeps the
  deliberately lighter native tab interface.
- Expanded the iOS 26 Inventory map with Property boundaries, areas, and Homes,
  plus one-shot current-location and Property-aware map-pin choices when adding
  equipment.

## 0.13.0 - 2026-07-26

- Added actionable native iOS notifications sent directly from each Stugu
  server through APNs, with per-device Home/severity filters, generic previews
  by default, and invalid-token cleanup.
- Added protected offline Home snapshots and chart history, bounded idempotent
  queues for field capture and alert acknowledgement, and explicit cached-data
  freshness.
- Added iOS Home and Lock Screen widgets, App Shortcuts, deep links, QR-assisted
  quick capture, and evidence-based read-only Today guidance.
- Added reviewed, geometry-only RoomPlan imports for supported LiDAR devices
  and a dependent Apple Watch companion for status and alert acknowledgement;
  neither path copies Stugu credentials or raw room imagery to the Watch/server.
- Existing databases migrate automatically. Push remains inert unless the
  complete optional APNs credential tuple is configured.

## 0.12.0 - 2026-07-26

- Added a Property-wide Inventory for maintainable equipment with stable QR
  identity, notes and issues, borrowing and return history, assigned locations,
  and an uncertainty-aware tracked state without creating a second asset model.
- Added opt-in BLE equipment tracking with rotating authenticated identifiers,
  scoped observer credentials, bounded evidence retention, confidence and
  freshness estimates, movement and exit signals, a simulator, and an
  explicitly estimated Property map. Tracking remains inert until its
  deployment flags are enabled.
- Added a native iOS companion for authenticated Home monitoring, alert
  acknowledgement, inventory QR scanning, BLE observation, Find nearby, and
  explicit foreground member-presence sharing that expires promptly and does
  not retain a location trail.
- Encrypted provisioned tracking secrets with a host-held key, required that
  key in verified backups containing tags, limited observer request size and
  credential abuse, stopped unavailable tracking polls, and accepted weak
  inventory ETags.

## 0.11.1 - 2026-07-25

- Clarified the Stuguby Host and Client flow: Hosts connect their Property
  without migration, moved Client Homes retain their authority and full edit
  access, and other participants receive a read-only overview marked with the
  three-cottage Stuguby symbol unless broader access is explicitly shared.
- Expanded the local MCP server to a strictly read-only 54-tool inspection
  surface covering current Stuguby, analytics, energy, actions, maintenance,
  integrations, backup, and readiness data, with SQLite read-only and
  query-only enforcement.
- Added a guarded maintenance script for removing an orphaned legacy Stuguby
  when malformed pre-0.11 grant data prevents the normal UI lifecycle. It
  requires exact identity confirmation, creates and verifies a complete backup,
  refuses adopted Properties, preserves Home and Property rows, restores
  stopped services after failure, and verifies SQLite after restart.

## 0.11.0 - 2026-07-25

- Added Stuguby Property adoption with clear separation from local Properties,
  reviewed merge-and-delete migration, durable offline edits, coordinator-wins
  conflict handling, and explicit permanent disconnect.
- Shared Homes are read-only by default and can opt into synchronized manual
  inventory edits. One designated successor can retain a complete sanitized
  recovery copy and promote it during Server decommissioning; integrations,
  endpoints, credentials, controls, and accounts remain local.
- Added subtle Stuguby ownership, edit, pending, conflict, recovery, and offline
  states throughout the existing Property and Home interface, plus the
  three-cottage Stuguby mark.
- Enforced the same Stuguby ownership rules across REST and MCP, including
  owner-only integrations and binary floor-plan authoring.
- A sensor can now keep direct TP-Link and Home Assistant bindings together:
  the healthy direct path is preferred for live data, Home Assistant provides
  failover and recovery, and equivalent handover samples are not duplicated.
- Stuguby coordinators can now be connected to Cloudflare from the authenticated
  local Stugu UI. Stugu registers a private OAuth client from a one-time OAuth
  Client Write bootstrap token, completes PKCE consent, hands the in-memory
  grant once to the trusted host agent, provisions and verifies the boundary,
  and revokes temporary access. Existing installations reuse their runtime
  Access-group token; new installations enter it once in the UI. No provider
  token is stored in browser storage or the host-agent queue. Interactive
  Docker installs and remote-UI upgrades now continue in this UI automatically;
  explicit Cloudflare CLI flags remain available for automation and recovery.
- Stuguby setup now asks how people will use Stugu, suggests and verifies the
  existing secure address, and gives plain recovery guidance instead of a
  disabled technical form. Existing Cloudflare remote access upgrades reuse
  the retained runtime approval, request one temporary owner approval, then
  provision and verify the coordinator automatically. Reruns preserve the
  installed runtime, data mode, web port, and connected update helper.
- Cloudflare provisioning can now obtain its temporary approval through an
  Authorization Code + PKCE browser flow. Setup validates a loopback callback,
  never retains the OAuth token, revokes the access token after success or
  failure, and keeps the exact-zone API-token path available for multi-zone
  accounts.
- Added a guarded **Delete Stuguby** action under Advanced. It removes local
  federation records and cached assets without touching Home data, and refuses
  deletion while memberships, Home grants, or replica deletion receipts remain
  active.

## 0.10.1 - 2026-07-24

- Fixed Docker and Podman startup permissions across Linux, macOS, and Windows
  by selecting rootless-safe named volumes, applying shared SELinux labels to
  host binds, and writing explicit exports with the runtime-mapped identity.
- Added portable local-mode CI, verified scheduled-backup export, dynamic
  container DNS for API recreation, and cross-platform setup/runtime checks.

## 0.10.0 - 2026-07-24

- Added an explicit Docker setup option to install and immediately start the
  host update agent as a per-user startup service. The opt-in wizard warns that
  the agent has Docker-administrator authority; unattended setup must pass
  `--install-update-agent`.
- Fixed host update agents to target the Compose project derived from the
  installation directory instead of an unrelated hard-coded project. The
  agent now verifies the running API and web before backup and never attempts
  rollback when a pre-update backup fails before release state changes.

## 0.9.0 - 2026-07-24

- Added guided Cloudflare Tunnel + Access onboarding to the setup wizard for
  Docker and Podman. It accepts tokens only through hidden input or protected
  files, enforces separate setup/runtime credentials, provisions least-scope
  path policies, starts the connector, verifies the complete edge boundary,
  and stops public ingress automatically if verification fails.
- Fixed Stuguby coordinator upgrades to repin unjoined loopback federations,
  revoke stale origin-bound invitations, block unusable admissions, recreate
  origin-consuming services, and verify the complete public invitation handoff.

## 0.8.0 - 2026-07-24

- Added a cross-platform setup wizard for local Node.js, Docker, Podman, and
  Raspberry Pi appliance onboarding. It configures only the essential data
  mode and container port, preserves existing secrets and advanced settings,
  validates container Compose configuration, and supports dry-run automation.
- Fixed local API, development, and MCP commands to load the root `.env` and
  resolve runtime paths from the repository root. No data migration is needed.

## 0.7.0 - 2026-07-24

- Added an evidence-led Home performance review covering comfort exposure,
  ventilation recovery, opening effectiveness, heating-energy normalization,
  measured maintenance outcomes, and sensor health, with explicit provenance,
  coverage limits, responsive presentation, and English, Finnish, and Swedish
  guidance.
- Added bounded opening-state history and Home-scoped action-run queries, while
  enforcing maintenance-task ownership across Home and property boundaries.

## 0.6.0 - 2026-07-23

- Added Owner/Admin system-update management backed by GitHub Releases,
  including installed/latest version visibility, release notes, stable or
  preview channels, configurable checks and local-time maintenance windows,
  manual update requests, and live operation status.
- Added a platform-neutral Docker update agent with trusted GHCR release
  validation, pre-update backup, health-gated replacement, and automatic
  rollback. Docker Desktop and ordinary Docker Engine can run it on the host;
  Raspberry Pi appliance images enable the isolated `self-update` sidecar and
  preserve the selected container release across A/B operating-system slots.
  No database migration is required.

## 0.5.0 - 2026-07-23

- Added resumable live Stugu-to-Stugu migration over authenticated SSH with
  online seed snapshots, content-addressed chunks, portable settings and secret
  transfer, final writer quiescence, isolated TimescaleDB candidate restore,
  full backup verification, health-gated commit, automatic target rollback,
  durable receipts, and fail-closed split-brain protection.
- Added inert-until-granted Stuguby federation for independently administered Stugu nodes,
  including shared common-property management, per-Home/per-dataset consent,
  privacy-preserving publication IDs, signed and replay-protected HTTPS events,
  durable SSE cursor notifications, bounded raw telemetry sharing, replica
  retention and deletion receipts, a translated owner UI, and strict protocol
  rejection of integrations, secrets, account identities, and remote control.
  The coordinator-only Cloudflare path is now automated with a server-pinned
  origin, narrowly scoped Access exception, origin rate limits, and fail-closed
  boundary verification; participants remain outbound-only.

## 0.4.1 - 2026-07-22

- Fixed the Raspberry Pi factory-image export on Debian Trixie by using the
  portable `zstd -o` output option after the hosted ARM64 build completes.

## 0.4.0 - 2026-07-22

- Refined the primary Home, property, setup, alert, and analytics workflows
  with progressive disclosure, lazy-loaded specialist surfaces, exact CSV
  export, correct connection-first remediation, multi-P110 integration
  coverage, actionable local-origin guidance, and extensive keyboard and
  screen-reader improvements.
- Added an idempotent daily Home analytics run with persisted month-to-date
  findings for indoor sensors, observed outdoor weather, electricity
  power/energy, and heartbeat-deduplicated door/window openings, plus an
  evidence-first responsive UI and read-only v2 endpoint.
- Added house-timezone calendar comparisons for sensor days, ISO weeks,
  months, years, and decades across all available SQLite/Timescale history,
  reusing the all/single/multiple-series selection with coverage-aware
  aggregation, archive warnings, and an accessible responsive table and chart.
- Added webhook fan-out to as many as 16 stable destinations with independent
  credentials and health, optional HMAC-SHA256 signatures, exact host
  allowlisting, immutable per-destination outbox rows, bounded attempts, durable
  dead letters, and Owner/Admin manual retry.
- Added an Owner/Admin-only append-only security audit API for authentication,
  membership, integration credential, and bridge-grant lifecycles, plus
  restart-persistent automated credential rotation/revocation drills that prove
  retired secrets do not remain in the protected secrets file or audit records.
- Verified restart-safe wall-clock alert deadlines: durable sustained
  conditions now have explicit integration coverage proving they open without
  a second sensor sample and without inventing telemetry.
- Hardened the optional Cloudflare Tunnel/Access deployment with a durable
  static edge-operator allowlist, separation from the local Stugu owner login,
  fail-closed upgrade validation, generated-config regression coverage, and a
  provisioning, rotation, recovery, and rollback runbook.
- Added independently toggleable experimental Air movement and Sensor support
  overlays to both the 2D Home plan and 3D Home volume, with persisted view
  preferences, sparse-data qualification, in-view placement markers, and
  research-grounded suggestions for improving sensors and building inputs.
- Added a local-only, failure-isolated experimental spatial-layer engine with a
  separate state database, versioned house/property snapshots, sensor-quality
  and psychrometric layers, graph-constrained propagation evidence, research
  zone-activity evidence, and shared accessible 2D/3D presentation contracts.
- Added property management with required house-to-property ownership,
  user-drawn mapped areas, area equipment, targeted notes, and property-owned
  maintenance that also works for land-only properties.
- Added built-in local owner, administrator, and Guest accounts for one
  workspace, with server-managed HttpOnly sessions, read-only Guest access,
  least-privilege property, house, and area grants, and fail-closed historical
  access.
- Hardened live telemetry hydration and reconnects with subscribe-before-snapshot
  buffering, bounded SSE backpressure, exact history truncation, chronological
  downsampling, and provenance-safe real-data state transitions.
- Added a durable, retrying outbox for alert notifications, with stable webhook
  idempotency keys and revision/generation fences that prevent stale delivery
  attempts from overwriting newer work.
- Hardened Home Assistant, TP-Link, Telegram, and weather
  integrations around validation, lifecycle cleanup, credential consistency,
  bounded handshakes, and race-safe configuration changes.
- Added native Telegram alert delivery with guided private-chat discovery,
  write-only bot credentials, delivery testing, redacted health, and an
  independent per-rule opt-in that keeps mock/replay data local.
- Added a house-scoped Apple Notes bridge for iOS Shortcuts with revocable
  Shortcut grants, operator-only device labels, idempotent note-to-maintenance
  capture, dated generated snapshots, and explicit iCloud credential-sync,
  retry, and platform/security limitations.
- Added an Automations setup workspace with step-by-step Telegram and Apple
  Notes onboarding, one-time secret handling, connection warnings, tests, and
  disconnect/revocation controls.
- Added house-scoped Activity and Maintenance workspaces, a prominent Home
  quick-observation flow that does not require map placement, and explicit
  observation-to-maintenance planning links.
- Added revisioned maintenance tasks across local REST/MCP, SQLite, and the web
  application, including planned versus due dates, trust basis, priority,
  completion outcomes, independent verification, and conflict-safe editing.
- Added an explicit observation resolution lifecycle: outcome notes such as
  "Fixed leak", server-recorded resolution times, reopening, visually distinct
  resolved markers, and revisioned actor attribution in local storage.
- Protected observation floor membership and placed coordinates during layout
  edits and concurrent writes, while retaining historical sensor provenance
  without blocking later note or resolution updates.

## 0.3.0 - 2026-07-15

- Added a precise manual-observation time model with separate observed and
  immutable recorded times, exact/approximate/date/date-range/unknown
  precision, validity ranges, source provenance, and confidence.
- Added optimistic observation updates and append-only revision snapshots to
  the local SQLite REST/MCP surface, including channel actor attribution and
  legacy backfills.
- Expanded observation authoring and activity context so imprecise dates,
  ongoing conditions, provenance, confidence, and revision metadata remain
  visible instead of being flattened into one editable timestamp.
- Unified Overview and Alerts around an explainable monitoring result: open
  alerts remain blockers, while missing, stale, or aging sensor coverage can no
  longer be presented as a healthy all-clear.
- Added a persistent, visually distinct demo shell driven by the API-confirmed
  data mode, while retaining the irreversible local real-data latch and keeping
  scenario controls out of real installations.
- Added a provider-neutral weather event broker that turns scheduled pulls and
  accepted on-demand snapshots into deduplicated live SSE events after guarded
  outdoor-boundary projection.

## 0.2.0 - 2026-07-14

- Added multi-home setup, typed floor and sensor management, shared map
  placement, plan orientation, and guided location discovery.
- Added direct local TP-Link H100/H200 discovery and polling alongside guided
  Home Assistant discovery, connection testing, secure credential storage, and
  explicit real-data mode transitions.
- Added automatic location-based weather routing: Finnish locations use FMI
  observations, forecasts, and official warnings, while other locations use
  Open-Meteo current conditions and forecasts with explicit attribution and
  coverage semantics.
- Added durable, location-isolated outdoor temperature observations from fresh
  FMI results; stale responses and forecasts are not stored as observations.
- Added a shared 2D/3D sensor-constrained indoor-flow layer using paired
  temperature/RH virtual-temperature buoyancy, wall/door constraints, weak
  fresh-wind window leakage, pressure projection, passive CO2 seeding, replay
  driver history, and an honestly labelled scalar-gradient fallback.
- Added an experimental sensor-scoped first-order thermal calibration,
  fitted reconstruction, untouched holdout metrics, residual analysis, and
  constant-outdoor weather scenario.
- Added bounded five-minute calibration buckets, continuous-coverage gates,
  stale scenario-anchor protection, and privacy-aware boundary retention.
- Added a distinct Twin physics panel for observed, simulated, empirical-band,
  and signed-residual values, including honest collecting/provisional states.
- Added model provenance, calibration metrics, OpenAPI documentation, and
  deterministic physics/API/UI tests.
- Expanded the REST/OpenAPI and local MCP surfaces across home authoring,
  integrations, measurements, alerts, observations, weather, replay, and
  simulation workflows, with structured schemas and redacted integration
  responses.
- Added Home Pulse, prioritized room comfort, a moisture and ventilation coach,
  indoor/outdoor comparison, and a unified home activity timeline.
- Added responsive portfolio, outdoor-weather, sensor-management, home-insight,
  and setup experiences, plus keyboard navigation, drawer focus isolation,
  accessible state labels, and English/Finnish copy corrections.
- Added JavaScript/TypeScript and Python coverage ingestion plus a blocking
  SonarQube Cloud quality gate in CI.
- Added a canonical runtime system version, release consistency check, and
  pre-1.0 pull-request versioning policy.

## 0.1.0

- Initial local-first Stugu digital-twin vertical slice.
