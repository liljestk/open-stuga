# Raspberry Pi 4 appliance

This installation turns a Raspberry Pi 4 and USB SSD/HDD into a Stuga
appliance. You write the disk once. Later releases are installed into the
inactive operating-system slot and Raspberry Pi Connect switches slots on
reboot. Stuga's databases, generated secrets, Docker state, configuration, and
backups remain on the shared persistent partition.

The release is immutable: do not use `apt upgrade` on the appliance. Package,
kernel, firmware, configuration, and application updates are built together as
a new A/B artifact. This avoids an unrepeatable mix of image and in-place
package updates.

## What is automated

- `rpi-image-gen` builds Raspberry Pi OS Trixie for Pi 4 with read-only A/B
  system slots.
- The first boot expands the final persistent partition to fill the external
  disk.
- Docker and containerd state are shared across both OS slots.
- CI-built factory and OTA images pull release-tagged, digest-pinned ARM64
  containers and wait for their health checks. A local factory build uses the
  release tag unless you supply exact image references.
- If new application containers fail, the startup service restores the last
  known-good image set.
- A GitHub Release builds multi-architecture containers, creates an OTA
  artifact, attaches it to the release, registers it with Raspberry Pi
  Connect, deploys it, and waits for the result.

Raspberry Pi's A/B mechanism protects against an unbootable OS update. The
application fallback is an additional safeguard; it does not replace an
off-device backup.

## Requirements

For the appliance:

- Raspberry Pi 4 with current EEPROM firmware.
- A 16 GB or larger USB SSD. A spinning HDD should use its own powered
  enclosure or a powered USB hub.
- Ethernet for the easiest first boot, or an iwd Wi-Fi profile.
- A Raspberry Pi Connect account. Fully automatic API deployment requires a
  Connect for Organisations account.

For image builds:

- The release workflow uses GitHub's native `ubuntu-24.04-arm` runner and runs
  `rpi-image-gen` in a privileged, digest-pinned Debian Trixie container.
- Add the recovery public key as the repository secret
  `RPI_FACTORY_SSH_PUBLIC_KEY`. Keep the matching private key off GitHub.
- `rpi-image-gen` recommends at least 20 GB of free build space. The workflow
  reports the hosted runner's allocation before building. If a standard runner
  is too small for a future image, use an ARM64 larger or self-hosted runner
  with at least 20 GB while keeping the Debian build container unchanged.

The build runner is deliberately separate from the immutable appliance. A
local build remains available on a current 64-bit Raspberry Pi OS Trixie,
Debian Trixie, or Debian Bookworm host.

## 1. Prepare USB boot

Boot the Pi from a normal Raspberry Pi OS card, update it, and choose USB first:

```sh
sudo apt update
sudo apt full-upgrade
sudo raspi-config
```

In `raspi-config`, choose **Advanced Options → Boot Order → NVMe/USB Boot**.
Early Pi 4 boards may update their EEPROM during the package upgrade. Power the
Pi off cleanly after any requested reboot.

## 2. Prepare the build host

Install the two small prerequisites used by the wrapper:

```sh
sudo apt update
sudo apt install --yes git zstd
```

Clone Stuga and check out the exact release you want to install:

```sh
git clone https://github.com/liljestk/open-stuga.git
cd open-stuga
RELEASE_TAG=v0.4.0  # replace with the release you want to install
git switch --detach "$RELEASE_TAG"
```

Always create a new release tag for new content; do not move or reuse an
existing published tag.

