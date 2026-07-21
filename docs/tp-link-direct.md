# Direct TP-Link hubs and energy devices

Stuga can poll three local TP-Link source shapes without Home Assistant:

- Tapo T310 and T315 climate children paired to an H100 or H200 hub;
- paired hub children that expose a boolean python-kasa contact-state capability; and
- one discovered or manually addressed TP-Link/Kasa device (or one strip and its outlets)
  that the pinned python-kasa library exposes through `Module.Energy`.

The energy-device boundary is capability-based rather than a model allowlist.
Stuga reads `current_consumption` as instantaneous `power` in W. It reads
`consumption_total` as cumulative `energy` in kWh only when python-kasa actually
provides that property. It does not relabel daily or monthly reset counters as
cumulative energy. The pinned python-kasa 0.10.2 SMART/Tapo implementation does
not provide `consumption_total`, so a typical direct Tapo smart energy device
provides power but not Stuga's cumulative-energy metric. Some legacy Kasa
emeter devices provide a total-since-reboot counter; that counter can decrease
after a device reboot and is not a certified billing total.

`electricity_price` never comes from a TP-Link device. By default Stuga fetches
it per property from Pörssisähkö; see [electricity prices and contracts](electricity-prices.md). It may also be supplied through a Home
Assistant mapping or the v2 measurement API. Threshold alerts work for any
accepted direct `power` or `energy` sample through the normal metric alert
engine.

