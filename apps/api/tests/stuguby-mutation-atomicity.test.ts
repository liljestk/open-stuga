import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { node, stop, type RunningNode } from "./stugubyTestSupport.js";

describe("Stuguby mutation atomicity", () => {
  const nodes: RunningNode[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  it("rolls a sensor edit back when publishing the Home change fails", async () => {
    const current = await node("Atomic sensor");
    nodes.push(current);
    const house = current.runtime.database.listHouses()[0]!;
    const floor = house.floors[0]!;
    const sensor = current.runtime.database.createSensor({
      houseId: house.id,
      floorId: floor.id,
      name: "Before",
      room: "Test room",
      model: "T110",
      x: 1,
      y: 1,
      z: 1,
      tags: ["contact"],
      enabled: true,
    });
    vi.spyOn(current.runtime.stuguby!, "captureHomeMutation").mockImplementation(() => {
      throw new Error("Injected publication failure");
    });

    await request(current.runtime.app)
      .patch(`/api/v1/sensors/${sensor.id}`)
      .send({ name: "After" })
      .expect(500);

    expect(current.runtime.database.getSensor(sensor.id)?.name).toBe("Before");
  });
});
