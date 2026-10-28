import { withSignal } from "@climate-twin/contracts";
import type {
  Nexus433Binding,
  Nexus433BindingCreateInput,
  Nexus433Candidate,
  Nexus433ConfigInput,
  Nexus433ReconnectInput,
  Nexus433Status,
  Sensor,
} from "@climate-twin/contracts";
import { request } from "./support/request";

export const nexus433Api = {
  nexus433Status: (houseId: string, signal?: AbortSignal) => request<Nexus433Status>(
    `/integrations/nexus433/status?houseId=${encodeURIComponent(houseId)}`,
    withSignal(signal),
  ),
  configureNexus433: (input: Nexus433ConfigInput) => request<Nexus433Status>(
    "/integrations/nexus433/config",
    { method: "PUT", body: JSON.stringify(input) },
  ),
  nexus433Candidates: async (houseId: string, signal?: AbortSignal): Promise<Nexus433Candidate[]> => (
    await request<{ candidates: Nexus433Candidate[] }>(
      `/integrations/nexus433/candidates?houseId=${encodeURIComponent(houseId)}`,
      withSignal(signal),
    )
  ).candidates,
  nexus433Bindings: async (houseId: string, signal?: AbortSignal): Promise<Nexus433Binding[]> => (
    await request<{ bindings: Nexus433Binding[] }>(
      `/integrations/nexus433/bindings?houseId=${encodeURIComponent(houseId)}`,
      withSignal(signal),
    )
  ).bindings,
  bindNexus433Candidate: (input: Nexus433BindingCreateInput) => request<{
    binding: Nexus433Binding;
    sensor?: Sensor;
  }>("/integrations/nexus433/bindings", { method: "POST", body: JSON.stringify(input) }),
  reconnectNexus433Sensor: (sensorId: string, input: Nexus433ReconnectInput) => request<{
    binding: Nexus433Binding;
  }>(`/integrations/nexus433/bindings/${encodeURIComponent(sensorId)}/reconnect`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
};
