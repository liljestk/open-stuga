# Stugu brand and interface system

Version 1.9 · 4 August 2026

## 1. Brand idea

**Stugu** is Swedish for cottage. The name makes a technical home-climate system feel domestic, calm, and understandable.

**Positioning:** Stugu turns signals from the home into a clear picture of how the home feels.

**Tagline:** Your home, in balance.

**Product promise:** Open Stugu and understand the state of the home in a few seconds. Details are available, but they never obstruct the answer.

### Creative direction

The visual language combines three ideas:

- Bauhaus geometry: circles, squares, clear alignment, purposeful primary colour.
- Scandinavian warmth: off-white surfaces, honest materials, generous negative space.
- Product restraint: few effects, quiet motion, precise typography, and controls that explain themselves.

The result should feel architectural rather than decorative, warm rather than rustic, and advanced without looking technical.

## 2. Design principles

1. **The home comes first.** Say “Home,” “Room,” and “Set up” before “Twin,” “Entity,” or “Integration.” Technical language belongs in the developer area.
2. **One clear action.** Each surface gets one visually dominant next step. Secondary actions stay neutral.
3. **Geometry carries meaning.** Shape, border, icon, label, and position reinforce colour. Colour is never the only signal.
4. **Quiet by default.** Use animation only to explain a change in state or location.
5. **Details on demand.** Lead with the conclusion; reveal sensor provenance, confidence, and API detail progressively.
6. **Accessibility is a release criterion.** WCAG 2.2 AA is the minimum, not an optional polish pass.
7. **Trust outranks drama.** Unknown, delayed, stale, and partial evidence are explicit states; none may be promoted to healthy or urgent without supporting evidence.
8. **Premium means coherent.** Prefer fewer, better-composed layers, predictable placement, and platform-appropriate behaviour over ornamental effects or denser dashboards.
9. **Ask only what matters.** Infer or prefill safe, reversible values; ask when a choice changes identity, ownership, privacy, or meaning.
10. **Advanced is available, not ambient.** Expert controls remain easy to find in the relevant context, but start closed unless they are the current task.

### Scope and information architecture

Stugu has one durable hierarchy. Every screen, route, API operation, status,
and permission must identify which level owns the information:

```text
Workspace
└── Property (one or many)
    ├── Home (zero or many)
    │   ├── Floor
    │   └── Room
    ├── Area or structure
    └── Equipment
```

- **Workspace** owns the cross-property overview, aggregated alerts, accounts,
  and developer access through API & MCP.
- **Property** owns land, mapped areas and structures, wells, equipment, notes,
  access grants, maintenance work, contracts, electricity pricing, and the
  default weather location. A
  Property with no Home must remain fully usable.
- **Home** owns floors, rooms, sensors, activity, indoor/outdoor telemetry,
  consumption meters, its Tapo and Home Assistant connections, and an optional
  advanced weather-location override. It also owns the definition and run
  history of each scheduled data export.
- **Maintenance** is Property-owned and may optionally target a Home, Floor,
  Area, structure, or piece of Equipment inside that Property.

Hiding a Home is retirement, not erasure. The action and confirmation say
**Hide Home**. Active navigation and APIs exclude the Home and its Home-owned
telemetry, layout, sensors, and connections; new writes to that retired scope
fail closed. Property-owned maintenance, notes, and equipment remain visible
and editable, labelled **Hidden Home** until they are reassigned. Legacy
credentials are archived with the retired Home so they can never attach to a
different Home. Detaching a remote Stuguby projection is the deliberate
exception: purge that projection because it is a cache of remote authority,
not retained local history.

The shell keeps the selected Property in the URL and may keep one selected Home
inside it. Selecting a Home also selects its parent Property. The Home selector
shows only children of the selected Property. Back, Forward, refresh, copied
links, and a new browser session must restore the same visible scope.

Meaningful nested views are URL state too. A tab or filter that changes the
evidence someone is reading must use a stable path or query parameter when it
is useful to refresh, copy, or revisit that exact view. Back and Forward restore
the visible selection without resetting the surrounding Property or Home.

