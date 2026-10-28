import { type ConnectedDeviceCommand, type ConnectedDevicePlacementPatch, type HeatPumpPlacementPatch, withSignal } from "@climate-twin/contracts";
import { request } from "./support/request";
import { connectedDeviceStateShape, heatPumpStateShape } from "./support/entity-shapes";
import { string, boolean, nullable, arrayOf, fields } from "./support/response-shapes";

/** Connected devices and heat pumps: state, commands, placement and history. */
export const devicesApi = {
  connectedDevices: async (houseId?: string, signal?: AbortSignal) => (await request(`/connected-devices${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, fields({ devices: arrayOf(connectedDeviceStateShape) }), withSignal(signal))).devices,
  commandConnectedDevice: (connectionId: string, command: ConnectedDeviceCommand) => request(`/connected-devices/${encodeURIComponent(connectionId)}/commands`, fields({ ok: boolean, deduplicated: boolean, state: connectedDeviceStateShape }), {
    method: "POST",
    body: JSON.stringify(command),
  }),
  placeConnectedDevice: (connectionId: string, placement: ConnectedDevicePlacementPatch) => request(`/connected-devices/${encodeURIComponent(connectionId)}/placement`, fields({ state: nullable(connectedDeviceStateShape), energySensorId: nullable(string) }), {
    method: "PATCH",
    body: JSON.stringify(placement),
  }),
  heatPumpStates: async (houseId?: string, signal?: AbortSignal) => (await request(`/heat-pumps${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, fields({ states: arrayOf(heatPumpStateShape) }), withSignal(signal))).states,
  placeHeatPump: (connectionId: string, placement: HeatPumpPlacementPatch) => request(`/heat-pumps/${encodeURIComponent(connectionId)}/placement`, fields({ state: nullable(heatPumpStateShape) }), {
    method: "PATCH",
    body: JSON.stringify(placement),
  }),
  heatPumpHistory: async (
    connectionId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.from) query.set("from", options.from);
    if (options.to) query.set("to", options.to);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return (await request(`/heat-pumps/${encodeURIComponent(connectionId)}/history${suffix}`, fields({ states: arrayOf(heatPumpStateShape) }))).states;
  },
};
