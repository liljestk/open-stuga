import { describe, expect, it } from "vitest";
import type { AppPage } from "./domain";
import { locationForRoute, routeFromLocation, type RouteScope } from "./routing";

function routeFromUrl(url: string) {
  const location = new URL(url, "https://stuga.test");
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
    expect(locationForRoute("twin", scope)).toBe("/properties/property-main/homes/home-1");
    expect(locationForRoute("outdoor", scope)).toBe("/properties/property-main/homes/home-1/outdoor");
    expect(locationForRoute("activity", scope)).toBe("/properties/property-main/homes/home-1/activity");
    expect(locationForRoute("maintenance", scope)).toBe("/properties/property-main/homes/home-1/maintenance");
    expect(locationForRoute("energy", { propertyId: scope.propertyId, houseId: null })).toBe("/properties/property-main/electricity");
    expect(locationForRoute("energy", scope)).toBe("/properties/property-main/homes/home-1/electricity");
    expect(locationForRoute("sensors", scope)).toBe("/properties/property-main/homes/home-1/sensors");
    expect(locationForRoute("integrations", scope)).toBe("/properties/property-main/homes/home-1/setup");
  });

  it("keeps the active Setup section while changing scope", () => {
    expect(locationForRoute("integrations", scope, "/setup/homes")).toBe("/properties/property-main/homes/home-1/setup");
    expect(locationForRoute("integrations", scope, "/properties/old/homes/old/setup/weather/")).toBe("/properties/property-main/homes/home-1/setup/weather");
    expect(locationForRoute("integrations", scope, "/overview")).toBe("/properties/property-main/homes/home-1/setup");
  });

  it.each([
    ["overview", "/overview", null, null],
    ["properties", "/properties/property%20%2F%20one", "property / one", null],
    ["twin", "/properties/property%20%2F%20one/homes/home%20%2F%20one", "property / one", "home / one"],
    ["outdoor", "/properties/property%20%2F%20one/homes/home%20%2F%20one/outdoor", "property / one", "home / one"],
    ["activity", "/properties/property%20%2F%20one/homes/home%20%2F%20one/activity", "property / one", "home / one"],
    ["maintenance", "/properties/property%20%2F%20one/homes/home%20%2F%20one/maintenance", "property / one", "home / one"],
    ["energy", "/properties/property%20%2F%20one/homes/home%20%2F%20one/electricity", "property / one", "home / one"],
    ["sensors", "/properties/property%20%2F%20one/homes/home%20%2F%20one/sensors", "property / one", "home / one"],
    ["alerts", "/alerts", null, null],
    ["integrations", "/properties/property%20%2F%20one/homes/home%20%2F%20one/setup", "property / one", "home / one"],
    ["developer", "/developer", null, null],
    ["people", "/people", null, null],
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
  });
});
