import { describe, expect, it } from "vitest";
import type { AppPage } from "./domain";
import { locationForPropertySection, locationForRoute, routeFromLocation, type RouteScope } from "./routing";

function routeFromUrl(url: string) {
  const location = new URL(url, "https://stugu.test");
  return routeFromLocation(location);
}

const scope: RouteScope = { propertyId: "property-main", houseId: "home-1" };

describe("application routes", () => {
  it("restores canonical Property and Home scope", () => {
    expect(routeFromUrl("/properties/lake%20estate")).toEqual({
      page: "properties",
      propertyId: "lake estate",
      houseId: null,
    });
    expect(routeFromUrl("/properties/lake%20estate/maintenance")).toEqual({
      page: "maintenance",
      propertyId: "lake estate",
      houseId: null,
    });
    expect(routeFromUrl("/properties/lake%20estate/maintenance?home=lake%20house")).toEqual({
      page: "maintenance",
      propertyId: "lake estate",
      houseId: "lake house",
    });
    expect(routeFromUrl("/properties/lake%20estate/homes/lake%20house/maintenance")).toEqual({
      page: "maintenance",
      propertyId: "lake estate",
      houseId: "lake house",
      legacy: true,
    });
    expect(routeFromUrl("/properties/lake%20estate/electricity")).toEqual({
      page: "energy",
      propertyId: "lake estate",
      houseId: null,
    });
    expect(routeFromUrl("/properties/lake%20estate/homes/lake%20house/outdoor")).toEqual({
      page: "outdoor",
      propertyId: "lake estate",
      houseId: "lake house",
    });
    expect(routeFromUrl("/properties/lake%20estate/homes/lake%20house/sensors")).toEqual({
      page: "sensors",
      propertyId: "lake estate",
      houseId: "lake house",
    });
    expect(routeFromUrl("/properties/lake%20estate/homes/lake%20house/analytics")).toEqual({
      page: "analytics",
      propertyId: "lake estate",
      houseId: "lake house",
    });
    expect(routeFromUrl("/properties/lake%20estate/homes/lake%20house/electricity")).toEqual({
      page: "energy",
      propertyId: "lake estate",
      houseId: "lake house",
    });
  });

  it("keeps legacy Site and query URLs readable until App can canonicalize them", () => {
    expect(routeFromUrl("/sites/lake%20house/activity")).toEqual({
      page: "activity",
      propertyId: null,
      houseId: "lake house",
      legacy: true,
    });
    expect(routeFromUrl("/sensors?site=remote")).toEqual({
      page: "sensors",
      propertyId: null,
      houseId: "remote",
      legacy: true,
    });
    expect(routeFromUrl("/")).toEqual({
      page: "twin",
      propertyId: null,
      houseId: null,
      legacy: true,
    });
  });

  it("parses all 28 meaningful canonical route states", () => {
    const workspace = { propertyId: null, houseId: null };
    const property = { propertyId: "p", houseId: null };
    const home = { propertyId: "p", houseId: "h" };
    const cases: Array<[string, ReturnType<typeof routeFromUrl>]> = [
      ["/overview", { page: "overview", ...workspace }],
      ["/properties", { page: "properties", ...workspace }],
      ["/properties/p", { page: "properties", ...property }],
      ["/properties/p/map", { page: "properties", ...property, propertySection: "map" }],
      ["/properties/p/inventory", { page: "properties", ...property, propertySection: "inventory" }],
      ["/properties/p/notes", { page: "properties", ...property, propertySection: "notes" }],
      ["/properties/p/access", { page: "properties", ...property, propertySection: "access" }],
      ["/properties/p/maintenance", { page: "maintenance", ...property }],
      ["/properties/p/maintenance?home=h", { page: "maintenance", ...home }],
      ["/properties/p/electricity", { page: "energy", ...property }],
      ["/properties/p/homes/h", { page: "twin", ...home }],
      ["/properties/p/homes/h/activity", { page: "activity", ...home }],
      ["/properties/p/homes/h/activity?view=observations", { page: "activity", ...home }],
      ["/properties/p/homes/h/outdoor", { page: "outdoor", ...home }],
      ["/properties/p/homes/h/electricity", { page: "energy", ...home }],
      ["/properties/p/homes/h/sensors", { page: "sensors", ...home }],
      ["/properties/p/homes/h/analytics", { page: "analytics", ...home }],
      ...["overview", "layout", "connections", "weather", "operations", "automations"].map((section) => [
        `/properties/p/homes/h/setup/${section}`,
        { page: "integrations", ...home },
      ] as [string, ReturnType<typeof routeFromUrl>]),
      ["/alerts", { page: "alerts", ...workspace }],
      ["/people", { page: "people", ...workspace }],
      ["/stugbys", { page: "stugubys", ...workspace }],
      ["/developer", { page: "developer", ...workspace }],
      ["/system", { page: "updates", ...workspace }],
    ];

    expect(cases).toHaveLength(28);
    for (const [url, expected] of cases) expect(routeFromUrl(url), url).toEqual(expected);
  });

  it("keeps all 24 documented legacy URL forms readable for migration", () => {
    const cases: Array<[string, ReturnType<typeof routeFromUrl>]> = [
      ...(["twin", "activity", "maintenance", "outdoor", "energy"] as const).map((page) => [
        `/sites/h/${page}`,
        { page, propertyId: null, houseId: "h", legacy: true },
      ] as [string, ReturnType<typeof routeFromUrl>]),
      ["/?home=h", { page: "twin", propertyId: null, houseId: "h", legacy: true }],
      ...(["twin", "outdoor", "energy", "activity", "maintenance", "sensors", "analytics"] as const).map((page) => [
        `/${page}?site=h`,
        { page, propertyId: null, houseId: "h", legacy: true },
      ] as [string, ReturnType<typeof routeFromUrl>]),
      ...(["", "/overview", "/homes", "/layout", "/connections", "/weather", "/automations", "/operations"] as const).map((section) => [
        `/setup${section}?site=h`,
        { page: "integrations", propertyId: null, houseId: "h", legacy: true },
      ] as [string, ReturnType<typeof routeFromUrl>]),
      ["/system/updates", { page: "updates", propertyId: null, houseId: null, legacy: true }],
      ["/properties/p/homes/h/maintenance", { page: "maintenance", propertyId: "p", houseId: "h", legacy: true }],
      ["/properties/p/homes/h/setup/homes", { page: "properties", propertyId: "p", houseId: null, legacy: true }],
    ];

    expect(cases).toHaveLength(24);
    for (const [url, expected] of cases) expect(routeFromUrl(url), url).toEqual(expected);
  });

  it("marks unknown URLs for an explicit recovery screen", () => {
    expect(routeFromUrl("/old-or-mistyped-page?site=home-1")).toEqual({
      page: "overview",
      propertyId: null,
      houseId: null,
      notFound: true,
    });
    expect(routeFromUrl("/setup/mistyped-section?site=home-1")).toEqual({
      page: "overview",
      propertyId: null,
      houseId: null,
      notFound: true,
    });
  });

  it("builds bookmarkable canonical URLs for each ownership level", () => {
    expect(locationForRoute("overview", scope)).toBe("/overview");
    expect(locationForRoute("properties", scope)).toBe("/properties/property-main");
    expect(locationForRoute("stugubys", scope)).toBe("/stugbys");
    expect(locationForRoute("updates", scope)).toBe("/system");
    expect(locationForRoute("twin", scope)).toBe("/properties/property-main/homes/home-1");
    expect(locationForRoute("outdoor", scope)).toBe("/properties/property-main/homes/home-1/outdoor");
    expect(locationForRoute("activity", scope)).toBe("/properties/property-main/homes/home-1/activity");
    expect(locationForRoute("maintenance", scope)).toBe("/properties/property-main/maintenance?home=home-1");
    expect(locationForRoute("energy", { propertyId: scope.propertyId, houseId: null })).toBe("/properties/property-main/electricity");
    expect(locationForRoute("energy", scope)).toBe("/properties/property-main/homes/home-1/electricity");
    expect(locationForRoute("sensors", scope)).toBe("/properties/property-main/homes/home-1/sensors");
    expect(locationForRoute("analytics", scope)).toBe("/properties/property-main/homes/home-1/analytics");
    expect(locationForRoute("integrations", scope)).toBe("/properties/property-main/homes/home-1/setup");
  });

  it("restores every Property workspace section without losing scope", () => {
    expect(routeFromUrl("/properties/lake%20estate/map")).toEqual({
      page: "properties",
      propertyId: "lake estate",
      houseId: null,
      propertySection: "map",
    });
    expect(routeFromUrl("/properties/lake%20estate/inventory")).toEqual({
      page: "properties",
      propertyId: "lake estate",
      houseId: null,
      propertySection: "inventory",
    });
    expect(locationForPropertySection("lake estate", "overview")).toBe("/properties/lake%20estate");
    expect(locationForPropertySection("lake estate", "notes")).toBe("/properties/lake%20estate/notes");
    expect(locationForPropertySection("lake estate", "access")).toBe("/properties/lake%20estate/access");
  });

  it("keeps the active Setup section while changing scope", () => {
    expect(locationForRoute("integrations", scope, "/setup/homes")).toBe("/properties/property-main/homes/home-1/setup");
    expect(routeFromUrl("/properties/property-main/homes/home-1/setup/homes")).toEqual({
      page: "properties",
      propertyId: "property-main",
      houseId: null,
      legacy: true,
    });
    expect(locationForRoute("integrations", scope, "/properties/old/homes/old/setup/weather/")).toBe("/properties/property-main/homes/home-1/setup/weather");
    expect(locationForRoute("integrations", scope, "/properties/old/homes/old/setup/operations")).toBe("/properties/property-main/homes/home-1/setup/operations");
    expect(locationForRoute("integrations", scope, "/overview")).toBe("/properties/property-main/homes/home-1/setup");
  });

  it("restores every bookmarkable Setup section, including Operations", () => {
    for (const section of ["overview", "layout", "connections", "weather", "operations", "automations"]) {
      expect(routeFromUrl(`/properties/property-main/homes/home-1/setup/${section}`)).toEqual({
        page: "integrations",
        propertyId: "property-main",
        houseId: "home-1",
      });
    }
    expect(routeFromUrl("/setup/operations?site=home-1")).toEqual({
      page: "integrations",
      propertyId: null,
      houseId: "home-1",
      legacy: true,
    });
  });

  it.each([
    ["overview", "/overview", null, null],
    ["properties", "/properties/property%20%2F%20one", "property / one", null],
    ["twin", "/properties/property%20%2F%20one/homes/home%20%2F%20one", "property / one", "home / one"],
    ["outdoor", "/properties/property%20%2F%20one/homes/home%20%2F%20one/outdoor", "property / one", "home / one"],
    ["activity", "/properties/property%20%2F%20one/homes/home%20%2F%20one/activity", "property / one", "home / one"],
    ["maintenance", "/properties/property%20%2F%20one/maintenance?home=home%20%2F%20one", "property / one", "home / one"],
    ["energy", "/properties/property%20%2F%20one/homes/home%20%2F%20one/electricity", "property / one", "home / one"],
    ["sensors", "/properties/property%20%2F%20one/homes/home%20%2F%20one/sensors", "property / one", "home / one"],
    ["analytics", "/properties/property%20%2F%20one/homes/home%20%2F%20one/analytics", "property / one", "home / one"],
    ["alerts", "/alerts", null, null],
    ["integrations", "/properties/property%20%2F%20one/homes/home%20%2F%20one/setup", "property / one", "home / one"],
    ["developer", "/developer", null, null],
    ["people", "/people", null, null],
    ["stugubys", "/stugbys", null, null],
    ["updates", "/system", null, null],
  ] satisfies Array<[AppPage, string, string | null, string | null]>) (
    "round-trips the %s route without losing its ownership scope",
    (page, expectedUrl, expectedPropertyId, expectedHouseId) => {
      const url = locationForRoute(page, { propertyId: "property / one", houseId: "home / one" });
      expect(url).toBe(expectedUrl);
      expect(routeFromUrl(url)).toEqual({ page, propertyId: expectedPropertyId, houseId: expectedHouseId });
    },
  );

  it("recognizes global routes without requiring a selected Property", () => {
    expect(routeFromUrl("/overview/")).toEqual({ page: "overview", propertyId: null, houseId: null });
    expect(routeFromUrl("/developer")).toEqual({ page: "developer", propertyId: null, houseId: null });
    expect(routeFromUrl("/alerts")).toEqual({ page: "alerts", propertyId: null, houseId: null });
    expect(routeFromUrl("/properties")).toEqual({ page: "properties", propertyId: null, houseId: null });
    expect(routeFromUrl("/people")).toEqual({ page: "people", propertyId: null, houseId: null });
    expect(routeFromUrl("/stugbys")).toEqual({ page: "stugubys", propertyId: null, houseId: null });
    expect(routeFromUrl("/system")).toEqual({ page: "updates", propertyId: null, houseId: null });
    expect(routeFromUrl("/system/updates")).toEqual({ page: "updates", propertyId: null, houseId: null, legacy: true });
  });
});