The Tapo/Kasa app is still used to commission devices, pair hub children,
update firmware, and give devices useful names. Reserve a stable LAN address
for the configured hub or direct energy device before configuring Stuga. For
T310/T315, TP-Link also documents app-based CSV export and up to two calendar
years of cloud retention in its [history-export FAQ](https://www.tp-link.com/us/support/faq/4048/).

## 1. Install the helper dependency

Docker images built from this repository already contain Python and the pinned
dependency. For a local Node.js development run, use Python 3.11 or newer:

```powershell
python -m pip install -r apps/api/python/requirements.txt
```

On a system where the executable is named `python3`, either use that command or
set `TP_LINK_PYTHON=python3`.

## 2. Find or address the device and save credentials

Use the TP-Link account email and password that can authenticate to the hub.
Select the owning Home and open **Set up > Connections** at
`/properties/{propertyId}/homes/{homeId}/setup/connections`, then select
**Find devices**. Choose an H100/H200 hub or a supported energy device, or enter
a reserved IP address manually if discovery is blocked by Wi-Fi isolation,
VLANs, or Docker networking. The scan uses saved TP-Link credentials or
credentials currently entered in the setup form to update non-hub devices and
includes only devices that expose `Module.Energy`. Legacy Kasa energy devices
such as HS110 can normally be verified over their older local protocol without
credentials. Draft credentials used for discovery are not saved. Enter the same
account used by the Tapo/Kasa app and select **Save and connect**.

These are two separate discovery stages. **Find devices** locates H100/H200
hubs, supported energy devices, and any Home Assistant instance; it does not
enumerate the T310/T315 devices paired to a hub. Hub addresses can be reported
without authentication. Verifying an energy device's capability requires saved
TP-Link credentials because `python-kasa` must update the device before its
modules are available. The credentials are also required for the direct local
connection. Only after that connection starts can the H100/H200 report its
paired child sensors or a direct endpoint report live Energy data.

Connections saved in Stuga are owned by the selected Home. One Home can have
an H100/H200 plus one or more directly polled energy sockets, and each connection
runs independently with its own LAN host and status. `TP_LINK_HOST` remains a
single advanced environment override for legacy deployments.

An H200 may initially connect without returning its child list. After saving,
the setup page checks the integration status and child-device endpoint for up
to 30 seconds. Keep the page open while it reports that discovery is settling.
If no sensors appear, use **Check again**, confirm the children are paired and
named in the Tapo app, or open **Sensors** and refresh device discovery there.

The page sends the credentials to the local API over the current web origin and
then clears the secret field. The API never returns the saved values. It stores
them in `INTEGRATION_SECRETS_FILE`, outside SQLite, with owner-only file mode on
platforms that support it. The file is not application-level encrypted, so also
protect the host account, disk, backups, and Docker volume.

Administrators can instead use environment variables; they take precedence
over web-saved values after a restart:

```dotenv
TP_LINK_HOST=192.0.2.10
TP_LINK_USERNAME=user@example.com
TP_LINK_PASSWORD=replace-me
TP_LINK_POLL_INTERVAL_MS=2000
```

## 3. Discover and add sensors

After the bridge connects, open Stuga and
select **Sensors** in the sidebar. The page shows sanitized climate-child or
direct-energy-device details from the latest poll; credentials never reach the
browser.

Choose **Add sensor**, select an unmapped climate child or energy endpoint, then:

1. confirm or improve its friendly name and model;
2. select the Home, floor, and room;
3. set mounting height and place it on the floor plan; and
4. review and save.

The Home (`houseId` in the compatibility API), connection ID, and stable TP-Link device ID are stored on the Stuga
sensor in SQLite, so identical device identifiers on different home networks do
not collide.
The running bridge refreshes database mappings on each snapshot, so ingestion
starts without editing a file or restarting again. Names and locations can be
changed later from the same workspace without changing sensor history.

For diagnostics, inspect:

```text
GET  /api/v1/integrations/status?houseId=house-main
POST /api/v1/integrations/tp-link/test?houseId=house-main
GET  /api/v1/integrations/tp-link/devices?houseId=house-main
GET  /api/v1/integrations/tp-link/setup
```

`tpLink.connected` should be `true` and the mapped/discovered counts should be
non-zero. `hubModel` is `H100` or `H200` for a hub and `null` for a direct energy
endpoint. Climate readings and generic power/energy samples have
`source: "tp-link"`. The helper uses a fixed-rate schedule at
`TP_LINK_POLL_INTERVAL_MS` (two seconds by default). Temperature or humidity
changes are persisted immediately; otherwise an unchanged climate heartbeat is
persisted every minute to keep freshness explicit without writing an identical
row on every poll. SQLite is the crash-safe ingestion buffer, and the telemetry
archive worker copies both raw measurement samples and legacy climate readings
to TimescaleDB with durable checkpoints.

## Retained-history recovery

The durable gap coordinator checks source availability every 30 seconds and
scans the prior 30 days of stored samples every 15 minutes. When a direct
TP-Link gap closes, the owning connection first asks the same LAN device for
retained history:

- Stuga attempts to read up to 96 15-minute temperature or humidity buckets
  from an H100/H200 T310 or T315 child, representing approximately the latest
  day;
- a compatible energy device can return retained instantaneous `power` at a
  5-minute interval for a range up to 12 hours, or a 60-minute interval for a
  longer range, subject to the model and firmware's actual retention; and
- local interval energy is deliberately not mapped to the cumulative `energy`
  metric.

These history commands are reverse-engineered protocol capabilities, not a
public TP-Link contract. The pinned helper validates the requested connection,
device ID, metric, time range, units, and returned row count. Unsupported
firmware returns `not-supported`; a range extending beyond local retention or
containing missing buckets returns `partial`. Recovered rows are inserted
idempotently without live events or historical alert delivery.

Canary each hub model and firmware separately. An H100 fixture or live result
does not prove that the H200 child-command wrapper is identical, and a firmware
update can remove or reshape either retained-history command.

When the optional automated history stack is enabled, a partial local result
can fall through to the Tapo app export/mailbox queue. See
[Automated Tapo history recovery](tapo-history-automation.md) for Appium flow
capture, Gmail OAuth, worker leases, operator controls, and the experimental
endpoint boundary. A Home Assistant-mapped sensor instead uses Home Assistant
recorder history; Stuga does not merge the same physical sensor across both
adapters automatically.

Operators can inspect the persistent gap ledger and export-job ledger with:

```text
GET /api/v1/integrations/sensor-data-gaps?houseId=house-main
GET /api/v1/integrations/tp-link/history-export/jobs
```

To use a contact child for airflow, add or select its door, window, or vent in
the 2D or 3D Home editor. Under **Advanced**, choose **Tapo** as the
contact-state source and enter the stable child-device id returned by the
devices endpoint. Set the TP-Link connection id as well when the Home has more
than one hub connection; an unscoped contact binding is deliberately ignored
while multiple connections are configured. A fresh contact state overrides the configured
fallback; offline, missing, unknown, or stale state falls back safely. Contact
bindings are architectural opening bindings and do not require creating a
climate sensor record.

The same devices can be used through Home Assistant at the same time, and Stuga
can run both adapters. Map each physical device through only one adapter to
avoid duplicate history and alert evaluation.

## Optional legacy mapping file

Existing installations may continue to set `TP_LINK_DEVICE_MAP_FILE`. Copy
`config/tp-link.devices.example.json` to the untracked
`config/tp-link.devices.json` and map each stable child ID to a Stuga
sensor ID. The file is used as a bootstrap source alongside database bindings;
after validation, its canonical non-secret mapping set is stored with a verified
hash and revision in core SQLite. Manager startup performs this import even when
credentials are absent or only Home-scoped connections exist. An existing file
is an explicit repair/update; semantic reordering is a no-op. If the file is
later absent, the legacy environment-backed bridge uses the last verified
SQLite copy, so the file is no longer a recovery dependency. Source paths,
credentials, and unknown fields are not copied. Unknown sensor references remain
in the stored aggregate for recovery but are skipped with a status diagnostic,
without blocking valid legacy or database-bound devices. A device binding saved
on a Stuga sensor still takes precedence over this compatibility map. Set
`"devices": []` to explicitly clear the compatibility set. Direct energy
devices use the same stable-device-ID mapping shape.

## Demo-data boundary

Saving TP-Link credentials permanently switches the current SQLite database to
real-data mode before polling begins. Existing mock/replay samples, synthetic
outdoor boundaries, and potentially mock-derived alerts are purged; mock ticks
and later demo ingestion then return HTTP 409. This latch remains active if the
credentials are removed. Use a separate database for demonstrations.

## Troubleshooting

- Confirm the API host/container can route to the configured device's reserved IPv4 address.
- Discovery broadcasts and mDNS often do not cross guest Wi-Fi, VLAN, or Docker
  bridge boundaries. Use the manual address field; this does not prevent normal
  polling when the hub is routable.
- On a multi-interface host, Stuga scans each active IPv4 subnet using its
  directed broadcast address. To restrict a local development scan, set a
  comma-separated override such as
  `TP_LINK_DISCOVERY_TARGETS=192.168.71.255` before starting the API.
- Confirm `python --version` is 3.11 or newer and `python-kasa` is installed.
- Re-run the helper with `--list` after firmware changes or re-pairing.
- Treat an offline mapped child as a radio/power issue; cached hub values are
  not ingested while the child reports offline.
- Do not expect local climate recovery to recreate the original two-second
  stream. The retained response is a 15-minute bucket series and normally covers
  only approximately the latest day.
- A local `partial` or `not-supported` result is not proof that the Tapo cloud
  has the missing rows. TP-Link states that hub power/internet outages can lose
  history before upload and that a hub restart can delete unuploaded history;
  see its [missing-history FAQ](https://www.tp-link.com/us/support/faq/3450/).
- If a direct Tapo device reports power but no energy, inspect python-kasa's
  `Module.Energy.consumption_total`. Stuga deliberately does not substitute
  `consumption_today` or `consumption_this_month` because those counters reset.
- Some firmware changes can alter the local protocol. Check the current
  python-kasa supported-device fixtures before upgrading a production hub.
