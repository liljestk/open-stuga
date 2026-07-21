# Tapo Android export runner

This worker drives the Tapo Android app through Appium when local device history cannot cover a requested gap. It claims durable jobs from the Stuga API, submits one export at a time, and reports a terminal state back to the API. The emailed CSV is ingested by a separate mailbox component; this worker does not mark data as imported merely because the app accepted an export request.

The runner is intentionally disabled by default. After loading the configuration
needed to select disabled mode, it logs and exits without reading/executing the
flow or contacting the API or Appium. It does not validate the enabled-mode
pins. Tapo UI resource IDs vary by app release, language, account state, and
device family. `flow.example.json` contains placeholders, not working production
selectors. A tested flow captured from the exact deployed APK is required before
`TAPO_RUNNER_ENABLED=true` is safe.

## Safety and reliability properties

- One worker processes one job at a time. App screens are never driven concurrently.
- Enabled mode requires both a stable Appium `appium:udid` and an operator-assigned `TAPO_TARGET_LOCK_ID`. The lease identity is derived from those two physical-target identifiers, so changing an Appium hostname cannot split the phone lock.
- Enabled mode hashes the exact compiled runner JavaScript, Node runtime version, cached flow bytes, target/UDID, normalized export mailbox, exact Tapo APK, Appium, and UiAutomator2 versions, Android platform version, locale/language, and the complete sorted capability object. It also binds the Tapo account using HMAC-SHA256 keyed by the worker token; neither account email nor proof is placed in the fingerprint payload. The fingerprint accompanies the claim in both a query parameter and header; ordinary jobs remain blocked until the API has a recent successful canary for that exact deployment. The runtime build digest changes automatically with implementation/image builds; the hardcoded fingerprint schema is a format-version fallback, not the primary release pin.
- Approval is not just a runner fingerprint. The API also fences its exact
  implementation build, acceptance/parser revision, Gmail identity/credential
  proof, observed CSV schema, and target sensor/device/alias/timezone/interval.
  Approval expires after 30 days. A queued job starts automatic renewal seven
  days before expiry; schema drift or a relevant deployment/API change relocks
  ordinary work until another live canary succeeds.
- Every claim is preceded by Appium `/status` and active `/sessions` ownership preflights. An unavailable/unsafe endpoint or unknown target session therefore consumes zero queue attempts. An Appium infrastructure failure after a claim opens a runner-wide circuit before a second claim. Infrastructure circuits exit nonzero so Compose `restart: on-failure` can recover after the target is repaired; every replacement process preflights again.
- The API owns the durable queue and job lease. The runner arms a local watchdog from the claim and every heartbeat response, aborts Appium at that exact expiry, and also stops after a lease conflict or three consecutive heartbeat failures.
- Every job starts by deleting the prior WebDriver session and creating a fresh one with the job's exact IANA timezone. A timed-out or failed deletion stops the worker; it never creates a possibly concurrent replacement. Android `noReset` preserves app data and login, not the WebDriver session.
- Session records are file-fsynced and atomically renamed without an unlink gap. Before creating an unrecorded session, the runner queries Appium `/sessions`; it deletes only crash-orphans that echo the exact configured UDID and all platform/driver/locale pins. A same-target mismatch or unidentified session is refused, never guessed.
- Login, 2FA, and an unrecognized UI are different states. Any login-flow failure opens a worker-wide authentication circuit before another job can be claimed. The worker never attempts to bypass 2FA and never treats an unknown screen as success.
- Shared export-flow `ui_drift` and `configuration_error` failures also open a worker-wide circuit so a broken selector cannot park the queue. A verified `device_not_found` remains job-local unless its underlying WebDriver failure is infrastructure-related.
- Every claim rotates to a new 128-bit plus-address capability derived from a separate API-only random nonce. It cannot be calculated from the public job ID. A late message from a cancelled or retried generation cannot complete the current generation.
- The API permits one live claimed/running or `waiting-email` Appium generation
  by default, so this worker cannot submit another export while the prior email
  remains unresolved. Operators may raise the configured cap only within the
  API's bounded 1-10 range.
