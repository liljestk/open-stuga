# Raspberry Pi 4 appliance

This installation turns a Raspberry Pi 4 and USB SSD/HDD into a Stugu
appliance. Stugu's databases, generated secrets, Docker state, configuration,
and backups remain on the shared persistent partition. Application releases
update automatically from repository-bound, digest-pinned GitHub/GHCR releases
with health checks and container rollback. Tailscale is installed and enabled,
and its device identity remains persistent.

The operating-system release is immutable: do not use `apt upgrade` on the
appliance. Layout-v2 factory images include a public-anchor-only TUF + RAUC host
updater and an early-initramfs A/B root selector. Activation is fail-closed
unless a signed receipt matches the exact runtime Pi, EEPROM, USB bridge, and
storage fingerprint. Preview bundles must keep the shared boot artifact
byte-identical; kernel and boot-firmware changes still use a newly validated
factory image. Pi 4 USB
firmware partition handoff is intentionally not used because it boot-looped on
supported USB-SATA bridges. Direct boot waits six seconds after essential
drivers load so slower bridges can enumerate before the immutable system slot
is mapped.

## What is automated

- `rpi-image-gen` builds Raspberry Pi OS Trixie for Pi 4 with read-only A/B
  system slots.
- The first boot relocates the backup GPT and expands the final persistent
  partition and ext4 filesystem to fill the complete external disk.
- A complete first-partition rescue payload boots directly and selects slot A
  by default from a validated marker, avoiding Pi 4 USB partition handoff.
- New factory images reserve p1's final MiB outside FAT for redundant host
  boot-control records; factory validation proves the boundary is zero-filled.
- The direct-boot command line keeps `rootwait`, adds `rootdelay=6`, and enables
  the cgroup v2 memory controller for Docker limits and memory metrics.
- Docker and containerd state are shared across both OS slots.
- Stugu listens on the trusted LAN and Tailscale interfaces by default, while
  first-owner creation requires a device-generated setup link.
- Tailscale is enabled and ready for a one-time interactive Tailnet login; no
  reusable Tailnet credential is embedded in the image.
- The host clock is continuously synchronized over NTP, while an unavailable
  time service never prevents the local appliance from starting.
- Factory images pull release-tagged, digest-pinned ARM64 containers and wait
  for their health checks.
- If new application containers fail, the startup service restores the last
  known-good image set.
- Stable GitHub application releases are checked daily and installed during a
  weekly maintenance window by default. Owners can change this policy.
- One guarded local command builds and publishes the multi-architecture
  containers, creates the Pi artifacts, and publishes the GitHub Release.
- GitHub's hosted release workflow is manual fallback only. Publishing a
  release does not start an expensive hosted image build.

The application fallback does not replace an off-device backup.

## Requirements

For the appliance:

- Raspberry Pi 4 with current EEPROM firmware.
- A 16 GB or larger USB SSD. A spinning HDD should use its own powered
  enclosure or a powered USB hub.
- Ethernet for the easiest first boot, or an iwd Wi-Fi profile.
- Optionally, a Raspberry Pi Connect account for remote shell access.

For image builds:

- Node.js 22.13 or newer, Git, GitHub CLI, and Docker with Buildx.
- Docker must support privileged Linux containers and either native ARM64 or
  ARM64 emulation. Current Docker Desktop is sufficient.
- Authenticate GitHub CLI for the repository and GHCR package writes. Set
  `GHCR_TOKEN` and `GHCR_USERNAME` when the GitHub CLI token cannot write
  packages.
- Keep the recovery private key off GitHub. The local publisher reads only its
  public key.
- `rpi-image-gen` recommends at least 20 GB of free Docker/build space.

The build runner is deliberately separate from the immutable appliance. A
local build remains available on a current 64-bit Raspberry Pi OS Trixie,
Debian Trixie, Debian Bookworm, Windows, macOS, or Linux host with compatible
Docker. The manual fallback workflow retains the native
`ubuntu-24.04-arm` path and requires explicit hosted-build confirmation.

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

Do not skip this step. Every Stugu factory image boots its complete first FAT
partition directly and rejects any `autoboot.txt` there. This is a release
gate: redirecting that partition to itself loops, while redirecting to a later
GPT FAT partition proved unreliable on the tested Pi 4 USB bridge. The build
also validates current firmware and automatic kernel/initramfs pairing.