Create a recovery SSH key if you do not already have one:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/stuga_appliance
```

In Raspberry Pi Connect, create a short-lived, single-use device auth key and
save only that key to a protected file:

```sh
install -m 0600 /dev/null /tmp/stuga-connect.authkey
nano /tmp/stuga-connect.authkey
```

This is a per-device auth key, not the organisation management API token. The
management token must only be stored in GitHub Actions or another trusted CI
system.

For Wi-Fi, create an iwd file named exactly `<SSID>.psk`:

```ini
[Security]
Passphrase=replace-with-the-real-passphrase
```

Keep that file outside the repository and set its mode to `0600`. Ethernet
does not need a profile.

## 3. Build the one-time factory image

The first command can install `rpi-image-gen` dependencies and will ask for
`sudo` once:

```sh
RPI_IMAGE_GEN_INSTALL_DEPS=1 \
RPI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/stuga_appliance.pub" \
RPI_CONNECT_AUTH_KEY_FILE=/tmp/stuga-connect.authkey \
bash scripts/build-rpi-image.sh
```

For Wi-Fi, add both variables:

```sh
RPI_WIFI_PROFILE=/secure/path/MyNetwork.psk \
RPI_WIFI_COUNTRY=FI \
RPI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/stuga_appliance.pub" \
RPI_CONNECT_AUTH_KEY_FILE=/tmp/stuga-connect.authkey \
bash scripts/build-rpi-image.sh
```

Substitute your ISO 3166-1 two-letter country code for `FI`.

The outputs are written to `dist/rpi/`:

- `stuga-rpi4-<version>.img.zst` — factory disk image.
- `stuga-rpi4-<version>-ota.tar.zst` — remote A/B update.
- `stuga-rpi4-<version>.sha256` — checksums for both.

If supplied, the factory image contains the single-use Connect key, so it is
mode `0600`. Do not upload such an image to a public release. Delete it after
the disk is installed and verified. OTA artifacts do not contain the
persistent Connect identity. The CI factory image described below embeds only
the recovery SSH public key, never its private key or a Connect auth key.

## 4. Publish the matching application images

The appliance pulls immutable images tagged with the Git release, for example
`v0.4.0`. Before publishing the first release:

1. Create a dedicated recovery key with
   `ssh-keygen -t ed25519 -f ~/.ssh/stuga_appliance`.
2. Add `~/.ssh/stuga_appliance.pub` as the repository secret
   `RPI_FACTORY_SSH_PUBLIC_KEY`.
3. Publish the existing tag as a GitHub Release.

The workflow builds on GitHub's native hosted ARM64 runner. It attaches only
the OTA image and its checksum to the public release. The factory image and a
separate factory checksum are uploaded to that workflow run as an uncompressed
Actions artifact retained for three days. Download it before the retention
window expires; it can be rebuilt by rerunning the release workflow.

The `Raspberry Pi release` workflow publishes these GHCR packages:

- `ghcr.io/liljestk/open-stuga-api:<tag>`
- `ghcr.io/liljestk/open-stuga-web:<tag>`
- `ghcr.io/liljestk/open-stuga-backup:<tag>`
- `ghcr.io/liljestk/open-stuga-tapo-export-runner:<tag>`

Make the packages public so the appliance can pull anonymously. If they must
remain private, sign in once on the appliance with a read-only package token:

```sh
DOCKER_CONFIG=/persistent/stuga/docker-config docker login ghcr.io
stugactl restart
```

The workflow's GitHub Release URL must be anonymously downloadable by the Pi.
For a private repository, upload the OTA artifact to a private HTTPS object
store that the device can access and adjust the workflow's `RPI_OTA_URI`.

## 5. Write the external disk once

Verify the image before writing it:

```sh
cd dist/rpi
VERSION=0.4.0  # the release tag without its leading v
sha256sum --check "stuga-rpi4-${VERSION}-factory.sha256"
```

For a manual local build, use its combined
`stuga-rpi4-${VERSION}.sha256` file instead.

Open a current Raspberry Pi Imager:

1. Select Raspberry Pi 4.
2. Choose **Use Custom** and select `stuga-rpi4-<version>.img.zst`.
3. Select the external SSD/HDD. Double-check the device: writing destroys its
   existing partition table and data.
4. Write and verify the image.
5. Power the Pi off, remove the SD card, attach the external disk, connect
   Ethernet, and power it on.

On first boot the appliance expands the persistent partition, signs in to
Connect, pulls the pinned containers, creates runtime secrets, and starts
Stuga. Large images and a slow HDD can make this take several minutes.

## 6. Verify and open Stuga

Connect through SSH using the key from step 2:

```sh
ssh stuga@stuga.local
stugactl status
```

The web service initially binds only to loopback. Create a secure tunnel:

```sh
ssh -L 8080:127.0.0.1:8080 stuga@stuga.local
```

Keep that terminal open and browse to <http://127.0.0.1:8080>. Complete the
owner setup there.

To expose Stuga deliberately on a trusted LAN, edit the persistent settings:

```sh
stugactl config
```

Set the Pi's reserved LAN address and exact browser origin, then restart:

```dotenv
BIND_ADDRESS=192.168.1.50
CORS_ORIGIN=http://192.168.1.50:8080
```

```sh
stugactl restart
```

Prefer a specific reserved address over `0.0.0.0`, restrict the host/network
firewall to the trusted subnet, and use Cloudflare Access or another TLS
reverse proxy for access beyond the private LAN.

## 7. Enable completely automatic OTA deployment

In Raspberry Pi Connect for Organisations:

1. Confirm the device appears and has **Remote update** enabled.
2. Create a management API access token.
3. Obtain the device UUID from the organisation device list/API.

Add these GitHub Actions repository secrets:

| Secret | Value |
| --- | --- |
| `RPI_CONNECT_API_TOKEN` | Organisation management API token |
| `RPI_CONNECT_DEVICE_ID` | The appliance's Connect device UUID |

The management token is administrator-equivalent. Never put it in an image,
repository variable, `.env`, or appliance filesystem.

For every later release:

1. Update and test the code.
2. Bump `package.json`, `package-lock.json`, and the changelog consistently.
3. Tag that commit, for example `v0.3.1`.
4. Publish the tag as a GitHub Release.

The workflow then builds the four multi-architecture images, freezes their
registry digests into the OS release, builds the Trixie A/B artifact, attaches
it and its checksum to the release, registers its HTTPS URL and SHA-256
checksum with Connect, deploys it, and waits up to 30 minutes for success.
Connect keeps an offline device's deployment pending so it can receive it when
it reconnects. If that takes more than 30 minutes, the GitHub job reports a
polling timeout; the Connect deployment itself remains available to the device.

Without Connect for Organisations, the build and upload remain automatic, but
you must select the artifact and press **Deploy** in your personal Raspberry Pi
Connect dashboard.

## Routine commands

```sh
stugactl status       # OS version, last release result, and container health
stugactl logs         # live application logs
stugactl system-log   # image/container startup and fallback log
stugactl config       # persistent appliance settings
stugactl restart      # pull/reconcile the images pinned by this OS release
stugactl backup       # complete application backup
stugactl migration    # authenticated live-migration receiver and rollback tools
stugactl images       # exact immutable image references
```

Backups under `/persistent/stuga/backups` survive A/B updates, but they are on
the same physical disk. Copy verified backups to another machine or encrypted
off-site storage.

The appliance is also a guarded target for Stuga's resumable system-to-system
migration. Seed chunks while the source remains online, then perform a final
health-gated cutover with `npm run migrate` from the source project. See the
[live migration runbook](live-migration.md); do not manually restart the old
source after an ambiguous network failure until the target receipt is known.

## Recovery notes

- If a new container set is unhealthy, `stuga.service` attempts the previous
  known-good image set and records the outcome in
  `/persistent/stuga/release-status`.
- If the new OS cannot boot, Raspberry Pi's try-boot A/B mechanism returns to
  the previous slot.
- Do not run `docker compose down -v`; it deletes the named data and credential
  volumes.
- Do not run `apt upgrade`; the root filesystem is intentionally read-only.
- View Raspberry Pi update diagnostics with `journalctl -t rpi-ota-connector`
  and Stuga startup diagnostics with `stugactl system-log`.
- Keep the recovery SSH private key and a recent off-device Stuga backup.

Upstream references:

- [Raspberry Pi Connect remote updates](https://www.raspberrypi.com/documentation/services/connect.html#remotely-update-your-raspberry-pi-devices)
- [Raspberry Pi Connect for Organisations API](https://www.raspberrypi.com/documentation/services/connect-for-organisations.html#management-api)
- [rpi-image-gen](https://github.com/raspberrypi/rpi-image-gen)
- [Raspberry Pi USB mass-storage boot](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)
