# Validation and release decision

The final 0.28.0 receipts and decision below supersede overlapping historical
tranche values. See `08-v0.28.0-release-addendum.md` for the compact release
record and accepted evidence limits.

## Latest automated and static receipts

| Gate | Status | Evidence |
|---|---|---|
| Root `npm test` | Pass — final-tree receipt | Every configured workspace completed; the API suite passed 744/744 across 121 files |
| API suite | Pass — 121 files / 744 tests | Includes sensitive-route authorization, API-guard, server-visibility, Home-retirement, and MCP-parity coverage |
| Web suite | Pass — 140 files / 958 tests | Final web aggregate includes capability policy; confirmations; storage; routes; localisation; responsive regressions; semantic convergence; URL-state; Live View focus, and retained hidden-Home record coverage |
| Focused route/deep-link state | Pass — 9 files / 82 tests | Canonical and legacy routing plus Property; Home; Sensor; Activity; Outdoor; Maintenance; Electricity; Analytics; and App-level copied-link/popstate behavior |
| Tapo runner | Pass — 37 tests | Included in the successful root workspace receipt |
| Spatial layers | Pass — 34 tests | Included in the successful root workspace receipt |
| Portable native readiness | Pass — 4/4 | Native route; ready-error; catalogue; placeholder; and Watch-fallback invariants |
| `npm run build` | Pass | Packages; API; and production web build completed |
| Root `npm run typecheck` | Pass | File-size; architecture; and every workspace check completed |
| `npm run version:check` | Pass | Version `0.28.0` is consistent across runtime; repository; packages; Apple projects; and changelog |
| `git diff --check` | Pass | No whitespace errors |
| `npm run smoke:built-api` | Pass | Built API `0.28.0` started successfully on Node `22.22.3` |
| Claude code review | Partial provider coverage, fully disclosed | An earlier untruncated Claude/Sonnet core pass returned two medium browser-storage concerns. Revalidation confirmed that active-namespace purge on logout/session expiry is the explicit security contract and that no-email service/MCP principals are non-browser actors; focused storage/policy tests pass. A final Claude/Opus whole-tree attempt accepted the 283-file diff but hit the router safety limit and timed out after 420 seconds without returning findings. The complete diff was separately reviewed by the integrated senior review, whose eight P0–P2 findings were fixed and regression-tested |
| Swift/Xcode build | Not available | `swift`, `xcodebuild`, and `xcodegen` are unavailable on this Windows host |

## Preserved pre-final receipts

These remain useful historical checkpoints; the verified receipts above supersede them where they overlap:

| Tranche | Historical result |
|---|---:|
| Baseline focused web/API tests | 70/70 |
| Changed-surface focused web tests | 48/48 |
| Additional Property regression | 14/14 |
| Portfolio/Energy focused tests | 23/23 |
| Localisation focused tests | 9/9 |
| Canonical route tests | 23/23 |
| Earlier full web suite | 835/835 across 123 files |

## Browser validation

The current requested acceptance target is the responsive web product. iOS and
other Apple-device acceptance are explicitly deferred; portable native guards
remain useful repository checks but are not part of the web completion claim.