USB discovery and boot order are handled separately by the Pi 4 EEPROM. Update
it to the current release and confirm that its boot order contains USB mode
`4`:

```sh
sudo rpi-eeprom-update -a
sudo reboot
sudo rpi-eeprom-update
sudo rpi-eeprom-config | grep '^BOOT_ORDER='
```

When there are no login credentials for the card, update the EEPROM without
booting an OS at all: in Raspberry Pi Imager choose **Misc utility images →
Bootloader (Pi 4 family) → USB Boot**, write that to any spare card, and boot
the Pi from it. It rewrites the EEPROM and the boot order unattended; a steady
green ACT LED, or a green screen over HDMI, means it finished. Power off and
remove the card. This erases the card it is written to.

## 2. Prepare the build host

Install the two small prerequisites used by the wrapper:

```sh
sudo apt update
sudo apt install --yes git zstd
```

Clone Stugu and check out the exact release you want to install:

```sh
git clone https://github.com/liljestk/open-stuga.git
cd open-stuga
RELEASE_TAG=v0.18.0  # replace with the release you want to install
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
install -m 0600 /dev/null /tmp/stugu-connect.authkey
nano /tmp/stugu-connect.authkey
```

This is a per-device auth key, not the organisation management API token. Keep
the management token in a trusted local secret store or in GitHub Actions only
for the manual fallback.

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
STUGA_HOST_GENERATION=42 \
RPI_HOST_TUF_ROOT_FILE=/secure/public/root.json \
RPI_HOST_RAUC_CA_FILE=/secure/public/rauc-ca.pem \
RPI_HOST_UPDATE_BASE_URL=https://updates.example.net/stugu \
RPI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/stuga_appliance.pub" \
RPI_CONNECT_AUTH_KEY_FILE=/tmp/stugu-connect.authkey \
bash scripts/build-rpi-image.sh
```

For Wi-Fi, add both variables:

```sh
RPI_WIFI_PROFILE=/secure/path/MyNetwork.psk \
RPI_WIFI_COUNTRY=FI \
STUGA_HOST_GENERATION=42 \
RPI_HOST_TUF_ROOT_FILE=/secure/public/root.json \
RPI_HOST_RAUC_CA_FILE=/secure/public/rauc-ca.pem \
RPI_HOST_UPDATE_BASE_URL=https://updates.example.net/stugu \
RPI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/stuga_appliance.pub" \
RPI_CONNECT_AUTH_KEY_FILE=/tmp/stugu-connect.authkey \
bash scripts/build-rpi-image.sh
```

Substitute your ISO 3166-1 two-letter country code for `FI`.

The outputs are written to `dist/rpi/`:

- `stugu-rpi4-<version>.img.zst` — factory disk image.
- `stugu-rpi4-<version>-ota.tar.zst` — generated A/B build byproduct; do not
  deploy it to the Pi 4 USB appliance.
- `stugu-rpi4-<version>.sha256` — checksums for both.
- `host-inputs/` — validated boot/root, SBOM, provenance, and container
  manifest inputs for the isolated RAUC signer; this directory is not itself an
  installable update.

The factory image contains no SSH server host private keys. Each installed disk
generates a fresh RSA, ECDSA, and Ed25519 host-key set from the Pi's kernel RNG
on first boot, before SSH can start. The keys live under the persistent shared
partition and survive A/B slot changes and application releases. The key passed
through `RPI_SSH_PUBLIC_KEY_FILE` is separate: it authorizes operator login and
may also be made per-device, but its private half never enters the image.

Before compression, the build validates the raw image with Linux `sfdisk` and
`mtools`. It fails unless the protective MBR, GPT, six aligned/named
partitions, the layout-v2 95 MiB FAT/raw-tail boundary, filesystem signatures,
current Pi firmware, complete rescue
payload, automatic kernel/initramfs pairing, `rootwait rootdelay=6`,
`cgroup_enable=memory`, and identical factory A/B slots are all valid.

If supplied, the factory image contains the single-use Connect key, so it is
mode `0600`. Do not upload such an image to a public release. Delete it after
the disk is installed and verified. The local publisher and hosted fallback
embed only the recovery SSH public key, never its private key or a Connect auth
key.

## 4. Publish the release locally

The appliance pulls immutable images tagged with the Git release, for example
`v0.15.0`. Before publishing the first release, create a dedicated recovery
key:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/stuga_appliance
```

