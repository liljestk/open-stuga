# Host-updater hardware handoff

Date: 2026-08-02

This is a lab handoff, not an activation receipt. Host activation remains
disabled. Do not use the production SSD for destructive qualification.

## Inventoried production hardware class

- Raspberry Pi 4 Model B Rev 1.1, revision `c03111`, 4 GB RAM.
- EEPROM release dated 2026-05-17, commit
  `224877da90f82a72dbcc9db10bcf059259f54680`.
- EEPROM `BOOT_ORDER=0xf14`; boot watchdog currently disabled.
- Transcend StoreJet / `TS240GESD230C`, firmware `R0605A3S`.
- USB identity `2174:2000`, descriptor `bcdDevice 80.00`, UAS driver,
  currently negotiated at 480 Mbit/s.
- GPT disk with six partitions, active `system_a`, and persistent data on p6.
- Deployed compatibility is layout v1: p1 is a 96 MiB FAT filesystem mounted
  at `/bootfs`, with about 48 MiB free. It has no layout-v2 raw tail.
- No throttling was reported during inventory.

Device serials and partition UUIDs are intentionally omitted from this source
document. The qualification runner must capture and bind them in private lab
receipts.

## Software gates before destructive testing

1. Obtain a complete independent implementation-review verdict and resolve all
   release-critical findings.
2. Implement and review the production U-Boot selector and exact runtime
   Pi/EEPROM/USB hardware matcher. Do not flip
   `HARDWARE_ACTIVATION_IMPLEMENTED` before both exist.
3. Implement the authenticated layout-v1 fixed-FAT-extent bridge. It must not
   treat the live 96 MiB FAT as the layout-v2 raw-tail format.
4. Complete candidate dwell checks, data/runtime epochs, per-slot
   Docker/containerd state, migration execution, NAS policy, and privilege
   separation.
5. Produce signed recovery media and complete the recovery drill.
6. Complete API/UI capability gating and the production RAUC/TUF signing,
   verification, canary, pause, and audit path.

## Physical lab required from the owner

- Prefer a spare Pi matching revision/RAM and an identical spare Transcend
  StoreJet hardware class. If the production Pi is used, disconnect the
  production SSD completely before attaching the test SSD.
- Provide a controllable power relay in the Pi power path, a UART console
  adapter, and a recovery microSD. Keep the relay control/logging host on
  separate power.
- Connect only the disposable test SSD during qualification. Never attach the
  production and test SSDs at the same time.
- Tell Codex when the relay, UART, Pi, and disposable SSD are connected and
  visible. Codex can then build/flash the candidate, run the automated matrix,
  collect receipts, and stop on the first invariant failure.

## Required test campaigns

1. Layout-v2 factory path on a disposable SSD: normal/pending markers, exact
   disk selection, A/B trials, watchdog handoffs, bad candidates, warm/cold
   boots, UAS and `usb-storage`, slow enumeration, extra-disk ambiguity, network
   loss, and fallback before userspace.
2. Layout-v1 bridge path on a disposable v0.30-style image: preallocated FAT
   extents, pending and normal selector trials, byte-identical `config.txt`
   replacement, authenticated trust bootstrap, seed bundle, and retry/recovery.
3. Relay cuts at every journal and record transition and during boot/root/FAT
   writes. Run 1,000 cycles for each supported hardware class. Acceptance is a
   verified old or new slot, unchanged p6 raw boundaries, and no wrong-disk
   write or unrecovered boot.
4. Full/near-full storage, Timescale/SQLite restore, configured and unavailable
   NAS, R2 outage, migration interlocks, signed recovery, and operator recovery
   drills.

After these gates pass, the one-time production layout-v1 bridge can run while
the SSD stays connected to the Pi. It still requires local confirmation,
verified power, and prepared recovery media. Subsequent ordinary host OS/kernel
updates use the native A/B path remotely. Raspberry Pi EEPROM and canonical p1
firmware remain recovery-class updates and may still require local recovery
media.
