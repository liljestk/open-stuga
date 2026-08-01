# Implementation ledger

## Baseline and scope

Implementation began only after the current-state audit was frozen and `DESIGN.md` recorded the target. Baseline was clean `main@827cf0d`. Domain ownership, telemetry lineage, feature-flag defaults, production credentials, and production user data remain unchanged. URL presentation state, visible-action policy, browser-local preference scoping, copy, UI implementation, and the deliberate Home-retirement API/schema contract changed as recorded below.

## Changed production surfaces

| Area | Files | Change | Verification |
|---|---|---|---|
| Design constitution | `DESIGN.md` | v1.4 premium principles; v1.5 URL-state, confirmation, storage, access, palette, and unknown-state rules; v1.6 Home retirement; v1.7 attention management and lifecycle setup | Manual diff review + architecture gate |
| Primary IA | `apps/web/src/components/AppShell.tsx` | Three everyday Workspace links; People/Stugubys under Advanced; active-group logic updated | AppShell tests + desktop browser |
| Property actions | `PropertyManagementPage/render.tsx`; `part-02.tsx`; `part-07.tsx`; CSS | Add Home/Property and Record/Edit note disclosures; cancel and success-close behaviour | Property tests + 320 px browser |
| Overview trust | `PortfolioOverview.tsx`; related global CSS | Separate actionable attention from monitoring not confirmed | Unit tests + desktop browser |
| Electricity scope | `EnergyPage.tsx`; `EnergyPage.css` | Property scope chip names owning Property | Unit tests + desktop browser |
| Setup readability | `12-setup-connection-home-picker.css` | Long summary help wraps | Build + static/browser inspection |
| Setup dark theme | `SetupOperationsPanel.css` | Canonical theme-aware semantic tokens; no hex fallbacks | Semantic-token test + dark browser |
| CSS/system convergence | 46 web CSS files; `semantic-tokens.test.ts` | Zero runtime pine references, sub-10 px declarations, >700 weights, or negative focus offsets; canonical radii and governed contextual palettes | Semantic-token regression test + final build |
| Structured confirmation | `ConfirmationProvider.tsx`; CSS; 37 production call sites | Queued accessible dialog with safe Cancel, Escape, trigger-focus restoration, and fail-closed unmounted behavior | Static denominator + provider/page tests + live browser |
| Evidence URL state | Property and Sensor `urlState.ts`; `TwinDashboard/queryState.ts`; Activity, Outdoor, Maintenance, Energy, and Analytics pages | Validated compact query state; defaults omitted; unrelated params/hash preserved; push/replace and `popstate` restoration | Focused URL-state suites and the final 958/958 web aggregate pass, including cross-route `popstate`, Property map-to-inventory selection, and copied Outdoor/Home deep links |
| Responsive web | `EnergyPage.css`; `PropertyManagementPage.css`; global responsive CSS; AppShell and semantic regression tests | Stacked min-content pressure points, contained Home editor disclosures, full-height import modal, coarse-pointer targets, and explicit mobile location/inventory grids | 27-route production Chromium matrix at 320 × 568, 390 × 844, 768 × 1024, and 1024 × 768; 900/901 px shell breakpoint; FI/SV long-copy checks |
| Setup compatibility | `IntegrationsPage/render.tsx`; routing | Dead legacy Homes renderer removed while compatibility redirect resolves to Property | Routing/integration tests + live browser |
| Browser-local state | `browserStorage.ts`; lifecycle/discovery consumers | Eighteen key families scoped by hashed tenant/principal; safe migration and logout/unauthorized purge | Storage tests + final suite |
| Access parity | web `accessPolicy.ts`; API `access-policy.ts`; consumers | Guest/API/MCP hiding and direct-route denial; admin-only system operations; role-gated Tapo history actions | 35 browser + 10 API + 32 server-visibility policy cells |
| Home retirement | House schema/migration, database methods, integration stores, OpenAPI, Property/Maintenance UI | **Hide Home** tombstone; retired-scope projection/write filtering; legacy credential archival; retained Property-owned record editing with **Hidden Home** context; hard purge only for detached Stuguby projections | API soft-delete, lineage, integration, maintenance/property, MCP-parity, and Stuguby regressions; final API 744/744; focused web retained-record tests |
| Native error | `MainTabView.swift` | Dismissible ready-state alert clears `errorMessage` | Static review; macOS build pending |
| Native deep link | `LargeScreenExperienceView.swift` | Inventory URL reaches `/inventory` | Route tests; native runtime pending |
| EN/FI/SV copy | split web catalogues; `Localizable.xcstrings` | Plain-language sweep; native FI/SV 367/367 with matching placeholders; Monitoring 31/31 | Strict locale + native-readiness tests |
| Watch fallback | `StuguWatchApp.swift` | Explicit balanced green retained; unknown/future state defaults neutral | Portable native-readiness test; Watch runtime pending |
| Architecture | `docs/architecture.md` | Six Setup sections and page-owned evidence URL state recorded | Architecture gate |