Use **Home** in user-facing copy and canonical browser routes. **House** is the
internal API/domain term and must not leak into ordinary navigation. **Site**
means the Property's land/map context; it is never a synonym for Home.

Primary navigation is scoped and deliberately short:

- Workspace: **Overview**, **Properties**, **Alerts**.
- Selected Property: **Property**, **Maintenance**, **Electricity**.
- Selected Home: **Home**, **Activity**, **Outdoor**, **Electricity use**,
  **Data & analytics**, **Sensors**, **Set up**.
- Advanced: **People & access**, **Stugubys**, **System**, **API & MCP**.

Only the current scope is expanded by default. Other scope headers stay visible
and may be opened deliberately; changing scope closes the previous group. A
Property or Home switcher appears only when there is a real choice. Account,
language, units, and sign-out live in one compact preferences disclosure rather
than competing with everyday navigation.

People & access and Stugubys remain Workspace-owned routes, but they are
administrative utilities rather than everyday primary navigation. Owners and
Admins find them under Advanced; permissions and canonical URLs remain
unchanged.

**System** describes the Stugu installation and its host, not a Workspace,
Property, or Home. Keep it outside the selected Property and Home scope. Only
Owners and Admins see it.

A shared NAS connection is installation-owned and configured from **Set up**
(with full storage controls still available under **System**). The data scope,
format, and recurrence of an export are Home-owned choices under **Data &
analytics**. Keep expert frequency and retention controls in a closed
disclosure. Do not add a generic scheduled-jobs destination until multiple job
types need one operational queue.

Map & assets, Inventory, Notes, and Access are sections inside Property. Inventory
is the Property-wide catalogue for maintainable equipment; a saved Home, area,
or map pin is the expected location, while optional tracking remains a separate,
explicitly labelled estimate with freshness and uncertainty. A scanned
equipment QR tag resolves back to this Property-owned
record before notes, issues, or borrowing actions are offered. Live member
presence on the Property map is a separate, explicit foreground opt-in: show
current accuracy, stop promptly, and do not present it as a location trail.
Activity,
Outdoor, Home electricity consumption, and Data & analytics appear only in the
selected Home group. Property electricity covers the contract and price source;
Home electricity covers meters and consumption.

A cross-Home recommendation must identify itself as Property-owned even when it
is reached from a Home page. Never place a Property-wide optimizer beneath a
Home-scoped heading without a visible Property label and an explicit route back
to the Property context.

### Attention management and progressive disclosure

Every Stugu overview should manage attention rather than display everything the system knows. Lead with what matters now, summarize routine information, and reveal evidence, history, configuration, and secondary actions only when the user asks for them.

The Home page is a calm, adaptive command centre. In a few seconds it should answer:

- Does anything need my attention?
- What has meaningfully changed?
- What is the home doing now?
- What, if anything, should I do next?

Use a stable hierarchy across Home and other overview surfaces:

1. **Needs attention.** Show only current, actionable exceptions. Omit the section when there are none.
2. **Today or current state.** Summarize the immediate situation and the most useful next action.
3. **Key status.** Present frequently checked information as compact cards with one primary value and a plain-language interpretation.
4. **Everything else.** Collapse healthy, unchanged, historical, or specialist information into a reassuring summary that can be expanded.

Unknown is not attention. Missing confirmation, pending setup, delayed data,
and unverified monitoring belong in a clearly labelled **Not yet confirmed** or
**Monitoring incomplete** group unless there is separate evidence of risk.
Reserve **Needs attention** for actionable exceptions.

Core zones remain in a predictable order so people retain spatial memory. Items may be ranked within a zone by urgency, time sensitivity, relevance, confidence, and recent activity, but personalization must not make the page feel as though it rearranges itself at random.

Support four intentional density states:

- **Quiet:** normal conditions dominate; show a minimal status summary.
- **Active:** several useful updates are ranked and grouped.
- **Critical:** one urgent issue leads and visually reduces secondary content.
- **Exploration:** the user has expanded supporting evidence, trends, or controls in place.

