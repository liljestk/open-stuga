# Automated Tapo history recovery

Stuga can repair a missing TP-Link measurement interval without pretending that
one source can provide every kind of history. It keeps a durable gap ledger,
tries the closest authoritative source first, and only then creates an
asynchronous Tapo app export job. Every sample released to the gap coordinator
is validated and inserted idempotently; historical recovery does not emit live
events or replay old alerts.

The Android and mailbox path is disabled by default. It controls a third-party
mobile interface whose selectors can change between Tapo app releases. Enable it
only after capturing and canary-testing a flow against the exact APK, Android
image, locale, screen geometry, and account used in production.

This is not an HTML scraper: TP-Link exposes the documented T310/T315 export in
the Tapo mobile app, and does not publish a stable end-user web/cloud API for the
same data. The production-shaped fallback therefore isolates mobile UI
automation behind a durable internal job protocol instead of embedding screen
driving inside the API process.

## Recovery phases

| Phase | Source | Coverage | Operational boundary |
| --- | --- | --- | --- |
| 1A | Direct H100/H200 or energy-device LAN history | Attempts T310/T315 temperature and humidity retained as up to 96 15-minute buckets; supported energy devices can expose retained instantaneous power | Reverse-engineered local commands through the pinned `python-kasa`; hub/model/firmware canary required |
| 1B | Home Assistant recorder | Entities mapped through the Home Assistant adapter and retained by recorder | Alternative owning-adapter branch, not a cross-adapter merge; map each physical sensor through only one adapter |
| 2 | Optional compatibility endpoint | Whatever the separately maintained endpoint can authoritatively return after local TP-Link retention is incomplete | Experimental, explicitly configured, HTTPS-only, and not a public TP-Link API |
| 3 | Tapo Android export and Gmail mailbox | Older T310/T315 temperature/humidity CSV data available in the Tapo app | Used only after the private adapter is absent or fails; durable Appium job, then independently verified email/CSV staging |