- Enabled mode attests to a dedicated Tapo account. The exact alias must occur once, and the device page must display the configured immutable `deviceProofs[deviceId]` value before export navigation continues.
- A successful automation result is `waiting-email`, not `completed` or `imported`. Mail arrival, CSV validation, staging, and final ingestion remain separate durable steps.
- After mailbox completion, the authenticated operator job records
  `sourceArtifactSha256`, `sourceArtifactBytes`, `parserVersion`, and
  `sourceSchemaSignature` for the exact attachment. The recipient capability
  and Gmail message ID remain redacted.
- The separate mailbox/API stage limits an attachment to 8 MiB and 23,000 raw
  data rows, then permits at most 20,000 accepted rows (about 40,000 climate
  samples). It fails closed on ambiguous schema, missing/conflicting units,
  timezone/range/cadence gaps, or drift from the canary's schema signature.
- UI failures can save a local screenshot. Screenshots are mode `0600`, may contain household/device information, and are automatically pruned after `TAPO_RUNNER_ARTIFACT_RETENTION_DAYS` (30 by default).
- The runner redacts known secrets and marks every Appium value command sensitive. Appium itself must still be started with the supplied log filters; its remaining device/UI logs need protected, short retention.
- Job-API and Appium JSON bodies are read through streaming byte limits. Screenshots have a separate 16 MiB JSON/base64 limit; ordinary Appium JSON is limited to 1 MiB and internal API JSON to 256 KiB.

## Runtime topology

The normal deployment has four independently restartable pieces:

1. Stuga API and its durable export-job store.
2. This Node worker.
3. Appium 2.18.0 or newer with UiAutomator2 3.1.0 or newer.
4. A dedicated Android emulator or device with the Tapo app installed.

Use one runner identity per Android target. Sharing one Appium target between multiple runner processes can corrupt navigation even when the API jobs themselves are correctly leased.

## Internal API contract

The default prefix is `/api/v1/internal/tapo-history`. All requests include:

```http
Authorization: Bearer <TAPO_HISTORY_WORKER_TOKEN>
X-Stuga-Worker-Id: tapo-target-<derived-target-hash>
X-Tapo-Deployment-Fingerprint: <64-lowercase-hex-fingerprint>
Content-Type: application/json
```

### Claim

```http
GET /api/v1/internal/tapo-history/jobs/claim?workerId=tapo-target-<derived-target-hash>&deploymentFingerprint=<64-lowercase-hex-fingerprint>
```

No work is HTTP `204`. A claim keeps the lease capability outside the job:

```json
{
  "job": {
    "id": "job-id",
    "sensorId": "stuga-sensor-id",
    "deviceId": "stable-tapo-device-id",
    "deviceName": "Living room",
    "metric": "temperature",
    "from": "2026-06-01T00:00:00.000Z",
    "to": "2026-06-08T00:00:00.000Z",
    "timeZone": "Europe/Helsinki",
    "intervalMinutes": 15,
    "expectedRecipient": "history+stuga-opaque-capability@example.com",
    "status": "claimed",
    "attemptCount": 1,
    "leaseExpiresAt": "2026-07-19T20:10:00.000Z"
  },
  "leaseToken": "unguessable-per-claim-token",
  "serverNow": "2026-07-19T20:05:00.000Z"
}
```

The query and `X-Tapo-Deployment-Fingerprint` header must match. The API first
offers canary work; it withholds ordinary work unless that exact fingerprint,
API acceptance revision, target scope, and approved CSV schema have a successful
approval no older than 30 days. The API claims atomically, does not return the same live lease twice, and compares
both the stable physical-target worker ID and `leaseToken` on subsequent calls.
`serverNow` lets the runner compute the remaining TTL without trusting its own
wall clock.

### Heartbeat

```http
POST /api/v1/internal/tapo-history/jobs/{jobId}/heartbeat

{
  "workerId": "tapo-target-<derived-target-hash>",
  "leaseToken": "..."
}
```

The API extends the lease on success and returns `{ "job": { "leaseExpiresAt":
"..." }, "serverNow": "..." }`. The runner requires both timestamps and rearms
its local watchdog.
HTTP `409` means the lease is lost; the worker stops touching that job.

### Status

