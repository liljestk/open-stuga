# Direct Gree/Wilfa heat pumps

Stugu can discover and monitor compatible Gree-protocol air-source heat pumps,
including Wilfa models that use the same local protocol. Home Assistant is not
required, and the Raspberry Pi can run the helper inside the existing Stugu API
container.

This first phase is deliberately read-only. Stugu records:

- power and selected operating mode;
- selected temperature;
- the indoor temperature only when the unit actually reports it;
- fan, swing, quiet, turbo, and X-Fan state when available; and
- connection health and timestamped state history.

The protocol does not provide dependable compressor activity. Stugu therefore
keeps **Selected mode** separate from **Actual activity**. A unit set to cooling
is shown as “Cooling selected,” not “Actively cooling.”

## Set up

1. Commission the heat pump with the manufacturer's compatible app first and
   leave its Wi-Fi enabled.
2. Put the heat pump and Stugu appliance on the same trusted LAN. Guest-network
   isolation and many VLANs block local discovery.
3. In Stugu, select the owning Home and open **Set up**. Discovery starts in the
   background when the connections area opens.
4. If the unit is found, choose **Add to _Home_**. Adding is always explicit;
   discovery alone never binds the unit or changes real-data mode.

The Gree/Wilfa section is not rendered when no compatible unit is discovered
or configured. A failed background scan is also kept quiet unless an existing
Gree connection needs attention.

Binding creates a Property inventory record for the heat pump and associates
it with the selected Home. Disconnecting removes the private protocol key and
stops polling, while retaining the inventory record and recorded history.

## Network and Raspberry Pi

Discovery and polling use the local Gree UDP protocol, normally on port 7000.
Do not forward this port from the internet. The heat pump and Stugu should use a
trusted local network; a DHCP reservation is helpful but not mandatory because
Stugu can recover an address change using the unit's stable MAC identity.

Stugu also tries common `/24` broadcasts inferred from configured local
TP-Link or Home Assistant IPv4 addresses. Docker or VM NAT may still hide the
physical LAN, especially with another subnet size or no existing integration.
Set the directed broadcast address when discovery does not find the unit:

```dotenv
GREE_DISCOVERY_TARGETS=192.168.1.255
```

Multiple targets can be comma-separated. `GREE_POLL_INTERVAL_MS` defaults to
60 seconds, which is intentionally light enough for the same Raspberry Pi 4
that runs Stugu. Each configured unit uses one small Python helper process.

The production image already includes the pinned Python dependency. For a
local development run:

```powershell
python -m pip install -r apps/api/python/requirements.txt
```

Set `GREE_PYTHON=python3` only when Python is not available under the default
executable name.

## Data and security

The one-time local binding key is write-only: it is accepted from the isolated
helper, saved in Stugu's protected integration-secrets file, and never returned
by the API or written to SQLite. Helper library logging is restricted because
some versions log binding details at informational level.

Every successful poll is a timestamped observation, including polls whose
values are unchanged. Stugu first commits the complete typed observation to its
crash-safe SQLite archive journal and updates the current projection. The
checkpointed archive worker then stores it automatically in the dedicated
TimescaleDB heat-pump hypertable. UI events remain change-only, so this
time-series capture does not create repeated visual updates.

If TimeDB is unavailable, polling continues into the local journal.
Reconciliation replays those observations after recovery, and SQLite rows are
pruned only after the corresponding TimeDB checkpoint is durable. The history
API merges permanent TimeDB history with the current local tail and fails
closed rather than returning an incomplete retained range. If the unit omits
indoor temperature, Stugu stores no value; it never substitutes the selected
target temperature.

Useful compatibility API routes are:

```text
POST   /api/v1/integrations/gree/discover
PUT    /api/v1/integrations/gree/config
DELETE /api/v1/integrations/gree/config/{connectionId}
GET    /api/v1/heat-pumps?houseId={homeId}
GET    /api/v1/heat-pumps/{connectionId}/history
```

There are no control routes in this phase. Continue to change mode, target
temperature, schedules, and safety settings with the physical remote or the
manufacturer's app.

## Troubleshooting

- Confirm the heat pump is online in its app before opening Stugu setup.
- Keep the Pi and heat pump on the same IPv4 LAN without wireless client
  isolation.
- Add the LAN's directed broadcast to `GREE_DISCOVERY_TARGETS` when Stugu runs
  through Docker/VM NAT.
- Allow outbound and return UDP traffic between Stugu and the unit on port
  7000; do not expose it publicly.
- If a configured unit becomes unavailable, leave it configured while checking
  Wi-Fi. Stugu retries and searches for the same MAC at a new address.

Compatibility is provided by the pinned
[`greeclimate`](https://github.com/cmroche/greeclimate) library, licensed under
GPL-3.0. Gree's protocol and firmware are not a stable public compatibility
contract, so validate polling again after heat-pump firmware upgrades.
