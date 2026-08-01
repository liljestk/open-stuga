# Findings and target experience

## Severity model

- **P0:** unsafe or unusable; blocks all release consideration.
- **P1:** trust, scope, accessibility, or core-flow defect; blocks premium release until fixed or explicitly gated.
- **P2:** material coherence/usability debt; may ship only with an owned staged plan.
- **P3:** polish or low-frequency improvement.

No P0 was found.

## Findings ledger

| ID | Priority | Current evidence | User consequence | Decision | Status |
|---|---|---|---|---|---|
| F01 | P1 | `PortfolioOverview.tsx` grouped pending/error/unconfirmed Homes as “Needs attention” | Unknown evidence appears urgent and erodes trust | Separate actionable and unconfirmed monitoring | Implemented |
| F02 | P1 | `EnergyPage.tsx` fetched a Property optimizer inside a Home page | Scope and recommendation ownership were ambiguous | Keep capability; label Property scope and name | Implemented |
| F03 | P1 | `MainTabView` did not consume ready-state `AppModel.errorMessage` | Native operations could fail invisibly | Present dismissible ready-state alert | Implemented; device proof pending |
| F04 | P1 | large-screen `stugu://inventory` opened Property overview | Deep link did not reach the promised task | Route to Property Inventory | Implemented; native runtime proof pending |
| F05 | P1 | Setup Operations used undefined fallback tokens with light colours | Dark-mode text/graphics fell as low as 1.04:1 | Use canonical theme tokens | Implemented |
| F06 | P1 | Four CSS variables were undeclared | Background/border/error declarations silently vanished | Replace with canonical tokens and add regression test | Implemented |
| F07 | P1 | Frozen census found native FI/SV at 76/367 | Supported locales broadly fell back to English | Complete translations or mark locales preview-only | Implemented: FI 367/367; SV 367/367; device layout proof pending |
| F08 | P1 | Frozen review found non-exhaustive UI/API parity and Guest exposure | Possible denial-after-action or accidental exposure | Build role/scope/action matrix and gate visibility | Implemented: 35 browser; 10 API; 32 server-visibility policy cells; live session proof pending |
| F09 | P1 | Frozen review found browser state not demonstrably account-scoped | Same-browser users could inherit hidden/dismissed state | Namespace by principal and prove logout cleanup | Implemented across 18 key families; live multi-account proof pending |
| F10 | P2 | Workspace rail had People & access and Stugubys as everyday primary items | Primary navigation was longer and less calm than the constitution | Move administration under Advanced; retain URLs | Implemented |
| F11 | P2 | Property sidebar/index showed Add Home and Add Property forms continuously | Reading and navigation competed with mutation | Contextual verb-object disclosures | Implemented |
| F12 | P2 | Notes composer was always present | Empty editor consumed half the Notes surface | Closed Record/Edit note disclosure | Implemented |
| F13 | P2 | Setup disclosure help used single-line ellipsis | Critical setup explanation was clipped on narrow screens | Wrap naturally | Implemented |
| F14 | P2 | Frozen census found 170 CSS declarations below 10 px and 119 weights above 700 | Legibility and font rendering diverged from the system | Mechanical migration with visual baselines | Implemented: final prohibited counts 0/0; visual matrix pending |
| F15 | P2 | Frozen census found 188 legacy `--pine*` references and 228 unique literal hex colours | Semantic theme governance was hard to enforce | Token codemod plus documented map/data palettes | Implemented: zero runtime pine references; remaining palette values governed; visual/CVD proof pending |
| F16 | P2 | Frozen census found 546 radius declarations across 37 values and known nested panels | Component grammar felt assembled rather than systemic | Radius convergence and grouping primitives | Implemented: canonical radii tokenized and audited nested panels flattened; visual matrix pending |
| F17 | P2 | Frozen census found 32 `window.confirm` calls plus five inline consequential actions | Destructive consequences and recovery were inconsistent | Shared structured confirmation pattern | Implemented: 37/37 final production call sites use the provider and fail closed when it is absent |
| F18 | P2 | Activity Timeline/Observations was local state | Refresh/back/copied link lost the exact evidence view | URL-backed nested state | Implemented with `?view=observations` and popstate restoration |
| F19 | P2 | Legacy Set up Homes rendering was unreachable | Dead surface expanded maintenance and audit scope | Deprecate code after compatibility proof | Implemented: renderer removed; compatibility redirect retained |
| F20 | P2 | Watch treated unknown future state as green success | Future protocol state could be falsely reassuring | Default to neutral unknown | Implemented; Watch runtime proof pending |
| F21 | P2 | Setup architecture document listed four sections while UI had six | Maintainers received contradictory IA | Update architecture record | Implemented: architecture records all six sections |
| F22 | P3 | Home/technical terminology leaked into specialist copy | Ordinary setup felt implementation-led | Plain-language sweep by route and locale | Implemented in EN/FI/SV; representative-user proof pending |