```http
POST /api/v1/internal/tapo-history/jobs/{jobId}/status

{
  "workerId": "tapo-target-<derived-target-hash>",
  "leaseToken": "...",
  "status": "waiting-email",
  "detail": "Tapo accepted the historical export request"
}
```

States emitted by this runner are:

- `running`: Appium automation has started and the lease remains active.
- `waiting-email`: the configured confirmation selector appeared after submitting the app form. The mailbox stage is now responsible for completion.
- `needs-attention`: login, 2FA, UI drift, a missing device, or bad operator configuration needs intervention. This is terminal until an operator explicitly retries it.
- `failed`: infrastructure/automation failed. The API's durable retry policy decides whether and when another attempt is allowed.

The API should treat duplicate status calls with the same lease token idempotently. A lease mismatch is HTTP `409`.

## Setup

1. Prepare a dedicated Android target, install a pinned Tapo APK, record its exact version in `TAPO_APP_VERSION`, and sign in manually once.
2. Run Appium 2.18.0 or newer and install UiAutomator2 3.1.0 or newer.
3. Open the target with Appium Inspector. Capture stable resource IDs/accessibility IDs for all signals and actions.
4. Copy `flow.example.json` outside the source tree, replace every `CHANGE_ME`, and exercise an export into a test mailbox.
5. Copy `.env.example` into your deployment secret/configuration system. Its worker token is intentionally blank: generate one or use the file form; the runner explicitly rejects the old published placeholder. Keep `TAPO_RUNNER_ENABLED=false` while preparing configuration; disabled mode is inert and therefore does not certify the pins.
6. Verify the internal claim/status endpoints and plus-address mailbox delivery.
7. Enable a single runner and enqueue a live canary spanning at least eight
   configured intervals and at most `max(7 days, 8 intervals)`. It must prove
   both climate columns against at least eight overlapping trusted-good direct
   samples at zero lag. Ordinary claims remain gated until the exact
   deployment/API/schema/target scope passes.

Typical Appium bootstrap commands are:

```sh
npm install --global appium
appium driver install uiautomator2
appium --address <docker-bridge-or-vpn-interface-ip> --port 4723 \
  --log-filters <absolute-repository-path>/apps/tapo-export-runner/appium-log-filters.json \
  --log-level info
```

Confirm `appium --version` is at least `2.18.0`, record that exact value in
`TAPO_APPIUM_VERSION`, and keep it pinned. The runner requires `/status` to
report the exact configured version before every claim. The runner sends
`X-Appium-Is-Sensitive: true` on every typed value, while the required filter
file independently removes value-endpoint payloads and `setValue` log lines.
Run Appium under a dedicated OS account and configure the service manager's
stdout/stderr files for owner-only access, bounded rotation, and prompt expiry.
Only after those controls are active set `TAPO_APPIUM_LOGS_HARDENED=true`; an
enabled runner fails closed without it.

Run `appium driver list --installed --json`, verify that `uiautomator2` is at
least 3.1.0, and record its exact installed version in
`TAPO_UIAUTOMATOR2_VERSION`. This attests support for the dynamic
`appium:timeZone` capability; changing the driver requires another canary.

Pin `platformName: Android`, `appium:automationName: UiAutomator2`, exact
`appium:platformVersion`, `appium:language`, `appium:locale`, and
`appium:udid` in `TAPO_APPIUM_CAPABILITIES_JSON`. Appium must echo every pin
exactly when a session is created or reused. A mismatch deletes the session,
fails the job closed, and opens the global infrastructure circuit.

Appium is remote control of a logged-in device and commonly has no application
authentication. Bind it only to the Docker bridge/VPN interface used by the
runner, enforce a host firewall for that source, and never expose it on the LAN
or internet. Do not enable relaxed-security features for this worker.

Pin Appium, the driver, Android image, Tapo APK, locale, font scale, resolution, and orientation in a real deployment. An unpinned app update is effectively an unreviewed automation-code change.

## Flow file

The flow is a small declarative WebDriver program. Supported selector strategies are `accessibility id`, `id`, `xpath`, `class name`, and `-android uiautomator`.

The `signals` section identifies mutually relevant account states:

