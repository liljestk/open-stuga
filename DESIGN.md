# Stuga brand and interface system

Version 1.0 · 14 July 2026

## 1. Brand idea

**Stuga** is Swedish for cottage. The name makes a technical home-climate system feel domestic, calm, and understandable.

**Positioning:** Stuga turns signals from the home into a clear picture of how the home feels.

**Tagline:** Your home, in balance.

**Product promise:** Open Stuga and understand the state of the home in a few seconds. Details are available, but they never obstruct the answer.

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

The source mark is implemented in [`StugaMark.tsx`](apps/web/src/components/StugaMark.tsx) and [`stuga-mark.svg`](apps/web/public/stuga-mark.svg).

### Wordmark

Set **Stuga** in Manrope Bold with tight optical tracking (`-0.045em`). The product lockup uses sentence case, never all caps. The tagline may use small uppercase lettering because it is secondary and short.

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
| Stuga red | `#B54122` | Brand mark and rare emphasis | 5.42:1 on Surface |
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

- At 900 px, navigation becomes a modal drawer with focus containment and Escape dismissal.
- At 680 px, headings and controls stack into a single reading order.
- Support 320 CSS px without horizontal page scrolling. A complex chart may scroll inside its labelled region.
- At 200% browser zoom, all actions and content must remain available.

## 7. Components

### Navigation

The rail is near-black to frame the home rather than compete with it. Active items use a cream block and a cobalt square marker. Labels remain visible; icon-only primary navigation is not allowed.

Preferred user-facing labels:

- Home
- Sensors
- Alerts
- Set up
- API & MCP

### Buttons

- Primary: cobalt fill, white text, one per action group.
- Secondary: Surface fill, strong border, Ink text.
- Destructive: Critical fill or Critical text with an explicit confirmation.
- Icon button: must have an accessible name and at least a 24 × 24 px target; aim for 40–44 px.
- Disabled controls retain their label and must not be communicated by opacity alone.

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

## 8. Content and voice

Stuga speaks like a calm, observant host.

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

Stuga targets **WCAG 2.2 AA**. A feature is not done until all applicable checks pass.

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

When introducing a component, document any new token here rather than adding a one-off hex value. A design-system change should include light/dark values, contrast evidence, keyboard behaviour, and reduced-motion behaviour in the same pull request.
