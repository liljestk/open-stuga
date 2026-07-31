# Nexus 433 receiver support implementation plan

Status: product direction confirmed; implementation not started
Prepared: 2026-07-31
Reviewed: 2026-07-31
Direction confirmed: 2026-07-31
Scope: receive Nexus-compatible 433 MHz temperature/humidity senders through the local Stugu appliance

## Outcome

Stugu can read Nexus 36-bit temperature/humidity senders through a GPIO ASK/OOK receiver, assign each sender to an existing stable Stugu Sensor, and preserve that Sensor's history and alerts when the sender changes its radio ID after a battery replacement.

The first release is intentionally Nexus-only. It establishes a narrow radio-adapter boundary without promising generic 433 MHz support.

## Baseline and preconditions

- Stugu Sensor UUIDs remain the canonical identities. Provider identifiers are bindings, never Sensor IDs.
- Measurements continue through the existing normalizer, SQLite outbox, Timescale archive, SSE, and alert paths.
- A Home owns its receiver connection and sender bindings. UI copy says **Home**, even where established storage/API fields remain `houseId`.
- The current TP-Link/Tuya integration work must be landed or otherwise isolated before implementation. At Milestone 1 start, update from main, claim the next available monotonic core migration, and run the migration-order checks again immediately before merge; do not hard-code a migration number in this plan.
- The initial hardware target is Raspberry Pi 4 on the supported Trixie appliance, `/dev/gpiochip0`, GPIO 17, and the user's existing three-pin ASK/OOK receiver.

## Deliberate non-goals

- `rtl_433`, SDR hardware, additional 433 protocols, transmitting, or remote receivers.
- Automatic identity guesses based on temperature, room name, channel, or timing.
- Importing the `rpi-temp` Node/MariaDB/Grafana/renamer stack.
- Home Assistant MQTT discovery or exposing an MQTT broker on the host network.
- Reconstructing radio history while the appliance was offline.
- Multiple simultaneous receivers or moving an active receiver between Homes in the first release.

## Architecture decisions

### 1. Use the clean upstream decoder

Package an audited, commit-pinned build of the canonical, non-fork `aquaticus/nexus433` project as a separate receiver process. The `liljestk/rpi-temp` project already cloned that upstream and adds no decoder capability Stugu needs; do not reuse its wrapper image, listener, database, or renamer.

The initial upstream audit target is `eb5f8bd87cc77ce89074d9144af19a5b2b9cc175` (current upstream `master`, after release `v2.0.0`). Milestone 0 rechecks the latest upstream release, head, and maintained forks before locking the build. Prefer upstream plus a minimal reviewed compatibility patch over adopting a fork wholesale; for example, a current fork's modern-compiler change only adds missing `<cstdint>` includes. Record the exact source hash and patches, and submit generally useful fixes upstream where practical.

Do not copy the decoder into the TypeScript API and do not parse its human-readable stdout. The clean upstream publishes to MQTT, so Nexus uses the optional MQTT transport described below.

```text
optional nexus433 decoder process
  -> optional private MQTT broker
  -> reusable MqttSourceTransport
  -> Nexus433SourceAdapter
  -> ExternalObservationService
  -> existing TelemetryService
  -> SQLite outbox, Timescale, SSE, alerts
```

Runtime defaults:

- event-driven GPIO mode;
- at least two matching frames before a packet is accepted;
- substitutions disabled;
- Home Assistant discovery disabled;
- state messages not retained;
- retained gateway/sender connection messages used only for health, never telemetry or freshness;
- anonymous MQTT disabled, with generated least-privilege publish-only receiver and subscribe-only API credentials mounted from protected files;
- no host-published broker port;
- receiver, broker, and API on a dedicated internal source-ingress network.

The upstream program is GPL-3.0. Keep it in a separate image/process, record its exact source revision and patches, ship the license notices, and provide corresponding source with each distributed build. Complete a license/compliance check before release; process isolation is an engineering boundary, not a substitute for that check.

### 2. Make the capability consume zero runtime resources when disabled

Nexus433 is an optional appliance capability, disabled by default. With it disabled:

- the decoder and broker services are not created or started;
- their images are not pulled by normal startup/update reconciliation;
- the API does not import an MQTT client, open a socket, schedule a reconnect/status timer, or register a GPIO device;
- `/dev/gpiochip*` is not mounted into any core Stugu service;
- the browser does not download the Nexus setup chunk;
- no Nexus card occupies normal Connections or Sensors views.

