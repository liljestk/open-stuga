# Signed host-update release runbook

This runbook covers the implemented `stugu-gpt-ab-v2` release path. It does
not authorize host activation: the repository default is deliberately
unqualified, and deployed layout-v1/updater-contract-3 appliances cannot use
the raw-tail bootstrap. See
[signed-host-updater-plan.md](signed-host-updater-plan.md) for the remaining
hardware and migration gates.

## Trust boundary

- The image builder receives only immutable TUF root v1 and the public RAUC CA.
- The isolated RAUC signer receives the validated host inputs, a constrained
  code-signing leaf/key, and its public chain. It never receives TUF keys.
- The independent TUF ceremony receives the immutable RAUC bundle and its
  unsigned `stugu-tuf-target-request/v1`. It never receives a RAUC key.
- Publish target bytes before targets/delegation metadata, then snapshot, then
  timestamp. All target objects are immutable and hash-prefixed because root v1
  enables consistent snapshots.
- A separate clean verifier downloads the production publication from immutable
  root v1 before rollout.

No production private key belongs in this repository, a GitHub secret used by
the image-build job, a release artifact, or the appliance.

## 1. Build public-anchor images and signing inputs

Use a clean annotated tag and a previously allocated monotonic host generation.
The seven container references must use the same GHCR prefix, exact `v<version>`
tag, and immutable digest.

```sh
export STUGA_HOST_GENERATION=42
export RPI_HOST_TUF_ROOT_FILE=/secure/public/root.json
export RPI_HOST_RAUC_CA_FILE=/secure/public/rauc-ca.pem
export RPI_HOST_UPDATE_BASE_URL=https://updates.example.net/stugu
export RPI_SSH_PUBLIC_KEY_FILE=/secure/public/stuga-recovery.pub
# Also export all seven STUGA_*_IMAGE values as tag@sha256 references.
bash scripts/build-rpi-image.sh
```

The hosted release workflow performs the same public-key-only build. Its
short-lived `stugu-rpi4-<version>-host-inputs` artifact must contain exactly the
validated boot/root images, SPDX SBOM, in-toto provenance, and matching
container release manifest. The upstream `*-ota.tar.zst` is a build byproduct,
not an installable or published host release.

The current implementation rejects every enabled
`RPI_HOST_HARDWARE_QUALIFICATION_FILE`. An enabled receipt is not sufficient:
the production selector, runtime Pi/EEPROM/USB matrix matcher, and physical
power-cut gate must first be implemented and reviewed. Omitting the file embeds
the fail-closed receipt and a zero watchdog setting.

## 2. Sign and verify the RAUC bundle

Run this on the isolated signer with Debian Trixie RAUC 1.13 and
`squashfs-tools` (RAUC invokes `mksquashfs` while creating the bundle). Prefer a
PKCS#11 URI for the release leaf and key. File paths are supported for an
offline lab ceremony only.

```sh
npm run build:host-bundle -- \
  --boot-image host-inputs/boot.vfat \
  --root-image host-inputs/system.erofs \
  --container-manifest host-inputs/stugu-release-manifest-v1.json \
  --sbom host-inputs/stugu-host-sbom.spdx.json \
  --provenance host-inputs/stugu-host-provenance.intoto.jsonl \
  --rauc-cert 'pkcs11:object=stugu-host-release-cert' \
  --rauc-key 'pkcs11:object=stugu-host-release-key' \
  --rauc-signing-keyring /secure/public/rauc-ca.pem \
  --generation 42 \
  --fallback-generation 41 \
  --version 0.29.0 \
  --min-eeprom 2026-01-01 \
  --source-commit <full-git-commit> \
  --output outgoing/stugu-rpi4-0.29.0-host.raucb
```

The command refuses existing outputs, rejects hooks, validates source
provenance and the seven-image container manifest, creates a RAUC verity bundle,
then asks RAUC to verify the finished signature, exact compatible/version,
image hashes/sizes, and image classes. It publishes read-only bundle and request
files only after those checks pass.

Approve both output hashes and archive the ceremony log. The adjacent
`.tuf-target.json` file is unsigned input, not TUF metadata.

## 3. Independent TUF ceremony

