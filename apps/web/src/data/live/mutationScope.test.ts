import { describe, expect, it } from "vitest";
import { mutationScope } from "./mutationScope";

const scope = (method: string, resource: string) => mutationScope({
  method,
  resource,
  occurredAt: "2027-01-15T08:00:00Z",
});

describe("mutationScope", () => {
  it.each([
    ["POST", "/houses"],
    ["DELETE", "/houses/home-1"],
    ["POST", "/properties"],
    ["DELETE", "/properties/property-1"],
    ["POST", "/tenant/members"],
    ["PUT", "/stugbys/stuguby-1/grants/grant-1"],
    ["POST", "/stugby-protocol/stugbys/stuguby-1/events"],
    // Guests receive mutations with the path removed.
    ["PATCH", ""],
    ["POST", "/a-route-added-later"],
  ])("re-runs the workspace bootstrap for %s %s", (method, resource) => {
    expect(scope(method, resource).bootstrap).toBe(true);
  });

  it.each([
    ["PATCH", "/sensors/sensor-1", ["sensors"]],
    ["POST", "/sensors", ["sensors"]],
    ["DELETE", "/sensors/sensor-1", ["sensors", "homeSnapshot"]],
    ["POST", "/setup/bulk-sensor-mappings", ["sensors", "homeSnapshot"]],
    ["PATCH", "/houses/home-1", ["houses", "sensors"]],
    ["PUT", "/houses/home-1/floors/ground", ["houses", "sensors"]],
    ["PATCH", "/properties/property-1", ["properties"]],
    ["POST", "/property-areas", ["propertyAreas"]],
    ["PATCH", "/area-equipment/heater/links/link-1", ["areaEquipment"]],
    ["POST", "/equipment-loans/loan-1/return", ["areaEquipment"]],
    ["DELETE", "/property-notes/note-1", ["propertyNotes"]],
    ["PATCH", "/maintenance-tasks/task-1", ["maintenanceTasks"]],
    ["POST", "/integrations/apple-notes/capture", ["maintenanceTasks"]],
    ["PATCH", "/observations/observation-1", ["homeSnapshot"]],
    ["POST", "/static-parameters", ["homeSnapshot"]],
    ["POST", "/alerts/alert-1/acknowledge", ["alerts"]],
    ["PATCH", "/alert-rules/rule-1", ["alerts"]],
    ["PUT", "/integrations/telegram/config", ["integrations"]],
    ["PUT", "/integrations/tp-link/config", ["integrations", "tpLinkDevices", "sensors", "homeSnapshot"]],
    ["DELETE", "/integrations/home-assistant/config/home-1", ["integrations", "sensors", "homeSnapshot"]],
    ["PATCH", "/measurement-definitions/co2", ["measurementDefinitions"]],
  ])("reloads only what %s %s changes", (method, resource, store) => {
    const result = scope(method, resource);
    expect(result.bootstrap).toBe(false);
    expect(result.store).toEqual(store);
  });

  it.each([
    ["PATCH", "/action-runs/run-1"],
    ["POST", "/notification-deliveries/delivery-1/retry"],
    ["PATCH", "/tracking/endpoints/endpoint-1/status"],
    ["POST", "/system/updates/check"],
    ["POST", "/backups"],
    ["PUT", "/houses/home-1/layers/config"],
    ["POST", "/houses/home-1/opening-states"],
    ["POST", "/houses/home-1/scheduled-data-exports"],
    ["PATCH", "/properties/property-1/tracking-settings"],
    ["POST", "/integrations/tp-link/test"],
    ["POST", "/integrations/gree/cloud/discover"],
    ["POST", "/integrations/discovery-jobs"],
    ["POST", "/integrations/tp-link/history-export/jobs/job-1/retry"],
    ["DELETE", "/integrations/apple-notes/grants/grant-1"],
  ])("refreshes nothing in the store for %s %s", (method, resource) => {
    const result = scope(method, resource);
    expect(result.bootstrap).toBe(false);
    expect(result.store).toEqual([]);
  });

  it("names the Home and Property a resource path scopes queries to", () => {
    expect(scope("PUT", "/houses/home%201/layout")).toMatchObject({ houseId: "home 1", queries: ["monitoring", "analytics"] });
    expect(scope("PUT", "/properties/property-1/electricity/tariff")).toMatchObject({
      propertyId: "property-1",
      queries: ["electricity"],
      store: [],
    });
    expect(scope("PATCH", "/sensors/sensor-1")).toMatchObject({ houseId: null, queries: ["monitoring", "analytics"] });
    expect(scope("PATCH", "/heat-pumps/pump-1/placement").queries).toEqual(["heatPumps", "monitoring"]);
    expect(scope("PATCH", "/connected-devices/plug-1/placement").queries).toEqual(["connectedDevices", "monitoring"]);
  });
});
