import { screen, waitFor } from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import { expect, vi } from "vitest";

import { useState, type ReactNode } from "react";

import type { Floor, MeasurementDefinition, MeasurementSample, Sensor } from "@climate-twin/contracts";

import { FloorPlan } from "./components/FloorPlan";

import { type ClimateState } from "./domain";

import { I18nProvider } from "./i18n";

export function withI18n(node: ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

export function samplesFor(state: ClimateState, definition: MeasurementDefinition, sensors: Sensor[] = state.sensors) {
  return Object.fromEntries(sensors.flatMap((sensor) => {
    const sample = state.latestMeasurements[sensor.id]?.[definition.id];
    return sample ? [[sensor.id, sample]] : [];
  })) as Record<string, MeasurementSample>;
}

export function ControlledFloorPlan({
  initialFloor, definition, sensors = [], onChange,
}: {
  initialFloor: Floor;
  definition: MeasurementDefinition;
  sensors?: Sensor[];
  onChange: (floor: Floor) => void;
}) {
  const [floor, setFloor] = useState(initialFloor);
  return (
    <FloorPlan
      floor={floor} sensors={sensors} samples={{}} observations={[]} definition={definition} units="metric"
      viewMode="plan" selectedSensorId={null} editing observationPlacement={false}
      onSensorSelect={vi.fn()} onSensorMove={vi.fn()} onFloorChange={(next) => { setFloor(next); onChange(next); }}
      onObservationPoint={vi.fn()} onCancelObservationPlacement={vi.fn()}
    />
  );
}

export async function openFloorAddTools(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText("Add", { selector: "summary" });
  await user.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
}

export async function openFloorEditorOptions(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText("Editor options", { selector: "summary" });
  await user.click(summary);
  await waitFor(() => expect(summary.closest("details")?.open).toBe(true));
}

export function declarationsFor(source: string, selector: string) {
  const result: Record<string, string> = {};
  let previousClose = -1;
  let open = source.indexOf("{");
  while (open !== -1) {
    const close = source.indexOf("}", open + 1);
    if (close === -1) break;
    const header = source.slice(previousClose + 1, open);
    if (header.includes(selector)) {
      for (const declaration of source.slice(open + 1, close).split(";")) {
        const colon = declaration.indexOf(":");
        if (colon === -1) continue;
        result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    previousClose = close;
    open = source.indexOf("{", open + 1);
  }
  return result;
}

export function resolveVariable(value: string | undefined, variables: Record<string, string>): string {
  if (!value) throw new Error("Expected a CSS color declaration");
  const match = value.match(/^var\((--[^,)]+)/);
  return match ? resolveVariable(variables[match[1]!], variables) : value;
}

export function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const normalized = color.startsWith("#")
      ? color.length === 4
        ? color.slice(1).split("").map((channel) => parseInt(channel + channel, 16))
        : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((channel) => parseInt(channel, 16))
      : color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const channels = normalized;
    if (channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}
