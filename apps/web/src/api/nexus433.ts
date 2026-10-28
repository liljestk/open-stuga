import { withSignal } from "@climate-twin/contracts";
import type {
  Nexus433Binding,
  Nexus433BindingCreateInput,
  Nexus433Candidate,
  Nexus433ConfigInput,
  Nexus433ReconnectInput,
} from "@climate-twin/contracts";
import { request } from "./support/request";
import { nexus433BindingShape, nexus433CandidateShape, nexus433StatusShape, sensorShape } from "./support/entity-shapes";
import { optional, arrayOf, fields } from "./support/response-shapes";

export const nexus433Api = {
  nexus433Status: (houseId: string, signal?: AbortSignal) => request(
    `/integrations/nexus433/status?houseId=${encodeURIComponent(houseId)}`, nexus433StatusShape,
    withSignal(signal),
  ),
  configureNexus433: (input: Nexus433ConfigInput) => request(
    "/integrations/nexus433/config", nexus433StatusShape,
    { method: "PUT", body: JSON.stringify(input) },
  ),
  nexus433Candidates: async (houseId: string, signal?: AbortSignal): Promise<Nexus433Candidate[]> => (
    await request(
      `/integrations/nexus433/candidates?houseId=${encodeURIComponent(houseId)}`, fields({ candidates: arrayOf(nexus433CandidateShape) }),
      withSignal(signal),
    )
  ).candidates,
  nexus433Bindings: async (houseId: string, signal?: AbortSignal): Promise<Nexus433Binding[]> => (
    await request(
      `/integrations/nexus433/bindings?houseId=${encodeURIComponent(houseId)}`, fields({ bindings: arrayOf(nexus433BindingShape) }),
      withSignal(signal),
    )
  ).bindings,
  bindNexus433Candidate: (input: Nexus433BindingCreateInput) => request("/integrations/nexus433/bindings", fields({ binding: nexus433BindingShape, sensor: optional(sensorShape) }), { method: "POST", body: JSON.stringify(input) }),
  reconnectNexus433Sensor: (sensorId: string, input: Nexus433ReconnectInput) => request(`/integrations/nexus433/bindings/${encodeURIComponent(sensorId)}/reconnect`, fields({ binding: nexus433BindingShape }), {
    method: "POST",
    body: JSON.stringify(input),
  }),
};