Compact summaries follow **icon · label · key value or status · one-line interpretation**. The collapsed state contains at most one primary action. Supporting explanation, contributing factors, history, provenance, and secondary actions belong in an inline disclosure or a clearly labelled detail view. Prefer native `details`/`summary` or a button with `aria-expanded` and `aria-controls`; expansion should preserve the user's context.

Do not place every available chart, form, and tool on an overview. Creation forms, calibration tools, simulations, imports, and advanced settings start closed unless they are the page's primary task. A disclosure label must describe its contents (for example, “Add an observation”), not use vague text such as “More.” The expanded state must remain understandable at 320 px and 200% zoom.

### Lifecycle setup contract

Setup is a guided path, not a catalogue of configuration forms. From first
owner account through the first Property, Home, and connection, each screen:

- explains the immediate value in one sentence and offers one primary next step;
- asks only for information that cannot be inferred safely, and marks inferred
  or copied suggestions with their source;
- lets the person skip nonessential steps, preserves completed work, and makes
  resuming obvious;
- detects available local or existing sources before asking for addresses,
  identifiers, credentials, or protocol details;
- keeps completed steps and expert configuration in nearby, closed disclosures;
- confirms success in context and advances to the next incomplete useful step;
  and
- provides Cancel, Back, retry, and recovery without erasing earlier work.

Inference never changes authority. The interface may suggest a Home timezone
from its Property location, reuse a typed name as a draft label, or offer saved
connection credentials after explicit confirmation. Once accepted, each value
is stored in the configuration object that owns it and can diverge independently.
Do not create hidden live bindings, merge Property and Home records, or copy
credentials, account identity, sharing policy, or secrets across boundaries.
Show where a suggested value came from and let the person replace it before
saving.

Weather setup is Property-level by default because ordinary Properties use one
local report. When no weather reference exists, a saved Property location is
used first and a saved Home map location is the fallback. Record the inferred
source so later Property changes update automatic values without replacing a
manual Home override. Home-specific weather configuration belongs in Advanced.

Use one action-disclosure pattern throughout the product:

- The collapsed summary uses a verb and object, such as **Add Home**, **Add Property**, or **Record note**.
- The summary sits next to the collection or context it changes.
- Opening the disclosure does not submit, navigate, or discard existing work.
- Successful completion closes the disclosure when that preserves context;
  validation failure keeps it open and moves focus to the first useful error.
- Editing an existing item opens the same editor with a clear **Editing** state
  and a Cancel action that restores focus to its opener.

### Smart-alert standard

An alert is an interpreted, actionable exception, not a notification feed. Before presenting one, establish that it is materially important or unusual, relevant now, actionable, not already handled, and not better combined with a related alert.

Alerts follow this lifecycle: **detected → presented → acknowledged or acted on → resolved or expired**. Resolved, expired, duplicate, and low-confidence events leave the attention surface automatically and remain available in history when that history is useful.

Rank alert groups by severity, then recency and relevance. Deduplicate repeated readings from the same cause. Each presented alert explains:

- what happened;
- the key status or value;
- why it may matter;
- what the person can do next; and
- why Stugu is showing it, when that is not self-evident.

Use one clear primary action such as “View recommendation” or “Fix connection.” Secondary lifecycle actions may include “Mark as handled,” “Remind me later,” “Mute this alert type,” “Why am I seeing this?”, and “Open details.” Do not manufacture an action when monitoring is the honest recommendation.

Prefer interpreted language: “The bathroom has stayed above 68% humidity for 14 minutes. Check the extractor fan.” Avoid generic announcements such as “A humidity reading is available.” Urgency must be conveyed by wording, icon, structure, and state label—not colour alone.

### Page-level application

Progressive disclosure applies throughout the product:

