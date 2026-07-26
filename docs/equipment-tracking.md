# Property-wide equipment tracking

Stuga’s first tracking slice keeps raw BLE observations separate from derived
asset positions. It is feature-gated and off by default.

Tracked assets are canonical Property inventory equipment records. The
equipment ID is stable across web inventory management, maintenance, Stugby
sharing, iOS inventory sync, tag replacement, and position history. The
assigned area remains the expected location; a derived tracking position never
silently overwrites it.

## Included

- Native iOS Core Bluetooth observer with a specific service UUID.
- Opt-in passive/property observation and foreground Active/Find modes.
- Keychain observer credentials and a protected, bounded seven-day queue.
- Rotating tag identifiers and authenticated 18-byte service-data payloads.
- Fixed gateway registration, heartbeats, zones, and authenticated batches.
- Immutable raw evidence, deduplication, confidence, uncertainty, freshness,
  movement, ordered SSE updates, and explainable current state.
- MapKit Property map, uncertainty circles/zones, unknown tray, filters, and
  warmer/colder Find nearby guidance.
- Property-wide inventory on iOS, with an in-app QR scanner and printable QR
  labels for every equipment record.
- Equipment notes, issue reporting through Property maintenance, and
  conflict-safe borrowing/return history.
- Optional foreground-only member location sharing with an accuracy circle,
  explicit one-hour timeout, and no retained location trail.
- Raw mobile observer-coordinate redaction after 24 hours by default.

iOS background discoveries are opportunistic. iOS may coalesce duplicates,
increase scan intervals, suspend the app, or provide no execution opportunity.
The UI must never imply continuous background coverage or an exact GPS asset
position.

## Enable a test deployment

Start with fixed gateways and zone inference:

```dotenv
TRACKING_ENABLED=true
TRACKING_LIVE_MAP_ENABLED=true
TRACKING_ROTATING_IDENTIFIERS_ENABLED=true
```

Enable mobile behavior only after consent, privacy wording, and field testing:

```dotenv
TRACKING_MOBILE_OBSERVER_ENABLED=true
TRACKING_IOS_BACKGROUND_ENABLED=true
TRACKING_EXPERIMENTAL_COORDINATE_INFERENCE_ENABLED=true
```

Enable optional live member presence separately:

```dotenv
TRACKING_USER_LOCATION_SHARING_ENABLED=true
```

This flag requires tracking and the live map. Sharing starts only after a
member taps **Share**, requests iOS When In Use permission, stops when Stuga
leaves the foreground or after at most four hours, and is removed immediately
when stopped. The default iOS session is one hour; a 90-second server fail-safe
removes clients that stop updating.

`TRACKING_SECRET_KEY_FILE` encrypts per-tag secrets. A backup containing
provisioned tags fails closed if this key is unavailable.

## BLE payload

Stuga v1 uses 18 bytes of service data:

```text
header(1) | rotating id(8) | epoch(2) | event(2) | battery(1) | auth(4)
```

The private service UUID is
`F8A57A01-9D58-4C66-8D2D-2026A11E0001`. Tags advertise the rotating identifier,
never their permanent asset or tag identifier.

With a 128-bit service UUID, this 18-byte service-data value requires BLE 5
extended advertising. Before selecting legacy 31-byte-only tag hardware,
finalize either a SIG-assigned compact service identifier or a smaller v2
payload and validate its iOS background behavior.

## API

The OpenAPI document covers provisioning, observer management, batch ingestion,
evidence, current/history state, short-lived Find tokens, map snapshots, and
ordered SSE updates under `/api/v1`.

Equipment operations use:

- `GET /properties/{propertyId}/equipment-loans`
- `POST /area-equipment/{equipmentId}/borrow`
- `POST /equipment-loans/{loanId}/return`
- existing Property note and maintenance-task APIs

Current member presence uses:

- `GET /properties/{propertyId}/member-locations`
- `PUT /properties/{propertyId}/member-location`
- `DELETE /properties/{propertyId}/member-location`

QR labels contain only stable Property and equipment identifiers. A scan is not
authorization: the app must reload or use its authorized Property inventory
before opening the equipment.

Machine observer credentials are accepted only for:

- `POST /tracking/observations:batch`
- `POST /tracking/observers/{observerId}/heartbeat`

Provisioning secrets and observer credentials are returned once and responses
are marked `no-store`.

## Deterministic simulation and replay

Generate a seeded property walk with RSSI noise, missed advertisements, mobile
and fixed observers, and an outage-delayed queue, then replay it through the
current inference algorithm:

```powershell
npm run tracking:simulate -- --seed 42 --duration-seconds 300 --output tracking-run.json
```

The output contains truth positions, immutable simulated observations, each
derived estimate, uncertainty, explanation, and the median coordinate error.
The command refuses to overwrite an existing output file.

## Current boundary

This slice does not include Android clients, gateway firmware, GATT buzzer
control, public crowdsourcing, Apple/Google finding networks, or calibrated
room-scale ranging. Full alert configuration and field-calibrated RF models
remain later phases, as do end-user tracking-data export/deletion workflows.