TP-Link documents T310/T315 app export, intervals of 1, 15, or 30 minutes,
1, 6, or 12 hours, or 1 day, and up to two calendar years of retained cloud
data in its [history-export FAQ](https://www.tp-link.com/us/support/faq/4048/).
Its [T310 product page](https://www.tp-link.com/us/smart-home/smart-sensor/tapo-t310/v1/)
likewise describes cloud data logging and emailed CSV export.
That published app workflow is the reason the final phase uses the app and emailed CSV
instead of claiming that an undocumented cloud endpoint is stable.

### Gap detection and ingestion

Stuga checks adapter availability on transitions and every 30 seconds. Every 15
minutes it also scans the preceding 30 days of **trusted-good direct TP-Link**
samples for previously unnoticed timestamp holes. Estimated retained, private,
and app-export samples do not create false proof of exact sampling. Home
Assistant entities are event-driven, so stable values can legitimately be
silent; they are deliberately excluded from this periodic timestamp scan.
Home Assistant disconnect/reconnect availability gaps still use recorder
history. A gap is keyed by sensor, metric, source, and time range in SQLite, so
an API restart does not forget it. Partial and failed recoveries use bounded
exponential backoff.

For a direct TP-Link sensor, the local bridge runs before any configured remote
fallback:

- T310/T315 climate history attempts the hub child's retained
  `get_temp_humidity_records` response. It represents approximately the latest
  day as 15-minute buckets, not the original two-second sensor stream, and is
  stored as `estimated` rather than exact/good data.
- Retained power uses the device's private `get_power_data` command. Stuga asks
  for 5-minute points for ranges up to 12 hours and 60-minute points for longer
  ranges. These retained points are also `estimated`; actual retention and
  support remain device/firmware-dependent.
- Tapo interval-energy records are not substituted for Stuga's cumulative
  `energy` metric. A resettable daily or monthly quantity is a different
  physical meaning.
- A missing protocol capability returns `not-supported`; incomplete retention
  returns `partial` and permits the next configured phase to run.

Treat each hub model and firmware as a separate canary target. In particular,
an H100 result does not establish that the H200 child-command wrapper behaves
identically, and protocol-fixture tests do not replace a read-only live-history
check before a production firmware rollout.

For a Home Assistant-mapped sensor, Stuga instead asks recorder for the missing
entity history in bounded 24-hour chunks. It does not silently combine the same
physical sensor from both adapters.

Recovered rows pass the normal sensor, metric, canonical-unit, valid-range,
source, and timestamp checks. The coordinator inserts batches without live
publication or alert evaluation, then wakes the telemetry archive. Repeating a
recovery is safe because existing measurement identities are ignored.

Inspect the gap ledger with an authenticated non-Guest session:

```text
GET /api/v1/integrations/sensor-data-gaps?houseId=house-main
```

## Prerequisites for automated app export

Prepare these components before setting `TAPO_HISTORY_ENABLED=true` for the
app/mailbox path. A private-adapter-only deployment may omit them, but it cannot
claim or process an Appium job:

1. A dedicated Android device or emulator, a stable operator-assigned
   `TAPO_TARGET_LOCK_ID`, and a pinned Tapo APK whose exact version is recorded
   in `TAPO_APP_VERSION`.
2. Appium 2.18.0 or newer and UiAutomator2 3.1.0 or newer, reachable from the
   export-runner container. Record their exact installed versions, and pin
   `platformName: Android`, `appium:automationName: UiAutomator2`, UDID, Android
   platform version, language, and locale. The
   [Appium quickstart](https://appium.io/docs/en/latest/quickstart/) covers the
   server and driver installation.
3. A dedicated mailbox whose provider supports plus addressing and preserves
   the exact recipient in `To`, `Delivered-To`, or `X-Original-To` headers.
4. Gmail REST OAuth credentials with offline access and only
   `https://www.googleapis.com/auth/gmail.readonly`. Google classifies that as a
   restricted scope; review its [scope and verification requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
   before deployment.
5. A captured `config/tapo-flow.json` for the exact app build. The repository's
   `apps/tapo-export-runner/flow.example.json` is a schema example with
   intentionally invalid `CHANGE_ME` selectors.
6. A worker bearer token containing at least 32 UTF-8 bytes. Compose generates
   and shares it in a dedicated volume; non-Compose deployments must generate
   one and provide the same value to the API and runner.
7. A dedicated Tapo automation account with globally unique device aliases.
   Enabled mode requires the operator attestation
   `TAPO_DEDICATED_ACCOUNT=true`, and either an email/password pair or a stable
   per-account high-entropy `TAPO_ACCOUNT_PROOF` for a retained signed-in
   session.

The mailbox and Appium target should be dedicated to this automation. Tapo
account credentials, Gmail refresh tokens, screenshots, and emailed household
history all need the same protection as the primary Stuga database.

## Configure Gmail OAuth

Stuga uses Gmail's REST API, not an account password or IMAP. Create an OAuth
client for the mailbox owner, enable the Gmail API, request only
`gmail.readonly`, and perform a one-time consent flow with offline access to
obtain a refresh token. Google's [server-side OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
describes the authorization-code and refresh-token flow.

Configure the client ID plus both secret values, or none. For non-Compose use:

```dotenv
TAPO_HISTORY_GMAIL_CLIENT_ID=replace-me.apps.googleusercontent.com
TAPO_HISTORY_GMAIL_CLIENT_SECRET=replace-me
TAPO_HISTORY_GMAIL_REFRESH_TOKEN=replace-me
```

`TAPO_HISTORY_GMAIL_CLIENT_SECRET_FILE` and
`TAPO_HISTORY_GMAIL_REFRESH_TOKEN_FILE` are safer non-Compose alternatives; do
not configure an inline and file form for the same value. Compose never puts
these secrets in container environment variables. It mounts the API-only
`TAPO_HISTORY_API_SECRET_DIR` and reads files named `gmail-client-secret` and
`gmail-refresh-token`. The runner cannot read that directory.

The API compares every OAuth access token's Gmail `/users/me/profile` identity
with the expected primary account. It infers that identity from
`TAPO_HISTORY_EXPORT_EMAIL` for a normal Gmail address. If exports are delivered
through a Google Workspace alias or catch-all address, set
`TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL` to the primary address returned by that
profile endpoint. An identity mismatch stops mailbox processing; it is not
treated as an empty search.

The mailbox reader:

- polls `waiting-email` jobs at `TAPO_HISTORY_MAILBOX_POLL_INTERVAL_MS`;
- searches mail addressed to that job's unguessable plus address, with a CSV
  attachment whose Gmail internal timestamp is no earlier than the
  server-recorded app submission time;
- does not mark messages read, move them, or delete them;
- accepts a Gmail message ID for only one job; and
- validates and stages the CSV before changing the job to `completed`.

Test plus delivery before involving Appium. Send a message to an address such as
`history+stuga-canary@example.com`, then confirm that Gmail exposes the tagged
recipient in one of the headers above. Forwarders and aliases sometimes discard
that identity even when delivery succeeds.

## Capture and canary the Appium flow

Install and start Appium outside the supplied Compose stack:

```sh
npm install --global appium
appium driver install uiautomator2
appium --address <docker-bridge-or-vpn-interface-ip> --port 4723 \
  --log-filters <absolute-repository-path>/apps/tapo-export-runner/appium-log-filters.json \
  --log-level info
```

Confirm `appium --version` reports at least `2.18.0`. The runner marks every
typed value with Appium's sensitive-command header; the supplied filter also
removes value-endpoint payloads and `setValue` log lines. Run Appium under a
dedicated OS account, keep its stdout/stderr owner-only, rotate it, and expire it
promptly. Set `TAPO_APPIUM_LOGS_HARDENED=true` only after these controls are
active. The runner fails closed without both the version and operator flag.

Do not expose Appium on `0.0.0.0`, a LAN, or the public internet. It is remote
control of a logged-in device and commonly has no application authentication.
Bind it only to the interface used by the runner and enforce a host firewall
allowing that source alone. Never enable Appium relaxed-security features here.

Then use Appium Inspector against the dedicated target:

1. Sign in manually and complete any 2FA or consent screen.
2. Set the app language, Android locale, font scale, resolution, and orientation
   that will be pinned in production.
3. Navigate one T310/T315 export by hand: device, History, View All, export,
   range, interval, recipient, submit, and the positive confirmation screen.
4. Prefer resource ID or accessibility ID selectors. Use XPath only when a
   stable ID is unavailable. Coordinate taps and swipes are a last resort and
   must be guarded by `waitFor` checks.
5. Copy `apps/tapo-export-runner/flow.example.json` to
   `config/tapo-flow.json`, replace every `CHANGE_ME`, and retain distinct
   signals for authenticated, login, and two-factor screens.
6. Set every `intervalLabels` entry to the exact label shown by the pinned app
   locale (`6 h`, `12 h`, and `1 day` are not minute labels). The flow validator
   requires device selection plus a second exact-alias check, house-local start
   and end dates, the job-specific interval label, and the correlated email.
7. For calendar controls that cannot accept typed dates, use the bounded
   `repeatTap` action. Its server-derived month-count variables support zero
   through 24 previous/next-month taps, resolve the selector before every tap,
   and reject future, negative, or over-two-year navigation. Calibrate those
   selectors against the pinned app; the checked-in example still uses
   `CHANGE_ME` placeholders.
8. Ensure the final action waits for a positive export confirmation. Reaching
   the form or tapping Submit is not success.
9. Open **Set up > Connections > Automated Tapo history exports**, select the
   explicitly mapped sensor and metric, and run an acceptance canary. Its range
   must span at least eight configured intervals and no more than
   `max(7 days, 8 intervals)`. Verify the
   `canary` job reaches `waiting-email`, the exact plus-address receives one CSV,
   and the mailbox changes it to `completed` with a nonzero staged-sample count.
   Canary rows are acceptance evidence only: they are never ingested, added to
   the gap ledger, or reused by automatic recovery.

With `TAPO_RUNNER_ENABLED=false`, the runner is inert after loading the
configuration needed to select disabled mode: it logs and exits without
reading/executing the flow or contacting the API or Appium. Disabled mode does
**not** certify the
enabled-mode pins. Check Appium's private `/status` endpoint and the authenticated
operator jobs endpoint separately, then enable one runner to execute the canary.
Pin the target lock/UDID, Appium server, UiAutomator2 driver, Android
image/platform/language/locale, Tapo APK, account, and exact flow bytes together.
No checked-in selector is production-ready: a live canary against those exact
pins is still required.

Ordinary jobs are fail-closed until a canary proves both temperature and
humidity coverage and matches at least eight overlapping trusted-good live
TP-Link samples for each metric at zero time lag. The approval lasts 30 days and
is scoped to the deployment fingerprint, exact API implementation and
acceptance/parser revision, observed CSV schema, sensor/device/unique alias,
house timezone, and export interval. A queued job begins automatic renewal seven
days before expiry; a successful renewal swaps the approval, while a failed
renewal cannot extend it. A manually requested canary immediately relocks its
scope. An APK/flow/runtime/account/mailbox/API-build change, schema drift, or
scope change therefore requires a fresh successful canary.

The runner deliberately stops at `needs-attention` for login, 2FA, an unknown
screen, a missing device, or UI drift. It does not generically dismiss CAPTCHA,
security, consent, firmware, purchase, or destructive prompts.

## Environment configuration

A minimal Compose deployment resembles:

```dotenv
TAPO_HISTORY_ENABLED=true
TAPO_HISTORY_EXPORT_EMAIL=history@example.com
TAPO_HISTORY_EMAIL_TAG_PREFIX=stuga
TAPO_HISTORY_EXPORT_INTERVAL_MINUTES=15
TAPO_HISTORY_MAX_EXPORT_DAYS=30
TAPO_HISTORY_MAX_PENDING_EMAILS=1
TAPO_HISTORY_MAILBOX_POLL_INTERVAL_MS=60000
TAPO_HISTORY_EMAIL_TIMEOUT_MS=21600000
TAPO_HISTORY_WORKER_LEASE_MS=300000

TAPO_HISTORY_GMAIL_CLIENT_ID=replace-me.apps.googleusercontent.com
# Set only when Gmail /users/me/profile returns a different primary identity.
TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL=
TAPO_HISTORY_API_SECRET_DIR=./secrets/tapo-history-api
TAPO_HISTORY_RUNNER_SECRET_DIR=./secrets/tapo-history-runner

TAPO_RUNNER_ENABLED=true
TAPO_RUNNER_WORKER_ID=tapo-android-01
TAPO_TARGET_LOCK_ID=stuga-tapo-phone-01
TAPO_APPIUM_URL=http://host.docker.internal:4723
TAPO_APPIUM_CAPABILITIES_JSON={"platformName":"Android","appium:automationName":"UiAutomator2","appium:udid":"emulator-5554","appium:platformVersion":"15","appium:language":"en","appium:locale":"GB","appium:noReset":true,"appium:newCommandTimeout":86400}
TAPO_APPIUM_LOGS_HARDENED=true
TAPO_APPIUM_VERSION=2.18.0
TAPO_UIAUTOMATOR2_VERSION=3.1.0
TAPO_APP_VERSION=<exact-installed-version>
TAPO_DEDICATED_ACCOUNT=true
# Use this only for retained-session mode; login mode uses the secret files.
TAPO_ACCOUNT_PROOF_FILE=/run/secrets/tapo-history/account-proof
TAPO_RUNNER_POLL_MS=10000
TAPO_RUNNER_HEARTBEAT_MS=15000
```

Create the ignored secret directories before startup. The API directory holds
`gmail-client-secret`, `gmail-refresh-token`, and, only when used,
`private-endpoint-token`. The runner directory holds either `account-email` and
`account-password`, or `account-proof` for retained-session mode. File
permissions should allow only the deployment account to read them. Compose
generates the shared worker token separately; neither container receives it
inline.

The Tapo email/password are optional only when the retained Android session is
already authenticated and a stable random account proof is configured. The
runner HMAC-binds the normalized email identity or proof into its fingerprint;
the plaintext value is not logged or placed in the fingerprint. This is an
operator/deployment attestation, not a Tapo-issued runtime account identity.
Runtime identity still depends on one unique live alias and the flow's immutable
on-screen `deviceProofs[deviceId]` check. Do not assume `noReset` eliminates
future login or 2FA challenges.

Allowed export intervals are `1`, `15`, `30`, `60`, `360`, `720`, and `1440`
minutes. Choose the coarsest interval that still meets the system requirement;
15 minutes matches local climate buckets and keeps CSV/job volume bounded.
Explicit backfills must fall within the most recent 730 days. They are advanced
as sequential segments of at most 30 days by default; the row budget makes a
one-minute segment shorter (about 13.9 days). `TAPO_HISTORY_MAX_EXPORT_DAYS`
may be set from 1 through 730, but it never overrides the two-year or row limits.

Start the API, web app, databases, and isolated runner with:

```sh
docker compose --profile tapo-history up --build -d
docker compose --profile tapo-history logs -f api tapo-export-runner
```

The profile starts the runner, not Appium or Android. On Docker Desktop the
default URL reaches an Appium server on the host through
`host.docker.internal`. Linux Compose adds the corresponding host-gateway name.
In either case, firewall Appium to the Docker/runner source only. If Appium is
elsewhere, set `TAPO_APPIUM_URL` to a private HTTPS endpoint; the runner rejects
plain HTTP except for explicit loopback and its named local Compose hosts.

## Job lifecycle and operator controls

The API owns the SQLite queue. A runner atomically claims the oldest runnable
Appium job and receives a per-claim lease capability. Its lease owner is derived
from the stable `TAPO_TARGET_LOCK_ID` plus mandatory UDID, not the worker label or
Appium hostname. It heartbeats while driving the UI. The API returns the new
expiry on every heartbeat; an independent runner watchdog aborts every Appium
request at that server-provided deadline.
An expired `claimed` or `running` lease can be reclaimed, up to the job's
attempt limit (five by default); a stale worker also stops on HTTP 409 or after
three heartbeat failures. `waiting-email` holds no worker lease. If matching mail
does not arrive within `TAPO_HISTORY_EMAIL_TIMEOUT_MS` (six hours by default),
the job fails and is retried within its bounded attempt budget.

`TAPO_HISTORY_MAX_PENDING_EMAILS=1` is the safe default. The claim transaction
counts live `claimed`/`running` Appium work and `waiting-email` work together, so
the next mobile export is not submitted until the outstanding generation has
resolved. The configurable range is 1 through 10; raise it only after validating
Tapo request limits, mailbox latency, and operational review capacity.
Run exactly one runner process for each Android target. The API lease prevents
two jobs from being claimed for one target, but duplicate runner replicas can
still collide during the Appium session preflight that happens before a claim.

| State | Meaning | Operator action |
| --- | --- | --- |
| `queued` | Ready for an Appium worker | None unless it remains queued because the worker is disabled/unreachable |
| `claimed` | Leased but automation has not started | Check runner logs if it persists beyond the lease |
| `running` | Appium is executing the tested flow | Do not operate the same Android target manually |
| `waiting-email` | Tapo showed positive export confirmation | Check delivery, spam, Gmail OAuth, and preserved recipient headers |
| `needs-attention` | Login, 2FA, selector drift, wrong device name, or CSV validation needs intervention | Correct the cause, canary if selectors changed, then explicitly Retry |
| `failed` | Infrastructure or automation failure | Automatic lease retry is bounded; Retry resets attempts after correction |
| `completed` | CSV/private rows were validated and durably staged | The gap coordinator consumes them after measurement ingestion succeeds |
| `cancelled` | Operator stopped an active request | Let a later gap attempt create/requeue work only after deciding the range is still needed |

Open **Set up > Connections > Automated Tapo history exports** to see provider,
device identity, range, attempts, lease-derived state, and the last error. Its
health strip shows whether automation is operational, a pending canary, the
waiting/max mailbox count, current mailbox error/failure count, last worker
contact, and a deployment-fingerprint prefix. The authenticated jobs response
also exposes `mailbox.lastSuccessfulPollAt`, `lastErrorAt`, `lastErrorCode`,
`consecutiveFailures`, and `budgetExhaustions`. The panel permits retry for
`failed` or `needs-attention` jobs and cancellation of active jobs. Owner/Admin
users can also create a fresh, isolated canary. The authenticated REST
equivalents are:

```text
GET    /api/v1/integrations/tp-link/history-export/jobs
POST   /api/v1/integrations/tp-link/history-export/canary
POST   /api/v1/integrations/tp-link/history-export/jobs/{id}/retry
DELETE /api/v1/integrations/tp-link/history-export/jobs/{id}
```

The canary body is `{ "sensorId", "metric", "from", "to" }`; the range must
span at least eight configured export intervals, end no more than five minutes
in the future, and be no longer than `max(7 days, 8 intervals)`. Both temperature
and humidity definitions must be enabled, and acceptance verifies both columns
regardless of the selected trigger metric. The public job's `canary: true` flag
distinguishes its staged-only acceptance result.

The runner-only endpoints under `/api/v1/internal/tapo-history` require the
separate bearer token and an active lease; they are not browser-session APIs.
The supplied nginx proxy returns 404 for `/api/v1/internal/`, so the runner uses
the isolated automation network directly. It is not attached to the Timescale
backend network. Do not expose those routes or Appium publicly.

## CSV identity and correctness boundary

The Tapo CSV filename and content do not reliably contain the stable device ID.
Stuga therefore generates an independent API-only random nonce for every new
job and exposes only its 128-bit plus-address capability to Tapo. The public job
ID cannot derive that address. A retry retains the durable job but every newly
leased attempt rotates to a new address and clears the prior submission/message
binding. Generation fences prevent late mail from a cancelled or earlier
attempt from completing the current one. Changed device alias, range, metric,
interval, or provider creates a distinct request. The recipient capability and
Gmail message ID are omitted from the operator API. The mailbox accepts only
fresh mail delivered to the exact current capability address, then binds parsed
rows to the job's already stored sensor ID.

Completed jobs retain the attachment SHA-256, byte length, parser version, and
schema signature, while Gmail retains the source message and attachment. Stuga
does not store a second raw CSV/RFC-message copy; configure Gmail retention to
cover the period in which byte-for-byte replay or forensic reprocessing may be
required.

The API derives `deviceName` only from live discovery of the immutable mapped
TP-Link device ID and refuses absent or duplicate aliases. Unmapping or
reassigning a sensor immediately invalidates every queued/running job whose
snapshotted physical device differs. The API revalidates that binding and the
live alias when claiming, heartbeating, updating status, and completing mail.
The runner must tap that exact alias and
verify it again on the device page. Each job also snapshots the house IANA time
zone, which must match the pinned Android/Tapo calendar configuration. The lease
owner is the stable target-lock ID plus mandatory UDID, while the queue permits
only one live lease per target. Never select a device by list position.

CSV parsing is bounded to 8 MiB and at most 23,000 raw data rows. After
calendar-boundary filtering, one job accepts at most 20,000 data rows, normally
materializing about 40,000 temperature and humidity samples. This remains below
the database's separate 250,000-sample atomic staging guard. Longer gaps are
advanced through sequential bounded jobs, so a supported two-year request does
not require an unbounded parse or transaction.

The parser fails closed unless the CSV has an accepted delimiter, valid UTF-8,
unambiguous time/temperature/humidity columns, and an explicitly declared
Celsius or Fahrenheit temperature unit. It uses the snapshotted Home timezone,
including repeated daylight-saving wall times, converts to canonical units,
rejects conflicting duplicate timestamps and out-of-range values, and enforces
the requested boundaries, cadence, and skipped-row ratio. Empty, one-point,
truncated, finer/default, internally gapped, unitless, or structurally changed
exports move to `needs-attention`; an ordinary job must match the structural
schema signature approved by its canary. Schema drift revokes that scope's
approval and requests recertification.

Invalid/oversized matching attachments are isolated; a later valid correlated
CSV can still complete the job, while an invalid-only result becomes
`needs-attention`. Completion records `sourceArtifactSha256` and
`sourceArtifactBytes` for the exact attachment plus `parserVersion` and
`sourceSchemaSignature`. Those non-secret audit fields are returned on the
authenticated operator job, although the raw mail and recipient capability are
not. A message, artifact, or staged-source
identity cannot be silently reused for conflicting content. App CSV, local
retained history, and private-adapter rows are labelled `estimated`; only fresh
direct observations can claim `good` quality.

## Optional experimental endpoint

There is no publicly documented end-user TP-Link smart-home cloud API. TP-Link
staff continue to describe the Tapo API as not public in its
[Smart Home Community](https://community.tp-link.com/en/smart-home/forum/topic/683438).
`TAPO_HISTORY_PRIVATE_ENDPOINT` is therefore a compatibility hook for an
operator-maintained service, not an official integration and not a promise that
captured private endpoints will remain usable.

Configure both values or neither:

```dotenv
TAPO_HISTORY_PRIVATE_ENDPOINT=https://history-adapter.example.net/v1/tapo/history
TAPO_HISTORY_PRIVATE_TOKEN=replace-me
```

Those token lines are for non-Compose operation. With Compose, put only the
token value in API secret file `private-endpoint-token`.

The endpoint must use HTTPS, contain no URL credentials, and cannot use a literal
IP, `localhost`, or a `.local` hostname. Stuga sends:

```json
{
  "deviceId": "stable-tapo-device-id",
  "from": "2026-06-01T00:00:00.000Z",
  "to": "2026-06-02T00:00:00.000Z"
}
```

with a bearer token. DNS is checked for private/reserved results and the vetted
public address is pinned through TLS while the configured hostname is verified.
The response must be bounded JSON, echo the exact `deviceId`, set
`state: "complete"`, provide covering ISO `rangeStart` and `rangeEnd`, and
provide a `samples` array whose rows have an ISO `timestamp` and finite
`temperature`, `humidity`, or `power` values in Stuga canonical units.
Redirects are rejected. The endpoint owner must fail the request when it cannot
authoritatively cover the requested metric/range; a syntactically successful
empty response is not evidence that a gap contains no readings.

The private adapter is tried before Appium and falls back to the documented app
export when it is absent, incomplete, or fails. Its accepted rows are still
labelled `estimated`. Keep it disabled unless its authentication, data
identity, timestamps, units, retention, rate limits, terms, and firmware/app
compatibility are independently tested and monitored.

## Irrecoverable gaps and maintenance

No automation can reconstruct a reading that was never retained by the hub,
Home Assistant recorder, or Tapo cloud. TP-Link states that the hub must remain
connected to the internet to upload T310/T315 history, that data during a power
outage is lost, and that restarting the hub can delete unuploaded history; see
its [missing-history FAQ](https://www.tp-link.com/us/support/faq/3450/).

For production:

- monitor unresolved gaps and `waiting-email`/`needs-attention` job age;
- alert on repeated OAuth refresh, mailbox, Appium, or lease failures;
- keep the Android target powered, time-synchronized, private, and dedicated;
- expire protected runner screenshots and mailbox CSVs according to policy;
- include the Stuga SQLite database in verified backups because it contains the
  job ledger and staged rows;
- watch the authenticated mailbox health fields and artifact/parser/schema audit
  metadata as well as job status; and
- let the scoped canary renew before its 30-day expiry, and run a fresh live
  canary immediately after any Tapo, Android, Appium, Gmail, API, account, flow,
  selector, locale, or network change.

Treat phase 3 as a controlled browser-style automation around a vendor UI, not
as an SLA-backed API. The local bridge and Home Assistant recorder remain the
preferred recovery paths whenever their retention covers the gap.
