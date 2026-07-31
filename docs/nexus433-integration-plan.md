# Nexus433 integration

Status: implemented for the Stugu Raspberry Pi appliance
Decision date: 2026-07-31
Scope: receive Nexus-compatible 433 MHz temperature/humidity senders through an RXB6-class GPIO receiver

## Outcome

Stugu receives Nexus 36-bit temperature/humidity packets, discovers unassigned
senders, and binds a sender to a stable Stugu Sensor. If a transmitter changes
its radio ID after a battery replacement, an Owner or Admin explicitly selects
the replacement sender for the existing Sensor. Its UUID, placement, alert
rules, and measurement history remain unchanged.

The integration is Nexus-only. It does not claim generic 433 MHz support and it
does not import the `liljestk/rpi-temp` listener, database, dashboards, or ID
renamer.

## Runtime architecture

The implementation uses canonical `aquaticus/nexus433` in a separate optional
container, a separate optional Mosquitto container, a lazy MQTT transport in
the API, and the existing Stugu telemetry path:

```text
RXB6 on GPIO 17
  -> optional nexus433 container
  -> optional private MQTT broker
  -> MqttSourceTransport
  -> strict Nexus parser and binding store
  -> TelemetryService
  -> Reading + paired measurement samples + alert work + SSE
```

The decoder and broker are controlled by independent Compose profiles. They are
absent from the default service graph and image-pull path. The API receives no
GPIO device and no Docker socket. A constrained host-agent request can only
start or stop the exact `source-ingress-secrets`, `mqtt`, and `nexus433`
services.

On an unsupported or disabled installation the API does not construct an MQTT
transport, open a socket, or schedule a receiver retry timer. The setup and
sender panels remain absent. The small shared source-ingress interfaces stay
available for another isolated source without coupling its identity or UI to
Nexus.

## Hardware and transport boundary

The supported appliance descriptor fixes the audited hardware values to
`/dev/gpiochip0`, GPIO 17. Arbitrary device paths are not accepted through the
API. Only the decoder container receives that gpiochip, its runtime is
unprivileged and read-only, and all Linux capabilities are dropped.

Mosquitto has no host-published port. It uses a private internal network,
anonymous access is disabled, and a networkless one-shot initializer creates
separate persistent credentials. Nexus433 can only publish `nexus433/#`; the
API can only subscribe to it.

## Identity and battery replacement

The Stugu Sensor UUID is authoritative. Radio identity is a binding made from
the receiver gateway, sender ID, and Nexus channel. MQTT topic labels and the
decoder's MAC-like receiver label are transport metadata, not Sensor identity.

Unknown radio identities create bounded, six-hour discovery candidates only.
They create no Sensor, Reading, measurement sample, alert, or action. At most
16 new identities are admitted per minute and at most 128 are retained per
gateway. Candidate and binding APIs require Owner/Admin access and local Home
authority.

Initial assignment attaches a candidate to an enabled Sensor with no existing
direct TP-Link binding. Reconnection is explicit and revision-checked: one
transaction retires the old binding and creates the new one against the same
Sensor. Active sender collisions and concurrent stale revisions fail with a
conflict instead of silently changing attribution.

One physical receiver can be enabled for only one Home. A request from another
Home cannot stop or take over the active receiver.

## Input and measurement semantics

Radio and MQTT data are untrusted. The parser accepts only the pinned decoder's
exact state and connection topics, a payload of at most 2,048 bytes, and an
exact JSON object containing bounded finite temperature, integer humidity,
`ok|low` battery state, and integer frame quality. Retained state packets are
never ingested; retained connection packets affect health only.

Identical packets and excessive bursts are suppressed for ten seconds. A jump
greater than 10 °C or 25 humidity points within 120 seconds is quarantined
until a second packet agrees within 1 °C and 3 humidity points within 180
seconds. Receipt time is authoritative because Nexus packets have no clock.

An accepted packet commits its legacy Reading, paired temperature/humidity
measurement samples, and alert queue work in one SQLite transaction. SSE is
published only after commit. Numeric battery percentage remains `null` because
the protocol reports only normal/low; battery state and frame quality are
binding health metadata.

While a Nexus binding is healthy and has an accepted packet no older than 240
seconds, it is the direct source and mapped Home Assistant live values are
suppressed. Home Assistant becomes the fallback immediately when the broker,
receiver, or sender is known offline, or after the freshness window. Historical
points are never rewritten.

Nexus radio has no authentication or checksum. These controls reduce accidental
corruption; they cannot prove that a packet using an active ID/channel came
from the intended physical sender. Nexus data must not be the sole basis for a
safety- or security-critical decision.

## Product surfaces

Supported Owners/Admins see the receiver in the existing Home connection setup.
They can start or stop it, inspect listening/error state, and open the existing
Sensors workspace. The Sensors workspace shows bound senders, signal/battery
health, newly discovered senders, attachment to an existing Sensor, and the
explicit reconnect action used after an ID change. English, Swedish, and
Finnish copy uses the established Home and Sensor wording and responsive panel
styles.

## Verification

Automated verification covers strict parsing, retained-state rejection,
unknown-sender isolation, discovery limits/expiry, binding conflicts, stable
Sensor history across ID replacement, deduplication, anomaly quarantine,
transactional telemetry and post-commit events, direct-source freshness,
disabled transport construction, exact host-agent operations, optional Compose
graphs, credential/ACL boundaries, deterministic source packaging, release
contracts, rollback metadata, UI visibility, enablement, and reconnection.

The canonical production/fake decoder and broker images have been built for
amd64 and arm64, and the fake decoder has completed the private MQTT path. A
real Pi/RXB6 activation is deployment verification of wiring, RF conditions,
and measured resource use; it is not represented here as completed hardware
evidence.

## Licensing

Nexus433 and Stugu remain separately packaged programs communicating only by
MQTT. The optional Nexus image is labelled GPL-3.0-only and carries the pinned
upstream archive, all patches, build Dockerfile, runtime entrypoint, upstream
license, and Stugu notice. Every release also builds, verifies, and attaches a
deterministic corresponding-source archive before publishing containers.

The corresponding-source archive deliberately contains the Nexus component's
source and rebuild inputs, not the Stugu API, web application, or packages.
Stugu remains under its own license. This describes the distribution design;
it is not legal advice.
