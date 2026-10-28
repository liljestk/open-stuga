import { type ConnectedDeviceCommand, type ConnectedDevicePlacementPatch, type ConnectedDeviceState, type HeatPumpPlacementPatch, type HeatPumpState, withSignal } from "@climate-twin/contracts";
import { list, request } from "./support/request";

/** Connected devices and heat pumps: state, commands, placement and history. */
export const devicesApi = {
  connectedDevices: async (houseId?: string, signal?: AbortSignal) => list<ConnectedDeviceState>(
      await request<unknown>(
        `/connected-devices${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`,
        withSignal(signal),
      ),
      "devices",
    ),
  commandConnectedDevice: (connectionId: string, command: ConnectedDeviceCommand) => request<{
    ok: boolean;
    deduplicated: boolean;
    state: ConnectedDeviceState;
  }>(`/connected-devices/${encodeURIComponent(connectionId)}/commands`, {
    method: "POST",
    body: JSON.stringify(command),
  }),
  placeConnectedDevice: (connectionId: string, placement: ConnectedDevicePlacementPatch) => request<{
    state: ConnectedDeviceState | null;
    energySensorId: string | null;
  }>(`/connected-devices/${encodeURIComponent(connectionId)}/placement`, {
    method: "PATCH",
    body: JSON.stringify(placement),
  }),
  heatPumpStates: async (houseId?: string, signal?: AbortSignal) => list<HeatPumpState>(
      await request<unknown>(
        `/heat-pumps${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`,
        withSignal(signal),
      ),
      "states",
    ),
  placeHeatPump: (connectionId: string, placement: HeatPumpPlacementPatch) => request<{
    state: HeatPumpState | null;
  }>(`/heat-pumps/${encodeURIComponent(connectionId)}/placement`, {
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
    return list<HeatPumpState>(
      await request<unknown>(`/heat-pumps/${encodeURIComponent(connectionId)}/history${suffix}`),
      "states",
    );
  },
};
