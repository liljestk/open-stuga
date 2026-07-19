import { describe, expect, it } from "vitest";
import {
  layerMetricText,
  layerStrength,
  spatialCalibrationSessionResult,
  spatialCalibrationSessions,
  spatialLayerSnapshotEvent,
  spatialLayerSnapshots,
} from "./spatialLayers";

function canonicalSnapshot() {
  return {
    scope: { kind: "property", id: "property-1" },
    coordinateFrames: [{ id: "site", version: "4", kind: "property-local-3d", unit: "m", origin: { x: 0, y: 0, z: 0 } }],
    layerId: "climate.unexplained-activity.research",
    model: { id: "residual-activity", version: "1.0.0", maturity: "research" },
    generatedAt: "2026-07-16T12:00:00.000Z",
    windowStart: "2026-07-16T11:30:00.000Z",
    windowEnd: "2026-07-16T12:00:00.000Z",
    status: "ready",
    configVersion: "4",
    inputDigest: "digest",
    qualityScore: 0.76,
    warnings: [],
    reasonCodes: ["persistent-local-residual"],
    zones: [{
      zoneId: "property:property-1:house:house-1",
      frameId: "site",
      name: "Pine House",
      polygon: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }],
      tags: ["house:house-1"],
      anchor: { x: 2, y: 3, z: 2.4 },
      metrics: { activityEvidenceScore: { value: 0.68, quality: 0.8 } },
      evidence: [{ score: 0.72, kind: "inference", reasonCodes: ["local-heat-residual"] }],
      reasonCodes: [],
      style: { palette: "activity", opacity: 0.55 },
    }],
    connections: [{
      connectionId: "stairs",
      anchorRefs: [
        { frameId: "ground", position: { x: 1, y: 1, z: 0.2 } },
        { frameId: "upper", position: { x: 1, y: 1, z: 3.2 } },
      ],
      fromZoneId: "ground-zone",
      toZoneId: "upper-zone",
      state: "directed",
      metrics: { evidenceStrength: { value: 0.61, quality: 0.7 } },
      evidence: [{ score: 0.64, kind: "inference", reasonCodes: [] }],
      reasonCodes: [],
      style: { direction: "a-to-b", lineStyle: "dashed" },
    }],
    points: [],
    metadata: { snapshotId: "snapshot-1", revision: 3, staleAfterSeconds: 120 },
  };
}

describe("spatial layer browser contracts", () => {
  it("normalizes guided calibration sessions while ignoring incompatible records", () => {
    const sessions = spatialCalibrationSessions({ sessions: [{
      id: "session-1",
      houseId: "house-1",
      kind: "empty-house-baseline",
      status: "running",
      startAt: "2026-07-16T20:00:00.000Z",
      endAt: null,
      intervention: { awayMode: true },
      notes: "House empty",
    }, { id: "future-record", kind: "unsupported" }] });
    expect(sessions).toEqual([expect.objectContaining({
      id: "session-1",
      kind: "empty-house-baseline",
      status: "running",
      endAt: null,
      intervention: { awayMode: true },
    })]);

    expect(spatialCalibrationSessionResult({ session: sessions[0], calibrations: [] })).toEqual({
      session: sessions[0],
      calibrations: [],
    });
  });

  it("retains snapshot-local frames, geometry, property tags, and cross-frame anchors", () => {
    const [snapshot] = spatialLayerSnapshots({ layers: [canonicalSnapshot()] });

    expect(snapshot).toMatchObject({ id: "snapshot-1", revision: 3, staleAfterSeconds: 120 });
    expect(snapshot?.coordinateFrames).toEqual([expect.objectContaining({ id: "site", kind: "property-local-3d", unit: "m" })]);
    expect(snapshot?.zones[0]).toMatchObject({
      label: "Pine House",
      tags: ["house:house-1"],
      polygon: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }],
      centroid: { x: 2, y: 3, z: 2.4 },
      style: { palette: "activity", opacity: 0.55 },
    });
    expect(snapshot?.connections[0]).toMatchObject({
      state: "directed",
      anchorRefs: [
        { frameId: "ground", position: { x: 1, y: 1, z: 0.2 } },
        { frameId: "upper", position: { x: 1, y: 1, z: 3.2 } },
      ],
      style: { direction: "forward", line: "dashed" },
    });
  });

  it("uses the canonical activity and propagation evidence metric names", () => {
    const [snapshot] = spatialLayerSnapshots({ layers: [canonicalSnapshot()] });
    expect(layerStrength(snapshot!.zones[0]!)).toBeCloseTo(0.72);
    expect(layerStrength(snapshot!.connections[0]!)).toBeCloseTo(0.64);
    expect(layerMetricText(snapshot!.layerId, snapshot!.zones[0]!, "en")).toBeNull();
  });

  it("accepts host snapshot notifications that carry snapshot IDs instead of a layer ID", () => {
    expect(spatialLayerSnapshotEvent({
      partition: "live",
      scope: { kind: "house", id: "house-1" },
      snapshotIds: ["snapshot-1", "snapshot-2"],
      bucketAt: "2026-07-16T12:00:00.000Z",
      emittedAt: "2026-07-16T12:00:01.000Z",
    })).toEqual({
      scope: { kind: "house", id: "house-1" },
      snapshotIds: ["snapshot-1", "snapshot-2"],
      generatedAt: "2026-07-16T12:00:00.000Z",
    });
  });
});