- **Overview and Home:** exceptions first, glanceable current state second, specialist tools collapsed.
- **Sensors:** health and setup gaps first; discovery, import, and editing open on request.
- **Inventory:** attention and service state first; search and location filters stay visible, while creation and editing open on request.
- **Alerts:** active actionable groups first; rule creation and acknowledged history are secondary disclosures.
- **System:** active host strain first; current CPU, memory, storage, database,
  and uptime second; storage forecasts remain explicitly confidence-labelled;
  thresholds, alert delivery, redacted error export, platform detail, metrics
  access, and software updates follow.
- **Outdoor:** current conditions and immediate implications first; forecast detail and model provenance follow.
- **Set up:** show setup progress and the recommended next incomplete step; keep completed and advanced configuration compact.
- **API & MCP:** lead with readiness and the shortest working path; reference detail and raw payloads remain expandable.

Before adding a surface, ask: what decision does this help someone make now, what can be summarized, what can stay closed, and when should the content disappear? If those answers are unclear, the content does not belong on a primary overview.

## 3. Identity

### Mark

The mark is a cottage built from four elementary forms:

- a vermilion square tile;
- a cream house and roof silhouette;
- a cobalt circular window;
- a dark rectangular door.

It remains recognisable in monochrome because the silhouette and openings do the work. The mark is decorative beside the written name and should use `aria-hidden="true"` there.

**Clear space:** keep at least one door-width around all sides.  
**Minimum size:** 24 px digital; 8 mm print.  
**Preferred size:** 40 px in the desktop product shell and 28 px on mobile.  
**Do not:** rotate, outline, add gradients, round it into an app-circle, recolour individual forms, or place it over a busy image.

The source mark is implemented in [`StuguMark.tsx`](apps/web/src/components/StuguMark.tsx) and [`stugu-mark.svg`](apps/web/public/stugu-mark.svg).

### Stuguby mark and ownership markers

Stuguby uses three close cottages built from the same forms and colours as the
Stugu mark. Use the full mark only for Stuguby identity and onboarding. In normal
Property and Home views, preserve the established layout and add a small mark
with a plain-language state such as **Shared**, **Read-only**, **Pending**, or
**Offline**. The mark is not a replacement for the written state, and shared
content must not become a separate visual theme.

The source mark is implemented in
[`StugubyMark.tsx`](apps/web/src/components/StugubyMark.tsx) and
[`stuguby-mark.svg`](apps/web/public/stuguby-mark.svg).

### Wordmark

Set **Stugu** in Manrope Bold with tight optical tracking (`-0.045em`). The product lockup uses sentence case, never all caps. The tagline may use small uppercase lettering because it is secondary and short.

Use the written name whenever space permits. The symbol alone is appropriate for the favicon and very small app surfaces.

## 4. Colour

Warm neutrals do most of the work. Cobalt is the interaction colour. Vermilion belongs to the identity and rare emphasis—not every button.

### Light theme

| Token | Value | Purpose | Verified contrast |
|---|---:|---|---:|
| Canvas | `#F1EFE9` | Page background | — |
| Surface | `#FCFBF7` | Cards and controls | — |
| Ink | `#1B1D1A` | Primary text | 16.39:1 on Surface |
| Muted | `#60635D` | Secondary text | 5.90:1 on Surface |
| Muted 2 | `#70736C` | Placeholders and metadata | 4.65:1 on Surface |
| Line | `#DEDBD2` | Decorative separators only | — |
| Strong line | `#919088` | Essential control boundaries | 3.10:1 on Surface |
| Action cobalt | `#0755C9` | Links, focus, primary actions | 6.66:1 with white |
| Action hover | `#003F9E` | Hover/pressed action | 9.52:1 with white |
| Stugu red | `#B54122` | Brand mark and rare emphasis | 5.42:1 on Surface |
| Success | `#007A5C` | Positive state | 5.15:1 on Surface |
| Warning | `#795000` | Caution text | 6.30:1 on `#FFF1C7` |
| Critical | `#B42318` | Destructive/error text | 5.75:1 on `#FDECEA` |

Contrast ratios were calculated with the WCAG relative-luminance formula. Recheck them whenever a token changes.

### Dark theme

Dark mode is neutral charcoal, not green-black. Core pairs are:

