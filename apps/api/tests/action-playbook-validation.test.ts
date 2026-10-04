import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const valid = {
  name: "Ventilate the room", description: "Verify a measured improvement", instructions: ["Open a window"],
  metric: "temperature", goal: "decrease", minimumImprovement: 1,
  waitSeconds: 0, verificationWindowSeconds: 60,
};

describe("playbook business bounds", () => {
  let runtime: ApiRuntime | undefined;
  afterEach(async () => { await runtime?.close(); });
  function boot() {
    return runtime = createApi({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false" }),
      startBackground: false });
  }

  it.each([
    { verificationWindowSeconds: 0 }, { minimumImprovement: -1 }, { waitSeconds: 604_801 },
    { verificationWindowSeconds: 2_592_001 }, { goal: "below" }, { goal: "above", targetValue: null },
  ])("returns 400 for a formerly crashing create: %j", async patch => {
    const app = boot();
    const count = app.database.listActionPlaybooks().length;
    const result = await request(app.app).post("/api/v1/action-playbooks").send({ ...valid, ...patch }).expect(400);
    expect(result.body.error.code).toBe("INVALID_PLAYBOOK");
    expect(app.database.listActionPlaybooks()).toHaveLength(count);
  });

  it("validates merged patches, leaves invalid records untouched, and accepts boundary values", async () => {
    const app = boot();
    const created = await request(app.app).post("/api/v1/action-playbooks").send(valid).expect(201);
    const path = "/api/v1/action-playbooks/" + created.body.playbook.id;
    for (const patch of [{ verificationWindowSeconds: 0 }, { waitSeconds: 604_801 },
      { minimumImprovement: -1 }, { goal: "below" }, { goal: "above", targetValue: null }]) {
      await request(app.app).patch(path).send(patch).expect(400);
      expect(app.database.getActionPlaybook(created.body.playbook.id)).toEqual(created.body.playbook);
    }
    const updated = await request(app.app).patch(path).send({
      goal: "below", targetValue: 0, waitSeconds: 604_800, verificationWindowSeconds: 2_592_000, minimumImprovement: 0,
    }).expect(200);
    expect(updated.body.playbook).toMatchObject({ goal: "below", targetValue: 0, minimumImprovement: 0 });
    await request(app.app).patch(path).send({ targetValue: null }).expect(400);
    await request(app.app).patch(path).send({ description: "Changed text only" }).expect(200);
  });
});