Use a static host capability descriptor read once at API startup to distinguish `unsupported`, `available`, `enabled`, and `healthy`. Compose profiles control optional processes; capability activation is performed through a narrowly validated host/update-agent operation, never a Docker socket in the API. Unsupported installations remain on the normal Stugu baseline. A supported but disabled receiver appears only in the progressive **Add connection** catalog.

### 3. Abstract transport and gateway-fed sources

Do not make MQTT part of Nexus identity, persistence, or UI contracts. Add three narrow, reusable boundaries:

- `SourceTransport`: lifecycle and delivery interface; `MqttSourceTransport` is one lazy-loaded implementation.
- `SourceProtocolAdapter`: validates a transport message and converts it to a canonical `ExternalObservation`; `Nexus433SourceAdapter` owns Nexus topics and payload semantics.
- `ExternalObservationService`: performs Home scoping, candidate/binding lookup, availability arbitration, deduplication, and telemetry ingestion without knowing MQTT.

The canonical observation carries gateway ID, provider, external device key, receive time, typed measurements, and sanitized health metadata. It never carries a Stugu Sensor ID supplied by the transport.

Mosquitto is an independent optional `mqtt` capability, with per-source ACLs and credentials. It starts only when at least one enabled source needs the embedded broker. A future source may reuse the MQTT transport and broker, use an external broker, or provide another `SourceTransport` without changing Sensor identity or telemetry services. Avoid a universal radio decoder abstraction in this release; protocol parsing remains explicit and testable per adapter.

### 4. Keep host hardware configuration outside the Home UI

GPIO chip and line are appliance configuration, with validated environment/Compose values and safe defaults. The API must not receive arbitrary `/dev/*` paths and must not control Docker through its socket.

Use separate `nexus433` and `mqtt` capabilities/profiles so ordinary desktop/non-Linux deployments are unaffected and another source can reuse MQTT without enabling radio. When absent, the optional status object is omitted and Stugu does not run a failing reconnect loop.

One local receiver can be assigned to exactly one Home. It is not reassigned in place: retire any bindings, remove the connection, and create a new receiver UUID in the destination Home.

### 5. Separate stable Sensor identity from radio identity

The Nexus packet exposes only an 8-bit transmitter ID and a two-bit channel. The binding key is:

```text
(receiver UUID, protocol = nexus, transmitter ID, channel)
```

That key points to a stable Stugu Sensor UUID. A changed transmitter ID creates an unassigned candidate; it never creates a new Sensor or measurement stream automatically.

The MAC-like gateway segment emitted in upstream MQTT topics is transport metadata only. The configured adapter maps it to Stugu's receiver UUID; a network-interface or topic-label change must never rewrite receiver, Home, or Sensor identity.

Battery replacement flow:

1. The existing Sensor becomes stale normally when its old sender stops.
2. The user chooses **Reconnect sender** on that Sensor.
3. Stugu opens a five-minute pairing window. Only one pairing session may be active for a receiver, and the server binds it to the Home, receiver, target Sensor, initiating actor, start time, and expected revisions.
4. Stugu highlights unassigned senders observed after that session started. Channel, recency, and reception quality may rank candidates, but Stugu never selects one automatically.
5. The user confirms the candidate. One transaction retires the old binding and creates the new binding against the same Sensor UUID.
6. The next valid packet resumes the same history and alerts. Pre-confirmation packets are not backfilled.

Confirmation accepts only a one-time candidate handle issued to that session. A concurrent attempt receives a conflict and cannot steal or reuse the candidate. If the ID does not change, the existing binding continues without user action.

Two physical senders using the same ID and channel at one receiver are indistinguishable. Stugu rejects a second active binding for that key and explains the limitation. A receiver is never reassigned across Homes in place: it must be removed after retiring its bindings, then recreated with a new receiver UUID in the destination Home.

### 6. Treat radio and transport input as untrusted

The Nexus protocol has no checksum or authentication. Stugu cannot distinguish a transmission from the bound physical sender from another transmitter deliberately or accidentally using the same ID/channel. The UI and security documentation must state that Nexus readings are unauthenticated radio data and must not be the sole basis for safety- or security-critical decisions.