| Route/state | Evidence | Result |
|---|---|---|
| Frozen 26-route sample before change | Chromium at 1280 px | Every sampled page loaded with one `h1`; no sampled page-level horizontal overflow; this is not a final route-count denominator |
| Home and Property before change | Chromium at 320 px | Loaded without page-level horizontal overflow |
| Final production responsive route matrix | Chromium at 320 × 568, 390 × 844, 768 × 1024, and 1024 × 768; 27 routes requested / 26 unique final destinations | Every destination has exactly one `h1` and one `main`; no remaining document overflow, dangling ARIA idrefs, unnamed controls, unlabeled fields, duplicate IDs, missing image alt, or effective interactive target below 24 px |
| Earlier desktop and narrow-desktop matrix | Chromium at 1050 × 898 and 791 × 898 | The same structural and accessibility sweep passed after the Setup Weather defect was fixed |
| Final structural/accessibility sweep | Same production matrix | No dangling ARIA idrefs; unnamed buttons; unlabeled controls; duplicate IDs; missing image alt; or effective interactive target below 24 px |
| Responsive defect rechecks | Chromium at 320 × 568 | Inventory, Property Electricity, Home Electricity, Setup Weather, and the expanded Home editor were fixed at their real min-content/grid causes and reverified with `scrollWidth === clientWidth` |
| Mobile overlays, localisation, and shell | Chromium at 320 × 568 plus 900/901 px boundary | Drawer focus/body-lock behavior is regression-tested; Historical Import keeps actions reachable with an internally scrolling body; FI/SV People and drawer copy do not overflow; the shell changes modes cleanly at 900/901 px |
| Copied Home deep link | Final production app | The copied URL auto-opens its visible floor; metric; view; sensor; and range state |
| Activity Observations | Final live app | `?view=observations` survives Back and Forward and restores the selected tab |
| Legacy Set up Homes URL | Final live app | Redirects to canonical Property without retaining the dead renderer |
| Structured destructive confirmation | Final live app | Safe Cancel receives initial focus; Escape closes; trigger focus is restored; no mutation performed |
| Production console | Final production route matrix | No warning or error entry observed |
| Performance evidence | Production bundle sizes plus successful browser route-load/structural checks | The browser-control sandbox exposes no performance timing API; true Core Web Vitals tracing was unavailable because the required Chrome DevTools MCP is absent |

## Route, authorization, history, and recovery validation

| Concern | Automated evidence | Limitation |
|---|---|---|
| Canonical routes | 28/28 meaningful parser states cover Workspace, Property, Home, Activity query state, Home-context maintenance, and all six Set up sections; page-owned query states are tested separately | The frozen census remains 27 route templates; the parser count does not turn the frozen 26-route browser sample into a final browser matrix |
| Legacy compatibility | 24/24 documented URL forms parse with the legacy marker and retain canonical migration behavior | Only the legacy Set up Homes redirect was exercised in the final live browser |
| Direct-route authorization | Guest `/developer`, `/stugbys`, `/people`, `/system`, and `/setup/connections` assertions deny access before privileged requests; a foreign shared Home denies Set up before requests; People has owner/admin/member/guest/service page coverage and client-side invalid-email validation | Principals and grants are simulated; the live multi-session and non-browser service/MCP matrix remains external |
| Recovery | Integrated tests cover backend-unavailable retry and unknown-route return to overview; the route boundary test covers focused fallback, reload, and reset after navigation | Real network outage, production chunk failure, and browser reload behavior remain external |
| History | The 82-test focused route/deep-link matrix covers canonical and legacy routing plus Property; Home; Sensor; Activity; Outdoor; Maintenance; Electricity; Analytics; and App-level copied-link/popstate behavior; live evidence confirms Activity Back/Forward and a copied Home URL auto-opens visible state | Real Firefox; Safari/WebKit; and multi-session restoration remain external |
| Page-owned query state | Meaningful evidence controls use the exact validated schemas below; defaults and invalid/out-of-scope IDs canonicalize away while unrelated query parameters and hashes survive | Real cross-browser and live-session restoration remain release evidence |

### Page-owned URL schemas

