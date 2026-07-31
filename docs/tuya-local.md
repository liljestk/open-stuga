# Local Tuya Wi-Fi devices

Stugu supports selected Tuya-compatible Wi-Fi lamps, outlets, and switches
through a direct LAN connection. Home Assistant is not required at runtime.

This is intentionally different from Home Assistant's official Tuya
integration. The official integration is classified as **Cloud Push** and
requires a Tuya Smart or Smart Life account plus QR authorization. Stugu uses
the device's encrypted LAN protocol after onboarding instead:

```text
Tuya Smart / Smart Life — initial Wi-Fi pairing and local-key acquisition
                         ↓
Stugu API — protected Home-scoped credential
                         ↓
Tuya device — direct TCP 6668 polling and control on the trusted LAN
```

See the current [Home Assistant Tuya integration](https://www.home-assistant.io/integrations/tuya/)
and [TinyTuya package documentation](https://pypi.org/project/tinytuya/) when
comparing the two paths.

## Setup

1. Power the device and pair it to the 2.4 GHz Wi-Fi network with Tuya Smart
   or Smart Life. The app and its account are normally required for this first
   activation.
2. Keep the device and Stugu on the same trusted IPv4 LAN. Guest isolation and
   many VLAN policies block Tuya discovery and control.
3. Obtain the device ID and local key. LAN discovery can reveal the address and
   protocol version, but not the encrypted local key.
   TinyTuya's setup wizard can retrieve the key through a temporary Tuya IoT
   authorization. Treat its generated device file as a secret and remove it
   after import.
4. Open the owning Home in **Set up → Connections → Tuya Wi-Fi**. Tuya is not
   included in Stugu's normal network search. Enter the device ID and local key,
   then select **Enable discovery and find device**. Stugu returns only that
   matching device and verifies it locally before filling in its address and
   protocol version. If UDP discovery is blocked, enter those two network
   details manually instead.
5. Optionally name and place the verified device, then select **Verify and
   add**. The local key is not saved until this step succeeds.
6. Open the Home's live view. The **Lights and switches** layer shows the
   device in both 2D and 3D. Use **Layout** to drag it or move it with the
   arrow keys.

Stugu does not save a Tuya cloud token or account password. A reset, removal,
or re-pair can rotate the local key; verify and add the device again if that
happens.

## Supported profiles

Stugu accepts only datapoint layouts it can identify safely:

| Profile | State and controls | Energy |
| --- | --- | --- |
| DP 20 colour/CCT lamp | Power, brightness, white temperature, HSV colour | None unless the physical model exposes a separately supported meter |
| DP 1 switch | Power | None |
| DP 1 outlet with DP 18/19/20 meter | Power, current, measured watts, voltage | Measured watts enter the normal Energy path |

Unknown layouts are rejected before a credential is saved. Commands are
absolute, bounded values rather than relative toggles, and Stugu displays a
change only after the device confirms its new state.

Metering follows the same rule as every other Energy source:

- measured power is ingested as canonical watts;
- cumulative energy is stored only if a verified profile actually reports it;
- ordinary lamp consumption is never estimated from rated wattage;
- the normal Energy summary may integrate sufficiently covered measured-power
  samples when no cumulative meter is available.

## Runtime and recovery

Each configured device has one supervised helper process. It maintains a
persistent encrypted connection, serializes polling and commands, bounds the
command queue, and restarts with capped backoff. After repeated failures it
marks the device unavailable without changing the last confirmed power state.

When the saved address stops responding, Stugu checks the local `/24` for the
same authenticated device and persists a recovered address. A DHCP reservation
is still recommended.

`TUYA_POLL_INTERVAL_MS` defaults to five seconds and is bounded from two
seconds to fifteen minutes. This gives responsive lamps without busy polling.
Set `TUYA_PYTHON` only when the shared Python executable is unsuitable. The
production image includes the pinned TinyTuya dependency.

## Security

- The browser sends the local key over the authenticated Stugu session for the
  opt-in scan and final add. The scan does not persist it.
- The key and raw Tuya device ID live only in the protected integration-secrets
  file; normal state, map, event, and command responses omit both.
- SQLite retains provider-neutral current state, placement, equipment identity,
  and an idempotent command journal.
- Owner or local Administrator authority is required to add, move, control, or
  disconnect a device. Guests remain read-only.
- Replay never shows current device state as if it were historical.
- Do not forward UDP 6666/6667/7000 or TCP 6668 from the internet.

## API

```text
POST   /api/v1/integrations/tuya/discover
PUT    /api/v1/integrations/tuya/config
DELETE /api/v1/integrations/tuya/config/{connectionId}
GET    /api/v1/connected-devices?houseId={homeId}
PATCH  /api/v1/connected-devices/{connectionId}/placement
POST   /api/v1/connected-devices/{connectionId}/commands
```

The discovery request requires `houseId`, `deviceId`, and `localKey`. It scans
only after this explicit request, filters the result to that device ID, verifies
the local credential, and returns no secret material.

Every command requires a client-generated UUID `operationId`. Retrying the
same operation returns the confirmed result; reusing its UUID for a different
command is rejected.

## Troubleshooting

- If discovery is empty, confirm power, 2.4 GHz Wi-Fi, the same IPv4 LAN, and
  firewall access to UDP 6666/6667/7000 and TCP 6668.
- If verification reports a key/version problem, check that the key belongs to
  this exact device and was obtained after its most recent pairing.
- If a device is online in the Tuya app but absent locally, disable wireless
  client isolation and confirm that its firmware exposes LAN control.
- If an existing device is unavailable, leave it configured while checking
  power and Wi-Fi. The supervisor keeps retrying and preserves the last
  confirmed state.

Tuya firmware and datapoint layouts are not a stable public compatibility
contract. Re-run verification after firmware changes, and add new profiles only
with captured read/write tests for the exact layout.
