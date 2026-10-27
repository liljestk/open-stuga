import { rmSync } from "node:fs";

import { SpatialLayerEngineRegistry, type SpatialLayerEngine } from "@climate-twin/spatial-layers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EngineHost,
  SpatialExecutionTimeoutError,
  SpatialLayerScheduler,
  SpatialLayerStateStore,
  type SpatialInferenceAdmission,
} from "../src/spatial-layers/index.js";
import {
  coreDatabases,
  enableEngine,
  partition,
  runtimes,
  scope,
  seededRuntime,
  temporaryDirectories,
} from "./spatial-layersTestSupport.js";

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const database of coreDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function schedulerFixture(input: {
  admission: SpatialInferenceAdmission;
  report?: { status: "succeeded" | "failed"; failures: Array<{ engineId: string; code: string; message: string }> };
}) {
  const store = new SpatialLayerStateStore(":memory:");
  const now = new Date("2026-08-08T09:00:00.000Z");
  const warn = vi.fn();
  const inferScope = vi.fn(async () => ({
    scope,
    bucketAt: now.toISOString(),
    snapshots: [],
    ...(input.report ?? { status: "succeeded" as const, failures: [] }),
  }));
  const host = {
    partition,
    ensureAllScopeDefaults: () => [scope],
    ensureScopeDefaults: () => ({ configuration: {}, assignments: [] }),
    cancelScope: vi.fn(),
    inferScope,
  } as unknown as EngineHost;
  const scheduler = new SpatialLayerScheduler({
    host,
    state: store,
    admission: input.admission,
    admissionRetryMs: 15_000,
    logger: { warn },
    now: () => now,
  });
  const session = scheduler.startHouseSession({ houseId: scope.id });
  const job = () => {
    const row = store.db.prepare("SELECT id FROM spatial_inference_jobs WHERE session_id = ?").get(session.id) as { id: string };
    return store.getJob(partition, row.id)!;
  };
  return { store, scheduler, warn, inferScope, job };
}

describe("spatial inference failure handling", () => {
  it("defers the job and warns when the admission check itself fails", async () => {
    const { store, scheduler, warn, inferScope, job } = schedulerFixture({
      admission: { async acquire() { throw new Error("governor unavailable"); } },
    });

    await scheduler.tick();

    expect(job()).toMatchObject({ status: "pending", attempts: 0, availableAt: "2026-08-08T09:00:15.000Z" });
    expect(inferScope).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "house", scopeId: scope.id, error: "governor unavailable" }),
      "Spatial inference admission check failed",
    );
    await scheduler.stop();
    store.close();
  });

  it("schedules a retry for a failed run and still reports a lease that cannot be released", async () => {
    const release = vi.fn(async () => { throw new Error("lease already gone"); });
    const { store, scheduler, warn, job } = schedulerFixture({
      admission: { async acquire() { return { release }; } },
      report: { status: "failed", failures: [{ engineId: "climate-scalars", code: "ENGINE_FAILURE", message: "boom" }] },
    });

    await scheduler.tick();

    expect(job()).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "climate-scalars:ENGINE_FAILURE",
      availableAt: "2026-08-08T09:00:02.000Z",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: scope.id, dataMode: partition.dataMode, attempts: 1 }),
      "Spatial inference job failed",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: scope.id, error: "lease already gone" }),
      "Spatial inference admission lease release failed",
    );
    await scheduler.stop();
    store.close();
  });

  it("records an engine timeout as timed out and an unsupported scope as a failure", async () => {
    const timing: SpatialLayerEngine = {
      manifest: {
        id: "test-timing-engine", version: "1.0.0", maturity: "research", title: "Timing", description: "Test",
        supportedScopes: ["house"], requiredMetrics: [], producedLayerIds: ["test.timing"],
      },
      infer() { return []; },
    };
    const propertyOnly: SpatialLayerEngine = {
      manifest: {
        id: "test-property-only", version: "1.0.0", maturity: "research", title: "Property", description: "Test",
        supportedScopes: ["property"], requiredMetrics: [], producedLayerIds: ["test.property-only"],
      },
      infer() { return []; },
    };
    const { runtime, core } = seededRuntime(new SpatialLayerEngineRegistry().register(timing).register(propertyOnly));
    const houseScope = { kind: "house" as const, id: core.listHouses()[0]!.id };
    const warn = vi.fn();
    const host = new EngineHost({
      ...runtime.host.dependencies,
      logger: { warn },
      executor: {
        async execute() { throw new SpatialExecutionTimeoutError("deliberate timeout"); },
        close() {},
      },
    });
    host.ensureScopeDefaults(houseScope);
    enableEngine(runtime, houseScope, timing.manifest.id);
    enableEngine(runtime, houseScope, propertyOnly.manifest.id);

    const report = await host.inferScope(houseScope, new Date().toISOString());

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(expect.arrayContaining([
      { engineId: timing.manifest.id, code: "ENGINE_TIMEOUT", message: "deliberate timeout" },
      { engineId: propertyOnly.manifest.id, code: "ENGINE_FAILURE", message: "Engine test-property-only does not support house" },
    ]));
    expect(runtime.state.latestRun(host.partition, houseScope, timing.manifest.id)?.status).toBe("timed_out");
    expect(runtime.state.latestRun(host.partition, houseScope, propertyOnly.manifest.id)?.status).toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ engineId: timing.manifest.id, errorCode: "ENGINE_TIMEOUT" }),
      "Spatial layer engine failed in isolation",
    );
  });
});