| Surface | Query contract | Default/canonical behaviour |
|---|---|---|
| Property map/inventory | `structure-search`; `map-search`; `map-type={home,asset,equipment,person}`; `map-layers=<comma kinds>` or `none`; `map-item={home,asset,equipment}:<id>` or `none`; `inventory-search`; `inventory-status={active,out-of-service,retired}`; `inventory-location={pinned,unassigned,house:<id>,area:<id>}`; `inventory-item=<equipment id>` | Empty/all/default selection omitted; Property-scoped IDs validated; typing replaces and discrete selections push history |
| Home dashboard | `floor=<floor id>`; `metric=<enabled metric id>`; `view=isometric`; `sensor=<enabled sensor id on selected floor>`; `range={6h,7d}` | First floor, temperature or first supported metric, plan, first enabled sensor, and `24h` omitted; cross-floor/invalid values canonicalize |
| Activity | `view=observations`; `status={open,resolved,critical}`; `search=<text>` | Timeline/all/empty omitted; typing replaces and choices push history |
| Outdoor | `forecast={12-24,24-36,36-48}` | First 12-hour window omitted; keyboard and `popstate` restore selection |
| Maintenance | `filter={overdue,upcoming,in-progress,completed}`; `basis={required,scheduled,condition-based,predictive,optional-improvement}`; `search=<text>` | Active/all/empty omitted; typing replaces and choices push history |
| Electricity | `range={6h,7d,30d,90d,1y}`; `metric={energy,electricity_price}`; `cost={1h,24h,7d,year}` | `24h`, power, and month omitted; invalid values canonicalize |
| Sensors | `urgency={live,waiting,unplaced,archived}`; `detail=sensor/<id>`, `contact/<device id>`, or `contact/<connection id>/<device id>`; `range={6h,7d}` | All/no detail/`24h` omitted; missing or out-of-scope detail targets canonicalize |
| Analytics | `range={6h,7d,30d,90d,1y}`; `resolution={raw,1m,5m,15m,1h,1d}`; `aggregation={mean,sum,delta,last,time_weighted_mean,min,max}`; `quality={good,all}`; `metric=<enabled metric id>`; `sensors=<sorted comma IDs>` or `none`; `weather={observations,forecast,none}` | `24h`/auto/default/reliable/default metric/all compatible sensors/both weather overlays omitted; IDs and metric-compatible aggregations canonicalize |

## Major-flow automated-coverage audit

| Flow family | Automated evidence | Manual-only or incomplete evidence |
|---|---|---|
| Authentication and session lifecycle | Focused receipt: 138/138 tests across 17 files covering sign-in, owner setup, invitations, cookie/CSRF/logout/401 handling, cross-tab auth epochs, bootstrap/SSE/resource lifecycle, and principal-scoped storage | Real browser cookies across multiple accounts; expiry during long work; live identity-provider and invitation delivery |
| Authorization and scope | 35 browser capability cells, 10 API guard cells, and 32 server visibility cells; direct route and five-role People assertions add integration evidence | Real owner/admin/member/guest sessions; changing grants mid-session; service and read-only MCP remain non-browser principals |
| Client validation | Page tests cover representative invalid, required, stale, and server-error paths; People now proves invalid email stays client-side | There is no claim of one automated invalid-state case for each of the frozen 222 inputs, 146 selects, 16 textareas, and 47 forms; locale/input-method combinations remain external |
| Core CRUD | Existing page suites exercise Property, Home, floor/room layout, area, equipment attachments/links, notes, guest access, Stuguby, sensor/binding, observation, maintenance, alert, integration, electricity-contract, and system-setting mutations | Real database/network concurrency, interrupted writes, multi-client conflicts, and long-duration reconciliation remain external; no artificial universal CRUD denominator is claimed |
| Home retirement | API and web regressions cover tombstoning, active projection/write denial, legacy credential archival, retained Property-record editing/reassignment, truthful labels, and Stuguby projection purge | Restore/unhide is not offered; live multi-client retirement and backup/restore proof remain release-candidate work |
| Consequential and destructive actions | Static invariant confirms 38 regex hits: one helper declaration plus 37/37 production call sites. Provider and page tests cover fail-closed absence, safe cancel, explicit confirmation, failure, and focus restoration | Real destructive recovery, undo where supported, concurrent deletion, and every adapter failure mode require release-candidate exercise |
| Historical import | 13 parser tests, 5 wizard lifecycle tests, and a sensor-page CSV-to-validated-import walkthrough cover formats, bounds, cancellation, stale work, errors, and focus | Real browser file pickers, very large device files, spreadsheet application variants, and imported-data rollback remain external |
| Export and backup | Analytics CSV behavior and Setup Operations export-scope/backup request are covered | Native browser download behavior, filesystem permissions, restored-backup verification, and release migration fixtures remain external |
| Integration install and history jobs | Seven Cloudflare tests cover new install, upgrade, one-time approval/token disclosure, popup fallback, stale setup, and accessibility; Tapo tests cover canary, automated jobs, retry/cancel/refresh, read-only action hiding, disabled state, and troubleshooting | Real vendor accounts, devices, approval windows, credentials, rate limits, offline transitions, and prolonged jobs remain external |
| System update | Seven System tests cover version/release notes, host strain/storage warnings, maintenance schedule, disconnected-agent disablement, progress, and confirmed queueing | Actual package download/install, restart, rollback, power/network interruption, and post-update migration evidence remain external |