- Ink `#F2F0E9` on Surface `#1B1D19`: 14.90:1.
- Muted `#B4B8AF` on Surface: 8.42:1.
- Action `#78A7FF` on Surface: 7.09:1.
- Dark button text `#111A2A` on Action: 7.28:1.
- Strong line `#666B61` on Surface: 3.11:1.

### Colour-vision safety

- Never pair red and green as opposite ends of the same scale.
- Every state needs a written label and at least one non-colour cue: icon, shape, line style, or position.
- Connection states use circle, square, and outline treatments as well as colour.
- Current/predicted lines use solid/dashed strokes as well as colour.
- Selected items use borders and inset markers, never colour fill alone.
- Check new work under protanopia, deuteranopia, tritanopia, and grayscale simulation.

### Data ramps

Use these perceptually ordered, colour-vision-safe ramps:

- Thermal: `#2166AC` → `#F2EBDD` → `#B54122`.
- Humidity: `#D8F0F6` → `#2A84B8` → `#123D75`.
- Air quality: `#E7F1F8` → `#D29B00` → `#8C2D04`.
- Generic sequential: `#E7E0F3` → `#7B6AB5` → `#3F285F`.

Experimental sensor-support volumes use the generic sequential endpoints through
the `--coverage` and `--coverage-soft` tokens. In dark mode these become
`#C4B5EC` and `#32294A`. The solid/dashed boundary and placement marker carry
the meaning when colour is unavailable.

Always show endpoints, units, numeric sensor values, and a text description near a visualised field. A heat map is supporting context, never the only way to retrieve a value.

## 5. Typography

**Display and headings:** Manrope, 600–700.  
**Body and controls:** DM Sans, 400–700.  
**Code and identifiers:** SFMono-Regular, Consolas, Liberation Mono, monospace.

| Role | Size / line height | Notes |
|---|---|---|
| Page title | `clamp(30px, 3vw, 46px)` / 1.06 | Tight tracking, short line |
| Section title | 18 px / 1.25 | Manrope, 600–700 |
| Body | 14 px / 1.55 | Default explanatory copy |
| Control | 12–14 px / 1.3 | Labels remain visible; no placeholder-only fields |
| Metadata | 10–12 px / 1.4 | Avoid below 10 px outside chart axes |
| Eyebrow | 10 px / 1.2 | Uppercase, 0.13 em tracking |

Keep line length below roughly 70 characters for prose. Do not use light font weights. Prefer a larger size or more space before adding another weight.

## 6. Layout and shape

Use a 4 px base grid. Preferred spacing steps are `4, 8, 12, 16, 24, 32, 48, 64`.

- Desktop shell: 256 px navigation rail plus a fluid content column.
- Main content: maximum 1660 px with 24–56 px responsive gutters.
- Default card radius: 10 px.
- Controls: 5 px radius.
- Navigation and small tools: 4 px radius.
- Circles are reserved for sensors, live/healthy state, and selected icon moments.
- Shadows are low-contrast and broad. Borders define structure; shadows only separate layers.
- Avoid stacked “cards inside cards.” Prefer dividers and whitespace within a surface.

### Responsive behaviour

- iPadOS and macOS expose the complete desktop product and use the same
  information architecture and feature surface as web. Only the iPhone
  companion intentionally reduces navigation and workflow density.
- At 900 px, navigation becomes a modal drawer with focus containment and Escape dismissal.
- At 680 px, headings and controls stack into a single reading order.
- Support 320 CSS px without horizontal page scrolling. A complex chart may scroll inside its labelled region.
- At 200% browser zoom, all actions and content must remain available.
- Phone-size web and iPhone open on a pinnable Home or Property overview. The
  pin is configurable without changing the underlying active scope.
- The default glance shows temperature, humidity, current electricity use, and
  carbon dioxide. A Home breaks these down by Room; a Property breaks them down
  by Home. People may hide metrics, but the interface must keep at least one.
- Active high-priority attention precedes quick statistics. Missing or stale
  readings stay visibly unknown, and an all-clear message appears only when
  there are no active actionable alerts in the pinned scope.

## 7. Components

