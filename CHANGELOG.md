# Changelog

All notable Stugu releases are recorded here.

## Unreleased

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
