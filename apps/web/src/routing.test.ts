import { describe, expect, it } from "vitest";
import type { AppPage } from "./domain";
import { locationForRoute, routeFromLocation } from "./routing";

function routeFromUrl(url: string) {
  const location = new URL(url, "https://stuga.test");
  return routeFromLocation(location);
}

describe("application routes", () => {
  it("restores site-scoped operational views", () => {
    expect(routeFromLocation({ pathname: "/sites/lake%20house/outdoor", search: "" })).toEqual({
      page: "outdoor",
      houseId: "lake house",
    });
    expect(routeFromLocation({ pathname: "/sensors", search: "?site=remote" })).toEqual({
      page: "sensors",
      houseId: "remote",
    });
  });

  it("keeps the historical root URL on the twin", () => {
    expect(routeFromLocation({ pathname: "/", search: "" })).toEqual({ page: "twin", houseId: null });
  });

  it("builds bookmarkable URLs for every new workspace", () => {
    expect(locationForRoute("overview", "home-1")).toBe("/overview");
    expect(locationForRoute("twin", "home-1")).toBe("/sites/home-1/twin");
    expect(locationForRoute("outdoor", "home-1")).toBe("/sites/home-1/outdoor");
    expect(locationForRoute("integrations", "home-1")).toBe("/setup?site=home-1");
  });

  it("keeps the active Setup section while adding or changing home scope", () => {
    expect(locationForRoute("integrations", "helsinki", "/setup/homes")).toBe("/setup/homes?site=helsinki");
    expect(locationForRoute("integrations", "tokyo", "/setup/weather/")).toBe("/setup/weather?site=tokyo");
    expect(locationForRoute("integrations", "helsinki", "/overview")).toBe("/setup?site=helsinki");
  });

  it.each([
    ["overview", "/overview", null],
    ["twin", "/sites/home%20%2F%20one/twin", "home / one"],
    ["outdoor", "/sites/home%20%2F%20one/outdoor", "home / one"],
    ["sensors", "/sensors?site=home%20%2F%20one", "home / one"],
    ["alerts", "/alerts?site=home%20%2F%20one", "home / one"],
    ["integrations", "/setup?site=home%20%2F%20one", "home / one"],
    ["developer", "/developer", null],
  ] satisfies Array<[AppPage, string, string | null]>) (
    "round-trips the %s route without losing its global or site scope",
    (page, expectedUrl, expectedHouseId) => {
      const url = locationForRoute(page, "home / one");
      expect(url).toBe(expectedUrl);
      expect(routeFromUrl(url)).toEqual({ page, houseId: expectedHouseId });
    },
  );

  it("recognizes global routes without requiring a selected site", () => {
    expect(routeFromUrl("/overview/")).toEqual({ page: "overview", houseId: null });
    expect(routeFromUrl("/developer")).toEqual({ page: "developer", houseId: null });
    expect(routeFromUrl("/setup/weather")).toEqual({ page: "integrations", houseId: null });
  });
});