## Tests changed or added

- `AppShell.test.tsx`: administrative link grouping and three-link Workspace assertion.
- `PropertyManagementPage.02-propertymanagementpage-2.test.tsx`: Add Home is closed by default and opens natively.
- `PropertyManagementPage.test.tsx`: contained index disclosure and padded inner form contract.
- `PortfolioOverview.test.tsx`: actionable vs unconfirmed monitoring semantics.
- `EnergyPage.test.tsx`: Property scope plus range/metric/cost URL state.
- `styles/semantic-tokens.test.ts`: enforces token, type, focus, and radius convergence.
- `ConfirmationProvider.test.tsx`: proves shared-provider use and structured dialog behaviour.
- `accessPolicy.test.ts`, `access-policy-matrix.test.ts`, and `access-visibility-matrix.test.ts`: prove browser/API/server policy cells.
- `browserStorage.test.ts`: proves principal isolation, migration, and purge behaviour.
- `App.test.tsx` and `routing.test.ts`: prove authorization, recovery, canonical states, and legacy redirect contracts.
- `OperationsPages.test.tsx`, `MaintenancePage.test.tsx`, and `DataAnalyticsPage.test.tsx`: prove Activity, Maintenance, and Analytics URL schemas, default/invalid canonicalisation, preserved unrelated state, and `popstate` restoration.
- `TwinDashboard.query-state.test.tsx` and `App.home-query-state.test.tsx`: prove Home floor/metric/view/sensor/range state and the same-Home App restoration race.
- `PropertyManagementPage.url-state.test.tsx` and `SensorManagementPage.url-state.test.tsx`: focused checks prove Property map/sidebar/inventory filters and selected evidence plus Sensor urgency/detail/range state, including scoped-ID canonicalisation, unrelated-param preservation, Property-tab continuity, and `popstate` restoration.
- `EnergyPage.responsive-styles.test.ts`, `styles/semantic-tokens.test.ts`, and `regressions.test.tsx`: prevent the 320 px Electricity, Inventory, Weather setup, editor-disclosure, coarse-target, and mobile-drawer regressions found during the final matrix.
- `house-soft-delete.test.ts`, maintenance/property regressions, and Stuguby federation coverage prove retired-scope isolation, retained-record editing, credential archival, and remote-projection purge.
- `MaintenancePage.test.tsx` and `PropertyManagementPage.03-propertymanagementpage-3.test.tsx` prove retained records remain clearly labelled and editable after a Home is hidden.
- `native-readiness.test.mjs` and `LocalizationCoverageTests.swift`: prove portable native route/error/catalogue/Watch invariants.
- Existing localisation tests assert strict EN/FI/SV completeness and placeholder integrity.

## Completed deferred scope

The scope initially recorded as deferred was completed in the same review package:

- design-system convergence and enforcement;
- complete FI/SV native catalogues;
- principal-scoped browser storage and cleanup;
- browser/API/server visibility and action parity;
- shared structured confirmations;
- URL-backed Property and Home evidence state;
- legacy Set up Homes renderer removal with redirect compatibility;
- neutral Watch fallback;
- plain-language EN/FI/SV copy and architecture reconciliation.

## Remaining external/runtime evidence

macOS Xcode/Swift compilation and Apple device/Watch/Widget runs remain unavailable on this Windows host and are explicitly deferred from this web completion. Real assistive-technology/browser/device/user, live role/grant, long-duration lifecycle, and end-to-end integration matrices also remain release evidence requirements. Service and local read-only MCP principals are non-browser actors in the current contract; that boundary must be confirmed before release, or browser access must first gain a durable principal identifier.

## Visual evidence

- `evidence/before-property-phone.png` — creation forms visible before the redesign.
- `evidence/after-property-phone.png` — contextual Add Home disclosure at 320 px.
- `evidence/after-overview-desktop.png` — three-item Workspace navigation and calm status hierarchy.
- `evidence/after-electricity-desktop.png` — explicit Property-scope optimizer.
- `evidence/after-setup-operations-desktop.png` — theme-correct specialist table.