## Accepted follow-up evidence matrix

| Matrix | Current status | Release implication |
|---|---|---|
| Production Chromium route matrix | 27 requested routes / 26 unique final destinations at 320 × 568, 390 × 844, 768 × 1024, and 1024 × 768, supplementing the 1050 × 898 and 791 × 898 runs; structural and target checks pass | Preserve as the release baseline |
| Real Firefox; Safari/WebKit; zoom; forced colours; and CVD | Not available in the completed matrix | Disclosed follow-up evidence; not represented as passed |
| NVDA/Chrome+Firefox and VoiceOver/Safari+iOS | Not available here | Web AT is follow-up evidence; iOS is explicitly deferred |
| True Core Web Vitals tracing | Browser-control exposes no performance timing API and the required Chrome DevTools MCP is absent; only production bundle sizes and measured API/fan-out evidence are available | Capture LCP, INP, and CLS later; no score is inferred here |
| Owner/admin/member/guest/service × grants × visible action/API | 77 exact automated policy cells; no live multi-session matrix | Exercise real sessions and confirm the non-browser service/MCP boundary |
| Live integration success/stale/offline/retry/redaction paths | Automated and demo coverage only | Complete with real accounts; devices; and prolonged jobs |
| iPhone/iPad/macOS/Watch/Widget compile and device runtime | Portable invariants pass; Apple runtime unavailable | Build and exercise on Apple hardware/tooling |
| EN/FI/SV native content | Static catalogues complete at 367/367 FI and 367/367 SV | Verify truncation, plural/device variants, and Dynamic Type on devices |
| Oldest/recent snapshots; backup/restore/rollback/lineage guards | Current automated tooling passes | Run the live release migration matrix at the release commit |
| First-run/daily/seasonal/month-six representative users and long-duration use | Not tested | Product outcome remains unknown |

The current browser session contract identifies local people by tenant, principal type, and email. Service and local read-only MCP principals are non-browser actors today. If either gains browser access, add a durable principal identifier before persisting personal UI state; the release session matrix must confirm that boundary.

## Final quality gate

