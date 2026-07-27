import { once } from "node:events";

import type { AddressInfo } from "node:net";

import { networkInterfaces } from "node:os";

import request from "supertest";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

export const OWNER = { email: "owner@example.test", password: "correct horse battery staple" };

export function privateIpv4Address(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("10.") || entry.address.startsWith("192.168.")) return entry.address;
      const match = entry.address.match(/^172\.(\d{1,3})\./);
      if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return entry.address;
    }
  }
  return null;
}

export function authRuntime(spatialLayers = false): ApiRuntime {
  return createApi({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      MOCK_ENABLED: "false",
      LOCAL_AUTH_TEST_BYPASS: "false",
      ...(spatialLayers ? {
        SPATIAL_LAYERS_ENABLED: "true",
        SPATIAL_LAYERS_DATABASE_PATH: ":memory:",
      } : {}),
    }),
    startBackground: false,
  });
}

export async function streamTextToEnd(response: globalThis.Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response did not expose a body");
  const chunks: Uint8Array[] = [];
  await Promise.race([
    (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        chunks.push(result.value);
      }
    })(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE did not close")), 2_000)),
  ]);
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

export function sessionCookie(response: request.Response): string {
  const cookies = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = cookies?.find((value) => value.startsWith("stuga_session="));
  if (!cookie) throw new Error("Session cookie missing");
  return cookie.split(";", 1)[0]!;
}

export async function setupOwner(runtime: ApiRuntime): Promise<{
  agent: ReturnType<typeof request.agent>;
  csrf: string;
}> {
  const agent = request.agent(runtime.app);
  const response = await agent.post("/api/v1/auth/setup").send(OWNER).expect(201);
  return { agent, csrf: response.body.csrfToken as string };
}