All defined code, catalogue, policy, and documentation dispositions are now implemented. Remaining evidence gaps are external/runtime validation, not deferred product implementation.

## Target experience

### Five-second promise

On opening Stugu, a person can answer: where am I; is anything actionable; what changed; how fresh is the evidence; and what is the one useful next step. Normal conditions are quiet. Unknown evidence is honest, not alarming. Specialist detail remains available without occupying the first reading layer.

### Scope model

Workspace, Property, and Home remain the durable hierarchy. Everyday Workspace navigation contains Overview, Properties, and Alerts. People & access, Stugubys, System, and API & MCP are still Workspace/System owned but live under Advanced. Moving a link does not move its data, permission, or route ownership.

A recommendation that aggregates multiple Homes says **Property scope** and names the Property. Property-owned electricity contracts never masquerade as Home consumption; Home pages can link to Property decisions but cannot silently inherit them.

### Attention and state model

Actionable exceptions alone enter **Needs attention**. Unconfirmed monitoring, incomplete setup, stale data, partial responses, reconnecting, offline, permission denial, and hard error each keep distinct language and treatment. A number without fresh evidence is not “healthy.” Unknown future protocol states default to neutral.

### Progressive action model

Collections lead with their contents. Add Home, Add Property, Record note, imports, calibration, and advanced configuration begin closed unless creation is the page’s explicit primary task. Summary labels use verb + object, sit next to what they change, retain entered state during expansion, and expose Cancel. Editing opens the same contextual editor.

### Responsive and accessible model

The shell remains a 256 px desktop rail and a focus-contained drawer at 900 px. Reading layouts stack before 680 px; tables and maps may scroll internally but never force page-level horizontal scrolling. WCAG 2.2 AA remains normative; Apple HIG influences hierarchy and platform feel but does not replace web semantics. Controls target 24 × 24 minimum and preferably 40–44 px; text and controls do not render below 10 px at defaults.

### Platform model

Web, iPad, and macOS preserve the complete domain model. iPhone stays a focused companion, with native alerts and task-appropriate sheets. Watch and Widget stay glanceable and conservative: stale, cached, unknown, and read-only states are explicit. Each platform receives native input/focus/assistive-technology treatment rather than visual imitation of another platform.

## Lifecycle scenarios

| Moment | Target behaviour | Evidence status |
|---|---|---|
| First run | Fast optional guidance; reasonable defaults; setup near the affected Home | Web source/live reviewed; native not rendered |
| First sensor value | Explain freshness and origin; do not overclaim health | Source reviewed; not field tested |
| Daily return | Actionable exceptions first; normal status compressed | Live demo reviewed |
| Degraded integration | Preserve last-known value with age; recovery remains visible | Source reviewed; integration matrix not run |
| Seasonal change | Trends and comparison available behind evidence layers | Source reviewed; longitudinal outcomes not tested |
| Month six | Dismissed insights and preferences remain correct for the signed-in person | Principal-scoped storage implemented; longitudinal proof pending |
| Shared/remote Home | Authority and read-only state remain persistent | Source/live sample reviewed |
| Offline iPhone | Cached state and pending actions remain explicit | Static implementation review only; Apple device proof pending |
