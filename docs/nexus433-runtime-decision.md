# Nexus433 runtime decision

Status: accepted and implemented
Decision date: 2026-07-31
Target: Stugu Raspberry Pi 4 appliance on Debian Trixie

## Decision

Run Nexus decoding in a separate, optional `open-stuga-nexus433` container and
Mosquitto in a separate, reusable, optional `open-stuga-mqtt` container. Both
are multi-architecture Stugu release images pinned by digest. Compose profiles
keep them disabled and absent from ordinary startup.

Do not embed Nexus433, an MQTT client connection, or GPIO access in the API
runtime. The MQTT package is dynamically imported only when the host advertises
the capability and a Home has enabled it. Host changes use an allow-listed
update-agent operation; the API has neither a Docker socket nor a configurable
device-path command.

## Selected upstream

The decoder is canonical `aquaticus/nexus433` commit
`eb5f8bd87cc77ce89074d9144af19a5b2b9cc175`, identified in Stugu as
`v2.0.0-stugu-eb5f8bd`.

- Archive SHA-256:
  `6f88074428738e4ffbdfa880bde84e4eada5a14a308c3f25cd52643ac445fcf8`
- The build applies four reviewable patches: missing C++ integer headers,
  libgpiod v2/event-mode compatibility, reproducible version injection, and
  stable unsigned receiver-topic formatting.
- `liljestk/rpi-temp` adds deployment and storage around Nexus433 but no decoder
  behavior Stugu needs, so none of that wrapper is used.

## Isolation

- `nexus433` is unprivileged, read-only, capability-free, and receives only the
  configured gpiochip.
- `mqtt` is unprivileged, read-only, non-persistent, packet/queue bounded, and
  has no host listener.
- Separate publish and subscribe credentials enforce topic ACLs.
- Only the host agent may change the two Compose profiles, and its request
  schema accepts only adapter `nexus433` and a boolean enabled state.
- The static appliance capability descriptor fixes `/dev/gpiochip0`, line 17.
- Unsupported hosts use an empty capability descriptor.

## Release and rollback contract

The release contract contains seven digest-pinned images: API, web, backup,
Tapo export runner, update agent, MQTT, and Nexus433. Its compatibility values
are release-environment schema 3, updater contract 3, and Compose contract 2.
Versioned `release-v3.env` and `known-good-v3.env` files prevent an older OS
slot from interpreting the seven-image contract as the prior five-image one.

Older immutable appliance contracts fail closed with **Factory upgrade
required**. The supported transition is a verified backup followed by the new
factory image and restore, or the existing health-gated live migration. The API
does not mutate Compose or reinterpret an incompatible release.

## GPL distribution boundary

The Nexus433 container is GPL-3.0-only. The Stugu API and web applications do
not contain or link its code; they exchange MQTT protocol messages with a
separate process. The Nexus image carries its source/rebuild inputs, and the
release publisher independently creates and validates the matching source
archive before any container publication. That archive is attached with its
SHA-256 checksum and excludes Stugu application source.

No manual confirmation flag can bypass source creation. This packaging is
designed to satisfy distribution obligations for the Nexus component without
changing Stugu's source-distribution model; final legal conclusions remain
fact-specific.

## Verification record

Completed automated/build evidence on 2026-07-31 includes amd64 and arm64
decoder/broker builds, fake-transmitter delivery through generated credentials
and private MQTT ACLs, source/archive/hash inspection, deterministic source
bundle reproduction, optional Compose graph proof, host-agent enable/disable
and rollback behavior, API ingestion/identity tests, UI workflows, and the
seven-image update/release contract tests.

The user's installed receiver is an RXB6 already operating with Nexus433 on
`/dev/gpiochip0`, BCM GPIO 17 in the legacy deployment. The new image has not
yet been exercised against that physical wiring because the appliance SSH host
key changed; no host-key bypass is part of this decision.
