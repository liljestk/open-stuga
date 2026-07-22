import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { spatialLayerSnapshots } from "../spatialLayers";
import { SpatialLayerOverlay2D } from "./SpatialLayerOverlay2D";
import { SpatialLayerOverlay3D } from "./SpatialLayerOverlay3D";
import { ExperimentalSensorCoverage2D, ExperimentalSensorCoverage3D } from "./ExperimentalSensorCoverage";
import type { SensorCoverageAssessment } from "../experimentalSpatialLayers";

function rawSnapshot(layerId = "climate.temperature") {
  const state = createDemoState();
  const house = state.houses[0]!;
  const upper = house.floors[1]!;
  const room = upper.rooms[0]!;
  return {
    scope: { kind: "house", id: house.id },
    coordinateFrames: [{ id: "upper-frame", version: "1", kind: "building-local-3d", unit: "normalized", floorId: upper.id, origin: { x: 0, y: 0, z: 0 } }],
    layerId,
    model: { id: "test", version: "1", maturity: "research" },
    generatedAt: "2026-07-16T12:00:00.000Z",
    windowStart: "2026-07-16T11:30:00.000Z",
    windowEnd: "2026-07-16T12:00:00.000Z",
    status: "ready",
    configVersion: "1",
    inputDigest: "test",
    qualityScore: 0.8,
    warnings: [],
    reasonCodes: [],
    zones: [{
      zoneId: `house:${house.id}:floor:${upper.id}:room:${room.id}`,
      frameId: "upper-frame",
      floorId: upper.id,
      roomId: room.id,
      name: room.name,
      polygon: room.points,
      anchor: { x: 200, y: 220, z: 4.3 },
      metrics: layerId.includes("activity")
        ? { activityEvidenceScore: { value: 0.8, quality: 0.8 } }
        : { temperatureC: { value: 21.5, unit: "°C", quality: 0.8 } },
      evidence: [{ score: 0.8, kind: "inference", reasonCodes: [] }],
      reasonCodes: [],
      style: { palette: layerId.includes("activity") ? "activity" : "temperature" },
    }],
    connections: [{
      connectionId: "cross-floor",
      anchorRefs: [
        { frameId: "ground-frame", position: { x: 100, y: 100, z: 0.2 } },
        { frameId: "upper-frame", position: { x: 200, y: 220, z: 3.2 } },
      ],
      fromZoneId: "ground-zone",
      toZoneId: `house:${house.id}:floor:${upper.id}:room:${room.id}`,
      state: "directed",
      metrics: { evidenceStrength: { value: 0.8, quality: 0.8 } },
      evidence: [{ score: 0.8, kind: "inference", reasonCodes: [] }],
      reasonCodes: [],
      style: { direction: "a-to-b" },
    }],
    points: [{
      pointId: "sensor-upper",
      frameId: "upper-frame",
      position: { x: 200, y: 220, z: 4.4 },
      metrics: { temperatureC: { value: 21.5, quality: 0.8 } },
      evidence: [{ score: 0.8, kind: "observation", reasonCodes: [] }],
      reasonCodes: [],
    }],
  };
}

describe("snapshot-backed spatial render adapters", () => {
  it("renders snapshot-local room geometry on the matching 2D floor without topology state", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[1]!;
    const [snapshot] = spatialLayerSnapshots({ layers: [rawSnapshot()] });
    const view = render(<I18nProvider><svg><SpatialLayerOverlay2D floor={floor} snapshots={[snapshot!]} topology={null} scale={1} /></svg></I18nProvider>);

    expect(view.container.querySelectorAll(".spatial-zone-value polygon")).toHaveLength(1);
    expect(view.getAllByText(/21.5/).length).toBeGreaterThan(0);
    expect(view.getByRole("img").getAttribute("aria-label")).toMatch(new RegExp(`${floor.rooms[0]!.name}.*21\\.5.*80%`, "i"));
  });

  it("uses absolute snapshot z coordinates in 3D and never renders activity as an exact trail or point", () => {
    const state = createDemoState();
    const [snapshot] = spatialLayerSnapshots({ layers: [rawSnapshot("climate.unexplained-activity.research")] });
    const project = vi.fn((point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.y, depth: point.z }));
    const view = render(<I18nProvider><svg><SpatialLayerOverlay3D house={state.houses[0]!} snapshots={[snapshot!]} topology={null} project={project} /></svg></I18nProvider>);

    expect(project.mock.calls.some(([point]) => point.z === 4.3)).toBe(true);
    expect(project.mock.calls.some(([point]) => point.z === 7.3)).toBe(false);
    expect(view.container.querySelector(".spatial-connection-values line")).toBeNull();
    expect(view.container.querySelector(".spatial-point-values circle")).toBeNull();
  });
});

describe("sensor-support view layer", () => {
  const assessment = (floorId: string): SensorCoverageAssessment => ({
    regions: [{
      id: "coverage:sensor", sensorId: "sensor", floorId, x: 120, y: 160, z: 1.4,
      radiusX: 80, radiusY: 70, radiusZ: .9, support: .8, pairedHumidity: true,
    }],
    recommendations: [{
      id: "placement:room", floorId, floorName: "Ground floor", roomName: "Bedroom",
      x: 320, y: 240, z: 1.4, reason: "room-uncovered",
    }],
    freshTemperatureSensors: 1,
    pairedHumiditySensors: 1,
    staleOrMissingSensors: 0,
    enabledSensors: 1,
    coverageScore: .44,
    support: "medium",
  });

  it("renders the same support region and suggested position in the 2D slice", () => {
    const state = createDemoState();
    const floor = state.houses[0]!.floors[0]!;
    const view = render(<I18nProvider><svg><ExperimentalSensorCoverage2D floor={floor} assessment={assessment(floor.id)} scale={1} /></svg></I18nProvider>);

    expect(view.container.querySelectorAll(".coverage-regions ellipse")).toHaveLength(1);
    expect(view.getByLabelText(/suggested environmental sensor position.*bedroom/i)).not.toBeNull();
  });

  it("projects support as a 3D volume and keeps the placement recommendation accessible", () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    const floor = house.floors[0]!;
    const project = vi.fn((point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.y - point.z * 10, depth: point.z }));
    const view = render(<I18nProvider><svg><ExperimentalSensorCoverage3D house={house} assessment={assessment(floor.id)} project={project} /></svg></I18nProvider>);

    expect(view.container.querySelectorAll(".coverage-regions ellipse")).toHaveLength(1);
    expect(project.mock.calls.some(([point]) => point.z > 1.4)).toBe(true);
    expect(view.getByLabelText(/suggested environmental sensor position.*bedroom/i)).not.toBeNull();
  });
});
