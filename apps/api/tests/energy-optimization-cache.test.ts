import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("energy optimization request reuse", () => {
  let runtime: ApiRuntime | undefined;
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await runtime?.close(); });
  it("coalesces repeated reads, separates query variants, and invalidates after a mutation", async () => {
    runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false });
    const propertyId = runtime.database.listProperties()[0]!.id;
    const report = { propertyId, generatedAt: new Date().toISOString(), insights: [] } as never;
    const calculate = vi.spyOn(runtime.energyOptimizer, "report").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return report;
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:01.000Z"));
    const path = `/api/v1/properties/${propertyId}/energy-optimization`;
    await Promise.all([request(runtime.app).get(path).expect(200), request(runtime.app).get(path).expect(200)]);
    await request(runtime.app).get(path).expect(200);
    expect(calculate).toHaveBeenCalledTimes(1);
    await request(runtime.app).get(path).query({ windowHours: 3 }).expect(200);
    expect(calculate).toHaveBeenCalledTimes(2);
    runtime.bus.publish({ type: "mutation", data: { method: "PATCH", resource: "/sensors/sensor-01",
      occurredAt: new Date().toISOString() } });
    await request(runtime.app).get(path).expect(200);
    expect(calculate).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-10-04T12:00:32.000Z"));
    await request(runtime.app).get(path).expect(200);
    expect(calculate).toHaveBeenCalledTimes(4);
    const absent = await request(runtime.app).get("/api/v1/properties/missing-property/energy-optimization").expect(404);
    expect(absent.body.error.code).toBe("NOT_FOUND");
    expect(calculate).toHaveBeenCalledTimes(4);
  });
});
