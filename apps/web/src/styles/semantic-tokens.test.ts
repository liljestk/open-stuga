import { describe, expect, it } from "vitest";

import setupOperationsStyles from "../pages/SetupOperationsPanel.css?raw";
import propertyStyles from "../pages/PropertyManagementPage.css?raw";
import hostSystemStyles from "../pages/HostSystemPanel.css?raw";
import { cssRule, globalStyles, type CssRule } from "../test/styleSources";

const productionStyles = import.meta.glob("../**/*.css", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const componentSources = import.meta.glob("../**/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const allProductionStyles = Object.entries(productionStyles)
  .map(([path, styles]) => `/* ${path} */\n${styles}`)
  .join("\n");

/** A legacy value declared first and its modern replacement after it, in the same rule. */
function expectFallback(rule: CssRule, property: string, legacy: string, modern: string): void {
  const values = rule.values(property);
  expect(values).toContain(legacy);
  expect(values.indexOf(legacy)).toBeLessThan(values.lastIndexOf(modern));
}

describe("semantic stylesheet tokens", () => {
  it("only reads custom properties that a stylesheet or component defines", () => {
    const defined = new Set<string>();
    for (const source of [allProductionStyles, ...Object.values(componentSources)]) {
      for (const match of source.matchAll(/(--[\w-]+)["']?\s*:/g)) defined.add(match[1]!);
    }
    const undefinedTokens = [...new Set([...allProductionStyles.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]!))]
      .filter((token) => !defined.has(token));
    expect(undefinedTokens).toEqual([]);
  });

  it("uses theme-aware tokens without hard-coded fallbacks", () => {
    expect(allProductionStyles).not.toMatch(/var\(--[\w-]+\s*,\s*#[\da-f]+\)/i);
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
    const sidebar = cssRule(globalStyles, ".sidebar");
    expect(sidebar.get("overflow-x")).toBe("hidden");
    expect(sidebar.get("overflow-y")).toBe("auto");
  });

  it("keeps unknown monitoring visually neutral", () => {
    const unknown = cssRule(globalStyles, ".alerts-monitoring-summary.unknown");
    expect(unknown.get("background")).toBe("var(--panel-soft)");
    expect(unknown.declarations.some(([, value]) => value.includes("var(--orange"))).toBe(false);
    expect(cssRule(globalStyles, ".alerts-monitoring-summary.unknown > span").get("color")).toBe("var(--muted)");
  });

  it("stacks dense workspaces before the desktop rail makes them cramped", () => {
    expect(cssRule(propertyStyles, ".property-layout", "(max-width: 1080px)").get("grid-template-columns")).toBe("1fr");
    expect(cssRule(propertyStyles, ".property-sidebar", "(max-width: 1080px)").get("grid-template-columns")).toMatch(/^repeat\(2,/);
    for (const child of [".property-house-group", ".property-area-list", ".property-action-disclosure"]) {
      expect(cssRule(propertyStyles, `.property-sidebar > ${child}`, "(max-width: 1080px)").get("grid-column")).toBe("1 / -1");
    }
    expect(cssRule(globalStyles, ".sensor-workspace", "(max-width: 1180px)").get("grid-template-columns")).toBe("1fr");
    expect(cssRule(globalStyles, ".sensor-side-column", "(max-width: 1180px)").get("grid-template-columns")).toMatch(/^repeat\(2,/);
    expect(cssRule(hostSystemStyles, ".host-system-grid", "(max-width: 1180px)").get("grid-template-columns")).toBe("1fr 1fr");
    expect(cssRule(hostSystemStyles, ".host-system-grid > :last-child:nth-child(odd)", "(max-width: 1180px)").get("grid-column")).toBe("1 / -1");
    const grid = cssRule(setupOperationsStyles, ".setup-operations-grid");
    expect(grid.get("min-width")).toBe("0");
    expect(grid.get("max-width")).toBe("100%");
    expect(cssRule(setupOperationsStyles, ".setup-operations-grid", "(max-width: 900px)").get("grid-template-columns")).toBe("minmax(0, 1fr)");
    const bulkMapping = cssRule(setupOperationsStyles, ".bulk-mapping-scroll");
    expect(bulkMapping.get("max-width")).toBe("100%");
    expect(bulkMapping.get("overflow-x")).toBe("auto");
  });

  it("keeps mobile banners and full-height surfaces inside the visual viewport", () => {
    expectFallback(cssRule(globalStyles, ".app-shell"), "min-height", "100vh", "100dvh");
    expectFallback(cssRule(globalStyles, ".sidebar"), "height", "100vh", "100dvh");
    expectFallback(cssRule(globalStyles, ".history-import-dialog"), "max-height",
      "min(900px, calc(100vh - 44px))", "min(900px, calc(100dvh - 44px))");
    expectFallback(cssRule(globalStyles, ".history-import-dialog", "(max-width: 680px)"), "max-height", "100vh", "100dvh");
    expect(cssRule(globalStyles, ".demo-banner", "(max-width: 900px)").get("position")).toBe("static");
    expect(cssRule(globalStyles, ".connection-banner", "(max-width: 900px)").get("position")).toBe("static");
    expect(cssRule(globalStyles, ".demo-mode .mobile-header", "(max-width: 900px)").get("top")).toBe("0");
  });

  it("turns narrow editor popovers into inline disclosures and stacks paired fields", () => {
    const disclosure = cssRule(globalStyles, ".editor-disclosure-content", "(max-width: 700px)");
    expect([disclosure.get("position"), disclosure.get("width"), disclosure.get("min-width")]).toEqual(["static", "100%", "0"]);
    const inventory = cssRule(globalStyles, ".opening-inventory-list", "(max-width: 700px)");
    expect([inventory.get("position"), inventory.get("width")]).toEqual(["static", "100%"]);
    expect(cssRule(globalStyles, ".field-row", "(max-width: 680px)").get("grid-template-columns")).toBe("1fr");
  });

  it("reflows phone-width inventory actions and weather location controls", () => {
    expect(cssRule(propertyStyles, ".inventory-overview .panel-header", "(max-width: 760px)").get("flex-direction")).toBe("column");
    expect(cssRule(propertyStyles, ".inventory-item-actions", "(max-width: 760px)").get("grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
    const action = cssRule(propertyStyles, ".inventory-item-actions .secondary-button", "(max-width: 760px)");
    expect([action.get("min-width"), action.get("white-space")]).toEqual(["0", "normal"]);
    expect(cssRule(globalStyles, ".location-discovery-current", "(max-width: 760px)").get("grid-template-columns")).toBe("auto minmax(0, 1fr)");
    const locationAction = cssRule(globalStyles, ".location-discovery-current > .secondary-button", "(max-width: 760px)");
    expect([locationAction.get("grid-column"), locationAction.get("white-space")]).toEqual(["1 / -1", "normal"]);
  });

  it("stacks history mapping controls at 320px", () => {
    expect(cssRule(globalStyles, ".history-import-map-list > div", "(max-width: 360px)").get("grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(cssRule(globalStyles, ".history-import-map-list > div > label:last-child", "(max-width: 360px)").get("grid-column")).toBe("1 / -1");
  });

  it("provides coarse-pointer touch targets for dense controls and property maps", () => {
    expect(cssRule(globalStyles, ".opening-binding-fields .checkbox-row", "(pointer: coarse)").get("min-height")).toBe("44px");
    expect(cssRule(globalStyles, ".opening-advanced-fields > summary", "(pointer: coarse)").get("min-height")).toBe("44px");
    const leafletButton = cssRule(propertyStyles, ".property-area-map.leaflet-container .leaflet-bar a", "(pointer: coarse)");
    expect([leafletButton.get("width"), leafletButton.get("height")]).toEqual(["44px", "44px"]);
    const handle = cssRule(propertyStyles, ".property-map-handle-wrap::before", "(pointer: coarse)");
    expect([handle.get("width"), handle.get("height")]).toEqual(["44px", "44px"]);
    expect(cssRule(propertyStyles, ".grant-tree label", "(pointer: coarse)").get("min-height")).toBe("44px");
  });
});