### Navigation

The rail is near-black to frame the home rather than compete with it. Active items use a cream block and a cobalt square marker. Labels remain visible; icon-only primary navigation is not allowed.

Preferred user-facing labels:

- Overview
- Properties
- Property
- Maintenance
- Electricity
- Home
- Activity
- Outdoor
- Electricity use
- Data & analytics
- Sensors
- Alerts
- Set up
- System
- API & MCP

Do not place Workspace-, Property-, and Home-owned destinations into one
unlabelled list. Show scope through the selector, group label, URL, page heading,
and breadcrumb or equivalent context. Credential-changing controls must always
name the Home or Property they will change.

### Buttons

- Primary: cobalt fill, white text, one per action group.
- Secondary: Surface fill, strong border, Ink text.
- Destructive: Critical fill or Critical text with an explicit confirmation.
- Icon button: must have an accessible name and at least a 24 × 24 px target; aim for 40–44 px.
- Disabled controls retain their label and must not be communicated by opacity alone.

### Confirmations

Use a shared structured confirmation for uncommon, consequential actions that
cannot be reliably undone. Do not use a browser-native confirmation prompt.
The dialog names the consequence in plain language and repeats the exact
object or scope being changed. The confirmation button names the result — for
example **Disconnect**, **Delete**, or **Install update** — rather than **OK** or
**Continue**.

Every confirmation provides **Cancel**, initially focuses the safe choice,
supports Escape, contains focus while open, and restores focus to the invoking
control when it closes. Use Critical styling only for destructive or
irreversible outcomes; high-consequence but constructive actions use the
ordinary action colour. Prefer undo or an inline reversible action when it can
provide equivalent safety without interruption.

### Forms

Every input has a persistent visible label. Help text explains the consequence, not the implementation. Errors appear next to the field, use `role="alert"` when immediate, and say how to recover.

### Cards and summaries

Summaries answer a question in this order: label, value, context. Use one icon. Attention cards add an inset border and text—not just a yellow background.

### Status

Use plain language:

- “Live” instead of “SSE connected.”
- “Trying to reconnect” instead of “Socket retry.”
- “Demo data” instead of “Offline” when the experience is intentionally simulated.

Do not animate critical alerts indefinitely. Acknowledge state changes in a polite live region.

Every live-data surface supports and distinguishes these states where
applicable: loading, empty, live, stale, reconnecting, offline, partial,
permission denied, and error. A cached or last-known value includes its age and
never uses the healthy treatment merely because a numeric value exists. Unknown
future enum values use the neutral/unknown treatment, never success.

## 8. Content and voice

Stugu speaks like a calm, observant host.

- Lead with what happened: “The bathroom is getting more humid.”
- Follow with evidence: “68% for 14 minutes.”
- End with a useful action: “Check the extractor fan.”
- Use sentence case.
- Prefer verbs: “Connect sensor,” “Save floor plan,” “View history.”
- Avoid false precision and overclaiming. Say “estimated gradient,” not “airflow,” unless airflow is directly measured.
- Never blame the user. Replace “Invalid token” with “This token could not connect. Check that it is current and has access to the selected home.”

## 9. Motion

Default interaction transitions are 120–180 ms with a standard ease-out curve. Larger spatial transitions may use up to 240 ms.

- Motion should preserve spatial context or confirm an action.
- Avoid decorative parallax, spring overshoot, and ambient floating.
- Live-state pulses must be subtle and paired with text.
- Under `prefers-reduced-motion: reduce`, remove particles, stop nonessential animation, and make transitions effectively instant.

## 10. Accessibility release gate

Stugu targets **WCAG 2.2 AA**. A feature is not done until all applicable checks pass.

### Required checks