The adapter accepts only the configured internal topic namespace and the small JSON shape belonging to the pinned decoder revision. It rejects oversized payloads, malformed JSON, unknown fields where ambiguity matters, non-finite numbers, transmitter IDs outside 0-255, channels outside 0-3, impossible humidity, and temperatures outside the registered measurement range. Validation failures affect integration health counters, not telemetry.

Before the receiver is assigned to a Home, sensor-state packets are discarded after aggregate health accounting and create no candidates. After assignment, unknown senders are Home-scoped discovery candidates only. They cannot create readings, alerts, actions, or Sensors. Candidate APIs are owner/admin-only so nearby devices are not exposed to guests. Admit at most 16 previously unseen radio keys per receiver per minute; excess keys increment a bounded drop counter rather than churning the candidate store.

Repeated RF frames must not create duplicate measurements. Use the decoder's frame agreement, a ten-second identical-payload deduplication window, and a maximum accepted rate of one observation per binding per ten seconds. The authoritative timestamp is API receipt time because Nexus packets carry no clock.

Add a post-decode anomaly quarantine when the preceding accepted Nexus sample is at most five minutes old. Provisional triggers are a change greater than 10 °C or 25 humidity percentage points within 120 seconds. It releases one sample only when a second independent transmission arrives within 180 seconds and agrees within 1 °C and 3 humidity points; otherwise it expires and increments a health counter. Milestone 0 may change these constants only with captured fixture evidence in the runtime decision. This reduces accidental corruption; it does not authenticate the sender or solve an active ID/channel collision.

### 7. Preserve honest measurement semantics

- Add `nexus433` to the contract and OpenAPI measurement-source enums.
- Temperature and humidity use the existing metrics and `TelemetryService` ingestion path.
- A decoder-accepted packet has measurement quality `good`. RF reception percentage remains operational metadata; it is not measurement accuracy.
- The Nexus battery bit means normal/low, not a percentage. Keep numeric Reading `battery` as `null`; expose `batteryState: "ok" | "low" | "unknown"` only on Nexus binding health. Do not convert the bit to `100` or `0` percent or expand the generic timeseries contract in this release.
- Expose `receivedAt`, last valid packet time, and stale state; do not invent missed samples.
- Keep signal freshness separate from the last battery state. **No recent signal** can mean a dead battery, range, interference, or receiver failure; Stugu must not label it **Dead battery**. New stale-sender notification rules are out of scope, while existing stale-data health surfaces continue to apply.

### 8. Generalize direct-source arbitration

A Sensor may retain a Home Assistant binding while also gaining a Nexus binding. Replace the current TP-Link-specific live-ingestion check with a small direct-source availability arbiter:

- a decoder-accepted, non-quarantined Nexus packet makes the direct source primary immediately;
- Home Assistant data for the same Sensor/metric is suppressed while direct data is fresh;
- Home Assistant becomes the fallback after 240 seconds without an accepted Nexus packet (roughly three expected sender intervals), or immediately when the API knows the receiver/broker path is down;
- on recovery, direct availability is set before the Nexus reading is committed, so subsequent Home Assistant events are suppressed;
- already committed Home Assistant points are never deleted or rewritten, and one transition-edge point from each source may coexist when their timestamps differ.

Do not add Nexus history recovery in the first release. Home Assistant recorder recovery may continue through its existing path.

## Contracts and persistence

Add a small gateway-fed source substrate rather than placing transport or radio fields directly on `Sensor`:

- `SourceCapability` and `SourceGatewayStatus`
- canonical `ExternalObservation`
- `SourceDeviceCandidate` and `SourceDeviceBinding`
- generic binding/rebinding commands used behind provider-specific facades
- Nexus projections such as `Nexus433ReceiverStatus` and optional `IntegrationStatus.nexus433`
- `nexus433` measurement source and Nexus-specific signal/battery health states

Audit every source-aware consumer, including OpenAPI, exports, analytics filters, dashboards, fixtures, and exhaustive UI labels. The database accepts open source strings, so TypeScript compilation alone cannot prove this inventory complete.

Core SQLite owns three transport-neutral record types. Existing TP-Link and Home Assistant stores are not migrated; this substrate is for optional gateway-fed sources beginning with Nexus.

### `source_gateway_connections`

- stable gateway UUID, `house_id`, provider (`nexus433` initially), and transport kind (`mqtt` initially);
- display label, enabled flag, and validated provider schema revision;
- service/gateway last-seen timestamps and optimistic revision;
- at most one enabled local Nexus gateway per installation in the first release.