- `authenticated` is required.
- `login` is optional but required for automatic login recognition.
- `twoFactor` is optional but strongly recommended. It has priority if multiple signals appear.

`restartAppBeforeJob` defaults to true: the runner terminates and reactivates only the Tapo app before each job, preserving app data/login through `noReset` while avoiding navigation state leaking from the previous export. The optional `prepare` flow handles a known harmless popup or splash delay. The optional `login` flow may reference credentials. The required `export` flow must end by waiting for a positive app confirmation; otherwise the runner would report `waiting-email` too early.

`intervalLabels` maps every API interval to the exact text shown by the pinned
app locale. The flow is rejected unless non-optional actions, in safe order,
tap and then verify the exact `DEVICE_NAME`, type `FROM_DATE` and `TO_DATE`, tap
or explicitly tap their year/month/day parts, verify both dates, tap and verify
`INTERVAL_LABEL`, type the correlated recipient, tap Submit, and end
on a non-optional confirmation wait. Immediately before the sole Submit tap,
the flow must `waitForGone` on that same final confirmation selector; this
proves a stale toast/success view cannot satisfy the post-submit wait.

Supported actions are:

- `tap`, `type`, `clear`, `waitFor`, `waitForGone`
- `back`, `pause`
- `tapCoordinates`, `swipe` for controls that expose no stable selector
- `repeatTap` for bounded calendar-month navigation

`repeatTap` requires a pinned selector and `countVariable` equal to exactly one
of `FROM_MONTHS_BEFORE_CURRENT`, `TO_MONTHS_BEFORE_CURRENT`, or
`MONTHS_FROM_FROM_TO`. Counts are derived from API `serverNow` and the job dates
in the house IANA timezone, never from email/UI text or arbitrary templates.
The engine accepts the inclusive 0-through-24-month range. It rejects
negative/future or greater-than-24-month values, resolves a
unique element again before every click, and allows only a bounded 50-2000 ms
`settleMs`. For a picker opening at the current month, use the corresponding
`*_MONTHS_BEFORE_CURRENT` with its previous-month selector. If the To picker
opens at the selected From month, use `MONTHS_FROM_FROM_TO` with its next-month
selector. The checked-in example remains deliberately uncalibrated and keeps
`CHANGE_ME` selectors for both controls.

Selector actions accept `timeoutMs`, `optional`, and `failureCode`. Use `failureCode: "device_not_found"` on the device-selection action. Coordinate actions are supported as a last resort and should be guarded by surrounding `waitFor` actions because they are sensitive to resolution and layout changes.

Available template variables are:

```text
JOB_ID
DEVICE_ID
DEVICE_NAME
DEVICE_PROOF
FROM_ISO
TO_ISO
FROM_DATE
TO_DATE
FROM_YEAR
FROM_MONTH
FROM_DAY
TO_YEAR
TO_MONTH
TO_DAY
FROM_MONTHS_BEFORE_CURRENT
TO_MONTHS_BEFORE_CURRENT
MONTHS_FROM_FROM_TO
TIME_ZONE
INTERVAL_MINUTES
INTERVAL_LABEL
EXPORT_EMAIL
TAPO_USERNAME
TAPO_PASSWORD
```

`FROM_ISO` and `TO_ISO` are UTC instants. `FROM_DATE` and `TO_DATE` are calendar dates in the house time zone returned by the API. If the app date picker cannot accept text, encode a tested navigation sequence in the flow or extend the DSL with a separately reviewed date-picker action. Do not silently substitute the device locale's "today"; that could import plausible but incorrect history.

## Configuration

See `.env.example` for every setting. The required enabled-mode settings are:

- `TAPO_HISTORY_WORKER_TOKEN` or `TAPO_HISTORY_WORKER_TOKEN_FILE` (Compose generates and mounts the latter)
- `TAPO_RUNNER_FLOW_CONFIG`
- `TAPO_EXPORT_EMAIL`
- `TAPO_APPIUM_LOGS_HARDENED=true`, after the filtered Appium service above is active
- `TAPO_APP_VERSION`, `TAPO_APPIUM_VERSION`, and `TAPO_UIAUTOMATOR2_VERSION` with exact installed versions
- `TAPO_TARGET_LOCK_ID`, plus exact Android platform/version/language/locale/UDID capabilities
- `TAPO_DEDICATED_ACCOUNT=true`, attesting an automation-only account with globally unique aliases
- either `TAPO_ACCOUNT_EMAIL` + `TAPO_ACCOUNT_PASSWORD`, or a stable high-entropy `TAPO_ACCOUNT_PROOF` for retained-session mode

