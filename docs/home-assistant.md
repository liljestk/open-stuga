# TP-Link H200 and Home Assistant setup

Climate Twin's recommended physical-data path is:

```text
Tapo T310/T315 sensors -> Tapo H200 -> official Home Assistant
TP-Link Smart Home integration -> Climate Twin
```

The T310/T315 path supplies temperature and humidity. Climate Twin can map CO2
and other numeric entities from additional Home Assistant devices to the same
placed sensor or to their own sensor locations. Each mapped measurement is
stored independently; it does not need to arrive at the same time as the Tapo
entities.

This is the current official Home Assistant path. Do not install a custom Tapo
integration just for these devices. Home Assistant lists H200, T310, and T315 as
supported by its built-in
[TP-Link Smart Home integration](https://www.home-assistant.io/integrations/tplink/).
It polls the hub locally over the LAN every five seconds. Tapo credentials may be
needed to authenticate local access, but normal telemetry does not traverse the
TP-Link cloud.

These instructions and supported-device claims were checked on 2026-07-14.
Firmware and Home Assistant support change, so recheck the official page after
upgrading either one.

## 1. Commission the hub and sensors

1. Put the H200 and Home Assistant on a network where they can reach each other.
   Ethernet is preferable for the hub when available.
2. Add the H200 to the Tapo mobile app and apply appropriate stable firmware.
3. Pair each T310/T315 to the H200 in the Tapo app. TP-Link's current
   [hub pairing guide](https://www.tp-link.com/us/support/faq/3118/) covers these
   models. Give each child device a unique physical name.
4. Place a temporary label on each sensor with its intended Climate Twin ID,
   `sensor-01` through `sensor-10`. This prevents entity-to-room swaps during
   installation.
5. Wait for all three readings (temperature, humidity, and battery, if exposed)
   to update in the Tapo app before moving to Home Assistant.

Avoid locating the hub inside a metal cabinet. Test every final sensor position
before permanently mounting it. A wall/floor plan coordinate can be changed
later without changing the sensor ID or losing history.

## 2. Add the official integration to Home Assistant

1. In Home Assistant open **Settings -> Devices & services**.
2. If **TP-Link Smart Home** was discovered, select **Configure**. Otherwise use
   **Add integration**, choose **TP-Link Smart Home**, and follow the dialog.
3. Enter the H200 host/IP if discovery did not find it. For Tapo devices, provide
   the case-sensitive TP-Link account email and password when requested.
4. Open the integration's H200 device and confirm its T310/T315 child devices and
   temperature/humidity entities are present.
5. Create a DHCP reservation for the H200 so its address remains stable.

The official integration notes two relevant network behaviours:

- discovery does not work across subnets; add the hub by IP and allow local
  traffic if Home Assistant and the H200 are separated by VLANs;
- some firmware requires **Third-Party Compatibility** in the vendor app. Only
  enable this if the option exists and authentication fails; follow the exact
  troubleshooting steps on the official integration page.

Do not expose the H200, Home Assistant, or Climate Twin API directly to the
internet. Permit only the necessary local connections through VLAN/firewall
rules.

## 3. Record the exact entity IDs

Friendly names are not stable identifiers. In Home Assistant use **Settings ->
Devices & services -> Entities**, filter to the TP-Link integration or H200, and
copy each exact `entity_id`. Depending on names and firmware, examples may look
like:

```text
sensor.living_room_window_temperature
sensor.living_room_window_humidity
sensor.living_room_window_battery
sensor.living_room_co2
```

Confirm the entity's unit and device class. Every measurement must have a finite
numeric state. Temperature should use a temperature device class, humidity a
relative-humidity device class, CO2 a carbon-dioxide concentration entity, and
battery a percentage entity. Climate Twin maps by entity ID; it does not guess
by friendly name.

The bridge reads Home Assistant's `unit_of_measurement` attribute. Temperature
in Fahrenheit or Kelvin is normalized to canonical Celsius. CO2 is stored in
ppm; ppb can be converted to ppm, but a mass concentration such as mg/m³ is not
converted because that requires environmental and substance assumptions. Other
custom metric units must exactly match their registry definition unless the map
contains an explicit linear conversion. Unsupported units and non-finite values
are rejected. Still confirm each entity's device class and unit in **Developer
tools -> States** so mapping mistakes are visible before enabling automations.
Current mapped states are fetched at startup and after reconnect; historical
events missed during an outage are not backfilled.

## 4. Create the Climate Twin entity map

Copy the example and replace every placeholder with the IDs from your instance:

```powershell
Copy-Item config/home-assistant.entities.example.json config/home-assistant.entities.json
```

On macOS/Linux:

```sh
cp config/home-assistant.entities.example.json config/home-assistant.entities.json
```

The map supports legacy climate keys and a generic `measurements` object:

```json
{
  "entities": [
    {
      "sensorId": "sensor-01",
      "temperature": "sensor.living_room_window_temperature",
      "humidity": "sensor.living_room_window_humidity",
      "battery": "sensor.living_room_window_battery",
      "measurements": {
        "co2": "sensor.living_room_co2",
        "voc_index": {
          "entityId": "sensor.living_room_voc_index",
          "unit": "index"
        }
      }
    }
  ]
}
```

`sensorId` is required; all entity bindings are optional, but a row must contain
at least one. The legacy `temperature`, `humidity`, and `battery` keys keep
existing setups working. Keys in `measurements` are stable measurement IDs from
`GET /api/v2/measurement-definitions`. Temperature bindings normalize
Fahrenheit/Kelvin to Celsius. Every other generic string binding requires Home
Assistant's unit to exactly match the registry's canonical unit. The object
form may declare the expected source `unit` and an explicit
`scale`/`offset`, calculated as
`canonical = raw * scale + offset`; do not use it for a physical conversion
whose assumptions are unknown. Each entity ID should occur in only one mapping.
The complete ten-sensor template is
[the example map](../config/home-assistant.entities.example.json).
Register `voc_index` (or any other custom ID) before using that example binding;
omit bindings for definitions that do not exist.

For example, a Home Assistant CO2 entity expressed in ppb maps to the built-in
ppm definition as:

```json
{
  "co2": {
    "entityId": "sensor.living_room_co2_ppb",
    "unit": "ppb",
    "scale": 0.001,
    "offset": 0
  }
}
```

Do not map categorical states such as `open`, `closed`, `high`, or `unknown` as
measurements. Store those through a dedicated context adapter/parameter or add a
future typed domain model instead of assigning arbitrary numbers.

Validate the file before starting:

```powershell
Get-Content config/home-assistant.entities.json -Raw | ConvertFrom-Json | Out-Null
```

Or, where `jq` is available:

```sh
jq empty config/home-assistant.entities.json
```

## 5. Create a Home Assistant token

Climate Twin uses Home Assistant's authenticated WebSocket API and subscribes to
`state_changed` events for mapped entities.

1. Create a dedicated, non-administrator Home Assistant user for the bridge when
   your access policy permits it.
2. Sign in as that user, open its profile, and create a **Long-Lived Access
   Token** named `Climate Twin`.
3. Copy it immediately into `HA_TOKEN` in your private `.env`; Home Assistant
   does not display it again.

Home Assistant documents long-lived tokens as valid for up to ten years. Treat
one like a password: never commit it, paste it into the entity-map JSON, include
it in a support bundle, or send it to the browser. Rotation means creating a new
token, updating `.env`, restarting Climate Twin, and deleting the old token.

Relevant environment values for a local run are:

```dotenv
HA_URL=http://homeassistant.local:8123
HA_TOKEN=replace-with-your-private-token
HA_ENTITY_MAP_FILE=./config/home-assistant.entities.json
```

For Docker, prefer Home Assistant's LAN IP because `.local` multicast DNS is not
reliably available inside every Docker network:

```dotenv
HA_URL=http://192.168.1.20:8123
HA_TOKEN=replace-with-your-private-token
HA_ENTITY_MAP_FILE=/app/config/home-assistant.entities.json
```

The Compose file sets the container path automatically; the last line is only
needed when overriding the Compose environment.

See Home Assistant's official [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
and [authentication API](https://developers.home-assistant.io/docs/auth_api/) for
the protocol and token lifecycle.

## 6. Verify ingestion

Start Climate Twin, then:

1. Open `GET /api/v1/integrations/status` or the integration status in the web
   app and confirm Home Assistant is configured and connected.
2. Warm one sensor briefly without covering its ventilation openings.
3. Within the upstream sampling/polling delay, confirm its Home Assistant state
   changes and the matching Climate Twin tile updates.
4. Query v2 history for each mapped metric and confirm a `home-assistant` sample
   was persisted with the entity's `last_updated` timestamp and expected unit.
5. Check every sensor against its physical label before removing mock mode.

Home Assistant updates the TP-Link integration on a five-second polling cycle,
so a state change is not expected to appear instantly. Climate Twin streams the
event after Home Assistant publishes it.

For every mapped sensor, the bridge requests Home Assistant's current states at
connect/reconnect. Generic measurements are accepted independently, so a CO2
sample does not wait for or re-timestamp temperature/humidity. Legacy climate
keys continue to provide paired v1 readings once both numeric temperature and
humidity values are available. Battery-only changes update the cache but do not
create duplicate climate readings.

## Troubleshooting

**Integration is not discovered**

- Add the H200 by stable LAN IP.
- Confirm Home Assistant can route to the hub and that VLAN rules allow it.
- Do not expect multicast discovery to cross subnets.

**Home Assistant reports authentication or communication errors**

- Verify the TP-Link email's exact case and password.
- Check the official integration's Third-Party Compatibility guidance.
- Remove/disable custom integrations that are also trying to control the device.
- Follow the official page's debug-logging procedure, then disable debug logging
  afterward because it is verbose and may contain sensitive context.

**Home Assistant values update but Climate Twin does not**

- Verify `HA_URL` is reachable from the API container, not just from the host.
- Verify the token belongs to an active user and has not been deleted.
- Compare each map value to the exact entity ID; JSON is case-sensitive.
- Check the integration status error and API logs. Never post the token in an
  issue or log excerpt.

**Only one of temperature/humidity changes**

Climate Twin retains the latest complementary value until its entity next
changes. At startup/reconnect it first refreshes all mapped current states, then
subscribes to live state events. Because the entities are independently updated,
the paired record is not guaranteed to be an atomic sample.

Use `/api/v2/measurements/history` when the individual entity timestamp matters;
its normalized temperature and humidity samples remain independent. The paired
record exists only for v1 compatibility.

**A CO2 or custom measurement is rejected**

- Confirm the metric exists, is enabled, and its ID exactly matches the key in
  `measurements`.
- Compare Home Assistant's `unit_of_measurement` with the definition's canonical
  unit. Use only a documented explicit linear conversion when they differ.
- ppm and ppb are supported for CO2; do not assume mg/m³ is interchangeable with
  ppm.
- States such as `unknown` and `unavailable` are ignored until a finite numeric
  state arrives.

**A newly created sensor never receives its first Home Assistant value**

For legacy climate readings, confirm both mapped temperature and humidity
entities currently have numeric states. For a generic metric, only that mapped
entity needs a valid numeric state. In both cases confirm the Climate Twin
sensor ID exists/enabled and the entity map is mounted at the configured path.
Restart the bridge after changing the map so its initial-state request includes
the new mapping.

**Entity IDs changed after renaming in Home Assistant**

Update the map explicitly and restart Climate Twin. Preserve the Climate Twin
`sensorId`; changing that ID creates a different history identity.