### `source_device_bindings`

- gateway UUID, Sensor UUID, provider, and adapter-canonical external device key;
- `active_from`, `retired_at`, retirement reason, and revision;
- latest accepted packet time and bounded, schema-validated provider health metadata; signal state is derived from gateway health and time rather than stored as a stale flag;
- unique active `(gateway, provider, external_device_key)`;
- unique active `(gateway, sensor_id)` for the first release;
- retired rows retained so rebindings are explainable and restorable.

For Nexus, the adapter alone converts ID/channel to the canonical external key and projects last reported battery state and frame quality. MQTT topic strings are never binding keys.

### `source_device_candidates`

- opaque candidate UUID plus gateway, provider, and canonical external key;
- first/last seen, observation count, and bounded schema-validated discovery metadata;
- no raw RF/MQTT payload or decoded environmental-value storage;
- expire unassigned candidates after six hours and cap them at 128 per gateway.

Binding transactions must verify Home ownership, Sensor enablement, local authority, candidate freshness, expected revisions, both uniqueness constraints, and that the Sensor has no other active direct climate-provider binding. A Home Assistant binding is allowed as fallback; an existing TP-Link direct binding must be removed explicitly before attaching Nexus. Disabling/removing a gateway retires bindings and candidates but never deletes Sensors or historical measurements. Home deletion uses the established cascade/cleanup path.

Rebinding sessions can be short-lived API state rather than a fourth durable table. They have opaque IDs, a five-minute expiry, one active session per gateway, initiating-actor and target-Sensor scope, a server-side set of candidate handles observed after session start, Home authorization on every operation, and no effect until confirmation. API restart safely expires the session. Confirmation atomically consumes the handle; unique constraints and expected revisions make concurrent confirmation deterministic.

Nearby senders may still leave short-lived ID/channel metadata in the Home database because reception of unauthenticated broadcast RF is inherent to discovery. Record that privacy tradeoff in the privacy documentation; minimize it with owner/admin visibility, no environmental-value persistence, the six-hour TTL, and the hard cap.

## API and live events

Add reusable `source-gateways`, `source-transports`, and `external-observations` API domains, plus a small `nexus433` protocol/UI facade. Load the MQTT transport and Nexus adapter only when the host capability is enabled. Keep routing composition thin and keep source files below the repository review thresholds.

Proposed owner/admin routes:

- `GET /api/v1/integrations/nexus433/status?houseId=...`
- `PUT /api/v1/integrations/nexus433/config`
- `DELETE /api/v1/integrations/nexus433/config/:receiverId`
- `GET /api/v1/integrations/nexus433/candidates?receiverId=...`
- `POST /api/v1/integrations/nexus433/bindings`
- `POST /api/v1/integrations/nexus433/rebinding-sessions`
- `POST /api/v1/integrations/nexus433/rebinding-sessions/:sessionId/confirm`
- `DELETE /api/v1/integrations/nexus433/rebinding-sessions/:sessionId`

Use opaque candidate/session IDs in commands rather than accepting a client-assembled radio key. Apply the same Home authorization and optimistic-concurrency patterns as other connection mutations.

Publish integration-status events only for meaningful changes: service connectivity, first candidate seen, assignment/rebinding, stale/fresh transitions, battery-low transitions, and error changes. Do not publish an integration event for every mapped reading; mapped values already use the existing reading/measurement events.

Status must distinguish:

- service unavailable vs disconnected vs listening;
- receiver assigned vs unassigned;
- last gateway heartbeat and last valid packet;
- mapped and unassigned sender counts;
- bounded validation/drop counters and sanitized error text;
- per-binding last seen, battery state, and reception quality.

When at least one MQTT-backed source is enabled, the reusable transport reconnects with capped exponential backoff and jitter. With none enabled it is not imported or instantiated. Nexus derives its 240-second direct-source freshness from accepted state packets, not the decoder's retained online/offline topics. A reconnect does not replay retained state as a new measurement.

## User experience

### Set up → Connections

Visually integrate Nexus with the existing connection cards and setup-gap language; runtime separation must not produce a plugin-looking secondary UI. A focused, lazy-loaded `Nexus433SetupPanel` shows whether the local **433 MHz receiver** is enabled, listening, and assigned to the current Home. Hardware installation details stay under an advanced/help disclosure.

