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

API routes are registered from `apps/api/src/app/main.ts`; the numbered
`part-NN.ts` modules are historical splits of one large registration file, not
feature boundaries. Analytics, forecast, thermal/moisture and electricity routes
live in feature modules (`apps/api/src/analytics/**/routes.ts`,
`app/electricity-routes.ts`), and the architecture check keeps them out of the
numbered parts. Web pages/panels live in `apps/web/src/pages`, dialogs in
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

Full verification needs Docker Desktop and a Python 3.13 environment with
`apps/api/python/requirements*.txt` installed; the native Apple checks only run
on macOS.

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
- **Architecture boundaries** — `npm run check:architecture` (prototype
  registries, workspace dependency direction, legacy numbered-module budget,
  feature-owned analytics/electricity routes, and no API-local median,
  percentile, time-weighted mean, local-midnight or kWh-conversion code
  outside `@climate-twin/analytics-kernel`).
- **Kernel parity** — `apps/api/tests/analytics-kernel-parity.test.ts` runs
  seeded series through the archive rollup SQL (PGlite) and the kernel-backed
  raw path; every number must agree within 1e-9. Changing either side's
  semantics means changing both.

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
