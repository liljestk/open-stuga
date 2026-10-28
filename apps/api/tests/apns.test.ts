import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import type { ClientHttp2Session } from "node:http2";
import { describe, expect, it } from "vitest";
import { APNSDeliveryError, APNSService, type APNSDestination } from "../src/apns.js";
import type { AppConfig } from "../src/config.js";

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = {
  apnsTeamId: "ABCDEFGHIJ",
  apnsKeyId: "K123456789",
  apnsBundleId: "net.example.stugu",
  apnsPrivateKey: privateKey,
} as AppConfig;
const destination: APNSDestination = {
  registrationId: "registration-1",
  deviceToken: "a".repeat(64),
  environment: "production",
  includeDetails: false,
  canAcknowledge: false,
};
const alert = JSON.stringify({ aps: { alert: { title: "Leak", body: "Utility room" }, sound: "default" } });

/** A session whose requests answer with the next queued status and body. */
function fakeApple(responses: Array<{ status: number; body?: string }>) {
  const requests: Array<{ origin: string; headers: Record<string, string>; payload: string }> = [];
  const connect = (origin: string) => {
    const session = new EventEmitter() as EventEmitter & { request: unknown; close: () => void };
    session.close = () => undefined;
    session.request = (headers: Record<string, string>) => {
      const stream = new EventEmitter() as EventEmitter & { setEncoding: () => void; end: (payload: string) => void; close: () => void };
      stream.setEncoding = () => undefined;
      stream.close = () => undefined;
      stream.end = (payload: string) => {
        requests.push({ origin, headers, payload });
        const response = responses.shift() ?? { status: 200 };
        queueMicrotask(() => {
          stream.emit("response", { ":status": response.status });
          if (response.body) stream.emit("data", response.body);
          stream.emit("end");
        });
      };
      return stream;
    };
    return session as unknown as ClientHttp2Session;
  };
  return { connect, requests };
}

async function failure(service: APNSService, payloadJson = alert): Promise<APNSDeliveryError> {
  const error = await service.send(config, destination, { payloadJson }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(APNSDeliveryError);
  return error as APNSDeliveryError;
}

describe("APNSService", () => {
  it("posts the alert to the device with a signed provider token", async () => {
    const apple = fakeApple([{ status: 200 }]);
    await new APNSService(apple.connect).send(config, destination, {
      payloadJson: alert,
      notificationId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    const [request] = apple.requests;
    expect(request!.origin).toBe("https://api.push.apple.com");
    expect(request!.headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${destination.deviceToken}`,
      "apns-topic": "net.example.stugu",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    expect(request!.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/u);
    expect(request!.payload).toBe(alert);
  });

  it("uses the sandbox origin for sandbox registrations", async () => {
    const apple = fakeApple([{ status: 200 }]);
    await new APNSService(apple.connect).send(config, { ...destination, environment: "sandbox" }, { payloadJson: alert });
    expect(apple.requests[0]!.origin).toBe("https://api.sandbox.push.apple.com");
  });

  it("treats gone and rejected requests as terminal and throttling or outages as retryable", async () => {
    const apple = fakeApple([
      { status: 410, body: JSON.stringify({ reason: "Unregistered" }) },
      { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) },
      { status: 429, body: JSON.stringify({ reason: "TooManyRequests" }) },
      { status: 503, body: "not json" },
    ]);
    const service = new APNSService(apple.connect);
    expect(await failure(service)).toMatchObject({ terminal: true, reason: "Unregistered" });
    expect(await failure(service)).toMatchObject({ terminal: true, reason: "BadDeviceToken" });
    expect(await failure(service)).toMatchObject({ terminal: false, reason: "TooManyRequests" });
    expect(await failure(service)).toMatchObject({ terminal: false, reason: null });
  });

  it("reuses the provider token, and signs a fresh one after ExpiredProviderToken", async () => {
    const apple = fakeApple([
      { status: 200 },
      { status: 200 },
      { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) },
      { status: 200 },
    ]);
    const service = new APNSService(apple.connect);
    await service.send(config, destination, { payloadJson: alert });
    await service.send(config, destination, { payloadJson: alert });
    expect(await failure(service)).toMatchObject({ terminal: false, reason: "ExpiredProviderToken" });
    await service.send(config, destination, { payloadJson: alert });
    const tokens = apple.requests.map((request) => request.headers.authorization);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).toBe(tokens[0]);
    expect(tokens[3]).not.toBe(tokens[0]);
  });

  it("rejects unusable payloads and device tokens before connecting", async () => {
    const apple = fakeApple([]);
    const service = new APNSService(apple.connect);
    for (const payloadJson of [
      "",
      JSON.stringify({ aps: { alert: { body: "x".repeat(4_100) } } }),
      "{not json",
      JSON.stringify({ aps: { sound: "default" } }),
      JSON.stringify({ aps: { alert: "plain text" } }),
    ]) {
      expect((await failure(service, payloadJson)).terminal).toBe(true);
    }
    const badToken = await service.send(config, { ...destination, deviceToken: "zz" }, { payloadJson: alert })
      .catch((caught: unknown) => caught);
    expect(badToken).toMatchObject({ terminal: true, reason: "BadDeviceToken" });
    expect(apple.requests).toHaveLength(0);
  });
});