Install dependencies, commit the tested release, and push its immutable tag:

```sh
npm ci
git tag v0.15.0
git push origin main v0.15.0
```

Preview the resolved local release plan:

```sh
npm run release:local -- \
  --repository OWNER/stugu-releases \
  --image-prefix ghcr.io/OWNER/open-stuga \
  --notes-file release-notes.md \
  --host-generation 42 \
  --host-tuf-root /secure/public/root.json \
  --host-rauc-ca /secure/public/rauc-ca.pem \
  --host-update-base-url https://updates.example.net/stugu \
  --ssh-public-key "$HOME/.ssh/stuga_appliance.pub"
```

Add `--publish` to execute it:

```sh
npm run release:local -- \
  --repository OWNER/stugu-releases \
  --image-prefix ghcr.io/OWNER/open-stuga \
  --notes-file release-notes.md \
  --host-generation 42 \
  --host-tuf-root /secure/public/root.json \
  --host-rauc-ca /secure/public/rauc-ca.pem \
  --host-update-base-url https://updates.example.net/stugu \
  --ssh-public-key "$HOME/.ssh/stuga_appliance.pub" \
  --publish
```

The release path always builds and verifies the exact Nexus433 corresponding-
source archive before publishing containers, then attaches that archive and its
checksum to the public release. There is no manual compliance bypass.

Replace `OWNER` with the GitHub account that owns the public artifact
repository and image packages. First create the same tag name on a harmless
commit in a separate checkout of the public artifact repository. Never push the
private source repository's tag or commit to that public repository. The
publisher verifies both tag locations and refuses a private or untagged
artifact repository before starting CI or builds. It also requires a clean
checkout at the pushed source tag on `origin/main`, runs local CI, builds and
pushes all AMD64/ARM64 containers, resolves their registry digests, builds the
Pi factory image and public-key-only host signing inputs in a pinned privileged
ARM64 Debian container, creates a draft
GitHub Release, uploads the immutable image manifest, local CI receipt, and
checksums, plus the Nexus433 corresponding-source bundle and its checksum, and
then publishes the release. RAUC and TUF private-key operations remain a
separate ceremony; see [the signed host-update runbook](host-update-release.md).

The factory image remains under `dist/rpi/` by default. Add
`--upload-factory` only when it contains no Connect auth key, Wi-Fi profile, or
other provisioning secret. Use `--notes-file PATH` for curated notes, or let
GitHub generate them. After a partial failure that already published all
containers, `--reuse-containers` skips rebuilding and resolves their existing
digests.

The local publisher creates these GHCR packages:

- `ghcr.io/liljestk/open-stuga-api:<tag>`
- `ghcr.io/liljestk/open-stuga-web:<tag>`
- `ghcr.io/liljestk/open-stuga-backup:<tag>`
- `ghcr.io/liljestk/open-stuga-tapo-export-runner:<tag>`
- `ghcr.io/liljestk/open-stuga-update-agent:<tag>`
- `ghcr.io/liljestk/open-stuga-mqtt:<tag>`
- `ghcr.io/liljestk/open-stuga-nexus433:<tag>`

Make the packages public so the appliance can pull anonymously. If they must
remain private, sign in once on the appliance with a read-only package token:

```sh
DOCKER_CONFIG=/persistent/stugu/docker-config docker login ghcr.io
stuguctl restart
```

The credential directory is mounted read-only into the appliance update agent,
so automatic and UI-triggered pulls use the same login as boot and `stuguctl`.
The GitHub Release feed and manifest must be anonymously readable by the Pi.
A persistent Docker login only grants GHCR access; it does not grant access to
a private GitHub Release. Private GitHub Releases are not currently supported
by the appliance updater. When source code is private, point
`SYSTEM_UPDATE_REPOSITORY` at a separate readable release repository and keep
`SYSTEM_UPDATE_IMAGE_PREFIX` pointed at the published image namespace.
Create the matching release tag in that repository first, then pass
`--repository OWNER/RELEASE-REPO --image-prefix ghcr.io/OWNER/IMAGE-PREFIX` to
the local publisher. Those values are embedded into the factory appliance
settings, while the source tag is still checked against `origin/main`.

