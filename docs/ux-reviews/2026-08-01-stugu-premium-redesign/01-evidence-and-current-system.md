# Evidence and current-system review

## Phase gate

The current-state audit was frozen before production or `DESIGN.md` changes. At the gate, `git status --short` was empty and the evidence baseline was `main@827cf0d`. The later diff is therefore attributable to the approved target tranche.

The counts in the current-system census below remain historical evidence, not a
description of the final tree. A separate post-change reconciliation was made
after the deferred implementation completed. Historical tranche totals remain
labelled separately from the final repository-wide rerun.

## Evidence hierarchy used

1. Running web product in an isolated local demo API/database.
2. Browser inspection at desktop and 320 px phone width.
3. Source, routes, permissions, state ownership, persistence, and migration documents.
4. Existing tests and focused baseline verification.
5. Static review of iPhone, iPad, macOS, Watch, and Widget code.
6. Current official guidance, used as a decision aid rather than a substitute for Stugu’s domain constraints.

The isolated review account and SQLite files lived only under `.tmp-runtime`; no production credentials or user data were changed. The persisted project database was read only.

## Product and architecture map

```text
Workspace
├─ Overview · Properties · Alerts
├─ Advanced administration · sharing · system · API/MCP
└─ Property (0..n Homes)
   ├─ map · areas · equipment · notes · access · maintenance · contract
   └─ Home
      ├─ Home · Activity · Outdoor · Electricity use · Sensors · Analytics
      └─ Set up · layout · connections · weather · operations · automations
```

React 19/Vite provides the web UI; Express 5 and SQLite own the control plane; optional Timescale owns permanent telemetry; SSE coordinates live state. SwiftUI supplies the iPhone companion, while iPad/macOS embeds the full web product with a native offline fallback. Watch and Widget expose glanceable monitoring.

Roles are `owner`, `admin`, `member`, `guest`, and `service`. Property, Home, and area grants constrain access. Owners/Admins manage people, Stugubys, and System. Guests are read-only and do not see Set up. The final implementation centralizes matching browser and API role guards, hides unavailable actions and API/MCP content, protects direct routes, and encodes Property/Home/area grant visibility. Live multi-session verification remains part of the external release matrix.

## Frozen pre-change inventory and interaction census

- 15 `AppPage` values; 27 canonical and 24 legacy route templates.
- 77 production page TSX modules and 67 production component TSX modules.
- 46 production Swift files.
- Web JSX mechanical census: 455 buttons, 222 inputs, 146 selects, 16 textareas, 47 forms, 21 anchors, 23 tables, 15 SVGs, and 113 `details`/`summary` disclosures.
- 4 web tablists; 3 conditional dialog surfaces; 2 discovery toasts; 32 browser confirmations.
- Native: 5 root phases, 5 iPhone tabs, 20 sheets, 2 full-screen covers, 6 confirmation dialogs, 6 alerts, and 6 disclosure groups.
- 4,048 web translation keys with strict EN/FI/SV catalogue completeness.

The exact route and state register is in `02-surface-register.csv`; the element and content register is in `03-element-content-register.csv`.

## Post-change implementation reconciliation

- Production `--pine*` consumption moved from 188 references to zero; root
  compatibility declarations remain for installed-style safety only.
- The 170 sub-10 px declarations and 119 numeric weights above 700 both moved
  to zero. Explicit focus rings are separated by 3 px, and canonical 5/10 px
  radii use design tokens. Remaining literal colours and shape variants belong
  to documented brand, map, data, status, or geometric treatments rather than
  an open release blocker.
- All 37 final production confirmation call sites now enter one structured
  dialog: the frozen 32 native confirmations plus five formerly inline
  consequential actions. Direct page-level `window.confirm` calls are absent
  and the helper fails closed when its provider is not mounted.
- Activity nested view state is URL-backed, and the dead Set up Homes renderer
  is gone while `/setup/homes` remains a tested compatibility redirect.
- The final parser matrix covers 28/28 meaningful canonical states and all
  24/24 documented legacy URL forms. This does not replace the frozen
  27-template surface denominator: Activity Observations and Home-context
  maintenance are distinct query states while the canonical Set up entry
  resolves to the same state as its overview route.
- Browser-history assertions cover Property/Home scope, Property tabs, Set up
  tabs, and validated page-owned URL state for Property map/inventory, Home
  dashboard, Activity, Outdoor, Maintenance, Electricity, Sensors, and
  Analytics. Defaults and invalid or out-of-scope IDs canonicalize away while
  unrelated query parameters and hashes survive. A complete live-browser
  Back/Forward/reload matrix remains release-candidate evidence.
- All 18 inventoried browser-storage key families have an explicit
  migrate-or-discard policy under a hashed installation/principal namespace.
- Browser capability, API guard, and server-visibility matrices encode 35, 10,
  and 32 cells respectively. These are tranche denominators, not a claimed
  final repository-wide test total.
- Native general localisation moved from the frozen 76/367 FI and 76/367 SV
  census to 367/367 for each locale, with source/translation placeholder
  signatures checked by Swift and Windows-portable static tests.
- The web catalogue grew from the frozen 4,048-key census to 4,159 keys, with
  exact EN/FI/SV key and placeholder parity in the final web suite.

## Runtime observations

