import { describe, expect, it } from "vitest";
import { buildEwpeRequestBody, normalizeEwpeState } from "../src/ewpe-cloud.js";

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
      WdSpd: 0,
      SwingLfRig: 4,
      SwUpDn: 1,
      Quiet: 0,
      Tur: 0,
      Blo: 1,
      CompressorFqy: 12,
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
      fanSpeed: "auto",
      horizontalSwing: "middle",
      verticalSwing: "full",
      quiet: false,
      turbo: false,
      xfan: true,
      compressorFrequencyHz: 12,
      diagnostics: {
        environmentTemperatureRaw: 55,
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
