# Gree/Wilfa heat pumps

Stugu can discover and monitor compatible Gree-protocol air-source heat pumps,
including Wilfa models, through either the trusted local network or the EWPE
Smart cloud. Both paths are read-only: Stugu sends state queries but exposes no
temperature, mode, schedule, or power commands.

## Verified Wilfa/EWPE findings

The cloud reader was verified against a Wilfa Nordkapp 30W named `AC3a95`,
firmware 2.12, model ID 10001, model version 19.4. The test account continued to
return state while the phone used cellular data, confirming that this is an
internet path and does not depend on local-LAN reachability.

EWPE Smart uses encrypted REST calls at `https://eugrih.gree.com` for login,
Home/Room/device inventory, per-device keys, and broker selection. Live state
then uses TLS MQTT, normally at `mqtt-eu.gree.com:1984` or `:1994`. Stugu checks
that broker discovery remains on a `gree.com` host, bounds response sizes, uses
timeouts, and never logs cloud tokens or decrypted envelopes.

The verified unit reported:

- power, selected mode, target temperature, fan and swing settings;
- indoor temperature (`TemSen`; this firmware encodes 20 °C as 60);
- compressor frequency (`CompressorFqy`), Wi-Fi status, and fault fields; and
- additional vendor diagnostics whose engineering units are not independently
  calibrated and are therefore stored with explicit `Raw` names.

One live observation was power on, cooling selected, target 20 °C, reported
indoor temperature 20 °C, compressor frequency 12 Hz, Wi-Fi online, and no
reported fault. This is compatibility evidence for that unit/firmware, not a
promise that every Gree-derived model exposes the same fields.

## Set up and discovery

1. Commission the heat pump in EWPE Smart and leave its Wi-Fi enabled.
2. Select the owning Home and open **Set up**.
3. For local-first operation, keep Stugu and the heat pump on the same trusted
   LAN. Stugu scans without binding and offers compatible units it finds.
4. If LAN discovery is unavailable, open **EWPE Smart**, enter the account
   credentials, and discover the account inventory. Discovery is transient and
   does not save credentials.
5. Explicitly add one discovered unit. Only then does Stugu verify a live state
   read, create the Property equipment record, protect the required credential,
   and start monitoring.
6. Open **Home**, choose **Place on this floor**, then use edit mode to move the
   high-wall marker. The placement is shared by the 2D and 3D views.

If local and cloud discovery expose the same MAC, Stugu presents the local path
first. A configured physical unit cannot be added twice. Disconnecting deletes
its saved local key or EWPE credentials and stops monitoring while retaining
inventory, placement, and recorded history.

### Local network configuration

Local discovery and polling normally use UDP port 7000. Never forward it from
the internet. Docker/VM NAT or wireless client isolation can hide broadcasts;
in that case provide the physical LAN's directed broadcast:

```dotenv
GREE_DISCOVERY_TARGETS=192.168.1.255
GREE_POLL_INTERVAL_MS=60000
```

Multiple targets can be comma-separated. The production image includes the
pinned Python helper dependency. `GREE_PYTHON` overrides the Python executable
only when required.

## Stored data and security

The current typed state and every successful poll contain:

- transport, availability, timestamps, equipment identity, and Home placement;
- power, selected mode, target and reported indoor temperatures;
- fan, swing, quiet, turbo, and X-Fan settings;
- compressor frequency when reported;
- activity plus its evidence level; and
- a bounded whitelist of raw diagnostic and fault values.

Missing indoor temperature remains missing; it is never replaced by the target.
Selected heating/cooling mode is not proof that the compressor is active.
Compressor frequency greater than zero is stronger protocol evidence, while a
powered-off unit is explicitly off.

Local binding keys and EWPE credentials are write-only and live in Stugu's
protected integration-secret file, not SQLite or TimescaleDB. Cloud session
tokens and MQTT sessions are memory-only. Account discovery does not persist
the supplied password. The integration intentionally exposes no control route.

Each successful poll first enters the crash-safe SQLite telemetry journal and
current projection, then the checkpointed archive worker stores it in the
TimescaleDB heat-pump hypertable. Archived rows include placement, transport,
compressor frequency, and diagnostic JSON. During a TimeDB outage the local
journal continues accumulating; reconciliation is idempotent and local rows are
not pruned before durable acknowledgement. History reads merge the permanent
archive and local tail and fail closed if a requested retained range cannot be
answered completely.

Relevant API routes are:

```text
POST   /api/v1/integrations/gree/discover
PUT    /api/v1/integrations/gree/config
POST   /api/v1/integrations/gree/cloud/discover
PUT    /api/v1/integrations/gree/cloud/config
DELETE /api/v1/integrations/gree/config/{connectionId}
GET    /api/v1/heat-pumps?houseId={homeId}
PATCH  /api/v1/heat-pumps/{connectionId}/placement
GET    /api/v1/heat-pumps/{connectionId}/history
```

## Home impact and visualization

The Home views show the unit's state beside its marker in both 2D and 3D. An
estimated influence contour is solid only when compressor-frequency evidence
supports active heating/cooling; a dashed contour means the mode is merely
selected. Labels repeat the meaning so colour is never the only signal. The
contour is a qualitative local influence estimate, not measured airflow,
temperature propagation, delivered heat, efficiency, or room coverage.

The retained data can support evidence-based analysis by comparing heat-pump
state transitions with:

- nearby room-temperature response and recovery time;
- outdoor temperature and weather;
- Home electricity use or a dedicated power meter;
- door/window state and room-to-room temperature differences; and
- target-versus-reported temperature error and fault recurrence.

Recommended next evidence is a dedicated power meter and one calibrated room
sensor near, but not directly in, the outlet stream. Those enable defensible
energy attribution and response estimates. Do not calculate COP or delivered
heat from compressor frequency alone. Any future control should be a separate,
explicitly enabled project with command confirmation, bounds, idempotency,
audit logging, and a safe fallback to the physical remote/EWPE app.

## Troubleshooting

- Verify that the unit remains online in EWPE Smart.
- For local mode, remove wireless client isolation and allow UDP 7000 within
  the trusted LAN; use `GREE_DISCOVERY_TARGETS` through Docker/VM NAT.
- For cloud mode, allow outbound HTTPS and TLS MQTT to Gree's European service.
- Leave an unavailable configured unit in place while checking connectivity;
  monitoring retries with bounded backoff.
- Revalidate after firmware updates because Gree's protocol is not a stable
  public compatibility contract.

Local compatibility uses the pinned
[`greeclimate`](https://github.com/cmroche/greeclimate) GPL-3.0 library. Cloud
compatibility is based on observed EWPE Smart protocol behaviour and may need
maintenance if the vendor changes authentication, envelopes, or broker policy.
