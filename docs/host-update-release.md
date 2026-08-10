# Signed host-update release runbook

This runbook covers the implemented `stugu-gpt-ab-v2` release path. Images are
unqualified by default. A preview may activate only when its signed receipt
matches the exact runtime Pi, EEPROM, USB bridge, and storage fingerprint.
Deployed layout-v1/updater-contract-3 appliances cannot use the raw-tail
bootstrap and still require a factory transition.

Begin with the merge, source/feed tags, container publication, and validated
host inputs from the [application release cycle](release-cycle.md). This
runbook starts at the separate signing boundary; it never grants a general
release agent access to RAUC or TUF private keys.

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

The image builder accepts an enabled `RPI_HOST_HARDWARE_QUALIFICATION_FILE`
only when it validates the compiled early-initramfs selector hash and the exact
runtime hardware fingerprint contract. Omitting the file embeds the fail-closed
receipt. A receipt for another Pi, EEPROM, USB bridge, or disk does not match.

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
  --tuf-root /secure/public/root.json \
  --generation 42 \
  --fallback-generation 41 \
  --version 0.29.0 \
  --min-eeprom 2026-01-01 \
  --source-commit <full-git-commit> \
  --output outgoing/stugu-rpi4-0.29.0-host.raucb
```

The command refuses existing outputs, rejects hooks, validates source,
generation, and public trust-anchor provenance plus the seven-image container
manifest, creates a RAUC verity bundle,
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

Bridge-capable, qualified layout-v2 appliances expose separate Application and
Host rows in **Advanced -> System**. **Update everything** verifies a backup,
stages the signed host target, and stops for an explicit **Restart and install**
confirmation bound to the exact native operation, version, generation, and
manifest digest. The page reconnects during trial boots and probation. The
application update begins only after the native journal reports `complete`;
`returned` or `recovery-needed` never advances it. Cancelling before activation
marks the staged journal reusable and releases the shared mutation interlock.

The browser and API never call RAUC, write a block device, select a TUF path,
or access the native socket. Their only host boundary is the fixed file bridge
described in [System updates](system-updates.md). Host activation is never
automatic.

Generation-6 hosts do not contain that bridge in their immutable root. Perform
the first bridge-capable transition with the CLI below (or a validated factory
transition), then wait for the new host and update-agent capability before
using the unified UI. Do not copy a bridge binary or systemd unit into an older
slot by hand.

Read-only checks and staging are available through the native daemon:

```sh
stuguctl host-update hardware-id
stuguctl host-update status
stuguctl host-update check --channel stable
stuguctl host-update stage --channel stable
```

Before staging, collect the bounded cross-service and exact-device snapshot from
the release workstation without mutating the appliance:

```sh
npm run rpi:doctor -- --target operator@stugu.local
```

Use `--deep` only when the default receipt points to logs or database integrity.
The doctor never stages, activates, repairs, or restarts anything.

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

## Preview boundary and fleet blockers

The compiled initramfs selector, redundant boot records, and exact runtime
matcher permit a bounded exact-device preview. The 1,000-cycle and 72-hour
figures in the historical architecture plan were internal fleet-hardening
proposals, not external requirements and not preview gates.

For this preview, the RAUC boot artifact must be byte-identical to the active
boot slot. Only the inactive immutable root is replaced; kernel, firmware,
EEPROM, and canonical p1 changes remain recovery-class. A verified off-device
backup, disposable test disk, normal activation, bounded rollback drill, p6
invariance check, and healthy application reconciliation are mandatory.

General unattended rollout still needs a declared hardware support matrix,
broader recovery evidence, production key custody and TUF operations, canary
telemetry, and an explicit layout-v1 transition policy. Any wrong-disk write,
p6 raw change, signature bypass, unrecovered boot, or ambiguous selector result
stops both the preview and the release.
