# Stugu agent instructions

Read `CLAUDE.md` and `DESIGN.md` before changing the product. For release work,
read `docs/release-cycle.md`; for signed Raspberry Pi host updates, also read
`docs/host-update-release.md`.

Every code change follows the "Code quality" rules in `CLAUDE.md`: split by
domain (no new numbered modules), import only what a file uses, reuse helpers,
one canonical response shape, validated API responses, options objects past
three parameters, and shared types in `@climate-twin/contracts`. Run
`npm run verify:local -- --fast` and fix every failure before reporting work as
done. Claude Code enforces this with a Stop hook; other agents must run it
themselves.

Any change that affects a rendered screen must pass the blocking visual-
acceptance contract in `DESIGN.md`. Inspect the finished UI with representative
non-private data, exercise the primary workflow, and record the required
screenshots and pass/fail findings. Tests, snapshots, and code review do not
substitute for this inspection. If it cannot run or any criterion fails, report
visual acceptance as blocked or failed and do not call the UI work complete.

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
