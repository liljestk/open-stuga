import { describe, expect, it } from "vitest";

import setupOperationsStyles from "../pages/SetupOperationsPanel.css?raw";
import propertyStyles from "../pages/PropertyManagementPage.css?raw";
import hostSystemStyles from "../pages/HostSystemPanel.css?raw";
import shellStyles from "./global/01-root.css?raw";
import analyticsStyles from "./global/10-analytics-summary-card-dt.css?raw";
import alertStateStyles from "./global/07-simulation-provenance.css?raw";
import historyImportStyles from "./global/11-history-import-layout-choice-label-span.css?raw";
import responsiveStyles from "./global/14-weather-current-card-weather-empty-p.css?raw";
import mobileStyles from "./global/15-media-max-width-680px.css?raw";
import accessibilityStyles from "./global/16-portfolio-facts-dd.css?raw";

const productionStyles = import.meta.glob("../**/*.css", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const allProductionStyles = Object.entries(productionStyles)
  .map(([path, styles]) => `/* ${path} */\n${styles}`)
  .join("\n");

describe("semantic stylesheet tokens", () => {
  it("uses the canonical theme-aware tokens for corrected component styles", () => {
    expect(analyticsStyles).toContain("background: var(--panel-soft)");
    expect(analyticsStyles).toContain("color: var(--red)");
    expect(analyticsStyles).not.toMatch(/var\(--(?:surface-soft|danger)\b/);

    expect(historyImportStyles).toContain("border: 1px solid var(--line-strong)");
    expect(historyImportStyles).not.toContain("var(--strong-line)");

    expect(propertyStyles).toContain("background: var(--bg)");
    expect(propertyStyles).not.toContain("var(--canvas)");

    for (const token of ["panel-soft", "positive", "yellow", "red", "line", "action", "muted"]) {
      expect(setupOperationsStyles).toContain(`var(--${token})`);
    }
    expect(setupOperationsStyles).not.toMatch(
      /var\(--(?:surface-muted|success|warning|danger|border|text-muted)\b/,
    );
    expect(setupOperationsStyles).not.toMatch(/var\(--[\w-]+\s*,\s*#[\da-f]+\)/i);
  });

  it("keeps legacy pine tokens as root compatibility declarations only", () => {
    expect(allProductionStyles).not.toMatch(/var\(--pine(?:-hover|-soft)?\)/);

    for (const [path, styles] of Object.entries(productionStyles)) {
      if (!/--pine(?:-hover|-soft)?\s*:/.test(styles)) continue;
      expect(path).toMatch(/global\/(?:01-root|15-media-max-width-680px)\.css$/);
    }
  });

  it("enforces the production type floor and weight ceiling", () => {
    for (const match of allProductionStyles.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(10);
    }

    for (const match of allProductionStyles.matchAll(/font-weight\s*:\s*(\d+)/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(700);
    }

    for (const match of allProductionStyles.matchAll(/font\s*:\s*(\d{3})\s+(\d+(?:\.\d+)?)px/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(700);
      expect(Number(match[2])).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps explicit focus-visible rings separated by three pixels", () => {
    const focusRules = allProductionStyles.matchAll(/[^{}]*:focus-visible[^{}]*\{([^{}]*)\}/g);

    for (const match of focusRules) {
      const declarations = match[1] ?? "";
      expect(declarations).not.toMatch(/outline\s*:\s*(?:none|0)\b/);
      expect(declarations).not.toMatch(/outline-offset\s*:\s*-/);
      if (/outline\s*:/.test(declarations)) {
        expect(declarations).toMatch(/outline\s*:\s*3px\b/);
        expect(declarations).toMatch(/outline-offset\s*:\s*3px\b/);
      }
    }
  });

  it("uses radius tokens for canonical 5px and 10px values", () => {
    expect(allProductionStyles).not.toMatch(/border-radius\s*:\s*(?:5|10)px(?=\s*[;}])/);
  });

  it("keeps the primary navigation vertical-only", () => {
    expect(allProductionStyles).toMatch(/\.sidebar\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/);
  });

  it("keeps unknown monitoring visually neutral", () => {
    expect(alertStateStyles).toMatch(/\.alerts-monitoring-summary\.unknown\s*\{[^}]*background:\s*var\(--panel-soft\)/);
    expect(alertStateStyles).toMatch(/\.alerts-monitoring-summary\.unknown\s*>\s*span\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(alertStateStyles).not.toMatch(/\.alerts-monitoring-summary\.unknown[^}]*var\(--orange/);
  });

  it("stacks dense workspaces before the desktop rail makes them cramped", () => {
    expect(propertyStyles).toMatch(/@media \(max-width: 1080px\)[\s\S]*?\.property-layout\s*\{\s*grid-template-columns:\s*1fr/);
    expect(propertyStyles).toMatch(/@media \(max-width: 1080px\)[\s\S]*?\.property-sidebar\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    expect(propertyStyles).toMatch(/@media \(max-width: 1080px\)[\s\S]*?\.property-sidebar > \.property-house-group,[\s\S]*?\.property-sidebar > \.property-area-list,[\s\S]*?\.property-sidebar > \.property-action-disclosure,[\s\S]*?\{ grid-column: 1 \/ -1; \}/);
    expect(responsiveStyles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?\.sensor-workspace\s*\{\s*grid-template-columns:\s*1fr/);
    expect(responsiveStyles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?\.sensor-side-column\s*\{\s*grid-template-columns:\s*repeat\(2,/);
    expect(hostSystemStyles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?\.host-system-grid\s*\{\s*grid-template-columns:\s*1fr 1fr/);
    expect(hostSystemStyles).toContain(".host-system-grid > :last-child:nth-child(odd) { grid-column: 1 / -1; }");
    expect(setupOperationsStyles).toMatch(/\.setup-operations-grid\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(setupOperationsStyles).toMatch(/@media \(max-width: 900px\)[^}]*\.setup-operations-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(setupOperationsStyles).toMatch(/\.bulk-mapping-scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/);
  });

  it("keeps mobile banners and full-height surfaces inside the visual viewport", () => {
    expect(shellStyles).toMatch(/\.app-shell\s*\{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100dvh/);
    expect(shellStyles).toMatch(/\.sidebar\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh/);
    expect(analyticsStyles).toMatch(/\.history-import-dialog\s*\{[^}]*calc\(100vh - 44px\)[^}]*calc\(100dvh - 44px\)/);
    expect(mobileStyles).toMatch(/\.history-import-dialog\s*\{[^}]*max-height:\s*100vh;[^}]*max-height:\s*100dvh/);
    expect(responsiveStyles).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.demo-banner, \.connection-banner\s*\{\s*position:\s*static/);
    expect(responsiveStyles).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.demo-mode \.mobile-header\s*\{\s*top:\s*0/);
  });

  it("turns narrow editor popovers into inline disclosures and stacks paired fields", () => {
    expect(accessibilityStyles).toMatch(/@media \(max-width: 700px\)[\s\S]*?\.editor-disclosure-content\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*min-width:\s*0/);
    expect(accessibilityStyles).toMatch(/@media \(max-width: 700px\)[\s\S]*?\.opening-inventory-list, \.opening-inventory > p\s*\{[^}]*position:\s*static[^}]*width:\s*100%/);
    expect(mobileStyles).toMatch(/@media \(max-width: 680px\)[\s\S]*?\.field-row\s*\{\s*grid-template-columns:\s*1fr/);
  });

  it("reflows phone-width inventory actions and weather location controls", () => {
    expect(propertyStyles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.inventory-overview \.panel-header\s*\{[^}]*flex-direction:\s*column/);
    expect(propertyStyles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.inventory-item-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(propertyStyles).toMatch(/\.inventory-item-actions \.secondary-button\s*\{[^}]*min-width:\s*0[^}]*white-space:\s*normal/);
    expect(accessibilityStyles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.location-discovery-current\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(accessibilityStyles).toMatch(/\.location-discovery-current > \.secondary-button\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*white-space:\s*normal/);
  });

  it("stacks history mapping controls at 320px", () => {
    expect(mobileStyles).toMatch(/@media \(max-width: 360px\)[\s\S]*?\.history-import-map-list > div\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(mobileStyles).toMatch(/\.history-import-map-list > div > label:last-child\s*\{[^}]*grid-column:\s*1 \/ -1/);
  });

  it("provides coarse-pointer touch targets for dense controls and property maps", () => {
    expect(accessibilityStyles).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.opening-binding-fields \.checkbox-row[^}]*min-height:\s*44px/);
    expect(accessibilityStyles).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.opening-advanced-fields > summary[^}]*min-height:\s*44px/);
    expect(propertyStyles).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.property-area-map\.leaflet-container \.leaflet-bar a\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    expect(propertyStyles).toMatch(/\.property-map-handle-wrap::before\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    expect(propertyStyles).toMatch(/\.grant-tree label\s*\{[^}]*min-height:\s*44px/);
  });
});