Import the target request into the separately controlled TUF repository. The
signer must reject any difference in target path, length, SHA-256, or `custom`
metadata. Use the stable or preview delegated role and its required threshold;
the snapshot/timestamp service cannot create or alter a host target.

Publication order is:

1. upload the bundle under its consistent-snapshot hash-prefixed object name;
2. sign and upload targets/delegated metadata;
3. sign and upload snapshot metadata;
4. sign and upload short-lived timestamp metadata last.

Never overwrite a target object or reuse a host generation for different
bytes. A same-generation repair is valid only for the exact previously trusted
manifest digest.

From a clean machine, independently verify the public repository:

```sh
npm run verify:host-publication -- \
  --root /secure/public/root.json \
  --metadata-url https://updates.example.net/stugu/metadata/ \
  --targets-url https://updates.example.net/stugu/targets/ \
  --request outgoing/stugu-rpi4-0.29.0-host.raucb.tuf-target.json \
  --bundle outgoing/stugu-rpi4-0.29.0-host.raucb \
  --rauc-keyring /secure/public/rauc-ca.pem \
  --initial-publication \
  --receipt receipts/stugu-rpi4-0.29.0-publication.json
```

Use `--initial-publication` only for a new repository whose timestamp,
snapshot, and target-containing metadata are all version 1. After the first
publication, replace it with the latest independently archived receipt as
`--previous-receipt receipts/<previous>.json`. The verifier then
requires timestamp, snapshot, and the target-containing role to advance while
rejecting metadata rollback, host-generation rollback, and same-generation
equivocation in manifest, version, length, or target bytes. Use the previous
receipt for the same channel; a missing or cross-channel receipt is a ceremony
stop, not permission to reset the high-water marks.

The verifier independently checks the RAUC code-signing chain and every file in
the signed inner release manifest, enforces the production TUF thresholds and
role separation on every root, bootstraps from root v1, follows at most 32
sequential rotations, checks expiry/delegations and exact custom metadata,
downloads the public target, and writes an exclusive durable receipt. Run it
with RAUC 1.13 and `python3-tuf`; no rollout starts without that receipt.

## 4. Key rotation

For TUF root, publish each version sequentially with both the old and new root
thresholds. Never skip a version. Appliances retain the bounded complete chain
and revalidate it from immutable v1 on every refresh.

For RAUC CA rotation:

1. add the new CA while the old CA remains in every update-capable and fallback
   slot;
2. publish and activate that dual-keyring host generation;
3. switch the RAUC release leaf only after fleet evidence shows the dual
   keyring is present;
4. remove the old CA only after no supported rollback slot depends on it.

Lost/compromised keys pause publication. Recovery uses the separate offline
role and local physical confirmation; do not lower normal anti-rollback state.

## 5. Appliance operation

Read-only checks and staging are available through the native daemon:

```sh
stuguctl host-update status
stuguctl host-update check --channel stable
stuguctl host-update stage --channel stable
```

Activation requires an explicit confirmation and a valid immutable hardware
qualification receipt:

```sh
stuguctl host-update activate --confirm
```

On unqualified images this command must fail. Do not work around the receipt,
enable a watchdog value by hand, install an ad-hoc selector, or call RAUC
directly. Inspect service logs and the bounded persistent state under
`/persistent/stugu/host-update/`; export sanitized diagnostics with
`stuguctl host-update export-diagnostics`.

## Release blockers

The following remain hard blockers for host activation and fleet rollout:

- production U-Boot selector and exact firmware-selected-disk implementation;
- measured watchdog handoffs and 1,000-cycle reboot/power-cut evidence for every
  supported Pi 4/EEPROM/StoreJet/USB-bridge class;
- complete health dwell including expected container digests, Timescale
  semantics, and configured NAS sentinel policy;
- per-slot Docker/containerd runtime-state separation and migration executor;
- signed recovery media and operator drill;
- authenticated layout-v1/contract-3 fixed-extent bridge, or an explicit
  factory-transition policy;
- API/UI capability integration, canary telemetry, pause thresholds, and
  production TUF/HSM operations.

Any wrong-disk write, p6 raw change, signature bypass, unrecovered boot, or
ambiguous selector result stops the release.
