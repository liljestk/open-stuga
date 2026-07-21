import { describe, expect, it, vi } from "vitest";
import {
  assertTapoCanaryMatchesLive,
  assertTapoHistoryCsvCoverage,
  GmailTapoMailbox,
  parseTapoHistoryCsv,
  tapoExportRecipient,
  TapoHistoryFormatError,
  TapoPrivateHistoryClient,
} from "../src/tapo-history-export.js";

describe("Tapo history export adapters", () => {
  it("parses the anonymous app CSV and binds it to the requested sensor", () => {
    const parsed = parseTapoHistoryCsv([
      "\uFEFFTime,Temperature(\u00b0C),Humidity(%)",
      "2026-01-15 12:00:00,21.25,44",
      "2026-01-15 12:15:00,21.5,45",
    ].join("\r\n"), { sensorId: "sensor-cellar", timeZone: "Europe/Helsinki" });

    expect(parsed).toMatchObject({ rowsRead: 2, rowsSkipped: 0, firstTimestamp: "2026-01-15T10:00:00.000Z" });
    expect(parsed.samples).toEqual([
      { sensorId: "sensor-cellar", metric: "humidity", value: 44, canonicalUnit: "%", timestamp: "2026-01-15T10:00:00.000Z", source: "tp-link", quality: "estimated" },
      { sensorId: "sensor-cellar", metric: "temperature", value: 21.25, canonicalUnit: "\u00b0C", timestamp: "2026-01-15T10:00:00.000Z", source: "tp-link", quality: "estimated" },
      { sensorId: "sensor-cellar", metric: "humidity", value: 45, canonicalUnit: "%", timestamp: "2026-01-15T10:15:00.000Z", source: "tp-link", quality: "estimated" },
      { sensorId: "sensor-cellar", metric: "temperature", value: 21.5, canonicalUnit: "\u00b0C", timestamp: "2026-01-15T10:15:00.000Z", source: "tp-link", quality: "estimated" },
    ]);
  });

  it("supports localized semicolon CSV, decimal commas, Fahrenheit, and range filtering", () => {
    const parsed = parseTapoHistoryCsv([
      "Date;Time;Temperature (\u00b0F);Relative humidity (%)",
      "15.01.2026;12:00:00;68,0;40,5",
      "15.01.2026;12:15:00;69,8;41,0",
    ].join("\n"), {
      sensorId: "sensor-1", timeZone: "Europe/Helsinki",
      from: "2026-01-15T10:15:00.000Z", to: "2026-01-15T10:15:00.000Z",
    });
    expect(parsed.samples).toMatchObject([
      { metric: "humidity", value: 41, timestamp: "2026-01-15T10:15:00.000Z" },
      { metric: "temperature", value: 21, timestamp: "2026-01-15T10:15:00.000Z" },
    ]);
  });

  it("parses the localized T315 range-metadata header used by real app exports", () => {
    const parsed = parseTapoHistoryCsv([
      "2025/06/01 00:00:00 - 2025/07/01 00:00:00,Teplota(℃),Abnormální,Vlhkost vzduchu(%),Abnormální",
      "2025/06/01 15:00:00,24.0,,43,",
      "2025/06/01 16:00:00,23.1,,45,",
      "2025/06/01 17:00:00,22.7,,45,",
    ].join("\n"), { sensorId: "sensor-t315", timeZone: "Europe/Prague" });

    expect(parsed).toMatchObject({ rowsRead: 3, rowsSkipped: 0 });
    expect(parsed.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "temperature", value: 24, timestamp: "2025-06-01T13:00:00.000Z" }),
      expect.objectContaining({ metric: "humidity", value: 43, timestamp: "2025-06-01T13:00:00.000Z" }),
    ]));
  });

  it("does not infer a timestamp from an unproven metadata-looking header", () => {
    expect(() => parseTapoHistoryCsv([
      "2025/06/01 00:00:00 - 2025/07/01 00:00:00,Unknown(℃),Unknown(%)",
      "not-a-time,24,43",
      "still-not-a-time,23,45",
    ].join("\n"), { sensorId: "sensor-t315", timeZone: "Europe/Prague" }))
      .toThrow(/headers must contain time/u);
  });

  it("keeps both instants when the local clock repeats at DST fall-back", () => {
    const parsed = parseTapoHistoryCsv([
      "Time,Temperature(°C),Humidity(%)",
      "2026-10-25 03:30:00,20,40",
      "2026-10-25 03:30:00,21,41",
    ].join("\n"), { sensorId: "sensor-1", timeZone: "Europe/Helsinki" });
    const temperatures = parsed.samples.filter((sample) => sample.metric === "temperature");
    expect(temperatures.map((sample) => sample.timestamp)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
  });

  it("accepts a bounded whole-calendar export around a non-midnight DST fallback range", () => {
    const timeZone = "Europe/Helsinki";
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const wallTime = (timestamp: number): string => {
      const parts = formatter.formatToParts(timestamp);
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
    };
    const rawStart = Date.parse("2026-10-16T21:00:00.000Z"); // Oct 17 00:00 EEST
    const rawEnd = Date.parse("2026-10-31T22:00:00.000Z"); // Nov 1 00:00 EET
    const from = "2026-10-17T09:37:00.000Z";
    const to = new Date(Date.parse(from) + 19_999 * 60_000).toISOString();
    const rows = ["Time,Temperature(°C),Humidity(%)"];
    for (let at = rawStart; at < rawEnd; at += 60_000) {
      rows.push(`${wallTime(at)},20,40`);
    }

    const parsed = parseTapoHistoryCsv(rows.join("\n"), {
      sensorId: "sensor-1", timeZone, from, to,
    });

    expect(parsed.rowsRead).toBe(21_660);
    expect(parsed.samples).toHaveLength(40_000);
    expect(() => assertTapoHistoryCsvCoverage(parsed, {
      metric: "temperature", from, to, intervalMinutes: 1,
    })).not.toThrow();
  });

  it("rejects non-Tapo-shaped files instead of guessing columns", () => {
    expect(() => parseTapoHistoryCsv("name,value\na,1", {
      sensorId: "sensor-1", timeZone: "Europe/Helsinki",
    })).toThrow(TapoHistoryFormatError);
  });

  it("requires an explicit temperature unit and fingerprints the accepted CSV structure", () => {
    expect(() => parseTapoHistoryCsv(
      "Time,Temperature,Humidity(%)\n2026-01-15 12:00:00,72,45\n",
      { sensorId: "sensor-1", timeZone: "Europe/Helsinki" },
    )).toThrow(/explicitly declare °C or °F/u);

    const celsius = parseTapoHistoryCsv(
      "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,22,45\n",
      { sensorId: "sensor-1", timeZone: "Europe/Helsinki" },
    );
    const fahrenheit = parseTapoHistoryCsv(
      "Time,Temperature(°F),Humidity(%)\n2026-01-15 12:00:00,72,45\n",
      { sensorId: "sensor-1", timeZone: "Europe/Helsinki" },
    );
    expect(celsius.schemaSignature).toMatch(/^[a-f0-9]{64}$/u);
    expect(fahrenheit.schemaSignature).not.toBe(celsius.schemaSignature);
  });

  it("rejects conflicting values at one resolved metric timestamp", () => {
    expect(() => parseTapoHistoryCsv([
      "Time,Temperature(°C),Humidity(%)",
      "2026-01-15 12:00:00,20,40",
      "2026-01-15 12:00:00,21,40",
    ].join("\n"), { sensorId: "sensor-1", timeZone: "Europe/Helsinki" }))
      .toThrow(/conflicting duplicate timestamps/u);
  });

  it("creates stable plus-address identities from an opaque correlation nonce", () => {
    const address = tapoExportRecipient("Owner+old@gmail.com", "opaque-random-correlation-nonce", "Stuga Export");
    expect(address).toMatch(/^owner\+stugaexport-[a-f0-9]{32}@gmail\.com$/);
    expect(address).not.toContain("sensitive");
    expect(tapoExportRecipient("owner@gmail.com", "opaque-random-correlation-nonce", "Stuga Export")).toBe(address);
  });

  it("refreshes OAuth and accepts only a CSV addressed to the job alias", async () => {
    const csv = "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,21,45\n";
    const encoded = Buffer.from(csv).toString("base64url");
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth.test/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) return Response.json({ messages: [{ id: "message-1" }] });
      if (url.includes("/users/me/messages/message-1?")) return Response.json({
        id: "message-1",
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: "To", value: "Stuga <owner+stuga-a@gmail.com>" }],
          parts: [{ filename: "Tapo_sensor_data.csv", body: { data: encoded, size: csv.length } }],
        },
      });
      return new Response("not found", { status: 404 });
    });
    const mailbox = new GmailTapoMailbox({
      clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetcher,
      expectedEmail: "owner@gmail.com",
      tokenEndpoint: "https://oauth.test/token", apiBaseUrl: "https://gmail.test/gmail/v1",
    });
    await expect(mailbox.findCsv("owner+stuga-a@gmail.com", new Set())).resolves.toMatchObject({
      attachments: [{ messageId: "message-1", filename: "Tapo_sensor_data.csv" }],
      rejectedCandidates: 0,
      transientFailures: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects an OAuth token for a different Gmail mailbox before searching messages", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth.test/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "other@gmail.com" });
      return Response.json({ messages: [] });
    });
    const mailbox = new GmailTapoMailbox({
      clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetcher,
      expectedEmail: "owner@gmail.com",
      tokenEndpoint: "https://oauth.test/token", apiBaseUrl: "https://gmail.test/gmail/v1",
    });

    await expect(mailbox.findCsv("owner+stuga-a@gmail.com", new Set()))
      .rejects.toThrow(/different mailbox/u);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("skips a poisoned matching attachment and continues to a valid export", async () => {
    const csv = "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,21,45\n";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth.test/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) return Response.json({ messages: [{ id: "poison" }, { id: "valid" }] });
      const id = url.includes("/poison?") ? "poison" : "valid";
      return Response.json({
        id,
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: "Delivered-To", value: "owner+stuga-a@gmail.com" }],
          parts: id === "poison"
            ? [{ filename: "oversized.csv", body: { data: "", size: 25 * 1024 * 1024 } }]
            : [{ filename: "valid.csv", body: { data: Buffer.from(csv).toString("base64url"), size: csv.length } }],
        },
      });
    });
    const mailbox = new GmailTapoMailbox({
      clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetcher,
      expectedEmail: "owner@gmail.com",
      tokenEndpoint: "https://oauth.test/token", apiBaseUrl: "https://gmail.test/gmail/v1",
    });
    await expect(mailbox.findCsv("owner+stuga-a@gmail.com", new Set())).resolves.toMatchObject({
      attachments: [{ messageId: "valid", filename: "valid.csv" }],
      rejectedCandidates: 1,
      transientFailures: 0,
    });
  });

  it("stops fetching messages as soon as the four-candidate memory cap is full", async () => {
    const csv = "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,21,45\n";
    const ids = Array.from({ length: 10 }, (_, index) => ({ id: `message-${index}` }));
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth.test/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) return Response.json({ messages: ids });
      const id = /messages\/(message-\d+)\?/u.exec(url)?.[1] ?? "missing";
      return Response.json({
        id,
        internalDate: String(Date.now()),
        payload: {
          headers: [{ name: "To", value: "owner+stuga-a@gmail.com" }],
          parts: [{ filename: `${id}.csv`, body: { data: Buffer.from(csv).toString("base64url"), size: csv.length } }],
        },
      });
    });
    const mailbox = new GmailTapoMailbox({
      clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetcher,
      expectedEmail: "owner@gmail.com",
      tokenEndpoint: "https://oauth.test/token", apiBaseUrl: "https://gmail.test/gmail/v1",
    });

    const result = await mailbox.findCsv("owner+stuga-a@gmail.com", new Set());
    expect(result.attachments).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(7); // OAuth + profile + one list + four message bodies.
  });

  it("rejects an excessively nested MIME tree without recursive stack growth", async () => {
    const csv = "Time,Temperature(°C),Humidity(%)\n2026-01-15 12:00:00,21,45\n";
    let nested: Record<string, unknown> = { filename: "poison.csv", body: { data: "", size: 0 } };
    for (let depth = 0; depth < 20; depth += 1) nested = { parts: [nested] };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://oauth.test/token") return Response.json({ access_token: "access", expires_in: 3600 });
      if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "owner@gmail.com" });
      if (url.includes("/users/me/messages?")) return Response.json({ messages: [{ id: "nested" }, { id: "valid" }] });
      const id = url.includes("/nested?") ? "nested" : "valid";
      return Response.json({
        id,
        internalDate: String(Date.now()),
        payload: id === "nested"
          ? { headers: [{ name: "To", value: "owner+stuga-a@gmail.com" }], parts: [nested] }
          : {
              headers: [{ name: "To", value: "owner+stuga-a@gmail.com" }],
              parts: [{ filename: "valid.csv", body: { data: Buffer.from(csv).toString("base64url"), size: csv.length } }],
            },
      });
    });
    const mailbox = new GmailTapoMailbox({
      clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetcher,
      expectedEmail: "owner@gmail.com",
      tokenEndpoint: "https://oauth.test/token", apiBaseUrl: "https://gmail.test/gmail/v1",
    });

    await expect(mailbox.findCsv("owner+stuga-a@gmail.com", new Set())).resolves.toMatchObject({
      attachments: [{ messageId: "valid" }],
      rejectedCandidates: 1,
    });
  });

  it("requires private history responses to echo the device identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ deviceId: "wrong", samples: [] }));
    const client = new TapoPrivateHistoryClient({
      endpoint: "https://history.example.test/v1/query", token: "secret", fetcher,
      resolver: async () => ["1.1.1.1"],
    });
    await expect(client.fetch("device-a", "sensor-a", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"))
      .rejects.toThrow(/echo/);
  });

  it("requires authoritative range coverage and blocks private DNS targets", async () => {
    const incomplete = new TapoPrivateHistoryClient({
      endpoint: "https://history.example.test/v1/query", token: "secret",
      resolver: async () => ["1.1.1.1"],
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({
        deviceId: "device-a", state: "partial",
        rangeStart: "2026-01-01T00:00:00Z", rangeEnd: "2026-01-02T00:00:00Z", samples: [],
      })),
    });
    await expect(incomplete.fetch("device-a", "sensor-a", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"))
      .rejects.toThrow(/complete requested-range coverage/);

    const privateTargetFetch = vi.fn<typeof fetch>();
    const privateTarget = new TapoPrivateHistoryClient({
      endpoint: "https://history.example.test/v1/query", token: "secret",
      resolver: async () => ["192.168.1.10"], fetcher: privateTargetFetch,
    });
    await expect(privateTarget.fetch("device-a", "sensor-a", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"))
      .rejects.toThrow(/private or reserved network/);
    expect(privateTargetFetch).not.toHaveBeenCalled();
  });

  it("rejects empty, one-point, truncated, and wrong-cadence app exports", () => {
    const from = "2026-01-15T10:00:00.000Z";
    const to = "2026-01-15T12:00:00.000Z";
    const result = (minuteOffsets: number[], rowsSkipped = 0) => ({
      rowsRead: minuteOffsets.length + rowsSkipped,
      rowsSkipped,
      firstTimestamp: minuteOffsets.length ? new Date(Date.parse(from) + minuteOffsets[0]! * 60_000).toISOString() : null,
      lastTimestamp: minuteOffsets.length ? new Date(Date.parse(from) + minuteOffsets.at(-1)! * 60_000).toISOString() : null,
      samples: minuteOffsets.map((minutes) => ({
        sensorId: "sensor-a", metric: "temperature", value: 20, canonicalUnit: "°C",
        timestamp: new Date(Date.parse(from) + minutes * 60_000).toISOString(),
        source: "tp-link" as const, quality: "good" as const,
      })),
    });
    const request = { metric: "temperature" as const, from, to, intervalMinutes: 15 };
    expect(() => assertTapoHistoryCsvCoverage(result([]), request)).toThrow(/no data rows/);
    expect(() => assertTapoHistoryCsvCoverage(result([60]), request)).toThrow(/fewer than two/);
    expect(() => assertTapoHistoryCsvCoverage(result([0, 15, 30]), request)).toThrow(/boundaries/);
    expect(() => assertTapoHistoryCsvCoverage(result([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120]), request))
      .toThrow(/finer/);
    expect(() => assertTapoHistoryCsvCoverage(result([0, 30, 60, 90, 120]), request)).toThrow(/incomplete gap/);
    expect(() => assertTapoHistoryCsvCoverage(result([0, 15, 30, 45, 60, 75, 90, 105, 120]), request)).not.toThrow();
  });

  it("requires canary data to match trusted live telemetry at zero lag", () => {
    const base = Date.parse("2026-01-15T08:00:00.000Z");
    const values = [20, 20.7, 20.2, 21.3, 20.5, 22, 21.1, 22.4, 21.5, 23, 22.2, 23.5, 22.7, 24.1, 23.2, 24.6, 23.8, 25.1, 24.2, 25.5];
    const sample = (value: number, index: number, shiftMinutes = 0) => ({
      sensorId: "sensor-a",
      metric: "temperature",
      value,
      canonicalUnit: "°C",
      timestamp: new Date(base + (index * 15 + shiftMinutes) * 60_000).toISOString(),
      source: "tp-link" as const,
      quality: "good" as const,
    });
    const live = values.map((value, index) => sample(value, index));
    const aligned = values.slice(0, 12).map((value, index) => sample(value, index));
    const shifted = values.slice(0, 12).map((value, index) => sample(value, index, 60));

    expect(() => assertTapoCanaryMatchesLive(aligned, live, "temperature", 15)).not.toThrow();
    expect(() => assertTapoCanaryMatchesLive(
      aligned,
      live.map((entry) => ({ ...entry, quality: "estimated" as const })),
      "temperature",
      15,
    )).toThrow(/trusted live samples/u);
    expect(() => assertTapoCanaryMatchesLive(shifted, live, "temperature", 15)).toThrow(/zero-lag alignment/u);
  });
});
