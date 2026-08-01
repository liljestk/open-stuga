# Redesign specification and design-system deltas

## Disposition summary

| Surface/system | Keep | Improve | Move | Deprecate |
|---|---|---|---|---|
| Workspace everyday IA | Overview; Properties; Alerts | Active-group clarity | People & access; Stugubys to Advanced | None |
| Property | Scope; tabs; map; inventory; access; maintenance | Creation and note disclosure | None | None |
| Home | Decision layers; activity; weather; sensors; analytics | Property-scope recommendation label | None | None |
| Set up | Six visible task sections; contextual onboarding | Wrapping; dark tokens | Specialist operations stay late | Dead legacy Homes renderer; compatibility redirect remains |
| Native | Focused tabs; embedded large-screen web | Visible ready errors; exact deep links; complete FI/SV catalogues; neutral Watch fallback | None | None |
| Tokens | Semantic root themes; governed contextual palettes | Enforce declared names and runtime-token gate | Legacy pine aliases converged on semantic tokens | Local light-only fallbacks and runtime pine use |
| Typography | Manrope + DM Sans; clear headings | Enforce 10 px minimum and loaded 400-700 range | None | Sub-10 px and >700 declarations |
| Confirmation | Explicit destructive intent | Shared consequence/recovery dialog with safe cancellation and focus restoration | All production confirmations into provider | Direct production `window.confirm` |
| State and access | Scoped routes; authoritative permissions | URL-backed evidence controls; principal-scoped browser state; shared policy matrices | Technical controls remain in Advanced | Guest visibility and unattributable personal state |

## Information architecture

```text
Primary rail
├─ Workspace
│  ├─ Overview
│  ├─ Properties
│  └─ Alerts
├─ Property · {name}
│  ├─ Property
│  ├─ Maintenance
│  └─ Electricity
├─ Home · {name}
│  ├─ Home · Activity · Outdoor · Electricity use
│  └─ Data & analytics · Sensors · Set up
└─ Advanced
   ├─ People & access · Stugubys
   └─ System · API & MCP
```

Canonical route templates remain unchanged. Page-owned query parameters preserve meaningful evidence state on Property map/inventory, Home dashboard, Activity, Outdoor, Maintenance, Electricity, Sensors, and Analytics; the legacy Set up Homes path remains a redirect after its dead renderer was removed. Server authority remains the source of truth while browser visibility, direct-route handling, and API actions consume explicit policy matrices.

## Component deltas

### Action disclosure

An action disclosure is a bordered, quiet summary beside the collection it mutates. It contains an action icon, verb-object label, one-line consequence/context, and directional chevron. Closed is the default. Open state reveals the form on a panel surface separated by a semantic border. The summary remains keyboard native; focus uses the global ring; reduced motion removes chevron transition.

Applied to Add Home, Add Property, and Record/Edit note. Inventory already supplied the conforming precedent.

### Scope badge

Cross-scope recommendations expose an eyebrow-style scope label plus the owning Property name. This is semantic text, not colour-only metadata. It appears before the recommendation heading and stacks at narrow widths.

### Monitoring-not-confirmed group

Overview separates three concepts: actionable attention, unconfirmed monitoring, and routine/healthy state. The unconfirmed group uses neutral/blue informational geometry and never inherits warning/critical styling.

### Ready-state native error

When the iOS app is already ready, `errorMessage` binds to a dismissible SwiftUI alert and clears only on dismissal. Pre-ready inline recovery remains unchanged.

### Structured confirmation

All 37 final production confirmation call sites use one queued HTML-dialog provider: the frozen 32 native confirmations plus five formerly inline consequential actions. The dialog names the action and consequence, gives Cancel the safe initial focus, supports Escape, and restores focus to the trigger. No native fallback remains; the helper fails closed when the provider is not mounted.

### URL-backed evidence state

Meaningful page controls are represented by compact, validated query parameters without changing canonical route templates. Defaults are omitted, invalid and out-of-scope identifiers canonicalize safely, unrelated query parameters and hashes survive, discrete choices push history, search typing replaces it, and `popstate` restores state. The schemas cover Property structure/map/inventory filters and selections; Home floor/metric/view/sensor/range; Activity view/status/search; Outdoor forecast window; Maintenance filter/basis/search; Electricity range/metric/cost interval; Sensors urgency/detail/range; and Analytics range/resolution/aggregation/quality/metric/sensor set/weather overlays.

