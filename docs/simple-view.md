# Simple view — plan

Status: proposal · 31 July 2026 · targets web (and therefore iPadOS/macOS) and the iPhone companion

Stugu ships one interface today, and it is the expert one. This plan adds a
**Simple** view as the default experience and keeps everything that exists now
as an opt-in **Advanced** view, selectable in settings.

## 1. Why, and what this is not

[`DESIGN.md`](../DESIGN.md) already asks for exactly this behaviour and the
product does not fully deliver it:

- §2.1 "The home comes first" — the Home page still exposes `Iso`, spatial
  layers, replay resolution in seconds, and observation confidence.
- §2.5 "Details on demand" — the Home page renders roughly 20 panels, ~40
  controls, and a 12-field observation form on one route.
- §"Attention management" — the four zones (Needs attention → Today → Key
  status → Everything else) and the four density states (Quiet, Active,
  Critical, Exploration) are described, but "Exploration" is effectively always
  on.

So Simple view is **not a new design system, not a second theme, and not a
rewrite**. It is a *visibility and defaults layer* over the existing components:
the same tokens, the same components, the same copy, the same routes. The one
hard rule for this work:

> No `Simple*.tsx` duplicates of existing pages. If a page needs a simple and an
> advanced shape, that is one component reading one flag — never two components
> that drift apart.

## 2. Current surface inventory

Fifteen destinations in `AppPage` ([`domain.ts:40`](../apps/web/src/domain.ts:40)),
grouped by the scope model in [`AppShell.tsx:173-201`](../apps/web/src/App/AppShell.tsx:173).

| Scope | Destination | Route | Nested surfaces |
|---|---|---|---|
| Workspace | Overview | `/overview` | property cards, system summary disclosures |
| Workspace | Properties | `/properties` | — |
| Workspace | People & access | `/people` | admin only |
| Workspace | Stugubys | `/stugbys` | sharing grants |
| Workspace | Alerts | `/alerts` | open alerts, monitoring diagnostics, delivery settings, rule admin, new rule |
| Property | Property | `/properties/:p` | 5 tabs: Overview, Map, Inventory, Notes, Access |
| Property | Maintenance | `/properties/:p/maintenance` | work plan, editor, history |
| Property | Electricity | `/properties/:p/electricity` | contract, price source |
| Home | Home | `/properties/:p/homes/:h` | see below |
| Home | Activity | `…/activity` | 2 tabs: Timeline, Observations |
| Home | Outdoor | `…/outdoor` | current, forecast navigator, provenance |
| Home | Electricity use | `…/electricity` | meters, optimizer, sources, cost |
| Home | Data & analytics | `…/analytics` | query builder, evidence, continuity, CSV/JSON export |
| Home | Sensors | `…/sensors` | list, filters, discovery, contact assignment |
| Home | Set up | `…/setup/:section` | 6 sections: overview, layout, connections, weather, operations, automations |
| Advanced | System | `/system` | host strain, updates |
| Advanced | API & MCP | `/developer` | tokens, routes, payloads |

**The Home page is the worst offender.** [`TwinDashboard/render.tsx`](../apps/web/src/pages/TwinDashboard/render.tsx)
renders, on one route: pulse panel, moisture coach, 4-tile summary strip, live
map launcher, a toolbar with floor picker + metric picker + 2D/3D + five layer
toggles + full-page + edit, the spatial layer panel with experimental
visualisations, floor plan or building scene, sensor inspector, room comfort
board, operations preview, a replay workspace (window from/to, resolution in
seconds, speed, event list), and a disclosure containing thermal simulation,
the spatial layer lab, room comparison, activity timeline, a mock scenario
runner, a 12-field observation composer, and a building-context parameter form.

### iOS today

- **iPhone** → `MainTabView`: Home, Sensors, Inventory, Alerts, Settings.
  `HomeDashboardView` already follows the DESIGN.md zones (attention, current
  state, today, key status, everything else). This is the closest thing to
  Simple view that exists.
- **iPad and macOS (Catalyst)** → `LargeScreenExperienceView` loads the **full
  web app in a `WKWebView`** ([`LargeScreenExperienceView.swift:5-17`](../apps/ios/Stugu/App/LargeScreenExperienceView.swift:5)).

That last point matters: **Simple view on web is automatically Simple view on
iPad and Mac.** Native iOS work is scoped to the iPhone companion plus the
settings toggle and its bridge into the web view.

## 3. The model

Two named modes, one preference, one seam.

```ts
export type ViewMode = "simple" | "advanced";
```

- **Simple** — the default. Answers "does anything need me, what changed, what
  is the home doing, what should I do next" and stops there.
- **Advanced** — today's interface, unchanged, in full.

Not three modes. Not per-page toggles. A single switch people can explain to
someone else.

### Rules that make it a layer and not a fork

1. **Routes never change.** `/…/analytics` stays valid in Simple; it renders a
   short panel naming the page and offering one button that switches to
   Advanced and stays put. Bookmarks, deep links, and the iOS deep-link handler
   keep working.
