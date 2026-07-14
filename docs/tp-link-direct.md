# Direct TP-Link H100/H200 setup

Stuga can poll Tapo T310 and T315 child sensors straight from an H100 or
H200 hub on the local LAN. Home Assistant is optional. The adapter uses the
community-maintained [python-kasa](https://github.com/python-kasa/python-kasa)
library, whose supported-device matrix includes H100, H200, T310, and T315.

The Tapo app is still used to commission the hub, pair child sensors, update
firmware, and give devices useful names. Reserve a stable LAN address for the
hub before configuring Stuga.

## 1. Install the helper dependency

Docker images built from this repository already contain Python and the pinned
dependency. For a local Node.js development run, use Python 3.11 or newer:

```powershell
python -m pip install -r apps/api/python/requirements.txt
```

On a system where the executable is named `python3`, either use that command or
set `TP_LINK_PYTHON=python3`.

## 2. Find the hub and save credentials

Use the TP-Link account email and password that can authenticate to the hub.
Open **Set up** and select **Find devices**. Choose the H100/H200 result, or enter
its reserved IP address manually if discovery is blocked by Wi-Fi isolation,
VLANs, or Docker networking. Enter the same account used by the Tapo app and
select **Save and connect**.

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
TP_LINK_POLL_INTERVAL_MS=10000
```

## 3. Discover and add sensors

After the bridge connects, open Stuga and
select **Sensors** in the sidebar. The page shows sanitized child-device details
from the latest local hub poll; credentials never reach the browser.

Choose **Add sensor**, select an unmapped T310/T315, then:

1. confirm or improve its friendly name and model;
2. select the house, floor, and room;
3. set mounting height and place it on the floor plan; and
4. review and save.

The stable TP-Link child ID is stored on the Stuga sensor in SQLite.
The running bridge refreshes database mappings on each snapshot, so ingestion
starts without editing a file or restarting again. Names and locations can be
changed later from the same workspace without changing sensor history.

For diagnostics, inspect:

```text
GET  /api/v1/integrations/status
POST /api/v1/integrations/tp-link/test
GET  /api/v1/integrations/tp-link/devices
GET  /api/v1/integrations/tp-link/setup
```

`tpLink.connected` should be `true`, `hubModel` should be `H100` or `H200`, and
the mapped/discovered counts should be non-zero. New readings have
`source: "tp-link"`. The helper polls at `TP_LINK_POLL_INTERVAL_MS`; unchanged
values are persisted at least every five minutes to keep freshness explicit
without writing an identical row on every poll.

The hub and its children can be used through Home Assistant at the same time,
and Stuga can run both adapters. Map each physical child through only one
adapter to avoid duplicate history and alert evaluation.

## Optional legacy mapping file

Existing installations may continue to set `TP_LINK_DEVICE_MAP_FILE`. Copy
`config/tp-link.devices.example.json` to the untracked
`config/tp-link.devices.json` and map each stable child ID to a Stuga
sensor ID. The file is used as a bootstrap source alongside database bindings;
it is no longer required for discovery or new onboarding.

## Demo-data boundary

Saving TP-Link credentials permanently switches the current SQLite database to
real-data mode before polling begins. Existing mock/replay samples, synthetic
outdoor boundaries, and potentially mock-derived alerts are purged; mock ticks
and later demo ingestion then return HTTP 409. This latch remains active if the
credentials are removed. Use a separate database for demonstrations.

## Troubleshooting

- Confirm the API host/container can route to the hub's reserved IPv4 address.
- Discovery broadcasts and mDNS often do not cross guest Wi-Fi, VLAN, or Docker
  bridge boundaries. Use the manual address field; this does not prevent normal
  polling when the hub is routable.
- Confirm `python --version` is 3.11 or newer and `python-kasa` is installed.
- Re-run the helper with `--list` after firmware changes or re-pairing.
- Treat an offline mapped child as a radio/power issue; cached hub values are
  not ingested while the child reports offline.
- Some firmware changes can alter the local protocol. Check the current
  python-kasa supported-device fixtures before upgrading a production hub.
