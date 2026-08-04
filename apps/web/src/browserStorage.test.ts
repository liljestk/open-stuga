import type { AppSession } from "@climate-twin/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  accountScopedStorageKeyForTest,
  accountStorageKeyFamilies,
  activateAccountStorage,
  deactivateAccountStorage,
  readLocalStorage,
  removeLocalStorage,
  writeLocalStorage,
} from "./browserStorage";

const session = (email: string, tenantId = "tenant-1"): AppSession => ({
  authenticated: true,
  principal: { type: "local", email },
  tenant: { id: tenantId, name: "Stugu", role: "owner" },
  availableTenants: [{ id: tenantId, name: "Stugu", role: "owner" }],
  readOnly: false,
  grants: [],
});

describe("account-scoped browser storage", () => {
  it("keeps an explicit inventory of all 19 production localStorage key families", () => {
    expect(accountStorageKeyFamilies).toEqual([
      { key: "climate-twin-locale", kind: "exact", legacy: "migrate" },
      { key: "climate-twin-units", kind: "exact", legacy: "migrate" },
      { key: "climate-twin-navigation", kind: "exact", legacy: "migrate" },
      { key: "climate-twin-map-information", kind: "exact", legacy: "migrate" },
      { key: "climate-twin-outdoor-panel", kind: "exact", legacy: "migrate" },
      { key: "stugu-spatial-layer-panel", kind: "exact", legacy: "migrate" },
      { key: "stugu-experimental-home-visualizations", kind: "exact", legacy: "migrate" },
      { key: "stugu-outdoor-influence-metric", kind: "exact", legacy: "migrate" },
      { key: "stugu-home-map-energy-devices-visible", kind: "exact", legacy: "migrate" },
      { key: "stugu-home-map-connected-devices-visible", kind: "exact", legacy: "migrate" },
      { key: "stugu-home-map-climate-sensors-visible", kind: "exact", legacy: "migrate" },
      { key: "stugu-home-map-opening-state-labels-visible", kind: "exact", legacy: "migrate" },
      { key: "stugu-home-map-animations-enabled", kind: "exact", legacy: "migrate" },
      { key: "stugu-home-map-outdoor-extras-visible", kind: "exact", legacy: "migrate" },
      { key: "stugu-mobile-overview", kind: "exact", legacy: "discard" },
      { key: "stugu-dismissed-tp-link-device-notices", kind: "exact", legacy: "discard" },
      { key: "stugu-dismissed-integration-discovery-notices", kind: "exact", legacy: "discard" },
      { key: "stugu.integration-discovery.", kind: "prefix", legacy: "discard" },
      { key: "stugu-home-pulse-hidden:v1:", kind: "prefix", legacy: "discard" },
    ]);
  });

  it("isolates values by tenant and principal without exposing identity in the key", () => {
    const first = session("First.Person@example.test");
    const second = session("second.person@example.test");
    activateAccountStorage(first);
    expect(writeLocalStorage("climate-twin-units", "imperial")).toBe(true);

    activateAccountStorage(second);
    expect(readLocalStorage("climate-twin-units")).toBeNull();
    writeLocalStorage("climate-twin-units", "metric");

    activateAccountStorage(first);
    expect(readLocalStorage("climate-twin-units")).toBe("imperial");
    expect(accountScopedStorageKeyForTest(first, "climate-twin-units")).not.toContain("First.Person");
  });

  it("migrates presentation preferences but discards unattributable personal and job state", () => {
    const principal = session("owner@example.test");
    localStorage.setItem("climate-twin-locale", "fi");
    localStorage.setItem("stugu-mobile-overview", '{"scope":"home","targetId":"home-1"}');
    localStorage.setItem("stugu-dismissed-tp-link-device-notices", '["device-1"]');
    localStorage.setItem("stugu.integration-discovery.home-1", "job-1");
    localStorage.setItem("stugu-home-pulse-hidden:v1:home-1", '["insight-1"]');

    activateAccountStorage(principal);

    expect(readLocalStorage("climate-twin-locale")).toBe("fi");
    expect(localStorage.getItem("climate-twin-locale")).toBeNull();
    expect(localStorage.getItem(accountScopedStorageKeyForTest(principal, "climate-twin-locale"))).toBe("fi");
    expect(readLocalStorage("stugu-dismissed-tp-link-device-notices")).toBeNull();
    expect(readLocalStorage("stugu-mobile-overview")).toBeNull();
    expect(readLocalStorage("stugu.integration-discovery.home-1")).toBeNull();
    expect(readLocalStorage("stugu-home-pulse-hidden:v1:home-1")).toBeNull();
    expect(localStorage.getItem("stugu-dismissed-tp-link-device-notices")).toBeNull();
    expect(localStorage.getItem("stugu-mobile-overview")).toBeNull();
    expect(localStorage.getItem("stugu.integration-discovery.home-1")).toBeNull();
    expect(localStorage.getItem("stugu-home-pulse-hidden:v1:home-1")).toBeNull();
  });

  it("purges the active namespace on logout while preserving another account", () => {
    const first = session("first@example.test");
    const second = session("second@example.test");
    activateAccountStorage(first);
    writeLocalStorage("climate-twin-units", "imperial");
    activateAccountStorage(second);
    writeLocalStorage("climate-twin-units", "metric");
    writeLocalStorage("future-key", "private");

    deactivateAccountStorage({ purge: true });

    expect(localStorage.getItem(accountScopedStorageKeyForTest(second, "climate-twin-units"))).toBeNull();
    expect(localStorage.getItem(accountScopedStorageKeyForTest(second, "future-key"))).toBeNull();
    expect(localStorage.getItem(accountScopedStorageKeyForTest(first, "climate-twin-units"))).toBe("imperial");
    expect(readLocalStorage("climate-twin-units")).toBeNull();
  });

  it("keeps storage denial non-fatal", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readLocalStorage("key")).toBeNull();
    expect(writeLocalStorage("key", "value")).toBe(false);
    expect(removeLocalStorage("key")).toBe(false);
    get.mockRestore();
    set.mockRestore();
    remove.mockRestore();
  });
});
