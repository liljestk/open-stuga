# Working in this repository

Stugu is a **local-first** digital twin for indoor climate across one or more
homes. It runs on the owner's own hardware — Docker Compose on a NAS/PC, or the
Raspberry Pi appliance image under `deploy/rpi`. Internal package names keep the
original `climate-twin` identifier.

## Deployment reality (read this before suggesting anything)

- The product **does not deploy to Cloudflare**. There is no Workers/Pages
  hosting path for the API or the web app; both ship as container images
  (GHCR) and as the Pi appliance.
- Cloudflare appears only in two optional, operator-owned places: Tunnel +
  Access for remote entry to a self-hosted install (`scripts/cloudflare-*.mjs`,
  `secrets/cloudflare/`), and the standalone bug-report relay Worker in
  `apps/bug-report-relay` that holds a GitHub App key. Neither is part of
  shipping the app, and neither should be deployed as part of ordinary work.
- Hosted GitHub Actions CI is **paused** while the repo is private.
  `npm run verify:local -- --full` runs the authoritative local CI once and
  produces the reusable receipt (see `docs/local-ci.md`).
- For Raspberry Pi updater diagnosis and recovery—including an **unsupported
  safety state** or blocked application-only OTA—follow the
  [system-update recovery runbook](docs/system-update-recovery.md).

## Layout

| Path | What lives there |
| --- | --- |
| `apps/api` | Express API, SQLite control plane, background services, OpenAPI document, MCP servers |
| `apps/web` | React + Vite UI, locale catalogs, page/panel components |
| `apps/bug-report-relay` | Optional Cloudflare Worker relaying bug reports into a private GitHub repo |
| `apps/tapo-export-runner`, `apps/ios` | Tapo history export runner; Swift/Xcode companion |
| `packages/contracts` | Shared types and validators used by API, web, and relay |
| `packages/analytics-kernel` | The one implementation of analytics statistics, counter/kWh integration, time-weighted means and local-calendar helpers |
| `packages/spatial-layers`, `packages/stuguby-protocol` | Spatial inference; Stuguby peer protocol |
| `scripts/` | Setup, local CI, release publishing, update agent, Cloudflare provisioning, their `node --test` suites |
| `deploy/` | Compose extras, MQTT/Nexus433 images, Raspberry Pi image + host updater (Python) |

`apps/api/src/app/main.ts` builds the API from named composition steps
(config, data services, telemetry, integrations, request pipeline, access
control) and then registers one route module per domain
(`app/*-routes.ts`, `apps/api/src/analytics/**/routes.ts`, `stuguby/routes.ts`,
`spatial-layers/routes.ts`). Add a route to the module that owns its domain.
Web pages/panels live in `apps/web/src/pages`, dialogs in
`apps/web/src/components`.

## Build and test

```sh
npm run build            # packages -> api -> web
npm test -w @climate-twin/api
npm test -w @climate-twin/web
npm run typecheck        # file-size + architecture checks, then all workspaces
npm run verify:local -- --fast  # diff, architecture/types, affected tests
npm run verify:local -- --full  # authoritative full gate plus exact-input receipt
```

Full verification needs Docker Desktop, Node.js 22.22.2+ (the web tests' jsdom
30; the runtime floor in `engines` and setup stays 22.13), and a Python 3.13
environment with `apps/api/python/requirements*.txt` installed; the native Apple
checks only run on macOS.

**Rebuild contracts after editing them.** `@climate-twin/contracts` resolves to
`packages/contracts/dist`, so API/web tests keep using the previous build until
`npm run build:contracts` (or `npm run build:packages`) runs. A new export that
"exists but is undefined at runtime" is almost always this. The same applies to
`@climate-twin/analytics-kernel` (`npm run build:analytics-kernel`).

## Invariants that fail loudly

- **OpenAPI parity** — every Express route must be documented exactly once with
  an `operationId` and a success response body. `apps/api/tests/openapi-parity.test.ts`
  asserts hard operation counts; adding routes means updating those numbers.
- **Locale parity** — `en`, `fi`, `sv` catalogs must have identical key sets,
  no empty strings, and matching `{placeholders}`. Finnish is assembled from
  `fi-base` + `fi-overrides` + `fi-supplement`.
- **No user-facing string literals in components** — `apps/web/src/i18n.test.tsx`
  scans UI sources; even a placeholder URL must come from a translation key.
- **Confirmation census** — `ConfirmationProvider.test.tsx` counts
  `confirmAction(` call sites; `window.confirm` is banned.
- **Source size** — 600 lines advisory, 1200 hard ceiling (`npm run check:file-size`).
- **Cognitive complexity** — `npm run check:cognitive-complexity` scores every
  function in `apps/` and `packages/` with SonarJS rule S3776 (threshold 15)
  against `scripts/baselines/cognitive-complexity.json`. A file may not gain a
  function over 15, and no listed function may get worse. Split new logic into
  named helpers. After a reduction, run `-- --update` and commit the lowered
  baseline.
- **Architecture boundaries** — `npm run check:architecture` (prototype
  registries, workspace dependency direction, no new numbered modules,
  feature-owned analytics/electricity routes, no hand-copied shared types, and
  no API-local median, percentile, time-weighted mean, local-midnight or
  kWh-conversion code outside `@climate-twin/analytics-kernel`).