| Required check | Status | Evidence or remediation |
|---|---|---|
| Stugu spelling is immutable | Pass | Product copy, package, routes, and changed documentation retain Stugu |
| Current-state review preceded and was frozen before target work | Pass | Clean `main@827cf0d` census is preserved separately from final state |
| Every discovered route, page, tab, overlay, role path, and meaningful state is classified | Pass | Surface register uses evidence, disposition, and explicit runtime limitations |
| Functions, components, controls, content families, colour, and background behaviour are classified | Pass | Mechanical census and element/content register retain denominators and limitations |
| Purpose and function were reviewed separately | Pass | Findings connect observed purpose failures to functional dispositions |
| No unseen UI, evidence, result, or guidance was invented | Pass | Static-only and unavailable evidence is labelled; retrieved HIG pages are named |
| Property remains first-class and usable without a Home | Pass | Domain ownership and land/equipment/notes/access/maintenance/contract/electricity remain Property-scoped |
| Presentation simplification does not move ownership | Pass | Routes, writes, grants, telemetry lineage, and the explicit Home-retirement schema remain authoritative |
| Home Assistant was considered without dictating IA | Pass | It remains a Home connection and advanced source vocabulary |
| Every target change is traceable | Pass | F01–F22, design deltas, and implementation ledger form the trace |
| Every reviewed surface and element has a disposition | Pass | Surface and element/content CSV registers contain no unclassified row |
| Usability, comprehension, trust, and recovery outrank novelty | Pass | Target model and `DESIGN.md` v1.7 retain the existing Stugu visual language |
| Setup and lifecycle journeys are designed end to end | Pass | First use through degraded/month-six scenarios have target behaviour and evidence status |
| Arrival and first value include the product wrapping | Pass | Loading, setup, empty, permission, error, and recovery families are registered |
| `DESIGN.md` was reconciled and evolved traceably | Pass | v1.4/v1.5/v1.6/v1.7 change record and implementation rules |
| Application and design-system rules agree | Pass | Semantic, type, focus, radius, URL-state, confirmation, storage, and locale gates pass |
| Apple HIG retrieval status and use are honest | Pass | Only retrieved official pages are listed and mapped to concrete decisions |
| WCAG web targets and Apple platform units are not conflated | Pass | WCAG CSS-pixel rules are normative; Apple device verification remains separate |
| Evidence states are distinguishable | Pass | Unknown, stale, missing, partial, permission, error, and success rules are explicit |
| Consequential actions have acknowledgement and safe recovery | Pass | 37/37 production call sites use the shared safe-focus provider; it fails closed when absent and API recovery tests pass |
| Changed copy is purposeful, localisable, and placeholder-safe | Pass | 4,159-key EN/FI/SV web parity and 367/367 FI/SV native catalogues pass |
| Colour has governed purpose and non-colour reinforcement | Pass with accepted evidence limit | Automated semantic/non-colour rules pass; real forced-colour, CVD, and chart/map comprehension remain disclosed follow-up evidence |
| Shared changes cover every enumerated usage | Pass | Confirmation, storage, policy, and semantic-style denominators are enforced by tests |
| Validation covers the complete changed system | Pass with accepted evidence limit | Local web/test/build gates cover the release tree; Apple, real cross-browser/zoom/AT/CVD, CWV, live-session, integration, representative-user, and long-duration evidence is explicitly not claimed |
| Coverage claims use discovered denominators and expose limits | Pass | Frozen evidence; final web 140/958; focused route/deep-link state 9/82; final-tree root/API receipts; and external gaps are separated |
| Phase ordering and repository authority were respected | Pass | The Home tombstone migration is explicit and tested; publication is governed by the 0.28.0 release addendum |
| Final report has honest blockers and one exact decision | Pass | Defined blockers follow and the package uses one decision wording |

## Accepted follow-up work

1. After the explicitly deferred iOS phase resumes, compile and exercise iPhone, iPad, macOS, Watch, and Widget surfaces with Xcode and Apple hardware; verify FI/SV layout, Dynamic Type, offline behaviour, and the inventory deep link.
2. Complete real Firefox, Safari/WebKit, assistive-technology, zoom, forced-colour, and colour-vision testing.
3. Capture true Core Web Vitals traces; browser-control exposes no performance timing API and the required Chrome DevTools MCP is absent here, so only production bundle sizes and successful route-load/structural evidence are available.
4. Exercise live role/grant sessions, including direct routes and the service/MCP non-browser boundary.
5. Complete live integration and release migration/backup/restore/rollback testing.
6. Run representative-user and long-duration product validation.

## Decision rationale

The responsive-web product, policy, design-system, lifecycle setup, Home-retirement contract, and documentation programme are implemented. The final web suite and focused route/deep-link matrix pass; final-tree root test, typecheck, build, version, whitespace, and built-API smoke gates pass. All eight P0–P2 integrated-review findings were fixed. iOS is explicitly deferred. The named external evidence gaps remain visible follow-up work and are not represented as passes; they do not block the requested responsive-web and local-appliance 0.28.0 release.

D1 — Ship with limited refinement.
