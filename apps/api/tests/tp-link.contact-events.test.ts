import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpeningStateObservation } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { waitFor } from "./tp-linkTestSupport.js";

describe("direct TP-Link contact events", () => {
  let runtime: ApiRuntime | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it("retains every trigger-log transition inside one full polling interval", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "climate-twin-tp-link-contact-events-"));
    const helperPath = join(temporaryDirectory, "fake-helper.mjs");
    writeFileSync(helperPath, `
      const openedAt = new Date(Date.now() - 800).toISOString();
      const closedAt = new Date(Date.now() - 300).toISOString();
      const baselineAt = new Date(Date.now() - 1300).toISOString();
      const batch = {
        type: "contact-events", timestamp: new Date().toISOString(), events: [
          { deviceId: "contact-fast", eventId: "baseline-event", sequence: 9, state: "closed", timestamp: baselineAt },
          { deviceId: "contact-fast", eventId: "open-event", sequence: 10, state: "open", timestamp: openedAt },
          { deviceId: "contact-fast", eventId: "close-event", sequence: 11, state: "closed", timestamp: closedAt },
          { deviceId: "contact-fast", eventId: "ignored", sequence: 12, state: "keepOpen", timestamp: closedAt }
        ]
      };
      process.stdout.write(JSON.stringify(batch) + "\\n");
      process.stdout.write(JSON.stringify(batch) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H200",
        devices: [{ deviceId: "contact-fast", model: "T110", alias: "Fast contact",
          status: "online", battery: 91, contactOpen: false }]
      }) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const config: AppConfig = {
      port: 0, apiHost: "127.0.0.1", databasePath: ":memory:",
      integrationSecretsFile: join(temporaryDirectory, "secrets.json"), assetDirectory: temporaryDirectory,
      mockEnabled: false, mockIntervalMs: 2_000, retentionDays: 730, ingestApiKey: null,
      haUrl: null, haToken: null, haEntityMapFile: null,
      tpLinkHost: "192.0.2.12", tpLinkUsername: "local@example.test", tpLinkPassword: "secret",
      tpLinkDeviceMapFile: null, tpLinkPollIntervalMs: 2_000,
      tpLinkPython: process.execPath, tpLinkBridgeScript: helperPath,
      alertWebhookUrl: null, alertWebhookBearerToken: null, corsOrigin: null,
    };
    runtime = createApi({ config, startBackground: false });
    const house = runtime.database.getHouse("house-main")!;
    const floors = structuredClone(house.floors);
    floors[0]!.planElements = [...(floors[0]!.planElements ?? []), {
      id: "fast-door", kind: "door", wallId: floors[0]!.walls[0]!.id,
      position: {
        x: (floors[0]!.walls[0]!.from.x + floors[0]!.walls[0]!.to.x) / 2,
        y: (floors[0]!.walls[0]!.from.y + floors[0]!.walls[0]!.to.y) / 2,
      },
      rotationDegrees: 0, state: "closed",
      stateBinding: { provider: "tapo", externalId: "contact-fast" },
    }];
    runtime.database.updateHouse(house.id, { floors });
    const liveOpenings: OpeningStateObservation[] = [];
    const unsubscribe = runtime.bus.subscribe((event) => {
      if (event.type === "opening") liveOpenings.push(event.data);
    });
    runtime.tpLink.start();

    try {
      await waitFor(() => runtime!.database.listOpeningStateObservations(house.id).length === 3);
    } finally {
      unsubscribe();
    }
    const observations = runtime.database.listOpeningStateObservations(house.id);
    expect(observations.map((observation) => observation.state)).toEqual(["closed", "open", "closed"]);
    expect(observations.every(({ id }) => /^tapo-event:[0-9a-f]{64}$/u.test(id))).toBe(true);
    expect(Date.parse(observations[0]!.observedAt) - Date.parse(observations[1]!.observedAt)).toBeLessThan(2_000);
    expect(runtime.database.openingStateActivity(
      house.id,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    )).toEqual([expect.objectContaining({
      observationCount: 3,
      openedCount: 1,
      closedCount: 1,
    })]);
    expect(liveOpenings.map((observation) => observation.state)).toEqual(["closed", "open", "closed"]);
    expect(liveOpenings.map((observation) => observation.id)).toEqual([...observations].reverse().map(({ id }) => id));
  });
});