`TAPO_ACCOUNT_EMAIL` and `TAPO_ACCOUNT_PASSWORD` must be supplied together for automatic login. Their normalized email identity is HMAC-bound into the deployment fingerprint; password rotation does not invalidate a canary. When relying on a retained signed-in Android session, omit both credentials and configure `TAPO_ACCOUNT_PROOF` or `TAPO_ACCOUNT_PROOF_FILE` instead. Generate a different stable random secret of at least 32 bytes for every Tapo account. Its HMAC is fingerprinted, while the proof, worker token, and plaintext email are never put in the fingerprint or logs. A changed account/proof requires a new canary. If the retained app reaches its login screen, the job becomes `needs-attention` with a `login_required` detail.

This HMAC is an operator/deployment attestation; the Tapo app does not expose a
safe non-PII account token that the runner can compare at runtime. Runtime data
identity therefore remains anchored by the unique exact device alias and the
immutable on-screen `deviceProofs[deviceId]` check. If an account is switched
manually, automation can continue only when that same proven target is visible
in the new account; otherwise the job fails `device_not_found`. Do not weaken
device proofs to list position or a reusable friendly label.

The mailbox must support plus addressing and preserve the recipient address in message metadata. Test this explicitly; not every mail provider supports it. Existing plus tags on `TAPO_EXPORT_EMAIL` are replaced so each generated correlation address has one random, job-specific tag. The API separately verifies Gmail `/users/me/profile`; configure its `TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL` when a Workspace alias or catch-all differs from the primary OAuth identity.

`STUGA_API_URL` and `TAPO_APPIUM_URL` must use HTTPS for remote hosts. Plain
HTTP is accepted only for explicit loopback and the local Compose names
`api`, `appium`, and `host.docker.internal`; protect those local networks with
the host/container firewall.

At startup, the runner reads the flow file once. It hashes and parses that same
cached source, so a file replacement cannot make it execute selectors that do
not match the fingerprint sent to the API. Any flow/APK/driver/Android/locale
capability/export-mailbox change creates a new fingerprint and requires a new canary.

The session-record file stores an Appium session ID, endpoint, and capabilities fingerprint, not Tapo credentials. It is durably published with an atomic rename. A changed target/capabilities fingerprint invalidates the record, and a reused session must echo all configured target pins. Appium must support `GET /sessions` for crash-orphan reconciliation. Keeping the session on shutdown is the default. Set `TAPO_KEEP_SESSION_ON_SHUTDOWN=false` to send WebDriver `DELETE /session` during a graceful stop.

## Build and test

From the repository root:

```sh
npm run typecheck --workspace @climate-twin/tapo-export-runner
npm test --workspace @climate-twin/tapo-export-runner
```

Unit tests cover safe defaults and validation, plus-address correlation, UI signal precedence, and authentication-state decisions. A production rollout also needs an Appium canary test against the pinned Android/Tapo build; unit tests cannot establish that third-party UI selectors are current.

## Operational recovery

- `login_required`: sign in manually or configure and test the login flow, then explicitly retry the job.
- `two_factor_required`: complete the challenge manually on the dedicated target, verify the home signal, then retry.
- `ui_drift`: inspect the saved screenshot and Appium hierarchy, update/review selectors, run a canary, then retry.
- `device_not_found`: verify the API-to-Tapo device-name mapping. Do not guess by position in a device list.
- `appium_unavailable`: restore Appium/device connectivity, verify the pinned target, then restart the runner. Its global circuit prevents another claim in the failed process.
- Lost heartbeat/lease: the worker's local deadline aborts in-flight Appium work even if a request stalls. The API may reclaim only after its durable lease expiry.

Do not automatically acknowledge CAPTCHA, consent, account-security, destructive, purchase, or firmware prompts through a generic dismiss action. Those belong in `needs-attention` handling.
