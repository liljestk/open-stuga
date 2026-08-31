import { describe, expect, it, vi } from "vitest";
import {
  buildEwpeRequestBody,
  normalizeEwpeState,
  runEwpeMonitorLoop,
  type EwpeCloudSnapshot,
  type EwpeMonitorSession,
} from "../src/ewpe-cloud.js";

describe("EWPE Smart cloud protocol", () => {
  it("builds the observed deterministic request verification fields", () => {
    const now = new Date("2026-08-03T12:34:56.000Z");
    expect(buildEwpeRequestBody({
      user: "user@example.com",
      psw: "hash",
      t: "2026-08-03 12:34:56",
    }, ["user", "psw", "t"], now)).toEqual({
      api: {
        appId: "4920681951525131286",
        r: 1_785_760_496,
        t: "2026-08-03 12:34:56",
        vc: "5772395c51e6150e75c13dfac7064239",
      },
      datVc: "a22fb0d81a5a4664beb30393362e21ce",
      user: "user@example.com",
      psw: "hash",
      t: "2026-08-03 12:34:56",
    });
  });

  it("normalizes the verified Nordkapp 30W fields without inventing activity", () => {
    const observedAt = new Date("2026-08-03T17:20:00.000Z");
    expect(normalizeEwpeState({
      Pow: 1,
      Mod: 1,
      SetTem: 20,
      TemSen: 60,
      DwatSen: 48,
      Dwet: 7,
      WdSpd: 0,
      SwingLfRig: 4,
      SwUpDn: 1,
      Air: 1,
      Health: 1,
      SwhSlp: 0,
      SlpMod: 2,
      Lig: 1,
      Quiet: 0,
      Tur: 0,
      Blo: 1,
      StHt: 0,
      SvSt: 1,
      Dfltr: 0,
      DwatFul: 1,
      Dmod: 9,
      CompressorFqy: 12,
      TemUn: 0,
      TemRec: 1,
      HeatCoolType: 3,
      EnvTem: 55,
      ErrCode: 0,
      AllErr: 0,
      wifiStatus: 1,
    }, "19.4", observedAt)).toEqual({
      observedAt: observedAt.toISOString(),
      available: true,
      power: true,
      selectedMode: "cool",
      targetTemperatureC: 20,
      currentTemperatureC: 20,
      currentTemperatureSource: "reported",
      currentHumidityPercent: 48,
      targetHumidityPercent: 50,
      fanSpeed: "auto",
      horizontalSwing: "middle",
      verticalSwing: "full",
      freshAir: true,
      anion: true,
      sleep: false,
      light: true,
      quiet: false,
      turbo: false,
      xfan: true,
      steadyHeat: false,
      powerSave: true,
      cleanFilter: false,
      waterFull: true,
      dehumidifierMode: "anion-only",
      compressorFrequencyHz: 12,
      diagnostics: {
        environmentTemperatureRaw: 55,
        sleepModeRaw: 2,
        temperatureUnitRaw: 0,
        temperatureRecordRaw: 1,
        heatCoolTypeRaw: 3,
        faultCode: 0,
        allErrors: 0,
        wifiStatus: 1,
      },
      activity: "unknown",
      activityEvidence: "unavailable",
    });
  });

  it("keeps missing temperatures unknown and treats power-off as protocol evidence", () => {
    expect(normalizeEwpeState({
      Pow: 0,
      Mod: 4,
      SetTem: 21,
      TemSen: 0,
      CompressorFqy: 999,
      wifiStatus: 0,
    }, "19.4", new Date("2026-08-03T17:21:00.000Z"))).toMatchObject({
      available: false,
      power: false,
      selectedMode: "heat",
      currentTemperatureC: null,
      currentTemperatureSource: "unavailable",
      compressorFrequencyHz: null,
      activity: "off",
      activityEvidence: "protocol",
    });
  });
});

describe("EWPE monitor loop resilience", () => {
  const snapshot = { device: { mac: "AABBCCDDEEFF" }, state: { available: true } } as unknown as EwpeCloudSnapshot;

  function harness(queryPlan: Array<"ok" | "fail">) {
    let calls = 0;
    const closed: number[] = [];
    const session: EwpeMonitorSession<number> = {
      connect: vi.fn(async () => calls += 1),
      query: vi.fn(async () => {
        const step = queryPlan.shift();
        if (step === "fail") throw new Error("EWPE live-state response timed out");
        return snapshot;
      }),
      close: vi.fn(async (link: number) => { closed.push(link); }),
    };
    return { session, closed, links: () => calls };
  }

  it("rebuilds the link after a transient poll failure instead of ending the session", async () => {
    const { session, closed } = harness(["ok", "fail", "ok"]);
    const controller = new AbortController();
    const snapshots: EwpeCloudSnapshot[] = [];
    const run = runEwpeMonitorLoop(
      session,
      { pollIntervalMs: 5, retryDelayMs: 1 },
      controller.signal,
      (received) => {
        snapshots.push(received);
        if (snapshots.length === 2) controller.abort();
      },
    );
    await expect(run).resolves.toBeUndefined();
    expect(snapshots).toHaveLength(2);
    expect(session.connect).toHaveBeenCalledTimes(2);
    expect(closed).toEqual([1, 2]);
  });

  it("ends the session only after a sustained failure streak", async () => {
    const { session, closed, links } = harness(["fail", "fail", "fail"]);
    const controller = new AbortController();
    await expect(runEwpeMonitorLoop(
      session,
      { pollIntervalMs: 5, retryDelayMs: 1 },
      controller.signal,
      () => { throw new Error("no snapshot should arrive"); },
    )).rejects.toThrow("EWPE live-state response timed out");
    expect(session.query).toHaveBeenCalledTimes(3);
    expect(links()).toBe(3);
    expect(closed).toEqual([1, 2, 3]);
  });

  it("a successful poll resets the failure streak", async () => {
    const { session } = harness(["fail", "ok", "fail", "ok", "fail", "ok"]);
    const controller = new AbortController();
    const snapshots: EwpeCloudSnapshot[] = [];
    await expect(runEwpeMonitorLoop(
      session,
      { pollIntervalMs: 1, retryDelayMs: 1 },
      controller.signal,
      (received) => {
        snapshots.push(received);
        if (snapshots.length === 3) controller.abort();
      },
    )).resolves.toBeUndefined();
    expect(snapshots).toHaveLength(3);
    expect(session.query).toHaveBeenCalledTimes(6);
  });

  it("stops promptly and closes the link when aborted between polls", async () => {
    const { session, closed } = harness(["ok"]);
    const controller = new AbortController();
    const run = runEwpeMonitorLoop(
      session,
      { pollIntervalMs: 60_000, retryDelayMs: 1 },
      controller.signal,
      () => controller.abort(),
    );
    await expect(run).resolves.toBeUndefined();
    expect(closed).toEqual([1]);
  });
});