The frozen pre-change browser sample covered 26 representative routes at 1280 px, plus representative Home and Property views at 320 px. Every sampled page had one `h1`, and no sampled page-level horizontal overflow was observed. This remains historical sample evidence, separate from the later final production matrix across four phone/tablet viewports. The responsive drawer trapped focus and restored it, the shell exposed scope through URLs and selectors, and the sampled Home decision layers read well on a phone.

Observed baseline friction was structural rather than cosmetic:

- Property’s first phone viewport was dominated by always-open creation forms.
- People & access and Stugubys lengthened the everyday Workspace rail despite the documented three-item primary IA.
- unknown monitoring could be presented as “Needs attention”;
- a Property optimizer appeared inside a Home page without a Property scope label;
- Setup disclosure help was clipped to one line;
- Setup Operations used light-only fallback colours in dark mode;
- invalid token names silently removed backgrounds, borders, and error colour.

Every item in this observed-friction list has a recorded final implementation
disposition in `04-findings-and-target-experience.md`. The before/after images
remain evidence for the first implementation tranche; later static migrations
do not retroactively gain browser screenshots.

Before-state images are stored in `evidence/`. Full-page mobile capture was excluded because the browser tool duplicated the document; only normal-viewport evidence is used.

## Persistence and installed-base constraints

SQLite is authoritative for control-plane data. Integration secrets live in a protected secrets file; Timescale may hold permanent telemetry. The browser persists locale, units, map/display preferences, dismissed notices, hidden insight fingerprints, experimental views, and job IDs. This was unscoped in the frozen baseline. The final implementation inventories 18 key families, namespaces them by installation and signed-in principal, migrates only attributable presentation preferences, discards unattributable hidden/dismissed/job state, and purges the active namespace on logout or unauthorized session loss.

iOS stores credentials in Keychain and uses versioned UserDefaults/cache schemas with a bounded history and pending offline actions. Existing real-telemetry resources fail closed on hierarchy moves until immutable historical ownership lineage exists. The completed web programme preserves domain ownership, telemetry ownership, and server-side grant data, while deliberately evolving Home removal into retirement: SQLite records a Home tombstone, active Home-owned projections and writes are filtered, legacy credentials are archived against the retired Home, and Property-owned maintenance, notes, and equipment remain editable. A detached remote Stuguby projection is hard-purged because it is a cache of remote authority rather than local retained history.

## Retrieved external guidance and implementation mapping

Accessed 1 August 2026, in this order:

1. [Apple HIG — Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines?lang=en): hierarchy, harmony, and consistency.
2. [Apple HIG — Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles): purpose, agency, responsibility, familiarity, flexibility, simplicity, craft, and delight; the supporting guidance also requires recovery, context preservation, inclusive inputs, and platform intention.
3. [Apple HIG — Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility/): adaptable interfaces, larger text, sufficiently sized controls, keyboard access, and reduced cognitive complexity.
4. [Apple HIG — Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding): fast, optional, contextual learning and postponed nonessential setup.
5. [Apple HIG — Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls): keep essentials visible and hide details until relevant with descriptive labels.
6. [Apple HIG — Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons): clear purpose, familiar semantics, and role-appropriate styling.
7. [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/): the normative web target, including reflow, focus not obscured, dragging alternatives, and 24 × 24 CSS-pixel target size at AA.

Additional official Apple sources mapped during the final truth pass:

- [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts): use interruption sparingly for essential, actionable information; mapped to structured consequential confirmations and the recoverable native ready-state error.
- [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): reserve persistent tabs for primary destinations; mapped to the focused five-tab iPhone companion and URL-backed web Activity subview without adding another root destination.
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): expose hierarchy and selection predictably; mapped to scoped Workspace/Property/Home groups and role-aware Advanced visibility on iPad, macOS, and web.
- [Designing for watchOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-watchos): prioritize brief, glanceable, immediately useful state; mapped to conservative cached, stale, and unknown Watch presentation.
- [Complications](https://developer.apple.com/design/human-interface-guidelines/complications): show essential dynamic content and meaningful freshness across supported families; mapped to the Widget/Watch runtime evidence gate, not treated as proven on Windows.
- [Localizing and varying text with a string catalog](https://developer.apple.com/documentation/xcode/localizing-and-varying-text-with-a-string-catalog): complete shipped languages and preserve placeholders, plurals, and device variants; mapped to 367/367 FI/SV and strict placeholder checks, with Xcode/device layout still pending.
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility/): support adaptable interfaces, Dynamic Type, sufficiently sized controls, keyboard and assistive access, and reduced cognitive complexity; mapped to the external Apple-device and assistive-technology matrix.

Adopted: hierarchy, consistency, contextual onboarding, progressive disclosure, accessible targets, explicit states, and context preservation. Adapted: Stugu keeps denser evidence views where climate diagnosis needs them and uses web-native semantics rather than copying Apple visuals. Rejected: no “Liquid Glass” restyle, platform cosplay, or Apple-only navigation model; Stugu remains a cross-platform local-first system.

## Evidence limits

Still not tested in the final implementation working tree: macOS Swift/Xcode compilation; native rendering; Dynamic Type; real iPhone/iPad/macOS/Watch/Widget behaviour; VoiceOver/Safari/iOS and NVDA/browser use; the complete Firefox/WebKit, zoom, forced-colour, reduced-motion, and colour-vision matrix; real role/grant sessions; long-duration lifecycle and integration behaviour; field conditions; or representative users. iOS is explicitly deferred from the present web completion. These are release evidence gaps, not implicit passes.