2. **Hide, then default.** Anything hidden in Simple must have a defensible
   default (metric = temperature, replay = off, observation confidence =
   `reported`, analytics resolution = auto). No hidden control may leave the
   user in a state they cannot see.
3. **One consistent escape hatch.** Every surface that hides something ends
   with the same quiet link: *"More detail in Advanced view"*. It switches mode
   and returns to the same page and anchor. One pattern, one component.
4. **Never hide the only way out.** If a connection is broken, a sensor is
   offline, or an alert needs configuration, the fix must be reachable in
   Simple — even if that means the action deep-links into Advanced and
   announces the switch.
5. **Simple is not read-only.** Guests are read-only; that is a separate,
   existing concept (`session.readOnly`) and must not be conflated with this.

## 4. What Simple view shows

### Navigation

Simple hides the entire **Advanced** group and the specialist Home items.

| Group | Simple | Advanced adds |
|---|---|---|
| Workspace | Alerts; Overview and Properties only when more than one property exists | People & access, Stugubys |
| Property | Property, Maintenance | Electricity (contract) |
| Home | Home, Activity, Outdoor, Electricity use, Sensors, Set up | Data & analytics |
| Advanced | *(group not rendered)* | System, API & MCP |

A single-cottage owner therefore sees **eight** flat destinations instead of
fifteen across four collapsible groups.

**Constraint from DESIGN.md §7:** *"Do not place Workspace-, Property-, and
Home-owned destinations into one unlabelled list."* So Simple must not simply
flatten the sidebar. Instead, when there is exactly one Property and one Home,
render the group labels as **static headings rather than `<details>`** — scope
stays visible, but there are no disclosure widgets to operate. This keeps the
IA contract intact while removing two interactive elements.

### Per page

| Page | Simple keeps | Simple hides (Advanced only) |
|---|---|---|
| **Home** | Pulse panel, moisture coach, 3-tile summary (drop *Spread*), room comfort board, live map (2D/3D, floor + metric picker, full page, edit), sensor inspector, operations preview, a 3-field quick note | Five map layer toggles (sensible defaults applied), spatial layer panel and experimental visualisations, replay/history workspace, the whole "Analysis and specialist tools" disclosure — thermal simulation, spatial layer lab, room comparison, activity timeline, mock scenarios, 12-field observation composer, building-context parameters |
| **Activity** | Timeline | Observations tab, revision history, provenance fields |
| **Outdoor** | Current conditions, one-line implication, today's forecast strip | Dew point / pressure / visibility / cloud cover table, forecast window navigator controls, model provenance |
| **Electricity use** | Current power, today's use and cost, top devices | Contract editor, price API / margin / monthly fee, optimizer internals, cost-basis explanations (keep one line) |
| **Sensors** | Sensors grouped by room: name, reading, battery, online state; guided add | Status and type filters, archived, discovery internals, hardware IDs, contact-sensor legacy assignment, analytics metric picker |
| **Set up** | Overview (progress + next step), Connections (guided, one provider at a time), Weather (location) | Layout (reachable from Home → Edit), Operations, Automations, and the existing `setup.advanced*` direct-configuration panels |
| **Alerts** | Needs-attention groups, acknowledge, "why am I seeing this" | Rule creation and admin, delivery settings, monitoring-unknown diagnostics; acknowledged history collapses to a count |
| **Property** | Overview, Map (view-only), Inventory, Notes | Access tab, area drawing and boundary editing, equipment placement editor |
| **Maintenance** | Work plan, mark done, add task (title + date) | History disclosure, predictive detail |
| **Overview** | Property cards with status | System summary disclosures |
| **Analytics, System, API & MCP, People, Stugubys** | *not rendered* — route resolves to a one-panel explanation with a switch button | everything |

`setup.advanced*` translation keys already exist — the codebase has precedent
for this exact distinction, which is a good sign the seam is in the right place.

### iPhone companion

| Surface | Simple | Advanced adds |
|---|---|---|
| Tabs | Home, Sensors, Alerts, Settings | Inventory (equipment/QR/tracking) |
| `HomeDashboardView` | Needs attention, Current state, Today, Key status | "Everything else" detail |
| `SensorDetailView` | Reading, trend, battery | Calibration, hardware identifiers, raw history |
| `SettingsView` | Connection, Account, Notifications, Display, About | System updates, Equipment observation, full Privacy detail |

## 5. Where the setting lives

**Web** has no settings page; language and units live as `compact-field`
selects in the sidebar foot ([`AppShell.tsx:418-432`](../apps/web/src/App/AppShell.tsx:418)).
Add a third select there — *View: Simple / Advanced*. It matches the existing
pattern exactly, adds no route, and is reachable from the mobile drawer.

A dedicated workspace **Settings** page (language, units, view, theme) is the
better long-term home once this list grows past three items, but it is not
needed for this change and would add a sixteenth destination to the very
navigation this work is trying to shorten.

**iOS** already has `SettingsView` → *Display* (units). Add the *View* picker
there. It stays visible in both modes — it is the escape hatch.

## 6. Storage, and the cross-surface problem

