import type { HeatPumpState } from "@climate-twin/contracts";

export type HeatPumpInfluenceKind =
  | "off"
  | "cooling"
  | "heating"
  | "drying"
  | "circulating"
  | "selected"
  | "unknown";

export interface HeatPumpInfluenceEstimate {
  kind: HeatPumpInfluenceKind;
  intensity: number;
  /** True only when a positive compressor-frequency report supports the estimate. */
  compressorEvidence: boolean;
  visible: boolean;
}

/**
 * A conservative display estimate, not measured airflow or causal thermal impact.
 * Selected mode alone is shown as uncertain and deliberately kept low-intensity.
 */
export function estimateHeatPumpInfluence(state: HeatPumpState): HeatPumpInfluenceEstimate {
  if (!state.available) return { kind: "unknown", intensity: 0, compressorEvidence: false, visible: false };
  if (state.power === false) return { kind: "off", intensity: 0, compressorEvidence: false, visible: false };
  if (state.power !== true || !state.selectedMode) {
    return { kind: "unknown", intensity: 0, compressorEvidence: false, visible: false };
  }
  const frequency = state.compressorFrequencyHz;
  const compressorEvidence = frequency !== null && frequency > 0;
  const intensity = compressorEvidence ? Math.max(.25, Math.min(1, frequency / 60)) : .18;
  const kind: HeatPumpInfluenceKind = state.selectedMode === "cool"
    ? "cooling"
    : state.selectedMode === "heat"
      ? "heating"
      : state.selectedMode === "dry"
        ? "drying"
        : state.selectedMode === "fan"
          ? "circulating"
          : "selected";
  return { kind, intensity, compressorEvidence, visible: kind !== "selected" || compressorEvidence };
}