Unsupported installations show nothing in normal navigation. Supported-but-disabled installations list **433 MHz receiver** only under **Add connection**. Once enabled, it behaves like other Home connections in Set up and like other Sensor sources in Sensors. Do not expose MQTT, Compose profiles, decoder names, or GPIO terminology in the primary flow.

### Sensors

Put sender discovery and identity repair where Sensors are managed:

- a setup-gap card when unassigned senders have been heard;
- attach a candidate to an existing Sensor or create a Sensor and then place it;
- **Reconnect sender** on an existing Sensor for battery-ID changes;
- an explicit confirmation step showing Home, Sensor, channel, ephemeral live values, and last seen time; those unbound values are not persisted;
- raw transmitter ID and frame quality only under **Advanced**.

Use user-facing states such as **Listening**, **Sender needs assignment**, **No recent signal**, and **Low battery**. Add English, Swedish, and Finnish copy, keyboard/focus coverage, non-colour status cues, and screen-reader labels.

## Appliance and release work

This feature adds more than application code. The current appliance release environment, update request validator, and start scripts enforce exactly five Stugu image references. Adding a receiver and broker changes that tested architectural invariant. Do not smuggle the GPL binary into the API image to avoid changing the contract.

The current appliance's Compose file and startup validators are immutable OS assets. An ordinary application-container update cannot add the receiver/broker services, and the current updater rejects a changed image set before a candidate update agent can run. A bridge application release may report **Factory upgrade required**, but it cannot install these services by itself.

Milestone 0 must therefore produce and merge `docs/nexus433-runtime-decision.md` before Milestone 1 starts. The preferred route is a new validated factory/OS Compose contract with a verified backup-and-restore or live-migration transition for existing appliances. If that operator transition is unacceptable, stop and revisit the sidecar decision; do not create an untracked dynamic Compose override or hide the receiver inside the API image.

The decision fixes the new image count, ownership, digest strategy, release-environment/update-agent/Compose contract versions, old-appliance behavior, OS-slot rollback behavior, and objective hardware thresholds. It must choose and test the clean release shape:

- a separately built, multi-architecture `open-stuga-nexus433` image pinned by digest;
- an independently reusable Mosquitto capability/image pinned by digest and isolated in Compose;
- generic host capability activation and static capability reporting rather than Nexus-specific Docker control;
- explicit release-manifest, release-environment, publisher, updater, factory-layer, `stugu-compose-start`, rollback, and integrity-check support for every newly required image;
- a new compatibility contract and a fail-closed **Factory upgrade required** path on older immutable Compose assets.

Existing external images such as Timescale provide a precedent, but the receiver is feature-critical and must be available after factory install, offline restart, application update, OS-slot rollback, and restore. The spike must document whether Mosquitto is treated as a release-managed image or immutable appliance dependency; it must never float by tag.

On installations where the capability is disabled, Compose reconciliation must ignore the optional services and not pull their images. The release manifest may describe them for capable installations, but disabled hardware pays only static manifest/Compose disk bytes—not running processes, image layers, sockets, timers, or browser bundles.

GPL/compliance approval is a separate hard release gate. Internal prototyping may continue, but no appliance or container release containing the receiver may be distributed until the approval, license notices, patch/source archive, and corresponding-source publication path are recorded. Process isolation is not treated as a legal conclusion.

Also update:

- Compose profile, private network, health checks, read-only filesystems, dropped capabilities, and only the GPIO device access actually required;
- Pi image assets and `stuguctl` diagnostics/status output;
- backup/restore validation for the new SQLite records;
- operator wiring, GPIO reservation, troubleshooting, privacy, security, and GPL source-offer documentation.

## Delivery milestones

### 0. Hardware, licensing, and release-contract spike

- Recheck canonical `aquaticus/nexus433` releases/head and relevant maintained forks; record why the selected upstream revision and any minimal patches win.
- Build that pinned clean upstream revision for ARM64/Trixie and AMD64 CI.
- Confirm libgpiod compatibility, event-mode CPU, GPIO 17 ownership, container device permissions, clean shutdown, MQTT topic/payload behavior, and no retained state ingestion. Event mode is the supported release mode; polling is not exposed unless a later measured decision changes the resource contract.
- Identify the receiver module and verify its supply/data voltage. Never feed more than 3.3 V into the Pi GPIO; document the required level shifting if the module needs a 5 V supply or output.
- Verify the existing receiver with at least one real Nexus sender.
- Fix the anomaly thresholds from real packet fixtures and verify the unauthenticated-RF warning with product/security review.
- Prove the selected new-factory transition, including old-appliance **Factory upgrade required**, backup/restore or live migration, new-contract application update/rollback, and old-OS-slot fallback.
- Merge the runtime decision containing that compatibility shape, objective resource/reliability thresholds, and corresponding-source publication mechanism.