Preferences today are **localStorage only** (`readLocalStorage` /
`writeLocalStorage`, keys prefixed `stugu-`), and iOS keeps its own copy in
`AppModel`. Units and locale already suffer this split: changing units on
iPhone does not change them on web.

Ship in this order:

1. **Now — client-local.** `stugu-view-mode` in localStorage on web,
   `@AppStorage` on iOS, read through a single `useViewMode()` hook (web) and
   one `AppModel.viewMode` property (iOS). Everything else in this plan depends
   only on that seam, not on where the value is stored.
2. **iPad/Mac bridge.** The native *View* picker must reach the web view.
   Inject the value with a `WKUserScript` at
   `.atDocumentStart` before load in `LargeScreenExperienceView`, writing
   `stugu-view-mode` into localStorage for the trusted origin. Without this, an
   iPad user toggling native Settings sees no change in the web app, which
   reads as a bug.
3. **Later — server-backed.** Add `preferences: { viewMode, units, locale }` to
   `AppSession` with a small `GET`/`PUT /api/preferences`. This is the honest
   fix for all three preferences at once and retires the injection hack. Worth
   doing, out of scope here.

## 7. Default, and the upgrade moment

Simple should be the default — a default that only new users get is not a
default. But flipping existing installs silently would read as features being
deleted.

**Recommendation:** default to Simple for everyone, and on first render after
the upgrade show a one-time dismissible notice — *"Stugu now opens in Simple
view. Advanced view has everything, any time, in the sidebar."* — with an
inline switch. Honest, reversible, one interaction.

The alternative (keep existing browsers on Advanced by inferring "returning
user" from legacy `climate-twin-*` localStorage keys) is fragile, invisible,
and leaves two populations on different defaults forever. Not recommended.

## 8. Implementation phases

**Phase 1 — the seam (small, unblocks everything)**
- `viewMode.ts`: type, storage key, `useViewMode()`, `ViewModeProvider`.
- `AdvancedOnly` wrapper + the shared *"More detail in Advanced view"* link
  component. One implementation, used everywhere.
- Sidebar-foot select in `AppShell`.
- `test/setup.ts`: set the key to `"advanced"` in `beforeEach`. **This one line
  keeps all 116 existing web test files passing unchanged** — they were written
  against the advanced surface, and `localStorage.clear()` already runs there.
  New Simple tests opt in explicitly.

**Phase 2 — navigation**
- Filter `workspaceNavItems` / `propertyNavItems` / `homeNavItems` /
  `advancedNavItems` by mode. The existing `canManagePeople`, `readOnly`, and
  `propertyElectricityAvailable` filters are the precedent to follow.
- Static group headings instead of `<details>` in the single-property case.
- Route guard: hidden pages render the switch panel, never a 404.

**Phase 3 — Home page** (largest single piece; do it alone)
- Gate the tools disclosure, replay workspace, spatial layer panel, and layer
  toggles.
- Quick-note form replacing the observation composer in Simple.
- This is where the temptation to fork will be strongest. Resist it.

**Phase 4 — remaining web pages** — Sensors, Set up, Alerts, Outdoor,
Electricity use, Property, Maintenance, Overview. Independent of each other and
parallelisable.

**Phase 5 — iPhone** — tab filtering, `HomeDashboardView` / `SensorDetailView`
/ `SettingsView` gating, the *View* picker, the iPad `WKUserScript` bridge.

**Phase 6 — documentation and gates**
- `DESIGN.md` needs three edits: a new §2 subsection defining Simple/Advanced;
  an amendment to §6, which currently states *"Only the iPhone companion
  intentionally reduces navigation and workflow density"* — no longer true once
  web has Simple view; and the §7 navigation label list gaining *View*.
- `CHANGELOG.md`, and the iOS `README.md` note about the large-screen web view.

## 9. Risks

| Risk | Mitigation |
|---|---|
| **i18n throws at startup.** `completeCatalog()` in [`i18n.tsx:15-22`](../apps/web/src/i18n.tsx:15) throws on any key present in `en` but missing from `fi` or `sv`. A partial translation is a white screen, not a fallback. | Every new key lands in all three catalogs in the same commit. Non-negotiable. |
| Existing tests assert on hidden controls | One line in `test/setup.ts` (Phase 1). |
| Simple strands a user in a broken state | Rule 4 above; audit every error and empty state for its recovery path before shipping each page. |
| The two modes drift into two products | No duplicate page components; one flag, one component. Review gate. |
| Accessibility regressions in a new layout path | DESIGN.md §10 is a release gate and applies to *both* modes: 320 px, 200% and 400% zoom, keyboard, NVDA/VoiceOver, light/dark, reduced motion, colour-vision simulation. |

## 10. Open decisions

1. **Default for existing installs** — Simple with a one-time notice
   (recommended), or preserve Advanced for returning browsers?
2. **Maintenance and Inventory in Simple** — kept here as consumer-relevant for
   a cottage owner. If the real user is a property manager, they belong in
   Advanced instead.
3. **Server-backed preferences** — do it now as part of this work, or later as
   its own change that also fixes units and locale? Later is assumed above.
