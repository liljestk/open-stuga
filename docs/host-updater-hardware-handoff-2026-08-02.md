# Host-updater single-device preview handoff

Updated: 2026-08-03

This handoff authorizes a bounded preview on one backed-up Raspberry Pi and a
disposable disk. It does not qualify a hardware class or authorize unattended
fleet rollout.

The previously proposed 1,000 power-cut cycles and 72-hour rollout dwells were
internal fleet-hardening suggestions. They were not Raspberry Pi, RAUC, TUF,
GitHub, regulatory, or customer requirements. They are not acceptance criteria
for this single-device preview.

## Test hardware and safeguards

- Raspberry Pi 4 Model B Rev 1.1, revision `c03111`, with the inventoried Pi
  EEPROM and USB topology.
- The production Transcend StoreJet remains disconnected during destructive
  testing.
- Only the separately identified disposable 1 TB Verbatim disk may be flashed.
- A fresh verified Stugu backup, including secrets and the Timescale catalog,
  must exist both on the appliance and off-device before testing.
- Activation is enabled only by a signed receipt matching the exact runtime
  Pi, EEPROM, USB bridge, and storage fingerprint. A similar device does not
  match.

## Preview test sequence

1. Build, hash, and validate a layout-v2 factory image with activation disabled.
2. Flash the disposable disk, boot it alone, and record
   `stuguctl host-update hardware-id`.
3. Issue the exact-device qualification receipt and rebuild the candidate with
   that receipt and the verified boot-selector hash.
4. Verify the H200 live path and confirm that the H500 compatibility adapter is
   not installed on H100/H200 instances. Run the H500 protocol and regression
   suites; physical H500 verification remains a later separate check.
5. Publish a signed preview TUF/RAUC update whose boot image is byte-identical
   to the factory image. The preview therefore exercises inactive-root A/B
   replacement only; kernel, firmware, EEPROM, and canonical p1 changes remain
   recovery-class operations.
6. Exercise one normal activation through probation and reconciliation.
7. Exercise one bounded failed-candidate/interrupted-trial rollback and confirm
   automatic return to the recorded known-good root. Reflash the disposable
   disk if selector recovery is ambiguous.
8. Confirm p6 partition boundaries and application data are unchanged, no
   other disk was written, the H200 integration is healthy, and no updater or
   API service is crash-looping.

## Recovery boundary

Stop immediately on a wrong-disk write, p6 raw-boundary change, signature or
identity bypass, selector ambiguity, or failure to return to known-good. The
recovery path is to power off, reconnect the untouched production StoreJet, and
restore the verified off-device backup only if application data recovery is
needed. The disposable disk may be erased and reflashed.

Passing this sequence supports a clearly labelled GitHub preview release for
this exact device. It is evidence, not a claim of general production hardware
qualification.

The preview receipt uses `watchdogSeconds: 0`. If a candidate hangs before
userspace can request a reboot, the operator must power-cycle it; the selector
consumes one attempt before each root mount and returns to known-good after the
bounded attempts are exhausted.