If local Docker is temporarily unavailable, manually dispatch
**Raspberry Pi release (manual fallback)** with the existing tag and enable
**Confirm use of hosted runners**. The workflow builds and preserves the
verified Nexus433 corresponding-source archive before any container job can
run; there is no source-publication bypass. It is an explicit paid build
fallback that emits the factory image, immutable container manifest, and
short-lived public-key-only host signing inputs. It does not sign or publish a
RAUC/TUF host update, and a private source release is not the public feed needed
by appliances. Use the local publisher for a separate public artifact
repository.

## 5. Write the external disk once

Verify the image before writing it:

```sh
cd dist/rpi
VERSION=0.17.0  # the release tag without its leading v
sha256sum --check "stugu-rpi4-${VERSION}-factory.sha256"
```

For a manual local build, use its combined
`stugu-rpi4-${VERSION}.sha256` file instead.

Open a current Raspberry Pi Imager:

1. Select Raspberry Pi 4.
2. Choose **Use Custom** and select `stugu-rpi4-<version>.img.zst`.
3. Select the external SSD/HDD. Double-check the device: writing destroys its
   existing partition table and data.
4. Write and verify the image.
5. Power the Pi off, remove the SD card, attach the external disk, connect
   Ethernet, and power it on.

Raspberry Pi Imager performs a verified raw write on Windows, macOS, and Linux;
rewriting the same bytes with Linux `dd` does not create a different GPT. For
an additional Linux check before first boot, unmount the new partitions and
run the repository validator against the whole disk:

```sh
sudo apt install --yes fdisk mtools python3
sudo bash scripts/validate-rpi-image.sh /dev/sdX
```

Replace `/dev/sdX` with the external disk, not a partition. The command is
read-only but hashes both A/B slots, so it can take a minute. Run it before the
first boot, which expands the final persistent partition.

On first boot the kernel waits six seconds before mapping the active system
slot. The appliance then expands the persistent partition, signs in to Connect
when configured, pulls the pinned containers, creates runtime secrets and a
first-owner setup secret, and starts Stugu. Large images and a slow HDD can
make this take several minutes.

## 6. Verify and open Stugu

Connect through SSH using the key from step 2:

```sh
ssh stugu@stugu.local
stuguctl status
stuguctl access
cat /persistent/shared/.stugu-ssh-host-keys-v1
cat /proc/cmdline
findmnt -no SOURCE /
grep -w memory /sys/fs/cgroup/cgroup.controllers
docker stats --no-stream
```

The command line must contain `rootwait`, `rootdelay=6`, and
`cgroup_enable=memory`; the root source must be the selected immutable system
partition. The cgroup output and Docker memory columns confirm that host and
container memory metrics are available.

Open the displayed LAN URL. Before the first Owner exists, use the displayed
`Setup:` URL; its secret is carried in the browser fragment and is removed
before the browser sends the owner request. After setup, use the normal LAN URL
and owner password.

To join the Pi to a Tailnet, start the one-time interactive login:

```sh
stuguctl tailscale up
```

Open the URL printed by Tailscale, authorize the device, then run
`stuguctl access` again for its Tailnet URL. Tailscale traffic is encrypted,
but direct LAN access is plain HTTP and should remain on a trusted private
network. Use Cloudflare Access or another TLS reverse proxy for public access.

The SSH host-key receipt lists the installation's SHA-256 fingerprints. Record
the Ed25519 fingerprint through a trusted local or Raspberry Pi Connect console
before approving the first SSH connection. A later unexpected fingerprint
change requires investigation; normal application and A/B updates retain it.

## 7. Automatic GitHub application releases

The appliance enables its isolated update-agent container by default. A clean
installation checks stable GitHub releases every 24 hours and installs during
the Sunday 03:00 UTC maintenance window. Owners can change the days, time,
timezone, release channel, or manual/automatic mode under **Advanced →
System updates**.

Each installation creates a verified backup before pulling the exact release
images. It replaces only the application containers, waits for health checks,
and restores the previous image set on failure. The native host updater may
check, stage, and activate a signed root-filesystem preview only on the exact
hardware fingerprint named by its qualification receipt. A verified off-device
backup and rollback drill remain required. Kernel, firmware, and canonical p1
changes require a new validated factory image; Raspberry Pi Connect OS
deployment remains disabled on Pi 4 USB.

### One-time updater contract 3 transition

