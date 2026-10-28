# Source file modularization

Status: implemented on 2026-07-26; policy revised on 2026-07-30.

## Baseline

The audit covered production code and tests in:

- `apps`, including the web, API, Python bridge, and export runner
- `packages`
- `scripts`, `config`, and `deploy`

At the starting revision, 82 files exceeded 600 physical lines and together
contained 128,271 lines. The largest concentration points were:

| File | Lines | Main concern |
| --- | ---: | --- |
| `apps/api/src/db.ts` | 11,046 | Schema, migrations, repositories, and queries shared one module |
| `apps/api/src/app.ts` | 6,962 | Runtime assembly and unrelated route families were coupled |
| `apps/web/src/i18n.tsx` | 4,875 | Runtime translation logic and locale catalogs were combined |
| `apps/api/src/stuguby/service.ts` | 4,651 | Federation workflows and supporting policy lived together |
| `apps/api/src/openapi.ts` | 3,585 | Every API domain contributed to one specification module |
| `apps/web/src/styles.css` | 3,490 | Global, component, responsive, and feature styles were interleaved |
| `packages/contracts/src/index.ts` | 2,727 | Unrelated domain contracts shared one public entry point |

The recurring problems were mixed responsibilities, broad dependency surfaces,
hard-to-isolate tests, and merge conflicts around central files.

## Target boundaries

| Area | Boundary aimed for |
| --- | --- |
| Web application | Small public facades with feature-specific component, hook, API, locale, data, and style modules |
| API runtime | Route registration and runtime assembly split by API domain |
| Persistence | Database schema/migrations separated from domain repositories and query groups |
| Stateful services | Construction/state kept in the facade; behavior grouped into focused modules |
| OpenAPI and MCP | Domain-specific registration/specification sections behind the existing entry points |
| Shared contracts | Contracts grouped by business domain and re-exported through stable package barrels |
| Spatial propagation | Signal modeling, analysis, and engine orchestration separated |
| Operational scripts | Argument/configuration, external clients, operations, and executable orchestration separated |
| Tests | Reusable fixtures moved to support modules; suites divided by behavior without changing assertions |
| Python bridge | Discovery, recovery, shared helpers, and runtime orchestration separated |

The prototype registries (`db`, `stuguby/service`, `stuguby/store`,
`timeseries/store`) keep one file per aggregate under `methods/`
(`methods/sensors.ts`, `methods/alerts.ts`, `methods/tapo-history-export-jobs.ts`,
...). Each file declares its methods' signatures in a `declare module` block
next to the `register…Methods` call that implements them, so there is no
mirrored declarations folder. Row types, row mappers and shared validation
live beside them under `support/`, named after what they hold.

Several areas still carry numbered legacy modules from the original split by
line count rather than by domain, chiefly the hook chains of the largest web
pages. `scripts/baselines/numbered-modules.json` lists them and may only
shrink; each is renamed after its domain when it is next changed.

Existing public import paths remain facades, so callers do not need to know the
internal layout. During the split, deferred contexts were tightened to explicit
types, unused generic escape hatches were removed, and constructor dependencies
were made explicit where staged modules previously relied on placeholder state.

## Enforced rule

`npm run check:file-size` scans the audited roots. At 600 physical lines it
prints an advisory cohesion review; at 1,200 lines it fails. The review
threshold is deliberately not a mechanical split point: modules must be split
at ownership boundaries, not at line offsets. `npm run typecheck` runs this
check first. Build outputs, dependencies, caches, and coverage are excluded.

`npm run check:architecture` rejects every new numbered module (`part-NN`,
`NN-name`, `name.part-NN`, `name-NN`, `Name.NN-slug.test`) in code, styles and
tests anywhere under the audited roots. The legacy ones are listed in
`scripts/baselines/numbered-modules.json` (336 when the list was introduced:
TypeScript, JavaScript and CSS). The list may only shrink: renaming a module
after its domain means deleting its line, and the check fails on a stale line or
on a list that gained entries relative to `origin/main`. The one exception is a
file that already existed at the merge base: when the detector learns a new
numbered form, those existing files join the list as old debt. The check additionally protects the analytics/data rewrite against
reintroduction of deleted browser derivations, direct live-stream ownership
outside the coordinator, pure analytics imports of API I/O, and query-client
resources that import the legacy bootstrap chain. `useClimateData.ts` is now a
compatibility facade over named ownership modules; the former `part-01` through
`part-10` ReturnType chain is deleted.

`npm run check:cognitive-complexity` ratchets function-level complexity. It
reimplements SonarJS rule S3776 (the "Sonar way comprehensive" cognitive
complexity rule, threshold 15) on the TypeScript AST, so it needs no ESLint
toolchain. When it was introduced in 0.42.9 it matched `eslint-plugin-sonarjs`
4.2.2 score for score on every scored function in the tree. `scripts/baselines/cognitive-complexity.json`
lists the remaining offenders per file, worst first. The check fails when a
file gains an offender or when its i-th worst function scores above the i-th
baseline entry. `-- --update` only lowers entries; moving an existing offender
into a new file means editing the baseline by hand in the same change.

## Ongoing refactoring plan

1. Treat 600 lines as the cohesion-review threshold and 1,200 as the emergency
   hard ceiling.
2. Split by ownership or domain, not merely by line range. Sequential staged
   modules are acceptable only when the workflow itself is sequential.
3. Keep facades limited to exports, dependency construction, and orchestration.
4. Put shared test setup in explicit support modules rather than duplicating it.
5. Rename staged or numbered modules to domain names when their responsibilities
   stabilize; do not let them become new catch-all files.
6. Require the size check, type checks, and affected tests for every boundary
   change.