### Principal-scoped browser state and access parity

Eighteen browser key families now live under a hashed tenant/principal namespace. Attributable preferences migrate; unattributable dismissed, hidden, and job state is discarded; logout and unauthorized transitions purge the active namespace. Browser capability, API guard, and server visibility matrices cover 35, 10, and 32 policy cells respectively.

### Native catalogue and conservative glance surfaces

FI and SV now each cover 367/367 general native strings with matching placeholder signatures; Monitoring remains 31/31 in EN/FI/SV. Watch retains explicit balanced green but unknown or future protocol states fall back to neutral.

## Token deltas

No new colour token was introduced. Invalid aliases were mapped to existing semantics:

| Invalid/local token | Canonical replacement | Meaning |
|---|---|---|
| `--surface-soft` | `--panel-soft` | quiet grouped surface |
| `--danger` | `--red` | critical/error foreground |
| `--strong-line` | `--line-strong` | emphasized boundary |
| `--canvas` | `--bg` | page/canvas background |
| Setup `--surface-muted` fallback | `--panel-soft` | themed quiet surface |
| Setup success/warning/danger/border/text fallbacks | `--positive`/`--yellow`/`--red`/`--line`/`--muted` | canonical themed semantics |

A static regression test now rejects the corrected undeclared aliases and hex fallback pattern.

The convergence pass also reduced prohibited runtime use to zero:

- legacy `--pine*` runtime references: 188 before; 0 final;
- declarations below 10 px: 170 before; 0 final;
- numeric weights above 700: 119 before; 0 final;
- literal hex use: 412/228 unique before; 401/220 unique final, with remaining map, data, brand, and contextual ramps governed;
- radii: 546 declarations/37 values before; 551/35 final, with canonical 5 px and 10 px values tokenized and functional shapes retained.

The regression gate also rejects negative focus offsets and requires explicit rings to remain 3 px with 3 px separation.

## `DESIGN.md` evolution

Version 1.4 added trust-over-drama and premium-coherence principles; the Advanced destination model; explicit Property-scope recommendation rules; unknown-vs-attention semantics; action-disclosure grammar; full live-data state language; shipped-locale completeness; semantic token enforcement; minimum type/loaded weight constraints; and migration safeguards. Version 1.5 records the completed convergence rules for URL-backed nested state, structured confirmations, principal-scoped browser storage, policy parity, neutral unknown states, and governed contextual palettes. Version 1.6 defines Home retirement, retained Property-owned context, retired-scope write denial, credential isolation, and Stuguby projection purge. Version 1.7 defines attention-managed overview hierarchy, lifecycle setup, safe inference without ownership coupling, Property-default weather with an advanced Home override, and smart-alert lifecycle rules.

## Compatibility and migration

| Contract | Change | Compatibility action | Rollback |
|---|---|---|---|
| Canonical/legacy routes | Page-owned evidence query state; dead Setup renderer removed | Canonical routes retained; defaults omitted; 24/24 legacy redirects retained | Remove query-state adapters; restore renderer only if redirect proof fails |
| Roles/grants | Visibility/action/API policy centralized | Existing server authority retained; 35/10/32 policy cells tested | Revert policy consumers without changing stored grants |
| SQLite/Timescale | Add nullable `houses.deleted_at`; no Timescale ownership change | Active APIs filter retired Home-owned projections while Property-owned records remain | Do not run an older API against tombstoned data; restore a compatible release or follow an explicitly reviewed recovery |
| Browser storage | Eighteen key families principal-scoped | Migrate attributable preferences; discard unattributable personal/job state; purge active namespace on logout/unauthorized | Remove new namespace after explicit local-state reset |
| Native deep link | Inventory target becomes exact | Same URL scheme; more specific web path | Revert one route mapping |
| Localisation | Plain-language EN/FI/SV sweep; native FI/SV 367/367 | Strict catalogue and placeholder-signature tests | Revert keys and UI labels together |
| Confirmation | 37/37 final production call sites use shared provider | Provider fails closed when unmounted; no native fallback | Revert call sites and provider together |
| CSS | Semantic convergence and static enforcement | Light/dark values already defined; contextual palettes documented | Revert selectors/tokens with gate updates |

The additive Home-tombstone migration is implemented and tested in code but was not applied to production; browser-local preference migration was exercised only in the isolated review runtime. Publication and artifact scope are recorded separately in the 0.28.0 release addendum.
