# Stugu agent instructions

Read `CLAUDE.md` and `DESIGN.md` before changing the product. For release work,
read `docs/release-cycle.md`; for signed Raspberry Pi host updates, also read
`docs/host-update-release.md`.

If `.stuga-release-context.md` exists, read it for this machine's approved
public-input paths and last recorded generation. It is an ignored snapshot:
revalidate its hashes and all remote state before use, and never commit it.

- Keep telemetry, databases, migration captures, credentials, private keys, and
  completed operator-context forms outside Git.
- Read-only release checks are safe. Merging, tagging, pushing containers,
  publishing a release, changing its channel, signing a host update, and
  installing on an appliance require explicit authorization.
- Release from a fresh checkout. Do not switch branches or clean another
  agent's shared worktree.
- The private source is `liljestk/open-stuga`; the public appliance feed is
  `liljestk/stugu-releases`. Never copy private source history or commits into
  the feed repository.
- `npm run release:local` without `--publish` prints a plan only. With
  `--keep-draft --publish`, container tags are still pushed publicly.
- General release agents receive only public trust anchors. Never request or
  handle RAUC/TUF private keys; stop at the documented ceremony boundary.
- Finish with exact commits, tags, channel, generation, artifact checks, target
  appliance, and any missing operator-owned input. Do not report a release as
  complete until the public feed and intended appliance are verified.
