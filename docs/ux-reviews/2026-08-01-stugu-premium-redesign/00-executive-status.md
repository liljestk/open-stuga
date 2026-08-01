# Stugu premium experience review — executive status

Date: 1 August 2026

Baseline: `main@827cf0d` (`0.27.1`)

Review mode: A — a real web product was inspected in an isolated demo runtime; Apple surfaces were reviewed statically because Xcode and Apple devices are unavailable on Windows. The current-state census was frozen before changes; final implementation status is reported separately below.

## Outcome

Stugu already has a strong premium foundation: a durable Workspace → Property → Home model, calm decision layers, canonical scoped routes, complete web localisation, coherent light/dark themes, and meaningful accessibility work. A wholesale visual reset would erase useful product maturity.

The approved target is a premium evolution rather than a visual reset. The
responsive-web implementation programme is now complete while preserving
canonical routes, server authority, retained domain data, telemetry ownership,
and integration authority. iOS acceptance is explicitly deferred.

Implemented across the completed programme:

- unknown monitoring is separated from actionable **Needs attention**;
- the Home Electricity optimizer identifies its Property-wide scope;
- ready-state iOS errors become visible and dismissible;
- the large-screen inventory deep link reaches Property Inventory;
- primary Workspace navigation returns to three everyday destinations, with administration under Advanced;
- Add Home, Add Property, and note editing start behind contextual disclosures;
- four invalid CSS tokens and Setup Operations dark-mode fallbacks use canonical semantic tokens;
- long Setup disclosure help wraps instead of being clipped;
- production CSS has zero runtime `--pine*` references, zero sub-10 px declarations, zero numeric weights above 700, separated focus rings, and canonical 5/10 px radius tokens;
- all 37 current production confirmation call sites use the shared structured dialog with safe initial focus, Escape, action-specific labels, and focus restoration; this includes the frozen 32 native confirmations plus five formerly inline consequential actions;
- meaningful Property/Home evidence controls use validated, default-omitting URL state and restore on refresh and `popstate`: Property map/inventory, Home dashboard, Activity, Outdoor, Maintenance, Electricity, Sensors, and Analytics;
- a copied Home deep link auto-opens its visible floor, metric, view, sensor, and range state;
- the final production Chromium matrix rendered 27 requested routes (26 unique final destinations) at 320 × 568, 390 × 844, 768 × 1024, and 1024 × 768, supplementing the 1050 × 898 and 791 × 898 runs, with one `h1` and one `main`, no remaining document overflow or audited structural/accessibility defect, and no production console warning or error; phone-width defects in Inventory, both Electricity scopes, Setup Weather, and the Home editor were fixed and reverified;
- the unreachable legacy Set up Homes renderer is removed while its compatibility URL still redirects;
- ordinary user-facing copy was swept toward Home/Property/source language in EN/FI/SV, leaving implementation terms in Advanced contexts;
- 18 browser-storage key families are installation-and-principal scoped, with safe preference migration, unattributable sensitive-state discard, and logout purge;
- shared browser/API role guards cover visible developer/system/configuration actions and Property/Home/area visibility, including direct-route denial;
- Home removal is now an explicit **Hide Home** retirement flow: active Home-owned projections and writes are blocked, legacy credentials are isolated, and retained Property-owned maintenance, notes, and equipment remain editable with a **Hidden Home** label;
- the native general String Catalog is complete at 367/367 in Finnish and 367/367 in Swedish with placeholder-preservation gates;
- Watch explicitly maps known `balanced` state to success and defaults unknown/future states to neutral;
- `DESIGN.md` v1.7 records the premium constitution, URL-state, confirmation, localisation, browser-storage, token, migration, Home-retirement, lifecycle setup, and attention-management contracts.

## Coverage

| Evidence set | Frozen pre-change evidence | Final implementation state |
|---|---:|---|
| Surface/state register | 64 discovered rows | 64/64 classified `Audited with limitations`; external matrix is explicit |
| Element/content register | 31 discovered families | 31/31 classified `Audited with limitations`; family denominators retained |
| Canonical web route templates | 27/27 statically traced | Routes preserved; 28/28 meaningful canonical parser states pass (query-backed Activity and Home-context maintenance are distinct states while Set up entry resolves to overview) |
| Live-browser route evidence | 26 sampled routes at 1280 px; representative Home and Property at 320 px | Final production matrix: 27 requested routes / 26 unique final destinations at 320 × 568, 390 × 844, 768 × 1024, and 1024 × 768, supplementing 1050 × 898 and 791 × 898; one `h1`/`main`; no remaining document overflow, dangling ARIA idrefs, unnamed buttons, unlabeled controls, duplicate IDs, missing image alt, effective interactive targets below 24 px, or production console warning/error |
| Legacy route templates | 24/24 mechanically traced | Exact 24/24 legacy-form parser matrix passes; redirect/canonicalisation retained; dead Setup Homes renderer removed |
| Production UI modules | 144 web TSX + 46 Swift files inventoried | Frozen baseline census; changed-file ledger updated |
| Web localisation catalogue | 4,048 keys × EN/FI/SV | 4,159 keys × EN/FI/SV; strict parity and placeholders pass |
| Native general localisation | 367 strings; 76 FI and 76 SV | 367/367 FI and 367/367 SV; placeholder signatures match |
| CSS convergence | 188 runtime pine refs; 170 sub-10 px declarations; 119 weights above 700 | 0; 0; 0, enforced by static gate |
| Confirmations | 32 `window.confirm` production calls; five additional inline consequential actions | 37/37 current call sites route through the structured provider; no native fallback |
| Browser personal state | Unscoped families observed | 18/18 inventoried families use principal-scoped policy |
| Role/action/API policy | Sampled, not exhaustive | 35 browser capability, 10 API guard, and 32 visibility cells pass in the final suites |
| Automated tests | 70/70 baseline focused | Final web 958/958 across 140 files; focused route/deep-link state matrix 82/82 across nine files; final-tree root `npm test` passed all workspaces including API 744/744 across 121 files |
| Root static/build gates | Not applicable to frozen census | Final-tree typecheck, production build, version consistency, and `git diff --check` pass |
| Performance evidence | Not measured | Production bundle sizes and successful browser route-load/structural evidence only; the browser-control sandbox exposes no performance timing API and true Core Web Vitals tracing is unavailable because the required Chrome DevTools MCP is absent |
| Native rendered/device evidence | 0 | Still external: macOS/Xcode/device/Watch/Widget evidence required |
| Representative users/field outcomes | 0 | Still external: real AT/browser/device/user/long-duration/integration matrix required |

## Release posture

The defined responsive-web implementation work and locally available gates are
complete. Eight P0–P2 findings from the integrated senior review were fixed and
regression-tested. iOS is explicitly deferred. Cross-browser, assistive-
technology, live-hardware, representative-user, long-duration, and true Core
Web Vitals evidence remains disclosed follow-up work in the 0.28.0 addendum.

D1 — Ship with limited refinement.