An appliance on the five-image contract used by v0.25.0 cannot install the
seven-image contract as an application-only update. A final compatible bridge
release must first report **Factory upgrade required**; without that bridge the
older API fails closed on the incompatible release manifest.

Before continuing, run `stuguctl backup` and copy the verified backup from
`/persistent/stugu/backups` to another machine or encrypted storage. Then write
a validated contract-3 factory image and restore the backup, or migrate into a
separate freshly imaged target by following the
[live migration runbook](live-migration.md). Writing the factory image to the
same disk destroys its existing data. Do not manually place an eleven-line
contract-3 release file on an older OS.

Contract 3 uses `/persistent/stugu/update-release/release-v3.env` and
`known-good-v3.env`. Older slots keep their unversioned release files, so an
A/B rollback cannot reinterpret the seven-image state.

## Routine commands

```sh
stuguctl status       # OS version, last release result, and container health
stuguctl access       # LAN/Tailnet URLs and the first-owner setup link
stuguctl tailscale up # one-time interactive Tailnet login
stuguctl logs         # live application logs
stuguctl system-log   # image/container startup and fallback log
stuguctl config       # persistent appliance settings
stuguctl restart      # pull/reconcile the images pinned by this OS release
stuguctl reboot       # gracefully reboot the appliance host
stuguctl poweroff     # gracefully halt the host before disconnecting power
stuguctl backup       # complete application backup
stuguctl host-update hardware-id # exact-device qualification input
stuguctl host-update status # native signed-host updater status (activation gated)
stuguctl migration    # authenticated live-migration receiver and rollback tools
stuguctl images       # exact immutable image references
```

`restart` reconciles the Stugu application; it does not reboot the host.
`host-update check` and `host-update stage` remain read-only/staging operations.
Activation requires an immutable exact-device qualification receipt. Never
bypass that receipt or invoke RAUC directly.
`reboot` and `poweroff` remain available when application configuration is
broken. They reject extra arguments and use sudoers entries for only the exact
`systemctl reboot` and `systemctl poweroff` command lines; they do not grant
general sudo or arbitrary `systemctl` access. After `poweroff` disconnects SSH,
wait for disk activity to stop before removing power.

Backups under `/persistent/stugu/backups` survive A/B updates, but they are on
the same physical disk. Copy verified backups to another machine or encrypted
off-site storage.

The appliance is also a guarded target for Stugu's resumable system-to-system
migration. Seed chunks while the source remains online, then perform a final
health-gated cutover with `npm run migrate` from the source project. See the
[live migration runbook](live-migration.md); do not manually restart the old
source after an ambiguous network failure until the target receipt is known.

## Recovery notes

- If a new container set is unhealthy, `stugu.service` attempts the previous
  known-good image set and records the outcome in
  `/persistent/stugu/release-status`.
- Seven green ACT flashes means the firmware did not find a kernel. Release
  0.18.3 and newer reject `autoboot.txt` on the complete first-partition rescue
  boot. Release 0.19.9 and newer also retain firmware-managed automatic
  kernel/initramfs pairing and reject unsafe explicit overrides. Repeated
  seven-flash failures first point to an incomplete write, old EEPROM boot
  order, cable, bridge, or power issue.
  Some USB-SATA adapters work in bootloader mass-storage mode but fail when
  Linux selects UAS.
  `enable_uart=1` and `uart_2ndstage=1` are already set, so a 115200-baud
  serial console on GPIO 14/15 shows exactly which file fails.
- On the tested StoreJet bridge, netconsole accidentally hid an early USB
  enumeration race by waiting about five seconds for Ethernet. A production
  boot must succeed without netconsole and with `rootdelay=6`; diagnostic
  netconsole success alone does not approve an image.
- Do not run `docker compose down -v`; it deletes the named data and credential
  volumes.
- Do not run `apt upgrade`; the root filesystem is intentionally read-only.
- View Stugu startup and update diagnostics with `stuguctl system-log`.
- Keep the recovery SSH private key and a recent off-device Stugu backup.

Upstream references:

- [Raspberry Pi Connect](https://www.raspberrypi.com/documentation/services/connect.html)
- [rpi-image-gen](https://github.com/raspberrypi/rpi-image-gen)
- [Raspberry Pi USB mass-storage boot](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)
- [Pi 4 GPT/autoboot firmware report](https://github.com/raspberrypi/rpi-eeprom/issues/654)
