# Signed host updater implementation review

Date: 2026-08-02

## Review scope

This record covers the Phase 1 software foundation and layout-v2 factory-image
plumbing described in [signed-host-updater-plan.md](signed-host-updater-plan.md).
The review must treat wrong-disk writes, p6 raw writes, signature or
anti-rollback bypass, unsafe power-loss recovery, and misleading hardware claims
as release-stopping defects. It must not recommend weakening a fail-closed gate.

Review the complete working tree, including untracked files, with particular
attention to:

- immutable TUF root bootstrap, threshold/key separation, sequential rotation,
  metadata rollback, trusted time, target equivocation, and RAUC code-signing;
- exact firmware-selected disk/partition identity, inactive-slot-only writes,
  durable journals/trust/boot records, interruption recovery, and mutation
  interlocks with the container updater;
- strict release contracts, independent publication verification, signing-key
  separation, and release-pipeline boundary conditions;
- data/runtime epoch compatibility, migration/NAS behavior, candidate health,
  recovery, observability, and whether incomplete phases are honestly blocked;
- layout-v1/updater-contract-3 bootstrap limitations and Pi 4 USB/EEPROM/
  watchdog/selector qualification claims.

Classify concrete findings by severity and cite files/lines. A round may conclude
`NO_MAJOR_OBJECTIONS` only when no P0/P1 or other release-critical software
defect remains. Missing physical evidence and later phases may remain blockers;
they are not reasons to weaken the implementation.

## Baseline evidence

The complete local CI/release gate set passed against the immediately preceding
product baseline with 20 checks and no failures. The durable receipt is
`dist/ci/stugu-0.29.0-local-ci.json`, SHA-256
`7230cc3d067d594f67f79a5adfd2827a47396b864d8128d76f082586e38d81d6`
(270,087 ms).
It includes the native Python suite, a real RAUC 1.13/TUF 5.1 HTTPS publication
exercise, Linux process/durability tests under the production init contract,
ShellCheck, Ruff, application/tooling tests and coverage, builds, Compose
validation, all production container builds, and smoke tests.

The same gate set against `origin/main` correctly stops at the version gate
because the unreleasable working tree still declares 0.29.0. A version bump is
deferred until every release gate, including required hardware evidence, can be
truthfully satisfied.

## Hard release blockers

- `HARDWARE_ACTIVATION_IMPLEMENTED` is deliberately false. The production
  U-Boot selector and exact runtime Pi/EEPROM/USB hardware-matrix matcher do not
  exist yet; an enabled qualification receipt is rejected by the image builder.
- No 1,000-cycle Pi 4/EEPROM/StoreJet/USB-bridge reboot, watchdog, and relay
  power-cut qualification has been performed.
- Deployed layout-v1/updater-contract-3 appliances have a full 96 MiB FAT and no
  qualified fixed-extent bridge; the layout-v2 raw-tail bootstrap rejects them.
- Complete candidate dwell/container-digest/Timescale/NAS checks, per-slot
  Docker/containerd state and migrations, signed recovery media, API/UI fleet
  integration, canary telemetry, and production TUF/HSM operations remain later
  phases.

These blockers prohibit a product version bump, commit/push, production artifact
publication, or GitHub release in this review. If they remain after software
review, the result is a verified software foundation with a blocked general
release, not a weakened or nominal release.

## Claude implementation-review rounds

The earlier architecture review is recorded in
[signed-host-updater-plan.md](signed-host-updater-plan.md): Claude rounds 1 and
2 found major design objections, all were incorporated, and architecture round
3 concluded `NO_MAJOR_OBJECTIONS`.

The required post-implementation review was attempted through the
`multi-llm-router` with Claude Opus/max after its 14:10 Europe/Helsinki quota
reset. It did not produce a verdict:

1. Complete 0.5 MB change bundle: 540-second timeout; untruncated context SHA-256
   `e85cd06b9da2598df4c48ef76011f82bf84acb7209e0511a8fa0904fa257a4d0`.
2. Bounded 330 KB on-device scope: 540-second timeout; deliberately truncated
   context SHA-256
   `0b34aa2b42d1780b0f2a9a8086a99b926139daf2c5274a519a56914d1a2532a4`.
3. Untruncated approximately 110 KB boot/state-machine scope: 540-second
   timeout; context SHA-256
   `98ff4c41567fad15e05f72285dd176cb9d88c81b40d65a0f84dd93a4a88e5551`.
4. Untruncated single-file 22 KB `bootcontrol.py` diagnostic: 300-second
   timeout; context SHA-256
   `553397938ae9fc8d6bba2fb8f9830b80c5a2173d306caa38b523afbcf311a38e`.
5. Complete untruncated working-tree review after the live v0.30.0 rollout:
   569-second timeout; context SHA-256
   `b8334f5ce0cc53781e03ba1b807381a1577c641ba9b845d3d08a5b31550261fe`.

The complete and progressively smaller untruncated attempts show that the
remaining failure is provider/runtime-side rather than a context-size objection.
No Claude finding or approval was returned, so there is nothing to resolve and
no basis for claiming `NO_MAJOR_OBJECTIONS`. The implementation review gate
remains blocked.

Before those calls, local review found and fixed whole-file allocation before
size checks, symlink/race handling in the cross-updater lease, short audit-log
writes, permissive unknown mutation status, signer-input snapshot races,
publication-verifier local-input TOCTOU, target-role continuity, and accidental
omission of publication history. Regression tests and the real RAUC/TUF HTTPS
ceremony cover these corrections.

## Release decision

`BLOCKED`. The implementation foundation may not be versioned or published
until a post-implementation Claude review returns a valid verdict and every
hard hardware/later-phase blocker above is completed. No product version was
bumped, no changes were staged or committed, no branch was pushed, and no
GitHub release or production host artifact was created.
