import { createServer, type Server } from "node:http";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import type { MeasurementSample } from "@climate-twin/contracts";

import {
  STUGBY_DATASETS,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  validateDatasetPayload,
  validateWireEvent,
  type StugubyDatasetGrant,
} from "@climate-twin/stuguby-protocol";

import { createApi, type ApiRuntime } from "../src/app.js";

import { loadConfig } from "../src/config.js";

import { StugubyService } from "../src/stuguby/service.js";

import { StugubyStore } from "../src/stuguby/store.js";

export interface RunningNode {
  runtime: ApiRuntime;
  server: Server;
  url: string;
  directory: string;
}

export async function node(
  name: string,
  startBackground = false,
  stugubyFetcher?: typeof fetch,
  publicOrigin?: string,
  cloudflarePublicOrigin?: string,
): Promise<RunningNode> {
  const directory = mkdtempSync(join(tmpdir(), "stuguby-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    ASSET_DIRECTORY: directory,
    STUGBY_NODE_NAME: name,
    STUGBY_SYNC_INTERVAL_MS: "300000",
    SPATIAL_LAYERS_ENABLED: "false",
    ...(publicOrigin ? { STUGBY_PUBLIC_ORIGIN: publicOrigin } : {}),
    ...(cloudflarePublicOrigin ? { CLOUDFLARE_ACCESS_PUBLIC_ORIGIN: cloudflarePublicOrigin } : {}),
  });
  const runtime = createApi({ config, startBackground, ...(stugubyFetcher ? { stugubyFetcher } : {}) });
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { runtime, server, url: `http://127.0.0.1:${address.port}`, directory };
}

export async function stop(value: RunningNode): Promise<void> {
  await value.runtime.close();
  await new Promise<void>((resolve, reject) => value.server.close((error) => error ? reject(error) : resolve()));
  rmSync(value.directory, { recursive: true, force: true });
}

export function editableHomeDatasets(): StugubyDatasetGrant[] {
  return [
    "home.directory.v1",
    "home.location.v1",
    "home.structure.v1",
    "home.sensor-catalog.v1",
    "home.notes.v1",
    "home.observations.v1",
  ].map((dataset) => ({
    dataset: dataset as StugubyDatasetGrant["dataset"],
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 30,
  }));
}

export function fullRecoveryDatasets(): StugubyDatasetGrant[] {
  return STUGBY_DATASETS.map((dataset) => ({
    dataset,
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 3_650,
    ...(dataset === "home.telemetry.v1" ? {
      telemetry: {
        sensorPublicationIds: [],
        metricIds: [],
        historyFrom: "2000-01-01T00:00:00.000Z",
        live: true,
        maxSamplesPerHour: 1_000_000,
      },
    } : {}),
  }));
}
