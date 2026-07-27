# Property-wide equipment tracking

Stugu tracking is a profile-driven evidence system for canonical Property
equipment. It does not assume that every BLE advertiser is trackable, and it
does not define a private BLE wire format.

`AreaEquipment` remains the only equipment identity. Its saved Home, area, or
map pin is the expected location. Tracking produces a separate, derived
`EquipmentLocationEstimate` and never overwrites that saved placement.

## Domain model

- A `TrackingProfile` is a versioned, declarative description of advertisement
  matching, safe field extraction, identity rules, platform support, and
  capabilities.
- A `TrackingEndpoint` is a physically or cryptographically claimed location
  source. It can be a beacon, observer-local peripheral, verified tracker, or
  future external provider.
- An `EquipmentTrackingBinding` is the temporal relationship between one
  endpoint and one canonical equipment record. Closing a binding retains its
  history.
- A `TrackingObserver` is an authorized phone or fixed gateway.
- A `TrackingObservation` is immutable, normalized, claimed-only evidence.
  Raw BLE frames are not an ingestion or storage type.
- A `TrackingGatewayRollupInput` summarizes a gateway observation window so a
  dense deployment does not amplify every packet into storage and live events.
- An `EquipmentLocationEstimate` is versioned derived state with uncertainty,
  freshness, source, truth class, and complete provenance.

Trackability, identity scope, identity strength, background support, and map
capability are separate dimensions. Supporting a profile never implies exact
coordinates, reliable background scanning, spoof resistance, or alert
eligibility.

## Data flow

```text
local BLE frame
  -> bounded declarative profile parser
  -> observer-scoped claimed-identity resolver
  -> normalized observation or gateway rollup
  -> scope, binding, profile, and data-mode validation
  -> immutable evidence
  -> uncertainty-aware estimate
  -> Property map and ordered equipment events
```

Unknown and ambiguous frames stay on the observer and are discarded. The
backend accepts evidence only when the endpoint is claimed, actively bound,
visible to that observer, and uses the binding's exact profile version.

The observer resolver is a short-lived, machine-authenticated manifest. It
contains only the identity fields required to resolve endpoints visible to that
observer. It is not a general inventory export and is returned with
`Cache-Control: private, no-store`.

## Profiles and compatibility

Profiles contain data only: filters, byte ranges, encodings, identity fields,
capabilities, and platform conditions. They cannot contain executable code,
expressions, arbitrary GATT operations, JavaScript, WASM, or native modules.
Every profile envelope includes a detached digest and can carry a registry
signature. Profile ID and version are recorded with every accepted item of
evidence and every estimate.

Built-in profiles cover iBeacon, Eddystone UID, reviewed stable service or
manufacturer data, and observer-local GATT peripherals. Generic profiles
require explicit enrollment identity and never auto-match an ambient frame.
Compiled and reviewed drivers are the separate extension point for connection,
configuration, buzzer, firmware, or vendor-account behavior.

Compatibility is assessed for an exact profile version, platform, scan
context, and optional OS version. The result reports:

- trackability tier;
- identity scope and strength;
- background support;
- map capability; and
- concrete operating conditions.

Proprietary crowd networks are not generic BLE profiles. Any official future
integration belongs behind an external location-provider adapter.

## Enrollment, identity, and access

Endpoint enrollment requires an explicit proof kind such as physical access,
GATT challenge, vendor attestation, cryptographic challenge, or external
account authorization. Raw identity fields are encrypted at rest. Lookup uses
tenant-scoped HMAC references, and responses expose only an opaque
`identityReference`.

Only Owners and Admins can enroll endpoints, change their lifecycle state, or
bind them to equipment. Mobile observers may be registered by a Property
member, while fixed gateways require an administrator. Observer credentials are
opaque, returned once, and stored as verifiers.

Observer-local identities must include an observer scope and can bind only to
that observer. A phone-local peripheral UUID is never promoted to a
cross-observer identity.

## Evidence and privacy

The evidence endpoint accepts two bounded arrays:

- normalized observations for event-level evidence; and
- gateway rollups for packet-dense observation windows.

Both carry `schemaVersion`, `dataMode`, an idempotency key, Property, endpoint,
equipment, observer, and exact profile version. `live` and `demo` are isolated
at admission, storage, inference, snapshots, and streams.

The server rejects unknown fields, raw payloads, unclaimed endpoints, missing
bindings, observer-scope violations, Property mismatches, profile mismatches,
and cross-mode evidence. Mobile coordinates are role-redacted in evidence
queries. Property settings independently configure observation, rollup, and
estimate retention.