Provisional spike pass thresholds are: receiver average CPU below 5% of one Pi 4 core in event mode over one hour; receiver plus broker RSS below 128 MiB; at least 95% of expected transmissions decoded in a fixed one-hour bench setup; no false candidate during a controlled one-hour no-Nexus-transmitter noise run; local MQTT-to-durable-commit p95 below one second; and recovery on the next valid transmission after each process restart. A changed threshold requires captured evidence in the runtime decision.

Exit: a reproducible receiver image, captured real packet fixtures, the merged runtime decision, documented compliance path, and passing factory/transition/update/rollback proof of concept. Milestone 1 is blocked until this exit is reviewed. Stop here if these cannot be made supportable.

### 1. Contracts, schema, and identity service

- Add the capability, transport-neutral observation, gateway/candidate/binding, OpenAPI, and Nexus projection contracts.
- Add generic gateway-fed source migrations, stores, constraints, expiry, gateway assignment, binding, and rebinding transactions.
- Introduce the direct-source availability arbiter.
- Audit all source-string consumers and test Home boundaries, concurrent sessions/confirmation, collisions, cleanup, receiver transfer rejection, and stable Sensor identity.

Exit: simulated canonical observations can be bound/rebound without MQTT or Nexus code and cannot cross Homes or split Sensor history.

### 2. Adapter and ingestion

- Add the lazy `MqttSourceTransport`, private broker capability, and `Nexus433SourceAdapter` independently.
- Validate, rate-limit, quarantine anomalies, deduplicate, normalize, ingest, report health, and reconnect safely.
- Use the upstream fake-transmitter build for deterministic end-to-end CI.

Exit: with all optional capabilities disabled there are no extra processes, images pulled, MQTT imports/sockets/timers, GPIO mounts, or browser chunks. With them enabled, an unknown packet creates only a candidate; a mapped packet commits its Reading plus paired temperature/humidity v2 samples and alert-queue rows in the existing single SQLite transaction, then emits SSE after commit exactly once.

### 3. Setup and Sensor workflows

- Add the receiver connection panel, unassigned-sender workspace, create/attach flow, and reconnect flow.
- Add translations, accessibility tests, live invalidation, and responsive states.

Exit: a user can complete initial setup and a changed-ID battery replacement without editing identifiers or configuration files.

### 4. Appliance integration and documentation

- Complete release/update/factory/rollback integration for pinned images.
- Add backup/restore, diagnostics, security hardening, license artifacts, and operator docs.

Exit: compliance approval is recorded, and factory install, offline reboot, update, failed-update rollback, and restore all preserve receiver configuration and sender bindings.

### 5. Hardware release gate

- Run a 24-hour Pi 4 soak with a stable-ID sender and a sender known to change IDs.
- Exercise reboot, network loss, broker/API restarts, battery-low, ID change, duplicate bursts, invalid packets, and an ID/channel collision fixture.
- Record CPU/memory use, packet loss, stale/fallback timing, and recovery behavior.

Exit: measurements remain correctly attributed, resource use is acceptable, failures are visible, and no test produces silent identity reassignment.

## Test and acceptance checklist

