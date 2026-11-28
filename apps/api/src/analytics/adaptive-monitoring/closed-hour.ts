import { mean, median } from "@climate-twin/analytics-kernel";
import type { AdaptiveHourlyEvidence, DataMode } from "@climate-twin/contracts";
import { HOUR_MS } from "../forecast/models.js";

export const ADAPTIVE_CAPTURE_HORIZON_MS = 48 * HOUR_MS;
export const ADAPTIVE_HOUR_RETENTION_MS = 90 * 24 * HOUR_MS;
export const ADAPTIVE_MAX_HOUR_ROWS = 4_096;
export const ADAPTIVE_CADENCE_LOOKBACK_MS = 72 * HOUR_MS;
export const ADAPTIVE_MAX_CADENCE_ROWS = 1_024;

const observedSources = new Set(["home-assistant", "tp-link", "tuya", "nexus433", "gree", "api"]);

export type HourGap = "missing" | "source-conflict" | "unknown-cadence" | "low-coverage" | "row-limit";

export interface HourObservation { time: number; value: number; source: string }

export type ClosedHour =
  | { evidence: AdaptiveHourlyEvidence; source: string; reason: null; coverage: number }
  | { evidence: null; source: null; reason: HourGap; coverage: number };

export function isObservedSource(source: string, mode: DataMode): boolean {
  return mode === "demo" ? source === "mock" : observedSources.has(source);
}

export function expectedCadenceMs(orderedTimes: readonly number[]): number | null {
  const gaps = orderedTimes.slice(1)
    .map((time, index) => time - orderedTimes[index]!)
    .filter((gap) => gap >= 1_000 && gap <= 86_400_000);
  return gaps.length >= 20 ? median(gaps) : null;
}

interface HourInput {
  epochId: string;
  dataMode: DataMode;
  hour: number;
  availableAt: number;
  observations: HourObservation[];
  expectedSource: string | null;
  cadenceMs: number | null;
}

export function missingHour(reason: HourGap, coverage = 0): ClosedHour {
  return { evidence: null, source: null, reason, coverage };
}

/** Count at most one reporting interval per slot; bursts do not fill missing parts of the hour. */
export function summarizeClosedHour(input: HourInput): ClosedHour {
  const source = input.observations[0]?.source;
  if (!source) return missingHour("missing");
  if ((input.expectedSource !== null && input.expectedSource !== source)
    || input.observations.some((point) => point.source !== source)) return missingHour("source-conflict");
  if (!input.cadenceMs) return missingHour("unknown-cadence");

  const slots = new Map<number, number[]>();
  for (const observation of input.observations) {
    const slot = Math.floor((observation.time - input.hour) / input.cadenceMs);
    const values = slots.get(slot) ?? [];
    values.push(observation.value);
    slots.set(slot, values);
  }
  const coverage = Math.min(1, slots.size / Math.max(1, HOUR_MS / input.cadenceMs));
  if (coverage < 0.8) return missingHour("low-coverage", coverage);
  const value = mean([...slots.values()].map((values) => mean(values)!))!;
  return {
    source, reason: null, coverage,
    evidence: {
      epochId: input.epochId, time: input.hour, availableAt: input.availableAt, value, coverage, quality: "good",
      source: input.dataMode === "demo" ? "demo" : "observed", archiveComplete: true,
    },
  };
}