- **Unused-symbol ratchet** — `npm run check:unused` (last step of
  `npm run typecheck`); see "Code quality".
- **Kernel parity** — `apps/api/tests/analytics-kernel-parity.test.ts` runs
  seeded series through the archive rollup SQL (PGlite) and the kernel-backed
  raw path; every number must agree within 1e-9. Changing either side's
  semantics means changing both.

## Code quality

These rules bind every change, by a person or an agent. Gates named here run in
`npm run typecheck`, so `verify:local` and `ci:local` enforce them. In Claude
Code, the Stop hook in `.claude/settings.json` runs
`npm run verify:local -- --fast` whenever a turn changed the worktree (edits or
commits) and keeps the turn from ending while it fails. Other agents run that
command themselves before reporting work as done.

1. **Split modules by domain, never by line count.** Name a module after what it
   owns. No new `part-NN`, `NN-name`, `name.part-NN`, `name-NN` or
   `Name.NN-slug.test` file anywhere: code, styles or tests. Gate: `check:architecture` fails on any numbered module not
   listed in `scripts/baselines/numbered-modules.json`. That list may only
   shrink; when you rename a legacy module after its domain, delete its line.
2. **Import only what the file uses.** New code has no unused imports, locals or
   parameters. A parameter that must stay for a signature gets a leading `_`.
   Gate: `check:unused` runs `tsc --noUnusedLocals --noUnusedParameters` and
   fails when a file's count rises above `scripts/baselines/unused-symbols.json`
   or a file outside it has any. After cleaning files, lock in the gain with
   `npm run check:unused -- --update`, which only ever lowers counts. The check
   also fails if the committed baseline allows more than it does on `origin/main`.
3. **Reuse existing helpers before writing new ones.** Search `packages/` and the
   owning `apps/*/src` domain (`rg -n "function <name>"`) before adding a
   helper; a second implementation of an existing one is a review blocker.
   Statistics, time-weighted means, counter/kWh integration and local-calendar
   helpers come from `@climate-twin/analytics-kernel`. Gate: `check:architecture`
   for the kernel-owned helpers; review for the rest.
4. **One canonical response shape per endpoint.** A new endpoint documents one
   success body in OpenAPI and always returns it. Clients read that shape
   directly: no `T | { key: T }` union unwrapped with `"key" in response`, and no
   multi-key list fallbacks such as `body.items ?? body.sensors ?? body`. Gate:
   OpenAPI parity requires the single documented body; the client side is
   review-enforced.
5. **Validate API responses at the boundary.** The `apps/web/src/api` function
   that fetches a new endpoint checks the body's shape with a `parse…`/`is…`
   guard and throws on a mismatch. Share the guard from
   `@climate-twin/contracts` when the API needs it too. Hooks and components
   receive typed data and never cast a response with `as`. Gate: none yet;
   review-enforced.
6. **Use an options object instead of more than three positional parameters.**
   Write `createReport(store, { houseId, from, to, signal })`, not
   `createReport(store, houseId, from, to, signal)`. Gate: none yet;
   review-enforced.
7. **Put shared types in `@climate-twin/contracts`.** A type or constant that two
   workspaces use is defined once in `packages/contracts/src` and imported,
   never hand-copied with a "keep identical" or "keep in sync" comment. Rebuild
   contracts afterwards (see above). Gate: `check:architecture` rejects such
   comments in `apps/` and `packages/` and enforces the workspace dependency
   direction.

## Versioning and pull requests

`docs/versioning.md` is binding: **every feature or breaking PR bumps the minor
version**, patch-only for fixes/docs. `npm run version:check` requires the same
version in all of these, plus a `## <version>` CHANGELOG heading:

- `package.json`, every `apps/*/package.json` and `packages/*/package.json`
- `apps/web/package.json` `@climate-twin/*` dependency ranges
- `package-lock.json` (root `version`, `packages[""]`, each workspace entry, and
  the `apps/web` `@climate-twin/*` dependency versions)
- `packages/contracts/src/measurement-analytics.ts` `SYSTEM_VERSION`
- `apps/api/src/version.ts` `SYSTEM_VERSION`
- `docs/versioning.md` ("The current release is `x.y.z`.")
- `apps/ios/project.yml` and `apps/ios/Stugu.xcodeproj/project.pbxproj`
  `MARKETING_VERSION`

Work on a branch off `main` (history uses `codex/vX.Y.Z-topic`), keep the
CHANGELOG entry user-facing with an "Upgrade impact" note, and open a PR.
`npm run release:local -- --full-ci-receipt PATH --keep-draft --publish` is a
separate, deliberate preparation step that pushes GHCR images and Pi artifacts.
Final publication consumes `release:verify` evidence; neither is part of merging
a change.

For release work, follow `docs/release-cycle.md`. It covers the private source
and public feed tags, operator-owned trust context, draft/channel side effects,
artifact audit, and appliance verification.

## Secrets and privacy

- Operator credentials entered in the UI go to the protected integration
  secrets file via `apps/api/src/integration-secrets.ts` (0600, crash-safe,
  lock-guarded). Deployment environment variables take precedence over stored
  values, and the API never returns a stored secret.
- Never commit tokens, real entity IDs, floor plans, telemetry, or databases;
  examples and tests use fake values.