- Text contrast: 4.5:1 normal, 3:1 large.
- UI boundaries and meaningful graphics: 3:1 against adjacent colours.
- Keyboard: logical order, no trap, visible focus, Escape closes modal UI.
- Focus: a persistent 3 px ring with separation from the component edge.
- Targets: WCAG minimum 24 × 24 px; prefer 40–44 px for primary touch controls.
- Semantics: one page `h1`, ordered headings, landmarks, native buttons/inputs, explicit labels.
- Images and maps: useful text alternative or adjacent equivalent; decorative art hidden from assistive technology.
- Status: important asynchronous updates announced without moving focus.
- Zoom/reflow: verified at 200% and 400%, plus a 320 px viewport.
- Motion: full operation with reduced motion enabled.
- Colour: operation and comprehension in grayscale and common colour-vision simulations.
- Language: the document `lang` follows the selected locale.
- Localisation: every user-facing string in a shipped locale is translated or
  that locale is explicitly declared preview-only; silent broad English
  fallback is not a release-ready state.
- Themes: the same checks pass in light and dark mode.

### Test matrix

Run automated checks as a fast gate, then manually verify:

1. Keyboard-only navigation.
2. NVDA with Firefox or Chrome on Windows.
3. VoiceOver with Safari for a release candidate.
4. 320 px, 768 px, 1440 px, 200% zoom, and 400% zoom.
5. Light, dark, reduced motion, and high-contrast/forced-colour modes.
6. Protanopia, deuteranopia, tritanopia, and grayscale.

Automation cannot approve wording, focus order, chart comprehension, or whether a visual equivalent is genuinely useful. Those remain manual checks.

## 11. Implementation notes

- Theme and component rules live in [`styles.css`](apps/web/src/styles.css).
- Brand/product language lives in [`i18n.tsx`](apps/web/src/i18n.tsx).
- Data ramps live in [`measurements.ts`](apps/web/src/measurements.ts).
- The shell and lockup live in [`AppShell.tsx`](apps/web/src/components/AppShell.tsx).
- `--pine*` variables are temporary compatibility aliases for the semantic `--action*` tokens. Do not use the legacy name in new components.
- Referencing an undeclared design token is a build failure. Components use
  semantic tokens (`--bg`, `--panel-soft`, `--line-strong`, `--red`, and
  related theme pairs) rather than local fallbacks that bypass dark mode.
- Body and control text must not render below 10 px at default settings. Font
  weights use the loaded 400–700 range; synthetic weights above 700 are a
  migration defect, not a new style.
- Existing routes and stored data keep working through a documented migration
  window. Scope or hierarchy changes must preserve historical telemetry
  ownership, authorization, deep links, rollback, and explicit failure modes.
- Browser presentation preferences are scoped to the installation and signed-in
  principal. A different account must never inherit dismissed warnings, hidden
  items, setup progress, or other trust-affecting UI state. Sign-out and an
  unauthorized session purge the scoped browser state.

When introducing a component, document any new token here rather than adding a one-off hex value. A design-system change should include light/dark values, contrast evidence, keyboard behaviour, and reduced-motion behaviour in the same pull request.

### Change record

- **1.9 (4 August 2026):** Defined the pinned phone overview for web and iOS,
  including configurable default metrics, Home/Room and Property/Home
  breakdowns, attention-first ordering, and explicit unknown data states.
- **1.7 (1 August 2026):** Simplified active-scope and Live View navigation;
  defined progressive lifecycle setup with safe inference and separate
  authoritative records; made weather Property-owned by default with explicit
  Home overrides; and required advanced controls to remain available on demand
  without competing with the primary task.
- **1.6 (1 August 2026):** Defined Home retirement as an explicit soft hide;
  preserved editable Property-owned records; required retired-scope write
  denial and credential isolation; and distinguished Stuguby projection purge.
- **1.5 (1 August 2026):** Made nested evidence views bookmarkable; defined the
  structured confirmation and focus-restoration contract; required
  action-specific confirmation labels and risk-matched colour; and added
  installation-and-principal scoping for browser presentation state.
- **1.4 (1 August 2026):** Defined the premium target as a coherent evolution;
  moved Workspace administration into Advanced navigation; separated unknown
  monitoring from actionable attention; specified cross-scope recommendations,
  action disclosures, live-data states, localisation completeness, semantic
  token enforcement, typography limits, and migration safeguards.