- The default/non-Linux Compose path works with all source capabilities disabled.
- Disabled capability proof shows no decoder/broker containers, optional image pulls, MQTT module import/socket/timer, GPIO mount, steady-state CPU increase, measurable API RSS regression beyond baseline noise, or Nexus web-chunk request.
- Enabling an unrelated future MQTT-backed test adapter can reuse the MQTT transport/broker without enabling Nexus or GPIO access.
- The enabled Nexus profile exposes no MQTT host port and grants no unnecessary device/capability access.
- A fake non-MQTT `SourceTransport` drives the same canonical candidate/binding/ingestion service in contract tests.
- Parser property/fuzz tests cover malformed topics, sizes, JSON, values, and non-finite numbers.
- An unassigned receiver persists no sender candidates; candidate-flood admission limits preserve the bounded store and health visibility.
- An unbound sender key produces zero telemetry, alerts, actions, or Sensors; documentation does not claim that an active-key collision or deliberate RF spoof can be detected.
- Rate and anomaly tests prove that duplicate bursts, excessive frame rates, and one-off implausible jumps cannot silently create mapped telemetry.
- One accepted mapped RF observation atomically commits its Reading, paired temperature/humidity samples, outbox/alert work, and then publishes once under source `nexus433`; injected failures leave no partial pair.
- Numeric battery percentage remains `null`; low/normal state is preserved honestly.
- Fresh/low-battery, stale/last-known-low, and receiver-unavailable states remain distinct; no state claims to diagnose a dead battery.
- Battery-ID rebinding retains the same Sensor UUID, history, placement, tags, and alerts.
- Rebinding is explicit, revision-checked, Home/actor/session-scoped, and leaves an inspectable retired binding.
- A second pairing session on the receiver is rejected, a handle from another/expired session cannot be confirmed, and two confirmations have one deterministic winner.
- Same receiver/ID/channel collisions are rejected and explained.
- A Sensor with an active TP-Link direct climate binding cannot also receive a Nexus binding; its Home Assistant entities may remain as fallback.
- With a fake clock, Nexus suppresses Home Assistant until 240 seconds of unexplained silence, a known receiver/broker failure enables fallback immediately, and a recovered Nexus packet reclaims future ingest before its commit without rewriting prior HA points.
- Receiver/API/broker restarts recover on the next packet without replaying stale retained data.
- Candidate value minimization, six-hour TTL, 128-record cap, deletion, Home cleanup, backup, and restore are covered.
- Receiver transfer across Homes is rejected; remove-and-recreate produces a new UUID and no inherited bindings.
- Every source-aware export, query, dashboard, OpenAPI enum, fixture, and UI label handles `nexus433` intentionally.
- Older immutable Compose contracts fail closed with **Factory upgrade required**; the documented backup/restore or migration path preserves application data.
- New images are digest-pinned and survive new-factory install, application update/rollback, offline restart, and compatible OS-slot rollback.
- English, Swedish, and Finnish workflows meet the existing accessibility bar.
- Enabled Nexus workflows use the existing Connections and Sensors visual patterns; unsupported installations show no dead navigation or status card.
- Distributed builds include required GPL notices and corresponding source.

## Claude review disposition

Claude Sonnet's 2026-07-31 review was checked against the repository before editing this plan. It resulted in session-scoped concurrency rules, a hard runtime-contract decision gate, explicit compliance approval, separate battery/signal semantics, reduced candidate retention, receiver-transfer rules, source-consumer auditing, a concrete 240-second failover boundary, atomic paired-ingestion tests, and objective spike thresholds.

One recommendation was narrowed: plausibility/rate controls can reduce accidental corruptions, but a checksum-less radio protocol cannot prove that a packet using an active ID/channel came from the intended physical sender. The plan therefore tests those controls while explicitly refusing to promise spoof detection.

The subsequent product review made resource isolation and reuse mandatory. This revision uses clean canonical `aquaticus/nexus433`, splits capability/transport/protocol/observation concerns, requires zero active resources and no optional image pull when disabled, and keeps the enabled experience inside Stugu's normal Connections and Sensors UI.

## Files and ownership expected to change

- `packages/contracts/src/`: capability, external-observation, gateway/candidate/binding/status, and Nexus projection contracts.
- `apps/api/src/source-transports/`: lazy transport lifecycle and MQTT implementation.
- `apps/api/src/external-observations/`: transport-neutral gateway, candidate, binding, and ingestion service.
- `apps/api/src/nexus433/`: small protocol parser, health semantics, and route/UI facade.
- `apps/api/src/db/migrations/`: next available migration only.
- `apps/api/src/services/`: direct-source arbiter and narrow ingestion wiring.
- `apps/api/src/openapi/`: routes and schemas.
- `apps/web/src/pages/IntegrationsPage/`: focused, lazy-loaded connection panel and Add connection entry.
- `apps/web/src/pages/SensorsPage/` and related data modules: discovery and reconnect workflows.
- locale bundles, Compose, appliance/release/update scripts and tests, and relevant docs.

The exact file split is decided during implementation against the then-current tree. Do not add numbered continuation files or let the existing integration render module absorb the new workflow.