There is no public crowdsourcing, ambient unknown-device upload, or automatic
tracking from discovery.

## Location semantics

- A fixed gateway normally supports an area or zone observation.
- A phone sighting supports a broad last-seen area around the phone.
- A current foreground Find session supports nearby guidance with an
  uncertainty radius.
- Multiple suitable observers may support a coordinate estimate, still with a
  non-zero uncertainty radius.
- A manual position is explicit manual provenance.
- Radio silence decays confidence and freshness. It never fabricates an exit.

Every estimate records the algorithm, evidence and rollup IDs, observers,
profile versions, factors, source, confidence, truth class, and version.
Unknown equipment remains unplaced rather than appearing at an arbitrary map
center.

iOS scanning is profile-filtered and opportunistic in the background. The app
keeps raw frames in memory only long enough to parse and resolve them, queues
only normalized evidence, and uses a short-lived resolver cache. Foreground
Find is the high-feedback mobile mode. Fixed gateways are the reliable
continuous-coverage layer.

## API

The OpenAPI document exposes the future model under `/api/v1`:

- `GET /tracking/capabilities`
- `GET /tracking/profiles`
- `POST /tracking/compatibility-assessments`
- `GET|POST /tracking/endpoints`
- `GET /tracking/endpoints/{endpointId}`
- `PATCH /tracking/endpoints/{endpointId}/status`
- `GET /properties/{propertyId}/tracking-bindings`
- `POST|DELETE /area-equipment/{equipmentId}/tracking-binding`
- `GET /properties/{propertyId}/tracking-observers`
- `POST /tracking/observers/register`
- `PATCH /tracking/observers/{observerId}`
- `GET /tracking/observers/{observerId}/resolution-manifest`
- `POST /tracking/observers/{observerId}/heartbeat`
- `POST /tracking/observers/{observerId}/position`
- `POST /tracking/evidence:batch`
- `GET /properties/{propertyId}/tracked-equipment`
- `GET /area-equipment/{equipmentId}/tracking-position`
- `GET /area-equipment/{equipmentId}/tracking-position-history`
- `PUT /area-equipment/{equipmentId}/manual-tracking-position`
- `GET /area-equipment/{equipmentId}/tracking-observations`
- `GET /area-equipment/{equipmentId}/tracking-find-descriptor`
- `GET /properties/{propertyId}/tracking-map-snapshot`
- `GET /properties/{propertyId}/tracking-stream`

Machine observer credentials are accepted only for the resolver manifest,
heartbeat, and evidence ingestion. Find descriptors and resolver manifests are
short-lived and marked `no-store`.

## Configuration

Tracking is off by default. Enable only the capabilities deployed at a
Property:

```dotenv
TRACKING_ENABLED=true
TRACKING_LIVE_MAP_ENABLED=true
TRACKING_MOBILE_OBSERVER_ENABLED=true
TRACKING_IOS_BACKGROUND_ENABLED=true
TRACKING_ANDROID_BACKGROUND_ENABLED=true
TRACKING_ANDROID_GATEWAY_MODE_ENABLED=true
TRACKING_MOVEMENT_TRAILS_ENABLED=true
TRACKING_EXIT_ALERTS_ENABLED=true
TRACKING_USER_LOCATION_SHARING_ENABLED=true
```

`TRACKING_SECRET_KEY_FILE` locates the key used for encrypted enrollment
identity. Losing that key fails closed.

Member location sharing is a separate, explicit, foreground, time-limited
capability. It retains no location trail and does not change equipment
tracking identity or inference.

## Deterministic simulation

The simulator produces normalized demo evidence with RSSI noise, missed
advertisements, and optional outage-delayed delivery, then replays it through
the production profile-fusion inference function:

```powershell
npm run tracking:simulate -- --seed 42 --duration-seconds 300 --output tracking-run.json
```

The output keeps `dataMode: "demo"` and `truthClass: "simulated"` explicit.
No simulated item can influence live state.

## Deliberate boundaries

The model does not claim universal BLE compatibility, infer identity from a
MAC address or fingerprint, download executable parsers, reverse engineer
encrypted tracker networks, or promise exact GPS-like positions. A verified
open beacon can be added later as another signed profile and compiled driver
without changing equipment, binding, evidence, or estimate contracts; its
physical wire format must be selected through hardware and platform
validation.
