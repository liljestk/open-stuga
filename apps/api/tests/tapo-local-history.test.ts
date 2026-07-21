import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiRuntime } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { mergeTpLinkHistoryRecovery } from "../src/tp-link.js";

describe("direct TP-Link retained history IPC", () => {
  let runtime: ApiRuntime | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function setupHelper(overrides = "", historyFailure?: string): { sensorId: string; pollMarker: string } {
    directory = mkdtempSync(join(tmpdir(), "stuga-tapo-history-ipc-"));
    const helper = join(directory, "helper.mjs");
    const mapping = join(directory, "mapping.json");
    const pollMarker = join(directory, "polling-active");
    const historyMarker = join(directory, "history-active");
    writeFileSync(mapping, JSON.stringify({ devices: [{ deviceId: "t315-cellar", sensorId: "sensor-01" }] }));
    writeFileSync(helper, `
      import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
      const pollMarker = ${JSON.stringify(pollMarker)};
      const historyMarker = ${JSON.stringify(historyMarker)};
      const configuredFailure = ${JSON.stringify(historyFailure ?? null)};
      const active = (marker) => {
        if (!existsSync(marker)) return false;
        try {
          process.kill(Number(readFileSync(marker, "utf8")), 0);
          return true;
        } catch {
          try { rmSync(marker); } catch {}
          return false;
        }
      };
      let liveHistoryBusy = false;
      const respond = (request, exitAfterFailure = false) => {
        if (liveHistoryBusy) {
          process.stdout.write(JSON.stringify({
            type: "error", requestId: request.requestId, message: "overlapping encrypted session"
          }) + "\\n");
          return;
        }
        liveHistoryBusy = true;
        setTimeout(() => {
          if (configuredFailure) {
            process.stdout.write(JSON.stringify({
              type: "error", requestId: request.requestId, message: configuredFailure
            }) + "\\n");
            liveHistoryBusy = false;
            if (exitAfterFailure) process.exitCode = 1;
            return;
          }
          process.stdout.write(JSON.stringify({
            type: "history-result",
            requestId: request.requestId,
            deviceId: ${overrides || "request.deviceId"},
            metric: request.metric,
            state: "complete",
            samples: [{
              deviceId: request.deviceId,
              metric: request.metric,
              value: 21.5,
              canonicalUnit: "C",
              timestamp: "2026-01-15T10:15:00.000Z",
              quality: "good"
            }],
            error: null
          }) + "\\n");
          liveHistoryBusy = false;
        }, 50);
      };
      if (process.argv.includes("--history")) {
        if (active(pollMarker) || active(historyMarker)) {
          process.stdout.write(JSON.stringify({ type: "error", message: "overlapping encrypted session" }) + "\\n");
          process.exit(1);
        }
        writeFileSync(historyMarker, String(process.pid));
        const releaseHistory = () => { try { rmSync(historyMarker); } catch {} };
        process.on("exit", releaseHistory);
        let input = "";
        process.stdin.on("data", (chunk) => input += chunk);
        process.stdin.on("end", () => {
          respond(JSON.parse(input), true);
        });
      } else {
        if (active(pollMarker) || active(historyMarker)) process.exit(2);
        writeFileSync(pollMarker, String(process.pid));
        const releasePoll = () => { try { rmSync(pollMarker); } catch {} };
        process.on("SIGTERM", () => { releasePoll(); process.exit(0); });
        process.on("exit", releasePoll);
        process.stdout.write(JSON.stringify({
          type: "snapshot", timestamp: new Date().toISOString(), hubModel: "H100",
          sourceDeviceId: "hub-1", devices: []
        }) + "\\n");
        let input = "";
        process.stdin.on("data", (chunk) => {
          input += chunk;
          const lines = input.split(/\\r?\\n/);
          input = lines.pop() ?? "";
          for (const line of lines) if (line) respond(JSON.parse(line));
        });
        setInterval(() => {}, 1000);
      }
    `);
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: ":memory:", MOCK_ENABLED: "false",
      TP_LINK_HOST: "192.0.2.10", TP_LINK_USERNAME: "owner@example.test", TP_LINK_PASSWORD: "secret",
      TP_LINK_DEVICE_MAP_FILE: mapping, TP_LINK_PYTHON: process.execPath, TP_LINK_BRIDGE_SCRIPT: helper,
    });
    runtime = createApi({ config, startBackground: false });
    runtime.tpLink.start();
    return { sensorId: "sensor-01", pollMarker };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt >= timeoutMs) throw new Error("Timed out waiting for TP-Link helper state");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function markerPid(path: string): string | null {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  }

  it("validates and maps live-helper samples into canonical telemetry", async () => {
    const { sensorId, pollMarker } = setupHelper();
    await waitFor(() => existsSync(pollMarker));
    const previousPollPid = markerPid(pollMarker);
    await expect(runtime!.tpLink.recoverHistory(
      sensorId, "temperature", "2026-01-15T10:00:00.000Z", "2026-01-15T10:30:00.000Z",
    )).resolves.toEqual({
      state: "complete",
      samples: [{
        sensorId, metric: "temperature", value: 21.5, canonicalUnit: "\u00b0C",
        timestamp: "2026-01-15T10:15:00.000Z", source: "tp-link", quality: "good",
      }],
      error: null,
    });
    expect(markerPid(pollMarker)).toBe(previousPollPid);
  });

  it("serializes history commands on the live polling session", async () => {
    const { sensorId, pollMarker } = setupHelper();
    await waitFor(() => existsSync(pollMarker));
    const previousPollPid = markerPid(pollMarker);

    const recovered = await Promise.all([
      runtime!.tpLink.recoverHistory(
        sensorId, "temperature", "2026-01-15T10:00:00.000Z", "2026-01-15T10:30:00.000Z",
      ),
      runtime!.tpLink.recoverHistory(
        sensorId, "humidity", "2026-01-15T10:00:00.000Z", "2026-01-15T10:30:00.000Z",
      ),
    ]);

    expect(recovered.map((result) => result.state)).toEqual(["complete", "complete"]);
    expect(markerPid(pollMarker)).toBe(previousPollPid);
  });

  it("rejects a response whose device identity does not match the request", async () => {
    const { sensorId } = setupHelper('"another-device"');
    await expect(runtime!.tpLink.recoverHistory(
      sensorId, "temperature", "2026-01-15T10:00:00.000Z", "2026-01-15T10:30:00.000Z",
    )).rejects.toThrow(/identity/);
  });

  it("does not persist encrypted response bodies from helper failures", async () => {
    const { sensorId, pollMarker } = setupHelper("", "TP-Link history recovery failed: Unable to decrypt response from 192.0.2.10, error: Invalid padding bytes., response: sensitive-ciphertext");
    await waitFor(() => existsSync(pollMarker));

    await expect(runtime!.tpLink.recoverHistory(
      sensorId, "temperature", "2026-01-15T10:00:00.000Z", "2026-01-15T10:30:00.000Z",
    )).rejects.toThrow("TP-Link encrypted session was replaced during the local history request");
  });

  it("keeps preferred local rows and partial state when an app fallback is unavailable", () => {
    const timestamp = "2026-01-15T10:15:00.000Z";
    const result = mergeTpLinkHistoryRecovery({
      state: "partial",
      samples: [{
        sensorId: "sensor-01", metric: "temperature", value: 21.5, canonicalUnit: "°C",
        timestamp, source: "tp-link", quality: "good",
      }],
      error: "Local history ended early",
    }, {
      state: "not-supported",
      samples: [{
        sensorId: "sensor-01", metric: "temperature", value: 19, canonicalUnit: "°C",
        timestamp, source: "tp-link", quality: "estimated",
      }],
      error: "App export is unavailable",
    });

    expect(result).toMatchObject({
      state: "partial",
      samples: [{ value: 21.5, quality: "good" }],
      error: expect.stringContaining("App export is unavailable"),
    });
  });
});
